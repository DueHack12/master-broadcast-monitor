import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectSport, SPORTS } from './lib/sports.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
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
    'POST /api/youtube/auth/cancel': () => { yt(app).cancelAuth(); return { ok: true }; },
    'POST /api/youtube/auth/logout': () => { yt(app).logout(); return { ok: true }; },
    'POST /api/youtube/refresh': () => { yt(app).schedule(0); return { ok: true }; },

    'POST /api/notify/test': () => app.notifier.test()
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

function yt(app) {
  const m = app.monitors.youtube;
  if (!m) throw httpError(400, 'YouTube monitoring is disabled in config.json');
  return m;
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

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}
