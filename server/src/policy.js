import { posix } from 'node:path';

// The stub gateway's policy engine. Pure: evaluate(call, ctx) -> a decision, no I/O, no clock.
// Deny by default. The order of checks is fixed and is the point of the demo:
//   1. the agent must be registered (identity)            -> else deny unknown_agent
//   2. the tool must be in the catalog                    -> else deny unknown_tool
//   3. the arguments must be an object                    -> else deny bad_arguments
//   4. the verified token (a stub issuer's table, never the call) is read for four layered scope checks:
//        surface      the token may be used on the surface the call arrived on   -> else deny scope_surface
//        application  the token's application is registered for this tool        -> else deny scope_application
//        action       the agent holds the tool's scope (no rule can grant one)   -> else deny scope_exceeded
//        end user     the user the token acts for holds the tool's scope         -> else deny scope_end_user
//      The first layer that fails decides; the later ones are reported as not reached. All four run before any rule.
//   5. rate limit                                          -> else deny rate_limited
//   6. rules: deny beats pause beats allow                 -> first matching rule of the strongest effect
//   7. nothing matched                                     -> deny default_deny
// 'pause' is the third outcome, shown to people as "hold for a human". Whether a human is present is a claim of the token
// (attended). The rules are code, not input: no API changes them.
// Ping release claim (2026-11-02), UNVERIFIED on our tenant: the four layers and the hold outcome have no console swagger
// field names; their names here are lab-invented.

// Registered agents. The scopes are what the registry grants; a call never carries its own scopes.
export const AGENTS = Object.freeze({
  'support-bot': Object.freeze({ id: 'support-bot', scopes: Object.freeze(['tickets:read']) }),
  'finance-agent': Object.freeze({ id: 'finance-agent', scopes: Object.freeze(['payments:read', 'payments:write']) }),
  'ops-agent': Object.freeze({ id: 'ops-agent', scopes: Object.freeze(['files:read', 'files:delete']) }),
});

// Tool catalog: which stub upstream serves it and which scope it needs.
export const TOOLS = Object.freeze({
  'tickets.read': Object.freeze({ upstream: 'tickets', scope: 'tickets:read' }),
  'payments.read': Object.freeze({ upstream: 'payments', scope: 'payments:read' }),
  'payments.transfer': Object.freeze({ upstream: 'payments', scope: 'payments:write' }),
  'files.read': Object.freeze({ upstream: 'files', scope: 'files:read' }),
  'files.delete': Object.freeze({ upstream: 'files', scope: 'files:delete' }),
});

export const RATE_LIMIT = Object.freeze({ max: 5, windowMs: 10_000 });
export const PAUSE_TTL_MS = 30_000;
// After a human approves an unattended hold, the agent has this long to retry the exact call (lab reading of GrantTTLSec).
export const GRANT_TTL_MS = 60_000;

// Lab-invented stand-in for a token issuer. Tokens are looked up by id here; a call can name a token but never carries
// claims, so a client cannot widen its own surface, application or end user.
export const SURFACES = Object.freeze(['mcp', 'a2a', 'llm']);
const freeze2 = (o) => Object.freeze(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Object.freeze(Object.fromEntries(Object.entries(v).map(([a, b]) => [a, Array.isArray(b) ? Object.freeze([...b]) : b])))])));
export const APPLICATIONS = freeze2({
  'helpdesk-app': { tools: ['tickets.*', 'payments.*'] },
  'finance-app': { tools: ['payments.*'] },
  'ops-app': { tools: ['files.*'] },
});
export const END_USERS = freeze2({
  'user-manager': { scopes: ['tickets:read', 'payments:read', 'payments:write', 'files:read', 'files:delete'] },
  'user-analyst': { scopes: ['payments:read'] },
});
export const TOKENS = freeze2({
  'tok-support': { agentId: 'support-bot', application: 'helpdesk-app', surfaces: ['mcp'], endUser: 'user-manager', attended: true },
  'tok-finance': { agentId: 'finance-agent', application: 'finance-app', surfaces: ['mcp', 'a2a'], endUser: 'user-manager', attended: true },
  'tok-finance-analyst': { agentId: 'finance-agent', application: 'finance-app', surfaces: ['mcp'], endUser: 'user-analyst', attended: true },
  'tok-finance-batch': { agentId: 'finance-agent', application: 'finance-app', surfaces: ['mcp'], endUser: 'user-manager', attended: false },
  'tok-ops': { agentId: 'ops-agent', application: 'ops-app', surfaces: ['mcp'], endUser: 'user-manager', attended: true },
});
// The token a call uses when it names none: one per agent.
export const DEFAULT_TOKENS = Object.freeze({ 'support-bot': 'tok-support', 'finance-agent': 'tok-finance', 'ops-agent': 'tok-ops' });
export const LAYERS = Object.freeze(['surface', 'application', 'action', 'endUser']);
export const DEFAULT_SURFACE = 'mcp';

// Text an injected tool argument tends to carry. Matched on NFKC-folded, hidden-character-stripped, lowercased text.
const INJECTION = /(ignore|disregard|forget)\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier)\s+(instructions?|rules?|prompts?)|(reveal|print|show|output)\s+(your\s+|the\s+)?system\s+prompt|you\s+are\s+now\s+(in\s+)?(developer|admin|dan)\b|<\s*\/?\s*(system|assistant)\s*>|\bcall\s+(the\s+)?(payments|files)\.\w+/;
const HIDDEN_CLASS = '[\\u00AD\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u206F\\uFEFF\\u{E0000}-\\u{E007F}]';
const HIDDEN = new RegExp(HIDDEN_CLASS, 'gu');
const HAS_HIDDEN = new RegExp(HIDDEN_CLASS, 'u');
const MAX_SCAN = 2000;

export const normalizeForMatch = (s) => String(s).slice(0, MAX_SCAN).normalize('NFKC').replace(HIDDEN, '').toLowerCase();

// Every string in an args object: all values at any depth AND all object keys. Iterative, so depth costs no stack.
// The walk has a node budget; if the budget runs out (or a string is longer than MAX_SCAN) `complete` is false and the
// injection rule treats the call as hostile (fail closed), so no cap can hide text from the scan.
const MAX_NODES = 5000;
export function scanStrings(value) {
  const strings = [];
  const stack = [value];
  let nodes = 0;
  let complete = true;
  while (stack.length) {
    const v = stack.pop();
    if (++nodes > MAX_NODES) { complete = false; break; }
    if (typeof v === 'string') { strings.push(v); if (v.length > MAX_SCAN) complete = false; } else if (Array.isArray(v)) stack.push(...v);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { strings.push(k); stack.push(x); }
  }
  return { strings, complete };
}

export const OPS = Object.freeze({
  gt: (a, b) => typeof a === 'number' && a > b,
  gte: (a, b) => typeof a === 'number' && a >= b,
  lt: (a, b) => typeof a === 'number' && a < b,
  lte: (a, b) => typeof a === 'number' && a <= b,
  eq: (a, b) => a === b,
  // under: a normalised absolute path inside directory b. '..' segments, NUL and relative paths never match.
  under: (a, b) => typeof a === 'string' && !a.includes('\0') && a.startsWith('/') && !a.split('/').includes('..') && posix.normalize(a).startsWith(b),
  // injection: any string leaf of the whole args object looks like instructions or carries hidden characters
  injection: (_a, _b, args) => {
    const { strings, complete } = scanStrings(args);
    return !complete || strings.some((s) => INJECTION.test(normalizeForMatch(s)) || HAS_HIDDEN.test(s));
  },
});
// A condition on a missing argument never matches (so "amount > 500" does not fire without an amount).
const condMatches = (c, args) => (c.op === 'injection' ? OPS.injection(null, null, args) : Object.hasOwn(args, c.arg) && OPS[c.op](args[c.arg], c.value, args));

// effect: allow | deny | pause. agents/tools: ['*'] or lists; a tool entry ending in '.*' is a prefix.
export const RULES = Object.freeze([
  { id: 'deny-injection', effect: 'deny', reason: 'prompt_injection', agents: ['*'], tools: ['*'], when: [{ op: 'injection' }] },
  { id: 'deny-huge-transfer', effect: 'deny', reason: 'amount_over_limit', agents: ['finance-agent'], tools: ['payments.transfer'], when: [{ arg: 'amount', op: 'gt', value: 10_000 }] },
  { id: 'pause-large-transfer', effect: 'pause', reason: 'needs_human_approval', agents: ['finance-agent'], tools: ['payments.transfer'], when: [{ arg: 'amount', op: 'gt', value: 500 }] },
  { id: 'pause-file-delete', effect: 'pause', reason: 'needs_human_approval', agents: ['ops-agent'], tools: ['files.delete'], when: [] },
  { id: 'allow-ticket-read', effect: 'allow', reason: 'rule_allow', agents: ['support-bot'], tools: ['tickets.read'], when: [] },
  { id: 'allow-payment-read', effect: 'allow', reason: 'rule_allow', agents: ['finance-agent'], tools: ['payments.read'], when: [] },
  { id: 'allow-small-transfer', effect: 'allow', reason: 'rule_allow', agents: ['finance-agent'], tools: ['payments.transfer'], when: [{ arg: 'amount', op: 'gte', value: 0 }, { arg: 'amount', op: 'lte', value: 500 }] },
  { id: 'allow-public-file-read', effect: 'allow', reason: 'rule_allow', agents: ['ops-agent'], tools: ['files.read'], when: [{ arg: 'path', op: 'under', value: '/data/public/' }] },
].map((r) => Object.freeze({ ...r, when: Object.freeze(r.when) })));

const listMatches = (list, v) => list.some((x) => x === '*' || x === v || (x.endsWith('.*') && v.startsWith(x.slice(0, -1))));
const STRENGTH = { deny: 3, pause: 2, allow: 1 };
const has = (table, key) => typeof key === 'string' && Object.hasOwn(table, key);

export const REGISTRY = Object.freeze({ agents: AGENTS, tools: TOOLS, tokens: TOKENS, applications: APPLICATIONS, endUsers: END_USERS, defaultTokens: DEFAULT_TOKENS });

// Problems in a registry (empty list = consistent). Used by the doctor, and by tests on deliberately broken ones.
export function registryProblems(reg = REGISTRY) {
  if (!reg) reg = REGISTRY;
  const bad = [];
  for (const [id, t] of Object.entries(reg.tokens)) {
    if (!has(reg.agents, t.agentId)) bad.push(`token ${id}: unknown agent`);
    if (!has(reg.applications, t.application)) bad.push(`token ${id}: unknown application`);
    if (!has(reg.endUsers, t.endUser)) bad.push(`token ${id}: unknown end user`);
    if (!Array.isArray(t.surfaces) || t.surfaces.length === 0 || !t.surfaces.every((x) => SURFACES.includes(x))) bad.push(`token ${id}: bad surfaces`);
    if (typeof t.attended !== 'boolean') bad.push(`token ${id}: attended must be true or false`);
  }
  for (const id of Object.keys(reg.agents)) {
    const d = reg.defaultTokens[id];
    if (!has(reg.tokens, d) || reg.tokens[d].agentId !== id) bad.push(`agent ${id}: no default token of its own`);
  }
  return bad;
}

// Four layered scope checks, then (only if all pass) the rate limit and the rules. Pure: no I/O, no clock.
// call: { agentId, tool, args, tokenId?, surface? }. claims.subject is the token id (not named tokenId: the redactor hides anything called token). ctx: { rateExceeded, rules, registry } (the last two let a test mutate the policy).
export function evaluate({ agentId, tool, args, tokenId, surface }, { rateExceeded = false, rules = RULES, registry = REGISTRY } = {}) {
  const layers = { surface: 'skipped', application: 'skipped', action: 'skipped', endUser: 'skipped' };
  const out = (decision, reason, ruleId = null, extra = {}) => ({ decision, reason, ruleId, layers, claims: null, ...extra });
  const agent = has(registry.agents, agentId) ? registry.agents[agentId] : null;
  if (!agent) return out('deny', 'unknown_agent');
  const spec = has(registry.tools, tool) ? registry.tools[tool] : null;
  if (!spec) return out('deny', 'unknown_tool');
  const safeArgs = args && typeof args === 'object' && !Array.isArray(args) ? args : null;
  if (!safeArgs) return out('deny', 'bad_arguments', null, { requiredScope: spec.scope });
  const base = { requiredScope: spec.scope };

  // The verified token: named by the call, defined by the issuer's table. It must belong to the calling agent.
  const wantToken = tokenId === undefined ? registry.defaultTokens[agent.id] : tokenId;
  const token = has(registry.tokens, wantToken) && registry.tokens[wantToken].agentId === agent.id ? registry.tokens[wantToken] : null;
  if (!token) return out('deny', 'token_invalid', null, base);
  const where = surface === undefined ? DEFAULT_SURFACE : surface;
  const claims = { subject: wantToken, application: token.application, surface: typeof where === 'string' ? where.slice(0, 16) : '?', endUser: token.endUser, attended: token.attended };
  const stop = (layer, reason) => { layers[layer] = 'fail'; return out('deny', reason, null, { ...base, claims }); };

  if (typeof where !== 'string' || !token.surfaces.includes(where)) return stop('surface', 'scope_surface');
  layers.surface = 'pass';
  const app = has(registry.applications, token.application) ? registry.applications[token.application] : null;
  if (!app || !listMatches(app.tools, tool)) return stop('application', 'scope_application');
  layers.application = 'pass';
  if (!agent.scopes.includes(spec.scope)) return stop('action', 'scope_exceeded');
  layers.action = 'pass';
  const user = has(registry.endUsers, token.endUser) ? registry.endUsers[token.endUser] : null;
  if (!user || !user.scopes.includes(spec.scope)) return stop('endUser', 'scope_end_user');
  layers.endUser = 'pass';

  const withClaims = { ...base, claims };
  if (rateExceeded) return out('deny', 'rate_limited', null, withClaims);
  let best = null;
  for (const r of rules) {
    if (!listMatches(r.agents, agent.id) || !listMatches(r.tools, tool)) continue;
    if (!r.when.every((c) => condMatches(c, safeArgs))) continue;
    if (!best || STRENGTH[r.effect] > STRENGTH[best.effect]) best = r;
  }
  if (!best) return out('deny', 'default_deny', null, withClaims);
  return out(best.effect, best.reason, best.id, withClaims);
}
