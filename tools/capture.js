#!/usr/bin/env node
'use strict';
/**
 * Read-only capture from a real Brewie. Run on a computer on the same network:
 *
 *   node tools/capture.js 192.168.10.60 [seconds]
 *
 * It only sends what a freshly installed Brewie Control app sends:
 *   hello ("brewie?"), state query ("?"), an empty removed-list (110) and an
 *   empty recipe list (100). It never starts, stops, cleans or drains anything.
 * Everything received is written to ./capture/.
 */
const net = require('net');
const fs = require('fs');
const path = require('path');
const P = require('../src/protocol');

const host = process.argv[2];
const secs = Number(process.argv[3] || 45);
if (!host) { console.error('usage: node tools/capture.js <brewie-ip> [seconds]'); process.exit(1); }

const out = path.join(process.cwd(), 'capture');
fs.mkdirSync(path.join(out, 'recipes'), { recursive: true });
const logFile = fs.createWriteStream(path.join(out, 'session.jsonl'));
const statusFile = fs.createWriteStream(path.join(out, 'status-lines.txt'));
const rawFile = fs.createWriteStream(path.join(out, 'raw-stream.bin'));
const t0 = Date.now();
const counts = {}; let recipes = 0;

function rec(dir, msg) {
  const d = msg.data;
  const data = Buffer.isBuffer(d) ? { bufferHex: d.toString('hex') } : d;
  logFile.write(JSON.stringify({ t: Date.now() - t0, dir, type: msg.type, name: P.MSG_NAMES[msg.type] || null, data }) + '\n');
}
function send(sock, msg) { rec('out', msg); sock.write(P.encodeFrame(msg)); }

const sock = net.createConnection({ host, port: P.PORT });
const parser = new P.FrameParser();
sock.setTimeout(10000, () => { console.error('✗ No response from the Brewie (timeout).'); finish(1); });

sock.on('connect', () => { console.log(`✓ TCP connected to ${host}:${P.PORT}`); send(sock, { type: P.MSG.HELLO, data: 'brewie?' }); });
sock.on('data', (chunk) => {
  rawFile.write(chunk);
  let msgs = [];
  try { msgs = parser.push(chunk); } catch (e) { console.error('! parse error:', e.message); }
  for (const m of msgs) {
    rec('in', m); counts[m.type] = (counts[m.type] || 0) + 1;
    if (m.type === P.MSG.HELLO_REPLY) {
      console.log(`✓ Paired (reply: ${JSON.stringify(m.data)})`);
      sock.setTimeout(0);
      send(sock, { type: P.MSG.COMMAND, data: '?' });
      send(sock, { type: P.MSG.REMOVED_LIST, data: [] });
      setTimeout(() => send(sock, { type: P.MSG.RECIPE_LIST, data: Buffer.alloc(0) }), 1500);
    } else if (m.type === P.MSG.STATUS) {
      statusFile.write(`${Date.now() - t0}\t${m.data}\n`);
      if (counts[m.type] === 1) { const s = P.parseStatusLine(String(m.data)); console.log(`✓ Status: ${s.fieldCount} fields, mash ${s.mashTemp}°C, boil ${s.boilTemp}°C, step ${s.step}, MCU ${s.mcuVersion}`); }
    } else if (m.type === P.MSG.COMMAND) {
      if (Buffer.isBuffer(m.data)) {
        let b = null; try { b = P.decodeBrewing(m.data); } catch (e) { b = { decodeError: e.message }; }
        fs.writeFileSync(path.join(out, 'brewing.json'), JSON.stringify(b, null, 2));
        console.log(b ? `✓ Program state received (status ${b.status}, ${b.instructions ? b.instructions.length : 0} instructions)` : '✓ Program state: nothing running');
      } else console.log(`· Command echo: ${JSON.stringify(m.data)}`);
    } else if (m.type === P.MSG.RECIPE) {
      try {
        const r = P.decodeRecipe(m.data); recipes++;
        fs.writeFileSync(path.join(out, 'recipes', `${String(r.id || recipes).replace(/[^\w.-]/g, '_')}.json`), JSON.stringify(r, null, 2));
        console.log(`✓ Recipe: ${r.name}`);
      } catch (e) { console.error('! recipe decode failed:', e.message); fs.writeFileSync(path.join(out, 'recipes', `undecoded-${Date.now()}.bin`), m.data); }
    } else {
      console.log(`· ${P.MSG_NAMES[m.type] || 'type ' + m.type}: ${Buffer.isBuffer(m.data) ? `<${m.data.length} bytes>` : JSON.stringify(m.data).slice(0, 120)}`);
    }
  }
});
sock.on('error', (e) => { console.error('✗ Connection error:', e.message); finish(1); });
sock.on('close', () => { console.log('· Connection closed by the Brewie'); finish(0); });

let done = false;
function finish(code) {
  if (done) return; done = true;
  sock.destroy();
  const summary = { host, seconds: (Date.now() - t0) / 1000, messageCounts: counts, recipes };
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  logFile.end(); statusFile.end(); rawFile.end();
  console.log(`\nDone. ${recipes} recipe(s), ${counts[P.MSG.STATUS] || 0} status lines. Results are in ${out}`);
  setTimeout(() => process.exit(code), 200);
}
setTimeout(() => finish(0), secs * 1000);
console.log(`Capturing for ${secs} s (read-only)…`);
