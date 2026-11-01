import wideDoc from "../../../server/diagrams/gateway-flow.json";
import narrowDoc from "../../../server/diagrams/gateway-flow-narrow.json";
import { normalizeDiagram } from "../lib/diagram.js";

// The real diagram-studio/1 files the server serves, as a fake API answers them and as the component normalizes them.
export const DIAGRAM_DOCS = { "gateway-flow": wideDoc, "gateway-flow-narrow": narrowDoc };
export const WIDE = normalizeDiagram(wideDoc);
export const NARROW = normalizeDiagram(narrowDoc);
export const call = (o = {}) => ({
  id: "call-0001", seq: 1, rev: 1, at: "2026-10-21T12:00:00.000Z", scenarioId: "benign",
  agentId: "support-bot", tool: "tickets.read", args: { ticketId: "T-100" }, requiredScope: "tickets:read",
  decision: "allow", reason: "rule_allow", ruleId: "allow-ticket-read", outcome: "forwarded", ...o,
});
export const paused = (o = {}) => call({
  id: "call-0002", agentId: "finance-agent", tool: "payments.transfer", args: { amount: 900, to: "acct-demo-9" }, requiredScope: "payments:write",
  decision: "pause", reason: "needs_human_approval", ruleId: "pause-large-transfer", outcome: "pending",
  pause: { state: "pending", ttlMs: 30000, expiresAt: new Date(Date.now() + 30000).toISOString(), approvalCode: "demo-code-1" }, ...o,
});
export const entry = (seq, o = {}) => ({ seq, at: "2026-10-21T12:00:00.000Z", type: "decision", callId: "call-0001", data: { agentId: "support-bot", tool: "tickets.read", decision: "allow", reason: "rule_allow" }, prevHash: "0".repeat(64), hash: `${seq}`.padStart(64, "a"), ...o });

const LAYERS_OK = { surface: "pass", application: "pass", action: "pass", endUser: "pass" };
const CLAIMS = { subject: "tok-finance-batch", application: "finance-app", surface: "mcp", endUser: "user-manager", attended: false };
// An unattended hold: refused at once with a reference and an expiry. state is pending, approved, consumed, denied or expired.
export const held = (state = "pending", o = {}) => call({
  id: "call-0003", agentId: "finance-agent", tool: "payments.transfer", args: { amount: 900, to: "acct-demo-9" }, requiredScope: "payments:write",
  decision: "pause", reason: "needs_human_approval", ruleId: "pause-large-transfer", outcome: "held", layers: LAYERS_OK, claims: CLAIMS,
  hold: { attended: false, ref: "hold-0123456789abcdef", argsHash: "ab".repeat(32), state, ttlMs: 30000, expiresAt: new Date(Date.now() + 30000).toISOString(), grantTtlSec: state === "pending" ? null : 60,
    decidedAt: null, consumedAt: state === "consumed" ? "2026-10-21T12:00:05.000Z" : null, consumedByCallId: state === "consumed" ? "call-0004" : null, deniedBy: null, expiredAt: null,
    ...(state === "pending" ? { approvalCode: "hold-code-1" } : {}) }, ...o,
});
export const refused = (layer, reason, o = {}) => {
  const order = ["surface", "application", "action", "endUser"];
  const layers = Object.fromEntries(order.map((l, i) => [l, i < order.indexOf(layer) ? "pass" : i === order.indexOf(layer) ? "fail" : "skipped"]));
  return call({ id: "call-0005", decision: "deny", outcome: "blocked", reason, ruleId: null, layers, claims: { ...CLAIMS, attended: true }, ...o });
};
