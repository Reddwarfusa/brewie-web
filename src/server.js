'use strict';
/**
 * Brewie Web — HTTP API + live events + static UI. No external dependencies.
 *
 * Env:
 *   PORT=8080               web port
 *   DATA_DIR=/data          recipes, sync state, settings
 *   BREWIE_HOST=192.168.x.x machine address (can also be set in the UI)
 *   BREWIE_PORT=8001
 *   AUTH_USER / AUTH_PASS   optional HTTP basic auth (recommended if exposed beyond your LAN)
 *   SIMULATOR=1             run a built-in simulated Brewie and connect to it (demo mode)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { BrewieClient, discover } = require('./client');
const { RecipeStore, newId } = require('./store');
const { blankRecipe } = require('./samples');
const P = require('./protocol');
const notify = require('./notify');

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const PUBLIC = path.join(__dirname, '..', 'public');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

// Machine setup mirrors the Brewie's own water settings (which the network protocol can't read).
// Defaults match the test machine: inlet + outlet connected, cooling through the inlet water.
const MACHINE_DEFAULTS = { waterInlet: true, drainConnected: true, cooling: true, coolingSource: 'inlet', checklist: true, levelSensor: 'mash' };
let settings = { host: process.env.BREWIE_HOST || '', port: Number(process.env.BREWIE_PORT || P.PORT) };
try { settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch (_) {}
settings.machine = { ...MACHINE_DEFAULTS, ...(settings.machine || {}) };
settings.notify = { ...notify.DEFAULTS, ...(settings.notify || {}), events: { ...notify.DEFAULTS.events, ...((settings.notify || {}).events || {}) } };
/** Settings as sent to browsers: secrets masked. */
const MASK = '••••••••';
function publicSettings() {
  const n = settings.notify;
  return { ...settings, notify: { ...n, ntfyToken: n.ntfyToken ? MASK : '', pushoverToken: n.pushoverToken ? MASK : '', pushoverUser: n.pushoverUser ? MASK : '' } };
}
if (process.env.BREWIE_HOST) settings.host = process.env.BREWIE_HOST;
const saveSettings = () => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));

let sim = null;
if (process.env.SIMULATOR === '1') {
  const { SimMachine } = require('./simulator');
  const simPort = Number(process.env.SIMULATOR_PORT || 18001);
  sim = new SimMachine({ port: simPort, dataDir: path.join(DATA_DIR, 'simulator'), speed: Number(process.env.SIMULATOR_SPEED || 30) }).start();
  sim.stuckDrain = process.env.SIMULATOR_STUCK_DRAIN === '1';
  settings.host = '127.0.0.1'; settings.port = simPort;
}

const store = new RecipeStore(DATA_DIR);
const client = new BrewieClient({ store, host: settings.host, port: settings.port });
client.levelTank = settings.machine.levelSensor === 'boil' ? 'boil' : 'mash';

// ------------------------------------------------------------------ events (SSE)
const sseClients = new Set();
const logBuffer = []; const noticeBuffer = [];
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(payload);
}
let stateTimer = null;
let lastConn = '';
client.on('state', () => {
  if (client.connection !== lastConn) { lastConn = client.connection; console.log(`[brewie] ${new Date().toISOString()} ${client.connection}${client.lastError && client.connection !== 'connected' ? ' — ' + client.lastError : ''}`); } if (!stateTimer) stateTimer = setTimeout(() => { stateTimer = null; broadcast('state', client.snapshot()); }, 100); });
client.on('status', (s) => broadcast('status', s));
const notifier = new notify.Notifier(() => settings.notify);
notify.attach(client, notifier, (a) => broadcast('alarm', a));
client.on('activity', (e) => broadcast('activity', e));
client.on('log', (l) => { logBuffer.push(l); if (logBuffer.length > 500) logBuffer.shift(); broadcast('log', l); });
client.on('notice', (n) => { console.log(`[brewie] ${n.text}`); noticeBuffer.push(n); if (noticeBuffer.length > 50) noticeBuffer.shift(); broadcast('notice', n); });
let recipesTimer = null;
client.on('recipes', () => { if (!recipesTimer) recipesTimer = setTimeout(() => { recipesTimer = null; broadcast('recipes', store.summaries()); }, 200); });
setInterval(() => broadcast('ping', Date.now()), 20000);

// ------------------------------------------------------------------ helpers
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
function send(res, code, body, type = 'application/json') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(data);
}
function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { const s = Buffer.concat(chunks).toString('utf8'); if (!s) return resolve({}); try { resolve(JSON.parse(s)); } catch (e) { reject(new Error('Invalid JSON body')); } });
  });
}
function authorized(req) {
  const u = process.env.AUTH_USER; const p = process.env.AUTH_PASS;
  if (!u || !p) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [cu, ...rest] = Buffer.from(h.slice(6), 'base64').toString().split(':');
  const a = Buffer.from(`${cu}:${rest.join(':')}`); const b = Buffer.from(`${u}:${p}`);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const requireConnected = () => { if (client.connection !== 'connected') { const e = new Error('Not connected to the Brewie'); e.code = 409; throw e; } };

// ------------------------------------------------------------------ routes
const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

const VERSION = require('../package.json').version;
route('GET', '/api/state', () => ({ ...client.snapshot(), version: VERSION, settings: publicSettings(), simulator: !!sim, recipes: store.summaries(), notices: noticeBuffer.slice(-10) }));
route('GET', '/api/history', () => client.statusHistory);
route('GET', '/api/log', () => logBuffer);
route('GET', '/api/activity', () => client.activity);

route('POST', '/api/connect', async (req) => {
  const b = await readBody(req);
  if (b.host !== undefined) settings.host = String(b.host).trim();
  if (b.port) settings.port = Number(b.port);
  saveSettings(); client.setHost(settings.host, settings.port);
  return { ok: true, settings: publicSettings() };
});
route('POST', '/api/settings/machine', async (req) => {
  const b = await readBody(req); const m = settings.machine;
  for (const k of ['waterInlet', 'drainConnected', 'cooling', 'checklist']) if (typeof b[k] === 'boolean') m[k] = b[k];
  if (b.coolingSource === 'inlet' || b.coolingSource === 'external') m.coolingSource = b.coolingSource;
  if (b.levelSensor === 'mash' || b.levelSensor === 'boil') { m.levelSensor = b.levelSensor; client.levelTank = b.levelSensor; }
  saveSettings(); broadcast('settings', publicSettings()); return publicSettings();
});
route('POST', '/api/settings/notify', async (req) => {
  const b = await readBody(req); const n = settings.notify;
  for (const k of ['ntfyUrl', 'ntfyToken', 'pushoverToken', 'pushoverUser', 'webhookUrl']) {
    if (typeof b[k] === 'string' && b[k] !== MASK) n[k] = b[k].trim();
  }
  for (const k of ['alarms', 'push']) if (typeof b[k] === 'boolean') n[k] = b[k];
  if (b.events && typeof b.events === 'object') for (const k of Object.keys(n.events)) if (typeof b.events[k] === 'boolean') n.events[k] = b.events[k];
  if (n.ntfyUrl && !/^https?:\/\//.test(n.ntfyUrl)) throw new Error('ntfy URL must start with http:// or https://');
  if (n.webhookUrl && !/^https?:\/\//.test(n.webhookUrl)) throw new Error('Webhook URL must start with http:// or https://');
  saveSettings(); broadcast('settings', publicSettings()); return publicSettings();
});
route('POST', '/api/notify/test', async () => {
  broadcast('alarm', { event: 'test', title: 'Test alarm', message: 'This is how a Brewie alert sounds and looks.', level: 'error', at: Date.now() });
  if (!notifier.configured()) return { ok: true, results: [], note: 'No push channel configured — only the in-browser alarm was triggered.' };
  const results = await notifier.send('test', 'Brewie Web test', 'Notifications are working. You will get alerts like this when the Brewie needs attention.', 'error', { force: true });
  return { ok: results.every((r) => r.ok), results };
});
route('POST', '/api/disconnect', () => { client.disconnect(); return { ok: true }; });
route('POST', '/api/discover', async () => ({ hosts: await discover({ port: settings.port || P.PORT }) }));

route('GET', '/api/recipes', () => store.summaries());
route('GET', '/api/recipes/:id', (req, p) => { const r = store.get(p.id); if (!r) throw Object.assign(new Error('Recipe not found'), { code: 404 }); return r; });
route('POST', '/api/recipes', async (req) => {
  const b = await readBody(req);
  let r;
  if (b.cloneFrom) { const src = store.get(b.cloneFrom); if (!src) throw Object.assign(new Error('Source recipe not found'), { code: 404 }); r = JSON.parse(JSON.stringify(src)); r.id = newId(); r.path = `/recipes/${r.id}`; r.name = b.name || `${src.name} (copy)`; }
  else if (b.recipe) { r = b.recipe; if (!r.id || store.get(r.id)) r.id = newId(); r.path = `/recipes/${r.id}`; }
  else { r = blankRecipe(newId()); if (b.name) r.name = b.name; }
  store.put(r); autoPush(r.id); return r;
});
route('PUT', '/api/recipes/:id', async (req, p) => {
  const b = await readBody(req); if (!b || typeof b !== 'object') throw new Error('Recipe JSON required');
  b.id = p.id; if (!b.path) b.path = (store.get(p.id) || {}).path || `/recipes/${p.id}`;
  store.put(b); autoPush(p.id); return b;
});
route('DELETE', '/api/recipes/:id', (req, p) => {
  const ok = store.remove(p.id);
  if (client.connection === 'connected') { try { client.sendRemoved(); } catch (_) {} }
  return { ok };
});
route('POST', '/api/recipes/:id/push', (req, p) => { requireConnected(); client.pushRecipe(p.id); return { ok: true }; });
route('POST', '/api/sync', () => { requireConnected(); client.syncRecipes(); return { ok: true }; });

route('POST', '/api/brew/start', async (req) => {
  requireConnected(); const b = await readBody(req);
  if (!store.get(b.id)) throw Object.assign(new Error('Unknown recipe'), { code: 404 });
  client.startBrew(b.id, { waterInlet: b.waterInlet !== false, cooling: b.cooling !== false }); return { ok: true };
});
for (const [name, fn] of Object.entries({ pause: 'pause', resume: 'resume', next: 'nextStep', stop: 'stop', query: 'query' })) {
  route('POST', `/api/brew/${name}`, () => { requireConnected(); client[fn](); return { ok: true }; });
}
route('POST', '/api/brew/estop', () => { requireConnected(); client.emergencyStop(); return { ok: true }; });
route('POST', '/api/clean', async (req) => { requireConnected(); const b = await readBody(req); client.clean(Number(b.program || 1), b.waterInlet !== false); return { ok: true }; });
route('POST', '/api/drain', async (req) => { requireConnected(); const b = await readBody(req); client.drain(b); return { ok: true }; });
route('POST', '/api/raw', async (req) => {
  requireConnected(); const b = await readBody(req);
  const type = Number(b.type); if (!Number.isInteger(type)) throw new Error('type must be an integer');
  client.send({ type, data: b.data }); return { ok: true };
});

function autoPush(id) {
  if (client.connection !== 'connected') return;
  try { client.pushRecipe(id); client.sendRecipeList(); } catch (_) {}
}

// ------------------------------------------------------------------ server
const server = http.createServer(async (req, res) => {
  if (!authorized(req)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Brewie"' }); return res.end('Authentication required'); }
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`event: state\ndata: ${JSON.stringify(client.snapshot())}\n\n`);
      sseClients.add(res); req.on('close', () => sseClients.delete(res)); return;
    }
    const m = url.pathname.match(/^\/api\/recipes\/([^/]+)\/export$/);
    if (m && req.method === 'GET') {
      const r = store.get(decodeURIComponent(m[1])); if (!r) return send(res, 404, { error: 'Recipe not found' });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${String(r.name || r.id).replace(/[^\w .-]/g, '_')}.brewie"` });
      return res.end(JSON.stringify(r, null, 2));
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const mm = url.pathname.match(r.re); if (!mm) continue;
      const params = Object.fromEntries(Object.entries(mm.groups || {}).map(([k, v]) => [k, decodeURIComponent(v)]));
      return send(res, 200, await r.fn(req, params));
    }
    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
    // static
    let file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(PUBLIC)) return send(res, 403, 'Forbidden', 'text/plain');
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': file.endsWith('datas.json') ? 'max-age=86400' : 'no-cache' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    send(res, e.code && Number.isInteger(e.code) ? e.code : 400, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`Brewie Web ${VERSION} listening on http://0.0.0.0:${PORT}`);
  if (settings.host) { console.log(`Connecting to Brewie at ${settings.host}:${settings.port}`); client.connect(); }
  else console.log('No Brewie address configured yet — set BREWIE_HOST or use the Settings page.');
});
const shutdown = () => { client.disconnect(); if (sim) sim.close(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
