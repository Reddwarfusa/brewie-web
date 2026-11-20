'use strict';
/**
 * Minimal Qt 5 QDataStream / QVariant codec (big-endian, DoublePrecision).
 *
 * JS <-> QVariant mapping when writing:
 *   boolean          -> Bool (1)
 *   integer number   -> Int (2)  (LongLong (4) if outside int32)
 *   other number     -> Double (6)
 *   string           -> QString (10)
 *   Buffer           -> QByteArray (12)
 *   Array            -> QVariantList (9)
 *   plain object     -> QVariantMap (8)
 *   null/undefined   -> invalid QVariant (0)
 * Use the QV.* helpers to force a specific type.
 */

const T = {
  Invalid: 0, Bool: 1, Int: 2, UInt: 3, LongLong: 4, ULongLong: 5, Double: 6, QChar: 7,
  QVariantMap: 8, QVariantList: 9, QString: 10, QStringList: 11, QByteArray: 12,
  QDate: 14, QTime: 15, QDateTime: 16, QVariantHash: 28, Long: 32, Short: 33, Char: 34,
  ULong: 35, UShort: 36, UChar: 37, Float: 38, SChar: 40,
};

class Tagged {
  constructor(type, value) { this.type = type; this.value = value; }
}
const QV = {
  int: (v) => new Tagged(T.Int, v),
  uint: (v) => new Tagged(T.UInt, v),
  longlong: (v) => new Tagged(T.LongLong, v),
  double: (v) => new Tagged(T.Double, v),
  float: (v) => new Tagged(T.Float, v),
  bool: (v) => new Tagged(T.Bool, !!v),
  string: (v) => new Tagged(T.QString, v),
  bytes: (v) => new Tagged(T.QByteArray, v),
  list: (v) => new Tagged(T.QVariantList, v),
  map: (v) => new Tagged(T.QVariantMap, v),
  stringList: (v) => new Tagged(T.QStringList, v),
};

// ---------------------------------------------------------------- writer
class Writer {
  constructor() { this.chunks = []; this.length = 0; }
  push(b) { this.chunks.push(b); this.length += b.length; }
  u8(v) { const b = Buffer.alloc(1); b.writeUInt8(v & 0xff); this.push(b); }
  i8(v) { const b = Buffer.alloc(1); b.writeInt8(v); this.push(b); }
  u16(v) { const b = Buffer.alloc(2); b.writeUInt16BE(v); this.push(b); }
  i16(v) { const b = Buffer.alloc(2); b.writeInt16BE(v); this.push(b); }
  u32(v) { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); this.push(b); }
  i32(v) { const b = Buffer.alloc(4); b.writeInt32BE(v | 0); this.push(b); }
  i64(v) { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(Math.trunc(Number(v)))); this.push(b); }
  u64(v) { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(Math.trunc(Number(v)))); this.push(b); }
  f64(v) { const b = Buffer.alloc(8); b.writeDoubleBE(Number(v)); this.push(b); }
  qstring(s) {
    if (s === null || s === undefined) { this.u32(0xffffffff); return; }
    s = String(s);
    const b = Buffer.alloc(s.length * 2);
    for (let i = 0; i < s.length; i++) b.writeUInt16BE(s.charCodeAt(i), i * 2);
    this.u32(b.length); this.push(b);
  }
  qbytearray(buf) {
    if (buf === null || buf === undefined) { this.u32(0xffffffff); return; }
    this.u32(buf.length); this.push(Buffer.from(buf));
  }
  /** QMap<QString,QVariant> — Qt writes entries in reverse key order. */
  qvariantmap(obj) {
    const keys = Object.keys(obj).sort();
    this.u32(keys.length);
    for (let i = keys.length - 1; i >= 0; i--) { this.qstring(keys[i]); this.qvariant(obj[keys[i]]); }
  }
  qvariantlist(arr) { this.u32(arr.length); for (const v of arr) this.qvariant(v); }
  qvariant(v) {
    let type; let val = v;
    if (v instanceof Tagged) { type = v.type; val = v.value; }
    else if (v === null || v === undefined) type = T.Invalid;
    else if (typeof v === 'boolean') type = T.Bool;
    else if (typeof v === 'number') {
      if (Number.isInteger(v)) type = (v >= -2147483648 && v <= 2147483647) ? T.Int : T.LongLong;
      else type = T.Double;
    } else if (typeof v === 'bigint') type = T.LongLong;
    else if (typeof v === 'string') type = T.QString;
    else if (Buffer.isBuffer(v)) type = T.QByteArray;
    else if (Array.isArray(v)) type = T.QVariantList;
    else if (typeof v === 'object') type = T.QVariantMap;
    else throw new Error('Cannot encode value as QVariant: ' + typeof v);

    this.u32(type);
    this.i8(type === T.Invalid ? 1 : 0); // isNull flag (Qt >= 4.2)
    switch (type) {
      case T.Invalid: break;
      case T.Bool: this.u8(val ? 1 : 0); break;
      case T.Int: this.i32(val); break;
      case T.UInt: this.u32(val); break;
      case T.LongLong: this.i64(val); break;
      case T.ULongLong: this.u64(val); break;
      case T.Double: case T.Float: this.f64(val); break; // DoublePrecision default
      case T.QString: this.qstring(val); break;
      case T.QByteArray: this.qbytearray(val); break;
      case T.QVariantList: this.qvariantlist(val); break;
      case T.QVariantMap: this.qvariantmap(val); break;
      case T.QStringList: this.u32(val.length); for (const s of val) this.qstring(s); break;
      default: throw new Error('Unsupported QVariant type for writing: ' + type);
    }
  }
  toBuffer() { return Buffer.concat(this.chunks, this.length); }
}

// ---------------------------------------------------------------- reader
class Reader {
  constructor(buf, pos = 0) { this.buf = buf; this.pos = pos; }
  need(n) { if (this.pos + n > this.buf.length) throw new RangeError('QDataStream: read past end'); }
  u8() { this.need(1); return this.buf.readUInt8(this.pos++); }
  i8() { this.need(1); return this.buf.readInt8(this.pos++); }
  u16() { this.need(2); const v = this.buf.readUInt16BE(this.pos); this.pos += 2; return v; }
  i16() { this.need(2); const v = this.buf.readInt16BE(this.pos); this.pos += 2; return v; }
  u32() { this.need(4); const v = this.buf.readUInt32BE(this.pos); this.pos += 4; return v; }
  i32() { this.need(4); const v = this.buf.readInt32BE(this.pos); this.pos += 4; return v; }
  i64() { this.need(8); const v = this.buf.readBigInt64BE(this.pos); this.pos += 8; return Number(v); }
  u64() { this.need(8); const v = this.buf.readBigUInt64BE(this.pos); this.pos += 8; return Number(v); }
  f64() { this.need(8); const v = this.buf.readDoubleBE(this.pos); this.pos += 8; return v; }
  qstring() {
    const len = this.u32();
    if (len === 0xffffffff) return null;
    this.need(len);
    let s = '';
    for (let i = 0; i < len; i += 2) s += String.fromCharCode(this.buf.readUInt16BE(this.pos + i));
    this.pos += len; return s;
  }
  qbytearray() {
    const len = this.u32();
    if (len === 0xffffffff) return null;
    this.need(len);
    const b = Buffer.from(this.buf.subarray(this.pos, this.pos + len)); this.pos += len; return b;
  }
  qvariantmap() {
    const n = this.u32(); const out = {};
    for (let i = 0; i < n; i++) { const k = this.qstring(); out[k] = this.qvariant(); }
    return out;
  }
  qvariantlist() { const n = this.u32(); const out = []; for (let i = 0; i < n; i++) out.push(this.qvariant()); return out; }
  qvariant() {
    const type = this.u32();
    this.i8(); // isNull
    switch (type) {
      case T.Invalid: return null;
      case T.Bool: return this.u8() !== 0;
      case T.Int: case T.Long: return this.i32();
      case T.UInt: case T.ULong: return this.u32();
      case T.LongLong: return this.i64();
      case T.ULongLong: return this.u64();
      case T.Double: case T.Float: return this.f64();
      case T.Short: return this.i16();
      case T.UShort: return this.u16();
      case T.Char: case T.SChar: return this.i8();
      case T.UChar: return this.u8();
      case T.QChar: return String.fromCharCode(this.u16());
      case T.QString: return this.qstring();
      case T.QByteArray: return this.qbytearray();
      case T.QVariantList: return this.qvariantlist();
      case T.QVariantMap: case T.QVariantHash: return this.qvariantmap();
      case T.QStringList: { const n = this.u32(); const a = []; for (let i = 0; i < n; i++) a.push(this.qstring()); return a; }
      case T.QDate: return { __qdate: this.i64() };
      default: throw new Error('Unsupported QVariant type in stream: ' + type);
    }
  }
  get remaining() { return this.buf.length - this.pos; }
}

module.exports = { T, QV, Tagged, Writer, Reader };
