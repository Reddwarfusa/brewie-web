// Notifications: errors, waiting-for-you and program end reach ntfy-style and webhook endpoints.
const http = require('http'); const fs = require('fs'); const os = require('os'); const path = require('path');
const { SimMachine } = require('../src/simulator'); const { BrewieClient } = require('../src/client'); const { RecipeStore } = require('../src/store');
process.env.WAIT_CONFIRM_MS = '2500';
const notify = require('../src/notify');
const got = [];
const sink = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { got.push({ path: req.url, title: req.headers.title, prio: req.headers.priority, body: b }); res.end('ok'); }); }).listen(18099);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ntf-'));
const sim = new SimMachine({ port: 18031, dataDir: path.join(tmp, 'sim'), speed: 1 }).start();
const c = new BrewieClient({ store: new RecipeStore(path.join(tmp, 'app')), host: '127.0.0.1', port: 18031 });
const settings = { ...notify.DEFAULTS, ntfyUrl: 'http://127.0.0.1:18099/brewie-test', webhookUrl: 'http://127.0.0.1:18099/hook' };
const alarms = []; notify.attach(c, new notify.Notifier(() => settings, () => {}), (a) => alarms.push(a));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  c.connect(); while (c.connection !== 'connected') await wait(100); await wait(1500);
  c.clean(1); while (!c.status) await wait(200); await wait(1500);
  sim.notifications = ['P103']; await wait(1100); sim.notifications = []; await wait(3500); // brief P103 at a step change: no alarm
  const blipAlarms = alarms.length;
  sim.notifications = ['E005']; await wait(2500);
  sim.notifications = ['P103']; await wait(5000);
  sim.notifications = []; await wait(1500);
  settings.alarms = false; settings.push = false; const before = [alarms.length, got.length];
  sim.notifications = ['E006']; await wait(2500); sim.notifications = []; await wait(1500);
  const offOk = alarms.length === before[0] && got.length === before[1];
  settings.alarms = true; settings.push = true;
  sim.brew = null; await wait(16000);
  if (process.env.DBG) console.log(c.activity.slice(-8).map((e) => e.kind + ': ' + e.text).join('\n'), '| brewing', !!c.brewing, '| lastQuery ago', Date.now() - c.lastQuery);
  const titles = got.filter((g) => g.path === '/brewie-test').map((g) => `${g.title} [p${g.prio}]`);
  const hooks = got.filter((g) => g.path === '/hook').map((g) => JSON.parse(g.body).event);
  console.log('ntfy:', titles.join(' | ')); console.log('webhook events:', hooks.join(', ')); console.log('browser alarms:', alarms.map((a) => a.level).join(', '));
  const ok = titles.some((t) => t.startsWith('Brewie error [p5]')) && titles.some((t) => t.startsWith('Brewie needs you')) && titles.some((t) => t.startsWith('Brewie finished')) && hooks.length === titles.length && blipAlarms === 0 && offOk;
  console.log('brief P103 ignored:', blipAlarms === 0, '| switches off silences everything:', offOk);
  console.log(ok ? 'ok  notifications delivered' : 'FAIL notifications');
  c.disconnect(); sim.close(); sink.close(); process.exit(ok ? 0 : 1);
})();
