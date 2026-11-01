import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { GENESIS, createAudit } from '../src/audit.js';

const fill = (a, n = 5) => { for (let i = 0; i < n; i++) a.append('decision', `call-${i}`, { decision: 'allow', i }); };

test('an empty trail verifies; a filled one verifies and the head moves', () => {
  const a = createAudit();
  assert.equal(a.verify().ok, true);
  fill(a);
  const v = a.verify();
  assert.equal(v.ok, true);
  assert.equal(v.length, 5);
  assert.equal(v.headSeq, 5);
  assert.match(v.headHash, /^[0-9a-f]{64}$/);
  assert.equal(a.list()[0].prevHash, GENESIS);
});

test('tamper detection: editing a field of any entry is found at that entry', () => {
  for (const field of ['type', 'callId', 'data', 'at']) {
    const store = [];
    const a = createAudit({ store });
    fill(a);
    const e = store[2];
    store[2] = { ...e, [field]: field === 'data' ? { decision: 'deny' } : 'x' };
    const v = a.verify();
    assert.equal(v.ok, false, field);
    assert.equal(v.firstBadSeq, 3);
    assert.equal(v.reason, 'hash_mismatch');
  }
});

test('tamper detection: deleting, inserting, reordering and truncating the middle are all found', () => {
  const mk = () => { const store = []; const a = createAudit({ store }); fill(a); return { store, a }; };
  let { store, a } = mk();
  store.splice(2, 1);
  assert.equal(a.verify().ok, false, 'delete');
  ({ store, a } = mk());
  store.splice(2, 0, { ...store[1] });
  assert.equal(a.verify().ok, false, 'insert');
  ({ store, a } = mk());
  [store[1], store[2]] = [store[2], store[1]];
  assert.equal(a.verify().ok, false, 'reorder');
  ({ store, a } = mk());
  store[0] = { ...store[0], hash: 'f'.repeat(64) };
  assert.equal(a.verify().ok, false, 'forged hash');
});

test('a forger who recomputes the chain with a plain SHA-256 (no key) still fails verification', () => {
  const store = [];
  const a = createAudit({ store });
  fill(a);
  const canonical = (v) => JSON.stringify(v, Object.keys(v).sort());
  let prev = GENESIS;
  for (let i = 0; i < store.length; i++) {
    const e = { ...store[i], data: i === 1 ? { decision: 'allow', forged: true } : store[i].data, prevHash: prev };
    e.hash = crypto.createHash('sha256').update(canonical({ seq: e.seq, at: e.at, type: e.type, callId: e.callId, data: e.data, prevHash: e.prevHash })).digest('hex');
    store[i] = e; prev = e.hash;
  }
  assert.equal(a.verify().ok, false);
});

test('entries handed out are copies: editing one changes nothing in the trail', () => {
  const a = createAudit();
  fill(a, 3);
  const out = a.list();
  out[0].data.decision = 'deny'; out[0].hash = 'x';
  const ret = a.append('x', null, { k: 1 });
  ret.data.k = 2;
  assert.equal(a.verify().ok, true);
  assert.equal(a.list()[0].data.decision, 'allow');
});

test('stored entries are frozen (append-only in code too)', () => {
  const store = [];
  const a = createAudit({ store });
  fill(a, 2);
  assert.throws(() => { 'use strict'; store[0].type = 'x'; }, TypeError);
});

test('the cap drops the oldest entry and the rest still verify; tampering after a drop is still found', () => {
  const store = [];
  const a = createAudit({ store, cap: 4 });
  fill(a, 9);
  assert.equal(store.length, 4);
  const v = a.verify();
  assert.equal(v.ok, true);
  assert.equal(v.headSeq, 9);
  assert.equal(store[0].seq, 6);
  store[1] = { ...store[1], data: { x: 1 } };
  assert.equal(a.verify().ok, false);
});

test('reset starts a new epoch whose first entry records the head of the discarded chain', () => {
  const a = createAudit();
  fill(a, 3);
  const before = a.verify();
  const marker = a.reset();
  assert.equal(marker.type, 'reset');
  assert.equal(marker.data.discardedHeadHash, before.headHash);
  assert.equal(marker.data.discardedLength, 3);
  assert.equal(a.size, 1);
  assert.equal(a.verify().ok, true);
  assert.equal(a.verify().epoch, 2);
  assert.ok(marker.seq > 3, 'sequence numbers never restart');
});

test('the chain is keyed: the same entries under two keys (or two default instances) hash differently', () => {
  const at = () => new Date('2026-10-21T12:00:00Z');
  const mk = (key) => { const a = createAudit({ key, now: at }); a.append('decision', 'call-0001', { decision: 'allow' }); return a.list()[0].hash; };
  assert.notEqual(mk(Buffer.alloc(32, 1)), mk(Buffer.alloc(32, 2)));
  assert.equal(mk(Buffer.alloc(32, 1)), mk(Buffer.alloc(32, 1)));
  assert.notEqual(mk(undefined), mk(undefined), 'a fresh random key per instance');
});

// GW2 pins.
test('reset chains the new epoch to the head of the discarded trail (not to genesis)', () => {
  const a = createAudit();
  fill(a, 3);
  const head = a.verify().headHash;
  const marker = a.reset();
  assert.equal(marker.prevHash, head);
  assert.notEqual(marker.prevHash, GENESIS);
  assert.equal(a.verify().ok, true);
});

test('the trail keeps its own copy of the data it was given', () => {
  const a = createAudit();
  const data = { nested: { x: 1 } };
  a.append('decision', 'call-1', data);
  data.nested.x = 2; data.extra = true;
  assert.deepEqual(a.list()[0].data, { nested: { x: 1 } });
  assert.equal(a.verify().ok, true);
});
