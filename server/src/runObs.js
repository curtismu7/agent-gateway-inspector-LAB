// Rule 27: this lab's side of the shared run-observability panel. The vendored collector (runObservability.js) is never edited here.
//
// Mock. Every decision the stub gateway makes is an audit entry (audit.js), stamped ONCE by the audit. gateway.js hands each entry to
// observe() as it is stored; this module turns it into rows, writes ONE stdout line per row with the same time, and keeps the rows in the
// run the call belongs to. The record is built from those stored rows only: nothing is re-run, no time is invented, and a hop the stub did
// not make is not shown. Layers: agent = the registry check, person = the end-user layer of the four scope layers, privilege = the lab's
// policy engine (policy.js, a stand-in for Privilege) and its approvals, gateway = what the stub gateway did with the call, resource = the
// stub tool server's answer. A call has no Authorize hop: the lab never calls PingOne Authorize.
//
// Real. The only Real call is POST /api/gateway-check (tools/list, then a refusal probe through a real Privilege door). Each reply the lab
// received is a `response` row under Agent gateway, stamped when the lab had it. Scenarios still run through the stub in every mode, so
// they are Mock runs and never appear in a Real answer. This lab reads no logs (no reader is vendored), so nothing is ever `logged`.
//
// One run per record. A Mock run is one scenario run. It is open while the scenario is executing and while any call of it still waits
// (a held call, an approved hold not yet used, an allowed call not yet forwarded); events on its calls join it until then, and an event after
// that is on stdout only. The mode is stored on the run: a run is returned only in the mode it was made in.
//
// Stdout line (what a collector would ship), one per row:
//   `<iso> agent-gateway-inspector decision layer=<layer> step=<step> actor=<who> result=<passed|stopped|unclear|no-reply> cause=<cause> ref=<call or door> run=<id|-> mode=<mock|real>`
// The family's matchers read words such as refused, denied, rejected, forbidden, failed, invalid, expired, mismatch, token, audience, scope and
// served, so the line uses none of them (steps and causes come from the tables below). A test runs every line through the shared classify().
import crypto from 'node:crypto';
import { RATE_LIMIT, TOOLS } from './policy.js';
import { createMasker, createRunObservability } from './runObservability.js';

export const MAX_RUN_ROWS = 500; // the shared collector keeps at most 500 rows and says so; this only bounds memory, and a cut says so too
export const KEEP_RUNS = 10; // per mode; an open run is never dropped
const SERVICE = 'agent-gateway-inspector';
const LAYER_ORDER = ['agent', 'person', 'privilege', 'gateway', 'resource']; // the order the stub computes them in, used to break ties between rows of one instant

// Only safe characters survive, so a name typed by a caller cannot add a second key=value pair, a quote or a line.
export const lineValue = (v, n = 64) => String(v ?? '').replace(/[^A-Za-z0-9._:/@-]+/g, '_').slice(0, n) || '-';
// The panel masks emails, addresses and ids in every row, so the stdout line masks them too (then keeps only safe characters).
const { mask } = createMasker();
const field = (v) => lineValue(mask(String(v ?? '')));
const RESULT = { allowed: 'passed', refused: 'stopped', blocked: 'stopped', info: 'unclear' };
const text = (v, n = 160) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, n);

const PRODUCT = { agent: 'stub agent registry', person: 'stub end-user check', privilege: 'stub policy engine', gateway: 'stub gateway', resource: 'stub tool server' };

// Why a call was turned away: reason code -> [lane, outcome, word for the stdout line, sentence for the row]. `blocked` = the lab's own stop (a cap,
// a full queue, the fail-closed guard); `refused` = an ordinary check on the call did not pass.
const APPROVAL = 'The approval reference';
const DENY = {
  unknown_agent: ['agent', 'refused', 'unknown-agent', (c) => `The agent registry has no agent called ${c.agent}.`],
  unknown_tool: ['privilege', 'refused', 'unknown-tool', (c) => `The policy engine's catalog has no tool called ${c.tool}.`],
  bad_arguments: ['privilege', 'refused', 'bad-arguments', (c) => (c.scope ? 'The arguments are not a JSON object the gateway accepts, or are too large.' : 'The call did not name an agent and a tool as text.')],
  token_invalid: ['privilege', 'refused', 'wrong-credential', () => 'The credential the agent presented is unknown, or belongs to another agent.'],
  scope_surface: ['privilege', 'refused', 'surface-layer', (c) => `Layer 1 (surface): the credential is not valid on the ${c.surface} surface.`],
  scope_application: ['privilege', 'refused', 'application-layer', (c) => `Layer 2 (application): application ${c.application} is not registered for ${c.tool}.`],
  scope_exceeded: ['privilege', 'refused', 'action-layer', (c) => `Layer 3 (action): the agent does not hold ${c.scope}.`],
  scope_end_user: ['person', 'refused', 'end-user-layer', (c) => `Layer 4 (end user): ${c.endUser} does not hold ${c.scope}.`],
  rate_limited: ['privilege', 'blocked', 'rate-limit', () => `The rate limit was reached (${RATE_LIMIT.max} calls in ${RATE_LIMIT.windowMs / 1000} s per agent).`],
  prompt_injection: ['privilege', 'refused', 'rule-injection', (c) => `Rule ${c.ruleId} matched: the arguments carry instruction-like text or hidden characters.`],
  amount_over_limit: ['privilege', 'refused', 'rule-amount', (c) => `Rule ${c.ruleId} matched: the amount is over the hard limit.`],
  default_deny: ['privilege', 'refused', 'no-rule', () => 'No rule allows this call, so the policy engine denies it by default.'],
  evaluation_error: ['privilege', 'blocked', 'fail-closed', () => 'The policy could not be evaluated, or answered with something that is not allow, deny or hold, so the gateway failed closed.'],
  pause_queue_full: ['privilege', 'blocked', 'queue-full', () => 'Too many calls are already waiting for a human, so this one is denied instead of queued.'],
  approval_unknown: ['privilege', 'refused', 'approval-unknown', () => `${APPROVAL} is not one this gateway issued.`],
  approval_consumed: ['privilege', 'refused', 'approval-spent', () => `${APPROVAL} was already used: an approval works once.`],
  approval_expired: ['privilege', 'refused', 'approval-lapsed', () => `${APPROVAL} ran out before it was used.`],
  approval_pending: ['privilege', 'refused', 'approval-unanswered', () => `${APPROVAL} has not been answered by a human yet.`],
  approval_denied: ['privilege', 'refused', 'approval-declined', () => `${APPROVAL} was not approved.`],
  approval_mismatch: ['privilege', 'refused', 'approval-changed-call', () => `${APPROVAL} is bound to a different call: this one was changed.`],
};
const OTHER = ['privilege', 'refused', 'other', (c) => `The gateway turned the call away (reason ${text(c.reason, 40)}).`];

// One stored audit entry -> rows [{ layer, step, outcome, cause, who, ref, message, detail, result? }], in the order the stub computed them.
// `claims` are the claims the policy read from the credential (only a decision entry has them). An entry that is not a log row of any layer
// (reset) gives none.
export function rowsOf(entry, claims = null) {
  const d = entry.data || {};
  const who = d.agentId;
  const ref = entry.callId;
  const base = { callId: entry.callId, tool: d.tool, auditSeq: entry.seq };
  const row = (layer, step, outcome, cause, message, detail = {}, extra = {}) => ({ layer, step, outcome, cause, who, ref, message, detail: { ...base, ...detail }, ...extra });
  switch (entry.type) {
    case 'decision': {
      const rows = [];
      const spec = Object.hasOwn(DENY, d.reason) ? DENY[d.reason] : OTHER;
      const c = { agent: who, tool: d.tool, scope: d.requiredScope, surface: claims?.surface, application: claims?.application, endUser: claims?.endUser, ruleId: d.ruleId, reason: d.reason };
      const verdict = { reason: d.reason, ruleId: d.ruleId, requiredScope: d.requiredScope, layers: d.layers };
      // Did the policy look at the registry at all? A call that did not name an agent and a tool, and a failed evaluation, never reached it.
      if (d.reason !== 'evaluation_error' && !(d.reason === 'bad_arguments' && !d.requiredScope)) {
        rows.push(d.reason === 'unknown_agent'
          ? row('agent', 'agent-registry', 'refused', 'unknown-agent', spec[3](c), verdict)
          : row('agent', 'agent-registry', 'allowed', '-', `${who} is a registered agent.`));
      }
      if (d.layers?.endUser === 'pass' || d.layers?.endUser === 'fail') {
        rows.push(d.layers.endUser === 'pass'
          ? row('person', 'end-user-layer', 'allowed', '-', `Layer 4 (end user): ${c.endUser} holds ${c.scope}. The end user is a name in the stub issuer's table: nobody signed in.`, { endUser: c.endUser })
          : row('person', 'end-user-layer', 'refused', 'end-user-layer', `${spec[3](c)} The end user is a name in the stub issuer's table: nobody signed in.`, { ...verdict, endUser: c.endUser }));
      }
      // The registry and the end-user layer report their own refusal; every other verdict is the policy engine's.
      if (d.decision === 'allow') {
        rows.push(row('privilege', 'policy-verdict', 'allowed', d.reason === 'hold_approved' ? 'approval-used' : 'rule-allow',
          d.reason === 'hold_approved' ? `The approval was used: its reference is known, approved, unused and bound to exactly this call (rule ${d.ruleId} had held it for a human).` : `Rule ${d.ruleId} allows the call; the four scope layers and the rate limit passed first.`, verdict));
      } else if (d.decision === 'pause') {
        rows.push(row('privilege', 'policy-verdict', 'info', 'rule-hold', `Rule ${d.ruleId} holds the call for a human: it is not forwarded until a human answers.`, verdict));
      } else if (spec[0] === 'privilege') {
        rows.push(row('privilege', 'policy-verdict', spec[1], spec[2], spec[3](c), verdict));
      }
      if (d.decision === 'allow') {
        const upstream = Object.hasOwn(TOOLS, d.tool) ? TOOLS[d.tool].upstream : null;
        rows.push(row('gateway', 'gateway-verdict', 'allowed', 'let-through', `The stub gateway let the call through to the stub tool server${upstream ? ` "${upstream}"` : ''}.`));
      } else if (d.decision === 'pause') {
        rows.push(row('gateway', 'gateway-verdict', 'info', 'held', claims?.attended === false
          ? 'The stub gateway holds the call and answers at once with a hold reference: no connection is kept open, and nothing is forwarded.'
          : 'The stub gateway holds the call: nothing is forwarded until a human answers.'));
      } else {
        rows.push(row('gateway', 'gateway-verdict', spec[1], 'turned-away', 'The stub gateway turned the call away: it was not forwarded to any tool server.'));
      }
      return rows;
    }
    case 'pause_opened':
      return [row('privilege', 'approval-opened', 'info', 'attended', `The policy engine opened an approval request for a human; it waits until ${d.expiresAt}.`, { expiresAt: d.expiresAt })];
    case 'hold_opened':
      return [row('privilege', 'approval-opened', 'info', 'unattended', `The policy engine opened an approval request with a reference; no connection is kept open, and the reference lapses at ${d.expiresAt}.`, { ref: d.ref, expiresAt: d.expiresAt })];
    case 'pause_approved':
      return [row('privilege', 'approval-answered', 'allowed', 'approved', 'A human approved the call with the one-shot approval code; the gateway forwards it. The approver is whoever holds the code: the lab has no sign-in.')];
    case 'hold_approved':
      return [row('privilege', 'approval-answered', 'info', 'approved-for-retry', `A human approved the hold: nothing was forwarded. It opened a grant the agent's exact retry can use once, until ${d.expiresAt}. The approver is whoever holds the code: the lab has no sign-in.`, { ref: d.ref, expiresAt: d.expiresAt })];
    case 'pause_denied':
    case 'hold_denied':
      return [row('privilege', 'approval-answered', 'refused', 'declined-by-human', 'A human denied the call: it was never forwarded.', d.ref ? { ref: d.ref } : {})];
    case 'pause_expired':
    case 'hold_expired':
      return [row('privilege', 'approval-lapsed', 'blocked', 'no-use-in-time', 'The wait for a human ran out (no answer, or an approval nobody used in time): the gateway fails closed and the call is not forwarded.', d.ref ? { ref: d.ref } : {})];
    case 'pause_bad_code':
    case 'hold_bad_code':
      return [row('privilege', 'approval-code', 'refused', 'wrong-code', `A wrong approval code was presented (${d.failures} so far): the answer was not accepted.`, { failures: d.failures })];
    case 'pause_locked':
    case 'hold_locked':
      return [row('privilege', 'approval-locked', 'blocked', 'locked', 'Three wrong approval codes locked the approval request: it can no longer be answered.')];
    case 'hold_consumed':
      return [row('privilege', 'approval-spent', 'info', 'spent', `The approval was used by ${d.consumedBy}: an approval works once.`, { ref: d.ref, consumedBy: d.consumedBy })];
    case 'forwarded':
      return [row('resource', 'tool-server-answer', 'info', '-', `The stub tool server "${d.upstream}" answered the forwarded call. It makes no check of its own.`, { upstream: d.upstream })];
    case 'upstream_error': {
      // A timeout, a refused connection or the target guard is no reply at all; any other error is an answer the gateway could not use.
      const silent = ['upstream_timeout', 'upstream_unreachable', 'upstream_refused_target'].includes(d.error);
      return [row('resource', 'tool-server-answer', 'info', 'no-usable-answer', `The stub tool server gave no usable answer to the forwarded call (${text(d.error, 40)}).`, { error: text(d.error, 40) }, silent ? { result: 'no-reply' } : {})];
    }
    default:
      return [];
  }
}

export const decisionLine = (row, at, runId, mode) => `${at} ${SERVICE} decision layer=${lineValue(row.layer)} step=${lineValue(row.step)} actor=${field(row.who)} result=${row.result ?? RESULT[row.outcome]} cause=${lineValue(row.cause)} ref=${field(row.ref)} run=${runId ? lineValue(runId) : '-'} mode=${mode}`;

// ---- Real: one gateway check -> the replies the lab received ----------------------------------------------------------------------------
// listing / probe are what gatewayReal.js returned: { ok, tools | isError, text, ms } or { ok: false, refusal: { status, message }, ms }. A reply the lab did not get
// (the call never completed) makes no row and is named in `noReply`; the lab's own words for those start with "MCP HTTP request".
function replyOf(kind, r) {
  const what = kind === 'list' ? 'tools/list' : 'the refusal probe (a tool no policy grants)';
  if (r.ok) {
    if (kind === 'list') {
      const n = Array.isArray(r.tools) ? r.tools.length : 0;
      return n > 0
        ? { outcome: 'allowed', cause: 'listed', message: `The door answered tools/list for the agent key with ${n} tool${n === 1 ? '' : 's'}.`, detail: { tools: n, ms: r.ms } }
        : { outcome: 'info', cause: 'empty-list', message: 'The door answered tools/list with no tools: the lab cannot tell a key that is granted nothing from a reply it could not read.', detail: { tools: 0, ms: r.ms } };
    }
    return r.isError
      ? { outcome: 'refused', cause: 'tool-error', message: `The door answered the refusal probe with a tool error (isError): ${text(r.text)}`, detail: { isError: true, ms: r.ms } }
      : { outcome: 'allowed', cause: 'ran-probe', message: 'The door ran the refusal probe, a tool no policy should grant: check the door policy.', detail: { isError: false, ms: r.ms } };
  }
  const { status, message } = r.refusal;
  const words = text(message);
  if (status === null && /^MCP HTTP request (?:timed out|unreachable)/.test(message)) return null;
  if (status === 401 || status === 403) return { outcome: 'refused', cause: `http-${status}`, message: `The door answered ${what} with HTTP ${status}: ${words}`, detail: { status, ms: r.ms } };
  if (typeof status === 'number') return { outcome: 'info', cause: `http-${status}`, message: `The door answered ${what} with HTTP ${status}, which is not a policy answer the lab can read: ${words}`, detail: { status, ms: r.ms } };
  if (/^(?:reply is not JSON|reply larger than)/.test(message)) return { outcome: 'info', cause: 'unreadable', message: `The lab could not read the door's reply to ${what}: ${words}`, detail: { ms: r.ms } };
  return { outcome: 'refused', cause: 'rpc-error', message: `The door answered ${what} with a JSON-RPC error: ${words}`, detail: { ms: r.ms } };
}

export function gatewayCheckEvents({ app, caller, listing, listedAt, probe, probedAt }) {
  const events = []; const noReply = [];
  for (const [kind, step, r, at] of [['list', 'tools-list-reply', listing, listedAt], ['probe', 'probe-reply', probe, probedAt]]) {
    if (!r) continue; // the probe is only sent when tools/list got through
    const reply = replyOf(kind, r);
    const e = { layer: 'gateway', step, who: caller, ref: app, at, product: 'Privilege door reply', ...(reply ?? { outcome: 'info', cause: 'no-reply', result: 'no-reply' }) };
    if (reply) events.push(e); else noReply.push(e);
  }
  return { events, noReply };
}

const MOCK_WHY = {
  person: 'No call in this run reached the end-user layer (an earlier check stopped it, or nothing has run yet). The lab has no sign-in: an end user is a name in the stub issuer\'s table.',
  agent: 'No call in this run reached the agent registry (nothing has run yet, or the call did not name an agent and a tool as text).',
  authorize: 'This lab does not call PingOne Authorize: the stub policy engine (shown under Privilege) decides.',
  privilege: 'The stub policy engine logged nothing in this run so far.',
  gateway: 'The stub gateway logged nothing in this run so far.',
  resource: 'No call of this run was forwarded, so no stub tool server was reached.',
};
const REAL_WHY = {
  person: 'This lab signs nobody in. The gateway check sends an agent key from the settings file; nothing about a person reaches the lab.',
  agent: 'The lab sends the agent key and gets the door\'s reply (shown under Agent gateway). It reads no gateway log, so it does not claim the gateway logged the key.',
  authorize: 'This lab does not call PingOne Authorize.',
  privilege: 'The lab only sees the door\'s reply: it cannot tell Privilege\'s policy decision from the gateway\'s own, and it reads no Privilege log, so nothing is claimed here.',
  gateway: 'The door gave no reply to tools/list, so there is no reply to show.',
  resource: 'The lab reads no tool server: tools/list is answered by the gateway, and the refusal probe names a tool nothing grants.',
};

// The run log of ONE runtime. observe(entry, ctx) is called by gateway.js for every audit entry, in order, right after it was stored.
export function createRunLog({ write = (line) => process.stdout.write(`${line}\n`), clock = Date.now } = {}) {
  // Run ids are unique across Reset and restarts: a per-log random part and a counter that survives Reset.
  const part = crypto.randomBytes(3).toString('hex');
  let made = 0;
  let runs = { mock: [], real: [] }; // oldest first
  const stamp = () => new Date(clock()).toISOString();
  const emitLine = (line) => { try { write(line); } catch (e) { console.error(`[${SERVICE}] run log write failed: ${e?.code || e?.name || 'Error'}`); } };
  const isOpen = (run) => run.executing || run.inflight.size > 0;
  // The id carries no scenario name: scenario names hold words the family's matchers read (scope, refused, expired), and the id is in every stdout line.
  const newRun = (source, startedAt) => {
    made += 1;
    const run = { id: `${source === 'mock' ? 'run' : 'check'}-${part}-${made}`, source, startedAt, endedAt: startedAt, executing: true, inflight: new Set(), rows: [], cursor: 0, cut: false, noReply: [] };
    const list = runs[source];
    list.push(run);
    while (list.length > KEEP_RUNS) { const i = list.findIndex((r) => !isOpen(r)); if (i < 0) break; list.splice(i, 1); }
    return run;
  };
  const find = (source, runId) => (runId === undefined ? runs[source].at(-1) : runs[source].find((r) => r.id === runId)) ?? null;
  // A call is on its way until its last event: a denial ends it at once; an allowed or held one ends at the tool server's answer, a human's refusal or a lapse.
  // Using a hold hands the run on to the agent's retry (a new call), which is added before the held call is dropped so the run never looks closed in between.
  const ENDS = new Set(['forwarded', 'upstream_error', 'pause_denied', 'pause_expired', 'pause_locked', 'hold_denied', 'hold_expired', 'hold_locked']);
  const track = (run, entry) => {
    if (entry.type === 'decision') { if (entry.data.decision === 'deny') run.inflight.delete(entry.callId); else run.inflight.add(entry.callId); } else if (entry.type === 'hold_consumed') { run.inflight.add(entry.data.consumedBy); run.inflight.delete(entry.callId); } else if (ENDS.has(entry.type)) run.inflight.delete(entry.callId);
  };

  function observe(entry, { runId = null, claims = null } = {}) {
    const rows = rowsOf(entry, claims);
    if (!rows.length) return;
    const run = runId ? find('mock', runId) : null;
    const joins = Boolean(run) && isOpen(run);
    for (const r of rows) {
      if (joins) {
        run.rows.push({ at: entry.at, layer: r.layer, product: PRODUCT[r.layer], outcome: r.outcome, message: r.message, detail: r.detail });
        run.cursor += 1;
        if (run.rows.length > MAX_RUN_ROWS) { run.rows.shift(); run.cut = true; }
      }
      emitLine(decisionLine(r, entry.at, joins ? run.id : null, 'mock'));
    }
    if (joins) { run.endedAt = entry.at; track(run, entry); }
  }

  // A scenario run opens a run; the runtime closes the execution when the scenario's script has finished (calls may still wait for a human).
  // Neither throws: a failure here must not break the scenario.
  const failed = (what, e) => console.error(`[${SERVICE}] ${what} failed: ${e?.code || e?.name || 'Error'}: ${String(e?.message ?? e).slice(0, 120)}`);
  function begin() {
    try { return newRun('mock', stamp()).id; } catch (e) { failed('starting the run record', e); return null; }
  }
  function executed(runId) {
    const run = runId ? find('mock', runId) : null;
    if (run) run.executing = false;
  }

  // One gateway check = one Real run, complete when it is recorded. Never throws either: a failure here must not break the check.
  function recordGatewayCheck({ app, caller, startedAt, listing, listedAt, probe, probedAt }) {
    try {
      const { events, noReply } = gatewayCheckEvents({ app, caller, listing, listedAt, probe, probedAt });
      const run = newRun('real', startedAt);
      run.executing = false;
      run.noReply = noReply.map((e) => `${e.step === 'tools-list-reply' ? 'tools/list' : 'the refusal probe'} got no reply (the call did not complete), so nothing is shown for it`);
      for (const e of [...events, ...noReply].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
        if (e.result !== 'no-reply') run.rows.push({ at: e.at, layer: e.layer, product: e.product, outcome: e.outcome, message: e.message, detail: { cause: e.cause, ...e.detail } });
        emitLine(decisionLine(e, e.at, run.id, 'real'));
        run.endedAt = e.at;
      }
      run.cursor = run.rows.length;
      return run.id;
    } catch (e) {
      failed('recording the gateway check', e);
      return null;
    }
  }

  // { record, open, noReply } for the run, all read at one instant, or null when the mode keeps no such run.
  async function record(source, runId) {
    const run = find(source, runId);
    if (!run) return null;
    const open = isOpen(run);
    const noReply = [...run.noReply];
    const mock = source === 'mock';
    const layers = ['person', 'agent', 'authorize', 'privilege', 'gateway', 'resource'].map((layer) => {
      const mine = run.rows.filter((r) => r.layer === layer);
      const why = (mock ? MOCK_WHY : REAL_WHY)[layer];
      return mock ? { layer, products: [], reason: why, simulated: mine } : { layer, products: [], reason: why, responses: mine };
    });
    const rec = await createRunObservability({ clock }).collectRun({ runId: run.id, startedAt: run.startedAt, endedAt: run.endedAt, source, layers });
    // Rows of one instant (one decision makes several) are put back in the order the stub computed them, not the collector's layer order.
    const stamped = rec.rows.filter((r) => r.at !== null).sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.detail?.auditSeq ?? 0) - (b.detail?.auditSeq ?? 0) || LAYER_ORDER.indexOf(a.layer) - LAYER_ORDER.indexOf(b.layer));
    return { record: { ...rec, truncated: rec.truncated || run.cut, rows: [...stamped.map((r, i) => ({ ...r, id: `r${i + 1}` })), ...rec.rows.filter((r) => r.at === null)] }, open, noReply };
  }

  return {
    observe, begin, executed, recordGatewayCheck, record, stamp,
    // The newest run of a mode, or the one with that id; null when none is kept in that mode.
    head(source, runId) { const run = find(source, runId); return run ? { runId: run.id, cursor: run.cursor, open: isOpen(run) } : null; },
    reset() { runs = { mock: [], real: [] }; },
  };
}
