/**
 * Browser sign-in where you pick the channel: start → Google (simulated)
 * chooser → back to us, plus the paste-the-address path for other devices.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startSimulator, SIM_CHANNELS } from '../tools/simulator.js';
import { ConfigStore } from '../src/config.js';
import { App } from '../src/app.js';
import { createServer } from '../src/http.js';

const P = { control: 38000, vmix: 38088, ose: 38080, youtube: 38443, mqtt: 31883 };
const G = `http://127.0.0.1:${P.youtube}`;

test('choose a channel with browser sign-in', { timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-yt-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    vmix: { enabled: false }, audio: { enabled: false }, scorebot: { enabled: false }, ose: { enabled: false }, ndi: { enabled: false },
    youtube: { clientType: 'desktop', clientId: 'c', clientSecret: 's', apiBase: G, oauthBase: G, authBase: `${G}/o/oauth2/v2/auth`, pollIdleSec: 1 }
  }));
  const sim = startSimulator({ quiet: true, ports: P });
  await sim.ready;
  const app = new App({ config: new ConfigStore(path.join(dir, 'config.json')), dataDir: dir });
  app.start();
  const server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  t.after(() => { app.stop(); server.close(); server.closeAllConnections?.(); sim.close(); });
  const card = () => { app.flush(); return app.snapshot.cards.find((c) => c.id === 'youtube'); };
  const go = (url) => fetch(url, { redirect: 'manual' });

  /** Start sign-in and return the URL of the simulated Google chooser link for `channel`. */
  async function startAndPick(channel) {
    const start = await go(`${base}/oauth/youtube/start`);
    assert.equal(start.status, 302);
    const google = new URL(start.headers.get('location'));
    assert.equal(google.origin + google.pathname, `${G}/o/oauth2/v2/auth`);
    assert.equal(google.searchParams.get('redirect_uri'), `http://127.0.0.1:${port}/oauth/youtube`);
    assert.match(google.searchParams.get('prompt'), /select_account/);
    assert.equal(google.searchParams.get('access_type'), 'offline');
    assert.equal(google.searchParams.get('code_challenge_method'), 'S256');
    const chooser = await (await fetch(google)).text();
    const href = chooser.match(new RegExp(`id="pick-${channel}" href="([^"]+)"`))[1].replace(/&amp;/g, '&');
    const back = await go(`${G}${href}`);
    assert.equal(back.status, 302);
    return back.headers.get('location'); // → our /oauth/youtube?code=…&state=…
  }

  await t.test('not signed in: the card offers channel sign-in', () => {
    const c = card();
    assert.equal(c.status, 'Not connected');
    assert.equal(c.actions[0].href, '/oauth/youtube/start');
    assert.equal(c.actions[0].newTab, true);
  });

  await t.test('pick the personal channel, come back to the dashboard', async () => {
    const back = await startAndPick('personal');
    assert.ok(back.startsWith(`http://127.0.0.1:${port}/oauth/youtube?`));
    assert.equal(card().status, 'Waiting for sign-in');
    assert.equal(card().controls[0].post, '/api/youtube/auth/code');
    const page = await fetch(back);
    assert.equal(page.status, 200);
    assert.match(await page.text(), new RegExp(`Connected to the channel &quot;${SIM_CHANNELS.personal.replace(/[()]/g, '\\$&')}&quot;`));
    const tok = JSON.parse(fs.readFileSync(path.join(dir, 'youtube-token.json'), 'utf8'));
    assert.equal(tok.refresh_token, 'demo-refresh-personal');
    assert.equal(tok.channel, SIM_CHANNELS.personal);
    assert.equal(card().rows[0].value, SIM_CHANNELS.personal);
  });

  await t.test('switch to the Brand Account channel by pasting the address (other device)', async () => {
    assert.ok(card().actions.some((a) => a.label === 'Switch channel'));
    const back = await startAndPick('brand');
    const r = await fetch(`${base}/api/youtube/auth/code`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: `  ${back}  ` }) });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).channel, SIM_CHANNELS.brand);
    assert.equal(card().rows[0].value, SIM_CHANNELS.brand);
    // a used code cannot be replayed
    const again = await fetch(back);
    assert.equal(again.status, 400);
  });

  await t.test('a link from another attempt is refused', async () => {
    const back = await startAndPick('personal');
    await go(`${base}/oauth/youtube/start`); // a newer attempt replaces the old one
    const r = await fetch(`${base}/api/youtube/auth/code`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: back }) });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /doesn't belong/);
    const junk = await fetch(`${base}/api/youtube/auth/code`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'hello' }) });
    assert.match((await junk.json()).error, /whole address/);
  });

  await t.test('cancelling on Google is reported, and the old channel stays connected', async () => {
    const start = await go(`${base}/oauth/youtube/start`);
    const google = new URL(start.headers.get('location'));
    const chooser = await (await fetch(google)).text();
    const cancel = chooser.match(/id="pick-cancel" href="([^"]+)"/)[1].replace(/&amp;/g, '&');
    const page = await fetch(cancel);
    assert.equal(page.status, 400);
    assert.match(await page.text(), /cancelled/);
    assert.equal(card().rows[0].value, SIM_CHANNELS.brand);
  });

  await t.test('tv client type keeps the code sign-in', async () => {
    app.config.update({ 'youtube.clientType': 'tv' });
    const c = card();
    assert.ok(c.actions.some((a) => a.label === 'Reconnect' && a.post === '/api/youtube/auth/start'));
  });
});
