'use strict';
/**
 * BrewieClient — speaks the Brewie Control protocol to one machine, the same
 * way the Android app does, and emits high-level events for the web layer.
 *
 * Events: 'state' (connection/brew snapshot), 'status' (parsed MCU line),
 *         'log' ({dir, type, name, summary}), 'recipes' (store changed), 'error'.
 */
const net = require('net');
const os = require('os');
const { EventEmitter } = require('events');
const P = require('./protocol');
const STALE_STATUS_MS = 5000; // status older than this (no program streaming) means nothing is running
const LAMP_NAMES = { mashHeater: 'Mash heater', boilHeater: 'Boil heater', mashPump: 'Mash pump', boilPump: 'Boil pump', waterInlet: 'Water inlet', mashInlet: 'Mash inlet', boilInlet: 'Boil inlet', mashReturn: 'Mash return', boilReturn: 'Boil return', coolValve: 'Cooling valve', outlet: 'Drain outlet', hop1: 'Hop cage 1', hop2: 'Hop cage 2', hop3: 'Hop cage 3', hop4: 'Hop cage 4', waiting: 'Waiting for you' };
const LAMP_KEYS = [...Object.keys(LAMP_NAMES), 'alert'];
const { QV } = require('./qt/qdatastream');

const PAIR_TIMEOUT_MS = 12000;
// The machine is silent while idle (no status, no answer to "?"), so silence alone
// never means the link is dead; TCP keep-alive and socket errors handle that.
const QUERY_GRACE_MS = 4000;     // no answer to "?" within this time => nothing is running
const ACTIVE_SILENCE_MS = 6000;  // a program was running but status stopped => re-check

class BrewieClient extends EventEmitter {
  constructor({ store, host = '', port = P.PORT, autoReconnect = true, logRaw = false } = {}) {
    super();
    this.store = store; this.host = host; this.port = port;
    this.autoReconnect = autoReconnect; this.logRaw = logRaw;
    this.sock = null; this.parser = null;
    this.connection = 'disconnected'; // disconnected | connecting | pairing | connected
    this.lastError = null; this.lastSeen = 0; this.connectedAt = 0;
    this.status = null; this.statusHistory = [];
    this.brewing = null; this.brewingKnown = false; this.lastQuery = 0;
    this.pending = null; // {kind, at}
    this.reconnectDelay = 5000; this.timers = {};
    this.syncState = { lastSync: 0, received: 0, sent: 0, inProgress: false };
    this.tank = { in: 0, out: 0, lastBoil: null }; // water balance for the tank without a level sensor
    this.levelTank = 'mash'; // which tank the Brewie's single water-level reading belongs to (Settings → Machine setup)
    this.activity = []; this.lastLamps = null; this.lastStepIdx = null; this.lastEcho = ''; this.lastAlerts = '';
    store.on('change', (c) => this.emit('recipes', c));
  }

  // ------------------------------------------------------------ connection
  setHost(host, port) {
    this.host = (host || '').trim(); if (port) this.port = Number(port);
    this.disconnect(true);
    if (this.host) this.connect();
  }

  connect() {
    if (!this.host) return;
    this.clearTimer('reconnect');
    this.disconnect(true);
    this.autoReconnectPaused = false;
    this.setConnection('connecting');
    const sock = net.createConnection({ host: this.host, port: this.port });
    this.sock = sock; this.parser = new P.FrameParser();
    sock.setNoDelay(true); sock.setKeepAlive(true, 10000);
    // The Brewie serves ONE controller at a time and silently leaves extra connections waiting.
    // Never churn sockets (dead waiting sockets can jam its single slot): keep this one open and
    // repeat the hello until the Brewie picks it up.
    sock.on('connect', () => {
      this.lastError = null;
      this.setConnection('pairing');
      this.pairStarted = Date.now();
      const hello = () => {
        if (this.connection !== 'pairing' || this.sock !== sock) return;
        try { sock.write(P.encodeFrame({ type: P.MSG.HELLO, data: 'brewie?' })); } catch (_) {}
        if (Date.now() - this.pairStarted > PAIR_TIMEOUT_MS) {
          this.lastError = 'Waiting for the Brewie — another controller (phone app or another Brewie Web) may be connected';
          this.emitState();
        }
        this.setTimer('pair', hello, 5000);
      };
      this.log('out', P.MSG.HELLO, 'HELLO', 'brewie? (repeats every 5 s until the Brewie answers)');
      hello();
    });
    sock.on('data', (chunk) => {
      this.lastSeen = Date.now();
      let msgs = [];
      try { msgs = this.parser.push(chunk); } catch (e) { this.log('in', -1, 'PARSE_ERROR', e.message); }
      for (const m of msgs) this.handle(m);
    });
    sock.on('error', (e) => this.fail(e));
    sock.on('close', () => { if (this.sock === sock) this.fail(new Error('Connection closed')); });
  }

  disconnect(silent = false) {
    this.clearTimer('pair'); this.clearTimer('watchdog');
    if (this.sock) { const s = this.sock; this.sock = null; s.removeAllListeners('close'); s.removeAllListeners('error'); s.on('error', () => {}); s.end(); setTimeout(() => s.destroy(), 1000); }
    if (!silent) { this.autoReconnectPaused = true; }
    if (this.connection !== 'disconnected') this.setConnection('disconnected');
  }

  fail(err) {
    if (!this.sock && this.connection === 'disconnected') return;
    this.lastError = err.message;
    this.log('sys', null, 'ERROR', err.message);
    this.disconnect(true);
    if (this.autoReconnect && this.host && !this.autoReconnectPaused) {
      this.setTimer('reconnect', () => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.6, 60000);
    }
  }

  setConnection(c) { this.connection = c; this.emitState(); }

  // ------------------------------------------------------------ sending
  sendRaw(msg) {
    if (!this.sock || this.sock.destroyed) throw new Error('Not connected to Brewie');
    this.sock.write(P.encodeFrame(msg));
    this.log('out', msg.type, P.MSG_NAMES[msg.type], summarize(msg.data));
  }
  send(msg) {
    if (this.connection !== 'connected') throw new Error('Not connected to Brewie');
    this.sendRaw(msg);
  }

  command(code) {
    this.send({ type: P.MSG.COMMAND, data: code });
    if (code === P.CMD.QUERY) {
      this.lastQuery = Date.now();
      // The Brewie only answers "?" when a program is active; silence means idle.
      this.setTimer('queryGrace', () => {
        this.brewingKnown = true;
        if (this.status && Date.now() - this.status.at < 5000 && this.brewing) return; // still streaming: still running
        if (this.brewing) { this.setBrewing(null); this.emit('notice', { text: 'Program finished', level: 'info', at: Date.now() }); }
        this.emitState();
      }, QUERY_GRACE_MS);
    }
  }
  query() { this.command(P.CMD.QUERY); }
  // The machine doesn't acknowledge these, so re-read the program state shortly after.
  refreshSoon(ms = 1200) { this.setTimer('refresh', () => { try { this.query(); } catch (_) {} }, ms); }
  pause() { this.addActivity('user', 'You pressed Pause'); this.command(P.CMD.PAUSE); if (this.brewing) this.brewing.status = 2; this.refreshLamps(); this.emitState(); this.refreshSoon(); }
  resume() { this.addActivity('user', 'You pressed Resume'); this.command(P.CMD.CONTINUE); if (this.brewing) this.brewing.status = 1; this.emitState(); this.refreshSoon(); }
  nextStep() { this.addActivity('user', 'You pressed Continue / next step'); this.command(P.CMD.NEXT_STEP); this.refreshSoon(); }
  /** Emergency stop: pause first (the controller drops heaters and pumps immediately), then end the program. */
  emergencyStop() {
    this.addActivity('alert', 'EMERGENCY STOP pressed');
    this.command(P.CMD.PAUSE);
    if (this.brewing) this.brewing.status = 2;
    this.refreshLamps();
    setTimeout(() => { try { this.command(P.CMD.STOP); } catch (_) {} this.refreshSoon(); }, 400);
  }
  stop() { this.addActivity('user', 'You pressed Stop'); this.command(P.CMD.STOP); this.refreshSoon(); }

  startBrew(recipeId, { waterInlet = true, cooling = true } = {}) {
    this.pending = { kind: 'start', at: Date.now(), recipeId };
    this.send({ type: P.MSG.START_BREW, data: { id: recipeId, isWaterInlet: !!waterInlet, isCooling: !!cooling } });
  }
  /**
   * program (= Brewing type): 1 = short clean (301), 2 = sanitizing clean (302), 3 = full clean (303).
   * The bool payload is "use the automatic water inlet" (machine: Brewing::setWaterInlet). With false the
   * Brewie waits for the water to be poured in by hand.
   */
  clean(program = 1, waterInlet = true) {
    const type = { 1: P.MSG.CLEAN_SHORT, 2: P.MSG.CLEAN_SANITIZE, 3: P.MSG.CLEAN_OTHER }[program] || P.MSG.CLEAN_SHORT;
    this.pending = { kind: 'clean', at: Date.now(), program };
    this.send({ type, data: QV.bool(waterInlet) });
  }
  drain({ boil = true, mash = true, hop = true, sedimentation = false } = {}) {
    this.pending = { kind: 'drain', at: Date.now() };
    this.send({ type: P.MSG.DRAIN, data: { isBoilingTankActive: !!boil, isMashingTankActive: !!mash, isHopTankActive: !!hop, sedimentation: !!sedimentation } });
  }

  // ------------------------------------------------------------ recipe sync
  sendRemoved() {
    const removed = this.store.takeRemoved();
    this.send({ type: P.MSG.REMOVED_LIST, data: removed });
  }
  sendRecipeList() {
    const list = this.store.syncList().map((e) => ({ id: e.id, time: QV.longlong(e.time), modified: QV.bool(e.modified) }));
    this.send({ type: P.MSG.RECIPE_LIST, data: P.encodeFramedMaps(list) });
    this.store.clearModified();
    this.syncState.lastSync = Date.now();
  }
  /** Full sync, as on pairing: removals first, then our recipe list. */
  syncRecipes() {
    this.syncState.inProgress = true; this.emitState();
    this.sendRemoved();
    // The app sends the list when the machine answers with its own removals (110);
    // fall back to sending it ourselves if the machine stays quiet.
    this.setTimer('syncFallback', () => { try { this.sendRecipeList(); } catch (_) {} this.finishSyncSoon(); }, 1500);
  }
  finishSyncSoon() { this.setTimer('syncDone', () => { this.syncState.inProgress = false; this.emitState(); }, 2500); }
  pushRecipe(id) {
    const r = this.store.get(id); if (!r) throw new Error('Unknown recipe ' + id);
    this.send({ type: P.MSG.RECIPE, data: P.encodeRecipe(r) });
    this.syncState.sent++;
  }
  requestRecipe(id) { this.send({ type: P.MSG.RECIPE_REQUEST, data: id }); }
  deleteOnMachine(id) { this.send({ type: P.MSG.REMOVED_LIST, data: [id] }); }

  // ------------------------------------------------------------ receiving
  handle(m) {
    const type = m.type; const data = m.data;
    this.log('in', type, P.MSG_NAMES[type], summarize(data));
    switch (type) {
      case P.MSG.HELLO_REPLY:
        if (data === 'hey') {
          this.clearTimer('pair');
          this.reconnectDelay = 5000; this.lastError = null; this.connectedAt = Date.now(); this.clearTimer('pair');
          this.autoReconnectPaused = false;
          this.setConnection('connected');
          this.query();
          this.syncRecipes();
          this.startWatchdog();
        }
        break;
      case P.MSG.STATUS: {
        const s = P.parseStatusLine(String(data || ''));
        s.at = Date.now();
        this.status = s;
        this.statusHistory.push({ t: s.at, mash: s.mashTemp, boil: s.boilTemp, vol: s.waterVolume });
        if (this.statusHistory.length > 3600) this.statusHistory.shift();
        if (s.step !== null && s.step >= 0 && this.brewing && this.brewing.status === 2) { /* paused -> running handled by echo */ }
        // Status only flows while a program runs. If we don't have that program (e.g. it was started
        // on the touchscreen), ask the Brewie for it.
        if (!this.brewing && Date.now() - this.lastQuery > 5000) { try { this.query(); } catch (_) {} }
        this.trackActivity();
        this.emit('status', this.summaryStatus());
        break;
      }
      case P.MSG.COMMAND:
        if (Buffer.isBuffer(data)) {
          this.clearTimer('queryGrace');
          this.brewingKnown = true;
          this.setBrewing(data.length ? P.decodeBrewing(data) : null);
        } else if (typeof data === 'string' && this.brewing) {
          if (data === P.CMD.CONTINUE) this.brewing.status = 1;
          else if (data === P.CMD.PAUSE) this.brewing.status = 2;
          else if (data === P.CMD.STOP) this.brewing = null;
          this.emitState();
        }
        break;
      case P.MSG.START_BREW:
        this.pending = null;
        this.notice(data ? 'Brewing started' : 'Machine refused to start the recipe', data ? 'ok' : 'error');
        setTimeout(() => { try { this.query(); } catch (_) {} }, 500);
        break;
      case P.MSG.CLEAN_SHORT: case P.MSG.CLEAN_SANITIZE: case P.MSG.CLEAN_OTHER:
        this.pending = null;
        if (Buffer.isBuffer(data) && data.length) { this.brewingKnown = true; this.setBrewing(P.decodeBrewing(data)); this.notice('Cleaning program started', 'ok'); }
        else this.notice('Machine refused the cleaning program', 'error');
        break;
      case P.MSG.DRAIN:
        this.pending = null;
        this.notice(data ? 'Draining started' : 'Machine refused to drain', data ? 'ok' : 'error');
        setTimeout(() => { try { this.query(); } catch (_) {} }, 500);
        break;
      case P.MSG.RECIPE_REQUEST: {
        const r = this.store.get(String(data));
        if (r) { this.send({ type: P.MSG.RECIPE, data: P.encodeRecipe(r) }); this.syncState.sent++; }
        break;
      }
      case P.MSG.RECIPE:
        try {
          const r = P.decodeRecipe(data);
          if (r && r.id) { this.store.put(r, { fromMachine: true }); this.syncState.received++; }
        } catch (e) { this.log('sys', null, 'ERROR', 'Could not decode recipe: ' + e.message); }
        this.finishSyncSoon();
        break;
      case P.MSG.REMOVED_LIST:
        for (const id of (Array.isArray(data) ? data : [])) this.store.remove(String(id), { fromMachine: true });
        this.clearTimer('syncFallback');
        try { this.sendRecipeList(); } catch (_) {}
        this.finishSyncSoon();
        break;
      case P.MSG.REMOVE_RECIPE:
        if (data) this.store.remove(String(data), { fromMachine: true });
        break;
      case P.MSG.DISCOVERY_SERIAL:
        this.serial = String(data); this.emitState();
        break;
      default: break;
    }
    this.emitState();
  }

  /** Time-stamped activity entry (kind: stage|step|on|off|cmd|alert|user|info). */
  addActivity(kind, text) {
    const e = { at: Date.now(), kind, text }; this.activity.push(e);
    if (this.activity.length > 1000) this.activity.shift();
    this.emit('activity', e);
  }

  /** Current lamp states: heaters/pumps from live readings, valves from the active step. */
  lamps() {
    const s = this.status; const b = this.brewing; if (!s) return null;
    // No program, or the last reading is old (the Brewie goes silent when a program ends): nothing is running.
    if (!b || Date.now() - (s.at || 0) > STALE_STATUS_MS) {
      const off = {}; for (const k of LAMP_KEYS) off[k] = false; return off;
    }
    // Paused: the controller drops outputs, so trust live readings only, not the step's plan.
    const ins = b.instructions && s.step >= 0 && b.status !== 2 ? b.instructions[s.step] : null;
    const o = P.stepOutputs(ins) || {};
    const live = (p) => !!(p && ((p.tach || 0) > 0));
    return {
      mashHeater: !!s.mashHeater, boilHeater: !!s.boilHeater,
      mashPump: live(s.mashPump) || !!o.mashPump, boilPump: live(s.boilPump) || !!o.boilPump,
      waterInlet: !!o.waterInlet, mashInlet: !!o.mashInlet, boilInlet: !!o.boilInlet,
      mashReturn: !!o.mashReturn, boilReturn: !!o.boilReturn, coolValve: !!o.coolValve, outlet: !!o.outlet,
      hop1: !!o.hop1, hop2: !!o.hop2, hop3: !!o.hop3, hop4: !!o.hop4,
      waiting: (s.notifications || []).includes('P103'),
      alert: (s.notifications || []).some((n) => /^E/.test(n)),
    };
  }

  /**
   * The Brewie only measures the boil tank (pressure sensor). Estimate the mash tank by water
   * balance: boil rising with the inlet open = water in; falling with the drain open = water out;
   * any other change is water moving between the tanks.
   */
  trackWater() {
    const s = this.status; const l = this.lastLamps || {}; const v = s && s.waterVolume;
    if (typeof v !== 'number') return;
    const t = this.tank;
    if (t.lastBoil === null) { t.lastBoil = v; t.in = Math.max(t.in, v); return; }
    const dv = v - t.lastBoil; t.lastBoil = v;
    if (Math.abs(dv) < 0.02 || Math.abs(dv) > 5) return; // sensor noise / glitches
    if (dv > 0 && l.waterInlet) t.in += dv;
    else if (dv < 0 && l.outlet) t.out += -dv;
    if (t.in - t.out < v) t.in = t.out + v; // never less water in the system than we can see
  }
  /** Warn when the drain is open and a pump runs but the measured tank's level doesn't fall. */
  watchDrain() {
    const s = this.status; const l = this.lastLamps || {}; const v = s && s.waterVolume;
    const draining = l.outlet && (this.levelTank === 'mash' ? l.mashPump : l.boilPump) && typeof v === 'number';
    if (!draining) { this.drainWatch = null; if (this.warning && this.warning.code === 'DRAIN_STALL') this.warning = null; return; }
    if (!this.drainWatch) { this.drainWatch = { at: Date.now(), v }; return; }
    const w = this.drainWatch;
    if (v < w.v - 0.3) { this.drainWatch = { at: Date.now(), v }; if (this.warning && this.warning.code === 'DRAIN_STALL') { this.warning = null; this.addActivity('info', 'Draining resumed'); } return; }
    if (Date.now() - w.at > 60000 && v > 1 && !(this.warning && this.warning.code === 'DRAIN_STALL')) {
      this.warning = { code: 'DRAIN_STALL', text: `${this.levelTank === 'mash' ? 'Mash' : 'Boil'} tank isn't draining — level stuck at ${v.toFixed(1)} L for a minute with the drain open. A valve may be stuck or the outlet clogged.` };
      this.addActivity('alert', this.warning.text);
      this.notice('Drain looks stuck — see the Advanced tab', 'error');
    }
  }
  tanks() {
    const s = this.status; if (!s || typeof s.waterVolume !== 'number') return null;
    const other = Math.round(Math.max(0, this.tank.in - this.tank.out - s.waterVolume) * 10) / 10;
    return this.levelTank === 'mash'
      ? { measured: 'mash', mash: s.waterVolume, boilEst: other }
      : { measured: 'boil', boil: s.waterVolume, mashEst: other };
  }

  trackActivity() {
    const s = this.status; const b = this.brewing; if (!s) return;
    this.trackWater();
    this.watchDrain();
    const names = LAMP_NAMES;
    if (b && b.steps && s.step >= 0 && s.step !== this.lastStepIdx) {
      const prevStage = this.lastStepIdx !== null && b.stages ? b.stages.find((x) => this.lastStepIdx >= x.first && this.lastStepIdx <= x.last) : null;
      const stage = b.stages ? b.stages.find((x) => s.step >= x.first && s.step <= x.last) : null;
      if (stage && stage !== prevStage) this.addActivity('stage', `Stage ${b.stages.indexOf(stage) + 1}/${b.stages.length}: ${stage.name}`);
      const d = b.steps[s.step];
      this.addActivity('step', `Step ${s.step + 1}/${b.steps.length}: ${d ? d.label : ''}${d && d.mashTarget ? ` · mash ${d.mashTarget} °C` : ''}${d && d.boilTarget ? ` · boil ${d.boilTarget} °C` : ''}${d && d.duration ? ` · ${Math.round(d.duration / 60) || '<1'} min` : ''}`);
      this.addActivity('cmd', `Step command: ${P.stepCommand(b.instructions[s.step])}`);
      this.lastStepIdx = s.step;
    }
    const l = this.lamps();
    if (l && this.lastLamps) for (const k of Object.keys(names)) if (l[k] !== this.lastLamps[k]) this.addActivity(l[k] ? 'on' : 'off', `${names[k]} ${l[k] ? (k === 'waiting' ? 'needs you' : 'ON') : (k === 'waiting' ? 'cleared' : 'OFF')}`);
    this.lastLamps = l;
    if (s.echo && s.echo !== this.lastEcho) this.addActivity('cmd', `Controller ← ${s.echo}`);
    this.lastEcho = s.echo || '';
    const al = (s.alerts || []).filter((a) => a.code !== 'P103').map((a) => a.code).join(',');
    if (al && al !== this.lastAlerts) for (const a of s.alerts.filter((x) => x.code !== 'P103' && !this.lastAlerts.includes(x.code))) this.addActivity('alert', `${a.code} ${a.text || ''}`);
    this.lastAlerts = al;
  }

  setBrewing(b) {
    this.clearTimer('queryGrace'); // fresh program data supersedes any pending "no answer = idle" check
    if (b && b.instructions) { b.steps = b.instructions.map(P.describeInstruction); b.stages = P.buildStages(b.instructions); b.plannedTotal = b.steps.reduce((a, x) => a + (x ? x.duration : 0), 0); }
    if (b && b.id) {
      const name = String(b.id).split('/').pop();
      b.recipeName = name;
    }
    if (b && (!this.brewing || this.brewing.id !== b.id || this.brewing.type !== b.type)) { this.tank = { in: 0, out: 0, lastBoil: null }; this.addActivity('info', `Program: ${P.BREW_TYPE[b.type] || 'Program'}${b.type === 0 ? ' — ' + (b.recipeName || '') : ''} (${b.stages ? b.stages.length : 0} stages, ${b.steps ? b.steps.length : 0} steps)`); this.lastStepIdx = null; }
    const ended = !b && this.brewing;
    if (ended) this.addActivity('info', 'Program ended');
    this.brewing = b;
    if (ended) this.refreshLamps();
    this.emitState();
  }
  /** Re-evaluate the lamps without new data from the machine (stop, pause, program end) and push them out. */
  refreshLamps() {
    if (!this.status) return;
    const l = this.lamps();
    if (l && this.lastLamps) for (const k of LAMP_KEYS) if (l[k] !== this.lastLamps[k] && LAMP_NAMES[k]) this.addActivity(l[k] ? 'on' : 'off', `${LAMP_NAMES[k]} ${l[k] ? (k === 'waiting' ? 'needs you' : 'ON') : (k === 'waiting' ? 'cleared' : 'OFF')}`);
    this.lastLamps = l;
    this.emit('status', this.summaryStatus());
  }

  startWatchdog() {
    this.setTimer('watchdog', () => {
      // While a program runs the machine streams status every second or so. If that stops,
      // ask again: no answer means the program ended (or was stopped on the machine).
      const quiet = Date.now() - this.lastSeen;
      if (this.brewing && quiet > ACTIVE_SILENCE_MS && Date.now() - this.lastQuery > ACTIVE_SILENCE_MS) { try { this.query(); } catch (_) {} }
      // Readings went stale (machine silent): don't leave pumps/heaters showing as on.
      if (this.status && this.lastLamps && Date.now() - this.status.at > STALE_STATUS_MS && Object.values(this.lastLamps).some(Boolean)) this.refreshLamps();
      this.startWatchdog();
    }, 2000);
  }

  // ------------------------------------------------------------ snapshots
  summaryStatus() {
    const s = this.status; if (!s) return null;
    const b = this.brewing;
    const step = b && b.steps && s.step !== null && s.step >= 0 ? b.steps[s.step] : null;
    const out = { ...s, raw: undefined, rawLine: s.raw.join('\t'), currentStep: step, lamps: this.lamps(), tanks: this.tanks(), warning: this.warning || null };
    if (b && b.stages && step) {
      // progress the way the touchscreen computes it: planned durations of finished instructions + time in the current one
      const si = b.stages.findIndex((x) => s.step >= x.first && s.step <= x.last);
      const done = b.steps.slice(0, s.step).reduce((a, x) => a + (x ? x.duration : 0), 0);
      const inStep = Math.min(s.stepTime || 0, step.duration || s.stepTime || 0);
      const elapsedPlan = done + inStep; const total = b.plannedTotal || b.estimatedTime || 0;
      const stage = b.stages[si];
      out.progress = {
        stageIndex: si, stageCount: b.stages.length, stageName: stage ? stage.name : null,
        stagePct: stage && stage.duration ? Math.min(100, (100 * (elapsedPlan - stage.start)) / stage.duration) : null,
        overallPct: total ? Math.min(100, (100 * elapsedPlan) / total) : null,
        remaining: total ? Math.max(0, total - elapsedPlan) : null,
      };
    }
    return out;
  }

  snapshot() {
    return {
      host: this.host, port: this.port, connection: this.connection, lastError: this.lastError,
      lastSeen: this.lastSeen, connectedAt: this.connectedAt, serial: this.serial || null,
      status: this.summaryStatus(),
      brewing: this.brewing ? {
        ...this.brewing, instructions: undefined,
        statusName: P.BREW_STATUS[this.brewing.status] || String(this.brewing.status),
        typeName: P.BREW_TYPE[this.brewing.type] || `Program ${this.brewing.type}`,
      } : null,
      brewingKnown: this.brewingKnown,
      pending: this.pending, sync: this.syncState,
    };
  }
  emitState() { this.emit('state', this.snapshot()); }
  notice(text, level = 'info') { this.addActivity(level === 'error' ? 'alert' : 'info', text); this.emit('notice', { text, level, at: Date.now() }); }
  log(dir, type, name, summary) { this.emit('log', { at: Date.now(), dir, type, name: name || String(type), summary }); }

  setTimer(k, fn, ms) { this.clearTimer(k); this.timers[k] = setTimeout(fn, ms); }
  clearTimer(k) { if (this.timers[k]) { clearTimeout(this.timers[k]); delete this.timers[k]; } }
}

function summarize(d) {
  if (d === null || d === undefined) return '';
  if (Buffer.isBuffer(d)) return `<${d.length} bytes>`;
  if (typeof d === 'string') return d.length > 160 ? d.slice(0, 160) + '…' : d;
  try { const s = JSON.stringify(d); return s.length > 160 ? s.slice(0, 160) + '…' : s; } catch (_) { return String(d); }
}

// ------------------------------------------------------------ discovery
/** Scan local /24 networks for something answering the Brewie handshake on :8001. */
async function discover({ port = P.PORT, timeout = 600, subnets } = {}) {
  const nets = subnets || Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address.split('.').slice(0, 3).join('.'));
  const uniq = [...new Set(nets)]; const found = [];
  const probe = (ip) => new Promise((resolve) => {
    const s = net.createConnection({ host: ip, port }); const parser = new P.FrameParser();
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeout, () => done(false));
    s.on('error', () => done(false));
    s.on('connect', () => { s.setTimeout(2500); s.write(P.encodeFrame({ type: P.MSG.HELLO, data: 'brewie?' })); });
    s.on('data', (c) => { for (const m of parser.push(c)) if (m.type === P.MSG.HELLO_REPLY && m.data === 'hey') { found.push(ip); return done(true); } });
  });
  for (const n of uniq) {
    const ips = Array.from({ length: 254 }, (_, i) => `${n}.${i + 1}`);
    for (let i = 0; i < ips.length; i += 64) await Promise.all(ips.slice(i, i + 64).map(probe));
  }
  return found;
}

module.exports = { BrewieClient, discover };
