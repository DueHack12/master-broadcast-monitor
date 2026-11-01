import { Monitor } from './base.js';
import { MqttClient } from '../lib/mqtt.js';
import { ping, tcpCheck } from '../lib/ping.js';
import { detectSport, sportName, SPORTS } from '../lib/sports.js';
import { fmtAgo } from '../levels.js';

/**
 * Sportzcast ScoreConnect III, watched directly — independent of
 * OpenStatsEngine, so it works whether or not OSE is running.
 *
 *   1. Ping the ScoreConnect computer (configurable host; localhost is fine).
 *   2. Subscribe to its MQTT broker (bot/0/json) like OSE does.
 *   3. Check messages keep arriving.
 *   4. Check the board's sport matches today's sport.
 *
 * Today's sport is chosen on the dashboard. "Auto" follows OSE's active game
 * when OSE is running; "Not in use" silences every scorebot alert.
 */
export default class ScorebotMonitor extends Monitor {
  static id = 'scorebot';
  static title = 'Scorebot';

  start() {
    const c = this.cfg;
    this.state = {
      ping: { ok: null, rttMs: null, failures: 0, lastOkAt: null, error: null, unavailable: false, method: 'icmp' },
      mqtt: { connected: false, error: null, since: null },
      messages: 0, lastMessageAt: null, raw: null, rate: 0,
      sport: null, startedAt: Date.now()
    };
    this.arrivals = [];
    this.client = new MqttClient({
      host: c.host, port: c.mqtt.port, topic: c.mqtt.topic,
      username: c.mqtt.username, password: c.mqtt.password, tls: !!c.mqtt.tls,
      onStatus: (s) => this.onMqttStatus(s),
      onMessage: (topic, payload) => this.onMessage(topic, payload)
    }).connect();
    if (c.ping.enabled) this.loop(() => this.doPing(), c.ping.intervalSec * 1000);
  }

  stop() { this.client?.end(); this.clearTimers(); }

  onMqttStatus(s) {
    const was = this.state.mqtt.connected;
    this.state.mqtt = { connected: !!s.connected, error: s.error || null, since: s.connected ? Date.now() : this.state.mqtt.since };
    if (was !== !!s.connected) {
      this.app.log.add(s.connected ? 'info' : 'warn',
        s.connected ? `Scorebot MQTT connected (${this.cfg.host}:${this.cfg.mqtt.port}, ${s.topic})` : `Scorebot MQTT disconnected: ${s.error || 'closed'}`, this.id);
    }
    this.app.changed();
  }

  onMessage(topic, payload) {
    let raw;
    try { raw = JSON.parse(payload); } catch { return; } // sbdata or junk on a wildcard topic
    if (!raw || typeof raw !== 'object') return;
    const now = Date.now();
    const s = this.state;
    const wasSilent = s.lastMessageAt && now - s.lastMessageAt > this.cfg.silentAfterSec * 1000;
    s.messages++;
    s.lastMessageAt = now;
    s.raw = raw;
    s.sport = detectSport(raw, this.vendorMap());
    this.arrivals.push(now);
    while (this.arrivals.length && this.arrivals[0] < now - 10000) this.arrivals.shift();
    s.rate = this.arrivals.length / 10;
    if (wasSilent) this.app.log.add('info', 'Scorebot data is flowing again', this.id);
    this.app.changed();
  }

  vendorMap() { return { ...(this.cfg.vendorSportIds || {}), ...(this.app.settings.get('vendorSportIds') || {}) }; }

  async doPing() {
    const c = this.cfg;
    const p = this.state.ping;
    let r = await ping(c.host, c.ping.timeoutMs);
    // No ping command on this machine: fall back to "is the MQTT port open".
    if (r.unavailable) { r = await tcpCheck(c.host, c.mqtt.port, c.ping.timeoutMs); p.method = 'tcp'; p.unavailable = true; }
    const wasDown = p.failures >= c.ping.failuresBeforeDown;
    if (r.ok) {
      if (wasDown) this.app.log.add('info', `ScoreConnect computer ${c.host} is answering again`, this.id);
      Object.assign(p, { ok: true, rttMs: r.rttMs, failures: 0, lastOkAt: Date.now(), error: null });
    } else {
      p.failures++;
      Object.assign(p, { ok: false, rttMs: null, error: r.error || 'no reply' });
      if (!wasDown && p.failures >= c.ping.failuresBeforeDown) this.app.log.add('warn', `ScoreConnect computer ${c.host} is not answering ping`, this.id);
    }
    this.app.changed();
  }

  /** Today's sport: { mode, sport, source } */
  expected(ctx) {
    const mode = ctx.settings.get('expectedSport') || 'auto';
    if (mode === 'none') return { mode, sport: null, source: 'not in use' };
    if (mode !== 'auto') return { mode, sport: mode, source: 'set here' };
    const ose = ctx.monitors.ose?.state;
    if (ose?.reachable && ose.game?.sportId) return { mode, sport: ose.game.sportId, source: 'from OSE' };
    return { mode, sport: null, source: 'auto — no OSE game' };
  }

  silentMs(now) {
    const s = this.state;
    if (!s.mqtt.connected) return null;
    return now - (s.lastMessageAt ?? s.mqtt.since ?? now);
  }

  hostDown() { return this.cfg.ping.enabled && this.state.ping.failures >= this.cfg.ping.failuresBeforeDown; }

  /** True if this monitor's own feed is healthy — OSE uses it to pin blame correctly. */
  healthy(now) {
    const q = this.silentMs(now);
    return this.state.mqtt.connected && q != null && (this.cfg.silentAfterSec <= 0 || q <= this.cfg.silentAfterSec * 1000);
  }

  issues(ctx) {
    const exp = this.expected(ctx);
    if (exp.mode === 'none') return [];
    const c = this.cfg, s = this.state;
    const where = `${c.host}`;
    const out = [];
    if (this.hostDown()) {
      out.push({
        id: 'scorebot.host_down', level: 'warn', title: `ScoreConnect computer (${where}) is offline`,
        detail: s.ping.method === 'tcp'
          ? `Nothing answering on ${where}:${c.mqtt.port} (no ping command on this machine, so the MQTT port was checked).`
          : `${where} has not answered ${s.ping.failures} pings.`
      });
    } else if (!s.mqtt.connected && ctx.now - s.startedAt > 6000) {
      out.push({
        id: 'scorebot.mqtt_down', level: 'warn', title: "Can't reach the Scorebot feed",
        detail: `MQTT ${where}:${c.mqtt.port}: ${s.mqtt.error || 'not connected'}. Is ScoreConnect running?`
      });
    }
    const quiet = this.silentMs(ctx.now);
    if (c.silentAfterSec > 0 && quiet != null && quiet > c.silentAfterSec * 1000) {
      out.push({
        id: 'scorebot.silent', level: 'warn', title: 'Scorebot has stopped sending data',
        detail: s.lastMessageAt
          ? `Connected, but nothing on ${c.mqtt.topic} for ${fmtAgo(quiet)}. Check the ScoreLink / scoreboard controller.`
          : `Connected, but no messages on ${c.mqtt.topic} yet. Check the topic and the ScoreLink.`
      });
    }
    if (exp.sport && s.sport?.sport && s.sport.method === 'id' && s.sport.sport !== exp.sport) {
      out.push({
        id: 'scorebot.wrong_sport', level: 'warn',
        title: `Scorebot is on ${sportName(s.sport.sport)}, not ${sportName(exp.sport)}`,
        detail: `ScoreConnect reports sport ID ${s.sport.vendorId} (${sportName(s.sport.sport)}). Today's sport is ${sportName(exp.sport)} (${exp.source}).`
      });
    }
    return out;
  }

  view(ctx) {
    const c = this.cfg, s = this.state;
    const exp = this.expected(ctx);
    const inUse = exp.mode !== 'none';
    const quiet = this.silentMs(ctx.now);
    const silent = c.silentAfterSec > 0 && quiet != null && quiet > c.silentAfterSec * 1000;
    const sp = s.sport;
    const mismatch = exp.sport && sp?.sport && sp.sport !== exp.sport;

    let sportValue = '—', sportLevel;
    if (sp?.sport) {
      sportValue = `${sportName(sp.sport)}${sp.method === 'guess' ? ' (guessed from fields)' : ''}${sp.vendorId ? ` · ID ${sp.vendorId}` : ''}`;
      sportLevel = mismatch ? (sp.method === 'id' ? 'warn' : 'info') : (exp.sport ? 'ok' : undefined);
    } else if (sp?.vendorId) {
      sportValue = `Unknown — sport ID ${sp.vendorId}`;
      if (sp.candidates?.length) sportValue += ` (looks like ${sp.candidates.map(sportName).join(' / ')})`;
    } else if (sp) sportValue = 'Not reported';

    const pingRow = !c.ping.enabled ? { label: 'Ping', value: 'disabled' } : {
      label: s.ping.method === 'tcp' ? 'Host (TCP)' : 'Ping',
      value: s.ping.ok == null ? '…' : s.ping.ok ? `${c.host} · ${s.ping.rttMs != null ? `${s.ping.rttMs} ms` : 'up'}` : `${c.host} · ${s.ping.error}`,
      level: s.ping.ok ? 'ok' : (this.hostDown() ? (inUse ? 'warn' : undefined) : undefined)
    };

    const issues = this.issues(ctx);
    const r = s.raw || {};
    const pick = (...keys) => { for (const k of keys) { const v = Object.entries(r).find(([kk]) => kk.toLowerCase() === k.toLowerCase())?.[1]; if (v != null && String(v).trim() !== '') return String(v).trim(); } return null; };
    const period = pick('Period', 'Quarter', 'Inning', 'Half', 'Game');
    const clock = pick('Clock', 'FullClock');
    const hs = pick('HomeScore'), gs = pick('GuestScore', 'AwayScore', 'VisitorScore');

    const rows = [
      pingRow,
      { label: 'MQTT', value: s.mqtt.connected ? `connected · ${c.mqtt.topic}` : (s.mqtt.error || 'connecting…'), level: s.mqtt.connected ? 'ok' : (inUse && ctx.now - s.startedAt > 6000 ? 'warn' : undefined) },
      { label: 'Last data', value: s.lastMessageAt ? `${fmtAgo(ctx.now - s.lastMessageAt)} ago · ${s.rate.toFixed(1)}/s` : 'none yet', level: s.lastMessageAt && !silent ? 'ok' : (silent && inUse ? 'warn' : undefined) },
      { label: 'Board sport', value: sportValue, level: inUse ? sportLevel : undefined },
      { label: "Today's sport", value: exp.sport ? `${sportName(exp.sport)} (${exp.source})` : exp.source }
    ];
    if (s.raw) rows.push({ label: 'Board', value: [period && `P${period}`, clock, hs != null && gs != null && `Home ${hs} – Guest ${gs}`].filter(Boolean).join('  ·  ') || '—' });

    const actions = [];
    // One-click teaching: an unmapped sport ID becomes today's sport.
    if (sp?.vendorId && sp.method !== 'id' && exp.sport) {
      actions.push({ label: `Sport ID ${sp.vendorId} is ${sportName(exp.sport)}`, post: '/api/scorebot/learn-sport', body: { vendorId: sp.vendorId, sport: exp.sport } });
    }
    if (sp?.vendorId && sp.method === 'id' && mismatch) {
      actions.push({ label: `Wrong? Forget sport ID ${sp.vendorId}`, post: '/api/scorebot/learn-sport', body: { vendorId: sp.vendorId, sport: null }, style: 'subtle' });
    }

    return {
      level: !inUse ? 'idle' : issues.length ? 'warn' : (s.mqtt.connected && s.lastMessageAt ? 'ok' : 'idle'),
      status: !inUse ? 'Not in use' : issues.length ? issues[0].title : (s.lastMessageAt ? 'Receiving' : 'Waiting for data'),
      rows,
      controls: [{
        type: 'select', label: "Today's sport", name: 'expectedSport', value: exp.mode, post: '/api/settings',
        options: [
          { value: 'auto', label: 'Auto (follow OSE game)' },
          ...SPORTS.map((x) => ({ value: x.id, label: x.name })),
          { value: 'none', label: 'Scorebot not in use' }
        ]
      }],
      actions
    };
  }
}
