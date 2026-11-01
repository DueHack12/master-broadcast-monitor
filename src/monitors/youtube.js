import path from 'node:path';
import fs from 'node:fs';
import { Monitor } from './base.js';
import { readJson, writeJson } from '../store.js';
import { fmtAgo } from '../levels.js';

/**
 * YouTube Live through the YouTube Data API v3.
 *
 *   liveBroadcasts.list  → is the broadcast LIVE, or still in preview/ready?
 *   liveStreams.list     → is YouTube actually receiving our feed, and how healthy is it?
 *   videos.list          → concurrent viewers (optional)
 *
 * Sign-in uses Google's device flow: the dashboard shows a short code, you
 * enter it at google.com/device on any phone or laptop. That works on a
 * locked-down LAN where an OAuth redirect back to this server would not.
 *
 * Quota: 2–3 units per poll. Polls every `pollOnAirSec` while vMix is
 * streaming or a broadcast is live, every `pollIdleSec` otherwise — a 3-hour
 * show plus a day of idling is ~6,000 of the default 10,000 daily units.
 */

const SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';

export const LIFECYCLE = {
  created: { label: 'Created', live: false },
  ready: { label: 'Ready — not live', live: false },
  testStarting: { label: 'Starting preview', live: false },
  testing: { label: 'Preview — NOT LIVE', live: false },
  liveStarting: { label: 'Going live…', live: false },
  live: { label: 'LIVE', live: true },
  complete: { label: 'Ended', live: false },
  revoked: { label: 'Revoked', live: false }
};

const PRIORITY = { live: 7, liveStarting: 6, testing: 5, testStarting: 4, ready: 3, created: 2 };

/** Pick the broadcast that matters: the most "advanced" one, preferring one whose stream is receiving. */
export function pickBroadcast(broadcasts, streams) {
  const active = new Set(streams.filter((s) => s.status?.streamStatus === 'active').map((s) => s.id));
  const score = (b) => (PRIORITY[b.status?.lifeCycleStatus] || 0) * 10 + (active.has(b.contentDetails?.boundStreamId) ? 5 : 0);
  return [...broadcasts].sort((a, b) => score(b) - score(a)
    || Math.abs(Date.parse(a.snippet?.scheduledStartTime || 0) - Date.now()) - Math.abs(Date.parse(b.snippet?.scheduledStartTime || 0) - Date.now()))[0] || null;
}

export default class YouTubeMonitor extends Monitor {
  static id = 'youtube';
  static title = 'YouTube';

  start() {
    this.tokenFile = path.join(this.app.dataDir, 'youtube-token.json');
    this.token = readJson(this.tokenFile, null);
    this.state = {
      configured: !!(this.cfg.clientId && this.cfg.clientSecret),
      authed: !!this.token?.refresh_token,
      channel: this.token?.channel || null,
      auth: null,
      polling: false,
      lastPollAt: null, lastOkAt: null, error: null, errorReason: null,
      broadcast: null, stream: null, viewers: null, broadcastsSeen: 0
    };
    this.noTypeParam = false;
    this.onVmix = (streaming) => {
      // React quickly when vMix starts or stops instead of waiting out the idle interval.
      this.schedule(streaming ? 8000 : 3000);
    };
    this.app.on('vmix:streaming', this.onVmix);
    this.schedule(500);
  }

  stop() {
    this.app.off('vmix:streaming', this.onVmix);
    clearTimeout(this.timer);
    clearTimeout(this.authTimer);
    this.stopped = true;
  }

  schedule(ms) {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.poll(), ms);
  }

  get onAirNow() {
    return !!(this.app.monitors.vmix?.state.streaming || this.state.broadcast?.lifeCycleStatus === 'live');
  }

  async poll() {
    if (!this.state.configured || !this.state.authed) { this.schedule(5000); return; }
    this.state.polling = true;
    try {
      await this.fetchStatus();
      this.state.lastOkAt = Date.now();
      this.state.error = null;
      this.state.errorReason = null;
    } catch (e) {
      this.state.error = e.message;
      this.state.errorReason = e.reason || null;
      if (e.reason === 'auth') { this.state.authed = false; }
    } finally {
      this.state.polling = false;
      this.state.lastPollAt = Date.now();
      this.app.changed();
    }
    // Quota exhausted: back off hard until it resets rather than burning requests.
    const quota = this.state.errorReason === 'quotaExceeded';
    this.schedule(quota ? 10 * 60000 : (this.onAirNow ? this.cfg.pollOnAirSec : this.cfg.pollIdleSec) * 1000);
  }

  async fetchStatus() {
    const part = 'id,snippet,status,contentDetails';
    let broadcasts;
    if (this.cfg.broadcastId) {
      broadcasts = (await this.api('liveBroadcasts', { part, id: this.cfg.broadcastId })).items || [];
    } else {
      const active = await this.listBroadcasts(part, 'active');
      broadcasts = active;
      if (!active.some((b) => b.status?.lifeCycleStatus === 'live')) {
        broadcasts = active.concat(await this.listBroadcasts(part, 'upcoming'));
      }
    }
    const streams = (await this.api('liveStreams', { part: 'id,snippet,status', mine: 'true', maxResults: 50 })).items || [];
    const b = pickBroadcast(broadcasts, streams);
    const boundId = b?.contentDetails?.boundStreamId;
    const s = boundId ? streams.find((x) => x.id === boundId) : streams.find((x) => x.status?.streamStatus === 'active');

    const prev = this.state.broadcast?.lifeCycleStatus;
    const next = b?.status?.lifeCycleStatus || null;
    if (prev !== next && (prev || next)) {
      this.app.log.add(next === 'live' ? 'ok' : (prev === 'live' ? 'warn' : 'info'),
        next ? `YouTube broadcast "${b.snippet?.title}" is ${LIFECYCLE[next]?.label || next}` : 'No YouTube broadcast in progress', this.id);
    }

    this.state.broadcastsSeen = broadcasts.length;
    this.state.broadcast = b ? {
      id: b.id,
      title: b.snippet?.title || '(untitled)',
      lifeCycleStatus: next,
      privacy: b.status?.privacyStatus || null,
      scheduledStartTime: b.snippet?.scheduledStartTime || null,
      actualStartTime: b.snippet?.actualStartTime || null,
      autoStart: b.contentDetails?.enableAutoStart ?? null,
      boundStreamId: boundId || null
    } : null;
    this.state.stream = s ? {
      id: s.id,
      title: s.snippet?.title || 'Stream key',
      streamStatus: s.status?.streamStatus || null,
      health: s.status?.healthStatus?.status || null,
      issues: (s.status?.healthStatus?.configurationIssues || []).map((i) => ({
        type: i.type, severity: i.severity, reason: i.reason, description: i.description
      }))
    } : null;

    this.state.viewers = null;
    if (this.cfg.showViewers && next === 'live') {
      try {
        const v = await this.api('videos', { part: 'liveStreamingDetails', id: b.id });
        const n = v.items?.[0]?.liveStreamingDetails?.concurrentViewers;
        this.state.viewers = n != null ? parseInt(n, 10) : null;
      } catch { /* viewers are a nice-to-have */ }
    }
  }

  async listBroadcasts(part, broadcastStatus) {
    const q = { part, broadcastStatus, maxResults: 10 };
    if (!this.noTypeParam) q.broadcastType = 'all';
    try {
      return (await this.api('liveBroadcasts', q)).items || [];
    } catch (e) {
      // Some accounts reject broadcastType; fall back to the default (events) once and remember.
      if (!this.noTypeParam && e.status === 400) { this.noTypeParam = true; return this.listBroadcasts(part, broadcastStatus); }
      throw e;
    }
  }

  /* ---------------- Google API plumbing ---------------- */

  async api(resource, params, retried = false) {
    const token = await this.accessToken();
    const url = `${this.cfg.apiBase}/youtube/v3/${resource}?${new URLSearchParams(params)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
    const json = await res.json().catch(() => ({}));
    if (res.status === 401 && !retried) { this.token.access_token = null; return this.api(resource, params, true); }
    if (!res.ok) {
      const reason = json.error?.errors?.[0]?.reason || json.error?.status || null;
      const err = new Error(`YouTube API: ${json.error?.message || `HTTP ${res.status}`}`);
      err.status = res.status;
      err.reason = reason;
      throw err;
    }
    return json;
  }

  async accessToken() {
    const t = this.token;
    if (!t?.refresh_token) { const e = new Error('YouTube is not connected'); e.reason = 'auth'; throw e; }
    if (t.access_token && t.expires_at > Date.now() + 60000) return t.access_token;
    const json = await this.oauth('token', {
      client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret,
      refresh_token: t.refresh_token, grant_type: 'refresh_token'
    });
    if (json.error) {
      const e = new Error(json.error === 'invalid_grant'
        ? 'YouTube sign-in expired or was revoked — reconnect'
        : `Google sign-in: ${json.error_description || json.error}`);
      if (json.error === 'invalid_grant') e.reason = 'auth';
      throw e;
    }
    t.access_token = json.access_token;
    t.expires_at = Date.now() + (json.expires_in || 3600) * 1000;
    this.saveToken();
    return t.access_token;
  }

  async oauth(endpoint, form) {
    const res = await fetch(`${this.cfg.oauthBase}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(10000)
    });
    return res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  }

  saveToken() { writeJson(this.tokenFile, this.token); }

  /* ---------------- device-flow sign-in ---------------- */

  async startAuth() {
    if (!this.state.configured) throw new Error('Set youtube.clientId and youtube.clientSecret in config.json first (see README).');
    clearTimeout(this.authTimer);
    const json = await this.oauth('device/code', { client_id: this.cfg.clientId, scope: SCOPE });
    if (json.error) throw new Error(`Google: ${json.error_description || json.error}`);
    const auth = {
      userCode: json.user_code,
      url: json.verification_url || json.verification_uri || 'https://www.google.com/device',
      expiresAt: Date.now() + (json.expires_in || 1800) * 1000,
      interval: (json.interval || 5) * 1000,
      deviceCode: json.device_code
    };
    this.set({ auth: { userCode: auth.userCode, url: auth.url, expiresAt: auth.expiresAt } });
    const pollAuth = async () => {
      if (this.stopped || !this.state.auth) return;
      if (Date.now() > auth.expiresAt) { this.set({ auth: null }); this.app.log.add('warn', 'YouTube sign-in code expired', this.id); return; }
      const r = await this.oauth('token', {
        client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret,
        device_code: auth.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
      }).catch((e) => ({ error: e.message }));
      if (r.access_token) {
        this.token = { refresh_token: r.refresh_token, access_token: r.access_token, expires_at: Date.now() + (r.expires_in || 3600) * 1000 };
        this.saveToken();
        this.set({ auth: null, authed: true, error: null });
        await this.loadChannel();
        this.app.log.add('info', `YouTube connected${this.state.channel ? ` as ${this.state.channel}` : ''}`, this.id);
        this.schedule(100);
        return;
      }
      if (r.error === 'slow_down') auth.interval += 5000;
      else if (r.error && r.error !== 'authorization_pending') {
        this.set({ auth: null, error: `Sign-in failed: ${r.error_description || r.error}` });
        return;
      }
      this.authTimer = setTimeout(pollAuth, auth.interval);
    };
    this.authTimer = setTimeout(pollAuth, auth.interval);
  }

  cancelAuth() { clearTimeout(this.authTimer); this.set({ auth: null }); }

  logout() {
    clearTimeout(this.authTimer);
    this.token = null;
    try { fs.unlinkSync(this.tokenFile); } catch { /* already gone */ }
    this.set({ authed: false, channel: null, broadcast: null, stream: null, viewers: null, auth: null, error: null });
    this.app.log.add('info', 'YouTube disconnected', this.id);
  }

  async loadChannel() {
    try {
      const j = await this.api('channels', { part: 'snippet', mine: 'true' });
      const name = j.items?.[0]?.snippet?.title || null;
      this.token.channel = name;
      this.saveToken();
      this.set({ channel: name });
    } catch { /* cosmetic */ }
  }

  /** Data older than this is too stale to judge the stream by. */
  isStale(now) {
    const limit = Math.max(60, this.cfg.pollOnAirSec * 4) * 1000;
    return !this.state.lastOkAt || now - this.state.lastOkAt > limit;
  }

  /* ---------------- dashboard ---------------- */

  issues(ctx) {
    const s = this.state;
    const streaming = !!ctx.monitors.vmix?.state.streaming;
    if (!s.configured) return [{ id: 'youtube.setup', level: streaming ? 'warn' : 'info', title: 'YouTube monitoring not set up', detail: 'Add a Google API client to config.json — see README.' }];
    if (!s.authed) return [{ id: 'youtube.auth', level: 'warn', title: 'YouTube not connected', detail: 'Press "Connect YouTube" on the YouTube card.' }];
    if (s.error && (this.isStale(ctx.now) || streaming)) {
      return [{ id: 'youtube.api', level: 'warn', title: "Can't check YouTube", detail: s.error }];
    }
    // The stream-chain rules (receiving? live?) are in rules.js, since they need vMix too.
    const out = [];
    for (const i of s.stream?.issues || []) {
      if (i.severity === 'error' && (ctx.onAir || s.stream?.streamStatus === 'active')) {
        out.push({ id: `youtube.config.${i.type || i.reason}`, level: 'warn', title: `YouTube: ${i.reason || i.type}`, detail: i.description });
      }
    }
    return out;
  }

  view(ctx) {
    const s = this.state;
    if (!s.configured) {
      return {
        level: 'idle', status: 'Not set up',
        notice: { text: 'Add a Google Cloud OAuth client ("TVs and Limited Input devices") to config.json → youtube.clientId / clientSecret. Step-by-step in the README.' }
      };
    }
    if (s.auth) {
      return {
        level: 'warn', status: 'Waiting for sign-in',
        notice: { text: `On any phone or computer, open ${s.auth.url} and enter this code:`, code: s.auth.userCode, link: s.auth.url },
        actions: [{ label: 'Cancel', post: '/api/youtube/auth/cancel' }]
      };
    }
    if (!s.authed) {
      return {
        level: 'warn', status: 'Not connected',
        rows: s.error ? [{ label: 'Error', value: s.error, level: 'warn' }] : [],
        actions: [{ label: 'Connect YouTube', post: '/api/youtube/auth/start', style: 'primary' }]
      };
    }
    const b = s.broadcast, st = s.stream;
    const lc = b?.lifeCycleStatus;
    const live = lc === 'live';
    const receiving = st?.streamStatus === 'active';
    const healthLevel = { good: 'ok', ok: 'ok', bad: 'warn', noData: live ? 'crit' : undefined }[st?.health];
    const rows = [
      { label: 'Broadcast', value: b ? b.title : 'none found' },
      { label: 'Status', value: b ? (LIFECYCLE[lc]?.label || lc) : '—', level: live ? 'ok' : (b && receiving ? 'crit' : undefined) },
      { label: 'Receiving feed', value: st ? (receiving ? 'YES' : (st.streamStatus || 'no')) : '—', level: receiving ? 'ok' : (ctx.monitors.vmix?.state.streaming ? 'crit' : undefined) },
      { label: 'Stream health', value: st?.health || '—', level: healthLevel }
    ];
    if (live && b.actualStartTime) rows.push({ label: 'Live for', value: fmtAgo(ctx.now - Date.parse(b.actualStartTime)) });
    if (s.viewers != null) rows.push({ label: 'Viewers', value: s.viewers.toLocaleString() });
    rows.push({ label: 'Checked', value: s.lastPollAt ? `${fmtAgo(ctx.now - s.lastPollAt)} ago` : '—', level: s.error ? 'warn' : undefined });
    if (s.error) rows.push({ label: 'Error', value: s.error, level: 'warn' });
    if (s.channel) rows.push({ label: 'Channel', value: s.channel });

    const issues = (st?.issues || []).filter((i) => i.severity !== 'info' || receiving);
    return {
      level: live ? (receiving ? 'ok' : 'crit') : (receiving ? 'crit' : 'idle'),
      status: live ? 'LIVE' : b ? (LIFECYCLE[lc]?.label || lc) : 'No broadcast',
      rows,
      list: issues.length ? {
        title: 'YouTube reports',
        items: issues.map((i) => ({ name: i.reason || i.type, level: i.severity === 'error' ? 'warn' : 'info', detail: i.description }))
      } : null,
      actions: [
        { label: 'Check now', post: '/api/youtube/refresh' },
        ...(b?.id ? [{ label: 'Open Live Control Room', href: `https://studio.youtube.com/video/${b.id}/livestreaming` }] : []),
        { label: 'Disconnect', post: '/api/youtube/auth/logout', confirm: 'Disconnect YouTube?', style: 'subtle' }
      ]
    };
  }
}
