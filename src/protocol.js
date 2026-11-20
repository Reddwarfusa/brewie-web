'use strict';
/**
 * Brewie "Brewie Control" network protocol, recovered from the Android app
 * (libBrewie.so, v1.1.15). See PROTOCOL.md for the full write-up.
 *
 * Transport: TCP port 8001.
 * Frame:     int32 BE length  +  QDataStream(QMap<QString,QVariant>{ type:int, data:QVariant })
 */
const { Writer, Reader, QV } = require('./qt/qdatastream');
const qbjs = require('./qt/qbjs');

const PORT = 8001;

const MSG = {
  HELLO: 0,            // app -> machine  data:"brewie?"
  HELLO_REPLY: 1,      // machine -> app  data:"hey"
  RECIPE_LIST: 100,    // app -> machine  data:QByteArray(concat of framed {id,time,modified})
  RECIPE_REQUEST: 101, // both ways       data:recipe id (QString)
  RECIPE: 102,         // both ways       data:qCompress(QJsonDocument binary)
  REMOVED_LIST: 110,   // both ways       data:QVariantList<QString> of removed recipe ids
  REMOVE_RECIPE: 111,  // machine -> app  data:recipe id
  COMMAND: 200,        // app -> machine  data:"?"|"200"|"201"|"204"|"999"; machine -> app: serialized brewing (QByteArray)
                       // NOTE: the machine ignores "?" while idle (it only answers when a program is active)
  STATUS: 201,         // machine -> app  data:MCU status line (tab separated) — only sent while a program is active
  START_BREW: 300,     // app -> machine  data:{id,isWaterInlet,isCooling}; reply data:bool
  CLEAN_SHORT: 301,    // app -> machine  data:bool; reply: serialized brewing / empty  (Brewing type 1)
  CLEAN_SANITIZE: 302, // sanitizing clean (Brewing type 2)
  CLEAN_OTHER: 303,    // full clean (Brewing type 3)  — payload for 301–303: bool = use automatic water inlet
  DRAIN: 304,          // app -> machine  data:{isBoilingTankActive,isMashingTankActive,isHopTankActive,sedimentation}
  DISCOVERY_SERIAL: 889, // machine -> app data:serial number
};
const MSG_NAMES = Object.fromEntries(Object.entries(MSG).map(([k, v]) => [v, k]));

const CMD = {
  QUERY: '?',
  CONTINUE: '200',
  PAUSE: '201',
  NEXT_STEP: '204',
  STOP: '999',
};

// --------------------------------------------------------------- framing
function encodeMap(map) { const w = new Writer(); w.qvariantmap(map); return w.toBuffer(); }

function encodeFrame(msg) {
  // msg: {type:int, data:any}. type must go out as Int.
  const body = encodeMap({ type: QV.int(msg.type), data: msg.data });
  const h = Buffer.alloc(4); h.writeInt32BE(body.length);
  return Buffer.concat([h, body]);
}

class FrameParser {
  constructor() { this.buf = Buffer.alloc(0); }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    const out = [];
    while (this.buf.length > 4) {
      const len = this.buf.readInt32BE(0);
      if (len <= 0 || len > 64 * 1024 * 1024) { this.buf = Buffer.alloc(0); break; } // resync on garbage
      if (this.buf.length < len + 4) break;
      const body = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      out.push(new Reader(body).qvariantmap());
    }
    return out;
  }
}

/** Concatenated framed maps, as used inside the RECIPE_LIST (100) payload. */
function encodeFramedMaps(list) { return Buffer.concat(list.map((m) => {
  const b = encodeMap(m); const h = Buffer.alloc(4); h.writeInt32BE(b.length); return Buffer.concat([h, b]);
})); }
function decodeFramedMaps(buf) { return new FrameParser().push(buf); }

// --------------------------------------------------------------- recipes on the wire
function encodeRecipe(recipe) { return qbjs.qCompress(qbjs.toBinaryData(recipe)); }
function decodeRecipe(buf) { return qbjs.fromBinaryData(qbjs.qUncompress(buf)); }

// --------------------------------------------------------------- brewing state
/**
 * Serialized Brewing (Brewing::serialize): QDataStream(QMap{id,type,status,estimatedTime,
 * isWaterInlet,isCooling,data:QByteArray(QDataStream(QList<QVariant> instructions))}).
 */
function decodeBrewing(buf) {
  if (!buf || !buf.length) return null;
  const m = new Reader(buf).qvariantmap();
  if (Buffer.isBuffer(m.data) && m.data.length) {
    try { m.instructions = new Reader(m.data).qvariantlist(); } catch (e) { m.instructions = []; }
  }
  delete m.data;
  return m;
}
function encodeBrewing(b) {
  const w = new Writer(); w.qvariantlist(b.instructions || []);
  return encodeMap({
    id: b.id, type: QV.int(b.type || 0), status: QV.int(b.status || 0), estimatedTime: QV.int(b.estimatedTime || 0),
    isWaterInlet: !!b.isWaterInlet, isCooling: !!b.isCooling, data: w.toBuffer(),
  });
}

/** Brewing::status values used by the app. */
const BREW_STATUS = { 0: 'idle', 1: 'running', 2: 'paused', 3: 'finished', 4: 'stopped' };
/** Brewing::type: 0 = beer brewing, other values = cleaning programs. */
const BREW_TYPE = { 0: 'Brewing', 1: 'Short clean', 2: 'Sanitizing clean', 3: 'Full clean', 4: 'Draining' };

/** Instruction vector indices (Brewing::addInstruction argument order). */
const INSTR = { MAIN: 0, INNER: 1, INDEX: 2, MASH_TARGET: 6, BOIL_TARGET: 7, DURATION: 18, MODE: 19 };
const MAIN_STEP = { 0: 'Preparation', 1: 'Mashing', 2: 'Sparging', 3: 'Boiling & hopping', 4: 'Cooling', 5: 'Finishing', 6: 'Cleaning', 7: 'Cleaning' };
/** Stage names as the Brewie touchscreen shows them (inner step type → name). */
const STAGE_NAME = {
  10: 'Water inlet', 11: 'Water inlet', 12: 'Heating up before mash in', 13: 'Mash in', 14: 'Mashing', 15: 'Mashing', 16: 'Mashing',
  26: 'Prepare the next mashing round', 17: 'Heating up before sparging', 18: 'Sparging', 19: 'Boiling', 20: 'Hopping', 21: 'Hop back',
  22: 'Cooling', 23: 'Cooling', 24: 'Finishing', 25: 'Sedimentation', 70: 'Cleaning', 71: 'Cleaning', 72: 'Cleaning', 73: 'Cleaning',
  74: 'Rinsing', 75: 'Draining', 76: 'Draining',
};
const INNER_STEP = {
  10: 'Filling water', 11: 'Filling water', 12: 'Heating to mash-in', 13: 'Add grains / prepare mash',
  14: 'Heating to step temperature', 15: 'Mash rest', 16: 'Recirculating', 17: 'Heating sparge water',
  18: 'Sparging', 19: 'Heating to boil', 20: 'Boiling', 21: 'Hop-back', 22: 'Cooling', 24: 'Finishing', 26: 'Next mash round',
  70: 'Cleaning', 71: 'Cleaning', 72: 'Cleaning', 73: 'Cleaning', 74: 'Rinsing', 75: 'Draining',
};

/**
 * Group instructions into the stages the touchscreen shows (consecutive instructions with the
 * same stage name). Durations are the planned seconds per instruction (index 18).
 */
function buildStages(instructions) {
  const stages = []; let t = 0;
  (instructions || []).forEach((ins, i) => {
    const d = describeInstruction(ins); if (!d) return;
    const name = STAGE_NAME[d.inner] || d.phase;
    let st = stages[stages.length - 1];
    if (!st || st.name !== name || st.main !== d.main) { st = { name, main: d.main, phase: d.phase, first: i, last: i, start: t, duration: 0 }; stages.push(st); }
    st.last = i; st.duration += d.duration; t += d.duration;
  });
  return stages;
}

/**
 * Outputs a step switches, from the step command the GUI sends the controller (P103, fields per the
 * ReBrewie firmware B20Plus.h). Instruction index i maps to P103 field i-2.
 */
const OUTPUTS = [
  ['waterInlet', 3, 'Water inlet'], ['mashInlet', 4, 'Mash inlet'], ['boilInlet', 5, 'Boil inlet'],
  ['hop1', 8, 'Hop cage 1'], ['hop2', 9, 'Hop cage 2'], ['hop3', 10, 'Hop cage 3'], ['hop4', 11, 'Hop cage 4'],
  ['coolValve', 12, 'Cooling valve'], ['outlet', 14, 'Drain outlet'], ['mashPump', 15, 'Mash pump'], ['boilPump', 16, 'Boil pump'],
  ['mashReturn', 21, 'Mash return'], ['boilReturn', 22, 'Boil return'],
];
function stepOutputs(ins) {
  if (!Array.isArray(ins)) return null;
  const o = {}; for (const [k, i] of OUTPUTS) { const v = ins[i]; o[k] = v === true || (typeof v === 'number' && v > 0); }
  return o;
}
function stepCommand(ins) { return Array.isArray(ins) ? 'P103 ' + ins.slice(2).map((v) => (v === true ? 1 : v === false ? 0 : v)).join(' ') : ''; }

function describeInstruction(ins) {
  if (!Array.isArray(ins)) return null;
  const main = ins[INSTR.MAIN]; const inner = ins[INSTR.INNER];
  return {
    main, inner,
    phase: MAIN_STEP[main] || `Phase ${main}`,
    label: INNER_STEP[inner] || `Step ${inner}`,
    mashTarget: ins[INSTR.MASH_TARGET] ? ins[INSTR.MASH_TARGET] / 10 : null,
    boilTarget: ins[INSTR.BOIL_TARGET] ? ins[INSTR.BOIL_TARGET] / 10 : null,
    duration: ins[INSTR.DURATION] || 0,
  };
}

// --------------------------------------------------------------- MCU status line
/**
 * The machine relays its microcontroller status line (type 201). Field layout
 * per the stock app's McuOutput parser and the open ReBrewie firmware.
 */
const STATUS_FIELDS = [ // ReBrewie firmware V7 layout, verified against the machine's own brewing logs
  'step', 'totalTime', 'stepTime', 'leftTime', 'notifications', 'mass', 'waterVolume',
  'mashTempRaw', 'boilTempRaw', 'mashTemp10', 'boilTemp10', 'mashPumpTach', 'boilPumpTach',
  'mashPumpDiag', 'mashPumpCurrent', 'boilPumpDiag', 'boilPumpCurrent', 'mashHeater', 'boilHeater',
  'boardTemp10', 'echo', 'flowTotal', 'unused22', 'sensorTemp', 'unused24',
];
function num(s) { if (s === undefined || s === '') return null; const n = Number(s); return Number.isFinite(n) ? n : null; }

function parseStatusLine(line) {
  const parts = String(line).replace(/\r?\n$/, '').split('\t');
  const raw = {}; STATUS_FIELDS.forEach((k, i) => { raw[k] = parts[i]; });
  const notif = (raw.notifications || '').split(',').map((s) => s.trim()).filter(Boolean);
  const version = notif.find((n) => /^V\d+/.test(n));
  const mash10 = num(raw.mashTemp10); const boil10 = num(raw.boilTemp10);
  return {
    valid: parts.length > 20,
    fieldCount: parts.length,
    step: num(raw.step),
    totalTime: num(raw.totalTime),
    stepTime: num(raw.stepTime),
    leftTime: num(raw.leftTime),
    notifications: notif.filter((n) => n !== version),
    alerts: notif.filter((n) => n !== version).map((code) => ({ code, text: NOTIFICATIONS[code] || null })),
    mcuVersion: version ? version.slice(1) : null,
    mass: num(raw.mass),
    waterVolume: num(raw.waterVolume),
    mashTemp: mash10 !== null ? mash10 / 10 : num(raw.mashTempRaw),
    boilTemp: boil10 !== null ? boil10 / 10 : num(raw.boilTempRaw),
    mashPump: { tach: num(raw.mashPumpTach), diag: num(raw.mashPumpDiag), current: num(raw.mashPumpCurrent) },
    boilPump: { tach: num(raw.boilPumpTach), diag: num(raw.boilPumpDiag), current: num(raw.boilPumpCurrent) },
    mashHeater: num(raw.mashHeater) === 1,
    boilHeater: num(raw.boilHeater) === 1,
    boardTemp: num(raw.boardTemp10) !== null ? num(raw.boardTemp10) / 10 : null,
    echo: raw.echo || '',
    flowTotal: num(raw.flowTotal),
    sensorTemp: num(raw.sensorTemp),
    raw: parts,
  };
}

/** Known MCU notification codes (P1xx) as named in the app's notification table. */
const NOTIFICATIONS = { // from the ReBrewie firmware flashed on the machine
  P103: 'Waiting for you to confirm before continuing',
  P303: 'Step data contained a negative value',
  P998: 'Drain button pressed on the machine',
  P999: 'Power button pressed on the machine',
  E005: 'No water from the inlet — check the tap and hose',
  E006: 'Cooling error',
  E007: 'Mash heater fault',
  E008: 'Boil heater fault',
  E009: 'Mash pump clogged',
  E010: 'Boil pump clogged',
  E011: 'No water detected',
  E012: 'Too much water',
  E115: 'Mash temperature sensor lost',
  E116: 'Boil temperature sensor lost',
  E118: 'Water level sensor error',
  E200: 'Valve 0 error', E201: 'Valve 1 error', E202: 'Valve 2 error', E203: 'Valve 3 error', E204: 'Valve 4 error',
  E205: 'Valve 5 error', E206: 'Valve 6 error', E207: 'Valve 7 error', E208: 'Valve 8 error', E209: 'Valve 9 error',
  E210: 'Heater overcurrent — heaters shut off',
  E220: 'Mash pump running dry',
  E221: 'Boil pump running dry',
  E300: 'Invalid step received',
  E301: 'Program running too long (safety limit)',
  E302: 'Step running too long (safety limit)',
};

module.exports = {
  PORT, MSG, MSG_NAMES, CMD, BREW_STATUS, BREW_TYPE, INSTR, MAIN_STEP, INNER_STEP, NOTIFICATIONS,
  encodeFrame, FrameParser, encodeMap, encodeFramedMaps, decodeFramedMaps,
  encodeRecipe, decodeRecipe, decodeBrewing, encodeBrewing, describeInstruction, buildStages, stepOutputs, stepCommand, OUTPUTS, parseStatusLine, STAGE_NAME,
};
