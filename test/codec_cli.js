// helper used by qt_crosscheck.py
const qbjs = require('../src/qt/qbjs');
const { Writer, Reader } = require('../src/qt/qdatastream');
const { encodeFrame, FrameParser } = require('../src/protocol');
const cmd = process.argv[2]; const chunks = [];
process.stdin.on('data', (c) => chunks.push(c)).on('end', () => {
  const input = Buffer.concat(chunks);
  const out = {
    'qbjs-encode': () => qbjs.toBinaryData(JSON.parse(input)).toString('base64'),
    'qbjs-decode': () => JSON.stringify(qbjs.fromBinaryData(Buffer.from(input.toString(), 'base64'))),
    'qcompress': () => qbjs.qCompress(input).toString('base64'),
    'quncompress': () => qbjs.qUncompress(Buffer.from(input.toString(), 'base64')),
    'frame': () => encodeFrame(JSON.parse(input)).toString('base64'),
    'unframe': () => { const p = new FrameParser(); return JSON.stringify(p.push(Buffer.from(input.toString(), 'base64'))); },
  }[cmd]();
  process.stdout.write(out);
});
