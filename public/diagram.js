/* Brewie Web — Advanced view: live schematic of the Brewie (tanks, heaters, pumps, valves, hop cages).
 * Valve/pump states come from the current step (what the controller was told); heaters, temperatures
 * and the boil-tank level are live sensor readings; the mash-tank level is a water-balance estimate. */
'use strict';

const DIAGRAM_MAX_L = 30; // display scale for tank fill

function diagramSVG() {
  // pipe(id, path) — id is the output (or flow) that makes it active
  const pipe = (cls, d) => `<path class="pipe ${cls}" d="${d}"/>`;
  const valve = (k, x, y, label, vertical, left) => `<g class="valve" data-v="${k}" transform="translate(${x},${y})${vertical ? ' rotate(90)' : ''}">
      <path d="M-11,-8 L11,8 L11,-8 L-11,8 Z"/><circle r="3.2"/></g>
    <text class="vlabel" x="${x}" y="${y + (vertical ? 4 : 24)}" ${vertical ? (left ? 'dx="-18" text-anchor="end"' : 'dx="18" text-anchor="start"') : 'text-anchor="middle"'}>${label}</text>`;
  const pump = (k, x, y, label) => `<g class="pump" data-v="${k}" transform="translate(${x},${y})">
      <circle r="22"/><g class="rotor"><path d="M0,-14 L4,0 L0,14 L-4,0 Z"/><path d="M-14,0 L0,4 L14,0 L0,-4 Z"/></g></g>
    <text class="vlabel" x="${x}" y="${y + 40}" text-anchor="middle">${label}</text>`;
  const heater = (k, x, y) => `<path class="heater" data-v="${k}" d="M${x - 80},${y} ${Array.from({ length: 8 }, (_, i) => `l10,${i % 2 ? -9 : 9} l10,${i % 2 ? 9 : -9}`).join(' ')}"/>`;
  const tank = (k, x, label) => `<g class="tank" data-tank="${k}">
      <rect class="shell" x="${x}" y="120" width="210" height="260" rx="14"/>
      <clipPath id="clip-${k}"><rect x="${x + 3}" y="123" width="204" height="254" rx="12"/></clipPath>
      <g clip-path="url(#clip-${k})"><rect class="liquid ${k}" x="${x}" y="380" width="210" height="0"/><path class="wave" d=""/></g>
      <text class="tlabel" x="${x + 105}" y="146" text-anchor="middle">${label}</text>
      <text class="ttemp" x="${x + 105}" y="236" text-anchor="middle" data-t="${k}T">–</text>
      <text class="ttgt" x="${x + 105}" y="262" text-anchor="middle" data-t="${k}Tgt"></text>
      <text class="tvol" x="${x + 105}" y="356" text-anchor="middle" data-t="${k}Vol"></text></g>`;
  const cage = (n, y) => `<g class="cage" data-v="hop${n}" transform="translate(420,${y})"><rect x="0" y="0" width="64" height="44" rx="8"/>
      <path d="M8,10 h48 M8,22 h48 M8,34 h48" class="mesh"/><text x="32" y="28" text-anchor="middle">${n}</text></g>`;

  // Layout matches the real machine (front view): BOIL tank left, hop cages in the middle, MASH tank right.
  return `<svg viewBox="0 0 940 600" class="diagram" role="img" aria-label="Brewie schematic">
    <!-- water supply header -->
    <text class="vlabel" x="18" y="48">TAP</text>
    ${pipe('f-inlet', 'M20,62 H715')}
    ${pipe('f-boilin', 'M185,62 V120')}
    ${pipe('f-mashin', 'M715,62 V120')}
    ${pipe('f-cool', 'M305,62 V178 H290')}
    <path class="coil" data-v="coolValve" d="M290,178 q-12,-12 -24,0 t-24,0 t-24,0 t-24,0 t-24,0 t-24,0 t-24,0"/>
    ${pipe('f-cool', 'M122,178 H40 V555')}
    ${valve('waterInlet', 92, 62, 'WATER INLET')}
    ${valve('boilInlet', 185, 92, 'BOIL INLET', true)}
    ${valve('mashInlet', 715, 92, 'MASH INLET', true)}
    ${valve('coolValve', 305, 120, 'COOLING', true)}
    <!-- tanks -->
    ${tank('boil', 80, 'BOIL TANK')}
    ${tank('mash', 610, 'MASH TANK')}
    ${heater('boilHeater', 185, 398)}
    ${heater('mashHeater', 715, 398)}
    <text class="vlabel hlabel" data-v="boilHeater" x="185" y="420" text-anchor="middle">HEATER</text>
    <text class="vlabel hlabel" data-v="mashHeater" x="715" y="420" text-anchor="middle">HEATER</text>
    <!-- hop cages between the tanks, draining into the boil tank -->
    ${pipe('f-hops', 'M185,448 H345 V100 H452 V130')}
    ${pipe('f-hops', 'M420,152 H290 M420,212 H290 M420,272 H290 M420,332 H290')}
    ${pipe('f-hops', 'M452,130 V120')}
    ${cage(1, 130)}${cage(2, 190)}${cage(3, 250)}${cage(4, 310)}
    <text class="vlabel" x="452" y="374" text-anchor="middle">HOP CAGES</text>
    <!-- boil circuit -->
    ${pipe('f-boilpump', 'M240,380 V470 H207')}
    ${pipe('f-boilret', 'M163,470 H70 V150 H80')}
    ${valve('boilReturn', 70, 300, 'BOIL RETURN', true)}
    ${pipe('f-boilout', 'M185,492 V515')}
    ${pipe('f-b2m', 'M185,515 H640 V380')}
    <text class="vlabel flowlbl" x="420" y="508" data-v="f-b2m" text-anchor="middle">→ to mash tank</text>
    <!-- mash circuit -->
    ${pipe('f-mashpump', 'M660,380 V470 H693')}
    ${pipe('f-mashret', 'M737,470 H870 V150 H820')}
    ${valve('mashReturn', 870, 430, 'MASH RETURN', true, true)}
    ${pipe('f-m2b', 'M715,492 V532 H262 V380')}
    <text class="vlabel flowlbl" x="480" y="548" data-v="f-m2b" text-anchor="middle">← to boil tank</text>
    ${pump('boilPump', 185, 470, 'BOIL PUMP')}
    ${pump('mashPump', 715, 470, 'MASH PUMP')}
    <!-- drain -->
    ${pipe('f-drainpump', 'M185,515 V555')}
    ${pipe('f-drain', 'M40,555 H920')}
    ${valve('outlet', 830, 555, 'DRAIN OUTLET')}
    <text class="vlabel" x="915" y="542" text-anchor="end">DRAIN</text>
  </svg>`;
}

function renderAdvanced() {
  const st = S.st || {}; const b = st.brewing;
  view().innerHTML = `<div class="head"><div><h1>Advanced view</h1><p>Live schematic of the Brewie. Valves and pumps show what the current step commands; heaters, temperatures and the boil-tank level are live sensor readings.</p></div><div class="mobconn"></div></div>
    <div class="grid dash"><div class="panel tight" style="padding:10px">${diagramSVG()}</div>
    <div class="grid">
      <div class="panel"><h3>Controls</h3>
        <button class="estop" id="estop"><b>EMERGENCY STOP</b><span>Stops heaters and pumps, then ends the program</span></button>
        <div id="advWarn"></div>
        <div class="btns" style="margin-top:12px">
          <button class="btn" id="aPause">❚❚ Pause all</button>
          <button class="btn" id="aResume" title="Also overrides an error the Brewie paused on">▶ Resume / override</button>
          <button class="btn" id="aNext">Skip step ⏭</button>
        </div>
        <h3 style="margin-top:18px">Drain <span class="faint" style="font-size:11px;letter-spacing:.06em;text-transform:none">only when nothing is running</span></h3>
        <div class="grid g2" style="gap:8px">
          <button class="btn" data-drain="boil">Drain boil tank</button>
          <button class="btn" data-drain="mash">Drain mash tank</button>
          <button class="btn" data-drain="hop">Drain hop cages</button>
          <button class="btn" data-drain="all">Drain everything</button>
        </div>
        <label class="check" style="margin-top:8px;font-size:14px"><input type="checkbox" id="aSed"> Leave sediment behind (sedimentation)</label>
        <details class="trouble" style="margin-top:14px"><summary><b>Troubleshooting: tank won't drain / valve stuck</b></summary>
          <ol>
            <li><b>Pause</b> (or Emergency stop if anything is overheating or overflowing).</li>
            <li>Check the alert: <span class="num">E009/E010</span> = pump clogged, <span class="num">E20x</span> = valve x not responding, <span class="num">E220/E221</span> = pump running dry, <span class="num">E011</span> = no water detected.</li>
            <li><b>Clogged outlet</b> (most common when draining wort): lift the Brewie Bag or hop cage and look at the bottom hole of that tank. Clear grain/hop debris, then <b>Resume / override</b>. The touchscreen also has a guided <i>Unclog boiling / mashing tank</i> program (not available over the network).</li>
            <li><b>Valve stuck</b>: <b>Resume / override</b> once. The controller retries every valve when a step restarts, which frees most sticky valves. If the same <span class="num">E20x</span> comes back, stop the program and run <b>Drain</b> for just that tank, so only that path is used.</li>
            <li>Still stuck: stop, switch the Brewie off for 30 seconds and on again (this resets every valve), then drain again. As a last resort, drain the tank by hand through the outlet hose.</li>
            <li>Before brewing again, run a <b>Short clean</b> and watch the Advanced view to confirm every valve and pump comes on.</li>
          </ol></details>
      </div>
      <div class="panel"><h3>Now <span class="tick" id="tick" title="flashes on every update from the Brewie"></span></h3><div id="advNow" class="muted"></div></div>
      <div class="panel"><h3>Legend</h3><div class="legend3">
        <span><i class="lg on"></i>valve open / pump running</span><span><i class="lg off"></i>closed / off</span>
        <span><i class="lg heat"></i>heater on</span><span><i class="lg flow"></i>water flowing</span></div>
        <p class="faint" style="font-size:12px;margin:10px 0 0">Laid out like the machine seen from the front. The Brewie reports once per second; valve and pump states are what each step commands, so valves the controller cycles by itself in the middle of a step (e.g. during cleaning) aren't shown. The plumbing is simplified. Mash-tank volume is estimated from the water that has come in and gone out, because the Brewie only has a level sensor in the boil tank.</p></div>
      <div class="panel"><h3>Activity</h3><div class="alog" id="alog" style="height:260px"></div></div>
    </div></div>`;
  renderConn(); patchAdvanced(); appendActivity(true);
  $('#estop').onclick = () => act(() => api('POST', 'api/brew/estop'), 'Emergency stop sent');
  $('#aPause').onclick = () => act(() => api('POST', 'api/brew/pause'), 'Paused');
  $('#aResume').onclick = () => act(() => api('POST', 'api/brew/resume'), 'Resume sent');
  $('#aNext').onclick = async () => { if (await confirmBox('Skip to the next step?', 'The Brewie will end the current step and move on.', 'Skip')) act(() => api('POST', 'api/brew/next')); };
  $$('[data-drain]').forEach((b) => (b.onclick = async () => {
    const k = b.dataset.drain; const sed = $('#aSed').checked;
    const body = { boil: k === 'boil' || k === 'all', mash: k === 'mash' || k === 'all', hop: k === 'hop' || k === 'all', sedimentation: sed };
    const what = { boil: 'the boil tank', mash: 'the mash tank', hop: 'the hop cages', all: 'all tanks' }[k];
    const warn = machine().drainConnected ? '' : '<br><br><b style="color:var(--err)">Machine setup says the drain hose isn\'t connected.</b>';
    if (await confirmBox(`Drain ${what}?`, `The Brewie will pump ${what} out through the drain hose${sed ? ', leaving the sediment behind' : ''}.${warn}`, 'Drain', true)) act(() => api('POST', 'api/drain', body), 'Drain started');
  }));
}

function patchAdvanced() {
  const svg = $('.diagram'); if (!svg) return;
  const tk0 = $('#tick'); if (tk0) { tk0.classList.remove('beat'); void tk0.offsetWidth; tk0.classList.add('beat'); }
  const s = S.status || {}; const L = s.lamps || {}; const cur = currentStepInfo(); const tk = s.tanks || {};
  const running = !!(S.st && S.st.brewing);
  // flows derived from outputs
  const F = {
    'f-inlet': L.waterInlet && (L.mashInlet || L.boilInlet || L.coolValve),
    'f-mashin': L.waterInlet && L.mashInlet, 'f-boilin': L.waterInlet && L.boilInlet,
    'f-cool': L.coolValve, 'f-mashpump': L.mashPump, 'f-mashret': L.mashPump && L.mashReturn,
    'f-m2b': L.mashPump && !L.mashReturn, 'f-boilpump': L.boilPump, 'f-boilret': L.boilPump && L.boilReturn,
    'f-b2m': L.boilPump && L.mashInlet && !L.boilReturn && !L.waterInlet,
    'f-hops': L.boilPump && (L.hop1 || L.hop2 || L.hop3 || L.hop4),
    'f-drainpump': L.outlet && L.boilPump, 'f-drain': L.outlet || L.coolValve,
  };
  F['f-boilout'] = F['f-b2m'] || F['f-drainpump'];
  for (const [k, on] of Object.entries(F)) $$(`.pipe.${k}`, svg).forEach((p) => p.classList.toggle('flow', !!on));
  $$('[data-v]', svg).forEach((el) => { const k = el.dataset.v; el.classList.toggle('on', k.startsWith('f-') ? !!F[k] : !!L[k]); });
  // tanks
  const lvl = (k, v) => {
    const liq = $(`.liquid.${k}`, svg); if (!liq) return;
    const h = Math.max(0, Math.min(1, (v || 0) / DIAGRAM_MAX_L)) * 254;
    liq.setAttribute('y', String(377 - h)); liq.setAttribute('height', String(h));
  };
  const vOf = (k) => (isNum(tk[k]) ? tk[k] : tk[k + 'Est']);
  lvl('mash', vOf('mash')); lvl('boil', vOf('boil'));
  const txt = (k, v) => { const el = $(`[data-t="${k}"]`, svg); if (el) el.textContent = v; };
  txt('mashT', isNum(s.mashTemp) ? `${fmtT(s.mashTemp)}${unitT()}` : '–');
  txt('boilT', isNum(s.boilTemp) ? `${fmtT(s.boilTemp)}${unitT()}` : '–');
  txt('mashTgt', cur && cur.mashTarget ? `target ${fmtT(cur.mashTarget, 0)}${unitT()}` : '');
  txt('boilTgt', cur && cur.boilTarget ? `target ${fmtT(cur.boilTarget, 0)}${unitT()}` : '');
  for (const k of ['mash', 'boil']) txt(k + 'Vol', isNum(tk[k]) ? `${tk[k].toFixed(1)} L` : isNum(tk[k + 'Est']) ? `≈ ${tk[k + 'Est'].toFixed(1)} L (est.)` : '');
  svg.classList.toggle('idle', !running);
  const connected = S.st && S.st.connection === 'connected'; const paused = running && S.st.brewing.status === 2;
  const en = (id, on) => { const el = $(id); if (el) el.disabled = !on; };
  en('#estop', connected && running); en('#aPause', connected && running && !paused); en('#aResume', connected && running); en('#aNext', connected && running);
  $$('[data-drain]').forEach((b) => { b.disabled = !connected || running; });
  const w = $('#advWarn'); const warn = s.warning; const errs = (s.alerts || []).filter((a) => a.code.startsWith('E'));
  if (w) w.innerHTML = (warn ? `<div class="alert err" style="margin:12px 0 0"><span>⚠</span><div class="grow">${esc(warn.text)}<div class="muted">See troubleshooting below.</div></div></div>` : '')
    + errs.map((a) => `<div class="alert err" style="margin:12px 0 0"><span>⚠</span><div class="grow"><b>${esc(a.text || 'Machine alert')}</b> <span class="num faint">${esc(a.code)}</span></div></div>`).join('');
  const now = $('#advNow');
  if (now) now.innerHTML = running
    ? `<b style="color:var(--text)">${esc((s.progress && s.progress.stageName) || '')}</b>${s.progress ? ` · stage ${s.progress.stageIndex + 1}/${s.progress.stageCount} · ${Math.floor(s.progress.overallPct || 0)}% overall` : ''}<div style="margin-top:6px;color:var(--copper2)">${esc(activityText())}</div>`
    : 'No program running — the Brewie only reports while a brew or cleaning runs.';
}
