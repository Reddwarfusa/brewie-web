// The Brewie serves one controller; a second must wait without churning sockets, then pair when the slot frees.
const fs = require('fs'); const os = require('os'); const path = require('path'); const net = require('net');
const { SimMachine } = require('../src/simulator'); const { BrewieClient } = require('../src/client'); const { RecipeStore } = require('../src/store');
const P = require('../src/protocol');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-'));
const sim = new SimMachine({ port: 18011, dataDir: path.join(tmp, 'sim'), speed: 300 }).start();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  // "phone app" grabs the slot first
  const phone = net.createConnection({ port: 18011 }); await wait(200);
  phone.write(P.encodeFrame({ type: 0, data: 'brewie?' })); await wait(200);
  let sockets = 0; const orig = net.createConnection; net.createConnection = (...a) => { sockets++; return orig(...a); };
  const c = new BrewieClient({ store: new RecipeStore(path.join(tmp, 'app')), host: '127.0.0.1', port: 18011 });
  c.connect(); await wait(16000);
  console.log(c.connection === 'pairing' ? 'ok  waits while another controller is connected' : 'FAIL state ' + c.connection, '| sockets opened:', sockets, '| msg:', c.lastError);
  phone.end(); // phone app disconnects
  const t = Date.now(); while (c.connection !== 'connected' && Date.now() - t < 12000) await wait(100);
  console.log(c.connection === 'connected' ? `ok  paired ${((Date.now() - t) / 1000).toFixed(1)} s after the slot freed` : 'FAIL never paired', '| sockets opened:', sockets, '| jammed:', !!sim.jammed);
  c.disconnect(); await wait(1500);
  const c2 = new BrewieClient({ store: new RecipeStore(path.join(tmp, 'app2')), host: '127.0.0.1', port: 18011 });
  c2.connect(); const t2 = Date.now(); while (c2.connection !== 'connected' && Date.now() - t2 < 8000) await wait(100);
  console.log(c2.connection === 'connected' && !sim.jammed ? 'ok  slot released cleanly on disconnect' : 'FAIL slot stuck');
  c2.disconnect(); sim.close(); process.exit(0);
})();
