/* In-browser alarm: repeating tone + banner until silenced. Audio must be unlocked by a tap (iOS rule). */
'use strict';
const Alarm = {
  ctx: null, timer: null, active: null,
  unlock() {
    try {
      if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (this.ctx.state === 'suspended') this.ctx.resume();
      // play a silent blip so iOS considers audio unlocked
      const o = this.ctx.createOscillator(); const g = this.ctx.createGain(); g.gain.value = 0.0001; o.connect(g); g.connect(this.ctx.destination); o.start(); o.stop(this.ctx.currentTime + 0.02);
    } catch (_) {}
  },
  get ready() { return !!(this.ctx && this.ctx.state === 'running'); },
  tone(level) {
    if (!this.ready) return;
    const seq = level === 'error' ? [[880, 0], [660, 0.22], [880, 0.44], [660, 0.66]] : level === 'warn' ? [[740, 0], [988, 0.25]] : [[660, 0], [880, 0.18]];
    for (const [f, t] of seq) {
      const o = this.ctx.createOscillator(); const g = this.ctx.createGain(); const t0 = this.ctx.currentTime + t;
      o.type = 'square'; o.frequency.value = f; g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
      o.connect(g); g.connect(this.ctx.destination); o.start(t0); o.stop(t0 + 0.22);
    }
  },
  raise(a) {
    this.active = a; this.render();
    if (S.prefs.sound === false) return;
    this.tone(a.level); clearInterval(this.timer);
    if (a.level !== 'info') this.timer = setInterval(() => this.tone(a.level), a.level === 'error' ? 3000 : 8000);
    else setTimeout(() => { if (this.active === a) this.silence(); }, 15000);
  },
  silence() { clearInterval(this.timer); this.timer = null; this.active = null; this.render(); },
  render() {
    let el = document.getElementById('alarmBar');
    if (!this.active) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('div'); el.id = 'alarmBar'; document.body.appendChild(el); }
    const a = this.active;
    el.className = `alarmbar ${a.level}`;
    el.innerHTML = `<span class="ab-ic">${a.level === 'error' ? '⚠' : a.level === 'warn' ? '✋' : '✓'}</span><div class="grow"><b>${esc(a.title)}</b><div>${esc(a.message)}</div>
      ${S.prefs.sound !== false && !this.ready ? '<div class="ab-note">Tap anywhere to enable alarm sound on this device</div>' : ''}</div>
      <button class="btn" id="abGo">Advanced</button><button class="btn primary" id="abOk">${a.level === 'info' ? 'OK' : 'Silence'}</button>`;
    el.querySelector('#abOk').onclick = () => this.silence();
    el.querySelector('#abGo').onclick = () => { this.silence(); location.hash = '#/advanced'; };
  },
};
// any tap unlocks audio (iOS/Safari requirement)
['pointerdown', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, () => { if (!Alarm.ready) { Alarm.unlock(); if (Alarm.active) Alarm.render(); } }, { passive: true }));
