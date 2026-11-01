/**
 * End to end: the real App against the simulator on spare ports.
 * Walks the show from standby to live and through a few failures.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startSimulator, setPath, SCENARIOS } from '../tools/simulator.js';
import { ConfigStore } from '../src/config.js';
import { App } from '../src/app.js';
import { createServer } from '../src/http.js';

const P = { control: 28000, vmix: 28088, ose: 28080, youtube: 28443, mqtt: 21883 };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const scenario = (name) => { for (const [k, v] of Object.entries(SCENARIOS[name])) setPath(k, v); };

async function until(app, pred, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    app.flush();
    if (pred(app.snapshot)) return app.snapshot;
    await wait(250);
  }
  app.flush();
  return app.snapshot;
}
const ids = (s) => s.issues.map((i) => i.id);

test('full show walk-through against the simulator', { timeout: 120000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-e2e-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    vmix: { port: P.vmix, pollMs: 100 },
    youtube: { clientId: 'c', clientSecret: 's', apiBase: `http://127.0.0.1:${P.youtube}`, oauthBase: `http://127.0.0.1:${P.youtube}`, pollOnAirSec: 1, pollIdleSec: 1, ingestGraceSec: 12 },
    scorebot: { mqtt: { port: P.mqtt }, silentAfterSec: 3, ping: { enabled: false } },
    ose: { url: `http://127.0.0.1:${P.ose}`, pollSec: 1 },
    audio: { low: { durationSec: 2 }, sources: [{ label: 'Master', bus: 'master', mutedLevel: 'crit' }] },
    ndi: { enabled: false }
  }));
  fs.writeFileSync(path.join(dir, 'youtube-token.json'), JSON.stringify({ refresh_token: 'demo-refresh' }));

  const sim = startSimulator({ quiet: true, ports: P });
  await sim.ready;
  scenario('Pre-show (standby)');
  const config = new ConfigStore(path.join(dir, 'config.json'));
  const app = new App({ config, dataDir: dir });
  app.start();
  const server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { app.stop(); server.close(); server.closeAllConnections?.(); sim.close(); });

  await t.test('standby is green', async () => {
    const s = await until(app, (x) => x.overall.level === 'ok' && x.cards.find((c) => c.id === 'scorebot').level === 'ok');
    assert.equal(s.overall.level, 'ok', JSON.stringify(s.issues));
    assert.equal(s.onAir, false);
    assert.match(s.overall.detail, /Standby/);
  });

  await t.test('streaming in preview turns red: press Go Live', async () => {
    scenario('Streaming, NOT live (preview)');
    const s = await until(app, (x) => ids(x).includes('youtube.not_live'));
    assert.equal(s.overall.level, 'crit');
    assert.match(s.overall.headline, /Go Live/);
  });

  await t.test('live is green with viewers', async () => {
    scenario('LIVE — all good');
    const s = await until(app, (x) => x.overall.level === 'ok' && x.live.youtube);
    assert.equal(s.overall.level, 'ok', JSON.stringify(s.issues));
    assert.match(s.overall.detail, /LIVE on YouTube/);
  });

  await t.test('silent program audio goes yellow, muted goes red', async () => {
    scenario('Audio silent');
    let s = await until(app, (x) => ids(x).includes('audio.master.low'));
    assert.equal(s.overall.level, 'warn');
    scenario('Master muted');
    s = await until(app, (x) => ids(x).includes('audio.master.muted'));
    assert.equal(s.overall.level, 'crit');
    setPath('vmix.masterMuted', false); setPath('vmix.audio', 'normal');
  });

  await t.test('wrong sport on the scorebot', async () => {
    scenario('Scorebot on wrong sport');
    const s = await until(app, (x) => ids(x).includes('scorebot.wrong_sport'));
    assert.match(s.issues.find((i) => i.id === 'scorebot.wrong_sport').title, /Soccer, not Football/);
    setPath('scorebot.sport', 'football');
  });

  await t.test('scorebot silence', async () => {
    scenario('Scorebot stopped sending');
    const s = await until(app, (x) => ids(x).includes('scorebot.silent'));
    assert.ok(s);
    setPath('scorebot.sending', true);
    const back = await until(app, (x) => !ids(x).includes('scorebot.silent'));
    assert.ok(!ids(back).includes('scorebot.silent'));
  });

  await t.test('OSE feed problem is pinned on OSE, not the scorebot', async () => {
    scenario('OSE not connected to feed');
    const s = await until(app, (x) => ids(x).includes('ose.feed_down'));
    assert.ok(!ids(s).some((i) => i.startsWith('scorebot.')));
    setPath('ose.feedConnected', true);
  });

  await t.test('today\'s sport can be pinned from the dashboard API', async () => {
    const r = await fetch(`${base}/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedSport: 'soccer' }) });
    assert.equal(r.status, 200);
    const s = await until(app, (x) => ids(x).includes('ose.wrong_sport'));
    assert.ok(ids(s).includes('ose.wrong_sport'));
    const bad = await fetch(`${base}/api/settings`, { method: 'POST', body: JSON.stringify({ expectedSport: 'curling' }) });
    assert.equal(bad.status, 400);
    await fetch(`${base}/api/settings`, { method: 'POST', body: JSON.stringify({ expectedSport: 'auto' }) });
  });

  await t.test('YouTube live with vMix stopped is red', async () => {
    scenario('LIVE — vMix stopped streaming');
    const s = await until(app, (x) => ids(x).includes('youtube.live_no_vmix'));
    assert.equal(s.overall.level, 'crit');
  });

  await t.test('vMix offline is red', async () => {
    scenario('vMix offline');
    const s = await until(app, (x) => ids(x).includes('vmix.offline'));
    assert.equal(s.overall.level, 'crit');
    setPath('vmix.online', true);
  });

  await t.test('status endpoint and SSE stream', async () => {
    const st = await (await fetch(`${base}/api/status`)).json();
    assert.ok(['ok', 'warn', 'crit'].includes(st.level));
    const res = await fetch(`${base}/events`);
    const reader = res.body.getReader();
    let text = '';
    while (!text.includes('data: ')) text += new TextDecoder().decode((await reader.read()).value);
    reader.cancel();
    assert.match(text, /"overall"/);
    const page = await fetch(`${base}/`);
    assert.match(await page.text(), /Broadcast Monitor/);
    assert.equal((await fetch(`${base}/../package.json`)).status, 404);
  });

  await t.test('YouTube device sign-in flow', async () => {
    await fetch(`${base}/api/youtube/auth/logout`, { method: 'POST' });
    let s = await until(app, (x) => x.cards.find((c) => c.id === 'youtube').status === 'Not connected');
    assert.ok(s.issues.some((i) => i.id === 'youtube.auth'));
    await fetch(`${base}/api/youtube/auth/start`, { method: 'POST' });
    s = await until(app, (x) => x.cards.find((c) => c.id === 'youtube').notice?.code === 'BCST-DEMO', 5000);
    assert.equal(s.cards.find((c) => c.id === 'youtube').notice.code, 'BCST-DEMO');
    s = await until(app, (x) => x.cards.find((c) => c.id === 'youtube').status !== 'Waiting for sign-in' && !ids(x).includes('youtube.auth'), 15000);
    assert.ok(!ids(s).includes('youtube.auth'));
    assert.ok(fs.existsSync(path.join(dir, 'youtube-token.json')));
  });
});
