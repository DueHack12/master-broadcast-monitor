import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
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
 * Two ways to sign in, matching the type of OAuth client made in Google Cloud:
 *
 *   desktop  Google's normal browser sign-in, where you pick the account AND
 *            the channel (Brand Account channels included). Google sends the
 *            browser back to http://127.0.0.1:<port>/oauth/youtube, which only
 *            works on the Broadcast Monitor computer — from any other device,
 *            the address of the page Google lands on is pasted into the dashboard.
 *   tv       Google's device flow: enter a short code at google.com/device on
 *            any phone. Simple, but picks an account only, not a channel.
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
    if (!this.state.configured) throw new Error('Add your Google client ID and secret in Settings → YouTube first.');
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

  cancelAuth() { clearTimeout(this.authTimer); this.browserAuth = null; this.set({ auth: null }); }

  /* ---------------- browser sign-in (choose a channel) ---------------- */

  /**
   * Start Google's authorization-code sign-in (with PKCE) and return the URL
   * to send the browser to. `port` is the port this server is listening on.
   */
  startBrowserAuth(port) {
    if (!this.state.configured) throw new Error('Add your Google client ID and secret in Settings → YouTube first.');
    clearTimeout(this.authTimer);
    const b64 = (buf) => buf.toString('base64url');
    const verifier = b64(crypto.randomBytes(32));
    const auth = {
      state: b64(crypto.randomBytes(16)),
      verifier,
      redirectUri: `http://127.0.0.1:${port}/oauth/youtube`,
      expiresAt: Date.now() + 15 * 60000
    };
    this.browserAuth = auth;
    this.set({ auth: { mode: 'browser', expiresAt: auth.expiresAt, redirectUri: auth.redirectUri } });
    const q = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: auth.redirectUri,
      response_type: 'code',
      scope: SCOPE,
      access_type: 'offline',
      // Always show the account chooser and consent, so a channel can be picked
      // and Google issues a long-lived sign-in even if it has seen this app before.
      prompt: 'select_account consent',
      state: auth.state,
      code_challenge: b64(crypto.createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256'
    });
    return `${this.cfg.authBase}?${q}`;
  }

  /** Finish browser sign-in from Google's redirect (or a pasted copy of its address). */
  async finishBrowserAuth({ code, state, error }) {
    const p = this.browserAuth;
    if (error) {
      this.browserAuth = null;
      this.set({ auth: null });
      throw new Error(error === 'access_denied' ? 'Sign-in was cancelled.' : `Google said: ${error}`);
    }
    if (!p || Date.now() > p.expiresAt) { this.set({ auth: null }); throw new Error('This sign-in has expired. Start again from the dashboard.'); }
    if (!code || state !== p.state) throw new Error("That sign-in link doesn't belong to the current attempt. Start again from the dashboard.");
    const r = await this.oauth('token', {
      code, client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret,
      redirect_uri: p.redirectUri, grant_type: 'authorization_code', code_verifier: p.verifier
    });
    if (r.error) {
      const hint = r.error === 'invalid_client' || r.error === 'unauthorized_client'
        ? ' Check the client in Settings → YouTube is a "Desktop app" client.' : '';
      throw new Error(`Google: ${r.error_description || r.error}.${hint}`);
    }
    if (!r.refresh_token) throw new Error('Google did not issue a lasting sign-in. Remove Broadcast Monitor at myaccount.google.com/permissions, then sign in again.');
    this.browserAuth = null;
    this.token = { refresh_token: r.refresh_token, access_token: r.access_token, expires_at: Date.now() + (r.expires_in || 3600) * 1000 };
    this.saveToken();
    this.set({ auth: null, authed: true, error: null, broadcast: null, stream: null, viewers: null });
    await this.loadChannel();
    this.app.log.add('info', `YouTube connected${this.state.channel ? ` to channel "${this.state.channel}"` : ''}`, this.id);
    this.schedule(100);
    return this.state.channel;
  }

  /** Parse the address Google redirected to, pasted from a browser on another device. */
  async finishFromPastedUrl(text) {
    const s = String(text || '').trim();
    let params;
    try { params = new URL(s).searchParams; } catch { params = new URLSearchParams(s.replace(/^[^?]*\?/, '')); }
    if (!params.get('code') && !params.get('error')) throw new Error('Paste the whole address from the browser (it contains "code=").');
    return this.finishBrowserAuth({ code: params.get('code'), state: params.get('state'), error: params.get('error') });
  }

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
      this.token.channelId = j.items?.[0]?.id || null;
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
    if (!s.configured) return [{ id: 'youtube.setup', level: streaming ? 'warn' : 'info', title: 'YouTube monitoring not set up', detail: 'Add your Google client ID and secret in Settings → YouTube.' }];
    if (!s.authed) return [{ id: 'youtube.auth', level: 'warn', title: 'YouTube not connected', detail: 'Sign in on the YouTube card.' }];
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
        notice: { text: 'Add your Google client ID and secret in Settings → YouTube. The setup guide walks through getting them from Google Cloud (about 10 minutes).' },
        actions: [{ label: 'Open Settings', href: '/settings#youtube', style: 'primary' }, { label: 'Setup guide', href: 'https://github.com/DueHack12/master-broadcast-monitor#youtube' }]
      };
    }
    if (s.auth?.mode === 'browser' && ctx.now > s.auth.expiresAt) { this.browserAuth = null; s.auth = null; }
    if (s.auth?.mode === 'browser') {
      return {
        level: 'warn', status: 'Waiting for sign-in',
        notice: { text: 'Finish in the Google tab: pick the account, then the channel you stream to. On this computer it comes back here by itself. On another device, the Google tab ends on an error page. That\'s expected: copy that page\'s full address and paste it below.' },
        controls: [{ type: 'input', name: 'url', label: 'Address from the Google tab', placeholder: `${s.auth.redirectUri}?code=…`, post: '/api/youtube/auth/code', button: 'Finish sign-in' }],
        actions: [{ label: 'Open Google sign-in again', href: '/oauth/youtube/start', newTab: true }, { label: 'Cancel', post: '/api/youtube/auth/cancel', style: 'subtle' }]
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
        notice: this.cfg.clientType === 'desktop'
          ? { text: 'Sign in with the Google account that runs your channel. You\'ll pick the channel next, including Brand Account channels.' }
          : { text: 'You\'ll get a code to enter at google.com/device on any phone. To pick a specific channel (such as a Brand Account), use a "Desktop app" client instead: Settings → YouTube.' },
        actions: [this.signInAction('Sign in & choose channel', 'Connect YouTube', 'primary')]
      };
    }
    const b = s.broadcast, st = s.stream;
    const lc = b?.lifeCycleStatus;
    const live = lc === 'live';
    const receiving = st?.streamStatus === 'active';
    const healthLevel = { good: 'ok', ok: 'ok', bad: 'warn', noData: live ? 'crit' : undefined }[st?.health];
    const rows = [
      { label: 'Channel', value: s.channel || '(unknown)' },
      { label: 'Broadcast', value: b ? b.title : 'none found' },
      { label: 'Status', value: b ? (LIFECYCLE[lc]?.label || lc) : '—', level: live ? 'ok' : (b && receiving ? 'crit' : undefined) },
      { label: 'Receiving feed', value: st ? (receiving ? 'YES' : (st.streamStatus || 'no')) : '—', level: receiving ? 'ok' : (ctx.monitors.vmix?.state.streaming ? 'crit' : undefined) },
      { label: 'Stream health', value: st?.health || '—', level: healthLevel }
    ];
    if (live && b.actualStartTime) rows.push({ label: 'Live for', value: fmtAgo(ctx.now - Date.parse(b.actualStartTime)) });
    if (s.viewers != null) rows.push({ label: 'Viewers', value: s.viewers.toLocaleString() });
    rows.push({ label: 'Checked', value: s.lastPollAt ? `${fmtAgo(ctx.now - s.lastPollAt)} ago` : '—', level: s.error ? 'warn' : undefined });
    if (s.error) rows.push({ label: 'Error', value: s.error, level: 'warn' });

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
        this.signInAction('Switch channel', 'Reconnect', 'subtle'),
        { label: 'Disconnect', post: '/api/youtube/auth/logout', confirm: 'Disconnect YouTube?', style: 'subtle' }
      ]
    };
  }

  /** The sign-in button for the configured client type. */
  signInAction(desktopLabel, tvLabel, style) {
    return this.cfg.clientType === 'desktop'
      ? { label: desktopLabel, href: '/oauth/youtube/start', newTab: true, style }
      : { label: tvLabel, post: '/api/youtube/auth/start', style };
  }
}
