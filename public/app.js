/* Brewie Web — single-page UI (no framework). */
'use strict';

// ======================================================================= state & utils
const S = {
  st: null, status: null, recipes: [], log: [], history: [], db: null, view: 'dash', editor: null,
  prefs: Object.assign({ unit: 'C', verbose: false, showCmds: false, sound: true }, safeJSON(localStorage.getItem('brewie.prefs'))),
  activity: [],
  dashSig: '', lastLogRender: 0,
};
function safeJSON(s) { try { return JSON.parse(s) || {}; } catch (_) { return {}; } }
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const view = () => $('#view');
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
function savePrefs() { try { localStorage.setItem('brewie.prefs', JSON.stringify(S.prefs)); } catch (_) {} }

function fmtT(c, digits = 1) {
  if (!isNum(c)) return '–';
  const v = S.prefs.unit === 'F' ? c * 9 / 5 + 32 : c;
  return v.toFixed(digits);
}
const unitT = () => (S.prefs.unit === 'F' ? '°F' : '°C');
function fmtDur(sec) {
  if (!isNum(sec) || sec < 0) return '–';
  sec = Math.round(sec); const h = Math.floor(sec / 3600); const m = Math.floor((sec % 3600) / 60); const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function fmtMin(sec) { if (!isNum(sec) || sec <= 0) return ''; const m = Math.round(sec / 60); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`; }
const r1 = (n, d = 1) => (isNum(n) ? Number(n.toFixed(d)) : n);
function ago(t) { if (!t) return 'never'; const s = Math.round((Date.now() - t) / 1000); return s < 5 ? 'just now' : s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : new Date(t).toLocaleString(); }

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.error) || res.statusText);
  return data;
}
async function act(fn, okText) {
  try { const r = await fn(); if (okText) toast(okText, 'ok'); return r; } catch (e) { toast(e.message, 'error'); return null; }
}
function toast(text, level = 'info') {
  const el = document.createElement('div'); el.className = `toast ${level}`; el.textContent = text;
  $('#toasts').appendChild(el); setTimeout(() => el.remove(), level === 'error' ? 7000 : 4000);
}

// ======================================================================= modal
function modal(html, { onOpen } = {}) {
  return new Promise((resolve) => {
    const dlg = $('#modal'); const body = $('#modalBody');
    body.innerHTML = html;
    const close = (v) => { dlg.close(); resolve(v); };
    body.onsubmit = (e) => { e.preventDefault(); const btn = e.submitter; close(btn ? btn.value : 'ok'); };
    dlg.oncancel = () => resolve('cancel');
    dlg.showModal(); if (onOpen) onOpen(body);
  });
}
async function confirmBox(title, text, okLabel = 'Confirm', danger = false) {
  const v = await modal(`<h2>${esc(title)}</h2><p class="muted" style="margin:0">${text}</p>
    <div class="foot"><button class="btn ghost" value="cancel">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" value="ok">${esc(okLabel)}</button></div>`);
  return v === 'ok';
}

// ======================================================================= live events
function connectEvents() {
  const es = new EventSource('api/events');
  es.addEventListener('state', (e) => { S.st = { ...(S.st || {}), ...JSON.parse(e.data) }; // keep settings/simulator from /api/state
    if (S.st.status) S.status = S.st.status; onState(); });
  es.addEventListener('status', (e) => {
    S.status = JSON.parse(e.data);
    S.history.push({ t: S.status.at, mash: S.status.mashTemp, boil: S.status.boilTemp, vol: S.status.waterVolume });
    if (S.history.length > 3600) S.history.shift();
    if (S.st) S.st.status = S.status;
    if (Alarm.active && Alarm.active.event === 'waiting' && S.status.lamps && !S.status.lamps.waiting) Alarm.silence();
    if (S.view === 'dash') renderDash();
    if (S.view === 'console') renderConsoleStatus();
    if (S.view === 'advanced') patchAdvanced();
  });
  es.addEventListener('log', (e) => { S.log.push(JSON.parse(e.data)); if (S.log.length > 500) S.log.shift(); if (S.view === 'console') appendLog(); });
  es.addEventListener('settings', (e) => { if (S.st) S.st.settings = JSON.parse(e.data); if (S.view === 'settings') { renderMachineSetup(); renderNotify(); } });
  es.addEventListener('activity', (e) => { S.activity.push(JSON.parse(e.data)); if (S.activity.length > 1000) S.activity.shift(); if (S.view === 'dash' || S.view === 'advanced') appendActivity(); });
  es.addEventListener('alarm', (e) => { const a = JSON.parse(e.data); if (Date.now() - a.at < 60000 && (a.event === 'test' || S.prefs.banner !== false)) Alarm.raise(a); });
  es.addEventListener('notice', (e) => { const n = JSON.parse(e.data); toast(n.text, n.level); });
  es.addEventListener('recipes', (e) => { S.recipes = JSON.parse(e.data); if (S.view === 'recipes') renderRecipes(); if (S.view === 'dash') { S.dashSig = ''; renderDash(); } });
  es.onerror = () => { renderConn(true); };
}
function onState() {
  renderConn();
  if (S.view === 'dash') renderDash();
  else if (S.view === 'advanced') patchAdvanced();
  else if (S.view === 'settings') renderSettingsStatus();
  else if (S.view === 'care') renderCare(true);
}

function renderConn(sseDown) {
  const st = S.st || {}; const c = sseDown ? 'disconnected' : (st.connection || 'disconnected');
  const label = { connected: 'Connected', connecting: 'Connecting…', pairing: 'Pairing…', disconnected: 'Offline' }[c];
  const host = st.host ? `${esc(st.host)}:${esc(st.port)}` : 'No address set';
  $('#conn').innerHTML = `<div class="row"><span class="dot ${c}"></span><b>${sseDown ? 'Server unreachable' : label}</b></div>
    <div class="muted num" style="margin-top:4px">${host}</div>
    ${st.status && st.status.mcuVersion ? `<div class="faint" style="margin-top:2px">MCU v${esc(st.status.mcuVersion)}</div>` : ''}
    ${st.lastError && c !== 'connected' ? `<div style="margin-top:6px;color:var(--err);font-size:12px">${esc(st.lastError)}</div>` : ''}
    ${st.simulator ? '<div class="badge" style="margin-top:8px">simulator</div>' : ''}
    ${st.version ? `<div class="faint num" style="margin-top:6px;font-size:11px">Brewie Web v${esc(st.version)}</div>` : ''}`;
  $$('.mobconn').forEach((el) => { el.innerHTML = `<span class="dot ${c}"></span>${label}${st.version ? ` <span class="faint num" style="font-size:11px">v${esc(st.version)}</span>` : ''}`; });
}

// ======================================================================= router
const VIEWS = { '': 'dash', recipes: 'recipes', recipe: 'editor', care: 'care', advanced: 'advanced', console: 'console', settings: 'settings' };
function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const v = VIEWS[parts[0]] || 'dash';
  if (S.editor && S.editor.dirty && v !== 'editor') {
    if (!window.confirm('Discard unsaved recipe changes?')) { location.hash = `#/recipe/${S.editor.id}`; return; }
  }
  S.view = v; S.dashSig = '';
  $$('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.view === (v === 'editor' ? 'recipes' : v)));
  window.scrollTo(0, 0);
  if (v === 'dash') renderDash(true);
  else if (v === 'recipes') renderRecipes();
  else if (v === 'editor') openEditor(decodeURIComponent(parts[1] || ''));
  else if (v === 'care') renderCare();
  else if (v === 'console') renderConsole();
  else if (v === 'advanced') renderAdvanced();
  else if (v === 'settings') renderSettings();
}

// ======================================================================= dashboard
/** Plain-English "what is it doing right now", from the current step plus live sensor data. */
function activityText() {
  const s = S.status; const st = S.st || {}; const b = st.brewing; if (!s || !b) return '';
  const cur = currentStepInfo(); const alerts = (s.alerts || []);
  if (b.status === 2) return 'Paused — resume when you are ready';
  const wait = alerts.find((a) => a.code === 'P103');
  if (wait) {
    const inner = cur ? cur.inner : null;
    const what = { 13: 'Add the fermentables: Brewie Bag with grain in the mashing tank', 26: 'Prepare the next mashing round', 20: 'Load the hops', 21: 'Prepare the hop back' }[inner];
    return `Waiting for you — ${what || 'finish the step shown on the Brewie'}, then press Continue`;
  }
  const err = alerts.find((a) => a.code.startsWith('E')); if (err) return `Stopped: ${err.text || err.code}`;
  const parts = []; const hist = S.history.slice(-12); const dv = hist.length > 3 ? (hist[hist.length - 1].vol - hist[0].vol) : 0;
  const stage = s.progress && s.progress.stageName;
  if (cur && (cur.inner === 10 || cur.inner === 11) || dv > 0.15) parts.push(`Filling water — ${isNum(s.waterVolume) ? s.waterVolume.toFixed(1) + ' L' : '…'}`);
  else if (dv < -0.15 || /Drain/.test(stage || '')) parts.push(`Draining${isNum(s.waterVolume) ? ` — ${s.waterVolume.toFixed(1)} L left` : ''}`);
  if (cur && cur.mashTarget && Math.abs(s.mashTemp - cur.mashTarget) > 0.5) parts.push(`${s.mashTemp < cur.mashTarget ? 'Heating' : 'Cooling'} mash tank to ${fmtT(cur.mashTarget, 0)}${unitT()} (now ${fmtT(s.mashTemp)}${unitT()})`);
  else if (cur && cur.mashTarget) parts.push(`Holding mash at ${fmtT(cur.mashTarget, 0)}${unitT()}`);
  if (cur && cur.boilTarget && Math.abs(s.boilTemp - cur.boilTarget) > 0.5) parts.push(`${s.boilTemp < cur.boilTarget ? 'Heating' : 'Cooling'} boil tank to ${fmtT(cur.boilTarget, 0)}${unitT()} (now ${fmtT(s.boilTemp)}${unitT()})`);
  else if (cur && cur.boilTarget >= 90) parts.push('Boiling');
  if (!parts.length && s.mashPump && s.mashPump.tach) parts.push('Mash pump circulating');
  if (!parts.length && s.boilPump && s.boilPump.tach) parts.push('Boil pump circulating');
  if (!parts.length && /Clean|Rins/.test(stage || '')) parts.push('Cleaning — valves and pumps cycling');
  return parts.slice(0, 2).join(' · ') || (cur ? cur.label : '');
}
function clockIn(sec) { if (!isNum(sec)) return '–'; return new Date(Date.now() + sec * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

function currentStepInfo() {
  const st = S.st || {}; const b = st.brewing; const s = S.status;
  if (!b || !b.steps || !s || !isNum(s.step) || s.step < 0) return null;
  return b.steps[s.step] || null;
}
function dashSignature() {
  const st = S.st || {}; const b = st.brewing; const s = S.status || {};
  return JSON.stringify([st.connection, !!b, b && b.id, b && b.status, b && b.steps && b.steps.length, s.progress && s.progress.stageIndex, (s.notifications || []).join(), S.recipes.length, S.prefs.unit, !!s.valid]);
}
function renderDash(force) {
  const sig = dashSignature();
  if (!force && sig === S.dashSig && $('#dashRoot')) return patchDash();
  S.dashSig = sig;
  const st = S.st || {}; const b = st.brewing; const s = S.status;
  const connected = st.connection === 'connected';
  const cur = currentStepInfo();
  const notif = (s && s.notifications) || [];
  const waiting = notif.includes('P103');
  const running = b && b.status === 1; const paused = b && b.status === 2;
  const pillCls = b ? (b.statusName || '') : '';

  let stepCard;
  if (b) {
    stepCard = `<div class="panel">
      <div class="phase"><div>
        <div class="sub">${esc(b.typeName || 'Brewing')}${b.type === 0 && b.recipeName ? ' · ' + esc(b.recipeName) : ''} · <span data-k="stageno"></span></div>
        <div class="name" data-k="phase">${esc((s && s.progress && s.progress.stageName) || (cur ? cur.phase : 'Starting…'))}</div>
        ${S.prefs.verbose ? '<div data-k="activity" style="font-size:17px;margin-top:4px;color:var(--copper2)"></div>' : ''}
      </div><div style="text-align:right"><span class="pill ${esc(pillCls)}">${esc(b.statusName || '')}</span><div class="num" style="font-family:var(--display);font-size:44px;font-weight:700;line-height:1;margin-top:8px" data-k="overallPct">–</div><div class="faint" style="font-size:11px;letter-spacing:.12em">OVERALL</div></div></div>
      <div style="margin-top:16px;display:flex;justify-content:space-between;font-size:13px" class="muted"><span data-k="stagelbl">Stage</span><span class="num" data-k="stagePct"></span></div>
      <div class="bar" style="margin-top:6px"><i data-k="stagebar"></i></div>
      <div class="bar thin" style="margin-top:8px"><i data-k="overall"></i></div>
      <div class="kv">
        <div><span>Step time</span><b data-k="stepTime">–</b></div>
        <div><span>Elapsed</span><b data-k="totalTime">–</b></div>
        <div><span>Remaining</span><b data-k="remaining">–</b></div>
        <div><span>Ends at</span><b data-k="endsAt">–</b></div>
      </div>
      ${waiting ? `<div class="alert"><span style="font-size:22px">✋</span><div class="grow"><b>Brewie is waiting for you.</b><div class="muted">Complete the action shown on the machine, then confirm to continue.</div></div><button class="btn primary" data-act="next">Continue</button></div>` : ''}
      ${((s && s.alerts) || []).filter((a) => a.code !== 'P103').map((a) => `<div class="alert ${a.code.startsWith('E') ? 'err' : ''}"><span style="font-size:20px">${a.code.startsWith('E') ? '⚠' : 'ℹ'}</span><div class="grow"><b>${esc(a.text || 'Machine notification')}</b> <span class="num faint">${esc(a.code)}</span><div class="muted">${a.code.startsWith('E') ? 'The Brewie has paused. Fix the problem, then resume from here or on the machine.' : 'See the Brewie\'s screen for details.'}</div></div>${a.code.startsWith('E') && paused ? '<button class="btn primary" data-act="resume">Resume</button>' : ''}</div>`).join('')}
      <div class="btns" style="margin-top:16px">
        ${running ? '<button class="btn big" data-act="pause">❚❚ Pause</button>' : ''}
        ${paused ? '<button class="btn big primary" data-act="resume">▶ Resume</button>' : ''}
        <button class="btn big" data-act="next" ${connected ? '' : 'disabled'}>Skip to next step ⏭</button>
        <button class="btn big danger" data-act="stop" ${connected ? '' : 'disabled'}>■ Stop</button>
      </div>
    </div>`;
  } else {
    const opts = S.recipes.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');
    stepCard = `<div class="panel">
      <div class="phase"><div><div class="sub">${connected ? 'Machine idle' : 'Not connected'}</div>
      <div class="name">${connected ? 'Ready to brew' : 'Brewie offline'}</div>
      <div class="muted" style="margin-top:4px">${connected ? 'Pick a recipe that is on the machine and start brewing. The Brewie only sends live temperatures while a program runs, so the gauges stay blank until then.' : (st.host ? `Trying to reach ${esc(st.host)}…` : 'Set your Brewie\'s IP address in Settings.')}</div></div>
      <span class="pill">${connected ? 'idle' : esc(st.connection || 'offline')}</span></div>
      ${connected ? `<div style="display:flex;gap:10px;margin-top:18px;flex-wrap:wrap">
        <select id="quickRecipe" style="flex:1;min-width:200px">${opts || '<option value="">No recipes yet</option>'}</select>
        <button class="btn primary big" data-act="start" ${S.recipes.length ? '' : 'disabled'}>Start brewing…</button></div>
        <div class="btns" style="margin-top:12px"><a class="btn sm ghost" href="#/care">Cleaning & draining</a><a class="btn sm ghost" href="#/recipes">Manage recipes</a></div>`
      : `<div class="btns" style="margin-top:18px"><a class="btn primary" href="#/settings">Open settings</a>${st.host ? '<button class="btn" data-act="reconnect">Reconnect now</button>' : ''}</div>`}
    </div>`;
  }

  const timeline = b && b.stages ? renderStages(b.stages, s && s.progress ? s.progress.stageIndex : -1) : '<div class="empty" style="padding:20px"><b>No program running</b>The step plan appears here once a brew or cleaning starts.</div>';

  view().innerHTML = `<div id="dashRoot">
    <div class="head"><div><h1>${b ? esc(b.type === 0 ? (b.recipeName || 'Brewing') : (b.typeName || 'Cleaning')) : 'Brewhouse'}</h1><p>${b && isNum(b.estimatedTime) && b.estimatedTime ? `Program length ≈ ${fmtMin(b.estimatedTime)}` : 'Live status from your Brewie'}</p></div>
      <div class="mobconn"></div></div>
    <div class="grid dash">
      <div class="grid">
        <div class="tanks">
          ${tankHTML('boil', 'Boil tank', '--boil')}
          ${tankHTML('mash', 'Mash tank', '--mash')}
        </div>
        ${stepCard}
        <div class="panel"><h3>Temperature history <span class="legend"><span><i style="background:var(--boil)"></i>Boil</span><span><i style="background:var(--mash)"></i>Mash</span></span></h3>
          <canvas class="chart" id="chart"></canvas></div>
      </div>
      <div class="grid">
        <div class="panel"><h3>Program</h3>${timeline}</div>
        <div class="panel"><h3><span>Machine status <span class="tick" id="tick" title="flashes on every update from the Brewie"></span></span> <span class="legend2"><span><span style="color:#7fe06a">●</span> on</span><span><span style="color:#e9958a">●</span> off</span></span></h3>
          <div id="lampBox">${lampsHTML()}</div>
          <div class="kv" style="grid-template-columns:1fr 1fr;margin-top:12px">
            <div><span>Water</span><b data-k="vol">–</b></div><div><span>Board temp</span><b data-k="board">–</b></div>
          </div><div class="faint" style="font-size:12px;margin-top:10px" data-k="seen"></div></div>
        <div class="panel"><h3>Activity <span style="display:flex;gap:12px">
            <label class="switch"><input type="checkbox" id="vSw" ${S.prefs.verbose ? 'checked' : ''}> Verbose</label>
            <label class="switch"><input type="checkbox" id="cSw" ${S.prefs.showCmds ? 'checked' : ''}> Commands</label></span></h3>
          <div class="alog" id="alog"></div></div>
      </div>
    </div></div>`;
  renderConn();
  patchDash();
  appendActivity(true);
  $('#vSw').onchange = (e) => { S.prefs.verbose = e.target.checked; savePrefs(); renderDash(true); };
  $('#cSw').onchange = (e) => { S.prefs.showCmds = e.target.checked; savePrefs(); appendActivity(true); };
}
const LAMP_GROUPS = [
  ['Heat', [['mashHeater', 'Mash heater'], ['boilHeater', 'Boil heater']]],
  ['Pumps', [['mashPump', 'Mash pump'], ['boilPump', 'Boil pump']]],
  ['Water', [['waterInlet', 'Water inlet'], ['mashInlet', 'Mash inlet'], ['boilInlet', 'Boil inlet'], ['mashReturn', 'Mash return'], ['boilReturn', 'Boil return'], ['coolValve', 'Cooling'], ['outlet', 'Drain']]],
  ['Hop cages', [['hop1', 'Cage 1'], ['hop2', 'Cage 2'], ['hop3', 'Cage 3'], ['hop4', 'Cage 4']]],
  ['Attention', [['waiting', 'Waiting for you', 'warn'], ['alert', 'Alert', 'err']]],
];
function lampsHTML() {
  const L = (S.status && S.status.lamps) || {};
  return LAMP_GROUPS.map(([g, items]) => `<div class="lampgrp">${g}</div><div class="lamps">${items.map(([k, label, cls]) => `<div class="lamp ${cls || ''} ${L[k] ? 'on' : ''}" data-lamp="${k}"><i></i>${label}</div>`).join('')}</div>`).join('');
}
function patchLamps() {
  const L = (S.status && S.status.lamps) || {};
  $$('[data-lamp]').forEach((el) => el.classList.toggle('on', !!L[el.dataset.lamp]));
}
function appendActivity(all) {
  const box = $('#alog'); if (!box) return;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  if (all) { box.innerHTML = ''; S.actRendered = 0; }
  const ph = $('.alog-ph', box); if (ph && S.activity.length) ph.remove();
  const frag = document.createDocumentFragment();
  for (const e of S.activity.slice(S.actRendered || 0)) {
    if (e.kind === 'cmd' && !S.prefs.showCmds) continue;
    const d = document.createElement('div');
    d.innerHTML = `<span class="t">${new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</span><span class="${esc(e.kind)}">${esc(e.text)}</span>`;
    frag.appendChild(d);
  }
  if (!S.activity.length && all) box.innerHTML = '<div class="faint alog-ph" style="display:block">Changes appear here as the Brewie runs a program.</div>';
  box.appendChild(frag); S.actRendered = S.activity.length;
  while (box.childNodes.length > 800) box.removeChild(box.firstChild);
  if (atBottom || all) box.scrollTop = box.scrollHeight;
}
function tankHTML(k, label, color) {
  return `<div class="tank" style="--c:var(${color})" data-tank="${k}">
    <div class="lbl"><span>${label}</span><span class="heat" data-k="${k}Heat">HEATER</span></div>
    <div class="t"><span data-k="${k}T">–</span><small>${unitT()}</small></div>
    <div class="tgt" data-k="${k}Tgt">&nbsp;</div><div class="vol" data-k="${k}Vol">&nbsp;</div></div>`;
}
function renderStages(stages, cur) {
  let html = '<ul class="timeline">';
  stages.forEach((st, i) => {
    const cls = i < cur ? 'done' : i === cur ? 'cur' : '';
    html += `<li class="st ${cls}"><span class="b"></span><span>${esc(st.name)}</span><span class="meta">${esc(fmtMin(st.duration) || '<1 min')}</span></li>`;
  });
  return html + '</ul>';
}
function renderTimeline(steps, curIdx) {
  let html = '<ul class="timeline">'; let lastPhase = null;
  steps.forEach((st, i) => {
    if (!st) return;
    if (st.phase !== lastPhase) { html += `<li class="ph">${esc(st.phase)}</li>`; lastPhase = st.phase; }
    const cls = i < curIdx ? 'done' : i === curIdx ? 'cur' : '';
    const meta = [st.mashTarget ? `${fmtT(st.mashTarget, 0)}${unitT()}` : st.boilTarget ? `${fmtT(st.boilTarget, 0)}${unitT()}` : '', fmtMin(st.duration)].filter(Boolean).join(' · ');
    html += `<li class="st ${cls}" ${i === curIdx ? 'id="curStep"' : ''}><span class="b"></span><span>${esc(st.label)}</span><span class="meta">${esc(meta)}</span></li>`;
  });
  return html + '</ul>';
}
function setK(k, v, attr) { $$(`[data-k="${k}"]`).forEach((el) => { if (attr) el.style[attr] = v; else el.innerHTML = v; }); }
function patchDash() {
  const s = S.status; const st = S.st || {}; const b = st.brewing; const cur = currentStepInfo();
  if (s) {
    setK('mashT', fmtT(s.mashTemp)); setK('boilT', fmtT(s.boilTemp));
    $$('[data-k="mashHeat"]').forEach((e) => e.classList.toggle('on', !!s.mashHeater));
    $$('[data-k="boilHeat"]').forEach((e) => e.classList.toggle('on', !!s.boilHeater));
    $$('[data-tank="mash"]').forEach((e) => e.classList.toggle('heating', !!s.mashHeater));
    $$('[data-tank="boil"]').forEach((e) => e.classList.toggle('heating', !!s.boilHeater));
    const tk = s.tanks || {};
    const fill = (k, v) => $$(`[data-tank="${k}"]`).forEach((t) => t.style.setProperty('--fill', `${Math.max(4, Math.min(100, ((v || 0) / 30) * 100))}%`));
    const lv = (k) => { const m = tk[k], e = tk[k + 'Est']; fill(k, isNum(m) ? m : e);
      setK(k + 'Vol', isNum(m) ? `Water <b>${m.toFixed(1)} L</b>` : isNum(e) ? `Water <b>≈ ${e.toFixed(1)} L</b> <span class="faint">est.</span>` : '&nbsp;'); };
    lv('mash'); lv('boil');
    setK('vol', isNum(s.waterVolume) ? `${s.waterVolume.toFixed(1)} L` : '–');
    patchLamps();
    const tick = $('#tick'); if (tick) { tick.classList.remove('beat'); void tick.offsetWidth; tick.classList.add('beat'); }
    setK('board', isNum(s.boardTemp) ? `${s.boardTemp.toFixed(1)}°C` : '–');
    setK('seen', `Last update ${ago(s.at)}${s.mcuVersion ? ` · MCU v${esc(s.mcuVersion)}` : ''}`);
    setK('stepTime', fmtDur(s.stepTime)); setK('totalTime', fmtDur(s.totalTime));
    const pr = s.progress;
    if (b && pr) {
      setK('overallPct', isNum(pr.overallPct) ? `${Math.floor(pr.overallPct)}%` : '–');
      setK('overall', `${pr.overallPct || 0}%`, 'width');
      setK('stagebar', `${pr.stagePct || 0}%`, 'width');
      setK('stagelbl', esc(`${pr.stageName || 'Stage'}${isNum(pr.stagePct) ? ` — ${Math.floor(pr.stagePct)}%` : ''}`));
      setK('stagePct', '');
      setK('stageno', `stage ${pr.stageIndex + 1} of ${pr.stageCount}`);
      setK('remaining', fmtDur(pr.remaining)); setK('endsAt', b.status === 2 ? 'paused' : clockIn(pr.remaining));
    }
    if (S.prefs.verbose) setK('activity', esc(activityText()));
  }
  setK('mashTgt', cur && cur.mashTarget ? `Target <b>${fmtT(cur.mashTarget)}${unitT()}</b>` : '&nbsp;');
  setK('boilTgt', cur && cur.boilTarget ? `Target <b>${fmtT(cur.boilTarget)}${unitT()}</b>` : '&nbsp;');
  drawChart();
}

function drawChart() {
  const cv = $('#chart'); if (!cv) return;
  const dpr = window.devicePixelRatio || 1; const w = cv.clientWidth; const h = cv.clientHeight;
  if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  const data = S.history.filter((p) => p.t > Date.now() - 90 * 60 * 1000);
  const pad = { l: 38, r: 10, t: 10, b: 22 };
  const conv = (c) => (S.prefs.unit === 'F' ? c * 9 / 5 + 32 : c);
  let lo = Infinity; let hi = -Infinity;
  for (const p of data) for (const v of [p.mash, p.boil]) if (isNum(v)) { lo = Math.min(lo, conv(v)); hi = Math.max(hi, conv(v)); }
  if (!isFinite(lo)) { lo = conv(10); hi = conv(100); }
  lo = Math.floor((lo - 3) / 10) * 10; hi = Math.ceil((hi + 3) / 10) * 10; if (hi - lo < 20) hi = lo + 20;
  const t0 = data.length ? data[0].t : Date.now() - 60000; const t1 = Math.max(Date.now(), t0 + 60000);
  const X = (t) => pad.l + ((t - t0) / (t1 - t0)) * (w - pad.l - pad.r);
  const Y = (v) => pad.t + (1 - (conv(v) - lo) / (hi - lo)) * (h - pad.t - pad.b);
  g.font = '11px ui-monospace, monospace'; g.fillStyle = '#75685b'; g.strokeStyle = 'rgba(255,255,255,.06)'; g.lineWidth = 1;
  for (let v = lo; v <= hi; v += (hi - lo > 60 ? 20 : 10)) {
    const y = pad.t + (1 - (v - lo) / (hi - lo)) * (h - pad.t - pad.b);
    g.beginPath(); g.moveTo(pad.l, y); g.lineTo(w - pad.r, y); g.stroke(); g.fillText(String(v), 4, y + 4);
  }
  const mins = Math.round((t1 - t0) / 60000); g.fillText(`−${mins} min`, pad.l, h - 5); g.fillText('now', w - pad.r - 24, h - 5);
  const cur = currentStepInfo();
  for (const [k, color, tgt] of [['mash', '#f0a640', cur && cur.mashTarget], ['boil', '#e2553a', cur && cur.boilTarget]]) {
    if (tgt) { g.setLineDash([4, 4]); g.strokeStyle = color + '88'; g.beginPath(); g.moveTo(pad.l, Y(tgt)); g.lineTo(w - pad.r, Y(tgt)); g.stroke(); g.setLineDash([]); }
    g.strokeStyle = color; g.lineWidth = 2; g.beginPath(); let started = false;
    for (const p of data) { if (!isNum(p[k])) continue; const x = X(p.t); const y = Y(p[k]); if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y); }
    g.stroke(); g.lineWidth = 1;
  }
}
window.addEventListener('resize', () => { if (S.view === 'dash') drawChart(); });

// ======================================================================= machine setup
function machine() {
  return Object.assign({ waterInlet: true, drainConnected: true, cooling: true, coolingSource: 'inlet', checklist: true }, (S.st && S.st.settings && S.st.settings.machine) || {});
}

// ======================================================================= brew actions
async function startBrewFlow(recipeId) {
  const r = S.recipes.find((x) => x.id === recipeId);
  if (!r) return toast('Pick a recipe first', 'error');
  const M = machine();
  // [key, text, shown-when]
  const checks = [
    ['bag', 'False bottom is in the mashing tank and the Brewie Bag sits on it', () => true],
    ['ferm', 'Fermentables are in the Brewie Bag', () => true],
    ['hops', 'Hops are loaded in the hop cages', () => true],
    ['inlet', 'Water inlet hose is connected and the tap is open', (o) => o.inlet || (o.cool && M.coolingSource === 'inlet')],
    ['pour', 'The recipe\'s water is poured into the boiling tank', (o) => !o.inlet],
    ['chiller', 'External chiller is connected and running', (o) => o.cool && M.coolingSource === 'external'],
    ['drain', 'Drain/outlet hose is connected and led to a drain', () => true],
  ];
  const v = await modal(`<h2>Start “${esc(r.name)}”</h2>
    <p class="muted" style="margin:0">The Brewie will start heating as soon as you confirm.</p>
    ${!M.drainConnected ? '<div class="alert err" style="margin:0"><span>⚠</span><div class="grow">Machine setup says the <b>drain hose isn\'t connected</b>. The Brewie drains during the brew and cooling — connect it before starting.</div></div>' : ''}
    <div class="grid" style="gap:8px">
      <label class="check"><input type="checkbox" id="optInlet" ${M.waterInlet ? 'checked' : ''}> Automatic water inlet</label>
      <label class="check"><input type="checkbox" id="optCool" ${M.cooling ? 'checked' : ''}> Automatic cooling <span class="faint" style="margin-left:auto;font-size:12px">${M.coolingSource === 'external' ? 'external chiller' : 'tap water'}</span></label>
    </div>
    ${M.checklist ? `<h3 style="margin-top:4px">Checklist</h3><div class="grid" style="gap:8px">${checks.map(([k, t]) => `<label class="check" data-row="${k}"><input type="checkbox" class="ck"> ${esc(t)}</label>`).join('')}</div>` : ''}
    <div class="foot"><button class="btn ghost" value="cancel">Cancel</button><button class="btn primary" value="ok" id="goBtn">Start brewing</button></div>`,
  { onOpen: (body) => {
    const upd = () => {
      const o = { inlet: $('#optInlet', body).checked, cool: $('#optCool', body).checked };
      let ok = true;
      for (const [k, , when] of checks) {
        const row = $(`[data-row="${k}"]`, body); if (!row) continue;
        const show = when(o); row.style.display = show ? '' : 'none';
        if (show && !$('.ck', row).checked) ok = false;
      }
      $('#goBtn', body).disabled = !ok;
    };
    body.addEventListener('change', upd); upd();
  } });
  if (v !== 'ok') return;
  const waterInlet = $('#optInlet').checked; const cooling = $('#optCool').checked;
  await act(() => api('POST', 'api/brew/start', { id: recipeId, waterInlet, cooling }), 'Start command sent');
  location.hash = '#/';
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const a = el.dataset.act;
  if (a === 'pause') act(() => api('POST', 'api/brew/pause'));
  else if (a === 'resume') act(() => api('POST', 'api/brew/resume'));
  else if (a === 'next') { if (await confirmBox('Continue to the next step?', 'The Brewie will finish the current step and move on.', 'Continue')) act(() => api('POST', 'api/brew/next')); }
  else if (a === 'stop') { if (await confirmBox('Stop the program?', 'This aborts the running brew or cleaning program on the machine. It cannot be resumed.', 'Stop program', true)) act(() => api('POST', 'api/brew/stop'), 'Stop sent'); }
  else if (a === 'start') startBrewFlow(($('#quickRecipe') || {}).value || el.dataset.id);
  else if (a === 'reconnect') act(() => api('POST', 'api/connect', {}));
});

// ======================================================================= recipes list
function srmColor(srm) { const tbl = (S.db && S.db.srm) || []; if (!tbl.length || !isNum(srm)) return '#d9a43a'; return tbl[Math.max(0, Math.min(tbl.length - 1, Math.round(srm)))]; }
const lovToSrm = (l) => (isNum(l) ? 1.3546 * l - 0.76 : null);

function renderRecipes() {
  const q = (S.recipeQuery || '').toLowerCase();
  const list = S.recipes.filter((r) => !q || `${r.name} ${r.style}`.toLowerCase().includes(q));
  const connected = S.st && S.st.connection === 'connected';
  const sync = (S.st && S.st.sync) || {};
  view().innerHTML = `<div class="head"><div><h1>Recipes</h1><p>${S.recipes.length} recipe${S.recipes.length === 1 ? '' : 's'} mirrored from your Brewie${sync.lastSync ? ` · synced ${ago(sync.lastSync)}` : ''}</p></div>
    <div class="btns"><button class="btn" id="syncBtn" ${connected ? '' : 'disabled'}>⇅ Sync with Brewie</button>
    <button class="btn" id="importBtn">Import .brewie</button><button class="btn primary" id="newBtn">+ New recipe</button></div></div>
    <input type="search" id="rq" placeholder="Search recipes…" value="${esc(S.recipeQuery || '')}" style="margin-bottom:16px;max-width:420px">
    ${list.length ? `<div class="cards">${list.map((r) => `<div class="rcard" data-id="${esc(r.id)}">
      <div class="glass" style="--beer:${srmColor(lovToSrm(r.estColor))}"></div>
      <h4>${esc(r.name)}</h4><div class="style">${esc(r.style || 'No style set')}</div>
      <div class="stats">${isNum(r.estABV) ? `<span class="stat">ABV<b>${r.estABV.toFixed(1)}%</b></span>` : ''}${isNum(r.estOG) ? `<span class="stat">OG<b>${r.estOG.toFixed(3)}</b></span>` : ''}${isNum(r.IBU) ? `<span class="stat">IBU<b>${Math.round(r.IBU)}</b></span>` : ''}${isNum(r.batchSize) ? `<span class="stat">Batch<b>${r.batchSize.toFixed(1)} L</b></span>` : ''}</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:auto">${r.pendingUpload ? '<span class="badge">not on machine yet</span>' : '<span class="faint" style="font-size:12px">on machine</span>'}
      <button class="btn sm" data-act="start" data-id="${esc(r.id)}" ${connected ? '' : 'disabled'}>Brew</button></div></div>`).join('')}</div>`
    : `<div class="panel empty"><b>${S.recipes.length ? 'No matches' : 'No recipes yet'}</b>${connected ? 'Recipes on your Brewie appear here after a sync. You can also create one here.' : 'Connect to your Brewie to pull its recipes, or create one now — it uploads on the next connection.'}</div>`}
    <input type="file" id="importFile" accept=".brewie,.json,application/json" style="display:none">`;
  $('#rq').oninput = (e) => { S.recipeQuery = e.target.value; const pos = e.target.selectionStart; renderRecipes(); const i = $('#rq'); i.focus(); i.setSelectionRange(pos, pos); };
  $$('.rcard').forEach((c) => c.addEventListener('click', (e) => { if (e.target.closest('[data-act]')) return; location.hash = `#/recipe/${encodeURIComponent(c.dataset.id)}`; }));
  $('#syncBtn').onclick = () => act(() => api('POST', 'api/sync'), 'Sync started');
  $('#newBtn').onclick = newRecipeFlow;
  $('#importBtn').onclick = () => $('#importFile').click();
  $('#importFile').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { const recipe = JSON.parse(await f.text()); const r = await api('POST', 'api/recipes', { recipe }); toast(`Imported “${r.name}”`, 'ok'); location.hash = `#/recipe/${r.id}`; }
    catch (err) { toast('Import failed: ' + err.message, 'error'); }
  };
}
async function newRecipeFlow() {
  const opts = S.recipes.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');
  const v = await modal(`<h2>New recipe</h2>
    <label class="f">Name<input type="text" id="nrName" value="New recipe" required></label>
    <label class="f">Start from<select id="nrFrom"><option value="">Blank template</option>${opts}</select></label>
    <p class="muted" style="margin:0;font-size:13px">Copying a recipe that came from your Brewie keeps every field the machine expects — the safest way to start.</p>
    <div class="foot"><button class="btn ghost" value="cancel">Cancel</button><button class="btn primary" value="ok">Create</button></div>`,
  { onOpen: (b) => { const sel = $('#nrFrom', b); if (S.recipes.length) sel.value = S.recipes[0].id; $('#nrName', b).select(); } });
  if (v !== 'ok') return;
  const name = $('#nrName').value.trim() || 'New recipe'; const from = $('#nrFrom').value;
  const r = await act(() => api('POST', 'api/recipes', from ? { cloneFrom: from, name } : { name }));
  if (r) location.hash = `#/recipe/${r.id}`;
}

// ======================================================================= recipe calculations (mirrors Recipe::calculate)
const EFF_TABLE = [0.9, 0.85, 0.8, 0.7, 0.65, 0.55, 0.5, 0.4];
function flatGroups(x) { return Array.isArray(x) ? x.flatMap((g) => (Array.isArray(g) ? g : [g])).filter((v) => v && typeof v === 'object') : []; }
function calcRecipe(r) {
  const ferm = flatGroups(r.fermentables); const hops = flatGroups(r.hops); const mash = r.mash || {};
  const kg = ferm.reduce((s, f) => s + (Number(f.amount) || 0), 0);
  const idx = Math.max(1, Math.trunc(kg)) - 1; const eff = idx > 7 ? 0.65 : EFF_TABLE[idx];
  const water = Number(mash.mashInWater) || 0;
  const out = { kg, efficiency: eff, warnings: [] };
  if (!ferm.length) out.warnings.push('Add at least one fermentable.');
  if (!water) out.warnings.push('Mash-in water amount is missing.');
  const steps = flatGroups(mash.mashSteps);
  if (!steps.length) out.warnings.push('Add at least one mash step.');
  if (water <= 0) return out;
  const V = (water + (Number(mash.spargingWater) || 0) - kg) * 0.9; out.batchSize = V; // verified against 25 recipes saved by the Brewie
  if (V <= 0) { out.warnings.push('Not enough mash water for this grain bill.'); return out; }
  const gal = V / 3.78541; let pts = 0; let mcu = 0;
  for (const f of ferm) { const a = Number(f.amount) || 0; pts += eff * (Number(f.yield) || 0) * a / 0.45363; mcu += (Number(f.color) || 0) * a / 0.4536 / gal; }
  const og = pts / gal / 1000 + 1; out.estOG = og;
  out.srm = 1.4922 * Math.pow(mcu, 0.6859); out.estColor = (out.srm + 0.76) / 1.3546;
  let att = 0;
  for (const stage of (Array.isArray(r.fermentation) ? r.fermentation : []).slice(0, 1)) for (const ing of (stage.ingredients || [])) if (String(ing.category || '').toLowerCase() === 'yeast' && isNum(Number(ing.attenuation))) att = Number(ing.attenuation);
  if (att > 0) { const p = Math.round((og - 1) * 1000); out.estFG = (p - p * att / 100) / 1000 + 1; out.estABV = (og - out.estFG) * 131; }
  else if (Array.isArray(r.fermentation) && r.fermentation.length) out.warnings.push('Pick a yeast to estimate FG and ABV.');
  let ibu = 0;
  for (const hp of hops) { const a = Number(hp.amount) || 0; const t = Number(hp.time) || 0; const aa = Number(hp.alpha) || 0;
    ibu += aa / 100 * a * 1e6 * ((1 - Math.exp(-0.04 * t)) / 4.15) * 1.65 * Math.pow(0.000125, og - 1) / V; }
  out.IBU = ibu;
  if (mash.spargingWater && !(mash.spargingTemperature && mash.spargingTime)) out.warnings.push('Sparging needs water, temperature and time.');
  return out;
}

// ======================================================================= recipe editor
async function openEditor(id) {
  if (S.editor && S.editor.id === id && S.editor.recipe) return renderEditor();
  view().innerHTML = '<div class="empty">Loading recipe…</div>';
  const r = await act(() => api('GET', `api/recipes/${encodeURIComponent(id)}`));
  if (!r) { location.hash = '#/recipes'; return; }
  normalizeRecipe(r);
  S.editor = { id, recipe: r, tab: 'overview', dirty: false };
  renderEditor();
}
function normalizeRecipe(r) {
  const groups = (x, n) => { let g = Array.isArray(x) ? x : []; if (g.length && !Array.isArray(g[0])) g = [g]; while (g.length < n) g.push([]); return g; };
  r.fermentables = groups(r.fermentables, 1);
  r.hops = groups(r.hops, 4);
  r.mash = r.mash && typeof r.mash === 'object' ? r.mash : {};
  r.mash.mashSteps = groups(r.mash.mashSteps, 1);
  // fermentation is optional on the Brewie; only create it when the user picks a yeast
}
function getPath(o, p) { return p.split('.').reduce((a, k) => (a == null ? a : a[k]), o); }
function setPath(o, p, v) { const ks = p.split('.'); const last = ks.pop(); const t = ks.reduce((a, k) => (a[k] == null ? (a[k] = /^\d+$/.test(k) ? [] : {}) : a[k]), o); t[last] = v; }
function inp(path, { type = 'number', step = 'any', ph = '', cls = '', ac = '' } = {}) {
  const v = getPath(S.editor.recipe, path);
  return `<input type="${type}" ${type === 'number' ? `step="${step}"` : ''} data-p="${esc(path)}" ${ac ? `data-ac="${ac}"` : ''} class="${cls}" placeholder="${esc(ph)}" value="${esc(v ?? '')}">`;
}

function renderEditor() {
  const E = S.editor; const r = E.recipe; const connected = S.st && S.st.connection === 'connected';
  const tabs = [['overview', 'Overview'], ['ferm', 'Fermentables'], ['mash', 'Mash'], ['hops', 'Hops'], ['yeast', 'Fermentation'], ['json', 'Raw JSON']];
  view().innerHTML = `<div class="head"><div><a href="#/recipes" class="muted" style="text-decoration:none">← Recipes</a><h1 style="margin-top:4px">${esc(r.name || 'Untitled')}</h1><p class="num faint" style="font-size:12px">${esc(r.id)}</p></div>
    <div class="btns"><button class="btn" id="dupBtn">Duplicate</button><a class="btn" href="api/recipes/${encodeURIComponent(r.id)}/export">Export</a><button class="btn danger" id="delBtn">Delete</button></div></div>
    <div class="editor"><div class="panel">
      <div class="etabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${E.tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div id="tabBody">${tabBody(E.tab)}</div></div>
      <div class="side grid">
        <div class="panel"><h3>Estimates</h3><div id="calcBox"></div></div>
        <div class="panel grid" style="gap:8px">
          <button class="btn primary big" id="saveBtn">${connected ? 'Save & upload' : 'Save'}</button>
          <button class="btn" data-act="start" data-id="${esc(r.id)}" ${connected ? '' : 'disabled'}>Brew this recipe…</button>
          <div class="faint" style="font-size:12px" id="dirtyNote">${E.dirty ? 'Unsaved changes' : 'All changes saved'}</div>
        </div>
      </div></div>`;
  $$('.etabs button').forEach((b) => (b.onclick = () => { if (E.tab === 'json' && !applyJson()) return; E.tab = b.dataset.tab; renderEditor(); }));
  $('#saveBtn').onclick = saveRecipe;
  $('#delBtn').onclick = async () => {
    if (!(await confirmBox('Delete recipe?', `“${esc(r.name)}” will be removed here and from the Brewie.`, 'Delete', true))) return;
    if (await act(() => api('DELETE', `api/recipes/${encodeURIComponent(r.id)}`), 'Recipe deleted')) { S.editor = null; location.hash = '#/recipes'; }
  };
  $('#dupBtn').onclick = async () => {
    if (E.dirty && !(await confirmBox('Unsaved changes', 'Duplicate the last saved version? Your unsaved edits stay here.', 'Duplicate'))) return;
    const n = await act(() => api('POST', 'api/recipes', { cloneFrom: r.id }), 'Duplicated');
    if (n) { S.editor = null; location.hash = `#/recipe/${n.id}`; }
  };
  bindEditor(); updateCalc();
}
function markDirty() { S.editor.dirty = true; const n = $('#dirtyNote'); if (n) n.textContent = 'Unsaved changes'; }

function tabBody(tab) {
  const r = S.editor.recipe; const db = S.db || {};
  if (tab === 'overview') {
    const cur = r.style ? `${r.style.categoryNumber || ''}${r.style.styleLetter || ''}` : '';
    const styles = (db.bjcp || []).map((s, i) => `<option value="${i}" ${cur === s.code || (r.style && r.style.name === s.name) ? 'selected' : ''}>${esc(s.code)} · ${esc(s.name)}</option>`).join('');
    return `<div class="grid" style="gap:14px">
      <label class="f">Recipe name<input type="text" data-p="name" value="${esc(r.name || '')}"></label>
      <label class="f">BJCP style<select id="styleSel"><option value="">— none —</option>${styles}</select></label>
      <div id="styleBox"></div>
      <div class="frow">
        <label class="f">Cooling target (°C)${inp('coolingTemperature')}</label>
        <label class="f">Delayed hopping (min)${inp('delayedHoppingTime', { step: 1 })}</label>
      </div>
      <p class="muted" style="margin:0;font-size:13px">Batch size, efficiency, OG, FG, ABV, colour and IBU are calculated the same way the Brewie app does and saved with the recipe.</p></div>`;
  }
  if (tab === 'ferm') {
    return r.fermentables.map((bag, bi) => `<div class="group"><header><b>Brewie bag ${r.fermentables.length > 1 ? bi + 1 : ''}</b>
      ${r.fermentables.length > 1 ? `<button class="btn sm ghost" data-rm="fermentables.${bi}">Remove bag</button>` : ''}</header>
      <table class="ing"><thead><tr><th>Fermentable</th><th style="width:110px">Amount kg</th><th style="width:90px">Color °L</th><th style="width:90px">PPG</th><th></th></tr></thead><tbody>
      ${bag.map((f, i) => `<tr><td class="acwrap">${inp(`fermentables.${bi}.${i}.name`, { type: 'text', ac: 'ingredients' })}</td>
        <td>${inp(`fermentables.${bi}.${i}.amount`, { step: 0.01 })}</td><td>${inp(`fermentables.${bi}.${i}.color`)}</td><td>${inp(`fermentables.${bi}.${i}.yield`)}</td>
        <td class="x"><button class="btn sm ghost" data-rm="fermentables.${bi}.${i}" title="Remove">✕</button></td></tr>`).join('')}
      </tbody></table><button class="btn sm" data-add="ferm" data-g="${bi}" style="margin-top:8px">+ Fermentable</button></div>`).join('')
      + '<button class="btn sm ghost" data-add="bag">+ Add another bag</button>';
  }
  if (tab === 'mash') {
    const m = r.mash;
    return `<div class="frow"><label class="f">Mash-in water (L)${inp('mash.mashInWater', { step: 0.1 })}</label><label class="f">Mash-in temp (°C)${inp('mash.mashInTemperature', { step: 0.5 })}</label></div>
      ${m.mashSteps.map((round, ri) => `<div class="group" style="margin-top:14px"><header><b>${m.mashSteps.length > 1 ? `Mash round ${ri + 1}` : 'Mash steps'}</b>${m.mashSteps.length > 1 ? `<button class="btn sm ghost" data-rm="mash.mashSteps.${ri}">Remove round</button>` : ''}</header>
        <table class="ing"><thead><tr><th>#</th><th>Temperature °C</th><th>Rest (min)</th><th></th></tr></thead><tbody>
        ${round.map((s, i) => `<tr><td class="faint num">${i + 1}</td><td>${inp(`mash.mashSteps.${ri}.${i}.stepTemp`, { step: 0.5 })}</td><td>${inp(`mash.mashSteps.${ri}.${i}.stepTime`, { step: 1 })}</td>
        <td class="x"><button class="btn sm ghost" data-rm="mash.mashSteps.${ri}.${i}">✕</button></td></tr>`).join('')}</tbody></table>
        <button class="btn sm" data-add="step" data-g="${ri}" style="margin-top:8px">+ Step</button></div>`).join('')}
      <button class="btn sm ghost" data-add="round">+ Add mash round</button>
      <div class="group" style="margin-top:14px"><header><b>Sparging</b><label class="check" style="padding:6px 10px"><input type="checkbox" id="spargeOn" ${m.spargingWater ? 'checked' : ''}> Enabled</label></header>
        <div class="frow" ${m.spargingWater ? '' : 'style="opacity:.4;pointer-events:none"'}><label class="f">Water (L)${inp('mash.spargingWater', { step: 0.1 })}</label><label class="f">Temp (°C)${inp('mash.spargingTemperature', { step: 0.5 })}</label><label class="f">Time (min)${inp('mash.spargingTime', { step: 1 })}</label></div></div>`;
  }
  if (tab === 'hops') {
    return `<p class="muted" style="margin:0 0 12px;font-size:13px">The Brewie has four hop cages. Each cage is added at one time, in minutes before the end of the boil (the machine can sort cages by time). Empty cages keep their time.</p>`
      + r.hops.map((cage, ci) => {
        const t = cageTime(cage); const rows = cage.map((h, i) => [h, i]).filter(([h]) => isRealHop(h));
        return `<div class="group"><header><b>Hop cage ${ci + 1}</b><label class="f" style="flex-direction:row;align-items:center;gap:8px">Added at<input type="number" step="1" data-cagetime="${ci}" value="${esc(t ?? '')}" style="width:90px">min</label></header>
      ${rows.length ? `<table class="ing"><thead><tr><th>Hop</th><th style="width:110px">Amount g</th><th style="width:90px">Alpha %</th><th></th></tr></thead><tbody>
      ${rows.map(([h, i]) => `<tr><td class="acwrap">${inp(`hops.${ci}.${i}.name`, { type: 'text', ac: 'hops' })}</td>
        <td><input type="number" step="1" data-p="hops.${ci}.${i}.amount" data-scale="1000" value="${esc(isNum(Number(h.amount)) && h.amount !== '' && h.amount !== undefined ? r1(Number(h.amount) * 1000, 1) : '')}"></td>
        <td>${inp(`hops.${ci}.${i}.alpha`, { step: 0.1 })}</td>
        <td class="x"><button class="btn sm ghost" data-rmhop="${ci}.${i}">✕</button></td></tr>`).join('')}
      </tbody></table>` : '<div class="faint" style="font-size:13px">Empty cage</div>'}<button class="btn sm" data-add="hop" data-g="${ci}" style="margin-top:8px">+ Hop</button></div>`;
      }).join('');
  }
  if (tab === 'yeast') {
    const st = (r.fermentation && r.fermentation[0]) || { ingredients: [] }; const y = (st.ingredients || []).find((i) => String(i.category || '').toLowerCase() === 'yeast');
    return `<div class="grid" style="gap:14px"><label class="f">Yeast<div class="acwrap"><input type="text" id="yeastIn" data-ac="yeast" value="${esc(y ? y.name : '')}" placeholder="Search ${(db.yeast || []).length} yeasts…"></div></label>
      ${y ? `<div class="stats"><span class="stat">Attenuation<b>${esc(y.attenuation)}%</b></span>${y.brand ? `<span class="stat">Brand<b>${esc(y.brand)}</b></span>` : ''}${y.mintemp ? `<span class="stat">Range<b>${esc(y.mintemp)}–${esc(y.maxtemp)}°F</b></span>` : ''}</div>` : ''}
      <div class="frow"><label class="f">Fermentation temp (°C)${inp('fermentation.0.temp', { step: 0.5 })}</label><label class="f">Duration (days)${inp('fermentation.0.time', { step: 1 })}</label></div>
      <p class="muted" style="margin:0;font-size:13px">Fermentation details are informational for the Brewie; the yeast's attenuation drives the FG/ABV estimate. Other fermentation stages from the app are preserved — edit them in Raw JSON.</p></div>`;
  }
  if (tab === 'json') {
    return `<p class="muted" style="margin:0 0 10px;font-size:13px">The exact document exchanged with the Brewie. Fields this editor doesn't know about are kept untouched.</p>
      <textarea id="jsonBox" spellcheck="false">${esc(JSON.stringify(r, null, 2))}</textarea>`;
  }
  return '';
}

function applyJson() {
  const box = $('#jsonBox'); if (!box) return true;
  try { const obj = JSON.parse(box.value); obj.id = S.editor.recipe.id; normalizeRecipe(obj); S.editor.recipe = obj; return true; }
  catch (e) { toast('JSON error: ' + e.message, 'error'); return false; }
}

function bindEditor() {
  const body = $('#tabBody'); const E = S.editor;
  body.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'jsonBox') { markDirty(); return; }
    if (t.dataset.cagetime !== undefined) {
      const cage = E.recipe.hops[Number(t.dataset.cagetime)]; const v = t.value === '' ? null : Number(t.value);
      if (!cage.length) cage.push({ time: v }); else cage.forEach((h) => { h.time = v; });
      markDirty(); updateCalc(); return;
    }
    if (!t.dataset.p) return;
    let v = t.value;
    if (t.type === 'number') { v = v === '' ? null : Number(v); if (t.dataset.scale && v !== null) v = v / Number(t.dataset.scale); }
    setPath(E.recipe, t.dataset.p, v); markDirty(); updateCalc();
    if (t.dataset.p === 'name') $('h1').textContent = v || 'Untitled';
    if (t.dataset.ac) showAc(t);
  });
  body.addEventListener('focusin', (e) => { if (e.target.dataset.ac) showAc(e.target); });
  body.addEventListener('focusout', () => setTimeout(() => { if (!body.contains(document.activeElement) || !document.activeElement.dataset.ac) $$('.ac').forEach((x) => x.remove()); }, 150));
  body.addEventListener('keydown', (e) => { if (e.key === 'Escape') $$('.ac').forEach((x) => x.remove()); });
  body.addEventListener('click', (e) => {
    const rmh = e.target.closest('[data-rmhop]');
    if (rmh) { const [ci, i] = rmh.dataset.rmhop.split('.').map(Number); const cage = E.recipe.hops[ci]; const t = cageTime(cage);
      cage.splice(i, 1); if (!cage.some(isRealHop)) { cage.length = 0; cage.push({ time: t }); } markDirty(); rerenderTab(); return; }
    const rm = e.target.closest('[data-rm]'); const add = e.target.closest('[data-add]');
    if (rm) { const ks = rm.dataset.rm.split('.'); const idx = Number(ks.pop()); getPath(E.recipe, ks.join('.')).splice(idx, 1); markDirty(); rerenderTab(); }
    if (add) {
      const g = Number(add.dataset.g); const k = add.dataset.add;
      if (k === 'ferm') E.recipe.fermentables[g].push({ name: '', customName: '', amount: 0, color: 2, yield: 36 });
      if (k === 'bag') E.recipe.fermentables.push([]);
      if (k === 'step') { const prev = E.recipe.mash.mashSteps[g].slice(-1)[0]; E.recipe.mash.mashSteps[g].push({ stepTemp: prev ? Number(prev.stepTemp) + 6 : 66, stepTime: prev ? 15 : 60 }); }
      if (k === 'round') E.recipe.mash.mashSteps.push([{ stepTemp: 66, stepTime: 60 }]);
      if (k === 'hop') { const cage = E.recipe.hops[g]; const t = cageTime(cage) ?? [60, 30, 15, 5][g] ?? 15;
        for (let i = cage.length - 1; i >= 0; i--) if (!isRealHop(cage[i])) cage.splice(i, 1);
        cage.push({ name: '', amount: 0.02, alpha: 5, time: t }); }
      markDirty(); rerenderTab();
    }
  });
  const styleSel = $('#styleSel');
  if (styleSel) {
    const showStyle = () => { const s = E.recipe.style; $('#styleBox').innerHTML = s && isNum(s.ogMin) ? `<div class="stats"><span class="stat">OG<b>${s.ogMin}–${s.ogMax}</b></span><span class="stat">FG<b>${s.fgMin}–${s.fgMax}</b></span><span class="stat">ABV<b>${s.abvMin}–${s.abvMax}%</b></span><span class="stat">IBU<b>${s.ibuMin}–${s.ibuMax}</b></span><span class="stat">SRM<b>${s.colorMin}–${s.colorMax}</b></span></div>` : ''; };
    styleSel.onchange = () => { E.recipe.style = styleSel.value === '' ? null : toBrewieStyle(S.db.bjcp[Number(styleSel.value)]); if (!E.recipe.style) delete E.recipe.style; markDirty(); showStyle(); updateCalc(); };
    showStyle();
  }
  const sp = $('#spargeOn');
  if (sp) sp.onchange = () => { const m = E.recipe.mash; if (sp.checked) { m.spargingWater = m.spargingWater || 4; m.spargingTemperature = m.spargingTemperature || 76; m.spargingTime = m.spargingTime || 10; } else { delete m.spargingWater; delete m.spargingTemperature; delete m.spargingTime; } markDirty(); rerenderTab(); };
}
function rerenderTab() { $('#tabBody').innerHTML = tabBody(S.editor.tab); bindEditorStatic(); updateCalc(); }
function bindEditorStatic() { // re-bind the few direct handlers after a tab-body re-render
  const E = S.editor; const styleSel = $('#styleSel'); const sp = $('#spargeOn');
  if (sp) sp.onchange = () => { const m = E.recipe.mash; if (sp.checked) { m.spargingWater = m.spargingWater || 4; m.spargingTemperature = m.spargingTemperature || 76; m.spargingTime = m.spargingTime || 10; } else { delete m.spargingWater; delete m.spargingTemperature; delete m.spargingTime; } markDirty(); rerenderTab(); };
  if (styleSel) styleSel.onchange = () => { E.recipe.style = styleSel.value === '' ? null : toBrewieStyle(S.db.bjcp[Number(styleSel.value)]); markDirty(); };
}

/** The Brewie stores styles as {name, category, categoryNumber, styleLetter, ogMin, ogMax, ...}. */
function toBrewieStyle(b) {
  const m = String(b.code).match(/^(\d+)([A-Z]?)/) || [];
  return { name: b.name, category: b.category, categoryNumber: m[1] || String(b.code), styleLetter: m[2] || '',
    ogMin: b.oglow, ogMax: b.oghigh, fgMin: b.fglow, fgMax: b.fghigh, abvMin: b.abvlow, abvMax: b.abvhigh,
    ibuMin: b.ibulow, ibuMax: b.ibuhigh, colorMin: b.srmlow, colorMax: b.srmhigh };
}
const isRealHop = (h) => h && (h.name || (Number(h.amount) || 0) > 0);
function cageTime(cage) { const h = (cage || []).find((x) => x && x.time !== undefined && x.time !== null); return h ? h.time : null; }
function updateCalc() {
  const box = $('#calcBox'); if (!box) return;
  const c = calcRecipe(S.editor.recipe); const st = S.editor.recipe.style;
  const range = (v, lo, hi, d) => (isNum(v) && isNum(lo) ? `<div class="faint" style="font-size:11px">style ${lo}–${hi}${v < lo || v > hi ? ' <span style="color:var(--warn)">●</span>' : ''}</div>` : '');
  box.innerHTML = `<div class="swatch" style="background:${srmColor(c.srm)}"></div>
    <div class="calc">
      <div><span>OG</span><b>${isNum(c.estOG) ? c.estOG.toFixed(3) : '–'}</b>${st ? range(c.estOG, st.ogMin, st.ogMax) : ''}</div>
      <div><span>FG</span><b>${isNum(c.estFG) ? c.estFG.toFixed(3) : '–'}</b>${st ? range(c.estFG, st.fgMin, st.fgMax) : ''}</div>
      <div><span>ABV</span><b>${isNum(c.estABV) ? c.estABV.toFixed(1) + '%' : '–'}</b>${st ? range(c.estABV, st.abvMin, st.abvMax) : ''}</div>
      <div><span>IBU</span><b>${isNum(c.IBU) ? Math.round(c.IBU) : '–'}</b>${st ? range(c.IBU, st.ibuMin, st.ibuMax) : ''}</div>
      <div><span>Colour</span><b>${isNum(c.srm) ? c.srm.toFixed(1) : '–'}</b><div class="faint" style="font-size:11px">SRM</div></div>
      <div><span>Batch</span><b>${isNum(c.batchSize) ? c.batchSize.toFixed(1) : '–'}</b><div class="faint" style="font-size:11px">litres</div></div>
      <div><span>Grain</span><b>${c.kg.toFixed(2)}</b><div class="faint" style="font-size:11px">kg</div></div>
      <div><span>Efficiency</span><b>${Math.round(c.efficiency * 100)}%</b></div>
    </div>${c.warnings.length ? `<ul class="warnlist">${c.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}`;
}

function showAc(input) {
  $$('.ac').forEach((x) => x.remove());
  const kind = input.dataset.ac; const db = S.db || {}; const q = input.value.trim().toLowerCase();
  const src = kind === 'ingredients' ? db.ingredients : kind === 'hops' ? db.hops : db.yeast; if (!src) return;
  const hits = src.filter((x) => !q || x.name.toLowerCase().includes(q)).slice(0, 40);
  if (!hits.length) return;
  const box = document.createElement('div'); box.className = 'ac';
  box.innerHTML = hits.map((x, i) => `<div data-i="${src.indexOf(x)}">${esc(x.name)}<small>${kind === 'ingredients' ? `${x.lovibond}°L · ${x.ppg}` : kind === 'hops' ? `${x.avgaa}% AA` : `${x.attenuation}% · ${esc(x.brand || '')}`}</small></div>`).join('');
  box.addEventListener('mousedown', (e) => {
    const d = e.target.closest('[data-i]'); if (!d) return; e.preventDefault();
    const item = src[Number(d.dataset.i)]; const E = S.editor; const p = input.dataset.p;
    if (kind === 'ingredients') { const base = p.replace(/\.name$/, ''); setPath(E.recipe, base, { ...getPath(E.recipe, base), name: item.name, customName: item.name, color: item.lovibond, yield: item.ppg }); }
    else if (kind === 'hops') { const base = p.replace(/\.name$/, ''); setPath(E.recipe, base, { ...getPath(E.recipe, base), name: item.name, alpha: item.avgaa }); }
    else {
      if (!Array.isArray(E.recipe.fermentation) || !E.recipe.fermentation.length) E.recipe.fermentation = [{ ingredients: [] }];
      const st = E.recipe.fermentation[0]; st.ingredients = (st.ingredients || []).filter((i) => String(i.category || '').toLowerCase() !== 'yeast');
      st.ingredients.unshift({ ...item, yeastCategory: item.category, category: 'yeast' });
    }
    markDirty(); box.remove(); rerenderTab();
  });
  input.parentElement.appendChild(box);
}

async function saveRecipe() {
  const E = S.editor; if (E.tab === 'json' && !applyJson()) return;
  const r = E.recipe; const c = calcRecipe(r);
  for (const k of ['estOG', 'estFG', 'estABV', 'estColor', 'IBU', 'efficiency', 'batchSize']) if (isNum(c[k])) r[k] = Number(c[k].toFixed(k === 'estOG' || k === 'estFG' ? 4 : 2));
  const saved = await act(() => api('PUT', `api/recipes/${encodeURIComponent(r.id)}`, r), S.st && S.st.connection === 'connected' ? 'Saved and sent to the Brewie' : 'Saved — uploads on next connection');
  if (saved) { normalizeRecipe(saved); E.recipe = saved; E.dirty = false; renderEditor(); }
}

// ======================================================================= cleaning & maintenance
function renderCare(soft) {
  const st = S.st || {}; const connected = st.connection === 'connected'; const busy = !!st.brewing;
  if (soft && $('#careRoot')) { $$('#careRoot [data-need]').forEach((b) => { b.disabled = !connected || busy; }); $('#careNote').innerHTML = careNote(connected, busy); return; }
  view().innerHTML = `<div id="careRoot"><div class="head"><div><h1>Cleaning & draining</h1><p>Maintenance programs run on the machine; progress shows on the Brew tab.</p></div><div class="mobconn"></div></div>
    <div id="careNote">${careNote(connected, busy)}</div>
    ${!machine().drainConnected ? '<div class="alert err" style="margin:0 0 16px;max-width:720px"><span>⚠</span><div class="grow">Machine setup says the <b>drain hose isn\'t connected</b>. Cleaning and draining pump water out through it — connect it first.</div><a class="btn sm" href="#/settings">Machine setup</a></div>' : ''}
    <label class="check" style="max-width:520px;margin-bottom:16px"><input type="checkbox" id="cInlet" ${machine().waterInlet ? 'checked' : ''}> Use the automatic water inlet <span class="faint" style="margin-left:auto;font-size:12px">untick to pour water in by hand</span></label>
    <div class="grid g3">
      <div class="panel"><h3>Short clean</h3><p class="muted">Quick rinse after brewing.</p>
        <button class="btn primary" data-need data-clean="1">Start short clean</button></div>
      <div class="panel"><h3>Sanitizing clean</h3><p class="muted">Sanitizing cycle with a cleaning tablet. Follow the Brewie's prompts for adding the cleaning agent.</p>
        <button class="btn primary" data-need data-clean="2">Start sanitizing clean</button></div>
      <div class="panel"><h3>Full clean</h3><p class="muted">The Brewie's longest cleaning program.</p>
        <button class="btn primary" data-need data-clean="3">Start full clean</button></div>
      <div class="panel" style="grid-column:1/-1;max-width:520px"><h3>Drain</h3><p class="muted">Empty the selected tanks through the drain.</p>
        <div class="grid" style="gap:6px;margin-bottom:12px">
          <label class="check"><input type="checkbox" id="dBoil" checked> Boil tank</label>
          <label class="check"><input type="checkbox" id="dMash" checked> Mash tank</label>
          <label class="check"><input type="checkbox" id="dHop" checked> Hop tanks</label>
          <label class="check"><input type="checkbox" id="dSed"> Sedimentation (leave trub behind)</label></div>
        <button class="btn" data-need id="drainBtn">Drain now</button></div>
    </div></div>`;
  renderConn();
  $$('[data-need]').forEach((b) => { b.disabled = !connected || busy; });
  $$('[data-clean]').forEach((b) => (b.onclick = async () => {
    const name = { 1: 'short clean', 2: 'sanitizing clean', 3: 'full clean' }[b.dataset.clean];
    const inlet = $('#cInlet').checked;
    const how = inlet ? 'The Brewie will fill itself through the water inlet — make sure the tap is open and the drain hose is in place.' : 'Pour the water the Brewie asks for into the boiling tank, and make sure the drain hose is in place.';
    const drainWarn = machine().drainConnected ? '' : '<br><br><b style="color:var(--err)">Machine setup says the drain hose isn\'t connected.</b>';
    if (await confirmBox(`Start ${name}?`, how + drainWarn, 'Start')) { await act(() => api('POST', 'api/clean', { program: Number(b.dataset.clean), waterInlet: inlet }), 'Cleaning started'); location.hash = '#/'; }
  }));
  $('#drainBtn').onclick = async () => {
    const body = { boil: $('#dBoil').checked, mash: $('#dMash').checked, hop: $('#dHop').checked, sedimentation: $('#dSed').checked };
    if (await confirmBox('Drain tanks?', 'Liquid in the selected tanks will be pumped to the drain.' + (machine().drainConnected ? '' : '<br><br><b style="color:var(--err)">Machine setup says the drain hose isn\'t connected.</b>'), 'Drain', true)) act(() => api('POST', 'api/drain', body), 'Drain command sent');
  };
}
function careNote(connected, busy) {
  if (!connected) return '<div class="alert err" style="margin:0 0 16px"><span>⚠</span><div class="grow">Not connected to the Brewie.</div><a class="btn sm" href="#/settings">Settings</a></div>';
  if (busy) return '<div class="alert" style="margin:0 0 16px"><span>ℹ</span><div class="grow">A program is running. Stop it on the Brew tab before starting maintenance.</div><a class="btn sm" href="#/">Brew tab</a></div>';
  return '';
}

// ======================================================================= console
function renderConsole() {
  view().innerHTML = `<div class="head"><div><h1>Console</h1><p>Live protocol traffic and the raw machine status line.</p></div>
    <div class="btns"><button class="btn" id="qBtn">Query state (?)</button><button class="btn" id="clrBtn">Clear</button></div></div>
    <div class="grid dash"><div class="panel"><h3>Messages</h3><div class="log" id="log"></div></div>
    <div class="grid"><div class="panel"><h3>Status fields</h3><div id="fields"></div></div>
    <div class="panel"><details><summary style="cursor:pointer"><b>Send raw message</b> <span class="faint">(advanced)</span></summary>
      <p class="muted" style="font-size:13px">Sends <span class="num">{type, data}</span> as-is. Know what you're doing — this talks directly to the machine.</p>
      <div class="frow"><label class="f">Type<input type="number" id="rawType" value="200"></label></div>
      <label class="f" style="margin-top:10px">Data (JSON)<textarea id="rawData" style="min-height:80px">"?"</textarea></label>
      <button class="btn" id="rawSend" style="margin-top:10px">Send</button></details></div></div></div>`;
  S.logRendered = 0; appendLog(true); renderConsoleStatus();
  $('#qBtn').onclick = () => act(() => api('POST', 'api/brew/query'));
  $('#clrBtn').onclick = () => { S.log = []; $('#log').innerHTML = ''; S.logRendered = 0; };
  $('#rawSend').onclick = () => { let data; try { data = JSON.parse($('#rawData').value); } catch (e) { return toast('Data must be valid JSON', 'error'); } act(() => api('POST', 'api/raw', { type: Number($('#rawType').value), data }), 'Sent'); };
}
function appendLog(all) {
  const box = $('#log'); if (!box) return;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const items = all ? S.log : S.log.slice(S.logRendered || 0);
  if (all) box.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const l of items) {
    if (l.type === 201 && !S.showStatusLines) continue;
    const d = document.createElement('div'); d.className = l.dir;
    d.innerHTML = `<span class="t">${new Date(l.at).toLocaleTimeString()}</span>${l.dir === 'in' ? '⇠' : l.dir === 'out' ? '⇢' : '!'} <b>${esc(l.name)}</b>${l.type !== null && l.type !== undefined ? ` (${l.type})` : ''} ${esc(l.summary)}`;
    frag.appendChild(d);
  }
  box.appendChild(frag); S.logRendered = S.log.length;
  while (box.childNodes.length > 600) box.removeChild(box.firstChild);
  if (atBottom || all) box.scrollTop = box.scrollHeight;
}
function renderConsoleStatus() {
  const box = $('#fields'); if (!box) return; const s = S.status;
  if (!s) { box.innerHTML = '<div class="muted">No status received yet.</div>'; return; }
  const rows = [['Step index', s.step], ['Total time', fmtDur(s.totalTime)], ['Step time', fmtDur(s.stepTime)], ['Step left', fmtDur(s.leftTime)], ['Notifications', (s.alerts || []).map((a) => `${a.code}${a.text ? ' ' + a.text : ''}`).join('; ') || '—'],
    ['Mash temp', `${fmtT(s.mashTemp, 2)}${unitT()}`], ['Boil temp', `${fmtT(s.boilTemp, 2)}${unitT()}`], ['Water volume', `${s.waterVolume} L`], ['Mass sensor', s.mass], ['Heaters (mash/boil)', `${s.mashHeater ? 'on' : 'off'} / ${s.boilHeater ? 'on' : 'off'}`],
    ['Mash pump rpm / A', `${s.mashPump.tach} / ${s.mashPump.current}`], ['Boil pump rpm / A', `${s.boilPump.tach} / ${s.boilPump.current}`], ['Board temp °C', s.boardTemp], ['Flow total', s.flowTotal], ['Sensor temp', s.sensorTemp], ['MCU version', s.mcuVersion], ['Fields', s.fieldCount]];
  box.innerHTML = `<table class="fields">${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v ?? '–')}</td></tr>`).join('')}</table>
    <label class="check" style="margin-top:10px"><input type="checkbox" id="showSL" ${S.showStatusLines ? 'checked' : ''}> Show status lines in log</label>
    <pre class="raw" style="margin-top:10px">${esc((s.rawLine || '').replace(/\t/g, ' ⇥ '))}</pre>`;
  $('#showSL').onchange = (e) => { S.showStatusLines = e.target.checked; appendLog(true); };
}

// ======================================================================= settings
function renderSettings() {
  const st = S.st || {}; const set = st.settings || {};
  view().innerHTML = `<div class="head"><div><h1>Settings</h1><p>Connection and display preferences.</p></div><div class="mobconn"></div></div>
    <div class="grid g2"><div class="panel"><h3>Brewie connection</h3>
      <p class="muted" style="margin-top:0">Find the address on the Brewie under <b>Settings → WiFi</b> (tap the active, green network). Give the machine a fixed DHCP lease on your router.</p>
      <div class="frow"><label class="f">IP address / hostname<input type="text" id="sHost" value="${esc(set.host || '')}" placeholder="192.168.1.50" ${st.simulator ? 'disabled' : ''}></label>
      <label class="f">Port<input type="number" id="sPort" value="${esc(set.port || 8001)}" ${st.simulator ? 'disabled' : ''}></label></div>
      <div class="btns" style="margin-top:14px"><button class="btn primary" id="sConnect">Save & connect</button><button class="btn" id="sDisc">Disconnect</button><button class="btn" id="sFind">Find Brewies on my network</button></div>
      <div id="findOut" style="margin-top:12px"></div><div id="connStatus" style="margin-top:12px"></div></div>
    <div class="panel" style="grid-column:1/-1"><h3>Machine setup</h3>
      <p class="muted" style="margin-top:0">How your Brewie is plumbed. These set the defaults in the brew and cleaning dialogs (you can still change them each time) and decide which checklist items and warnings you see. They're stored on the server, so every device uses the same ones.</p>
      <div id="machineSetup"></div></div>
    <div class="panel" style="grid-column:1/-1"><h3>Notifications &amp; alarms</h3><div id="notifyBox"></div></div>
    <div class="panel"><h3>Display</h3>
      <label class="f">Temperature unit<select id="sUnit"><option value="C">Celsius (°C)</option><option value="F">Fahrenheit (°F)</option></select></label>
      <label class="check" style="margin-top:12px"><input type="checkbox" id="sVerbose" ${S.prefs.verbose ? 'checked' : ''}> Verbose: describe what the Brewie is doing in words</label>
      <p class="muted" style="font-size:13px">Recipes are stored in the Brewie's native units (°C, kg, L); this only changes the live display.</p>
      <h3 style="margin-top:20px">About</h3><p class="num faint" style="font-size:12px;margin:0 0 6px">Brewie Web v${esc((S.st && S.st.version) || '')}</p><p class="muted" style="font-size:13px;margin:0">Brewie Web talks to the machine with the same protocol as the official Brewie Control app (TCP ${esc(set.port || 8001)}). Use one controller at a time if you notice conflicts.</p></div></div>`;
  $('#sUnit').value = S.prefs.unit;
  $('#sUnit').onchange = (e) => { S.prefs.unit = e.target.value; savePrefs(); toast('Saved', 'ok'); };
  $('#sVerbose').onchange = (e) => { S.prefs.verbose = e.target.checked; savePrefs(); toast('Saved', 'ok'); };
  $('#sConnect').onclick = () => act(() => api('POST', 'api/connect', { host: $('#sHost').value.trim(), port: Number($('#sPort').value) || 8001 }), 'Connecting…');
  $('#sDisc').onclick = () => act(() => api('POST', 'api/disconnect'), 'Disconnected');
  $('#sFind').onclick = async () => {
    $('#findOut').innerHTML = '<span class="muted">Scanning your network for Brewies… (takes ~20 s)</span>';
    const r = await act(() => api('POST', 'api/discover'));
    if (!r) { $('#findOut').innerHTML = ''; return; }
    $('#findOut').innerHTML = r.hosts.length ? r.hosts.map((h) => `<button class="btn sm" data-host="${esc(h)}">Use ${esc(h)}</button>`).join(' ') : '<span class="muted">No Brewie answered. On Docker, discovery only works with host or macvlan networking — enter the IP manually.</span>';
    $$('[data-host]').forEach((b) => (b.onclick = () => { $('#sHost').value = b.dataset.host; $('#sConnect').click(); }));
  };
  renderConn(); renderSettingsStatus(); renderMachineSetup(); renderNotify();
}
function renderNotify() {
  const box = $('#notifyBox'); if (!box) return;
  const n = (S.st && S.st.settings && S.st.settings.notify) || { events: {} }; const ev = n.events || {};
  const evs = [['alerts', 'Errors (Brewie paused on an E-code) and emergency stop'], ['drainStall', 'Drain looks stuck'], ['waiting', 'Brewie is waiting for you (add grain, hops…)'], ['finished', 'Program finished'], ['connectionLost', 'Connection lost during a program']];
  const configured = !!(n.ntfyUrl || n.pushoverUser || n.webhookUrl);
  box.innerHTML = `<div class="grid g2" style="gap:10px;margin-bottom:16px">
      <label class="check"><input type="checkbox" id="nAlarms" ${n.alarms !== false ? 'checked' : ''}> <b>Alarm banners on screen</b> <span class="faint" style="margin-left:auto;font-size:12px">all devices</span></label>
      <label class="check"><input type="checkbox" id="nPush" ${n.push !== false ? 'checked' : ''}> <b>Phone notifications</b> <span class="faint" style="margin-left:auto;font-size:12px">${configured ? 'set up' : 'not set up yet'}</span></label>
    </div>
    <div class="grid g2" style="gap:16px;align-items:start">
    <div class="grid" style="gap:10px">
      <p class="muted" style="margin:0;font-size:13px">Sent by the server, so they arrive even with no browser open. Easiest: install the free <b>ntfy</b> app on your phone, subscribe to a private topic, and paste its URL here.</p>
      <label class="f">ntfy topic URL<div style="display:flex;gap:6px"><input type="text" id="nUrl" placeholder="https://ntfy.sh/brewie-…" value="${esc(n.ntfyUrl || '')}"><button class="btn sm" id="nGen" title="Make a hard-to-guess topic">Generate</button></div></label>
      <label class="f">ntfy access token <span class="faint" style="text-transform:none;letter-spacing:0">(only for protected servers)</span><input type="text" id="nTok" value="${esc(n.ntfyToken || '')}"></label>
      <div class="frow"><label class="f">Pushover app token<input type="text" id="pTok" value="${esc(n.pushoverToken || '')}"></label><label class="f">Pushover user key<input type="text" id="pUsr" value="${esc(n.pushoverUser || '')}"></label></div>
      <label class="f">Webhook URL <span class="faint" style="text-transform:none;letter-spacing:0">(e.g. a Home Assistant webhook — receives JSON)</span><input type="text" id="wUrl" placeholder="http://homeassistant:8123/api/webhook/brewie" value="${esc(n.webhookUrl || '')}"></label>
    </div>
    <div class="grid" style="gap:8px">
      <div class="lampgrp" style="margin:0">Alert me about <span class="faint" style="text-transform:none;letter-spacing:0">(banners and phone)</span></div>
      ${evs.map(([k, t]) => `<label class="check"><input type="checkbox" data-ev="${k}" ${ev[k] !== false ? 'checked' : ''}> ${esc(t)}</label>`).join('')}
      <div class="lampgrp">This device</div>
      <label class="check"><input type="checkbox" id="ban" ${S.prefs.banner !== false ? 'checked' : ''}> Show alarm banners on this device</label>
      <label class="check"><input type="checkbox" id="snd" ${S.prefs.sound !== false ? 'checked' : ''}> Alarm sound on this device</label>
      <div class="btns"><button class="btn primary" id="nSave">Save</button><button class="btn" id="nTest">Send test</button></div>
      <div id="nOut" class="muted" style="font-size:13px"></div>
    </div></div>`;
  $('#nGen').onclick = (e) => { e.preventDefault(); const r = Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 14); $('#nUrl').value = `https://ntfy.sh/brewie-${r}`; };
  $('#snd').onchange = (e) => { S.prefs.sound = e.target.checked; savePrefs(); if (e.target.checked) Alarm.unlock(); else Alarm.silence(); toast('Saved', 'ok'); };
  $('#ban').onchange = (e) => { S.prefs.banner = e.target.checked; savePrefs(); if (!e.target.checked) Alarm.silence(); toast('Saved', 'ok'); };
  const quick = async (body) => { const r = await act(() => api('POST', 'api/settings/notify', body), 'Saved'); if (r && S.st) S.st.settings = r; if (body.alarms === false) Alarm.silence(); };
  $('#nAlarms').onchange = (e) => quick({ alarms: e.target.checked });
  $('#nPush').onchange = (e) => quick({ push: e.target.checked });
  const save = async () => {
    const events = {}; $$('[data-ev]', box).forEach((c) => { events[c.dataset.ev] = c.checked; });
    const r = await act(() => api('POST', 'api/settings/notify', { ntfyUrl: $('#nUrl').value, ntfyToken: $('#nTok').value, pushoverToken: $('#pTok').value, pushoverUser: $('#pUsr').value, webhookUrl: $('#wUrl').value, events, alarms: $('#nAlarms').checked, push: $('#nPush').checked }), 'Saved');
    if (r && S.st) S.st.settings = r; return r;
  };
  $('#nSave').onclick = save;
  $('#nTest').onclick = async () => {
    Alarm.unlock(); if (!(await save())) return;
    const r = await act(() => api('POST', 'api/notify/test'));
    if (r) $('#nOut').innerHTML = r.note ? esc(r.note) : r.results.map((x) => `${esc(x.channel)}: ${x.ok ? '<span style="color:var(--ok)">sent ✓</span>' : `<span style="color:var(--err)">failed — ${esc(x.error)}</span>`}`).join('<br>');
  };
}
function renderMachineSetup() {
  const box = $('#machineSetup'); if (!box) return; const M = machine();
  box.innerHTML = `<div class="grid g2" style="gap:10px">
      <label class="check"><input type="checkbox" data-m="waterInlet" ${M.waterInlet ? 'checked' : ''}> Water inlet hose connected <span class="faint" style="margin-left:auto;font-size:12px">auto-fill</span></label>
      <label class="check"><input type="checkbox" data-m="drainConnected" ${M.drainConnected ? 'checked' : ''}> Drain / outlet hose connected</label>
      <label class="check"><input type="checkbox" data-m="cooling" ${M.cooling ? 'checked' : ''}> Automatic cooling after the boil</label>
      <label class="check" style="gap:12px">Cooling with
        <select data-m="coolingSource" style="width:auto;margin-left:auto" ${M.cooling ? '' : 'disabled'}><option value="inlet" ${M.coolingSource === 'inlet' ? 'selected' : ''}>tap water (inlet)</option><option value="external" ${M.coolingSource === 'external' ? 'selected' : ''}>external chiller</option></select></label>
      <label class="check"><input type="checkbox" data-m="checklist" ${M.checklist ? 'checked' : ''}> Show the checklist before brewing</label>
      <label class="check" style="gap:12px">Water-level sensor is in the
        <select data-m="levelSensor" style="width:auto;margin-left:auto"><option value="mash" ${M.levelSensor !== 'boil' ? 'selected' : ''}>mash tank</option><option value="boil" ${M.levelSensor === 'boil' ? 'selected' : ''}>boil tank</option></select></label>
    </div>
    <details style="margin-top:14px"><summary class="muted" style="cursor:pointer">Settings that live on the Brewie itself</summary>
      <p class="muted" style="font-size:13px">Pump speeds, draining the hop cages, sorting hop cages by time, whirlpool heating, units and the Brewie's own water settings are changed on the touchscreen under <b>Settings</b>. The network connection can't read or change them, so keep the boxes above matching what the Brewie is set to.</p></details>`;
  $$('[data-m]', box).forEach((el) => (el.onchange = async () => {
    const k = el.dataset.m; const v = el.type === 'checkbox' ? el.checked : el.value;
    const r = await act(() => api('POST', 'api/settings/machine', { [k]: v }), 'Saved');
    if (r && S.st) { S.st.settings = r; renderMachineSetup(); }
  }));
}
function renderSettingsStatus() {
  const box = $('#connStatus'); if (!box) return; const st = S.st || {};
  box.innerHTML = `<table class="fields"><tr><td>State</td><td>${esc(st.connection)}</td></tr><tr><td>Connected since</td><td>${st.connectedAt && st.connection === 'connected' ? new Date(st.connectedAt).toLocaleTimeString() : '–'}</td></tr>
    <tr><td>Last data</td><td>${esc(ago(st.lastSeen))}</td></tr><tr><td>Recipes received / sent</td><td>${esc(st.sync ? `${st.sync.received} / ${st.sync.sent}` : '–')}</td></tr>
    ${st.lastError ? `<tr><td>Last error</td><td style="color:var(--err)">${esc(st.lastError)}</td></tr>` : ''}</table>`;
}

// ======================================================================= boot
(async function boot() {
  try {
    const st = await api('GET', 'api/state');
    S.st = st; S.recipes = st.recipes || []; S.status = st.status;
    (st.notices || []).forEach(() => {});
    S.history = (await api('GET', 'api/history')) || [];
    S.log = (await api('GET', 'api/log')) || [];
    S.activity = (await api('GET', 'api/activity')) || [];
  } catch (e) { toast('Could not reach the Brewie Web server', 'error'); }
  fetch('datas.json').then((r) => r.json()).then((d) => { S.db = d; if (S.view === 'editor' && S.editor) renderEditor(); if (S.view === 'recipes') renderRecipes(); }).catch(() => {});
  window.addEventListener('hashchange', route);
  window.addEventListener('beforeunload', (e) => { if (S.editor && S.editor.dirty) { e.preventDefault(); e.returnValue = ''; } });
  route(); connectEvents();
  setInterval(() => { if (S.view === 'dash') setK('seen', S.status ? `Last update ${ago(S.status.at)}${S.status.mcuVersion ? ` · MCU v${esc(S.status.mcuVersion)}` : ''}` : ''); }, 5000);
})();
