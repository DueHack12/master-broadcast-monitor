import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { detectSport, SPORTS } from './lib/sports.js';
import { FIELDS, isSecret, getPath, validate } from '../public/settings-schema.js';
import { readAsset } from './runtime.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json'
};

/**
 * HTTP: the dashboard, a Server-Sent Events stream of snapshots, and a few
 * JSON endpoints. No login — this is meant for a closed broadcast network.
 */
export function createServer(app) {
  const clients = new Set();

  app.on('snapshot', (snap) => {
    if (!clients.size) return;
    const msg = `data: ${JSON.stringify(snap)}\n\n`;
    for (const res of clients) res.write(msg);
  });
  const heartbeat = setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 15000);

  const routes = {
    'GET /events': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 2000\n\n');
      if (app.snapshot) res.write(`data: ${JSON.stringify(app.snapshot)}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
    },

    'GET /api/state': () => app.snapshot,

    /** Compact status for Apple Shortcuts, scripts or another monitoring system. */
    'GET /api/status': () => {
      const s = app.snapshot;
      return {
        level: s.overall.level, ok: s.overall.level === 'ok',
        headline: s.overall.headline, detail: s.overall.detail,
        onAir: s.onAir, youtubeLive: s.live.youtube,
        issues: s.issues.filter((i) => i.level !== 'info').map((i) => ({ level: i.level, title: i.title }))
      };
    },

    'POST /api/settings': (req, res, body) => {
      const patch = {};
      if ('expectedSport' in body) {
        const v = String(body.expectedSport);
        if (!['auto', 'none', ...SPORTS.map((s) => s.id)].includes(v)) throw httpError(400, 'Unknown sport');
        patch.expectedSport = v;
      }
      const values = app.settings.update(patch);
      app.log.add('info', `Today's sport set to ${values.expectedSport}`, 'scorebot');
      app.changed();
      return { ok: true, settings: values };
    },

    'POST /api/scorebot/learn-sport': (req, res, body) => {
      const id = String(body.vendorId ?? '').trim();
      if (!id) throw httpError(400, 'vendorId required');
      const map = { ...(app.settings.get('vendorSportIds') || {}) };
      if (body.sport) {
        if (!SPORTS.some((s) => s.id === body.sport)) throw httpError(400, 'Unknown sport');
        map[id] = body.sport;
        app.log.add('info', `Learned: scorebot sport ID ${id} = ${body.sport}`, 'scorebot');
      } else {
        delete map[id];
        app.log.add('info', `Forgot scorebot sport ID ${id}`, 'scorebot');
      }
      app.settings.update({ vendorSportIds: map });
      const sb = app.monitors.scorebot;
      if (sb?.state.raw) sb.state.sport = detectSport(sb.state.raw, sb.vendorMap());
      app.changed();
      return { ok: true };
    },

    'POST /api/youtube/auth/start': async () => { await yt(app).startAuth(); return { ok: true }; },

    /* Browser sign-in, where you choose the channel: off to Google, and back. */
    'GET /oauth/youtube/start': (req, res) => {
      let url;
      try { url = yt(app).startBrowserAuth(req.socket.localPort); } catch (e) { return sendPage(res, 400, 'Can\'t sign in yet', e.message); }
      res.writeHead(302, { Location: url, 'Cache-Control': 'no-store' });
      res.end();
      return undefined;
    },
    'GET /oauth/youtube': async (req, res) => {
      const q = new URL(req.url, 'http://x').searchParams;
      try {
        const channel = await yt(app).finishBrowserAuth({ code: q.get('code'), state: q.get('state'), error: q.get('error') });
        return sendPage(res, 200, 'YouTube connected', channel ? `Connected to the channel "${channel}".` : 'Connected.', true);
      } catch (e) {
        return sendPage(res, 400, 'Sign-in didn\'t finish', e.message);
      }
    },
    'POST /api/youtube/auth/code': async (req, res, body) => {
      try { return { ok: true, channel: await yt(app).finishFromPastedUrl(body.url) }; } catch (e) { throw httpError(400, e.message); }
    },
    'POST /api/youtube/auth/cancel': () => { yt(app).cancelAuth(); return { ok: true }; },
    'POST /api/youtube/auth/logout': () => { yt(app).logout(); return { ok: true }; },
    'POST /api/youtube/refresh': () => { yt(app).schedule(0); return { ok: true }; },

    'POST /api/notify/test': () => app.notifier.test(),

    /** The Settings page: current values (secrets never sent back, only whether they are set). */
    'GET /api/config': (req) => configPayload(app, req.socket.localPort),

    'POST /api/config': (req, res, body) => {
      const { values, errors } = validate(body.values);
      if (Object.keys(errors).length) { sendJson(res, 400, { error: 'Some settings need fixing.', errors }); return undefined; }
      if (!Object.keys(values).length) return { ok: true, changed: 0 };
      try { app.config.update(values); } catch (e) { throw httpError(409, e.message); }
      return { ok: true, changed: Object.keys(values).length };
    }
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const key = `${req.method} ${url.pathname}`;
    try {
      if (routes[key]) {
        const body = req.method === 'POST' ? await readBody(req) : null;
        const out = await routes[key](req, res, body || {});
        if (out !== undefined && !res.headersSent) sendJson(res, 200, out);
        return;
      }
      if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(url.pathname, res);
      sendJson(res, 404, { error: 'Not found' });
    } catch (e) {
      if (!res.headersSent) sendJson(res, e.status || 500, { error: e.message });
    }
  });
  server.on('close', () => { clearInterval(heartbeat); for (const res of clients) res.end(); clients.clear(); });
  const close = server.close.bind(server);
  server.close = (cb) => { for (const res of clients) res.end(); clients.clear(); return close(cb); };
  return server;
}

function configPayload(app, port) {
  const values = {}, secretsSet = {};
  for (const f of FIELDS) {
    const v = getPath(app.cfg, f.path);
    if (isSecret(f)) { secretsSet[f.path] = !!v; values[f.path] = ''; } else values[f.path] = v;
  }
  let ip = null;
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (!ip && (a.family === 'IPv4' || a.family === 4) && !a.internal) ip = a.address;
  }
  const vm = app.monitors.vmix?.state.data;
  const ndi = app.monitors.ndi;
  return {
    values, secretsSet,
    file: app.config.file,
    configError: app.config.error,
    firstRun: app.firstRun,
    hints: {
      publicUrl: ip ? `http://${ip}:${port}` : '',
      vmixInputs: vm ? vm.inputs.map((i) => i.title).filter(Boolean) : [],
      ndiSources: ndi ? ndi.online(Date.now()).map((s) => s.name) : []
    }
  };
}

function yt(app) {
  const m = app.monitors.youtube;
  if (!m) throw httpError(400, 'YouTube monitoring is disabled in config.json');
  return m;
}

/** A small standalone page for the end of browser sign-in. */
function sendPage(res, status, title, message, ok = false) {
  const e = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${e(title)} — Broadcast Monitor</title><link rel="stylesheet" href="/style.css">${ok ? '<meta http-equiv="refresh" content="4;url=/">' : ''}</head>
<body><main class="settings"><div class="card setting-card ${ok ? 'lvl-ok' : 'lvl-warn'}" style="border-top-width:4px">
<h1 style="margin-top:0">${ok ? '✔ ' : ''}${e(title)}</h1><p>${e(message)}</p>
<p class="muted">${ok ? 'Taking you to the dashboard… You can also close this tab.' : 'Go back to the dashboard and try again.'}</p>
<p><a class="btn primary" href="/">Open the dashboard</a></p></div></main></body></html>`);
  return undefined;
}

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj ?? null);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 64 * 1024) { reject(httpError(413, 'Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(httpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

/** The dashboard files: from public/ in a checkout, from inside the executable when packaged. */
function serveStatic(pathname, res) {
  let rel = pathname === '/' ? 'index.html' : pathname;
  try { rel = decodeURIComponent(rel); } catch { rel = ''; }
  rel = path.posix.normalize('/' + rel).slice(1);
  let body = rel && !rel.includes('..') ? readAsset(`public/${rel}`) : null;
  if (!body && rel && !path.extname(rel) && !rel.includes('..')) { body = readAsset(`public/${rel}.html`); if (body) rel += '.html'; }
  if (!body) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(rel)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(body);
}
