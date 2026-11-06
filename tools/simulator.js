#!/usr/bin/env node
/**
 * Simulator: fake vMix, YouTube API, ScoreConnect MQTT broker, OpenStatsEngine
 * and NDI senders, with a control page to flip them into every failure mode.
 *
 *   node tools/simulator.js           control page on http://localhost:18000
 *   npm run demo                      simulator + monitor wired together
 *
 * Nothing here talks to real equipment or to Google.
 */
import http from 'node:http';
import net from 'node:net';
import dgram from 'node:dgram';
import { createHash } from 'node:crypto';
import { packet } from '../src/lib/mqtt.js';
import { MDNS_ADDR, MDNS_PORT, NDI_SERVICE, parsePacket } from '../src/lib/mdns.js';

export const PORTS = { control: 18000, vmix: 18088, ose: 18080, youtube: 18443, mqtt: 11883, ndiBase: 15961 };

export const sim = {
  vmix: { online: true, streaming: false, ftb: false, masterMuted: false, audio: 'normal', streamStartedAt: null },
  youtube: { lifecycle: 'ready', receiving: 'auto', health: 'good', authApprovedAfterMs: 4000 },
  scorebot: { running: true, sending: true, sport: 'football' },
  ose: { running: true, sport: 'Football', feedConnected: true },
  // answerRate: share of discovery questions answered (real senders skip some);
  // discoverySilent: senders keep running but stop answering discovery at all.
  ndi: { sources: ['VMIX-PC (vMix - Output 1)', 'CAM-PC (Camera 1)', 'CAM-PC (Camera 2)'], enabled: true, answerRate: 1, discoverySilent: false, goodbye: true }
};

export const SCENARIOS = {
  'Pre-show (standby)': { 'vmix.online': true, 'vmix.streaming': false, 'vmix.ftb': false, 'vmix.masterMuted': false, 'vmix.audio': 'normal', 'youtube.lifecycle': 'ready', 'youtube.receiving': 'auto', 'youtube.health': 'good', 'scorebot.running': true, 'scorebot.sending': true, 'scorebot.sport': 'football', 'ose.running': true, 'ose.feedConnected': true, 'ndi.sources': ['VMIX-PC (vMix - Output 1)', 'CAM-PC (Camera 1)', 'CAM-PC (Camera 2)'], 'ndi.answerRate': 1, 'ndi.discoverySilent': false },
  'Streaming, NOT live (preview)': { 'vmix.online': true, 'vmix.streaming': true, 'youtube.lifecycle': 'testing', 'youtube.receiving': 'auto' },
  'LIVE — all good': { 'vmix.online': true, 'vmix.streaming': true, 'vmix.audio': 'normal', 'vmix.masterMuted': false, 'youtube.lifecycle': 'live', 'youtube.receiving': 'auto', 'youtube.health': 'good' },
  'LIVE — YouTube not receiving': { 'vmix.streaming': true, 'youtube.lifecycle': 'live', 'youtube.receiving': 'no' },
  'LIVE — vMix stopped streaming': { 'vmix.streaming': false, 'youtube.lifecycle': 'live' },
  'LIVE — stream health bad': { 'vmix.streaming': true, 'youtube.lifecycle': 'live', 'youtube.receiving': 'yes', 'youtube.health': 'bad' },
  'Audio clipping': { 'vmix.audio': 'clip' },
  'Audio silent': { 'vmix.audio': 'silent' },
  'Master muted': { 'vmix.masterMuted': true },
  'vMix offline': { 'vmix.online': false },
  'Scorebot on wrong sport': { 'scorebot.sport': 'soccer' },
  'Scorebot stopped sending': { 'scorebot.sending': false },
  'ScoreConnect not running': { 'scorebot.running': false },
  'OSE not connected to feed': { 'ose.feedConnected': false },
  'OSE closed': { 'ose.running': false },
  'NDI camera missing': { 'ndi.sources': ['VMIX-PC (vMix - Output 1)', 'CAM-PC (Camera 1)'] },
  'NDI discovery unreliable (30% answers)': { 'ndi.answerRate': 0.3 },
  'NDI senders stop answering discovery': { 'ndi.discoverySilent': true }
};

export function setPath(p, v) {
  const [a, b] = p.split('.');
  if (!sim[a] || !(b in sim[a])) throw new Error(`unknown ${p}`);
  const cur = sim[a][b];
  if (typeof cur === 'boolean') v = v === true || v === 'true' || v === '1';
  else if (typeof cur === 'number') v = Number(v);
  if (p === 'vmix.streaming') sim.vmix.streamStartedAt = v ? (sim.vmix.streaming ? sim.vmix.streamStartedAt : Date.now()) : null;
  sim[a][b] = v;
}

/* ---------------- vMix ---------------- */
function amp(mode) {
  if (mode === 'silent') return 0.0004;
  if (mode === 'clip') return Math.random() < 0.6 ? 1 : 0.7 + Math.random() * 0.2;
  return 0.08 + Math.random() * 0.35;
}
function vmixXml() {
  const v = sim.vmix;
  const a = amp(v.audio), b = amp(v.audio);
  const mic = () => (0.05 + Math.random() * 0.2).toFixed(5);
  const s = v.streaming ? 'True' : 'False';
  return `<?xml version="1.0" encoding="utf-8"?>
<vmix>
<version>28.0.0.39</version>
<edition>4K</edition>
<preset>C:\\Shows\\Friday Night.vmix</preset>
<inputs>
<input key="a1" number="1" type="NDI" title="CAM-PC (Camera 1)" shortTitle="Camera 1" state="Running" position="0" duration="0" loop="False" muted="True" volume="100" balance="0" solo="False" audiobusses="M" meterF1="0" meterF2="0">CAM-PC (Camera 1)</input>
<input key="a2" number="2" type="NDI" title="CAM-PC (Camera 2)" shortTitle="Camera 2" state="Running" position="0" duration="0" loop="False" muted="True" volume="100" balance="0" solo="False" audiobusses="M" meterF1="0" meterF2="0">CAM-PC (Camera 2)</input>
<input key="a3" number="3" type="Audio" title="Mic 1" shortTitle="Mic 1" state="Running" position="0" duration="0" loop="False" muted="False" volume="100" balance="0" solo="False" audiobusses="M" meterF1="${mic()}" meterF2="${mic()}">Mic 1</input>
<input key="a4" number="4" type="GT" title="Scoreboard.gtzip" shortTitle="Scoreboard" state="Paused" position="0" duration="0" loop="False">Scoreboard.gtzip<text index="0" name="HomeScore.Text">14</text></input>
</inputs>
<overlays><overlay number="1">4</overlay></overlays>
<preview>2</preview>
<active>1</active>
<fadeToBlack>${v.ftb ? 'True' : 'False'}</fadeToBlack>
<transitions><transition number="1" effect="Fade" duration="500"/></transitions>
<recording>False</recording>
<external>False</external>
<streaming channel1="${s}" channel2="False" channel3="False">${s}</streaming>
<playList>False</playList>
<multiCorder>False</multiCorder>
<fullscreen>False</fullscreen>
<audio>
<master volume="100" muted="${v.masterMuted ? 'True' : 'False'}" meterF1="${v.masterMuted ? 0 : a.toFixed(5)}" meterF2="${v.masterMuted ? 0 : b.toFixed(5)}" headphonesVolume="74"/>
<busA volume="100" muted="False" meterF1="0" meterF2="0" solo="False" sendToMaster="False"/>
</audio>
</vmix>`;
}

/* ---------------- YouTube ---------------- */
function ytReceiving() {
  const y = sim.youtube, v = sim.vmix;
  if (y.receiving === 'yes') return true;
  if (y.receiving === 'no') return false;
  return v.online && v.streaming && Date.now() - (v.streamStartedAt || 0) > 6000;
}
function ytBroadcast() {
  const lc = sim.youtube.lifecycle;
  if (lc === 'none') return null;
  return {
    kind: 'youtube#liveBroadcast', id: 'demoBroadcast01',
    snippet: { title: 'Varsity Football vs. Central', scheduledStartTime: new Date(Date.now() - 600000).toISOString(), actualStartTime: lc === 'live' ? new Date(Date.now() - 1234000).toISOString() : undefined },
    status: { lifeCycleStatus: lc, privacyStatus: 'public' },
    contentDetails: { boundStreamId: 'demoStream01', enableAutoStart: false }
  };
}
function ytStream() {
  const rx = ytReceiving();
  return {
    kind: 'youtube#liveStream', id: 'demoStream01',
    snippet: { title: 'Default stream key' },
    status: {
      streamStatus: rx ? 'active' : 'inactive',
      healthStatus: {
        status: rx ? sim.youtube.health : 'noData',
        configurationIssues: rx && sim.youtube.health === 'bad'
          ? [{ type: 'bitrateLow', severity: 'error', reason: 'Low bitrate', description: 'The stream bitrate (1.2 Mbps) is lower than the recommended 4.5 Mbps.' }]
          : []
      }
    }
  };
}
let deviceRequestedAt = 0;
// The fake Google account manages two channels, like a personal channel plus a Brand Account.
export const SIM_CHANNELS = { personal: 'Jack (personal)', brand: 'Demo Sports Network' };
const issuedCodes = new Map(); // code → { channel, challenge, redirectUri }
const chanOf = (token) => (String(token || '').match(/^demo-(personal|brand)-/) || [])[1] || 'brand';

function googleChooser(url) {
  const q = url.searchParams;
  const link = (key) => `/o/oauth2/v2/auth/choose?${new URLSearchParams({ channel: key, redirect_uri: q.get('redirect_uri'), state: q.get('state') || '', code_challenge: q.get('code_challenge') || '' })}`;
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Choose a channel (simulated Google)</title>
<style>body{font:16px system-ui;max-width:420px;margin:60px auto;padding:0 16px}a{display:block;padding:14px;margin:10px 0;border:1px solid #ccc;border-radius:10px;color:#111;text-decoration:none}a:hover{background:#f3f4f6}</style>
<h2>Choose an account or brand account</h2><p>Simulated Google sign-in. Pick the channel Broadcast Monitor should watch:</p>
${Object.entries(SIM_CHANNELS).map(([k, name]) => `<a id="pick-${k}" href="${link(k)}">${name}</a>`).join('')}
<a id="pick-cancel" href="${q.get('redirect_uri')}?error=access_denied&state=${encodeURIComponent(q.get('state') || '')}">Cancel</a>`;
}

function youtubeHandler(req, res, body) {
  const url = new URL(req.url, 'http://x');
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.method === 'GET' && url.pathname === '/o/oauth2/v2/auth') {
    if (!url.searchParams.get('redirect_uri') || url.searchParams.get('code_challenge_method') !== 'S256') return json(400, { error: 'invalid_request' });
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(googleChooser(url)); return;
  }
  if (req.method === 'GET' && url.pathname === '/o/oauth2/v2/auth/choose') {
    const q = url.searchParams;
    const code = `code-${Math.random().toString(36).slice(2)}`;
    issuedCodes.set(code, { channel: q.get('channel'), challenge: q.get('code_challenge'), redirectUri: q.get('redirect_uri') });
    res.writeHead(302, { Location: `${q.get('redirect_uri')}?${new URLSearchParams({ state: q.get('state'), code, scope: 'https://www.googleapis.com/auth/youtube.readonly' })}` });
    res.end(); return;
  }
  if (req.method === 'POST' && url.pathname === '/device/code') {
    deviceRequestedAt = Date.now();
    return json(200, { device_code: 'demo-device', user_code: 'BCST-DEMO', verification_url: 'https://www.google.com/device', expires_in: 1800, interval: 1 });
  }
  if (req.method === 'POST' && url.pathname === '/token') {
    const f = new URLSearchParams(body);
    if (f.get('grant_type') === 'refresh_token') {
      const k = (/^demo-refresh-(personal|brand)$/.exec(f.get('refresh_token')) || [])[1] || 'brand';
      return json(200, { access_token: `demo-${k}-${Date.now()}`, expires_in: 3600 });
    }
    if (f.get('grant_type') === 'authorization_code') {
      const c = issuedCodes.get(f.get('code'));
      if (!c) return json(400, { error: 'invalid_grant', error_description: 'Bad or used code.' });
      issuedCodes.delete(f.get('code'));
      const challenge = createHash('sha256').update(f.get('code_verifier') || '').digest('base64url');
      if (challenge !== c.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE check failed.' });
      if (f.get('redirect_uri') !== c.redirectUri) return json(400, { error: 'redirect_uri_mismatch' });
      return json(200, { access_token: `demo-${c.channel}-${Date.now()}`, refresh_token: `demo-refresh-${c.channel}`, expires_in: 3600 });
    }
    if (Date.now() - deviceRequestedAt < sim.youtube.authApprovedAfterMs) return json(428, { error: 'authorization_pending' });
    return json(200, { access_token: `demo-${Date.now()}`, refresh_token: 'demo-refresh', expires_in: 3600 });
  }
  if (!/^Bearer demo-/.test(req.headers.authorization || '')) return json(401, { error: { code: 401, message: 'Invalid Credentials' } });
  if (url.pathname === '/youtube/v3/liveBroadcasts') {
    const b = ytBroadcast();
    const st = url.searchParams.get('broadcastStatus');
    const isActive = b && ['live', 'liveStarting'].includes(b.status.lifeCycleStatus);
    const isUpcoming = b && ['created', 'ready', 'testing', 'testStarting'].includes(b.status.lifeCycleStatus);
    const items = (st === 'active' && isActive) || (st === 'upcoming' && isUpcoming) || url.searchParams.get('id') ? [b].filter(Boolean) : [];
    return json(200, { items });
  }
  if (url.pathname === '/youtube/v3/liveStreams') return json(200, { items: [ytStream()] });
  if (url.pathname === '/youtube/v3/videos') return json(200, { items: [{ id: 'demoBroadcast01', liveStreamingDetails: { concurrentViewers: String(380 + Math.floor(Math.random() * 40)) } }] });
  if (url.pathname === '/youtube/v3/channels') {
    const k = chanOf(req.headers.authorization.replace('Bearer ', ''));
    return json(200, { items: [{ id: `UC-${k}`, snippet: { title: SIM_CHANNELS[k] } }] });
  }
  return json(404, { error: { message: 'not found' } });
}

/* ---------------- ScoreConnect (MQTT broker) ---------------- */
let boardClock = 12 * 60;
function boardMessage() {
  boardClock = boardClock > 0 ? boardClock - 1 : 12 * 60;
  const clock = `${Math.floor(boardClock / 60)}:${String(boardClock % 60).padStart(2, '0')}`;
  if (sim.scorebot.sport === 'soccer') {
    return { HomeScore: '2', GuestScore: '0', HomeShots: ' 4', GuestShots: ' 1', HomeCornerKicks: ' 2', GuestCornerKicks: ' 3', Period: '2', PeriodOrdinal: '2nd', Clock: clock, ClockStatus: 'R', VendorSportId: 23 };
  }
  if (sim.scorebot.sport === 'basketball') {
    return { HomeScore: '41', GuestScore: '38', HomeFouls: '4', GuestFouls: '6', HomeBonus: ' ', GuestBonus: '<', Period: '3', Clock: clock, ShotClock: '22' };
  }
  return { PlayClock: '25', HomeScore: '14', GuestScore: '7', ToGo: '10', BallOn: '35', Down: '1', Quarter: '2', QuarterOrdinal: '2nd', Clock: clock, ClockStatus: ' ', HomePossession: '<', GuestPossession: ' ', HomeTimeouts: '3', GuestTimeouts: '2' };
}
function mqttBroker() {
  const subs = new Set();
  const server = net.createServer((sock) => {
    if (!sim.scorebot.running) { sock.destroy(); return; }
    let buf = Buffer.alloc(0);
    sock.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      while (buf.length >= 2) {
        let len = 0, mult = 1, i = 1, b;
        do { b = buf[i++]; len += (b & 127) * mult; mult *= 128; } while (b & 0x80 && i < buf.length);
        if (buf.length < i + len) return;
        const type = buf[0] >> 4, body = buf.subarray(i, i + len);
        buf = buf.subarray(i + len);
        if (type === 1) sock.write(Buffer.from([0x20, 2, 0, 0]));
        else if (type === 8) { sock.write(Buffer.from([0x90, 3, body[0], body[1], 0])); subs.add(sock); }
        else if (type === 12) sock.write(Buffer.from([0xd0, 0]));
        else if (type === 14) sock.end();
      }
    });
    sock.on('close', () => subs.delete(sock));
    sock.on('error', () => {});
  });
  server.timer = setInterval(() => {
    if (!sim.scorebot.running) { for (const s of subs) s.destroy(); subs.clear(); return; }
    if (!sim.scorebot.sending) return;
    const topic = Buffer.from('bot/0/json');
    const payload = Buffer.from(JSON.stringify(boardMessage()));
    const pkt = packet(3, 0, Buffer.concat([Buffer.from([topic.length >> 8, topic.length & 0xff]), topic, payload]));
    for (const s of subs) s.write(pkt);
  }, 1000);
  server.on('close', () => { clearInterval(server.timer); for (const s of subs) s.destroy(); });
  return server;
}

/* ---------------- OpenStatsEngine ---------------- */
let oseMessages = 0;
function oseHandler(req, res) {
  if (!sim.ose.running) { res.destroy(); return; }
  if (sim.ose.feedConnected && sim.scorebot.running && sim.scorebot.sending) oseMessages++;
  const feedOk = sim.ose.feedConnected && sim.scorebot.running;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    now: new Date().toISOString(),
    feed: { connected: feedOk, mode: 'mqtt', url: 'mqtt://127.0.0.1:1883/bot/0/json', topic: 'bot/0/json', messages: oseMessages, lastMessage: new Date().toISOString(), quietMs: sim.scorebot.sending ? 400 : 30000, stalled: feedOk && !sim.scorebot.sending, droppedAt: null, dropReason: feedOk ? null : 'connection lost', lastError: null, staleMs: 5000 },
    game: { id: 'g1', sport: sim.ose.sport, matchup: 'CEN at HOME', period: 2, periodLabel: 'Q2', clock: '7:42', running: true, score: { home: 14, away: 7 }, officialScore: { home: 14, away: 7 } }
  }));
}

/* ---------------- NDI (mDNS responder) ---------------- */
function labels(arr) { return Buffer.concat([...arr.map((l) => { const b = Buffer.from(l); return Buffer.concat([Buffer.from([b.length]), b]); }), Buffer.from([0])]); }
function rr(nameLabels, type, ttl, rdata) {
  const h = Buffer.alloc(10);
  h.writeUInt16BE(type, 0); h.writeUInt16BE(0x0001, 2); h.writeUInt32BE(ttl, 4); h.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([labels(nameLabels), h, rdata]);
}
/** An mDNS answer for these sources. `portOf(name)` gives each one's NDI TCP port. */
export function ndiResponse(sources, ttl = 120, portOf = () => 5961) {
  const svc = NDI_SERVICE.split('.');
  const recs = [];
  for (const name of sources) {
    recs.push(rr(svc, 12, ttl, labels([name, ...svc])));
    const srv = Buffer.alloc(6); srv.writeUInt16BE(0, 0); srv.writeUInt16BE(0, 2); srv.writeUInt16BE(portOf(name), 4);
    recs.push(rr([name, ...svc], 33, ttl, Buffer.concat([srv, labels(['sim-ndi', 'local'])])));
  }
  recs.push(rr(['sim-ndi', 'local'], 1, ttl, Buffer.from([127, 0, 0, 1])));
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(recs.length, 6);
  return Buffer.concat([header, ...recs]);
}

/**
 * Fake NDI senders: answer discovery like a real responder (with optional
 * unreliability), keep a TCP port open per source like a real sender, and
 * send a "goodbye" when a source is removed.
 */
function mdnsResponder(ndiBase) {
  const ports = new Map();
  let nextPort = ndiBase;
  const portOf = (n) => { if (!ports.has(n)) ports.set(n, nextPort++); return ports.get(n); };
  const tcp = new Map();
  let announced = new Set();
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('error', (e) => console.log(`  (NDI simulation unavailable: ${e.message})`));
  sock.on('message', (msg, rinfo) => {
    const n = sim.ndi;
    if (!n.enabled || !n.sources.length || n.discoverySilent || Math.random() > n.answerRate) return;
    try {
      if (parsePacket(msg).isResponse) return;
      if (!msg.toString('latin1').includes('_ndi')) return;
      const reply = ndiResponse(n.sources, 120, portOf);
      if (rinfo.port === MDNS_PORT) sock.send(reply, MDNS_PORT, MDNS_ADDR);
      else sock.send(reply, rinfo.port, rinfo.address);
    } catch { /* ignore */ }
  });
  sock.bind(MDNS_PORT, () => { try { sock.addMembership(MDNS_ADDR); sock.setMulticastLoopback(true); } catch (e) { console.log(`  (NDI multicast: ${e.message})`); } });

  const sync = setInterval(() => {
    const present = new Set(sim.ndi.enabled ? sim.ndi.sources : []);
    for (const name of present) {
      if (tcp.has(name)) continue;
      const srv = net.createServer((c) => c.destroy());
      srv.on('error', () => {});
      srv.listen(portOf(name), '127.0.0.1');
      tcp.set(name, srv);
    }
    for (const [name, srv] of tcp) if (!present.has(name)) { srv.close(); tcp.delete(name); }
    const gone = [...announced].filter((name) => !present.has(name));
    if (gone.length && sim.ndi.goodbye) { try { sock.send(ndiResponse(gone, 0, portOf), MDNS_PORT, MDNS_ADDR); } catch { /* closing */ } }
    announced = present;
  }, 300);

  return {
    close() {
      clearInterval(sync);
      try { sock.close(); } catch { /* */ }
      for (const srv of tcp.values()) srv.close();
    }
  };
}

/* ---------------- control page ---------------- */
function controlPage() {
  const btn = (name) => `<button onclick="scn('${name.replace(/'/g, "\\'")}')">${name}</button>`;
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Simulator</title>
<style>body{font:15px system-ui;background:#0b0f14;color:#e7edf4;margin:0;padding:20px;max-width:900px}h1{font-size:20px}button{font:inherit;margin:4px;padding:8px 12px;border-radius:8px;border:1px solid #2b3a4d;background:#18212c;color:#e7edf4;cursor:pointer}button:hover{background:#223040}pre{background:#121922;padding:12px;border-radius:8px;overflow:auto;font-size:13px}a{color:#60a5fa}</style>
<h1>Broadcast Monitor — simulator</h1>
<p>Dashboard: <a href="http://localhost:8090" target="_blank">http://localhost:8090</a> (in demo mode). Scenarios stack, so click <b>Pre-show</b> to reset.</p>
<div>${Object.keys(SCENARIOS).map(btn).join('')}</div>
<h2 style="font-size:16px">State</h2><pre id="s"></pre>
<script>
async function scn(n){await fetch('/scenario',{method:'POST',body:n});load()}
async function load(){document.getElementById('s').textContent=JSON.stringify(await (await fetch('/state')).json(),null,2)}
load();setInterval(load,2000);
</script>`;
}

function readBody(req) { return new Promise((r) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => r(d)); }); }

export function startSimulator({ quiet = false, ports = PORTS, mdns: withMdns = true } = {}) {
  const servers = [];
  const listen = (srv, port, name) => new Promise((resolve) => {
    srv.on('error', (e) => { console.error(`  ${name}: ${e.message}`); resolve(); });
    srv.listen(port, '127.0.0.1', () => { if (!quiet) console.log(`  ${name.padEnd(16)} 127.0.0.1:${port}`); resolve(); });
    servers.push(srv);
  });

  const vmix = http.createServer((req, res) => {
    if (!sim.vmix.online) { res.destroy(); return; }
    res.writeHead(200, { 'Content-Type': 'text/xml' }); res.end(vmixXml());
  });
  const yt = http.createServer(async (req, res) => youtubeHandler(req, res, await readBody(req)));
  const ose = http.createServer((req, res) => oseHandler(req, res));
  const control = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname === '/scenario') {
      const name = await readBody(req);
      const sc = SCENARIOS[name];
      if (!sc) { res.writeHead(404); res.end('unknown scenario'); return; }
      for (const [k, v] of Object.entries(sc)) setPath(k, v);
      res.end('ok'); return;
    }
    if (req.method === 'POST' && url.pathname === '/set') {
      for (const [k, v] of url.searchParams) setPath(k, v);
      res.end('ok'); return;
    }
    if (url.pathname === '/state') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(sim)); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(controlPage());
  });
  const mqtt = mqttBroker();
  const mdns = withMdns ? mdnsResponder(ports.ndiBase || PORTS.ndiBase) : null;

  const ready = Promise.all([
    listen(control, ports.control, 'Control page'),
    listen(vmix, ports.vmix, 'vMix API'),
    listen(yt, ports.youtube, 'YouTube API'),
    listen(ose, ports.ose, 'OpenStatsEngine'),
    listen(mqtt, ports.mqtt, 'ScoreConnect MQTT')
  ]);
  return {
    ready,
    close: () => {
      for (const s of servers) { s.close(); s.closeAllConnections?.(); }
      mdns?.close();
    }
  };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('simulator.js')) {
  console.log('\n  Broadcast Monitor simulator\n');
  startSimulator().ready.then(() => console.log(`\n  Control page: http://localhost:${PORTS.control}\n`));
}
