import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQuery, parsePacket, ndiSourcesFrom, readName } from '../src/lib/mdns.js';
import { ndiResponse } from '../tools/simulator.js';

test('query asks for _ndi._tcp.local PTR', () => {
  const q = buildQuery();
  assert.equal(q.readUInt16BE(4), 1);
  const { labels, end } = readName(q, 12);
  assert.deepEqual(labels, ['_ndi', '_tcp', 'local']);
  assert.equal(q.readUInt16BE(end), 12);
});

test('parses NDI sources from a response', () => {
  const p = parsePacket(ndiResponse(['CAM-PC (Camera 1)', 'GFX (Output)']));
  assert.equal(p.isResponse, true);
  const s = ndiSourcesFrom(p);
  assert.deepEqual(s.map((x) => x.name).sort(), ['CAM-PC (Camera 1)', 'GFX (Output)']);
  assert.equal(s[0].port, 5961);
  assert.equal(s[0].address, '127.0.0.1');
});

test('follows compression pointers', () => {
  // header + question "_ndi._tcp.local" + PTR answer whose name points back at the question
  const hdr = Buffer.from([0, 0, 0x84, 0, 0, 1, 0, 1, 0, 0, 0, 0]);
  const qname = Buffer.from([4, ...Buffer.from('_ndi'), 4, ...Buffer.from('_tcp'), 5, ...Buffer.from('local'), 0]);
  const qtail = Buffer.from([0, 12, 0, 1]);
  const inst = Buffer.from('BOX (Cam)');
  const rdata = Buffer.concat([Buffer.from([inst.length]), inst, Buffer.from([0xc0, 12])]);
  const ans = Buffer.concat([Buffer.from([0xc0, 12, 0, 12, 0, 1, 0, 0, 0, 120, 0, rdata.length]), rdata]);
  const p = parsePacket(Buffer.concat([hdr, qname, qtail, ans]));
  assert.deepEqual(ndiSourcesFrom(p).map((x) => x.name), ['BOX (Cam)']);
});

test('goodbye packets carry ttl 0', () => {
  const s = ndiSourcesFrom(parsePacket(ndiResponse(['X (Y)'], 0)));
  assert.equal(s[0].ttl, 0);
});

test('rejects garbage without throwing past parsePacket', () => {
  assert.throws(() => parsePacket(Buffer.from([1, 2, 3])));
  const loop = Buffer.concat([Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0]), Buffer.from([0xc0, 12])]);
  assert.throws(() => parsePacket(loop));
});
