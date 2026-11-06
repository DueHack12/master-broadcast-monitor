/**
 * NDI discovery against simulated senders: found, kept through flaky or
 * silent discovery (port still open), and only then called offline.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dgram from 'node:dgram';
import { startSimulator, setPath } from '../tools/simulator.js';
import { pickInterfaces, sendOnEach } from '../src/lib/mdns.js';
import { ConfigStore } from '../src/config.js';
import { App } from '../src/app.js';

const P = { control: 48000, vmix: 48088, ose: 48080, youtube: 48443, mqtt: 41883, ndiBase: 45961 };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = `T${process.pid}`;
const CAM1 = `${tag}-PC (Cam 1)`, CAM2 = `${tag}-PC (Cam 2)`;

/**
 * Can this machine hear its own multicast? Not on every CI machine: macOS
 * blocks local-network multicast for processes without the Local Network
 * permission, and a build machine cannot grant it.
 */
async function multicastHere() {
  const ifs = pickInterfaces().map((i) => i.address);
  const GROUP = '239.255.77.77', PORT = 47777;
  const open = () => new Promise((resolve) => {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    s.on('error', () => resolve(null));
    s.bind(PORT, () => resolve(s));
  });
  const rx = await open(), tx = await open();
  if (!rx || !tx) { rx?.close(); tx?.close(); return { ok: false, why: 'could not bind a UDP port' }; }
  for (const ip of ifs) { try { rx.addMembership(GROUP, ip); } catch { /* reported below */ } }
  tx.setMulticastLoopback(true);
  const heard = new Promise((resolve) => { rx.on('message', () => resolve(true)); setTimeout(() => resolve(false), 1500); });
  const errors = await sendOnEach(tx, Buffer.from('probe'), ifs, PORT, GROUP);
  const ok = await heard;
  rx.close(); tx.close();
  return { ok, why: `interfaces: ${ifs.join(', ') || 'none'}${errors.length ? `; send errors: ${errors.join('; ')}` : '; sent without error but nothing arrived'}` };
}

const mc = await multicastHere();
if (!mc.ok) console.log(`# NDI end-to-end test skipped: multicast does not loop back on this machine (${mc.why})`);

test('NDI sources stay put until they are really gone', { timeout: 90000, skip: mc.ok ? false : `multicast unavailable here (${mc.why})` }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-ndi-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    vmix: { enabled: false }, audio: { enabled: false }, youtube: { enabled: false }, scorebot: { enabled: false }, ose: { enabled: false },
    ndi: { expected: [`${tag}-PC (Cam 1)`, 'Cam 2'], scanIntervalSec: 1, goneAfterSec: 4 }
  }));
  setPath('ndi.sources', [CAM1, CAM2]);
  const sim = startSimulator({ quiet: true, ports: P });
  await sim.ready;
  const app = new App({ config: new ConfigStore(path.join(dir, 'config.json')), dataDir: dir });
  app.start();
  t.after(() => { app.stop(); sim.close(); });

  const ndi = () => app.monitors.ndi;
  const names = () => ndi().online().map((s) => s.name).sort();
  const offlineLogs = () => app.log.recent(200).filter((e) => /went offline/.test(e.text)).map((e) => e.text);
  async function until(pred, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (pred()) return true; await wait(100); }
    return pred();
  }

  await t.test('finds both sources', async () => {
    assert.ok(await until(() => names().length === 2, 6000), `saw [${names()}]; discovery: ${JSON.stringify({ ...ndi().browser.stats, others: [...ndi().browser.stats.others.keys()] })}`);
    const st = ndi().browser.stats;
    assert.equal(st.mode, 'shared');
    assert.ok(st.interfaces.length >= 1, 'searching at least one network');
    assert.ok(st.interfaces.every((i) => !i.address.startsWith('127.')), 'loopback is not searched');
    app.flush();
    assert.equal(app.issues.filter((i) => i.id.startsWith('ndi.')).length, 0);
  });

  await t.test('discovery goes quiet, senders still running: no false "offline"', async () => {
    setPath('ndi.discoverySilent', true);
    await wait(7000); // well past goneAfterSec (4 s)
    assert.deepEqual(names(), [CAM1, CAM2].sort());
    assert.deepEqual(offlineLogs(), []);
    assert.ok(ndi().online().every((s) => s.via === 'tcp'), 'kept alive by the port check');
    app.flush();
    const card = app.snapshot.cards.find((c) => c.id === 'ndi');
    assert.ok(card.list.items.some((i) => /port check/.test(i.detail)));
    setPath('ndi.discoverySilent', false);
  });

  await t.test('unreliable discovery (30% answers) does not flap', async () => {
    setPath('ndi.answerRate', 0.3);
    await wait(8000);
    assert.deepEqual(names(), [CAM1, CAM2].sort());
    assert.deepEqual(offlineLogs(), []);
    setPath('ndi.answerRate', 1);
  });

  await t.test('a sender that shuts down (signs off, port closes) goes offline within seconds', async () => {
    const started = Date.now();
    setPath('ndi.sources', [CAM1]);
    assert.ok(await until(() => !names().includes(CAM2), 5000), 'Cam 2 removed');
    assert.ok(Date.now() - started < 4500, `took ${Date.now() - started} ms`);
    assert.match(offlineLogs().join('\n'), /Cam 2.*signed off/);
    app.flush();
    assert.ok(app.issues.some((i) => i.id === 'ndi.missing.cam_2'));
  });

  await t.test('a sender that vanishes without a word is caught after goneAfterSec', async () => {
    setPath('ndi.goodbye', false);
    setPath('ndi.sources', []);
    const started = Date.now();
    assert.ok(await until(() => names().length === 0, 12000), `still have ${names()}`);
    const took = Date.now() - started;
    assert.ok(took > 3000 && took < 9000, `took ${took} ms`);
    assert.match(offlineLogs().join('\n'), /Cam 1/);
  });

  await t.test('and it comes back', async () => {
    setPath('ndi.goodbye', true);
    setPath('ndi.sources', [CAM1, CAM2]);
    assert.ok(await until(() => names().length === 2, 6000));
    app.flush();
    assert.equal(app.issues.filter((i) => i.id.startsWith('ndi.')).length, 0);
  });
});
