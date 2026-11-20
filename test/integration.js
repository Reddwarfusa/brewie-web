const assert = require('assert'); const fs = require('fs'); const os = require('os'); const path = require('path');
const { SimMachine } = require('../src/simulator'); const { BrewieClient } = require('../src/client'); const { RecipeStore } = require('../src/store');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brewie-'));
const sim = new SimMachine({ port: 18001, dataDir: path.join(tmp, 'sim'), speed: 300 }).start();
const store = new RecipeStore(path.join(tmp, 'app'));
const c = new BrewieClient({ store, host: '127.0.0.1', port: 18001 });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return; await wait(50); } throw new Error('timeout: ' + fn); };
const log = []; c.on('log', (l) => log.push(`${l.dir} ${l.name} ${l.summary}`)); const notices = []; c.on('notice', (n) => notices.push(n.text));
(async () => {
  c.connect();
  await until(() => c.connection === 'connected'); console.log('ok  paired');
  await until(() => store.summaries().length === 2); console.log('ok  pulled', store.summaries().map((r) => r.name).join(', '));
  // local edit -> sync -> machine requests it
  const r = store.get(store.summaries()[0].id); r.name = 'House Pale Ale v2'; store.put(r);
  await wait(20); c.sendRecipeList();
  await until(() => JSON.parse(fs.readFileSync(path.join(tmp, 'sim', 'recipes', r.id + '.brewie'))).name === 'House Pale Ale v2'); console.log('ok  pushed edit via 100/101/102');
  // new local recipe + delete
  const nr = store.put({ name: 'Brand new', hops: [[], [], [], []], fermentables: [[]], mash: { mashInWater: 20, mashInTemperature: 66, mashSteps: [[{ stepTemp: 65, stepTime: 60 }]] } });
  c.sendRecipeList(); await until(() => fs.existsSync(path.join(tmp, 'sim', 'recipes', nr.id + '.brewie'))); console.log('ok  new recipe uploaded');
  store.remove(nr.id); c.sendRemoved(); await until(() => !fs.existsSync(path.join(tmp, 'sim', 'recipes', nr.id + '.brewie'))); console.log('ok  deletion propagated');
  // brew
  await until(() => c.brewingKnown); console.log('ok  idle detected from silence (no status while idle):', c.status === null);
  c.startBrew(r.id, { waterInlet: true, cooling: true });
  await until(() => notices.includes('Brewing started')); await until(() => c.brewing && c.brewing.steps && c.brewing.steps.length > 5);
  await until(() => c.status && c.status.valid); console.log('ok  status line', c.status.mashTemp, c.status.boilTemp, 'fields', c.status.fieldCount);
  console.log('ok  brewing', c.brewing.recipeName, c.brewing.steps.length, 'steps; first:', c.brewing.steps[0].label);
  c.pause(); await until(() => c.brewing.status === 2); console.log('ok  paused');
  c.resume(); await until(() => c.brewing.status === 1); console.log('ok  resumed');
  await until(() => c.status.step >= 1, 15000); c.nextStep(); console.log('ok  step now', c.status.step, c.summaryStatus().currentStep && c.summaryStatus().currentStep.label);
  c.stop(); await until(() => c.brewing === null, 12000); console.log('ok  stopped (detected via silent "?")');
  c.clean(2); await until(() => c.brewing && c.brewing.type === 2); console.log('ok  cleaning program', c.snapshot().brewing.typeName); c.stop(); await until(() => c.brewing === null, 12000);
  c.drain({ boil: true, mash: false, hop: false }); await until(() => notices.includes('Draining started')); await until(() => c.brewing && c.brewing.type === 4, 8000);
  console.log('ok  drain boil tank runs as a program:', c.snapshot().brewing.typeName);
  c.drain({ mash: true }); await wait(800); console.log(notices.includes('Machine refused to drain') ? 'ok  second drain refused while one runs' : 'FAIL drain not refused');
  c.emergencyStop();
  { const l = c.lamps(); const planned = ['waterInlet', 'mashInlet', 'boilInlet', 'mashReturn', 'boilReturn', 'outlet', 'coolValve'].filter((k) => l && l[k]);
    if (planned.length) { console.log('FAIL valves still lit right after emergency stop:', planned.join(',')); process.exit(1); } }
  await until(() => c.brewing === null, 12000);
  { const st = c.summaryStatus(); const lit = Object.entries((st && st.lamps) || {}).filter(([, v]) => v).map(([k]) => k);
    if (lit.length) { console.log('FAIL lamps still on after the program ended:', lit.join(',')); process.exit(1); } }
  console.log('ok  emergency stop (pause + stop) ended the program; every lamp off');
  // program started on the touchscreen while we were idle -> must be picked up from the status stream
  await wait(500); sim.brew = require('../src/simulator').__makeCleaning(1); await until(() => c.brewing && c.brewing.type === 1, 10000);
  console.log('ok  touchscreen-started program detected:', c.snapshot().brewing.typeName, '| stages:', c.brewing.stages.map((x) => x.name).join(', '));
  await until(() => c.summaryStatus() && c.summaryStatus().progress, 5000); console.log('ok  progress', JSON.stringify(c.summaryStatus().progress));
  c.disconnect(); sim.close(); process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); console.error(log.slice(-25).join('\n')); process.exit(1); });
