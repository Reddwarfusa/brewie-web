'use strict';
/**
 * Push notifications for important Brewie events, sent from the server so they arrive even when no
 * browser is open. Channels: ntfy (https://ntfy.sh or self-hosted), Pushover, generic JSON webhook
 * (e.g. Home Assistant). Uses Node's built-in fetch.
 */
const DEFAULTS = {
  ntfyUrl: '', ntfyToken: '', pushoverToken: '', pushoverUser: '', webhookUrl: '',
  alarms: true, // on-screen alarm banners (all devices)
  push: true, // phone / webhook notifications (only once a channel is set up)
  events: { alerts: true, drainStall: true, waiting: true, finished: true, connectionLost: true },
};

class Notifier {
  constructor(getSettings, log = console.log) { this.getSettings = getSettings; this.log = log; this.recent = new Map(); }
  cfg() { const c = this.getSettings() || {}; return { ...DEFAULTS, ...c, events: { ...DEFAULTS.events, ...(c.events || {}) } }; }
  configured() { const c = this.cfg(); return !!(c.ntfyUrl || (c.pushoverToken && c.pushoverUser) || c.webhookUrl); }

  /** event: alerts|drainStall|waiting|finished|connectionLost|test; level: error|warn|info */
  async send(event, title, message, level = 'error', { force = false } = {}) {
    const c = this.cfg();
    if (!force && event !== 'test' && (!c.push || !c.events[event])) return { skipped: 'disabled' };
    const key = `${event}:${message}`; const now = Date.now();
    if (!force && this.recent.has(key) && now - this.recent.get(key) < 120000) return { skipped: 'duplicate' };
    this.recent.set(key, now);
    const results = [];
    const prio = level === 'error' ? 5 : level === 'warn' ? 4 : 3;
    if (c.ntfyUrl) {
      results.push(this.post('ntfy', c.ntfyUrl, message, {
        Title: title, Priority: String(prio), Tags: level === 'error' ? 'rotating_light,beer' : level === 'warn' ? 'warning,beer' : 'beer',
        ...(c.ntfyToken ? { Authorization: `Bearer ${c.ntfyToken}` } : {}),
      }));
    }
    if (c.pushoverToken && c.pushoverUser) {
      const body = new URLSearchParams({ token: c.pushoverToken, user: c.pushoverUser, title, message, priority: level === 'error' ? '1' : '0', sound: level === 'error' ? 'siren' : 'pushover' });
      results.push(this.post('pushover', 'https://api.pushover.net/1/messages.json', body, { 'Content-Type': 'application/x-www-form-urlencoded' }));
    }
    if (c.webhookUrl) {
      results.push(this.post('webhook', c.webhookUrl, JSON.stringify({ source: 'brewie-web', event, level, title, message, at: new Date().toISOString() }), { 'Content-Type': 'application/json' }));
    }
    return Promise.all(results);
  }

  async post(channel, url, body, headers) {
    try {
      const res = await fetch(url, { method: 'POST', body, headers, signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { channel, ok: true };
    } catch (e) {
      this.log(`[notify] ${channel} failed: ${e.message}`);
      return { channel, ok: false, error: e.message };
    }
  }
}

/**
 * Wire a BrewieClient's events to notifications + an in-browser alarm callback.
 * Event mapping comes from the client's activity log (see client.addActivity).
 */
function attach(client, notifier, onAlarm) {
  const fire = (event, title, message, level) => {
    const c = notifier.cfg();
    if (!c.events[event]) return; // this kind of alert is switched off
    if (c.alarms) onAlarm({ event, title, message, level, at: Date.now() });
    if (notifier.configured()) notifier.send(event, title, message, level).catch(() => {});
  };
  // The Brewie flags P103 for a moment at many step changes (e.g. during cleaning) while it takes the
  // next step command. Only treat it as "needs you" if it's still waiting after a few seconds.
  const WAIT_CONFIRM_MS = Number(process.env.WAIT_CONFIRM_MS || 8000);
  let waitTimer = null;
  client.on('activity', (e) => {
    const prog = client.brewing ? (client.brewing.type === 0 ? client.brewing.recipeName : null) : null;
    const where = prog ? ` (${prog})` : '';
    if (e.kind === 'alert' && /^E\d/.test(e.text)) fire('alerts', 'Brewie error', `${e.text}${where} — the Brewie has paused.`, 'error');
    else if (e.kind === 'alert' && /isn't draining/.test(e.text)) fire('drainStall', 'Brewie: drain stuck', e.text, 'error');
    else if (e.kind === 'alert' && /EMERGENCY STOP/.test(e.text)) fire('alerts', 'Brewie: emergency stop', `Emergency stop pressed${where}.`, 'warn');
    else if (e.kind === 'on' && /^Waiting for you/.test(e.text)) {
      clearTimeout(waitTimer);
      waitTimer = setTimeout(() => {
        waitTimer = null;
        const st = client.summaryStatus(); const step = st && st.currentStep;
        if (!st || !st.lamps || !st.lamps.waiting) return;
        fire('waiting', 'Brewie needs you', `Waiting for you${step ? ` — ${step.label}` : ''}${where}. Do the step, then press Continue.`, 'warn');
      }, WAIT_CONFIRM_MS);
    } else if (e.kind === 'off' && /^Waiting for you/.test(e.text)) { clearTimeout(waitTimer); waitTimer = null; } else if (e.kind === 'info' && e.text === 'Program ended') fire('finished', 'Brewie finished', `The program has ended${where}.`, 'info');
  });
  let wasConnected = false;
  client.on('state', () => {
    const c = client.connection === 'connected';
    if (wasConnected && !c && client.brewing) fire('connectionLost', 'Brewie connection lost', `Lost the connection to the Brewie while a program was running${client.lastError ? ` (${client.lastError})` : ''}. The Brewie keeps running on its own.`, 'warn');
    wasConnected = c;
  });
}

module.exports = { Notifier, attach, DEFAULTS };
