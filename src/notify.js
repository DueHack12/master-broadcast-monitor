import { atLeast } from './levels.js';

/**
 * Phone alerts. Three channels, each with its own minimum level:
 *
 *   pushcut  POST to a Pushcut notification webhook (iPhone). Easiest: copy the
 *            URL from Pushcut → Notifications → <yours> → Webhook.
 *   twilio   SMS through Twilio's REST API.
 *   webhook  POST JSON anywhere — ntfy, Home Assistant, Slack, Discord, n8n…
 *
 * Rules:
 *   - an issue must last `persistSec` before anyone is woken up (no flapping);
 *   - each issue is sent once per occurrence, re-sent every `repeatAfterMin`
 *     while it lasts (0 = never), and a quick clear-and-return within
 *     `cooldownSec` is not re-sent — unless an "all clear" went out in between;
 *   - once everything at the channel's level has been clear for `persistSec`,
 *     an "all clear" goes out (`recovery: true`);
 *   - with `onlyWhenOnAir`, nothing is sent while not streaming / not live.
 */

const CHANNELS = ['pushcut', 'twilio', 'webhook'];
const ICON = { crit: '🔴', warn: '🟡', info: 'ℹ️', ok: '✅' };

export class Notifier {
  constructor(app) {
    this.app = app;
    this.track = {};
    this.configure(app.cfg);
  }

  configure(cfg) {
    this.cfg = cfg.notify;
    this.publicUrl = cfg.publicUrl || '';
    this.station = cfg.stationName || 'Broadcast Monitor';
  }

  enabledChannels() { return CHANNELS.filter((n) => this.cfg[n]?.enabled); }

  tick(issues, onAir, now = Date.now()) {
    const n = this.cfg;
    for (const name of this.enabledChannels()) {
      const ch = n[name];
      const min = ch.minLevel || 'warn';
      const t = this.track[name] ||= { sent: new Map(), outstanding: false, clearSince: null, lastRecoveryAt: 0 };
      const atLevel = issues.filter((i) => atLeast(i.level, min));
      const due = [];

      if (!(n.onlyWhenOnAir && !onAir)) {
        for (const i of atLevel) {
          if (now - i.since < n.persistSec * 1000) continue;
          const rec = t.sent.get(i.id);
          if (!rec || rec.episode !== i.since) {
            const flapping = rec && now - rec.lastSentAt < n.cooldownSec * 1000 && rec.lastSentAt > t.lastRecoveryAt;
            t.sent.set(i.id, { lastSentAt: flapping ? rec.lastSentAt : now, episode: i.since });
            if (!flapping) due.push(i);
          } else if (n.repeatAfterMin > 0 && now - rec.lastSentAt >= n.repeatAfterMin * 60000) {
            rec.lastSentAt = now;
            due.push({ ...i, reminder: true });
          }
        }
      }
      if (due.length) {
        t.outstanding = true;
        t.clearSince = null;
        this.send(name, ch, compose(due, atLevel, this.station));
      }

      if (atLevel.length) t.clearSince = null;
      else if (t.outstanding) {
        t.clearSince ??= now;
        if (now - t.clearSince >= n.persistSec * 1000) {
          t.outstanding = false;
          t.lastRecoveryAt = now;
          if (n.recovery) this.send(name, ch, { level: 'ok', title: `${ICON.ok} All clear`, text: `${this.station}: everything is back to normal.`, issues: [] });
        }
      }
    }
  }

  async send(name, ch, msg) {
    try {
      await SENDERS[name](ch, msg, this);
      this.app.log.add('info', `Sent ${name} alert: ${msg.title}`, 'notify');
      return { channel: name, ok: true };
    } catch (e) {
      this.app.log.add('warn', `${name} alert failed: ${e.message}`, 'notify');
      return { channel: name, ok: false, error: e.message };
    }
  }

  async test() {
    const names = this.enabledChannels();
    if (!names.length) return { results: [], message: 'No notification channels are enabled in config.json → notify.' };
    const msg = { level: 'warn', title: `${ICON.warn} Test alert`, text: `${this.station}: this is a test from the broadcast monitor.`, issues: [], test: true };
    const results = await Promise.all(names.map((n) => this.send(n, this.cfg[n], msg)));
    return { results };
  }
}

export function compose(due, active, station) {
  const top = due[0];
  const lead = top.reminder ? 'Still: ' : '';
  const title = `${ICON[top.level] || ''} ${lead}${top.title}`.trim();
  let text;
  if (due.length === 1) text = top.detail || '';
  else text = due.map((i) => `${ICON[i.level] || ''} ${i.title}`).join('\n');
  const others = active.filter((a) => !due.some((d) => d.id === a.id));
  if (others.length) text += `\n(+${others.length} other active issue${others.length === 1 ? '' : 's'})`;
  return { level: top.level, title, text: text.trim(), issues: due, station };
}

async function post(url, init, label) {
  const res = await fetch(url, { ...init, method: 'POST', signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${label} HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  return res;
}

const SENDERS = {
  async pushcut(ch, msg, n) {
    if (!ch.url) throw new Error('notify.pushcut.url is empty');
    const body = {
      title: msg.title,
      text: msg.text || ' ',
      isTimeSensitive: atLeast(msg.level, ch.timeSensitiveLevel || 'crit'),
      threadId: 'broadcast-monitor'
    };
    if (n.publicUrl) body.defaultAction = { url: n.publicUrl };
    if (ch.sound) body.sound = ch.sound;
    await post(ch.url, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 'Pushcut');
  },

  async twilio(ch, msg) {
    const to = [].concat(ch.to || []).filter(Boolean);
    if (!ch.accountSid || !ch.authToken || !ch.from || !to.length) throw new Error('notify.twilio needs accountSid, authToken, from and to');
    const base = ch.apiBase || 'https://api.twilio.com';
    const auth = Buffer.from(`${ch.accountSid}:${ch.authToken}`).toString('base64');
    const text = `${msg.title}\n${msg.text}`.slice(0, 600);
    for (const num of to) {
      const form = { To: num, Body: text };
      if (/^MG/.test(ch.from)) form.MessagingServiceSid = ch.from; else form.From = ch.from;
      await post(`${base}/2010-04-01/Accounts/${encodeURIComponent(ch.accountSid)}/Messages.json`, {
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form)
      }, 'Twilio');
    }
  },

  async webhook(ch, msg, n) {
    if (!ch.url) throw new Error('notify.webhook.url is empty');
    const payload = {
      // "text" makes it work as-is with Slack/Mattermost/Discord-compatible incoming webhooks.
      text: `${msg.title}\n${msg.text}`,
      title: msg.title, message: msg.text, level: msg.level,
      station: n.station, url: n.publicUrl || null, time: new Date().toISOString(),
      issues: (msg.issues || []).map(({ id, level, title, detail }) => ({ id, level, title, detail }))
    };
    await post(ch.url, { headers: { 'Content-Type': 'application/json', ...(ch.headers || {}) }, body: JSON.stringify(payload) }, 'Webhook');
  }
};
