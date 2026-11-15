// "What Privilege did" for this lab: builds the gateway-trace record (server/src/gatewayTrace.js, vendored, never edited) for one call.
//
// HONESTY. This lab has no gateway to talk to: the gateway is the in-process stub in gateway.js and policy.js, so no HTTP call is made.
// What the trace shows, and why each part may say what it says:
//   - The request and the response are a lab-shaped JSON-RPC rendering of the call and of what the stub answered (the URL host is
//     gateway.invalid, the status codes and error codes are the lab's own). They are built from the stored call record, never invented.
//   - Every decision is `checked`: policy.js evaluates the checks in a fixed order and stops at the first that refuses; the record keeps
//     the reason and the four layer results, so which checks passed, which one refused and which were never reached is read from what the
//     code computed. A check that was never reached is `skipped`, not passed.
//   - The one `observed` decision is the tool server's answer: it is read from the stub upstream's reply, not computed by a check.
//   - No approval code is ever put in a trace (the one-shot code stays in gateway.js); the hold reference is shown, as the call detail already does.
// A call still waiting for a human, or still being forwarded, has no answer yet, so it has no trace (null): nothing is shown for it.
import { RULES, RATE_LIMIT } from './policy.js';
import { bearerForDisplay, mockTrace } from './gatewayTrace.js';

export const MOCK_GATEWAY_URL = 'https://agent-gateway.invalid';

const RULE_BY_ID = new Map(RULES.map((r) => [r.id, r]));
const LAYER_STEPS = [
  { id: 'surface', label: 'Scope layer 1: surface' },
  { id: 'application', label: 'Scope layer 2: application' },
  { id: 'action', label: 'Scope layer 3: action' },
  { id: 'endUser', label: 'Scope layer 4: end user' },
];
// The step that refused, by the reason the record keeps. A reason not listed here means every check before the rules passed.
const REFUSED_AT = { unknown_agent: 'agent', unknown_tool: 'tool', token_invalid: 'token', scope_surface: 'surface', scope_application: 'application', scope_exceeded: 'action', scope_end_user: 'endUser', rate_limited: 'rate' };

const decisionRow = (id, label, outcome, evidence, basis = 'checked') => ({ id, label, outcome, basis, evidence });

function checksFor(c, p) {
  if (c.reason === 'evaluation_error') {
    return [decisionRow('evaluation', 'Policy evaluation', 'fail', 'the policy could not be evaluated, or returned a verdict that is not allow, deny or hold, so the gateway refuses (fails closed)')];
  }
  const refusedAt = c.reason === 'bad_arguments' ? (c.requiredScope ? 'args' : 'agent') : REFUSED_AT[c.reason];
  const steps = [
    { id: 'agent', label: 'Agent registered', ok: `${c.agentId} is a registered agent`, no: c.reason === 'bad_arguments' ? 'the call did not name an agent and a tool as text' : `${c.agentId} is not a registered agent` },
    { id: 'tool', label: 'Tool in the catalog', ok: `${c.tool} is in the tool catalog`, no: `${c.tool} is not in the tool catalog` },
    { id: 'args', label: 'Arguments', ok: 'the arguments are a JSON object the gateway accepts', no: 'the arguments are not a JSON object the gateway accepts (or are too large)' },
    { id: 'token', label: 'Token', ok: `token ${c.claims?.subject ?? p.tokenId ?? ''} belongs to ${c.agentId}`, no: 'the token is unknown, or it does not belong to this agent' },
    { id: 'surface', label: LAYER_STEPS[0].label, ok: `the token is valid on the ${c.claims?.surface} surface`, no: `the token is not valid on the ${c.claims?.surface} surface` },
    { id: 'application', label: LAYER_STEPS[1].label, ok: `application ${c.claims?.application} is registered for ${c.tool}`, no: `application ${c.claims?.application} is not registered for ${c.tool}` },
    { id: 'action', label: LAYER_STEPS[2].label, ok: `the agent holds ${c.requiredScope}`, no: `the agent does not hold ${c.requiredScope}` },
    { id: 'endUser', label: LAYER_STEPS[3].label, ok: `end user ${c.claims?.endUser} holds ${c.requiredScope}`, no: `end user ${c.claims?.endUser} does not hold ${c.requiredScope}` },
    { id: 'rate', label: 'Rate limit', ok: `under the limit of ${RATE_LIMIT.max} calls in ${RATE_LIMIT.windowMs / 1000} seconds`, no: `over the limit of ${RATE_LIMIT.max} calls in ${RATE_LIMIT.windowMs / 1000} seconds` },
  ];
  const rows = [];
  let stopped = false;
  for (const s of steps) {
    if (stopped) rows.push(decisionRow(s.id, s.label, 'skipped', 'not reached: an earlier check refused the call'));
    else if (s.id === refusedAt) { stopped = true; rows.push(decisionRow(s.id, s.label, 'fail', s.no)); } else rows.push(decisionRow(s.id, s.label, 'pass', s.ok));
  }
  rows.push(rulesRow(c, stopped));
  if (stopped) return rows;
  if (c.reason === 'pause_queue_full') rows.push(decisionRow('queue', 'Room to hold the call', 'fail', 'too many calls are already waiting for a human, so the gateway denies this one instead of queueing it'));
  if (c.reason === 'hold_approved') rows.push(decisionRow('approval', 'Approval', 'pass', `approval ${c.approvalRef} is known, approved, unspent, unexpired and bound to exactly this call; it is now spent`));
  else if (c.reason?.startsWith('approval_')) rows.push(decisionRow('approval', 'Approval', 'fail', `approval ${c.approvalRef ?? '(none valid)'} was refused: ${c.reason}`));
  if (c.pause && c.pause.state !== 'pending') {
    const state = c.pause.state;
    rows.push(decisionRow('human', 'Human answer', state === 'approved' ? 'pass' : 'fail',
      state === 'approved' ? 'a human approved the call with the one-shot approval code' : state === 'denied' ? 'a human denied the call' : state === 'expired' ? 'nobody answered before the pause expired' : 'three wrong approval codes locked the pause'));
  }
  if (c.outcome === 'forwarded') rows.push(decisionRow('forward', 'Tool server', 'pass', 'the call was forwarded and the stub tool server answered', 'observed'));
  else if (c.outcome === 'upstream_error') rows.push(decisionRow('forward', 'Tool server', 'fail', `the call was forwarded but the stub tool server did not answer: ${c.upstream?.error ?? 'error'}`, 'observed'));
  return rows;
}

function rulesRow(c, stopped) {
  if (stopped) return decisionRow('rules', 'Rules', 'skipped', 'not reached: an earlier check refused the call');
  const rule = c.ruleId ? RULE_BY_ID.get(c.ruleId) : null;
  if (rule?.effect === 'allow') return decisionRow('rules', 'Rules', 'pass', `rule ${rule.id} allows this call (deny beats hold beats allow, and nothing stronger matched)`);
  if (rule?.effect === 'deny') return decisionRow('rules', 'Rules', 'fail', `rule ${rule.id} denies this call: ${rule.reason}`);
  if (rule?.effect === 'pause') return decisionRow('rules', 'Rules', 'info', `rule ${rule.id} matched: hold for a human before the call is forwarded`);
  if (c.reason === 'pause_queue_full') return decisionRow('rules', 'Rules', 'info', 'a rule matched: hold for a human');
  return decisionRow('rules', 'Rules', 'fail', 'no rule allows this call, so the gateway denies it by default');
}

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const refusal = (id, code, message, data) => ({ status: 403, body: { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } } });

// What the stub answered, or null while the call has no answer yet (waiting for a human, or being forwarded).
function answerFor(c) {
  const id = c.seq;
  if (c.hold) return refusal(id, -32002, 'held for a human: no connection is kept open; retry the exact call with the reference once a human approves', { reference: c.hold.ref, ttlSeconds: c.hold.ttlMs / 1000 });
  if (c.outcome === 'pending' || c.outcome === 'forwarding') return null;
  if (c.outcome === 'forwarded') return { status: 200, body: { jsonrpc: '2.0', id, result: { ...text(JSON.stringify(c.upstream?.result ?? null)), isError: false } } };
  if (c.outcome === 'upstream_error') return { status: 200, body: { jsonrpc: '2.0', id, result: { ...text(`the tool server did not answer: ${c.upstream?.error ?? 'error'}`), isError: true } } };
  if (c.outcome === 'denied_by_human') return refusal(id, -32003, 'denied by the human who was asked');
  if (c.outcome === 'expired') return refusal(id, -32003, 'the pause expired before a human answered');
  if (c.reason === 'too_many_bad_codes') return refusal(id, -32003, 'the pause was locked after three wrong approval codes');
  return refusal(id, -32001, `policy denied: ${c.reason}`, { reason: c.reason, ...(c.ruleId ? { ruleId: c.ruleId } : {}) });
}

// c: the stored call record (not the API view: it still holds the stub upstream's answer). p: what the simulated agent presented ({ tokenId, surface }).
export function traceForCall(c, p = {}) {
  const answer = answerFor(c);
  if (!answer) return null;
  const surface = p.surface === undefined ? 'mcp' : typeof p.surface === 'string' && /^[a-z0-9-]{1,16}$/.test(p.surface) ? p.surface : 'unknown-surface';
  const tokenId = p.tokenId ?? c.claims?.subject;
  const rpc = {
    jsonrpc: '2.0', id: c.seq, method: 'tools/call',
    params: { name: c.tool, arguments: c.args, ...(c.approvalRef ? { _meta: { approvalReference: c.approvalRef } } : {}) },
  };
  return mockTrace({
    url: `${MOCK_GATEWAY_URL}/${surface}`,
    authorization: typeof tokenId === 'string' ? bearerForDisplay(tokenId) : 'Bearer <none>',
    rpc, status: answer.status, body: answer.body,
    decisions: checksFor(c, p),
    record: `Audit entry "decision" for ${c.id}: ${c.decision}, ${c.reason}.`,
  });
}
