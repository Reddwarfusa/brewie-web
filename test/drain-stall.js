// A stuck drain (level not falling with outlet open) must raise a warning within ~60 s.
const fs = require('fs'); const os = require('os'); const path = require('path');
const { SimMachine } = require('../src/simulator'); const { BrewieClient } = require('../src/client'); const { RecipeStore } = require('../src/store');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-'));
const sim = new SimMachine({ port: 18021, dataDir: path.join(tmp, 'sim'), speed: 1 }).start();
sim.volume = 12; sim.stuckDrain = true;
const c = new BrewieClient({ store: new RecipeStore(path.join(tmp, 'app')), host: '127.0.0.1', port: 18021 });
c.levelTank = 'boil'; // the simulator models the level reading as the boil tank
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  c.connect(); while (c.connection !== 'connected') await wait(100); await wait(1500);
  c.drain({ boil: true }); const t = Date.now();
  while (!(c.warning && c.warning.code === 'DRAIN_STALL') && Date.now() - t < 80000) await wait(500);
  console.log(c.warning ? `ok  stall warning after ${Math.round((Date.now() - t) / 1000)} s: ${c.warning.text}` : 'FAIL no stall warning');
  sim.stuckDrain = false; const t2 = Date.now(); while (c.warning && Date.now() - t2 < 20000) await wait(500);
  console.log(!c.warning ? 'ok  warning cleared once the level started falling' : 'FAIL warning stuck');
  c.disconnect(); sim.close(); process.exit(0);
})();
