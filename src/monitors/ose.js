import { Monitor } from './base.js';
import { sportIdFromName, sportName } from '../lib/sports.js';
import { fmtAgo, netError } from '../levels.js';

/**
 * OpenStatsEngine — optional. Reads OSE's own /api/monitor endpoint (the one
 * its /monitor page uses) to show the active game and whether OSE itself is
 * receiving the scorebot feed.
 *
 * OSE not running is normal (not every event uses it), so by default that is
 * shown on the card only. Set `ose.required: true` to make it an alert.
 *
 * Blame is pinned carefully: if our own Scorebot connection is also dead, the
 * problem is the scorebot, and only the Scorebot card alerts. OSE alerts only
 * when the board is fine but OSE isn't getting it.
 */
export default class OseMonitor extends Monitor {
  static id = 'ose';
  static title = 'OpenStatsEngine';

  start() {
    this.base = String(this.cfg.url || '').replace(/\/+$/, '');
    this.state = { reachable: false, lastOkAt: null, error: null, feed: null, game: null, startedAt: Date.now() };
    this.loop(() => this.poll(), this.cfg.pollSec * 1000);
  }

  stop() { this.clearTimers(); }

  async poll() {
    try {
      const res = await fetch(`${this.base}/api/monitor`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (!this.state.reachable) this.app.log.add('info', `OpenStatsEngine found at ${this.base}`, this.id);
      const g = j.game;
      this.state = {
        ...this.state,
        reachable: true, lastOkAt: Date.now(), error: null,
        feed: j.feed || null,
        game: g ? {
          id: g.id, sport: g.sport, sportId: sportIdFromName(g.sport), matchup: g.matchup,
          periodLabel: g.periodLabel, period: g.period, clock: g.clock, running: g.running,
          score: g.score, officialScore: g.officialScore
        } : null
      };
    } catch (e) {
      if (this.state.reachable) this.app.log.add(this.cfg.required ? 'warn' : 'info', `OpenStatsEngine is not responding (${e.message})`, this.id);
      this.state.reachable = false;
      this.state.error = netError(e) === 'connection refused' ? 'not running' : netError(e);
    }
    this.app.changed();
  }

  issues(ctx) {
    const s = this.state;
    const out = [];
    if (!s.reachable) {
      if (this.cfg.required && ctx.now - s.startedAt > 8000) out.push({ id: 'ose.offline', level: 'warn', title: 'OpenStatsEngine is not running', detail: `No answer from ${this.base} (${s.error}).` });
      return out;
    }
    const sb = ctx.monitors.scorebot;
    const mode = ctx.settings.get('expectedSport') || 'auto';
    const scorebotInUse = mode !== 'none';
    const boardOk = sb ? sb.healthy(ctx.now) : true;
    const f = s.feed;
    if (scorebotInUse && s.game && f?.url && boardOk) {
      if (!f.connected) out.push({ id: 'ose.feed_down', level: 'warn', title: "OSE isn't connected to the Scorebot", detail: `The board is sending, but OSE's feed is ${f.mode === 'off' ? 'switched off' : 'disconnected'}${f.dropReason ? ` (${f.dropReason})` : ''}. Graphics won't update — Setup → Scorebot → Connect.` });
      else if (f.stalled) out.push({ id: 'ose.feed_stalled', level: 'warn', title: 'OSE has stopped receiving Scorebot data', detail: 'The board is sending to this monitor but not reaching OSE. Check its feed URL/topic.' });
    }
    if (mode !== 'auto' && mode !== 'none' && s.game?.sportId && s.game.sportId !== mode) {
      out.push({ id: 'ose.wrong_sport', level: 'warn', title: `OSE's active game is ${sportName(s.game.sportId)}, not ${sportName(mode)}`, detail: `Active game: ${s.game.matchup}. Make the right game active in OSE → Setup.` });
    }
    return out;
  }

  view(ctx) {
    const s = this.state;
    if (!s.reachable) {
      return {
        level: this.cfg.required ? 'warn' : 'idle',
        status: 'Not running',
        rows: [
          { label: 'Address', value: this.base },
          { label: 'Status', value: s.error || 'checking…' },
          { label: 'Last seen', value: s.lastOkAt ? `${fmtAgo(ctx.now - s.lastOkAt)} ago` : 'never' }
        ]
      };
    }
    const g = s.game, f = s.feed || {};
    const issues = this.issues(ctx);
    const rows = [
      { label: 'Active game', value: g ? `${g.sport} · ${g.matchup}` : 'none', level: g ? undefined : 'info' },
      { label: 'Feed', value: f.url ? (f.connected ? (f.stalled ? 'connected, but silent' : `connected · ${f.topic || f.mode}`) : (f.mode === 'off' ? 'switched off' : 'disconnected')) : 'not configured', level: f.connected && !f.stalled ? 'ok' : (issues.some((i) => i.id.startsWith('ose.feed')) ? 'warn' : undefined) },
      { label: 'Feed messages', value: f.messages != null ? `${f.messages}${f.quietMs != null ? ` · last ${fmtAgo(f.quietMs)} ago` : ''}` : '—' }
    ];
    if (g) {
      rows.push({ label: 'Game', value: `${g.periodLabel || g.period || ''} ${g.clock || ''} · ${g.score?.home ?? '–'}–${g.score?.away ?? '–'}`.trim() });
      if (g.officialScore && (g.officialScore.home !== g.score?.home || g.officialScore.away !== g.score?.away) && g.officialScore.home != null) {
        rows.push({ label: 'Board score', value: `${g.officialScore.home}–${g.officialScore.away} (differs from logged)`, level: 'info' });
      }
    }
    return {
      level: issues.length ? 'warn' : 'ok',
      status: issues.length ? issues[0].title : (g ? 'Running' : 'Running — no active game'),
      rows,
      actions: [{ label: 'Open OSE feed monitor', href: `${this.base}/monitor` }]
    };
  }
}
