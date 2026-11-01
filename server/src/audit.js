// Append-only audit trail with HMAC hash chaining.
//  - Entries are only ever appended. There is no update or delete; the API exposes no write route for it.
//  - entry.hash = HMAC-SHA256(key, canonical JSON of {seq, at, type, callId, data, prevHash}); prevHash is the previous
//    entry's hash. The key is random per process and never leaves it, so editing an entry and recomputing the chain
//    with a plain hash does not verify.
//  - Capped: when the cap is reached the oldest entry is dropped and the chain is re-anchored (anchor = the dropped
//    entry's seq and hash), so a verify still checks every entry that remains.
//  - `store` is the backing array. It is injectable so a test can tamper with it. Nothing else touches it.
import crypto from 'node:crypto';

export const GENESIS = '0'.repeat(64);
export const AUDIT_CAP = 2000;

const canonical = (v) => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
};

export function createAudit({ store = [], key = crypto.randomBytes(32), now = () => new Date(), cap = AUDIT_CAP } = {}) {
  let seq = store.length ? store[store.length - 1].seq + 1 : 1;
  let anchor = { seq: 0, hash: GENESIS };
  let epoch = 1;
  const mac = (e) => crypto.createHmac('sha256', key).update(canonical({ seq: e.seq, at: e.at, type: e.type, callId: e.callId, data: e.data, prevHash: e.prevHash })).digest('hex');

  function append(type, callId, data = {}) {
    const prevHash = store.length ? store[store.length - 1].hash : anchor.hash;
    const entry = { seq, at: now().toISOString(), type, callId: callId ?? null, data: structuredClone(data), prevHash };
    entry.hash = mac(entry);
    seq += 1;
    store.push(Object.freeze(entry));
    while (store.length > cap) { const dropped = store.shift(); anchor = { seq: dropped.seq, hash: dropped.hash }; }
    return structuredClone(entry);
  }

  function verify() {
    let prev = anchor.hash;
    let expectSeq = store.length ? store[0].seq : seq;
    if (store.length && store[0].seq !== anchor.seq + 1) return { ok: false, length: store.length, firstBadSeq: store[0].seq, reason: 'sequence_gap' };
    for (const e of store) {
      if (e.seq !== expectSeq) return { ok: false, length: store.length, firstBadSeq: e.seq, reason: 'sequence_gap' };
      if (e.prevHash !== prev) return { ok: false, length: store.length, firstBadSeq: e.seq, reason: 'chain_broken' };
      let expected;
      try { expected = mac(e); } catch { return { ok: false, length: store.length, firstBadSeq: e.seq, reason: 'malformed_entry' }; }
      const a = Buffer.from(String(e.hash)); const b = Buffer.from(expected);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, length: store.length, firstBadSeq: e.seq, reason: 'hash_mismatch' };
      prev = e.hash;
      expectSeq += 1;
    }
    return { ok: true, length: store.length, headSeq: store.length ? store[store.length - 1].seq : anchor.seq, headHash: prev, epoch, reason: null };
  }

  // After the whole trail is discarded by an operator reset: a new epoch starts with a marker that carries the
  // head of the discarded chain, so the discard itself is on the record.
  function reset() {
    const v = verify();
    store.length = 0;
    anchor = { seq: seq - 1, hash: v.headHash ?? anchor.hash };
    epoch += 1;
    return append('reset', null, { discardedHeadHash: v.headHash ?? null, discardedLength: v.length, discardedVerified: v.ok, epoch });
  }

  const list = ({ after = 0, limit = 200 } = {}) => store.filter((e) => e.seq > after).slice(0, limit).map((e) => structuredClone(e));
  return { append, verify, reset, list, get size() { return store.length; }, get headSeq() { return seq - 1; } };
}
