// Ping release claim (2026-11-02), UNVERIFIED on our tenant: the third outcome "hold for a human", attended versus
// unattended, and approvals that are single-use and bound to the exact call. Level 1 tests for the "AI Policies (scope and
// HITL)" row of the feature test plan. Each refusal below is paired with a negative control that succeeds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGateway, PENDING_CAP } from '../src/gateway.js';
import { GRANT_TTL_MS, PAUSE_TTL_MS, evaluate } from '../src/policy.js';
import { callHash, canonical } from '../src/approval.js';
import { fakeClock, fakeForward } from './fixtures.js';

// The rate limit is set high here so a test that makes many calls is not rate limited by accident; the one test about it sets its own.
const mk = (o = {}) => { const clock = fakeClock(); const forward = o.forward ?? fakeForward(); const gw = createGateway({ forward, now: clock.now, rate: { max: 1000, windowMs: 10_000 }, ...o }); return { gw, clock, forward }; };
const BATCH = 'tok-finance-batch';
const xfer = (gw, amount = 900, extra = {}) => gw.handle({ agentId: 'finance-agent', tool: 'payments.transfer', args: { amount, to: 'acct-demo-9' }, tokenId: BATCH, ...extra });
const codeOf = (gw, id) => gw.get(id).hold.approvalCode;
// open a hold, optionally approve it, and return what the agent needs to retry
async function held(gw, { approve = true, amount = 900 } = {}) {
  const c = await xfer(gw, amount);
  if (approve) assert.equal((await gw.decide(c.id, { decision: 'approve', approvalCode: codeOf(gw, c.id) })).status, 200);
  return { id: c.id, ref: c.hold.ref };
}
const drain = async (n = 25) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

test('unattended hold: refused at once with a reference and an expiry, not forwarded, and no connection is kept open', async () => {
  const { gw, forward, clock } = mk();
  const p = xfer(gw);
  let settled = false; p.then(() => { settled = true; });
  await drain();
  assert.equal(settled, true, 'handle() returned without waiting for a human');
  const c = await p;
  assert.deepEqual([c.decision, c.outcome, c.reason], ['pause', 'held', 'needs_human_approval']);
  assert.match(c.hold.ref, /^hold-[0-9a-f]{16}$/);
  assert.equal(c.hold.attended, false);
  assert.equal(c.hold.state, 'pending');
  assert.equal(c.hold.expiresAt, new Date(clock.now() + PAUSE_TTL_MS).toISOString());
  assert.match(c.hold.argsHash, /^[0-9a-f]{64}$/);
  assert.equal(c.hold.approvalCode, undefined, 'the response to the agent never carries the human\'s code');
  assert.equal(c.pause, undefined);
  assert.equal(forward.sent.length, 0);
  assert.deepEqual(gw.audit.list().map((e) => e.type), ['decision', 'hold_opened']);
});

test('attended versus unattended comes from the token: the same call by an attended token is the old pending pause (negative control)', async () => {
  const { gw, forward } = mk();
  const c = await xfer(gw, 900, { tokenId: undefined });
  assert.deepEqual([c.decision, c.outcome], ['pause', 'pending']);
  assert.equal(c.pause.attended, true);
  assert.equal(c.hold, undefined);
  assert.match(gw.get(c.id).pause.approvalCode, /^[0-9a-f]{32}$/);
  assert.equal(forward.sent.length, 0);
  const r = await gw.decide(c.id, { decision: 'approve', approvalCode: gw.get(c.id).pause.approvalCode });
  assert.equal(r.call.outcome, 'forwarded', 'an attended approval forwards the call itself');
  assert.equal(forward.sent.length, 1);
});

test('approving an unattended hold forwards nothing; the agent\'s exact retry with the reference is forwarded once', async () => {
  const { gw, forward } = mk();
  const { id, ref } = await held(gw);
  assert.equal(forward.sent.length, 0, 'approval alone moves nothing');
  const a = gw.get(id);
  assert.deepEqual([a.outcome, a.hold.state, a.hold.grantTtlSec], ['held', 'approved', GRANT_TTL_MS / 1000]);
  assert.ok(a.hold.decidedAt);
  const r = await xfer(gw, 900, { approvalRef: ref });
  assert.deepEqual([r.decision, r.outcome, r.reason, r.ruleId], ['allow', 'forwarded', 'hold_approved', 'pause-large-transfer']);
  assert.equal(r.approvalRef, ref);
  assert.deepEqual(forward.sent.map((s) => s.args), [{ amount: 900, to: 'acct-demo-9' }]);
  const done = gw.get(id);
  assert.deepEqual([done.hold.state, done.hold.consumedByCallId], ['consumed', r.id]);
  assert.ok(done.hold.consumedAt);
  assert.deepEqual(gw.audit.list().map((e) => e.type), ['decision', 'hold_opened', 'hold_approved', 'hold_consumed', 'decision', 'forwarded']);
});

test('single use: a second replay of the same approval is refused, and nothing more reaches the upstream (control: the first use worked)', async () => {
  const { gw, forward } = mk();
  const { ref } = await held(gw);
  assert.equal((await xfer(gw, 900, { approvalRef: ref })).outcome, 'forwarded');
  const again = await xfer(gw, 900, { approvalRef: ref });
  assert.deepEqual([again.decision, again.outcome, again.reason], ['deny', 'blocked', 'approval_consumed']);
  const third = await xfer(gw, 900, { approvalRef: ref });
  assert.equal(third.reason, 'approval_consumed');
  assert.equal(forward.sent.length, 1);
});

test('single use holds under a race: simultaneous retries with one approval forward exactly once', async () => {
  const { gw, forward } = mk();
  const { ref } = await held(gw);
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => xfer(gw, 900, { approvalRef: ref })));
  assert.deepEqual(rs.map((r) => r.reason).sort(), ['approval_consumed', 'approval_consumed', 'approval_consumed', 'approval_consumed', 'hold_approved']);
  assert.equal(forward.sent.length, 1);
});

test('bound to the exact call: a changed argument, a changed tool, another agent or another token is refused, and the approval stays unspent', async () => {
  const { gw, forward } = mk();
  const { ref } = await held(gw);
  const variants = [
    ['amount', () => xfer(gw, 901, { approvalRef: ref })],
    ['extra argument', () => gw.handle({ agentId: 'finance-agent', tool: 'payments.transfer', args: { amount: 900, to: 'acct-demo-9', memo: 'x' }, tokenId: BATCH, approvalRef: ref })],
    ['recipient', () => gw.handle({ agentId: 'finance-agent', tool: 'payments.transfer', args: { amount: 900, to: 'acct-other' }, tokenId: BATCH, approvalRef: ref })],
    ['type of amount', () => gw.handle({ agentId: 'finance-agent', tool: 'payments.transfer', args: { amount: '900', to: 'acct-demo-9' }, tokenId: BATCH, approvalRef: ref })],
  ];
  for (const [name, send] of variants) {
    const r = await send();
    assert.ok(['approval_mismatch'].includes(r.reason) || r.decision === 'deny', name);
    assert.equal(r.outcome, 'blocked', name);
    assert.equal(forward.sent.length, 0, name);
  }
  assert.equal((await xfer(gw, 901, { approvalRef: ref })).reason, 'approval_mismatch');
  // another token of the same agent (attended, so it would not even hold) and another agent's call
  const otherToken = await gw.handle({ agentId: 'finance-agent', tool: 'payments.transfer', args: { amount: 900, to: 'acct-demo-9' }, approvalRef: ref });
  assert.notEqual(otherToken.outcome, 'forwarded');
  const otherAgent = await gw.handle({ agentId: 'ops-agent', tool: 'files.delete', args: { path: '/data/x' }, approvalRef: ref });
  assert.notEqual(otherAgent.outcome, 'forwarded');
  assert.equal(forward.sent.length, 0);
  // negative control: the exact original call still works, because none of the refusals spent the approval
  const ok = await xfer(gw, 900, { approvalRef: ref });
  assert.deepEqual([ok.reason, ok.outcome], ['hold_approved', 'forwarded']);
  assert.equal(forward.sent.length, 1);
});

test('the binding is a hash of the canonical call: key order does not matter, any value does, and keys such as __proto__ are plain strings', () => {
  const base = { agentId: 'a', tool: 't', tokenId: 'k' };
  assert.equal(callHash({ ...base, args: { b: 1, a: [1, { y: 2, x: 1 }] } }), callHash({ ...base, args: { a: [1, { x: 1, y: 2 }], b: 1 } }));
  const h = callHash({ ...base, args: { a: 1 } });
  for (const other of [{ ...base, args: { a: 2 } }, { ...base, args: { a: '1' } }, { ...base, args: { a: 1, b: 1 } }, { ...base, agentId: 'b', args: { a: 1 } }, { ...base, tool: 'u', args: { a: 1 } }, { ...base, tokenId: 'j', args: { a: 1 } }]) assert.notEqual(callHash(other), h);
  const hostile = JSON.parse('{"__proto__": {"polluted": true}, "constructor": 1}');
  assert.equal(canonical(hostile), '{"__proto__":{"polluted":true},"constructor":1}');
  assert.equal({}.polluted, undefined);
  let deep = 1; for (let i = 0; i < 100; i++) deep = { k: deep };
  assert.throws(() => canonical(deep), /nested too deeply/);
});

test('expiry: an undecided hold expires, and a late approval is refused (control: the same approval inside the window works)', async () => {
  const { gw, clock, forward } = mk();
  const c = await xfer(gw);
  const code = codeOf(gw, c.id);
  clock.advance(PAUSE_TTL_MS + 1);
  const late = await gw.decide(c.id, { decision: 'approve', approvalCode: code });
  assert.deepEqual([late.status, late.error], [409, 'expired']);
  assert.equal(gw.get(c.id).outcome, 'expired');
  assert.equal((await xfer(gw, 900, { approvalRef: c.hold.ref })).reason, 'approval_expired');
  assert.equal(forward.sent.length, 0);
  const ok = mk();
  const fresh = await xfer(ok.gw);
  ok.clock.advance(PAUSE_TTL_MS - 1);
  assert.equal((await ok.gw.decide(fresh.id, { decision: 'approve', approvalCode: codeOf(ok.gw, fresh.id) })).status, 200);
});

test('expiry: an approved grant that is not used within its window expires, and the retry is refused', async () => {
  const { gw, clock, forward } = mk();
  const { ref, id } = await held(gw);
  clock.advance(GRANT_TTL_MS + 1);
  const r = await xfer(gw, 900, { approvalRef: ref });
  assert.deepEqual([r.decision, r.reason], ['deny', 'approval_expired']);
  assert.equal(gw.get(id).hold.state, 'expired');
  assert.ok(gw.get(id).hold.expiredAt);
  assert.equal(forward.sent.length, 0);
  assert.ok(gw.audit.list().some((e) => e.type === 'hold_expired'));
  // control: inside the window it works
  const ok = mk();
  const h = await held(ok.gw);
  ok.clock.advance(GRANT_TTL_MS - 1);
  assert.equal((await xfer(ok.gw, 900, { approvalRef: h.ref })).outcome, 'forwarded');
});

test('an approval that was never given, was denied, was locked, or never existed is refused', async () => {
  const { gw, forward } = mk();
  const pending = await held(gw, { approve: false });
  assert.equal((await xfer(gw, 900, { approvalRef: pending.ref })).reason, 'approval_pending');
  const d = await xfer(gw, 800);
  await gw.decide(d.id, { decision: 'deny', approvalCode: codeOf(gw, d.id) });
  assert.deepEqual([gw.get(d.id).outcome, gw.get(d.id).hold.state, gw.get(d.id).hold.deniedBy], ['denied_by_human', 'denied', 'human']);
  assert.equal((await xfer(gw, 800, { approvalRef: d.hold.ref })).reason, 'approval_denied');
  const l = await xfer(gw, 700);
  for (let i = 0; i < 3; i++) await gw.decide(l.id, { decision: 'approve', approvalCode: 'wrong' });
  assert.equal(gw.get(l.id).hold.state, 'locked');
  assert.equal((await xfer(gw, 700, { approvalRef: l.hold.ref })).reason, 'approval_denied');
  for (const bad of ['hold-0000000000000000', 'hold-', '', 'x'.repeat(10_000), '__proto__', 'constructor', 'hold-ZZZZZZZZZZZZZZZZ', 7, null, {}, ['hold-0000000000000000'], { $ne: 1 }]) {
    const r = await xfer(gw, 900, { approvalRef: bad });
    assert.deepEqual([r.decision, r.reason], ['deny', 'approval_unknown'], JSON.stringify(bad)?.slice(0, 30));
  }
  assert.equal(forward.sent.length, 0);
});

test('an approval is an input to the policy, never a bypass: a retry the policy now denies stays denied and does not spend the approval', async () => {
  const { gw, forward } = mk({ rate: { max: 5, windowMs: 10_000 } });
  const { ref } = await held(gw);
  // exhaust the agent's rate limit with reads so the retry is rate limited
  for (let i = 0; i < 6; i++) await gw.handle({ agentId: 'finance-agent', tool: 'payments.read', args: {}, tokenId: BATCH });
  const before = forward.sent.length;
  const blocked = await xfer(gw, 900, { approvalRef: ref });
  assert.deepEqual([blocked.decision, blocked.reason], ['deny', 'rate_limited']);
  assert.equal(forward.sent.length, before, 'the retry did not reach the upstream');
  gw.clearRate('finance-agent');
  const ok = await xfer(gw, 900, { approvalRef: ref });
  assert.deepEqual([ok.reason, ok.outcome], ['hold_approved', 'forwarded']);
  // an approval does not turn a different verdict into an allow either: a surface the token lacks is refused, approval or not
  const other = await held(gw);
  const wrongSurface = await xfer(gw, 900, { approvalRef: other.ref, surface: 'llm' });
  assert.equal(wrongSurface.reason, 'scope_surface');
  assert.equal(gw.get(other.id).hold.state, 'approved', 'still unspent');
  // and an approval presented on a call that is not held changes nothing (it is not consumed by an allow)
  const read = await gw.handle({ agentId: 'finance-agent', tool: 'payments.read', args: {}, tokenId: BATCH, approvalRef: other.ref });
  assert.equal(read.reason, 'rule_allow');
  assert.equal(gw.get(other.id).hold.state, 'approved');
});

test('evaluation error denies: an evaluator that throws, or returns something that is not allow, deny or pause, fails closed', async () => {
  for (const evaluateFn of [() => { throw new Error('boom'); }, () => null, () => undefined, () => ({ decision: 'maybe', reason: 'x' }), () => ({ decision: 'allow' }), () => ({ decision: 'allow', reason: 5 }), () => 'allow', () => ({ decision: ['allow'], reason: 'x' })]) {
    const { gw, forward } = mk({ evaluateFn });
    const c = await gw.handle({ agentId: 'support-bot', tool: 'tickets.read', args: { ticketId: 'T-1' } });
    assert.deepEqual([c.decision, c.outcome, c.reason], ['deny', 'blocked', 'evaluation_error']);
    assert.deepEqual(Object.values(c.layers), ['skipped', 'skipped', 'skipped', 'skipped']);
    assert.equal(forward.sent.length, 0);
    assert.equal(gw.audit.list()[0].data.reason, 'evaluation_error');
  }
  // control: the real evaluator, and a wrapper that behaves, allow the same call
  for (const evaluateFn of [undefined, (...a) => evaluate(...a)]) {
    const { gw } = mk(evaluateFn ? { evaluateFn } : {});
    assert.equal((await gw.handle({ agentId: 'support-bot', tool: 'tickets.read', args: { ticketId: 'T-1' } })).decision, 'allow');
  }
});

test('an evaluation error also denies a retry that carries an approval, and arguments too deep to bind an approval to are denied, not held', async () => {
  const { gw, forward } = mk();
  const { ref } = await held(gw);
  const broken = mk({ evaluateFn: () => { throw new Error('boom'); } });
  assert.equal((await broken.gw.handle({ agentId: 'finance-agent', tool: 'payments.transfer', args: { amount: 900 }, tokenId: BATCH, approvalRef: ref })).reason, 'evaluation_error');
  let deep = { amount: 900 }; for (let i = 0; i < 80; i++) deep = { amount: 900, k: deep };
  const c = await gw.handle({ agentId: 'finance-agent', tool: 'payments.transfer', args: deep, tokenId: BATCH });
  assert.deepEqual([c.decision, c.reason, c.outcome], ['deny', 'evaluation_error', 'blocked']);
  assert.equal(c.hold, undefined);
  assert.equal(forward.sent.length, 0);
});

test('the retry route in the gateway re-sends the held call as it was first sent: once, then refused', async () => {
  const { gw, forward } = mk();
  const c = await xfer(gw);
  assert.equal((await gw.retry(c.id)).call.reason, 'approval_pending', 'before the human answers, the retry is refused');
  await gw.decide(c.id, { decision: 'approve', approvalCode: codeOf(gw, c.id) });
  const r = await gw.retry(c.id);
  assert.deepEqual([r.status, r.call.reason, r.call.outcome], [200, 'hold_approved', 'forwarded']);
  assert.deepEqual(forward.sent[0].args, { amount: 900, to: 'acct-demo-9' });
  assert.equal((await gw.retry(c.id)).call.reason, 'approval_consumed');
  assert.equal(forward.sent.length, 1);
  // not a held call, or not a call at all
  const read = await gw.handle({ agentId: 'support-bot', tool: 'tickets.read', args: { ticketId: 'T-1' } });
  assert.deepEqual([(await gw.retry(read.id)).status, (await gw.retry(read.id)).error], [409, 'not_held']);
  assert.equal((await gw.retry('call-9999')).status, 404);
});

test('a human decision on a hold cannot be forged or repeated: wrong codes, the other call\'s code, a second decision', async () => {
  const { gw } = mk();
  const a = await xfer(gw, 900); const b = await xfer(gw, 800);
  for (const bad of [undefined, '', 'x', '0'.repeat(32), codeOf(gw, b.id), 123, { $ne: 1 }]) {
    const r = await gw.decide(a.id, { decision: 'approve', approvalCode: bad });
    assert.ok(r.status === 403 || gw.get(a.id).hold.state === 'locked', String(bad));
    if (gw.get(a.id).hold.state !== 'pending') break;
  }
  assert.equal(gw.get(b.id).hold.state, 'pending', 'the other hold is untouched');
  const ok = await gw.decide(b.id, { decision: 'approve', approvalCode: codeOf(gw, b.id) });
  assert.equal(ok.status, 200);
  assert.equal((await gw.decide(b.id, { decision: 'approve', approvalCode: 'anything' })).status, 409, 'an approved hold cannot be approved again');
  assert.equal((await gw.decide(b.id, { decision: 'deny', approvalCode: 'anything' })).status, 409, 'nor denied after the fact');
});

test('holds count against the waiting cap with attended pauses, and a full queue denies instead of holding', async () => {
  const { gw } = mk({ pendingCap: 3 });
  const hs = [await xfer(gw, 900), await xfer(gw, 800), await xfer(gw, 700)];
  const over = await xfer(gw, 600);
  assert.deepEqual([over.decision, over.reason, over.hold], ['deny', 'pause_queue_full', undefined]);
  assert.equal(PENDING_CAP, 20);
  // an approved but unused hold still occupies a slot; a consumed one does not
  await gw.decide(hs[0].id, { decision: 'approve', approvalCode: codeOf(gw, hs[0].id) });
  assert.equal((await xfer(gw, 600)).reason, 'pause_queue_full');
  await xfer(gw, 900, { approvalRef: hs[0].hold.ref });
  assert.equal((await xfer(gw, 600)).outcome, 'held');
});

test('a waiting hold is never evicted from the ring; a spent one can be, after which its reference is unknown (still refused)', async () => {
  const { gw } = mk({ ringCap: 4, rate: { max: 1000, windowMs: 1 } });
  const h = await held(gw, { approve: false });
  for (let i = 0; i < 8; i++) await gw.handle({ agentId: 'support-bot', tool: 'tickets.read', args: { ticketId: `T-${i}` } });
  assert.equal(gw.get(h.id).hold.state, 'pending', 'still there');
  const used = await held(gw);
  assert.equal((await xfer(gw, 900, { approvalRef: used.ref })).outcome, 'forwarded');
  for (let i = 0; i < 8; i++) await gw.handle({ agentId: 'support-bot', tool: 'tickets.read', args: { ticketId: `T-${i}` } });
  assert.equal(gw.get(used.id), null, 'the consumed hold was trimmed from the ring');
  assert.equal((await xfer(gw, 900, { approvalRef: used.ref })).reason, 'approval_unknown');
});

test('reset forgets every hold: references, retries and codes are gone, and the old reference is refused', async () => {
  const { gw, forward } = mk();
  const { ref, id } = await held(gw);
  const pending = await xfer(gw, 800);
  gw.reset();
  assert.equal(gw.get(id), null);
  assert.equal((await xfer(gw, 900, { approvalRef: ref })).reason, 'approval_unknown');
  assert.equal((await gw.retry(id)).status, 404);
  assert.equal((await gw.decide(pending.id, { decision: 'approve', approvalCode: 'x' })).status, 404);
  assert.equal(forward.sent.length, 0);
  assert.equal(gw.stats().pending, 0, 'nothing is waiting, and the refused replay opened no hold');
});

test('a typed credential or token never appears in a hold, a retry, an error or the audit trail', async () => {
  const { gw } = mk();
  const secret = ['sk', 'live', 'A1b2C3d4E5f6G7h8I9j0K1l2'].join('-');
  const pw = ['hunter', '2hunter2'].join('');
  const bearer = ['Bearer ', 'eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiJ4In0', '.', 'c2lnbmF0dXJlLWJ5dGVz'].join('');
  const args = { amount: 900, to: 'acct-demo-9', note: `password=${pw}`, auth: bearer, key: secret };
  const c = await gw.handle({ agentId: 'finance-agent', tool: 'payments.transfer', args, tokenId: BATCH });
  await gw.decide(c.id, { decision: 'approve', approvalCode: codeOf(gw, c.id) });
  const r = await gw.retry(c.id);
  const bad = await gw.handle({ agentId: 'finance-agent', tool: 'payments.transfer', args, tokenId: BATCH, approvalRef: `hold-${secret}` });
  const dump = JSON.stringify({ c, got: gw.get(c.id), r, bad, list: gw.list(), audit: gw.audit.list() });
  for (const needle of [secret, pw, bearer, 'eyJzdWIiOiJ4In0']) assert.equal(dump.includes(needle), false, needle.slice(0, 12));
  assert.equal(bad.reason, 'approval_unknown');
  assert.equal(bad.approvalRef ?? null, null, 'a malformed reference is not echoed');
});

test('the hold carries a hash of the call for the binding, computed from the exact arguments the agent sent', async () => {
  const { gw } = mk();
  const c = await gw.handle({ agentId: 'finance-agent', tool: 'payments.transfer', args: { to: 'acct-demo-9', amount: 900 }, tokenId: BATCH });
  assert.equal(c.hold.argsHash, callHash({ agentId: 'finance-agent', tool: 'payments.transfer', tokenId: BATCH, args: { amount: 900, to: 'acct-demo-9' } }));
  assert.notEqual(c.hold.argsHash, callHash({ agentId: 'finance-agent', tool: 'payments.transfer', tokenId: BATCH, args: { amount: 901, to: 'acct-demo-9' } }));
});

test('the claims a token carried are recorded on the call, and a hostile surface is shown inert', async () => {
  const { gw } = mk();
  const ok = await gw.handle({ agentId: 'support-bot', tool: 'tickets.read', args: { ticketId: 'T-1' } });
  assert.deepEqual(ok.claims, { subject: 'tok-support', application: 'helpdesk-app', surface: 'mcp', endUser: 'user-manager', attended: true });
  assert.deepEqual(ok.layers, { surface: 'pass', application: 'pass', action: 'pass', endUser: 'pass' });
  const bad = await gw.handle({ agentId: 'support-bot', tool: 'tickets.read', args: { ticketId: 'T-1' }, surface: 'llm‮<script>' });
  assert.equal(bad.reason, 'scope_surface');
  assert.doesNotMatch(JSON.stringify(bad), /[‮]/);
});
