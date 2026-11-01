import test from 'node:test';
import assert from 'node:assert/strict';
import { detectSport, fingerprint, sportIdFromName } from '../src/lib/sports.js';
import { pingArgs, parsePing } from '../src/lib/ping.js';
import { overrideLevel, worst } from '../src/levels.js';
import { deepMerge, DEFAULTS } from '../src/config.js';
import { pick } from '../src/monitors/audio.js';
import { pickBroadcast } from '../src/monitors/youtube.js';

test('VendorSportId 23 is soccer; unknown IDs fall back to a guess', () => {
  assert.deepEqual(detectSport({ VendorSportId: 23, HomeScore: '1' }), { vendorId: '23', sport: 'soccer', method: 'id', candidates: ['soccer'] });
  const g = detectSport({ VendorSportId: 7, Down: '2', ToGo: '5' });
  assert.equal(g.vendorId, '7');
  assert.equal(g.sport, 'football');
  assert.equal(g.method, 'guess');
  assert.equal(detectSport({ VendorSportId: 7 }, { 7: 'basketball' }).sport, 'basketball');
});

test('field fingerprints', () => {
  assert.deepEqual(fingerprint({ Balls: '1', Strikes: '2', Outs: '0' }), ['baseball']);
  assert.deepEqual(fingerprint({ HomeCornerKicks: ' 2' }), ['soccer']);
  assert.deepEqual(fingerprint({ HomeFouls: '3' }), ['basketball']);
  assert.deepEqual(fingerprint({ HomePenalty1: '1:00' }), ['hockey', 'lacrosse']);
  assert.deepEqual(fingerprint({ Clock: '1:00' }), []);
});

test('OSE sport names map to ids', () => {
  assert.equal(sportIdFromName('Ice Hockey'), 'hockey');
  assert.equal(sportIdFromName('Baseball / Softball'), 'baseball');
  assert.equal(sportIdFromName('Football'), 'football');
  assert.equal(sportIdFromName(''), null);
});

test('ping flags per platform', () => {
  assert.deepEqual(pingArgs('10.0.0.5', 1000, 'win32'), ['-n', '1', '-w', '1000', '10.0.0.5']);
  assert.deepEqual(pingArgs('10.0.0.5', 1000, 'darwin'), ['-c', '1', '-W', '1000', '10.0.0.5']);
  assert.deepEqual(pingArgs('10.0.0.5', 1500, 'linux'), ['-c', '1', '-W', '2', '10.0.0.5']);
});

test('ping output parsing, including the Windows false success', () => {
  assert.deepEqual(parsePing('Reply from 10.0.0.5: bytes=32 time=3ms TTL=128', true, 'win32'), { ok: true, rttMs: 3 });
  assert.deepEqual(parsePing('Reply from 10.0.0.5: bytes=32 time<1ms TTL=128', true, 'win32'), { ok: true, rttMs: 1 });
  assert.equal(parsePing('Reply from 10.0.0.1: Destination host unreachable.', true, 'win32').ok, false);
  assert.deepEqual(parsePing('64 bytes from 127.0.0.1: icmp_seq=0 ttl=64 time=0.051 ms', true, 'darwin'), { ok: true, rttMs: 0.051 });
  assert.equal(parsePing('1 packets transmitted, 0 received', false, 'linux').ok, false);
});

test('alert overrides: exact beats wildcard, longest wildcard wins', () => {
  const o = { 'scorebot.*': 'crit', 'scorebot.silent': 'info', 'audio.*.low': 'off', '*': 'warn' };
  assert.equal(overrideLevel('scorebot.silent', 'warn', o), 'info');
  assert.equal(overrideLevel('scorebot.host_down', 'warn', o), 'crit');
  assert.equal(overrideLevel('audio.program_master.low', 'warn', o), 'off');
  assert.equal(overrideLevel('vmix.offline', 'crit', {}), 'crit');
  assert.equal(worst(['info', 'warn', 'ok']), 'warn');
});

test('config deep-merges and skips _help keys', () => {
  const c = deepMerge(DEFAULTS, { _help: 'x', audio: { low: { durationSec: 20 } }, ndi: { expected: ['A'] } });
  assert.equal(c.audio.low.durationSec, 20);
  assert.equal(c.audio.low.thresholdDb, -50);
  assert.deepEqual(c.ndi.expected, ['A']);
  assert.equal(c._help, undefined);
});

test('audio source lookup by bus, number, title', () => {
  const d = { buses: { master: { left: -10 }, busA: { left: -20 } }, inputs: [{ number: 3, title: 'Mic 1', shortTitle: 'Mic' }, { number: 4, title: 'Commentary Mic', shortTitle: '' }] };
  assert.equal(pick(d, { bus: 'master' }).left, -10);
  assert.equal(pick(d, { bus: 'A' }).left, -20);
  assert.equal(pick(d, { input: 3 }).title, 'Mic 1');
  assert.equal(pick(d, { input: 'mic 1' }).title, 'Mic 1');
  assert.equal(pick(d, { input: 'commentary' }).title, 'Commentary Mic');
  assert.equal(pick(d, { input: 'nope' }), null);
});

test('broadcast picking prefers live, then the one actually receiving', () => {
  const b = (id, lc, stream) => ({ id, status: { lifeCycleStatus: lc }, contentDetails: { boundStreamId: stream }, snippet: {} });
  const streams = [{ id: 's2', status: { streamStatus: 'active' } }];
  assert.equal(pickBroadcast([b('a', 'ready', 's1'), b('b', 'live', 's1')], streams).id, 'b');
  assert.equal(pickBroadcast([b('a', 'ready', 's1'), b('b', 'ready', 's2')], streams).id, 'b');
  assert.equal(pickBroadcast([], streams), null);
});
