// Decisions and outcomes always show a word and a glyph, never colour alone.
export const DECISION = {
  allow: { word: "Allow", glyph: "✓", tone: "ok" },
  deny: { word: "Deny", glyph: "✕", tone: "deny" },
  pause: { word: "Hold for a human", glyph: "‖", tone: "hold" },
};
export const OUTCOME = {
  forwarded: { word: "Forwarded to the upstream", tone: "ok" },
  forwarding: { word: "Forwarding", tone: "info" },
  blocked: { word: "Blocked, never forwarded", tone: "deny" },
  pending: { word: "Waiting for a human", tone: "hold" },
  held: { word: "Held: refused with a reference", tone: "hold" },
  expired: { word: "Hold expired, never forwarded", tone: "mute" },
  denied_by_human: { word: "Denied by the human", tone: "deny" },
  upstream_error: { word: "Upstream error", tone: "hold" },
};
export const REASON = {
  rule_allow: "A rule allows this agent to make this call.",
  default_deny: "No rule allows it, and the gateway denies anything no rule allows.",
  unknown_agent: "The agent is not registered with the gateway.",
  unknown_tool: "The tool is not in the gateway's tool catalog.",
  bad_arguments: "The arguments are not a JSON object the gateway accepts.",
  scope_surface: "Layer 1, surface: the token is not valid on the surface this call arrived on. Nothing after it is read.",
  scope_application: "Layer 2, application: the application the token was issued to is not registered for this tool.",
  scope_exceeded: "Layer 3, action: the agent does not hold the scope this tool needs. No rule is consulted.",
  scope_end_user: "Layer 4, end user: the user the token acts for does not hold the scope this tool needs.",
  token_invalid: "The token is unknown, or it does not belong to this agent.",
  evaluation_error: "The policy could not be evaluated, so the call is denied (fail closed).",
  hold_approved: "A human approved this exact call and the agent retried it. The approval worked once and is now spent.",
  approval_consumed: "That approval was already used once. A second replay is refused.",
  approval_mismatch: "The retry is not the call that was approved (a different argument, tool, agent or token). The approval is still unspent.",
  approval_expired: "The approval ran out of time before the retry.",
  approval_pending: "No human has answered this hold yet.",
  approval_denied: "A human denied this hold, or it was locked after wrong codes.",
  approval_unknown: "No such approval reference (it never existed, was trimmed, or the buffer was reset).",
  rate_limited: "The agent is over its rate limit (5 calls in 10 seconds).",
  prompt_injection: "An argument carries instruction-like text or hidden characters.",
  amount_over_limit: "The amount is above the hard limit.",
  needs_human_approval: "A rule says a human must approve this call before it is forwarded: the third outcome, hold for a human.",
  pause_queue_full: "Too many calls are waiting for a human, so this one is denied instead of queued.",
  too_many_bad_codes: "Three wrong approval codes locked the pause.",
};
export const RULE = {
  "deny-injection": "Deny any call whose arguments look like instructions or hide characters.",
  "deny-huge-transfer": "Deny payments.transfer above 10000.",
  "pause-large-transfer": "Pause payments.transfer above 500 for a human.",
  "pause-file-delete": "Pause every files.delete for a human.",
  "allow-ticket-read": "Allow support-bot to call tickets.read.",
  "allow-payment-read": "Allow finance-agent to call payments.read.",
  "allow-small-transfer": "Allow payments.transfer up to 500.",
  "allow-public-file-read": "Allow files.read under /data/public/.",
};
// The four scope layers, in the order the gateway checks them. Names are lab-invented: the console swagger has none.
export const LAYERS = [
  { id: "surface", label: "Surface", asks: "Is this token valid on the surface the call arrived on?" },
  { id: "application", label: "Application", asks: "Is the token's application registered for this tool?" },
  { id: "action", label: "Action", asks: "Does the agent hold the tool's scope?" },
  { id: "endUser", label: "End user", asks: "Does the user the token acts for hold the scope?" },
];
export const LAYER_RESULT = {
  pass: { word: "Passed", glyph: "✓" },
  fail: { word: "Refused", glyph: "✕" },
  skipped: { word: "Not reached", glyph: "–" },
};
// Hold states, in words.
export const HOLD_STATE = {
  pending: "Waiting for a human",
  approved: "Approved: waiting for the agent's exact retry (works once)",
  consumed: "Spent: the retry used it",
  denied: "Denied by the human",
  expired: "Expired",
  locked: "Locked after wrong codes",
};
export const ERROR_TEXT = {
  bad_approval_code: "The server did not accept the approval code.",
  expired: "That pause has expired, so the call was never forwarded.",
  not_pending: "That call is no longer waiting for a human.",
  not_held: "That call is not a held call, so there is nothing for the agent to retry.",
  not_found: "The call is gone (the buffer was reset or trimmed).",
};
