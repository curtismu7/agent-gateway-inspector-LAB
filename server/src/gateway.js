// The stub gateway: takes a simulated agent tool call, decides allow / deny / pause with policy.js, forwards allowed
// calls to a stub upstream, holds paused calls for a human, and writes every step to the audit trail.
//
// Decision buffer: a bounded ring of call records (RING_CAP). Waiting (paused or held) calls are capped separately.
// Two kinds of wait, chosen by the verified token's `attended` claim (Ping release claim 2026-11-02, UNVERIFIED on our tenant):
//   attended   (a human is in the session) the call stays pending; decide() with the one-shot code forwards it.
//   unattended nothing is kept open: handle() returns at once, blocked, with a reference and an expiry. decide() approves
//              the reference; the agent then retries the exact call with that reference. The approval is bound to a hash of
//              the call, works once, and is an input to the policy, never a bypass: the retry is evaluated like any call.
// An evaluation error, or a verdict that is not allow / deny / pause, denies (fails closed).
// Everything an agent or an upstream supplies is redacted and made inert before it is stored or returned.
import crypto from 'node:crypto';
import { createAudit } from './audit.js';
import { AGENTS, GRANT_TTL_MS, LAYERS, evaluate, PAUSE_TTL_MS, RATE_LIMIT, TOOLS } from './policy.js';
import { HOLD_REF_RE, callHash, newHoldRef } from './approval.js';
import { inertValue, revealText } from './sanitize.js';
import { redactRecord } from './redaction.js';

export const RING_CAP = 200;
export const PENDING_CAP = 20;
export const MAX_BAD_CODES = 3;
const MAX_ARGS_JSON = 2000;
const RESULT_JSON_CAP = 1500;
const MIN_TTL = 50;

const safeText = (v, max = 64) => revealText(typeof v === 'string' ? v : String(v), max);
const clean = (v) => inertValue(redactRecord({ v }).v);
const DECISIONS = ['allow', 'deny', 'pause'];
const verdictOk = (v) => Boolean(v) && typeof v === 'object' && DECISIONS.includes(v.decision) && typeof v.reason === 'string';
const notReached = () => Object.fromEntries(LAYERS.map((l) => [l, 'skipped']));
const failClosed = () => ({ decision: 'deny', reason: 'evaluation_error', ruleId: null, layers: notReached(), claims: null });

export function createGateway({ forward, now = () => Date.now(), audit = createAudit({ now: () => new Date(now()) }), ringCap = RING_CAP, pendingCap = PENDING_CAP, rate = RATE_LIMIT, ttlMs = PAUSE_TTL_MS, grantTtlMs = GRANT_TTL_MS, evaluateFn = evaluate } = {}) {
  let calls = new Map(); // id -> record (insertion order = age)
  let seq = 0;
  let rev = 0;
  let epoch = 1;
  const rates = new Map(); // registered agent id -> recent call times
  const secrets = new Map(); // call id -> { code, failures, args }
  const holdRefs = new Map(); // hold reference -> call id
  const retryInputs = new Map(); // call id -> what the simulated agent sends again to retry a held call

  const touch = (c) => { c.rev = ++rev; };
  // Waiting for a human: an attended call pending, or an unattended hold that is not yet decided or not yet used.
  const waiting = (c) => c.outcome === 'pending' || (c.outcome === 'held' && (c.hold.state === 'pending' || c.hold.state === 'approved'));
  const pendingCount = () => { let n = 0; for (const c of calls.values()) if (waiting(c)) n += 1; return n; };

  function sweep() {
    const t = now();
    for (const c of calls.values()) {
      if (c.outcome === 'pending' && c.pause.expiresAtMs <= t) {
        c.outcome = 'expired';
        c.pause.state = 'expired';
        secrets.delete(c.id);
        touch(c);
        audit.append('pause_expired', c.id, { agentId: c.agentId, tool: c.tool });
      } else if (c.outcome === 'held' && waiting(c) && c.hold.expiresAtMs <= t) {
        c.outcome = 'expired';
        c.hold.state = 'expired';
        c.hold.expiredAt = new Date(t).toISOString();
        secrets.delete(c.id);
        touch(c);
        audit.append('hold_expired', c.id, { agentId: c.agentId, tool: c.tool, ref: c.hold.ref });
      }
    }
  }

  function evictIfFull() {
    while (calls.size > ringCap) {
      const oldest = [...calls.values()].find((c) => !waiting(c));
      if (!oldest) break;
      calls.delete(oldest.id);
      if (oldest.hold) holdRefs.delete(oldest.hold.ref);
      retryInputs.delete(oldest.id);
    }
  }

  function rateExceeded(agentId) {
    const t = now();
    const recent = (rates.get(agentId) ?? []).filter((x) => t - x < rate.windowMs);
    const exceeded = recent.length >= rate.max;
    recent.push(t);
    rates.set(agentId, recent);
    return exceeded;
  }

  const view = (c, detail = false) => {
    const { pause, hold, upstream, ...rest } = c;
    const out = { ...rest };
    if (hold) {
      const { expiresAtMs, ...h } = hold;
      out.hold = { ...h, expiresAt: new Date(expiresAtMs).toISOString() };
      if (detail && c.outcome === 'held' && hold.state === 'pending') out.hold.approvalCode = secrets.get(c.id)?.code ?? null;
    }
    if (pause) {
      out.pause = { attended: true, argsHash: pause.argsHash, state: pause.state, expiresAt: new Date(pause.expiresAtMs).toISOString(), ttlMs: pause.ttlMs };
      if (detail && c.outcome === 'pending') out.pause.approvalCode = secrets.get(c.id)?.code ?? null;
    }
    if (upstream) out.upstream = detail ? upstream : { ok: upstream.ok, error: upstream.error ?? null };
    return structuredClone(out);
  };

  async function forwardCall(c, rawArgs) {
    const startEpoch = epoch;
    const spec = TOOLS[c.tool];
    const port = forward.portFor(spec.upstream);
    let r;
    try { r = await forward.call({ port, tool: c.tool, args: rawArgs }); } catch { r = { ok: false, error: 'upstream_refused_target' }; }
    if (epoch !== startEpoch) return; // a reset discarded this call while it was in flight: it writes nothing into the new epoch
    if (r.ok) {
      const result = clean(r.result);
      const json = JSON.stringify(result);
      c.upstream = { ok: true, port, result: json.length > RESULT_JSON_CAP ? { truncated: true } : result };
      c.outcome = 'forwarded';
      audit.append('forwarded', c.id, { agentId: c.agentId, tool: c.tool, upstream: spec.upstream });
    } else {
      c.upstream = { ok: false, port, error: safeText(r.error, 40) };
      c.outcome = 'upstream_error';
      audit.append('upstream_error', c.id, { agentId: c.agentId, tool: c.tool, error: c.upstream.error });
    }
    touch(c);
  }

  // The agent retries a held call and names its approval. Checks in this order; the first that fails refuses the call.
  // Nothing here consumes the approval: the caller does that only after the policy has allowed the retry.
  function redeemCheck(ref, input) {
    if (typeof ref !== 'string' || !HOLD_REF_RE.test(ref)) return { reason: 'approval_unknown' };
    const id = holdRefs.get(ref);
    const hc = id === undefined ? undefined : calls.get(id);
    if (!hc?.hold) return { reason: 'approval_unknown' };
    const h = hc.hold;
    if (h.state === 'consumed') return { reason: 'approval_consumed' };
    if (h.state === 'expired') return { reason: 'approval_expired' }; // sweep() ran at the top of handle(), so a hold past its expiry is already expired
    if (h.state === 'pending') return { reason: 'approval_pending' };
    if (h.state !== 'approved') return { reason: 'approval_denied' };
    let hash = null;
    try { hash = callHash(input); } catch { /* too deep to bind: it cannot match */ }
    if (hash !== h.argsHash) return { reason: 'approval_mismatch' };
    return { hc };
  }

  // A simulated agent calls a tool. `scenarioId` and `pauseTtlMs` come from scenarios.js, never from the API.
  // `tokenId`, `surface` and `approvalRef` are what the simulated agent presents; none of them is a claim or a credential.
  async function handle({ agentId, tool, args, tokenId, surface, approvalRef, scenarioId = null, pauseTtlMs } = {}) {
    sweep();
    const idOk = typeof agentId === 'string' && typeof tool === 'string';
    const argsOk = args && typeof args === 'object' && !Array.isArray(args) && (() => { try { return JSON.stringify(args).length <= MAX_ARGS_JSON; } catch { return false; } })();
    const rawArgs = argsOk ? structuredClone(args) : null;
    const limited = idOk ? (Object.hasOwn(AGENTS, agentId) ? rateExceeded(agentId) : false) : false;
    let verdict;
    if (!idOk) verdict = { decision: 'deny', reason: 'bad_arguments', ruleId: null, layers: notReached(), claims: null };
    else {
      try { verdict = evaluateFn({ agentId, tool, args: rawArgs, tokenId, surface }, { rateExceeded: limited }); } catch { verdict = null; }
      if (!verdictOk(verdict)) verdict = failClosed();
    }
    let hash = null;
    if (verdict.decision === 'pause') {
      try { hash = callHash({ agentId, tool, tokenId: verdict.claims?.subject, args: rawArgs }); } catch { verdict = failClosed(); }
    }
    let redeemed = null;
    if (verdict.decision === 'pause' && approvalRef !== undefined) {
      const r = redeemCheck(approvalRef, { agentId, tool, tokenId: verdict.claims?.subject, args: rawArgs });
      if (r.hc) { redeemed = r.hc; verdict = { ...verdict, decision: 'allow', reason: 'hold_approved' }; } else verdict = { ...verdict, decision: 'deny', reason: r.reason };
    }
    const id = `call-${String(++seq).padStart(4, '0')}`;
    const c = {
      id, seq, rev: 0, at: new Date(now()).toISOString(), scenarioId: scenarioId ? safeText(scenarioId) : null,
      agentId: safeText(agentId), tool: safeText(tool), args: argsOk ? clean(rawArgs) : null,
      requiredScope: verdict.requiredScope ?? null,
      layers: structuredClone(verdict.layers ?? notReached()), claims: verdict.claims ? clean(verdict.claims) : null,
      decision: verdict.decision, reason: verdict.reason, ruleId: verdict.ruleId ?? null, outcome: 'blocked',
    };
    if (redeemed) {
      // Single use: the approval is spent here, before anything is awaited, so two simultaneous retries cannot both win.
      redeemed.hold.state = 'consumed'; redeemed.hold.consumedAt = c.at; redeemed.hold.consumedByCallId = id;
      c.approvalRef = redeemed.hold.ref;
      touch(redeemed);
      audit.append('hold_consumed', redeemed.id, { agentId: c.agentId, tool: c.tool, ref: redeemed.hold.ref, consumedBy: id });
    } else if (approvalRef !== undefined && verdict.reason.startsWith('approval_')) c.approvalRef = typeof approvalRef === 'string' && HOLD_REF_RE.test(approvalRef) ? approvalRef : null;
    let pauseWanted = verdict.decision === 'pause';
    if (pauseWanted && pendingCount() >= pendingCap) { c.decision = 'deny'; c.reason = 'pause_queue_full'; c.ruleId = null; pauseWanted = false; }
    calls.set(id, c);
    touch(c);
    audit.append('decision', id, { agentId: c.agentId, tool: c.tool, args: c.args, decision: c.decision, reason: c.reason, ruleId: c.ruleId, requiredScope: c.requiredScope, layers: c.layers, subject: c.claims?.subject ?? null });
    evictIfFull();
    if (c.decision === 'allow') {
      c.outcome = 'forwarding'; // a state nothing else can act on while the upstream answers
      await forwardCall(c, rawArgs);
    } else if (pauseWanted) {
      const ttl = Math.min(Math.max(pauseTtlMs ?? ttlMs, MIN_TTL), ttlMs);
      const code = crypto.randomBytes(16).toString('hex');
      if (verdict.claims?.attended === false) {
        const ref = newHoldRef();
        c.outcome = 'held'; // returns now: no connection is kept open for the human
        c.hold = { attended: false, ref, argsHash: hash, state: 'pending', ttlMs: ttl, expiresAtMs: now() + ttl, grantTtlSec: null, decidedAt: null, consumedAt: null, consumedByCallId: null, deniedBy: null, expiredAt: null };
        secrets.set(id, { code, failures: 0 });
        holdRefs.set(ref, id);
        retryInputs.set(id, { agentId, tool, args: rawArgs, tokenId: verdict.claims.subject, surface: verdict.claims.surface });
        audit.append('hold_opened', id, { agentId: c.agentId, tool: c.tool, ref, argsHash: hash, expiresAt: new Date(c.hold.expiresAtMs).toISOString() });
      } else {
        c.outcome = 'pending';
        c.pause = { attended: true, argsHash: hash, state: 'pending', ttlMs: ttl, expiresAtMs: now() + ttl };
        secrets.set(id, { code, failures: 0, args: rawArgs });
        audit.append('pause_opened', id, { agentId: c.agentId, tool: c.tool, expiresAt: new Date(c.pause.expiresAtMs).toISOString() });
      }
      touch(c);
    } else {
      touch(c);
    }
    return view(c);
  }

  // The human's answer to a paused or held call. Returns { status, error?, call? } (status is an HTTP status).
  async function decide(id, { decision, approvalCode } = {}) {
    sweep();
    const c = calls.get(id);
    if (!c) return { status: 404, error: 'not_found' };
    const w = c.hold ?? c.pause; // the wait this call is in
    if (!waiting(c) || (c.hold && c.hold.state !== 'pending')) return { status: 409, error: c.outcome === 'expired' ? 'expired' : 'not_pending', call: view(c) };
    if (decision !== 'approve' && decision !== 'deny') return { status: 400, error: 'bad_decision' };
    const kind = c.hold ? 'hold' : 'pause';
    const s = secrets.get(id);
    const given = Buffer.from(crypto.createHash('sha256').update(String(approvalCode ?? '')).digest('hex'));
    const want = Buffer.from(crypto.createHash('sha256').update(s.code).digest('hex'));
    if (typeof approvalCode !== 'string' || !crypto.timingSafeEqual(given, want)) {
      s.failures += 1;
      audit.append(`${kind}_bad_code`, id, { agentId: c.agentId, tool: c.tool, failures: s.failures });
      if (s.failures >= MAX_BAD_CODES) {
        c.outcome = 'blocked'; c.reason = 'too_many_bad_codes'; w.state = 'locked';
        secrets.delete(id);
        touch(c);
        audit.append(`${kind}_locked`, id, { agentId: c.agentId, tool: c.tool });
      }
      return { status: 403, error: 'bad_approval_code' };
    }
    const rawArgs = s.args;
    secrets.delete(id); // one-shot: the code is gone before anything else happens
    if (decision === 'deny') {
      c.outcome = 'denied_by_human'; w.state = 'denied';
      if (c.hold) { c.hold.deniedBy = 'human'; c.hold.decidedAt = new Date(now()).toISOString(); }
      touch(c);
      audit.append(`${kind}_denied`, id, { agentId: c.agentId, tool: c.tool });
      return { status: 200, call: view(c) };
    }
    if (c.hold) {
      // Approving a hold forwards nothing. It opens a grant bound to this call's hash that the agent's exact retry can use once.
      c.hold.state = 'approved'; c.hold.decidedAt = new Date(now()).toISOString();
      c.hold.expiresAtMs = now() + grantTtlMs; c.hold.grantTtlSec = grantTtlMs / 1000;
      touch(c);
      audit.append('hold_approved', id, { agentId: c.agentId, tool: c.tool, ref: c.hold.ref, expiresAt: new Date(c.hold.expiresAtMs).toISOString() });
      return { status: 200, call: view(c) };
    }
    c.outcome = 'forwarding'; c.pause.state = 'approved';
    audit.append('pause_approved', id, { agentId: c.agentId, tool: c.tool });
    await forwardCall(c, rawArgs);
    return { status: 200, call: view(c) };
  }

  // The simulated agent retries a held call exactly as it first sent it, presenting the hold's reference. The retry is a
  // new call: it is evaluated like any other, and the approval is only an input to that evaluation.
  async function retry(id) {
    sweep();
    const c = calls.get(id);
    if (!c) return { status: 404, error: 'not_found' };
    const input = retryInputs.get(id);
    if (!c.hold || !input) return { status: 409, error: 'not_held' };
    return { status: 200, call: await handle({ ...input, approvalRef: c.hold.ref, scenarioId: c.scenarioId }) };
  }

  return {
    audit, handle, decide, retry,
    get(id, { detail = true } = {}) { sweep(); const c = calls.get(id); return c ? view(c, detail) : null; },
    list({ since = 0, limit = 200 } = {}) {
      sweep();
      const items = [...calls.values()].filter((c) => c.rev > since).sort((a, b) => a.seq - b.seq).slice(0, limit).map((c) => view(c));
      return { epoch, cursor: rev, calls: items };
    },
    clearRate(agentId) { rates.delete(agentId); },
    reset() { calls = new Map(); secrets.clear(); holdRefs.clear(); retryInputs.clear(); rates.clear(); epoch += 1; audit.reset(); },
    stats() { return { calls: calls.size, pending: pendingCount(), epoch, cursor: rev }; },
  };
}
