import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validate, checkField, FIELDS, SECTIONS } from '../public/settings-schema.js';
import { ConfigStore, DEFAULTS } from '../src/config.js';
import { App } from '../src/app.js';
import { createServer } from '../src/http.js';

const field = (p) => FIELDS.find((f) => f.path === p);

test('every schema path exists in the defaults', () => {
  const get = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
  for (const f of FIELDS) assert.notEqual(get(DEFAULTS, f.path), undefined, f.path);
  for (const s of SECTIONS) assert.ok(s.title && s.id);
});

test('field checks', () => {
  assert.deepEqual(checkField(field('vmix.port'), '8088'), { value: 8088 });
  assert.ok(checkField(field('vmix.port'), '70000').error);
  assert.ok(checkField(field('vmix.host'), 'http://10.0.0.5').error);
  assert.ok(checkField(field('vmix.host'), '').error);
  assert.deepEqual(checkField(field('vmix.host'), ' 10.0.0.5 '), { value: '10.0.0.5' });
  assert.ok(checkField(field('audio.low.thresholdDb'), '-5').error);
  assert.deepEqual(checkField(field('audio.low.thresholdDb'), '-45'), { value: -45 });
  assert.ok(checkField(field('audio.low.durationSec'), '').error);
  assert.ok(checkField(field('ose.url'), 'localhost:8080').error);
  assert.deepEqual(checkField(field('ose.url'), 'http://10.0.0.9:8080/'), { value: 'http://10.0.0.9:8080' });
  assert.deepEqual(checkField(field('publicUrl'), ''), { value: '' });
  assert.deepEqual(checkField(field('vmix.youtubeChannels'), [2, 1, 2]), { value: [1, 2] });
  assert.ok(checkField(field('vmix.youtubeChannels'), []).error);
  assert.ok(checkField(field('notify.pushcut.minLevel'), 'loud').error);
  assert.deepEqual(checkField(field('notify.twilio.to'), ['+1 (555) 123-4567', '']), { value: ['+15551234567'] });
  assert.ok(checkField(field('notify.twilio.to'), ['call me']).error);
  assert.deepEqual(checkField(field('ndi.expected'), [' Camera 1 ', '']), { value: ['Camera 1'] });
});

test('secrets: replace, clear, validate urls', () => {
  assert.deepEqual(checkField(field('notify.twilio.authToken'), null), { value: '' });
  assert.deepEqual(checkField(field('notify.twilio.authToken'), 'abc'), { value: 'abc' });
  assert.ok(checkField(field('notify.pushcut.url'), 'not a url').error);
  assert.deepEqual(checkField(field('notify.pushcut.url'), 'https://api.pushcut.io/x/notifications/A'), { value: 'https://api.pushcut.io/x/notifications/A' });
});

test('audio sources', () => {
  const f = field('audio.sources');
  assert.deepEqual(checkField(f, [{ label: '', bus: 'master', mutedLevel: 'crit' }, { label: 'Mic', input: 'Mic 1' }]),
    { value: [{ label: 'Program (Master)', bus: 'master', mutedLevel: 'crit' }, { label: 'Mic', input: 'Mic 1' }] });
  assert.ok(checkField(f, [{ bus: 'Z' }]).error);
  assert.ok(checkField(f, [{ input: '' }]).error);
});

test('validate only touches what was sent, and rejects unknown keys', () => {
  const r = validate({ 'vmix.host': '10.0.0.5', 'vmix.port': 'x', 'nope.key': 1, 'youtube.clientSecret': undefined });
  assert.deepEqual(r.values, { 'vmix.host': '10.0.0.5' });
  assert.ok(r.errors['vmix.port']);
  assert.ok(r.errors['nope.key']);
  assert.equal('youtube.clientSecret' in r.values, false);
});

test('ConfigStore.update keeps hand-written keys and notes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-set-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ _help: 'mine', alerts: { overrides: { 'scorebot.*': 'crit' } }, vmix: { host: '1.2.3.4', _note: 'keep' } }, null, 2));
  const c = new ConfigStore(file);
  let source = null;
  c.on('change', (_, s) => { source = s; });
  c.update({ 'vmix.host': '10.0.0.5', 'audio.low.durationSec': 20 });
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw._help, 'mine');
  assert.equal(raw.vmix._note, 'keep');
  assert.equal(raw.vmix.host, '10.0.0.5');
  assert.deepEqual(raw.alerts.overrides, { 'scorebot.*': 'crit' });
  assert.deepEqual(raw.audio, { low: { durationSec: 20 } });
  assert.equal(c.current.audio.low.thresholdDb, -50, 'defaults still fill the rest');
  assert.equal(source, 'settings');
});

test('ConfigStore.update refuses to overwrite a file with a typo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-set-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{ "vmix": { "host": "1.2.3.4", } ');
  const c = new ConfigStore(file);
  assert.throws(() => c.update({ 'vmix.host': '10.0.0.5' }), /typo/);
  assert.match(fs.readFileSync(file, 'utf8'), /1\.2\.3\.4/);
});

test('settings API end to end', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-set-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({
    vmix: { host: '127.0.0.1', port: 1 }, youtube: { enabled: false }, scorebot: { enabled: false }, ose: { enabled: false }, ndi: { enabled: false },
    notify: { twilio: { authToken: 'SECRET-TOKEN' } }
  }));
  const config = new ConfigStore(file);
  const app = new App({ config, dataDir: path.join(dir, 'data') });
  app.start();
  const server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { app.stop(); server.close(); server.closeAllConnections?.(); });
  const post = (values) => fetch(`${base}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values }) });

  const got = await (await fetch(`${base}/api/config`)).json();
  assert.equal(got.values['notify.twilio.authToken'], '', 'secret not sent back');
  assert.equal(got.secretsSet['notify.twilio.authToken'], true);
  assert.equal(got.values['vmix.port'], 1);
  assert.ok(!JSON.stringify(got).includes('SECRET-TOKEN'));

  const bad = await post({ 'vmix.port': 99999, 'vmix.host': 'http://x' });
  assert.equal(bad.status, 400);
  const be = await bad.json();
  assert.ok(be.errors['vmix.port'] && be.errors['vmix.host']);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).vmix.port, 1, 'nothing written on error');

  const ok = await post({ 'vmix.port': 18088, 'audio.low.durationSec': 15, 'stationName': 'Field 2' });
  assert.equal(ok.status, 200);
  assert.equal(app.cfg.vmix.port, 18088);
  assert.equal(app.monitors.vmix.cfg.port, 18088, 'monitors restarted with the new value');
  assert.equal(app.cfg.audio.low.durationSec, 15);
  assert.equal(app.cfg.notify.twilio.authToken, 'SECRET-TOKEN', 'untouched secret kept');
  assert.ok(app.log.recent().some((e) => /Settings saved/.test(e.text)));

  await post({ 'notify.twilio.authToken': null });
  assert.equal(app.cfg.notify.twilio.authToken, '', 'secret cleared');

  const page = await fetch(`${base}/settings`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /settings\.js/);
  const schema = await fetch(`${base}/settings-schema.js`);
  assert.match(schema.headers.get('content-type'), /javascript/);
});
