'use strict';
/**
 * Brewie machine simulator — implements the machine side of the protocol well
 * enough to develop and demo the web UI without hardware.
 *
 *   node src/simulator.js [--port 8001] [--data ./sim-data] [--speed 30]
 *
 * --speed multiplies simulated time (30 = a 60 min mash rest takes 2 minutes).
 */
const net = require('net');
const fs = require('fs');
const path = require('path');
const P = require('./protocol');
const { sampleRecipes, SHORT_CLEAN_INSTRUCTIONS } = require('./samples');

function arg(name, def) { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : def; }

class SimMachine {
  constructor({ port = 8001, dataDir = path.join(__dirname, '..', 'sim-data'), speed = 30 } = {}) {
    this.port = port; this.speed = Number(speed); this.dir = path.join(dataDir, 'recipes');
    fs.mkdirSync(this.dir, { recursive: true });
    if (!fs.readdirSync(this.dir).length) for (const r of sampleRecipes()) this.saveRecipe(r);
    this.clients = new Set(); this.brew = null;
    this.mashTemp = 19.4; this.boilTemp = 18.9; this.volume = 0; this.notifications = [];
    this.removed = [];
  }

  recipes() { return fs.readdirSync(this.dir).filter((f) => f.endsWith('.brewie')).map((f) => {
    const full = path.join(this.dir, f); return { r: JSON.parse(fs.readFileSync(full, 'utf8')), t: fs.statSync(full).mtimeMs };
  }); }
  getRecipe(id) { try { return JSON.parse(fs.readFileSync(path.join(this.dir, id + '.brewie'), 'utf8')); } catch (_) { return null; } }
  saveRecipe(r) { fs.writeFileSync(path.join(this.dir, r.id + '.brewie'), JSON.stringify(r, null, 2)); }
  removeRecipe(id) { try { fs.unlinkSync(path.join(this.dir, id + '.brewie')); } catch (_) {} }

  start() {
    this.server = net.createServer((sock) => this.onClient(sock));
    this.server.listen(this.port, () => console.log(`[sim] Brewie simulator listening on :${this.port} (speed x${this.speed})`));
    this.tick = setInterval(() => this.step(1), 1000);
    return this;
  }
  close() { clearInterval(this.tick); for (const c of this.clients) c.destroy(); this.server.close(); }

  send(sock, type, data) { if (!sock.destroyed) sock.write(P.encodeFrame({ type, data })); }
  broadcast(type, data) { for (const s of this.clients) if (s.paired) this.send(s, type, data); }

  // Like the real Brewie: one controller at a time. Extra connections wait in a queue and
  // anything they send before being picked up is ignored. When the active one closes, the
  // next waiting socket is taken — even if it has already gone away (which jams the slot,
  // exactly the failure seen on the real machine).
  onClient(sock) {
    sock.on('error', () => {});
    sock.on('close', () => { sock.gone = true; this.clients.delete(sock); if (this.active === sock) { this.active = null; this.promote(); } });
    this.queue = this.queue || [];
    if (this.active) { this.queue.push(sock); return; }
    this.activate(sock);
  }
  activate(sock) {
    this.active = sock; this.clients.add(sock);
    if (sock.gone) { this.jammed = true; return; } // dead socket taken: slot stuck until restart
    const parser = new P.FrameParser();
    sock.on('data', (c) => { for (const m of parser.push(c)) this.onMessage(sock, m); });
  }
  promote() { const next = (this.queue || []).shift(); if (next) this.activate(next); }

  brewingBytes() { return this.brew ? P.encodeBrewing(this.brew) : Buffer.alloc(0); }

  onMessage(sock, { type, data }) {
    switch (type) {
      case P.MSG.HELLO: if (data === 'brewie?') { sock.paired = true; this.send(sock, P.MSG.HELLO_REPLY, 'hey'); } break;
      case P.MSG.COMMAND:
        if (data === '?') { if (this.brew) this.send(sock, P.MSG.COMMAND, this.brewingBytes()); break; } // real machine: silent when idle
        if (!this.brew) break;
        if (data === P.CMD.PAUSE) this.brew.status = 2;
        else if (data === P.CMD.CONTINUE) this.brew.status = 1;
        else if (data === P.CMD.NEXT_STEP) { this.advance(); this.notifications = []; }
        else if (data === P.CMD.STOP) { this.brew = null; this.notifications = []; this.lastMash = this.lastBoil = 0; }
        this.broadcast(P.MSG.COMMAND, data);
        break;
      case P.MSG.REMOVED_LIST:
        for (const id of data || []) this.removeRecipe(id);
        this.send(sock, P.MSG.REMOVED_LIST, this.removed.splice(0));
        break;
      case P.MSG.RECIPE_LIST: {
        const theirs = P.decodeFramedMaps(data || Buffer.alloc(0));
        const mine = new Map(this.recipes().map((x) => [x.r.id, x]));
        for (const e of theirs) {
          const m = mine.get(e.id);
          if (!m || (e.modified && e.time > m.t)) this.send(sock, P.MSG.RECIPE_REQUEST, e.id);
        }
        const known = new Set(theirs.map((e) => e.id));
        for (const [id, x] of mine) if (!known.has(id)) this.send(sock, P.MSG.RECIPE, P.encodeRecipe(x.r));
        break;
      }
      case P.MSG.RECIPE_REQUEST: { const r = this.getRecipe(data); if (r) this.send(sock, P.MSG.RECIPE, P.encodeRecipe(r)); break; }
      case P.MSG.RECIPE: { try { const r = P.decodeRecipe(data); if (r.id) this.saveRecipe(r); } catch (e) { console.log('[sim] bad recipe', e.message); } break; }
      case P.MSG.START_BREW: {
        const r = this.getRecipe(data && data.id);
        if (!r || this.brew) { this.send(sock, P.MSG.START_BREW, false); break; }
        this.brew = makeBrewing(r, data);
        this.send(sock, P.MSG.START_BREW, true);
        break;
      }
      case P.MSG.CLEAN_SANITIZE: case P.MSG.CLEAN_SHORT: case P.MSG.CLEAN_OTHER:
        if (this.brew) { this.send(sock, type, Buffer.alloc(0)); break; }
        this.brew = makeCleaning(type - 300); this.brew.isWaterInlet = !!data;
        this.send(sock, type, this.brewingBytes());
        break;
      case P.MSG.DRAIN: // like the machine: refused while a program runs, otherwise starts a drain program
        if (this.brew) { this.send(sock, P.MSG.DRAIN, false); break; }
        this.brew = makeDrain(data || {}); this.send(sock, P.MSG.DRAIN, true); break;
      default: break;
    }
  }

  advance() {
    const b = this.brew; if (!b) return;
    b.step++; b.stepElapsed = 0;
    if (b.step >= b.instructions.length) { b.status = 3; b.step = b.instructions.length - 1; setTimeout(() => { this.brew = null; }, 15000); }
  }

  step(dt) {
    const b = this.brew; const sdt = dt * this.speed;
    let mashTarget = this.lastMash || 19; let boilTarget = this.lastBoil || 19; let left = 0; let stepTime = 0;
    if (b && b.status === 1) {
      const ins = b.instructions[b.step]; const d = P.describeInstruction(ins);
      b.elapsed += sdt; b.stepElapsed += sdt;
      if (d.mashTarget) mashTarget = this.lastMash = d.mashTarget;
      if (d.boilTarget) boilTarget = this.lastBoil = d.boilTarget;
      const o = P.stepOutputs(ins) || {};
      if (d.inner === 10 || (o.waterInlet && o.boilInlet)) this.volume = Math.min(this.volume + 0.12 * sdt, 25);
      else if (o.outlet && o.boilPump) { if (!this.stuckDrain) this.volume = Math.max(0, this.volume - 0.1 * sdt); }
      else if (o.boilPump && o.mashInlet && !o.boilReturn) this.volume = Math.max(0, this.volume - 0.08 * sdt); // to mash
      else if (o.mashPump && !o.mashReturn) this.volume = Math.min(25, this.volume + 0.05 * sdt); // from mash
      const heatingMash = d.mashTarget && Math.abs(this.mashTemp - mashTarget) > 0.4;
      const heatingBoil = d.boilTarget && Math.abs(this.boilTemp - boilTarget) > 0.4;
      const dur = d.duration || 60;
      if (d.inner === 13) {
        if (!this.notifications.includes('P103') && b.stepElapsed > 20) this.notifications = ['P103'];
      } else if (!heatingMash && !heatingBoil && b.stepElapsed >= dur) this.advance();
      stepTime = b.stepElapsed; left = Math.max(0, dur - b.stepElapsed);
    } else if (b && b.status === 2) { stepTime = b.stepElapsed; }
    const approach = (cur, target, rate) => cur + Math.sign(target - cur) * Math.min(Math.abs(target - cur), rate * dt * this.speed / 30);
    this.mashTemp = approach(this.mashTemp, b && b.status === 1 ? mashTarget : 19, 0.9) + (Math.random() - 0.5) * 0.05;
    this.boilTemp = approach(this.boilTemp, b && b.status === 1 ? boilTarget : 19, 1.2) + (Math.random() - 0.5) * 0.05;
    if (!b) return; // real machine only streams status while a program is active
    const notif = [...this.notifications, 'V7'].join(',');
    const f = (x, d = 3) => x.toFixed(d);
    const heatM = b.status === 1 && this.mashTemp < mashTarget - 0.3 ? 1 : 0;
    const heatB = b.status === 1 && this.boilTemp < boilTarget - 0.3 ? 1 : 0;
    const line = [b.step, Math.round(b.elapsed), Math.round(stepTime), Math.round(left), notif,
      Math.round(1500 + this.volume * 260), f(this.volume), f(this.mashTemp - 0.556), f(this.boilTemp - 0.088, 2), f(this.mashTemp * 10, 2), f(this.boilTemp * 10, 1),
      '0.0000', f(b.status === 1 ? 110 : 0, 3), 0, 27, b.status === 1 ? 1 : 0, b.status === 1 ? 108 : 23, heatM, heatB, 370 + Math.round(Math.random() * 8), '',
      f(b.elapsed * 0.3, 4), '', f(this.boilTemp * 0.85, 3), ''].join('\t');
    this.broadcast(P.MSG.STATUS, line);
  }
}

function instr(main, inner, idx, { mash = 0, boil = 0, duration = 0, mode = 0 } = {}) {
  const a = new Array(23).fill(0);
  a[0] = main; a[1] = inner; a[2] = idx; a[6] = Math.round(mash * 10); a[7] = Math.round(boil * 10); a[18] = duration; a[19] = mode;
  return a;
}

function makeBrewing(r, opts) {
  const ins = []; const add = (...x) => ins.push(instr(x[0], x[1], ins.length, x[2]));
  const mash = r.mash || {};
  if (opts.isWaterInlet) add(0, 10, { duration: 240 });
  add(0, 12, { mash: mash.mashInTemperature || 67, duration: 30 });
  add(0, 13, { duration: 90 });
  const rounds = Array.isArray(mash.mashSteps) ? mash.mashSteps.map((x) => (Array.isArray(x) ? x : [x])) : [];
  rounds.forEach((round, ri) => {
    round.forEach((s) => { add(1, 14, { mash: s.stepTemp, duration: 60 }); add(1, 15, { mash: s.stepTemp, duration: (s.stepTime || 0) * 60 }); });
    if (ri < rounds.length - 1) add(1, 26, {});
  });
  if (mash.spargingWater) { add(2, 17, { boil: mash.spargingTemperature || 76, duration: 120 }); add(2, 18, { mash: mash.spargingTemperature || 76, boil: mash.spargingTemperature || 76, duration: (mash.spargingTime || 10) * 60 }); }
  add(3, 19, { boil: 100, duration: 180 });
  const boilMin = Math.max(60, ...flat(r.hops).map((h) => Number(h.time) || 0));
  add(3, 20, { boil: 100, duration: boilMin * 60 });
  add(4, 22, { duration: 900 });
  add(5, 24, { duration: 600 });
  const est = ins.reduce((s, x) => s + x[18], 0);
  return { id: `/recipes/${r.name || r.id}`, type: 0, status: 1, estimatedTime: est, isWaterInlet: !!opts.isWaterInlet, isCooling: !!opts.isCooling, instructions: ins, step: 0, elapsed: 0, stepElapsed: 0 };
}
function makeCleaning(program) {
  const ins = JSON.parse(JSON.stringify(SHORT_CLEAN_INSTRUCTIONS)); // the machine's real short-clean program
  return { id: '/cleaning', type: program, status: 1, estimatedTime: ins.reduce((a, x) => a + (Number(x[18]) || 0), 0), isWaterInlet: true, isCooling: false, instructions: ins, step: 0, elapsed: 0, stepElapsed: 0 };
}
function makeDrain(d) {
  const ins = []; let i = 0;
  const step = (inner, dur) => { const a = instr(5, inner, i++, { duration: dur, mode: 8 }); a[14] = 1; a[16] = 255; ins.push(a); };
  if (d.isBoilingTankActive || d.isMashingTankActive) step(75, 300);
  if (d.isHopTankActive) step(75, 60);
  return { id: '/drain', type: 4, status: 1, estimatedTime: ins.reduce((a, x) => a + x[18], 0), isWaterInlet: false, isCooling: false, instructions: ins, step: 0, elapsed: 0, stepElapsed: 0 };
}
function flat(x) { return Array.isArray(x) ? x.flat(Infinity).filter((v) => v && typeof v === 'object') : []; }

if (require.main === module) {
  const m = new SimMachine({ port: Number(arg('port', 8001)), dataDir: arg('data', path.join(process.cwd(), 'sim-data')), speed: arg('speed', 30) }).start();
  m.stuckDrain = process.argv.includes('--stuck-drain');
}
module.exports = { SimMachine, __makeCleaning: makeCleaning };
