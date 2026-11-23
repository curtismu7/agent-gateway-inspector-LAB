// Rule 27 for this lab: one run per record, the honesty of every row, the stdout line, the mode stored on the run, and the one Real hop.
// Mock rows are what the stub gateway's audit entries say; Real rows are the replies of one gateway check, here from a fake door on loopback.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { createGateway } from '../src/gateway.js';
import { createRuntime } from '../src/runtime.js';
import { KEEP_RUNS, MAX_RUN_ROWS, createRunLog, decisionLine, gatewayCheckEvents, lineValue, rowsOf } from '../src/runObs.js';
import { assertRunObservability, classify, layerMatchers } from '../src/runObservability.js';
import { SCENARIOS } from '../src/scenarios.js';
import { fakeClock, fakeForward } from './fixtures.js';
import { freeBase, request } from './helpers.js';

// A clock that moves 7 ms each time anything reads it, so every stamp is different and in order; advance() is what sleeping uses.
function tickClock(start = Date.parse('2026-11-22T10:00:00Z'), step = 7) {
  let t = start;
  return { now: () => (t += step), advance: (ms) => { t += ms; } };
}
// A run of free loopback ports inside the test slices (each slice is 4 wide, so runtimes alive together come from different ones).
async function ports(n) {
  for (const slice of ['spare', 'scenarios', 'safety', 'guards']) { try { return await freeBase(slice, n); } catch { /* this slice is in use */ } }
  throw new Error('no free test ports');
}
async function mk(t, over = {}) {
  const base = over.stubBase ?? await ports(3);
  const clock = tickClock();
  const lines = [];
  const rt = await createRuntime({ stubBase: base, now: clock.now, sleep: async (ms) => clock.advance(ms), upstreamTimeoutMs: 30_000, log: (l) => lines.push(l), ...over });
  t.after(() => rt.close());
  return { rt, clock, lines };
}
const rec = async (rt, runId, source = 'mock') => {
  const r = await rt.runLog.record(source, runId);
  assert.deepEqual(assertRunObservability(r.record), []);
  return { ...r, rows: r.record.rows.filter((x) => x.origin !== 'not-logged') };
};
const LINE = /^\d{4}-\d\d-\d\dT[\d:.]+Z agent-gateway-inspector decision layer=[a-z]+ step=[a-z-]+ actor=\S+ result=(?:passed|stopped|unclear|no-reply) cause=\S+ ref=\S+ run=\S+ mode=(?:mock|real)$/;
const WORDS = /refused|denied|rejected|forbidden|failed|invalid|expired|mismatch|token|audience|scope|served/i;
const byLayer = (rows, layer) => rows.filter((r) => r.layer === layer);
const outcomes = (rows, layer) => byLayer(rows, layer).map((r) => r.outcome);
const approvalCode = (rt, id) => { const c = rt.gateway.get(id, { detail: true }); return (c.hold ?? c.pause).approvalCode; };

test('every scenario: every row is simulated, comes from a stored audit entry with the same time, and no scenario shows a hop the stub did not make', async (t) => {
  for (const s of SCENARIOS) {
    const { rt } = await mk(t);
    rt.upstreams.reset();
    const result = await rt.runScenario(s.id);
    const { rows, record, open } = await rec(rt, result.runId);
    assert.equal(open, false, s.id);
    assert.equal(record.source, 'mock');
    assert.ok(rows.length > 0 && rows.every((r) => r.origin === 'simulated'), `${s.id}: no row is tagged logged or response`);
    assert.equal(record.coverage.authorize, 'not-logged');
    assert.match(record.reasons.authorize, /does not call PingOne Authorize/);
    // The row's time and place come from the audit entry it was made from.
    const audit = new Map(rt.gateway.audit.list({ limit: 500 }).map((e) => [e.seq, e]));
    for (const r of rows) {
      const e = audit.get(r.detail.auditSeq);
      assert.ok(e, `${s.id}: row ${r.id} has an audit entry`);
      assert.equal(r.at, e.at, `${s.id}: the row carries the audit entry's own time`);
      assert.ok(result.calls.some((c) => c.id === e.callId), `${s.id}: the entry belongs to a call of this run`);
    }
    const expected = [...audit.values()].filter((e) => e.callId).flatMap((e) => rowsOf(e, e.type === 'decision' ? rt.gateway.get(e.callId).claims : null));
    assert.equal(rows.length, expected.length, `${s.id}: one row per row-producing audit entry, no more`);
    // No narrated tool dispatch: a resource row exists exactly when the stub tool server was really called.
    assert.equal(byLayer(rows, 'resource').length, rt.upstreams.hits.length, `${s.id}: resource rows = tool server hits`);
    const times = rows.map((r) => Date.parse(r.at));
    assert.deepEqual(times, [...times].sort((a, b) => a - b), `${s.id}: time order`);
    assert.ok(rows.every((r) => r.message.length < 300), `${s.id}: no message is cut by the 300 character cap`);
    await rt.close();
  }
});

test('outcomes: a refusal is refused, a cap is blocked, a hold is information, and issuing nothing is never shown as allowed', async (t) => {
  const { rt } = await mk(t);
  const get = async (id, opts) => rec(rt, (await rt.runScenario(id, opts)).runId);

  const benign = await get('benign');
  assert.deepEqual(benign.rows.map((r) => [r.layer, r.outcome]), [['agent', 'allowed'], ['person', 'allowed'], ['privilege', 'allowed'], ['gateway', 'allowed'], ['resource', 'info']]);
  assert.deepEqual(benign.record.summary, { allowed: 4, refused: 0, blocked: 0, info: 1, unverified: 0 });

  const scope = await get('scope-exceeding');
  assert.deepEqual(scope.rows.map((r) => [r.layer, r.outcome]), [['agent', 'allowed'], ['privilege', 'refused'], ['gateway', 'refused']], 'no end-user row: that layer was never reached');
  assert.deepEqual(outcomes(scope.rows, 'privilege'), ['refused']);
  assert.match(byLayer(scope.rows, 'privilege')[0].message, /Layer 3 \(action\): the agent does not hold payments:write/);
  assert.deepEqual(outcomes(scope.rows, 'gateway'), ['refused']);
  assert.equal(byLayer(scope.rows, 'resource').length, 0);
  assert.equal(scope.record.coverage.resource, 'not-logged');
  assert.match(scope.record.reasons.resource, /No call of this run was forwarded/);

  const endUser = await get('end-user-denied');
  assert.deepEqual(endUser.rows.map((r) => [r.layer, r.outcome]), [['agent', 'allowed'], ['person', 'refused'], ['gateway', 'refused']]);
  assert.match(byLayer(endUser.rows, 'person')[0].message, /user-analyst does not hold payments:write.*nobody signed in/);

  const burst = await get('rate-burst');
  assert.deepEqual(outcomes(burst.rows, 'gateway'), [...Array(5).fill('allowed'), ...Array(2).fill('blocked')], 'the rate limit is the lab\'s own cap: blocked');
  assert.deepEqual(outcomes(burst.rows, 'privilege').slice(-2), ['blocked', 'blocked']);
  assert.equal(byLayer(burst.rows, 'resource').length, 5);

  const injection = await get('prompt-injection');
  assert.deepEqual(outcomes(injection.rows, 'privilege'), ['refused']);
  assert.match(byLayer(injection.rows, 'privilege')[0].message, /Rule deny-injection matched/);

  for (const id of ['surface-denied', 'application-denied']) assert.deepEqual(outcomes((await get(id)).rows, 'privilege'), ['refused'], id);

  // A hold is a policy decision that is neither a pass nor a refusal: information. The human's yes is the allow, and the tool server is only then reached.
  const paused = await get('paused-approved');
  assert.deepEqual(paused.rows.map((r) => [r.layer, r.outcome]), [['agent', 'allowed'], ['person', 'allowed'], ['privilege', 'info'], ['gateway', 'info'], ['privilege', 'info'], ['privilege', 'allowed'], ['resource', 'info']]);

  const expired = await get('paused-expired');
  assert.deepEqual(outcomes(expired.rows, 'privilege'), ['info', 'info', 'blocked'], 'a lapsed wait fails closed: blocked');
  assert.equal(byLayer(expired.rows, 'resource').length, 0, 'nothing was forwarded');
  assert.ok(expired.rows.every((r) => !(r.layer === 'gateway' && r.outcome === 'allowed')));

  // The replay is turned away, never shown as a plain allow.
  const replay = await get('hold-replay-refused');
  const verdicts = byLayer(replay.rows, 'privilege').filter((r) => r.detail.reason);
  assert.deepEqual(verdicts.map((r) => [r.detail.reason, r.outcome]), [['needs_human_approval', 'info'], ['hold_approved', 'allowed'], ['approval_consumed', 'refused']]);
  assert.equal(byLayer(replay.rows, 'resource').length, 1, 'the tool server was reached once');

  const changed = await get('hold-args-changed');
  assert.deepEqual(byLayer(changed.rows, 'privilege').filter((r) => r.detail.reason).map((r) => [r.detail.reason, r.outcome]), [['needs_human_approval', 'info'], ['approval_mismatch', 'refused'], ['hold_approved', 'allowed']]);
});

test('one run per record: a held run stays open until its call is answered and used, and later events join no run', async (t) => {
  const { rt, lines } = await mk(t);
  const first = await rt.runScenario('hold-unattended', { hold: true });
  assert.match(first.runId, /^run-[0-9a-f]{6}-1$/);
  const held = first.calls[0];
  assert.equal(held.outcome, 'held');
  let r = await rec(rt, first.runId);
  assert.equal(r.open, true, 'the call is waiting for a human');
  assert.equal(rt.runLog.head('mock', first.runId).open, true);
  const before = r.rows.length;

  // The human approves, then the agent retries: both join the run that made the call, which closes when the approval is used.
  assert.equal((await rt.gateway.decide(held.id, { decision: 'approve', approvalCode: approvalCode(rt, held.id) })).status, 200);
  r = await rec(rt, first.runId);
  assert.equal(r.open, true, 'an approved hold is still waiting for its retry');
  assert.ok(r.rows.length > before);
  assert.equal((await rt.gateway.retry(held.id)).status, 200);
  r = await rec(rt, first.runId);
  assert.equal(r.open, false);
  assert.deepEqual(byLayer(r.rows, 'agent').map((x) => x.outcome), ['allowed', 'allowed'], 'the retry was evaluated like any call');
  assert.equal(byLayer(r.rows, 'resource').length, 1);
  const cursor = rt.runLog.head('mock', first.runId).cursor;
  const n = lines.length;

  // A second retry after the verdict is a real decision (the approval was spent), on stdout only.
  assert.equal((await rt.gateway.retry(held.id)).status, 200);
  assert.ok(lines.length > n);
  assert.ok(lines.slice(n).every((l) => / run=- mode=mock$/.test(l)), 'after the verdict a line names no run');
  assert.match(lines.slice(n).find((l) => / layer=privilege step=policy-verdict /.test(l)), /cause=approval-spent /);
  assert.equal(rt.runLog.head('mock', first.runId).cursor, cursor, 'nothing joined the closed run');
  assert.deepEqual((await rec(rt, first.runId)).rows.map((x) => x.id), r.rows.map((x) => x.id));
});

test('rows of one instant keep the order the stub computed them in, and a hold is spent before its retry is evaluated', async (t) => {
  const frozen = fakeClock(); // every audit entry gets the same time, so only the order can tell them apart
  const { rt } = await mk(t, { now: frozen.now, sleep: async (ms) => frozen.advance(ms) });
  const r = await rt.runScenario('hold-unattended');
  const { rows } = await rec(rt, r.runId);
  assert.equal(new Set(rows.map((x) => x.at)).size, 1);
  assert.deepEqual(rows.map((x) => [x.layer, x.outcome]), [
    ['agent', 'allowed'], ['person', 'allowed'], ['privilege', 'info'], ['gateway', 'info'], ['privilege', 'info'], // the first call: held, approval opened
    ['privilege', 'info'], ['privilege', 'info'], // the human's yes (a grant, not a pass), then the approval spent by the retry
    ['agent', 'allowed'], ['person', 'allowed'], ['privilege', 'allowed'], ['gateway', 'allowed'], ['resource', 'info'], // the retry
  ]);
  assert.match(rows[6].message, /^The approval was used by call-\d+/);
});

test('overlapping runs: the answer joins the run that made the call, never the newest one; an open run is never dropped; the list is bounded', async (t) => {
  const { rt } = await mk(t);
  const a = await rt.runScenario('paused-approved', { hold: true });
  const b = await rt.runScenario('benign');
  assert.notEqual(a.runId, b.runId);
  const pending = a.calls[0];
  await rt.gateway.decide(pending.id, { decision: 'approve', approvalCode: approvalCode(rt, pending.id) });
  const ra = await rec(rt, a.runId);
  const rb = await rec(rt, b.runId);
  assert.ok(byLayer(ra.rows, 'privilege').some((x) => /A human approved the call/.test(x.message)));
  assert.ok(!byLayer(rb.rows, 'privilege').some((x) => /A human approved/.test(x.message)), 'the newest run does not receive the older run\'s answer');
  assert.equal(ra.open, false);
  assert.equal(byLayer(ra.rows, 'resource').length, 1, 'the forward that follows the approval joins the run too');
  assert.equal(byLayer(rb.rows, 'resource').length, 1, 'and the newest run keeps only its own tool server answer');
  assert.equal((await rt.runLog.record('mock')).record.runId, b.runId, 'without a run id the newest run is answered');
  assert.equal(await rt.runLog.record('mock', 'nope-1'), null);

  // Bounded, and a run that is still open survives the bound.
  const open = await rt.runScenario('paused-approved', { hold: true });
  for (let i = 0; i < KEEP_RUNS + 4; i += 1) await rt.runScenario('scope-exceeding');
  assert.ok(rt.runLog.head('mock', open.runId), 'the open run is still kept');
  assert.equal(rt.runLog.head('mock', open.runId).open, true);
  assert.equal(rt.runLog.head('mock', a.runId), null, 'the oldest closed runs were dropped');
  await rt.gateway.decide(open.calls[0].id, { decision: 'deny', approvalCode: approvalCode(rt, open.calls[0].id) });
  assert.equal(rt.runLog.head('mock', open.runId).open, false);
});

test('run ids are unique across Reset and across runtimes, and safe in the stdout line', async (t) => {
  const { rt, lines } = await mk(t);
  const a = (await rt.runScenario('benign')).runId;
  rt.reset();
  assert.equal(rt.runLog.head('mock'), null, 'Reset forgets the runs');
  const b = (await rt.runScenario('benign')).runId;
  const other = await mk(t);
  const c = (await other.rt.runScenario('benign')).runId;
  assert.equal(new Set([a, b, c]).size, 3, `${a} ${b} ${c}`);
  for (const id of [a, b, c]) assert.match(id, /^run-[0-9a-f]{6}-\d+$/);
  assert.ok(lines.some((l) => l.includes(` run=${a} `)) && lines.some((l) => l.includes(` run=${b} `)));
});

test('the stdout line: one per row with the row\'s own time, no word the shared matchers read, and no product reads it as a decision', async (t) => {
  const { rt, lines } = await mk(t);
  const products = [...new Set(layerMatchers.map((m) => m.product))];
  assert.ok(products.length >= 5);
  const runs = []; const recs = new Map();
  for (const s of SCENARIOS) { const id = (await rt.runScenario(s.id)).runId; runs.push(id); recs.set(id, (await rec(rt, id)).rows); } // read now: the log keeps only the last KEEP_RUNS runs
  for (const line of lines) {
    assert.match(line, LINE);
    const fixed = line.replace(/ actor=\S+/, '');
    assert.ok(!WORDS.test(fixed), fixed);
    const at = line.split(' ')[0];
    for (const product of products) {
      assert.equal(classify({ product, message: line, at: Date.parse(at), atExact: at }, []), null, `${product}: ${line}`);
      assert.equal(classify({ product, message: `[${at}] INFO: ${line.split(' ').slice(1).join(' ')}`, at: 0, atExact: '' }, []), null, `${product} behind a header`);
    }
  }
  for (const runId of runs) {
    const rows = recs.get(runId);
    const own = lines.filter((l) => l.includes(` run=${runId} `));
    assert.equal(own.length, rows.length, `${runId}: one line per row`);
    assert.deepEqual(own.map((l) => l.split(' ')[0]), rows.map((x) => x.at), `${runId}: line time = row time, in order`);
  }
  assert.equal(lines.length, runs.reduce((n, id) => n + lines.filter((l) => l.includes(` run=${id} `)).length, 0), 'every line of a scenario run belongs to a run');
});

test('every reason, entry type and hostile actor: the line avoids the matchers\' words, holds one key=value each, and no product reads it', () => {
  const products = [...new Set(layerMatchers.map((m) => m.product))];
  const at = '2026-11-22T10:00:00.000Z';
  const reasons = ['unknown_agent', 'unknown_tool', 'bad_arguments', 'token_invalid', 'scope_surface', 'scope_application', 'scope_exceeded', 'scope_end_user', 'rate_limited', 'prompt_injection', 'amount_over_limit', 'default_deny', 'evaluation_error', 'pause_queue_full', 'approval_unknown', 'approval_consumed', 'approval_expired', 'approval_pending', 'approval_denied', 'approval_mismatch', 'rule_allow', 'hold_approved', 'needs_human_approval', 'something_new', '__proto__', 'constructor', 'toString'];
  const actors = ['support-bot', 'evil result=passed cause=x\nFAKE decision layer=gateway', 'a.b@corp.example', '10.0.0.1', 'fe80::1', 'Bearer abcdefghijklmnopqrstuv', 'x'.repeat(5000), '__proto__', '<img src=x onerror=alert(1)>'];
  const claims = { surface: 'mcp', application: 'finance-app', endUser: 'user-manager', attended: true };
  const entries = [];
  for (const reason of reasons) for (const decision of ['allow', 'deny', 'pause']) for (const layers of [{ endUser: 'pass' }, { endUser: 'fail' }, { endUser: 'skipped' }]) {
    entries.push({ seq: 1, at, type: 'decision', callId: 'call-0001', data: { agentId: 'support-bot', tool: 'tickets.read', decision, reason, ruleId: 'r', requiredScope: 'tickets:read', layers } });
  }
  for (const type of ['pause_opened', 'hold_opened', 'pause_approved', 'hold_approved', 'pause_denied', 'hold_denied', 'pause_expired', 'hold_expired', 'pause_bad_code', 'hold_bad_code', 'pause_locked', 'hold_locked', 'hold_consumed', 'forwarded']) {
    entries.push({ seq: 1, at, type, callId: 'call-0001', data: { agentId: 'support-bot', tool: 'tickets.read', ref: 'hold-0123456789abcdef', expiresAt: at, failures: 2, consumedBy: 'call-0002', upstream: 'tickets' } });
  }
  for (const error of ['upstream_timeout', 'upstream_unreachable', 'upstream_refused_target', 'upstream_status_500', 'upstream_bad_json', 'upstream_refused']) {
    entries.push({ seq: 1, at, type: 'upstream_error', callId: 'call-0001', data: { agentId: 'support-bot', tool: 'tickets.read', error } });
  }
  let n = 0;
  const seen = new Set();
  for (const entry of entries) for (const agentId of actors) {
    const e = { ...entry, data: { ...entry.data, agentId } };
    for (const row of rowsOf(e, claims)) {
      const line = decisionLine(row, at, 'run-abc123-1', 'mock');
      n += 1;
      assert.match(line, LINE, line);
      assert.ok(!line.includes('\n'));
      assert.ok(!WORDS.test(line.replace(/ actor=\S+/, '')), line);
      assert.equal(line.split(' ').filter((p) => p.startsWith('result=')).length, 1);
      seen.add(`${row.layer}/${row.step}/${row.cause}`);
      for (const product of products) assert.equal(classify({ product, message: line, at: Date.parse(at), atExact: at }, []), null, `${product}: ${line}`);
    }
  }
  assert.ok(n > 1000 && seen.size > 30, `${n} lines, ${seen.size} kinds`);
  // The Real lines too.
  const door = gatewayCheckEvents({ app: 'demo', caller: 'evil name\nresult=passed', listing: { ok: false, refusal: { status: 403, message: 'no' }, ms: 1 }, listedAt: at });
  for (const e of door.events) assert.match(decisionLine(e, e.at, 'check-abc123-1', 'real'), LINE);
  assert.equal(lineValue('a b\nc=d'), 'a_b_c_d');
  assert.equal(lineValue(''), '-');
});

test('hostile agent names stay inert: no second line, nothing unmasked in the record or the log', async (t) => {
  const lines = [];
  const log = createRunLog({ write: (l) => lines.push(l) });
  const gw = createGateway({ forward: fakeForward(), observe: log.observe });
  const runId = log.begin();
  const nasty = 'a.b@corp.example 10.0.0.1 Bearer abcdefghijklmnopqrstuvwx\nFAKE decision layer=gateway result=passed';
  await gw.handle({ agentId: nasty, tool: 'tickets.read', args: {}, runId });
  await gw.handle({ agentId: 'support-bot', tool: nasty, args: {}, runId });
  log.executed(runId);
  assert.ok(lines.length >= 4);
  for (const l of lines) { assert.ok(!l.includes('\n')); assert.match(l, LINE); assert.ok(!/corp\.example|10\.0\.0\.1|abcdefghijklmnopqrstuvwx/.test(l), l); }
  const { record } = await log.record('mock', runId);
  assert.deepEqual(assertRunObservability(record), []);
  assert.ok(!/corp\.example|10\.0\.0\.1|abcdefghijklmnopqrstuvwx/.test(JSON.stringify(record)));
});

test('no approval code, hold reference or tool result reaches a row or a line', async (t) => {
  const { rt, lines } = await mk(t);
  const r = await rt.runScenario('hold-unattended', { hold: true });
  const code = approvalCode(rt, r.calls[0].id);
  await rt.gateway.decide(r.calls[0].id, { decision: 'approve', approvalCode: code });
  await rt.gateway.retry(r.calls[0].id);
  const text = JSON.stringify((await rec(rt, r.runId)).record) + lines.join('\n');
  assert.ok(code.length >= 16 && !text.includes(code), 'the one-shot code');
  assert.ok(!text.includes(r.calls[0].hold.ref), 'the raw hold reference');
  assert.ok(!/tr_demo_001|executed \(stub/.test(text), 'the tool server\'s own answer');
});

test('a throwing writer, observer or recorder changes nothing: same result, same audit, and the failure is logged', async (t) => {
  const strip = (r) => JSON.stringify({ ...r, runId: undefined, calls: r.calls.map((c) => ({ ...c, at: undefined, trace: undefined })) });
  const clean = await mk(t);
  const base = await clean.rt.runScenario('rate-burst');
  const errors = [];
  const orig = console.error; console.error = (m) => errors.push(String(m));
  let bad; let badRun; let obs; let obsRun;
  try {
    bad = await mk(t, { log: () => { throw new Error('disk full'); } });
    badRun = await bad.rt.runScenario('rate-burst');
    // An observer that throws inside the gateway
    const gw = createGateway({ forward: fakeForward(), observe: () => { throw Object.assign(new Error('boom'), { code: 'E_BOOM' }); } });
    obs = gw;
    obsRun = await gw.handle({ agentId: 'support-bot', tool: 'tickets.read', args: { ticketId: 'T-1' } });
    // A recorder handed garbage
    assert.equal(createRunLog({ write: () => {} }).recordGatewayCheck({ app: 'x', caller: 'y', startedAt: '2026-11-22T10:00:00.000Z', listing: { ok: false }, listedAt: '2026-11-22T10:00:00.000Z' }), null);
    // A run that cannot start
    const broken = createRunLog({ write: () => {}, clock: () => { throw new Error('clock'); } });
    assert.equal(broken.begin(), null);
  } finally { console.error = orig; }
  assert.equal(strip(badRun), strip(base));
  assert.deepEqual(bad.rt.gateway.audit.list().map((e) => e.type), clean.rt.gateway.audit.list().map((e) => e.type));
  assert.equal(obsRun.outcome, 'forwarded');
  assert.deepEqual(obs.audit.list().map((e) => e.type), ['decision', 'forwarded']);
  assert.ok(errors.some((m) => /run log write failed: Error/.test(m)), errors.join('|'));
  assert.ok(errors.some((m) => /run observer failed: E_BOOM: boom/.test(m)));
  assert.ok(errors.some((m) => /recording the gateway check failed/.test(m)));
  assert.ok(errors.some((m) => /starting the run record failed/.test(m)));
  assert.equal((await rec(bad.rt, badRun.runId)).record.summary.blocked, 4, 'the rows are kept when only the writer failed');
});

test('a run keeps at most MAX_RUN_ROWS rows and says it cut some', async () => {
  const log = createRunLog({ write: () => {}, clock: () => Date.parse('2026-11-22T10:00:00Z') });
  const runId = log.begin();
  for (let i = 0; i < MAX_RUN_ROWS + 20; i += 1) log.observe({ seq: i + 1, at: '2026-11-22T10:00:00.000Z', type: 'pause_bad_code', callId: 'call-0001', data: { agentId: 'support-bot', failures: i } }, { runId });
  const { record } = await log.record('mock', runId);
  assert.equal(record.truncated, true);
  assert.deepEqual(assertRunObservability(record), []);
});

// ---- the route, and the one Real hop -------------------------------------------------------------------------------------------------

// A fake MCP door on loopback: initialize, notifications/initialized, tools/list and tools/call, each answered as the test says.
async function fakeDoor(t, answers = {}) {
  const port = await freeBase('api', 1);
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.method === 'DELETE') return res.writeHead(200).end();
      const m = JSON.parse(raw || '{}');
      seen.push(m.method);
      const reply = (status, body) => res.writeHead(status, { 'content-type': 'application/json', 'mcp-session-id': 'fake-session' }).end(JSON.stringify(body));
      if (m.method === 'notifications/initialized') return res.writeHead(202).end();
      if (m.method === 'initialize') return reply(200, { jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'fake-door' }, capabilities: {} } });
      const a = (answers[m.method] ?? (() => ({ status: 200, body: { result: {} } })))(m);
      return reply(a.status, { jsonrpc: '2.0', id: m.id, ...a.body });
    });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { port, seen };
}
const KEY = 'fake-agent-key-0123456789abcdef';
const doorEnv = (port) => ({ AGI_GW_URL: `http://127.0.0.1:${port}`, AGI_GW_APPS: 'demo-door', AGI_GW_KEY_TESTER: KEY, STANDALONE_ENV: '/nonexistent/agi.env', HOME: '/nonexistent' });
async function boot(t, { env = {} } = {}) {
  const base = await ports(4);
  const { rt, lines } = await mk(t, { stubBase: base });
  const port = base + 3;
  const server = createApp({ runtime: rt, env }).listen(port, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  const get = (path) => request(port, 'GET', path);
  const post = (path, body = {}) => request(port, 'POST', path, { body });
  return { rt, lines, port, get, post };
}
const TOOLS = [{ name: 'tickets_read', description: 'd' }, { name: 'files_read', description: 'd' }];
const GOOD = { 'tools/list': () => ({ status: 200, body: { result: { tools: TOOLS } } }), 'tools/call': () => ({ status: 200, body: { error: { code: -32001, message: 'policy denied: no grant for this tool' } } }) };

test('the route: empty before a run, one record per run in this mode, ?runId picks a run, a bad id is a 400, GET only', async (t) => {
  const { rt, get, post, port } = await boot(t);
  const empty = await get('/api/run-observability');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json, { source: 'mock', record: null, message: 'No run yet: pick a scenario and press Run.' });
  assert.deepEqual((await get('/api/run-observability/head')).json, { source: 'mock', runId: null });
  const a = (await post('/api/scenarios/benign/run')).json;
  const b = (await post('/api/scenarios/scope-exceeding/run')).json;
  assert.match(a.runId, /^run-/);
  const newest = (await get('/api/run-observability')).json;
  assert.equal(newest.source, 'mock');
  assert.equal(newest.record.runId, b.runId);
  assert.deepEqual(assertRunObservability(newest.record), []);
  assert.equal(newest.open, false);
  assert.equal((await get(`/api/run-observability?runId=${a.runId}`)).json.record.runId, a.runId);
  assert.deepEqual((await get(`/api/run-observability/head?runId=${a.runId}`)).json, { source: 'mock', ...rt.runLog.head('mock', a.runId) });
  const unknown = await get('/api/run-observability?runId=nothing-1');
  assert.equal(unknown.status, 200);
  assert.equal(unknown.json.record, null);
  assert.match(unknown.json.message, /No run with that id in mock mode/);
  for (const bad of ['runId=a%20b', 'runId=', `runId=${'x'.repeat(65)}`, 'runId=a&runId=b', 'runId[]=a']) {
    const r = await get(`/api/run-observability?${bad}`);
    assert.equal(r.status, 400, bad);
    assert.equal(r.json.error, 'bad_request');
    assert.equal((await get(`/api/run-observability/head?${bad}`)).status, 400, `head ${bad}`);
  }
  assert.equal((await post('/api/run-observability')).status, 404, 'GET only');
  const head1 = (await get('/api/run-observability/head')).json;
  await post('/api/reset');
  assert.deepEqual((await get('/api/run-observability')).json, { source: 'mock', record: null, message: 'No run yet: pick a scenario and press Run.' });
  assert.notEqual(head1.runId, null);
  assert.equal((await post('/api/scenarios/nothing-here/run')).status, 404);
  assert.deepEqual((await get('/api/run-observability/head')).json, { source: 'mock', runId: null }, 'an attempt that began no run leaves no run');
});

test('a run that is still waiting says so, and the head moves when a row joins', async (t) => {
  const { get, post, rt } = await boot(t);
  const r = (await post('/api/scenarios/paused-approved/run', { hold: true })).json;
  const h1 = (await get(`/api/run-observability/head?runId=${r.runId}`)).json;
  assert.equal(h1.open, true);
  const rec1 = (await get(`/api/run-observability?runId=${r.runId}`)).json;
  assert.equal(rec1.open, true);
  const id = r.calls[0].id;
  assert.equal((await post(`/api/calls/${id}/decision`, { decision: 'approve', approvalCode: approvalCode(rt, id) })).status, 200);
  const h2 = (await get(`/api/run-observability/head?runId=${r.runId}`)).json;
  assert.ok(h2.cursor > h1.cursor);
  assert.equal(h2.open, false);
});

test('Real: one gateway check is one Real run of response rows under Agent gateway; no person or agent row, nothing logged, no key', async (t) => {
  const door = await fakeDoor(t, GOOD);
  const { get, post, lines } = await boot(t, { env: doorEnv(door.port) });
  assert.equal((await get('/api/info')).json.realAvailable, true);
  assert.equal((await post('/api/gateway-check')).status, 409, 'not Real yet');
  assert.equal((await post('/api/mode', { source: 'real' })).status, 200);
  assert.deepEqual((await get('/api/run-observability')).json, { source: 'real', record: null, message: 'No gateway check yet in Real mode. Scenarios always run through the in-process stub, so their record is shown in Mock mode.' });
  const out = await post('/api/gateway-check');
  assert.equal(out.status, 200);
  assert.equal(out.json.listing.ok, true);
  assert.deepEqual(door.seen, ['initialize', 'notifications/initialized', 'tools/list', 'initialize', 'notifications/initialized', 'tools/call']);
  const res = (await get('/api/run-observability')).json;
  assert.equal(res.source, 'real');
  assert.equal(res.open, false);
  assert.deepEqual(res.noReply, []);
  const rec = res.record;
  assert.equal(rec.source, 'real');
  assert.deepEqual(assertRunObservability(rec), []);
  assert.match(rec.runId, /^check-[0-9a-f]{6}-\d+$/);
  const rows = rec.rows.filter((r) => r.origin !== 'not-logged');
  assert.deepEqual(rows.map((r) => [r.layer, r.origin, r.outcome]), [['gateway', 'response', 'allowed'], ['gateway', 'response', 'refused']]);
  assert.match(rows[0].message, /tools\/list for the agent key with 2 tools/);
  assert.match(rows[1].message, /refusal probe.*JSON-RPC error: .*policy denied/);
  assert.deepEqual(rec.coverage, { person: 'not-logged', agent: 'not-logged', authorize: 'not-logged', privilege: 'not-logged', gateway: 'response', resource: 'not-logged' });
  assert.ok(rec.rows.every((r) => r.origin !== 'logged' && r.origin !== 'simulated'));
  assert.match(rec.reasons.privilege, /cannot tell Privilege's policy decision from the gateway's own/);
  assert.ok(!JSON.stringify(res).includes(KEY) && !lines.join('\n').includes(KEY), 'the agent key is never shown');
  // The same two replies, as stdout lines with the rows' own times.
  const own = lines.filter((l) => l.endsWith(' mode=real') && l.includes(` run=${rec.runId} `));
  assert.equal(own.length, 2);
  for (const l of own) { assert.match(l, LINE); assert.ok(!WORDS.test(l.replace(/ actor=\S+/, ''))); }
  assert.deepEqual(own.map((l) => l.split(' ')[0]), rows.map((r) => r.at));
  assert.match(own[1], / step=probe-reply actor=tester result=stopped cause=rpc-error ref=demo-door /);
});

test('the mode is stored on the run: a Mock run never comes back as a Real reply after the toggle, and a Real run never as Mock', async (t) => {
  const door = await fakeDoor(t, GOOD);
  const { get, post } = await boot(t, { env: doorEnv(door.port) });
  const mock = (await post('/api/scenarios/benign/run')).json;
  assert.equal((await get('/api/run-observability')).json.record.runId, mock.runId);
  await post('/api/mode', { source: 'real' });
  // Scenarios still run through the stub in Real: they are Mock runs, and Real does not show them.
  const during = (await post('/api/scenarios/scope-exceeding/run')).json;
  assert.equal(during.mode, 'mock');
  assert.equal((await get('/api/run-observability')).json.record, null);
  const named = (await get(`/api/run-observability?runId=${mock.runId}`)).json;
  assert.deepEqual([named.source, named.record], ['real', null], 'a Mock run id is not answered in Real');
  assert.deepEqual((await get(`/api/run-observability/head?runId=${mock.runId}`)).json, { source: 'real', runId: null });
  await post('/api/gateway-check');
  const real = (await get('/api/run-observability')).json.record;
  assert.equal(real.source, 'real');
  await post('/api/mode', { source: 'mock' });
  const back = (await get('/api/run-observability')).json;
  assert.equal(back.source, 'mock');
  assert.equal(back.record.runId, during.runId, 'Mock answers its own newest run');
  assert.equal((await get(`/api/run-observability?runId=${real.runId}`)).json.record, null, 'a Real run id is not answered in Mock');
  await post('/api/mode', { source: 'real' });
  assert.equal((await get('/api/run-observability')).json.record.runId, real.runId, 'back in Real: the Real run again');
});

// What each reply of the door means, as the lab reads it. Anything that is not a policy answer is information; no reply is no row.
test('Real replies: only a status the door sent or a JSON-RPC error is a refusal; a failure of the door or of the lab is information; a call that did not complete is no reply', () => {
  const at = '2026-11-22T10:00:00.000Z';
  const refusal = (status, message) => ({ ok: false, refusal: { status, message, layer: 'other' }, ms: 5 });
  const probe = (listing, p) => gatewayCheckEvents({ app: 'demo-door', caller: 'tester', listing, listedAt: at, probe: p, probedAt: at });
  const ok = { ok: true, tools: [{ name: 'a' }], ms: 5 };
  const list = (l) => { const r = probe(l); return [r.events.map((e) => [e.outcome, e.cause]), r.noReply.length]; };
  assert.deepEqual(list(ok), [[['allowed', 'listed']], 0]);
  assert.deepEqual(list({ ok: true, tools: [], ms: 5 }), [[['info', 'empty-list']], 0], 'an empty list is not proof that a key is granted nothing');
  assert.deepEqual(list(refusal(401, 'MCP HTTP 401: bad key')), [[['refused', 'http-401']], 0]);
  assert.deepEqual(list(refusal(403, 'MCP HTTP 403: no')), [[['refused', 'http-403']], 0]);
  assert.deepEqual(list(refusal(500, 'MCP HTTP 500: oops')), [[['info', 'http-500']], 0], 'a server error is not a policy refusal');
  assert.deepEqual(list(refusal(404, 'MCP HTTP 404')), [[['info', 'http-404']], 0]);
  assert.deepEqual(list(refusal(302, 'MCP HTTP 302: redirects are not followed')), [[['info', 'http-302']], 0]);
  assert.deepEqual(list(refusal(null, 'policy denied: nothing is granted')), [[['refused', 'rpc-error']], 0], 'a 200 carrying a JSON-RPC error is refused');
  assert.deepEqual(list(refusal(null, 'reply is not JSON')), [[['info', 'unreadable']], 0], 'an unparsed body is information');
  assert.deepEqual(list(refusal(null, 'reply larger than 4194304 bytes')), [[['info', 'unreadable']], 0]);
  assert.deepEqual(list(refusal(null, 'MCP HTTP request timed out after 15000ms')), [[], 1], 'a timeout is no reply: no row');
  assert.deepEqual(list(refusal(null, 'MCP HTTP request unreachable (ECONNREFUSED)')), [[], 1]);
  // A gateway whose own words mention a timeout is still a reply, not a missing one.
  assert.deepEqual(list(refusal(null, 'upstream timed out')), [[['refused', 'rpc-error']], 0]);
  // The probe: an isError result is refused, a run is allowed (the door should not have), and it is only sent after a good list.
  assert.deepEqual(probe(ok, { ok: true, isError: true, text: 'no', ms: 1 }).events.map((e) => [e.step, e.outcome]), [['tools-list-reply', 'allowed'], ['probe-reply', 'refused']]);
  assert.deepEqual(probe(ok, { ok: true, isError: false, text: 'ran', ms: 1 }).events.map((e) => e.outcome), ['allowed', 'allowed']);
  assert.equal(probe(refusal(403, 'x')).events.length, 1);
});

test('Real end to end: a refused list, a 500, a door that is down and a 200 with a JSON-RPC error are each read as the table says, and the key never shows', async (t) => {
  const answers = { 'tools/list': () => ({ status: 200, body: { result: { tools: TOOLS } } }), 'tools/call': () => ({ status: 403, body: { error: { code: -32003, message: `forbidden: ${KEY} Bearer abcdefghijklmnopqrstuvwx a.b@corp.example` } } }) };
  const door = await fakeDoor(t, answers);
  const { get, post, lines } = await boot(t, { env: doorEnv(door.port) });
  await post('/api/mode', { source: 'real' });
  await post('/api/gateway-check');
  let res = (await get('/api/run-observability')).json;
  assert.deepEqual(res.record.rows.filter((r) => r.origin !== 'not-logged').map((r) => r.outcome), ['allowed', 'refused']);
  assert.match(res.record.rows.filter((r) => r.origin !== 'not-logged').at(-1).message, /HTTP 403/);
  assert.deepEqual(assertRunObservability(res.record), []);
  assert.ok(!JSON.stringify(res).includes(KEY) && !/abcdefghijklmnopqrstuvwx|corp\.example/.test(JSON.stringify(res) + lines.join('\n')), 'key, bearer and email are not shown');
  // The door is down: no reply, no row, and the page is told why.
  const down = await boot(t, { env: doorEnv(await freeBase('api', 1)) });
  await down.post('/api/mode', { source: 'real' });
  assert.equal((await down.post('/api/gateway-check')).status, 200);
  res = (await down.get('/api/run-observability')).json;
  assert.deepEqual(res.record.rows.filter((r) => r.origin !== 'not-logged'), []);
  assert.equal(res.record.coverage.gateway, 'not-logged');
  assert.match(res.record.reasons.gateway, /no reply to tools\/list/i);
  assert.deepEqual(res.noReply, ['tools/list got no reply (the call did not complete), so nothing is shown for it']);
  assert.ok(down.lines.some((l) => / step=tools-list-reply .* result=no-reply cause=no-reply /.test(l)));
});

test('a scenario run is never a Real run, in either direction', async (t) => {
  const { rt } = await mk(t);
  for (const s of SCENARIOS) {
    const r = await rt.runScenario(s.id);
    assert.equal((await rec(rt, r.runId)).record.source, 'mock', s.id);
    assert.equal(await rt.runLog.record('real', r.runId), null, s.id);
  }
});
