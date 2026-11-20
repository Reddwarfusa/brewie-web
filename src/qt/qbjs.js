'use strict';
/**
 * Qt 5 binary JSON ("qbjs") codec, as produced by QJsonDocument::toBinaryData()
 * and consumed by QJsonDocument::fromBinaryData(), plus qCompress/qUncompress.
 *
 * Layout (all little-endian):
 *   Header { u32 tag = 'qbjs'; u32 version = 1 }
 *   Base   { u32 size; u32 (is_object:1 | length:31); u32 tableOffset } + payload + table
 *   Value  { type:3 | latinOrIntValue:1 | latinKey:1 | value:27 }
 * Arrays store Values in their table; objects store offsets to Entries
 * (Value followed by the key). Object entries are sorted by key.
 */
const zlib = require('zlib');

const TAG = 0x736a6271; // 'qbjs' little-endian
const VT = { Null: 0, Bool: 1, Double: 2, String: 3, Array: 4, Object: 5 };
const align4 = (n) => (n + 3) & ~3;
const isLatin = (s) => s.length < 0x8000 && /^[\x00-\xff]*$/.test(s);
// mirrors Qt's compressedNumber(): integers with 1 <= |v| < 2^26 (zero is stored as a full double)
const fitsCompressedInt = (v) => Number.isInteger(v) && v !== 0 && Math.abs(v) < 2 ** 26;

// ------------------------------------------------------------------ encode
function encodeString(s) {
  if (isLatin(s)) {
    const b = Buffer.alloc(align4(2 + s.length));
    b.writeUInt16LE(s.length, 0); b.write(s, 2, 'latin1');
    return { latin: true, buf: b };
  }
  const b = Buffer.alloc(align4(4 + s.length * 2));
  b.writeUInt32LE(s.length, 0);
  for (let i = 0; i < s.length; i++) b.writeUInt16LE(s.charCodeAt(i), 4 + i * 2);
  return { latin: false, buf: b };
}

function valueWord(type, latinOrInt, latinKey, value) {
  return ((type & 7) | ((latinOrInt ? 1 : 0) << 3) | ((latinKey ? 1 : 0) << 4) | ((value & 0x7ffffff) << 5)) >>> 0;
}

/** Encode payload for a value. Returns {type, latinOrInt, inline, data?: Buffer} */
function prepValue(v) {
  if (v === null || v === undefined) return { type: VT.Null, latinOrInt: false, inline: 0 };
  if (typeof v === 'boolean') return { type: VT.Bool, latinOrInt: false, inline: v ? 1 : 0 };
  if (typeof v === 'number') {
    if (fitsCompressedInt(v)) return { type: VT.Double, latinOrInt: true, inline: v };
    const b = Buffer.alloc(8); b.writeDoubleLE(v); return { type: VT.Double, latinOrInt: false, data: b };
  }
  if (typeof v === 'string') { const s = encodeString(v); return { type: VT.String, latinOrInt: s.latin, data: s.buf }; }
  if (Array.isArray(v)) return { type: VT.Array, latinOrInt: false, data: encodeBase(v, false) };
  if (typeof v === 'object') return { type: VT.Object, latinOrInt: false, data: encodeBase(v, true) };
  throw new Error('qbjs: unsupported value ' + typeof v);
}

function encodeBase(container, isObject) {
  const parts = []; let pos = 12; const table = [];
  if (isObject) {
    const keys = Object.keys(container).filter((k) => container[k] !== undefined).sort();
    for (const k of keys) {
      const p = prepValue(container[k]);
      const key = encodeString(k);
      const entryLen = 4 + key.buf.length; // already aligned
      const entryPos = pos;
      let valueField = p.inline ?? 0;
      if (p.data) valueField = entryPos + entryLen; // payload right after entry
      const head = Buffer.alloc(4);
      head.writeUInt32LE(valueWord(p.type, p.latinOrInt, key.latin, valueField));
      parts.push(head, key.buf); pos += entryLen;
      if (p.data) { parts.push(p.data); pos += p.data.length; }
      table.push(entryPos);
    }
  } else {
    for (const item of container) {
      const p = prepValue(item);
      let valueField = p.inline ?? 0;
      if (p.data) { valueField = pos; parts.push(p.data); pos += p.data.length; }
      table.push(valueWord(p.type, p.latinOrInt, false, valueField));
    }
  }
  const tableOffset = table.length ? pos : 0; // Qt writes 0 for empty containers
  const size = pos + table.length * 4;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(size, 0);
  header.writeUInt32LE(((table.length << 1) | (isObject ? 1 : 0)) >>> 0, 4);
  header.writeUInt32LE(tableOffset, 8);
  const tbl = Buffer.alloc(table.length * 4);
  table.forEach((t, i) => tbl.writeUInt32LE(t >>> 0, i * 4));
  return Buffer.concat([header, ...parts, tbl]);
}

function toBinaryData(doc) {
  if (doc === null || typeof doc !== 'object') throw new Error('qbjs root must be object or array');
  const h = Buffer.alloc(8); h.writeUInt32LE(TAG, 0); h.writeUInt32LE(1, 4);
  return Buffer.concat([h, encodeBase(doc, !Array.isArray(doc))]);
}

// ------------------------------------------------------------------ decode
function readString(buf, off, latin) {
  if (latin) { const n = buf.readUInt16LE(off); return buf.toString('latin1', off + 2, off + 2 + n); }
  const n = buf.readUInt32LE(off); let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(buf.readUInt16LE(off + 4 + i * 2));
  return s;
}

function decodeValue(buf, base, word) {
  const type = word & 7; const latinOrInt = (word >>> 3) & 1;
  const raw = word >>> 5; const signed = (word >> 5); // arithmetic shift keeps sign
  switch (type) {
    case VT.Null: return null;
    case VT.Bool: return raw !== 0;
    case VT.Double: return latinOrInt ? signed : buf.readDoubleLE(base + raw);
    case VT.String: return readString(buf, base + raw, !!latinOrInt);
    case VT.Array: return decodeBase(buf, base + raw);
    case VT.Object: return decodeBase(buf, base + raw);
    default: return undefined;
  }
}

function decodeBase(buf, base) {
  const size = buf.readUInt32LE(base);
  const flags = buf.readUInt32LE(base + 4);
  const isObject = flags & 1; const length = flags >>> 1;
  const tableOffset = buf.readUInt32LE(base + 8);
  if (tableOffset + length * 4 > size || base + size > buf.length) throw new Error('qbjs: corrupt container');
  if (isObject) {
    const out = {};
    for (let i = 0; i < length; i++) {
      const eoff = base + buf.readUInt32LE(base + tableOffset + i * 4);
      const word = buf.readUInt32LE(eoff);
      const key = readString(buf, eoff + 4, !!((word >>> 4) & 1));
      out[key] = decodeValue(buf, base, word);
    }
    return out;
  }
  const arr = [];
  for (let i = 0; i < length; i++) arr.push(decodeValue(buf, base, buf.readUInt32LE(base + tableOffset + i * 4)));
  return arr;
}

function fromBinaryData(buf) {
  if (buf.length < 20 || buf.readUInt32LE(0) !== TAG) throw new Error('qbjs: bad header');
  return decodeBase(buf, 8);
}

// ------------------------------------------------------------------ qCompress
function qCompress(buf, level = -1) {
  const h = Buffer.alloc(4); h.writeUInt32BE(buf.length);
  return Buffer.concat([h, zlib.deflateSync(buf, { level })]);
}
function qUncompress(buf) {
  if (!buf || buf.length < 4) return Buffer.alloc(0);
  return zlib.inflateSync(buf.subarray(4));
}

module.exports = { toBinaryData, fromBinaryData, qCompress, qUncompress };
