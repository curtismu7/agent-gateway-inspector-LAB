// runObservability.js — "What each layer logged for this run" (Rule 27): the CORE. It masks, classifies, orders and checks the log lines
// one run left behind. Vendor to server/src/runObservability.js. Dependency-free ESM, Node >= 22.
// This file has NO imports, no network and no file access, so a lab that reads no logs vendors only this file and exempts nothing in its
// safety tests. The log readers live in runObservabilityReaders.js; a lab that reads logs vendors both.
//
// HONESTY (Rule 25, applied to logs). Every row carries an origin:
//   logged       a real line read, read-only, from the product's own log, with the line's own timestamp, ids and tokens masked
//   simulated    the lab's mock computed it; never presented as read from a log
//   response     a decision the lab already holds as an API response (a PingOne Authorize permit/deny and its policy): real, but NOT read from a
//                log, so it is never tagged or counted as `logged`
//   not-logged   no line was found for this run (the product may not log this event); the panel says so, it never claims a line
// A missing event is never invented. An `info` row is never counted as passed, and a row whose line shape is `unverified-shape` is counted as
// information in the summary whatever outcome it carries. A line shape nobody has measured is marked `UNVERIFIED` in the matcher table below.
// SECRETS. Every text field of every row (message, product, host, timestamp text, detail) passes the masker (or is rebuilt from a number)
// before it leaves collectRun, whatever its origin. Matchers are ANCHORED to the shape of the line the product itself wrote: text typed by a
// caller (a request path, a message body) can never make a line count as a decision.
// BOUNDS. Every line is cut to maxLine characters before it is classified and to maxMaskInput before it is masked; every detail is cut to
// maxDetail characters in all; every masker and matcher pattern is linear (bounded repetition, no nested quantifiers). A cut is noted
// (`truncated`).

export const LAYERS = ['person', 'agent', 'authorize', 'privilege', 'gateway', 'resource'];
export const LAYER_LABELS = {
  person: 'Person', agent: 'Agent', authorize: 'Authorize', privilege: 'Privilege', gateway: 'Agent gateway', resource: 'Resource server',
};
export const OUTCOMES = ['allowed', 'refused', 'blocked', 'info'];
export const ORIGINS = ['logged', 'simulated', 'response', 'not-logged'];
export const COVERAGE = ['logged', 'simulated', 'response', 'not-logged', 'unreachable'];
export const BASES = ['measured-shape', 'unverified-shape'];

export const LIMITS = {
  timeoutMs: 8000, maxBytes: 2_000_000, maxHits: 500, maxLines: 2000, maxRows: 500, maxMessage: 300, maxReason: 600,
  maxMaskInput: 2000, maxLine: 4000, maxDetail: 8192, maxDepth: 8, minIdTerm: 6, maxProducts: 20,
};
const MIN_MS = Date.UTC(2000, 0, 1); const MAX_MS = Date.UTC(2100, 0, 1);
const PROTO = new Set(['__proto__', 'constructor', 'prototype']);

export class ReaderError extends Error {
  constructor(code, message) { super(message); this.name = 'ReaderError'; this.code = code; }
}
export class RunObsError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'RunObsError'; this.code = code; this.status = status; }
}

// A timestamp the way the products write it (ISO 8601, optional fraction up to nanoseconds). Anything else is not trusted as "exact".
export const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})$/;
export const NAME_OK = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export const safeName = (n) => typeof n === 'string' && NAME_OK.test(n) && !PROTO.has(n);

// ---- Masker ----------------------------------------------------------------------------------------------
// Same intent as the log collector's own masking rules (headers, Bearer/Basic, JWTs, sk- keys, secret-named fields, `code` parameters),
// plus addresses, emails and hostnames. Ids (UUIDs, long hex, long mixed strings) become <id>; only the ids a lab declares in `correlation` are
// kept, shortened to their first 4 and last 2 characters, so nothing that looks like a secret keeps any of its characters.
// Every pattern is linear: bounded repetition, no nested quantifier over the same characters, input cut to maxMaskInput first.
const CRED_WORDS = '(?:token|expired|invalid|missing|required|authentication|authorization|authenticate|credentials?|scheme|realm|failed|error|denied|refused)';
const VALUE = '"(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'|[^\\s,;&"\'}\\]]+';
const SEP = '(["\')\\]]*\\s*[:=]\\s*)';
const STRONG = '(?:client_secret|client_assertion|secret_key|private_key|api[_-]?key|password|passwd|passphrase|pwd|secret|assertion|code_verifier|session_id|sessionid|jsessionid|phpsessid|connect\\.sid|x-amz-security-token|(?:access|refresh|id|subject|actor|auth|bearer|csrf)[_-]token)';
const WEAK = '(?:token|pass|sid|session)';
const SECRET_KEY = /(secret|token|password|passwd|authorization|api[-_]?key|private[-_]?key|credential|cookie|assertion|code_verifier|session[-_]?id|jsessionid|phpsessid)/i;
const SHORT_KEYS = /^(pass|pwd|sid|session|token)$/i;
// Real-looking host suffixes. `example`, `invalid` and `localhost` are NOT here on purpose (RFC 2606 / 6761 reserved: they can never be a real host), so a
// demo host such as client.example or a.b.example stays readable, while example.com, my.example.com and x.example.evil.net still end in a listed suffix and are masked.
const TLDS = 'com|org|net|io|dev|app|cloud|local|internal|test|lan|corp|svc|ai|co|us|uk|de|eu|info|biz|edu|gov|int|me|tech';
const IPV6 = '(?<![\\w:])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?|::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6}))(?![\\w:])';
const EMAIL = '[\\w.+-]{1,64}@[\\w-]{1,63}(?:\\.[\\w-]{1,63}){1,8}';
const HOST = `\\b[a-z0-9-]{1,63}(?:\\.[a-z0-9-]{1,63}){0,8}\\.(?:${TLDS})\\b(?!\\.[a-z0-9])`;
const short = (s) => (s.length > 8 ? `${s.slice(0, 4)}…${s.slice(-2)}` : s);
const quoted = (v) => (/^["']/.test(v) ? `${v[0]}***${v[0]}` : '***');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const MASK_RULES = [
  // headers whose whole value is a credential
  [/\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-amz-security-token|x-auth-token|x-csrf-token)(["']?\s*[:=]\s*["']?)[^\r\n"']*/gi, (_m, n, sep) => `${n}${sep}***`],
  [/\bCookie\{[^}]*\}/g, 'Cookie{***}'],
  [new RegExp(`\\b(Bearer|DPoP|ApiKey)\\s+(?!${CRED_WORDS}\\b)[A-Za-z0-9._~+/=-]{6,}`, 'gi'), '$1 ***'],
  [new RegExp(`\\bBasic\\s+(?!${CRED_WORDS}\\b)[A-Za-z0-9+/]{8,}={0,2}(?![A-Za-z0-9+/=])`, 'gi'), 'Basic ***'],
  [/\beyJ[\w-]{10,}(?:\.[\w-]*)*/g, '<jwt>'],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/g, 'sk_***'],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***'],
  [/\bxox[abprs]-[A-Za-z0-9-]{8,}/g, 'xox*-***'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, 'gh*_***'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***'],
  // secret-named fields: name: value, name=value, "name":"value", (name)=value; and the multi-line form (value on the next indented line)
  [new RegExp(`(["']?)(?<![A-Za-z0-9])(${STRONG})(?![A-Za-z0-9])${SEP}(${VALUE})`, 'gi'), (_m, q, n, sep, v) => `${q}${n}${sep}${quoted(v)}`],
  [new RegExp(`(?<![A-Za-z0-9])(${STRONG}(?![A-Za-z0-9])[ \\t]{0,20}:?[ \\t]{0,20}\\r?\\n[ \\t]{1,40})\\S+`, 'gi'), '$1***'],
  // short names are only secrets when written name=value, or as a quoted JSON key with a string value
  [new RegExp(`(["']?)(?<![A-Za-z0-9])(${WEAK})(?![A-Za-z0-9])(["')\\]]*=\\s*)(${VALUE})`, 'gi'), (_m, q, n, sep, v) => `${q}${n}${sep}${quoted(v)}`],
  [/("(?:token|pass|sid|session)"\s*:\s*)("(?:[^"\\]|\\.)*")/gi, '$1"***"'],
  [new RegExp(`([?&;"']code["']?\\s*[:=]\\s*)(${VALUE})`, 'gi'), (_m, p, v) => `${p}${quoted(v)}`],
  [new RegExp(EMAIL, 'g'), '<email>'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>'],
  [new RegExp(IPV6, 'gi'), '<ip>'],
  [new RegExp(HOST, 'gi'), '<host>'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>'],
  [/\b[0-9a-f]{16,}\b/gi, '<id>'],
  [/[A-Za-z0-9=]{20,}/g, (m) => (/\d/.test(m) && /[A-Za-z]/.test(m) ? '<id>' : m)],
];
// The patterns, for the linear-time test (and for a lab that wants to audit them).
export const maskRules = MASK_RULES.map(([re]) => re);

// The ids a lab declared (correlation) are kept, shortened; everything else id-like is masked whole.
export function keepPattern(correlation = {}) {
  const ids = [correlation?.sub, correlation?.actClientId, correlation?.traceId, ...(Array.isArray(correlation?.requestIds) ? correlation.requestIds : [])]
    .filter((t) => typeof t === 'string' && t.length >= LIMITS.minIdTerm && t.length <= 200).slice(0, 20);
  return ids.length ? new RegExp(`(?<![A-Za-z0-9_-])(?:${ids.map(escapeRe).join('|')})(?![A-Za-z0-9_-])`, 'gi') : null;
}

export function createMasker() {
  const mask = (input, keep = null) => {
    let s = typeof input === 'string' ? input : String(input ?? '');
    if (s.length > LIMITS.maxMaskInput) s = `${s.slice(0, LIMITS.maxMaskInput)}…`;
    s = s.replace(/\p{Cf}/gu, ''); // zero-width and bidi format characters cannot hide a token from the rules below
    if (keep) s = s.replace(keep, (m) => short(m));
    for (const [re, rep] of MASK_RULES) s = s.replace(re, rep);
    return s;
  };
  // Objects and arrays: depth, width and total size bounded (`budget` = { left, cut }); a value under a secret-looking key never survives.
  const walk = (value, keep, budget, key, depth) => {
    if (depth > LIMITS.maxDepth) { budget.cut = true; return '<too deep>'; }
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (key && (SECRET_KEY.test(key) || SHORT_KEYS.test(key))) return '***';
    if (typeof value === 'string') {
      if (budget.left <= 0) { budget.cut = true; return '…'; }
      // A cut is only a REAL cut: the string was longer than the size cap or the budget left. Masking that replaces or shortens it (a declared id
      // becomes first 4 + last 2, a secret becomes ***) is not a cut.
      const room = Math.min(LIMITS.maxMaskInput, budget.left);
      if (value.length > room) budget.cut = true;
      const out = mask(value.slice(0, room), keep);
      budget.left -= out.length;
      return out;
    }
    if (Array.isArray(value)) return value.slice(0, 50).map((v) => walk(v, keep, budget, key, depth + 1));
    if (typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).slice(0, 80).map(([k, v]) => { const mk = mask(k.slice(0, 200)); budget.left -= mk.length; return [mk, walk(v, keep, budget, k, depth + 1)]; }));
    }
    return undefined;
  };
  const maskDeep = (value, keep = null, budget = { left: LIMITS.maxDetail, cut: false }) => walk(value, keep, budget, '', 0);
  return { mask, maskDeep };
}

// ---- Line matchers ---------------------------------------------------------------------------------------
// Table-driven: each entry maps one product's log line to { layer, outcome, message, detail }.
//   status 'measured'   the line shape was seen on a real run (evidence: see the shared README, Evidence section; every source was read-only)
//   status 'UNVERIFIED' nobody has measured this shape; the rows it makes carry basis 'unverified-shape'. DO NOT promote one without a capture.
// ANCHORING. A line is either JSON (its FIRST line parses as an object) or text. A JSON line is only ever read through its own fields by a `json`
// matcher; a text matcher is skipped for it. A text matcher sees only the FIRST line of the entry, and every pattern starts at the beginning with
// the product's own prefix (the logback prefix, `level=... msg="`, the PingFederate `| tid:` columns) and ends at the end, with CLOSED value
// shapes (no spaces inside a value), so words a caller put in a request path or a message body cannot make a line count as a decision. A matcher
// returns null for a line it does not recognise; unrecognised lines are dropped (never guessed). `unverified: true` marks a row whose OUTCOME
// rests on an unmeasured value in a measured line.
const ANSI = /\u001b\[[0-9;]*m/g;
const nonEmpty = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v !== undefined && v !== null));
// `| key=value | key=value` with values that contain no space; a repeated key makes the line unreadable (null).
const segments = (tail) => {
  const out = Object.create(null);
  for (const seg of tail.split(' | ').slice(1)) {
    const i = seg.indexOf('=');
    if (i < 1 || seg.slice(0, i) in out) return null;
    out[seg.slice(0, i)] = seg.slice(i + 1);
  }
  return out;
};
// PingGateway's logback prefix, measured on its router-error line: "[thread] LEVEL logger @route - ".
const GW_PREFIX = '^\\[[^\\]]+\\]\\s+[A-Z]+\\s+\\S+\\s+@\\S+\\s+-\\s+';
const P1AZ_RE = new RegExp(`${GW_PREFIX}\\[P1AZ\\] DECISION:\\s*([A-Z_]+)((?: \\| [A-Za-z_]+=\\S*)*)\\s*$`);
const HITL_RE = new RegExp(`${GW_PREFIX}(?:\\[P1AZ\\]\\s+)?INDETERMINATE - HITL challenge (\\S+) minted for tool=(\\S*)\\s*$`);
// The Privilege gateway log, logfmt: `time=<ISO> level=<l> msg="<text>"` (the time is dropped by the readers that keep it separately).
const LOGFMT = /^(?:time="?[^"\s]+"?\s+)?level=(\w+)\s+msg="((?:[^"\\]|\\.)*)"\s*$/;
const logfmt = (v) => { const m = LOGFMT.exec(v.first); return m ? { level: m[1], msg: m[2] } : null; };
// PingFederate audit.log on container stdout: the measured container prefix, an optional PF time, then the pipe-delimited columns.
const AUDIT_LINE = /^(?:\/opt\/out\/instance\/log\/audit\.log:\s+)?(?:\d{4}-\d{2}-\d{2}[T ][\d:.,]{8,30}(?:Z|[+-]\d{2}:?\d{2})?\s*)?\|\s*tid:/;
// The MCP server's header line "[<time>] LEVEL: message"; free text after the header never decides the outcome, only a closed list at its START.
const MCP_HEADER = /^\[[^\]]*\]\s+(INFO|WARN|WARNING|ERROR):\s+(.*)$/;
const MCP_REFUSED = /^(?:tool call denied|access denied|insufficient scope|token validation failed|token expired|audience mismatch|invalid token|forbidden|unauthori[sz]ed|request rejected)(?![A-Za-z0-9])/i;
const MCP_SERVED = /^tool [A-Za-z0-9_.-]{1,64} (?:called|executed|completed|served)(?: successfully)?$/i;
const MCP_VALIDATION = /^(?:token|audience|introspection|scopes?)(?![A-Za-z0-9])/i;

const pgw = (id, re, build) => ({ id, product: 'privilege-gateway', status: 'measured', kind: 'text', match(v) { const l = logfmt(v); const m = l && re.exec(l.msg); return m ? build(m, l) : null; } });
const jsonDoc = (v) => v.obj;

export const layerMatchers = [
  {
    // MEASURED 2026-11-08 (PingFederate audit lines on container stdout, real run): exactly 14 columns from "tid:" — tid, tracking id, event, subject, ip, (blank),
    // client id, protocol, host id, component, status, (blank), description, response ms. Statuses seen: inprogress, failure. 'success' is UNVERIFIED.
    // A value that contains a pipe shifts the columns: the column count is then not 14 and the line is not read at all.
    id: 'pf-audit', product: 'pingfederate', status: 'measured', kind: 'text',
    match(v) {
      if (!AUDIT_LINE.test(v.first)) return null;
      const f = v.first.split('|').map((p) => p.trim());
      const t = f.findIndex((p) => p.startsWith('tid:'));
      if (t < 0 || f.length - t !== 14 || !/^\d+$/.test(f[t + 13])) return null;
      const [tid, tracking, event, subject, ip, , client, protocol, , component, status, , description] = f.slice(t);
      const st = status.toLowerCase();
      const outcome = st === 'failure' ? 'refused' : st === 'success' ? 'allowed' : 'info';
      // No subject means a client authenticating on its own (no person signed in): that is the agent layer's event.
      return {
        layer: subject ? 'person' : 'agent', outcome, unverified: st === 'success' || !['failure', 'success', 'inprogress'].includes(st),
        message: `PingFederate ${event || 'audit'} ${st || 'event'}${description ? `: ${description}` : ''}${client ? ` (client ${client})` : ''}`,
        detail: nonEmpty({ tid: tid.slice(4), trackingId: tracking, event, subject, ip, client, protocol, component, status }),
      };
    },
  },
  {
    // MEASURED 2026-11-08 (Authorize decision lines, real run): "[P1AZ] DECISION: PERMIT | backend=real | sub=<id> | tool=<name> | method=tools/call | vertical=<v> | obligation=hitl".
    // Values hold no spaces, so a tool name with " | obligation=hitl" in it makes the whole line unreadable instead of changing its meaning.
    // PERMIT is measured; the wording for any other decision is NOT (DENY is mapped to refused, anything else to info; both UNVERIFIED).
    id: 'p1az-decision', product: 'pinggateway', status: 'measured', kind: 'text',
    match(v) {
      const m = P1AZ_RE.exec(v.first);
      if (!m) return null;
      const f = segments(m[2]);
      if (f === null) return null;
      const permit = m[1] === 'PERMIT'; const hold = permit && f.obligation === 'hitl';
      return {
        layer: 'authorize', outcome: hold ? 'info' : permit ? 'allowed' : m[1] === 'DENY' ? 'refused' : 'info', unverified: !permit,
        message: `PingOne Authorize ${m[1]}${f.tool ? ` for tool ${f.tool}` : ''}${f.method ? ` (${f.method})` : ''}${hold ? ': permitted with a human-approval obligation, so the call is held' : ''}`,
        detail: nonEmpty({ decision: m[1], sub: f.sub, tool: f.tool, method: f.method, vertical: f.vertical, obligation: f.obligation, backend: f.backend }),
      };
    },
  },
  {
    // MEASURED 2026-11-08 (same container): "INDETERMINATE - HITL challenge <id> minted for tool=<name>", behind the same logback prefix.
    id: 'p1az-hitl', product: 'pinggateway', status: 'measured', kind: 'text',
    match(v) {
      const m = HITL_RE.exec(v.first);
      return m ? { layer: 'authorize', outcome: 'info', message: `A human approval was requested${m[2] ? ` for tool ${m[2]}` : ''} (challenge ${m[1]})`, detail: nonEmpty({ challenge: m[1], tool: m[2] }) } : null;
    },
  },
  {
    // MEASURED 2026-11-08 (access audit JSON, real run): one JSON object per request: eventName, response.statusCode (a string), http.request.path.
    // The line has no response body, so a 2xx is only `info` (an MCP error can ride in a 200); 401 and 403 are refusals.
    id: 'pinggateway-access', product: 'pinggateway', status: 'measured', kind: 'json',
    match(v) {
      const j = jsonDoc(v);
      if (j.eventName !== 'OPENIG-HTTP-ACCESS') return null;
      const code = Number(j.response?.statusCode);
      const refused = code === 401 || code === 403;
      return {
        layer: 'gateway', outcome: refused ? 'refused' : 'info',
        message: `PingGateway answered ${j.response?.statusCode ?? '?'}${j.response?.status ? ` (${j.response.status})` : ''} to ${j.http?.request?.method ?? 'a request'} ${j.http?.request?.path ?? ''}${refused ? '' : '; the access line does not show the MCP result'}`.trim(),
        detail: nonEmpty({ route: j.ig?.routeName, statusCode: j.response?.statusCode, status: j.response?.status, elapsedTime: j.response?.elapsedTime }),
      };
    },
  },
  {
    // MEASURED 2026-11-08 (MCP topic audit JSON, real run): client.method (tools/list, tools/call) and client.param (the tool name) on an authenticated call.
    id: 'pinggateway-mcp', product: 'pinggateway', status: 'measured', kind: 'json',
    match(v) {
      const j = jsonDoc(v);
      if (j.eventName !== 'PING-GATEWAY-MCP' || !j.client?.method) return null;
      return { layer: 'gateway', outcome: 'info', message: `MCP ${j.client.method}${j.client.param ? ` ${j.client.param}` : ''} passed through PingGateway`, detail: nonEmpty({ method: j.client.method, param: j.client.param, clientId: j.client.id }) };
    },
  },
  // ---- Privilege agent gateway: logfmt lines — MEASURED 2026-11-07/08 (real runs; see the shared README, Evidence section) ----
  pgw('pgw-token-found', /^Access token found for user: (\S+), client: (\S+)$/, (m) => ({ layer: 'agent', outcome: 'info', message: `The gateway saw an access token for user ${m[1]}, agent client ${m[2]}`, detail: { user: m[1], client: m[2] } })),
  pgw('pgw-policy-denied', /^\[mcpgw\] policy denied (\S+) access to (\w+) app (\S+) \(agent=(\w+)\)(?::.*)?$/, (m) => ({ layer: 'gateway', outcome: 'refused', message: `The gateway refused ${m[1]} access to ${m[2]} app ${m[3]} (policy denied)`, detail: { user: m[1], kind: m[2], app: m[3], agent: m[4] } })),
  pgw('pgw-proxying', /^Proxying to: (\S+)$/, (m) => ({ layer: 'gateway', outcome: 'allowed', message: `The gateway forwarded the call to ${m[1]} (it logs no allow line; forwarding is the evidence)`, detail: { backend: m[1] } })),
  pgw('pgw-mcp-call', /^MCP call detected for method (\S+) with target: (\S+)$/, (m) => ({ layer: 'gateway', outcome: 'info', message: `MCP ${m[1]} call to ${m[2]} detected`, detail: { method: m[1], target: m[2] } })),
  // The pair "authorization header missing" + "Invalid Authorization token" is written by ONE request (measured), so each is its own refusal row.
  pgw('pgw-auth-rejected', /^(authorization header missing|Invalid Authorization token)$/, (m) => ({ layer: 'gateway', outcome: 'refused', message: `The gateway refused a request: ${m[1]}`, detail: { reason: m[1] } })),
  pgw('pgw-aiguard-blocked', /^aiguard: blocked mcp response client=(\S+) category=(\S+)$/, (m) => ({ layer: 'privilege', outcome: 'blocked', message: `AI Guard blocked an MCP response (${m[2]}) for client ${m[1]}`, detail: { client: m[1], category: m[2] } })),
  // ---- Privilege gateway JSON documents (log-tailer / SIEM): field names MEASURED 2026-11-08, values are examples ----
  {
    id: 'pgw-json-denied', product: 'privilege-gateway', status: 'measured', kind: 'json',
    match(v) {
      const j = jsonDoc(v);
      if (!/^(MCP|A2A) policy denied$/.test(j.msg || '')) return null;
      return { layer: 'privilege', outcome: 'refused', message: `${j.msg}${j.App ? ` for app ${j.App}` : ''}${j.Reason ? `: ${j.Reason}` : ''}`, detail: nonEmpty({ app: j.App, agent: j.Agent, principal: j.Principal, decision: j.Decision, reason: j.Reason }) };
    },
  },
  {
    // The verdict is recorded; whether the call was then blocked is NOT in this document, so the row is `info`, never `blocked`.
    id: 'pgw-json-aiguard', product: 'privilege-gateway', status: 'measured', kind: 'json',
    match(v) {
      const j = jsonDoc(v);
      if (j.msg !== 'AIGuard') return null;
      return { layer: 'privilege', outcome: 'info', message: `AI Guard verdict recorded: ${j.Category || 'category not given'}${j.TopScore !== undefined ? ` (score ${j.TopScore})` : ''}; the document does not say whether the call was blocked`, detail: nonEmpty({ category: j.Category, client: j.Client, topScore: j.TopScore, level: j.level }) };
    },
  },
  // ---- Privilege SIEM index ping-siem-events-v2 (privilege_event_kind runtime) ----
  {
    // MEASURED shape (relayed 2026-11-08, never read directly): Index 'policy-decision-log', Data.Decision allow | deny | hitl.
    id: 'siem-policy-decision', product: 'privilege-siem', status: 'measured', kind: 'json',
    match(v) {
      const j = jsonDoc(v);
      if (j.Index !== 'policy-decision-log') return null;
      const d = String(j.Data?.Decision ?? j.Decision ?? '').toLowerCase();
      const outcome = d === 'allow' ? 'allowed' : d === 'deny' ? 'refused' : 'info';
      return { layer: 'privilege', outcome, message: `Privilege policy decision: ${d || 'not given'}`, detail: nonEmpty({ decision: d, index: j.Index, level: j.Level }) };
    },
  },
  {
    id: 'siem-aiguard', product: 'privilege-siem', status: 'measured', kind: 'json',
    match(v) { const j = jsonDoc(v); return j.Index === 'aiguard-log' ? { layer: 'privilege', outcome: 'info', message: 'AI Guard verdict recorded in the SIEM; the document does not say whether the call was blocked', detail: nonEmpty({ index: j.Index, level: j.Level }) } : null; },
  },
  {
    // UNVERIFIED: the agent-approval-log shape has never been seen.
    id: 'siem-approval', product: 'privilege-siem', status: 'UNVERIFIED', kind: 'json',
    match(v) { const j = jsonDoc(v); return j.Index === 'agent-approval-log' ? { layer: 'privilege', outcome: 'info', message: 'An agent approval event was recorded', detail: nonEmpty({ index: j.Index, level: j.Level }) } : null; },
  },
  // ---- Prompt-Guard sidecar — MEASURED 2026-11-08 ----
  {
    id: 'promptguard-allow', product: 'promptguard', status: 'measured', kind: 'text',
    match(v) { return /^promptguard: \d+ unit\(s\) -> allow$/.test(v.first) ? { layer: 'privilege', outcome: 'allowed', message: 'Prompt-Guard judged the text safe', detail: {} } : null; },
  },
  {
    // The gateway wrote no block line beside a flag (measured), so a flag is information, not a refusal.
    id: 'promptguard-flagged', product: 'promptguard', status: 'measured', kind: 'text',
    match(v) { const m = /^promptguard: \d+ unit\(s\) -> Prompt-Guard flagged (\w+) \(([\d.]+)\)$/.exec(v.first); return m ? { layer: 'privilege', outcome: 'info', message: `Prompt-Guard flagged ${m[1]} (${m[2]}); the log does not say whether the call was blocked`, detail: { category: m[1], score: m[2] } } : null; },
  },
  // ---- Resource server (the banking MCP server): a header line "[<time>] LEVEL: message" (the indented lines under it are context, not decisions) ----
  {
    // UNVERIFIED: the wording of a refusal or a failed validation has never been captured. Only a WARN or ERROR header whose message STARTS with a
    // closed phrase counts; text after it, and any other level, never decides.
    id: 'mcp-server-refused', product: 'mcp-server', status: 'UNVERIFIED', kind: 'text',
    match(v) { const m = MCP_HEADER.exec(v.first); return m && m[1] !== 'INFO' && MCP_REFUSED.test(m[2]) ? { layer: 'resource', outcome: 'refused', message: `MCP server: ${m[2]}`, detail: { level: m[1] } } : null; },
  },
  {
    // UNVERIFIED: the wording of a served tool call has never been captured; a closed phrase, the whole message, INFO level only.
    id: 'mcp-server-served', product: 'mcp-server', status: 'UNVERIFIED', kind: 'text',
    match(v) { const m = MCP_HEADER.exec(v.first); return m && m[1] === 'INFO' && MCP_SERVED.test(m[2]) ? { layer: 'resource', outcome: 'allowed', message: `MCP server: ${m[2]}`, detail: { level: m[1] } } : null; },
  },
  {
    // MEASURED 2026-11-08 (MCP server header lines, real run): "[<time>] INFO: token audience validated" — token-validation steps, claim values, never the token.
    id: 'mcp-server-validation', product: 'mcp-server', status: 'measured', kind: 'text',
    match(v) { const m = MCP_HEADER.exec(v.first); return m && MCP_VALIDATION.test(m[2]) ? { layer: 'resource', outcome: 'info', message: `MCP server: ${m[2]}`, detail: { level: m[1] } } : null; },
  },
];

// What a matcher sees: the text without ANSI colour and format characters (cut to maxLine), its first line, and the parsed object when the FIRST line is JSON.
function viewOf(line) {
  const text = String(line.message ?? '').slice(0, LIMITS.maxLine).replace(ANSI, '').replace(/\p{Cf}/gu, '');
  const first = text.split('\n', 1)[0];
  let obj = null;
  if (first.trimStart().startsWith('{')) {
    try { const parsed = JSON.parse(first); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) obj = parsed; } catch { /* not JSON: a text line */ }
  }
  return { text, first, obj, multiline: text.includes('\n') };
}

// A lab's own matchers (createRunObservability({ matchers })). They run AFTER the built-ins, only on text lines a reader really returned, and
// can never create a row without one or choose its origin. Each declares layer, product and basis; the pattern is anchored and linear:
//   { id, product, layer, basis: 'measured-shape'|'unverified-shape', pattern: /^...$/, build(match, line) -> { outcome, message, detail? } | null }
// The pattern must start with ^ and end with $, have no top-level alternation, no lookaround, no `.*` / `.+`, no g, y or m flag, and carry at
// least 8 characters of your own fixed text. build() gets frozen copies, and its output is validated.
function patternProblem(re) {
  if (!(re instanceof RegExp)) return 'pattern must be a RegExp';
  if (/[gym]/.test(re.flags)) return 'pattern must not use the g, y or m flag';
  const src = re.source;
  if (!src.startsWith('^')) return 'pattern must start with ^';
  if (!/(?<!\\)(?:\\\\)*\$$/.test(src)) return 'pattern must end with $';
  let depth = 0; let inClass = false; let inBrace = false; let run = 0; let best = 0;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (c === '\\') { const n = src[i + 1]; i += 1; if (/[A-Za-z0-9]/.test(n)) run = 0; else { run += 1; best = Math.max(best, run); } continue; }
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (inBrace) { if (c === '}') inBrace = false; continue; }
    if (c === '{') { inBrace = true; run = 0; continue; }
    if (c === '[') { inClass = true; run = 0; continue; }
    if (c === '(') { depth += 1; run = 0; if (/^\(\?(?:=|!|<=|<!)/.test(src.slice(i))) return 'pattern must not use lookaround'; continue; }
    if (c === ')') { depth -= 1; run = 0; continue; }
    if (c === '|' && depth === 0) return 'pattern must not have top-level alternation';
    if (c === '.' && (src[i + 1] === '*' || src[i + 1] === '+')) return 'pattern must not use .* or .+ (use \\S+ or a bounded class)';
    if ('.*+?{}^$|'.includes(c)) { run = 0; continue; }
    run += 1; best = Math.max(best, run);
  }
  return best >= 8 ? null : 'pattern must contain at least 8 characters of your own fixed text';
}

export function validateMatchers(list = []) {
  if (!Array.isArray(list)) throw new RunObsError('bad_matcher', 'matchers must be an array.');
  const seen = new Set(layerMatchers.map((m) => m.id));
  return list.map((m) => {
    const bad = (why) => { throw new RunObsError('bad_matcher', `Lab matcher ${typeof m?.id === 'string' ? m.id.slice(0, 40) : '?'}: ${why}.`); };
    if (!m || typeof m !== 'object') bad('not an object');
    if (typeof m.id !== 'string' || !/^[a-z0-9-]{1,60}$/.test(m.id) || seen.has(m.id)) bad('needs a unique id of lower-case letters, digits and hyphens');
    seen.add(m.id);
    if (!safeName(m.product)) bad('needs a product');
    if (!LAYERS.includes(m.layer)) bad(`layer must be one of ${LAYERS.join(', ')}`);
    if (!BASES.includes(m.basis)) bad(`basis must be ${BASES.join(' or ')}`);
    const why = patternProblem(m.pattern); if (why) bad(why);
    if (typeof m.build !== 'function') bad('needs a build function');
    return Object.freeze({ id: m.id, product: m.product, layer: m.layer, basis: m.basis, pattern: m.pattern, build: m.build });
  });
}

// `onError(matcher)` is told about a matcher that threw; the line is then simply not matched.
export function classify(line, labMatchers = [], onError = () => {}) {
  const v = viewOf(line);
  for (const m of layerMatchers) {
    if (m.product !== line.product || (m.kind === 'json') !== (v.obj !== null)) continue;
    let r;
    try { r = m.match(v); } catch { onError(m); continue; }
    if (r) return { ...r, matcher: m.id, basis: m.status === 'UNVERIFIED' || r.unverified ? 'unverified-shape' : 'measured-shape', multiline: v.multiline };
  }
  if (v.obj === null) {
    for (const m of labMatchers) {
      if (m.product !== line.product) continue;
      const found = m.pattern.exec(v.first);
      if (!found) continue;
      let r;
      try { r = m.build(Object.freeze(Array.from(found)), Object.freeze({ product: line.product, message: v.first, at: line.at, atExact: line.atExact })); } catch { onError(m); continue; }
      if (r && OUTCOMES.includes(r.outcome) && typeof r.message === 'string') {
        return { layer: m.layer, outcome: r.outcome, message: r.message.slice(0, 1000), detail: r.detail && typeof r.detail === 'object' && !Array.isArray(r.detail) ? r.detail : {}, matcher: m.id, basis: m.basis, multiline: v.multiline };
      }
    }
  }
  return null;
}

// ---- The collector ---------------------------------------------------------------------------------------
// A layer spec: { layer, products: [product ids to read], simulated: [{ at, product?, outcome, message, detail? }] (mock only),
// responses: [same shape] (real only: decisions the lab holds as an API response, origin 'response'), reason (why products is empty) }.
// `at` is an ISO string or epoch milliseconds, like the window; all times are between the years 2000 and 2100.
const SAAS = 'PingOne sign-in and PingOne Authorize events are in the PingOne audit activity API, not in a container log; this panel does not read it yet (see the README follow-ups). A decision the lab holds as an API response is shown as a response row, never as logged.';
export function defaultLayers() {
  return [
    { layer: 'person', products: ['pingfederate'] },
    { layer: 'agent', products: ['pingfederate', 'privilege-gateway'] },
    { layer: 'authorize', products: ['pinggateway'] },
    { layer: 'privilege', products: ['privilege-siem', 'privilege-gateway', 'promptguard'] },
    { layer: 'gateway', products: ['privilege-gateway', 'pinggateway'] },
    { layer: 'resource', products: ['mcp-server'] },
  ];
}
export const saasLayer = (layer, responses = []) => ({ layer, products: [], reason: SAAS, responses });

const iso = (ms) => new Date(ms).toISOString();
const toMs = (v, what, code = 'bad_window') => {
  const ms = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  if (!Number.isFinite(ms) || ms < MIN_MS || ms > MAX_MS) throw new RunObsError(code, `${what} is not a time between the years 2000 and 2100.`);
  return ms;
};
// Whole-token matching of the run's ids: a short or common sub ("user", "demo") must not mark unrelated lines as this run's.
const terms = (c = {}) => [c.sub, c.actClientId, c.traceId, ...(Array.isArray(c.requestIds) ? c.requestIds : [])]
  .filter((t) => typeof t === 'string' && t.length >= LIMITS.minIdTerm && t.length <= 200).slice(0, 20).map((t) => new RegExp(`(?<![A-Za-z0-9_-])${escapeRe(t)}(?![A-Za-z0-9_-])`, 'i'));

const PARTIAL_NOTE = 'The search was cut at the cap, so absence is not proof.';

export function createRunObservability({ readers = [], masker = createMasker(), clock = () => Date.now(), matchers = [] } = {}) {
  const { mask, maskDeep } = masker;
  const labMatchers = validateMatchers(matchers);
  const knownProducts = new Set([...layerMatchers.map((m) => m.product), ...labMatchers.map((m) => m.product)]);
  const cache = new WeakMap();

  async function readProduct(product, from, to, classified) {
    const fails = []; const empties = [];
    for (const reader of readers) {
      try {
        if (!reader.canRead(product)) { fails.push(`${reader.name}: no source configured for ${product}`); continue; }
        const res = await reader.readLines({ product, from, to, match: (l) => classified(l) !== null });
        if (!Array.isArray(res?.lines)) throw new ReaderError('bad_reader', 'the reader returned no lines array');
        if (res.lines.length > 0) return { ...res, reader: reader.name, fellBack: [...fails, ...empties.map((e) => `${e.name}: returned no usable lines`)] };
        empties.push({ name: reader.name, res });
      } catch (e) {
        fails.push(`${reader.name}: ${e instanceof ReaderError ? e.message : 'unexpected error reading logs'}`);
      }
    }
    if (empties.length) return { lines: [], truncated: empties.some((e) => e.res.truncated === true), notes: empties.flatMap((e) => e.res.notes || []), reader: empties[0].name, fellBack: fails };
    return { failed: fails.length ? fails : ['no log reader is configured: set RUN_OBS_ES_URL and RUN_OBS_ES_READ_APIKEY (a read-only Elasticsearch key; see the README), or RUN_OBS_DOCKER=1 with RUN_OBS_CONTAINERS for an ad-hoc run'] };
  }

  function specsOf(layers) {
    if (!Array.isArray(layers)) throw new RunObsError('bad_layer', 'layers must be an array.');
    const specs = layers.map((l) => (typeof l === 'string' && LAYERS.includes(l) ? defaultLayers().find((d) => d.layer === l) : l));
    const seen = new Set();
    for (const s of specs) {
      if (!s || typeof s !== 'object' || !LAYERS.includes(s.layer)) throw new RunObsError('bad_layer', `Unknown layer: ${typeof s?.layer === 'string' ? s.layer.slice(0, 40) : '?'}.`);
      if (seen.has(s.layer)) throw new RunObsError('bad_layer', `Layer ${s.layer} is listed twice.`);
      seen.add(s.layer);
      if (s.products !== undefined && (!Array.isArray(s.products) || s.products.length > LIMITS.maxProducts || !s.products.every((p) => safeName(p) && knownProducts.has(p)))) {
        throw new RunObsError('bad_layer', `Layer ${s.layer}: products must be an array of known product ids (those with a matcher).`);
      }
      for (const k of ['simulated', 'responses']) if (s[k] !== undefined && !Array.isArray(s[k])) throw new RunObsError('bad_layer', `Layer ${s.layer}: ${k} must be an array.`);
    }
    // A layer the lab did not ask for is not-logged and says so: every record names all six.
    for (const l of LAYERS) if (!seen.has(l)) specs.push({ layer: l, products: [], reason: 'This lab did not ask for this layer.' });
    return specs;
  }

  async function collectRun({ runId, startedAt, endedAt, correlation = {}, layers = defaultLayers(), source = 'real' } = {}) {
    if (source !== 'mock' && source !== 'real') throw new RunObsError('bad_source', 'source must be mock or real.');
    const from = toMs(startedAt, 'startedAt');
    const to = endedAt === undefined ? toMs(clock(), 'the clock') : toMs(endedAt, 'endedAt');
    if (to < from) throw new RunObsError('bad_window', 'endedAt is before startedAt.');
    const specs = specsOf(layers);
    const want = terms(correlation);
    const keep = keepPattern(correlation);
    let truncated = false;
    const matcherErrors = {};
    const cap = (s, n = LIMITS.maxMessage) => { const t = mask(s, keep); return t.length > n ? `${t.slice(0, n)}…` : t; };
    const detailOf = (d) => { const budget = { left: LIMITS.maxDetail, cut: false }; const out = maskDeep(d, keep, budget); if (budget.cut) truncated = true; return out; };
    const classified = (line) => {
      if (!cache.has(line)) cache.set(line, classify(line, labMatchers, (m) => { const k = m.layer ?? 'gateway'; matcherErrors[k] = (matcherErrors[k] || 0) + 1; }));
      return cache.get(line);
    };
    let seq = 0;
    const rowFrom = (e, layer, origin) => {
      const ms = toMs(e?.at, `The time of a ${origin} ${layer} row`, `bad_${origin}_row`);
      if (!OUTCOMES.includes(e?.outcome) || typeof e.message !== 'string' || !e.message) throw new RunObsError(`bad_${origin}_row`, `A ${origin} ${layer} row needs at (ISO or epoch ms), outcome (${OUTCOMES.join('/')}) and a message string.`);
      return { seq: seq++, at: ms, atExact: typeof e.at === 'string' && ISO_RE.test(e.at) ? e.at : iso(ms), layer, product: cap(e.product || (origin === 'simulated' ? 'lab mock' : 'API response')), outcome: e.outcome, message: cap(e.message), origin, detail: e.detail === undefined ? undefined : detailOf(e.detail) };
    };
    const rows = []; const coverage = {}; const reasons = {}; const partial = {};

    if (source === 'mock') {
      for (const s of specs) {
        const sim = s.simulated || [];
        if (Array.isArray(s.responses) && s.responses.length) throw new RunObsError('bad_response_row', 'A mock run has no API responses: the mock computed them, so they are simulated rows.');
        for (const e of sim) rows.push(rowFrom(e, s.layer, 'simulated'));
        coverage[s.layer] = sim.length ? 'simulated' : 'not-logged';
        if (!sim.length) reasons[s.layer] = s.reason || 'The lab mock produced no event for this layer.';
      }
    } else {
      const products = [...new Set(specs.flatMap((s) => s.products || []))];
      const read = new Map(await Promise.all(products.map(async (p) => [p, await readProduct(p, from, to, classified)])));
      for (const s of specs) {
        const prods = s.products || [];
        const resp = s.responses || [];
        if ((s.simulated || []).length) throw new RunObsError('bad_simulated_row', 'A real run cannot hold simulated rows.');
        for (const e of resp) rows.push(rowFrom(e, s.layer, 'response'));
        if (!prods.length) {
          coverage[s.layer] = resp.length ? 'response' : 'not-logged';
          if (!resp.length) reasons[s.layer] = s.reason || 'No log source applies to this layer.';
          continue;
        }
        let got = 0; let readOk = 0; const why = [];
        for (const p of prods) {
          const r = read.get(p);
          if (r.failed) { why.push(`${p}: ${r.failed.join('; ')}`); continue; }
          readOk += 1;
          if (r.fellBack.length) why.push(`${p}: read from ${r.reader} after ${r.fellBack.join('; ')}`);
          for (const n of r.notes || []) why.push(`${p}: ${n}`);
          if (r.truncated) { truncated = true; partial[s.layer] = true; }
          for (const line of r.lines) {
            if (String(line.message ?? '').length > LIMITS.maxLine) truncated = true;
            const c = classified(line);
            if (!c || c.layer !== s.layer || !Number.isFinite(line.at) || line.at < from || line.at > to) continue;
            const first = String(line.message ?? '').slice(0, LIMITS.maxLine).split('\n', 1)[0];
            rows.push({
              seq: seq++, at: line.at, atExact: ISO_RE.test(line.atExact) ? line.atExact : iso(line.at), layer: s.layer, product: p, outcome: c.outcome, message: cap(c.message), origin: 'logged', basis: c.basis,
              matchedBy: want.some((re) => re.test(`${first} ${line.requestId || ''}`)) ? 'id' : 'window', matcher: c.matcher, detail: detailOf(c.detail),
              ...(c.multiline ? { multiline: true } : {}), ...(line.host ? { host: cap(line.host) } : {}),
            });
            got += 1;
          }
        }
        if (got) coverage[s.layer] = 'logged';
        else if (resp.length) coverage[s.layer] = 'response';
        else if (readOk) { coverage[s.layer] = 'not-logged'; reasons[s.layer] = 'No matching line was found for this run in the window. The product may not log this event.'; }
        else coverage[s.layer] = 'unreachable';
        // The partial note goes FIRST so no length cap can ever drop it.
        const text = [partial[s.layer] ? PARTIAL_NOTE : '', reasons[s.layer] ?? '', why.join(' | ')].filter(Boolean).join(' ');
        if (text) reasons[s.layer] = text;
      }
      for (const [layer, n] of Object.entries(matcherErrors)) reasons[layer] = `${reasons[layer] ? `${reasons[layer]} ` : ''}${n} lab matcher error${n === 1 ? ' was' : 's were'} ignored.`;
    }

    // The cap: placeholders for not-logged layers are counted in it. Rows are dropped OLDEST first from the layer holding the most, so every
    // layer keeps its newest rows; coverage is then rebuilt from the rows that are left, never claiming what no row supports. Equal times keep
    // the order the rows were written in (seq).
    const byTime = (a, b) => a.at - b.at || a.seq - b.seq;
    rows.sort(byTime);
    const placeholder = new Set(specs.filter((s) => coverage[s.layer] === 'not-logged').map((s) => s.layer));
    const kind = (l, rs) => (rs.some((r) => r.layer === l && r.origin === 'logged') ? 'logged' : rs.some((r) => r.layer === l && r.origin === 'response') ? 'response' : rs.some((r) => r.layer === l && r.origin === 'simulated') ? 'simulated' : null);
    let kept = rows;
    for (let pass = 0; pass <= LAYERS.length; pass += 1) {
      const budget = Math.max(0, LIMITS.maxRows - placeholder.size);
      const by = new Map();
      for (const r of rows) { if (!by.has(r.layer)) by.set(r.layer, []); by.get(r.layer).push(r); }
      const heads = new Map([...by.keys()].map((l) => [l, 0]));
      let total = rows.length;
      while (total > budget) {
        let pick = null;
        for (const [l, list] of by) { const left = list.length - heads.get(l); if (left > 0 && (pick === null || left > by.get(pick).length - heads.get(pick))) pick = l; }
        heads.set(pick, heads.get(pick) + 1); total -= 1;
      }
      kept = [...by].flatMap(([l, list]) => list.slice(heads.get(l)));
      if (kept.length < rows.length) truncated = true;
      let lost = false;
      for (const s of specs) {
        if (!['logged', 'response', 'simulated'].includes(coverage[s.layer])) continue;
        const now = kind(s.layer, kept);
        if (now === coverage[s.layer]) continue;
        lost = true;
        if (now) coverage[s.layer] = now;
        else { coverage[s.layer] = 'not-logged'; reasons[s.layer] = 'Every row of this layer was dropped at the row cap; narrow the run window to see them.'; placeholder.add(s.layer); }
      }
      if (!lost) break;
    }
    kept.sort(byTime);
    const out = kept.map(({ seq: _s, ...r }, i) => ({ id: `r${i + 1}`, ...r, at: iso(r.at) }));
    for (const s of specs) {
      if (placeholder.has(s.layer) && coverage[s.layer] === 'not-logged') {
        out.push({ id: `n-${s.layer}`, at: null, layer: s.layer, product: cap((s.products || []).join(', ') || 'none'), outcome: 'info', message: cap(reasons[s.layer], LIMITS.maxReason), origin: 'not-logged' });
      }
    }
    // A row whose line shape is unverified is counted as information, whatever outcome it carries.
    const summary = { allowed: 0, refused: 0, blocked: 0, info: 0, unverified: 0 };
    for (const r of out) {
      if (r.origin === 'not-logged') continue;
      if (r.basis === 'unverified-shape') { summary.info += 1; summary.unverified += 1; } else summary[r.outcome] += 1;
    }
    return {
      runId: cap(runId ?? ''), window: { from: iso(from), to: iso(to) }, source, excerpt: true, truncated, rows: out, coverage,
      reasons: Object.fromEntries(Object.entries(reasons).map(([k, v]) => [k, cap(v, LIMITS.maxReason)])), partial, summary,
    };
  }

  return { collectRun };
}

// ---- The contract ----------------------------------------------------------------------------------------
// Returns a list of problems (empty = fine). Every lab test calls it on a mock and a real record; it is the honesty rule, written as code.
const CRED_RE = `(?!${CRED_WORDS}\\b)`;
const LEAKS = [
  [new RegExp(`\\b(?:Bearer|DPoP)\\s+(?![*<])${CRED_RE}[A-Za-z0-9._~+/=-]{6,}`, 'i'), 'an unmasked Bearer credential'],
  [new RegExp(`\\bApiKey\\s+(?![*<])${CRED_RE}[A-Za-z0-9._~+/=-]{6,}`, 'i'), 'an unmasked ApiKey credential'],
  [new RegExp(`\\bBasic\\s+(?![*<])${CRED_RE}[A-Za-z0-9+/]{8,}`, 'i'), 'a Basic credential'],
  [/\beyJ[\w-]{10,}/, 'a JWT'],
  [/\b(?:sk|rk|pk)_(?:live|test)_(?!\*)[A-Za-z0-9]{8,}|\bsk-(?!\*)[A-Za-z0-9_-]{8,}/, 'an sk- key'],
  [/\bxox[abprs]-(?!\*)[A-Za-z0-9-]{8,}/, 'a Slack token'],
  [/\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}/, 'a cloud or git token'],
  [new RegExp(`(?<![A-Za-z0-9])${STRONG}(?![A-Za-z0-9])["')\\]]*\\s*[:=]\\s*["']?(?!\\*\\*\\*|<redacted>|["'])[^\\s"',}]{3,}`, 'i'), 'a secret-named field with a value'],
  [new RegExp(`(?<![A-Za-z0-9])${WEAK}(?![A-Za-z0-9])["')\\]]*=\\s*["']?(?!\\*\\*\\*|["'])[^\\s"',}]{3,}`, 'i'), 'a token, pass, sid or session value'],
  [/\b(?:authorization|cookie|set-cookie|x-api-key|x-amz-security-token)\s*:\s*(?!\*\*\*)[^\s*]{4,}/i, 'an unmasked credential header'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/, 'an IPv4 address'],
  [new RegExp(IPV6, 'i'), 'an IPv6 address'],
  [new RegExp(EMAIL), 'an email address'],
  [new RegExp(HOST, 'i'), 'a hostname'],
];
// Every string in the record, keys included, and every "key=value" pair, to any depth: a cycle guard and a size budget stop a hostile record.
function scan(root, bad) {
  const seen = new Set(); const stack = [root]; let budget = 400_000; let n = 0;
  const hit = (s) => { for (const [re, what] of LEAKS) if (re.test(s.length > 4000 ? s.slice(0, 4000) : s)) return what; return null; };
  while (stack.length) {
    const v = stack.pop();
    if (n++ > 100_000 || budget < 0) { bad.push('the record is too large to check'); return; }
    if (typeof v === 'string') { budget -= v.length; const w = hit(v); if (w) bad.push(`the record holds ${w}`); continue; }
    if (!v || typeof v !== 'object') continue;
    if (seen.has(v)) continue;
    seen.add(v);
    for (const [k, x] of Object.entries(v)) {
      stack.push(k);
      if (typeof x === 'string') { const pair = `${k}=${x}`; budget -= pair.length; const w = hit(pair); if (w) bad.push(`the record holds ${w}`); }
      stack.push(x);
    }
  }
}

export function assertRunObservability(r) {
  const bad = [];
  if (!r || typeof r !== 'object') return ['not an object'];
  if (r.source !== 'mock' && r.source !== 'real') bad.push(`source must be mock or real, got ${r.source}`);
  if (r.excerpt !== true) bad.push('a record must say it is an excerpt (excerpt: true)');
  if (!r.window || !Number.isFinite(Date.parse(r.window.from)) || !Number.isFinite(Date.parse(r.window.to))) bad.push('window needs from and to');
  else if (Date.parse(r.window.from) > Date.parse(r.window.to)) bad.push('window.from is after window.to');
  if (!Array.isArray(r.rows)) { bad.push('rows must be an array'); return bad; }
  if (r.rows.length > Math.max(LIMITS.maxRows, LAYERS.length)) bad.push(`more than ${LIMITS.maxRows} rows`);
  const cov = r.coverage && typeof r.coverage === 'object' ? r.coverage : {};
  if (!r.coverage) bad.push('coverage is missing');
  else for (const l of LAYERS) if (!(l in cov)) bad.push(`coverage names no state for layer ${l}`);
  if (!r.summary || typeof r.summary !== 'object') bad.push('summary is missing');
  const count = { allowed: 0, refused: 0, blocked: 0, info: 0, unverified: 0 };
  const has = Object.fromEntries(LAYERS.map((l) => [l, { logged: false, simulated: false, response: false, 'not-logged': false }]));
  const ids = new Set(); let lastAt = -Infinity;
  for (const [i, row] of r.rows.entries()) {
    const at = `row ${row?.id ?? i}`;
    if (!row || typeof row !== 'object') { bad.push(`${at} is not an object`); continue; }
    if (ids.has(row.id)) bad.push(`${at}: the row id is used twice`);
    ids.add(row.id);
    if (!LAYERS.includes(row.layer)) bad.push(`${at}: layer ${row.layer}`);
    if (!OUTCOMES.includes(row.outcome)) bad.push(`${at}: outcome ${row.outcome}`);
    if (!ORIGINS.includes(row.origin)) bad.push(`${at}: origin ${row.origin}`);
    if (typeof row.message !== 'string' || !row.message) bad.push(`${at}: the message must be a non-empty string`);
    if (has[row.layer] && ORIGINS.includes(row.origin)) has[row.layer][row.origin] = true;
    if (row.at) { const t = Date.parse(row.at); if (Number.isFinite(t)) { if (t < lastAt) bad.push(`${at}: rows are not in time order`); lastAt = Math.max(lastAt, t); } }
    if (row.origin === 'logged') {
      if (!row.at || !Number.isFinite(Date.parse(row.at))) bad.push(`${at}: a logged row needs the timestamp of its log line`);
      if (!BASES.includes(row.basis)) bad.push(`${at}: a logged row needs basis ${BASES.join(' or ')}`);
      if (r.source === 'mock') bad.push(`${at}: a mock record cannot hold a logged row; nothing was read from a log`);
    }
    if (row.origin === 'simulated') {
      if (r.source === 'real') bad.push(`${at}: a real record cannot hold a simulated row`);
      if (!row.at || !Number.isFinite(Date.parse(row.at))) bad.push(`${at}: a simulated row needs a time`);
      if (row.basis || row.matchedBy || row.matcher) bad.push(`${at}: a simulated row is presented as read from a log (basis, matchedBy or matcher set)`);
    }
    if (row.origin === 'response') {
      if (r.source === 'mock') bad.push(`${at}: a mock record cannot hold a response row; the mock computed it, so it is simulated`);
      if (!row.at || !Number.isFinite(Date.parse(row.at))) bad.push(`${at}: a response row needs the time the lab received it`);
      if (row.basis || row.matchedBy || row.matcher) bad.push(`${at}: a response row is presented as read from a log (basis, matchedBy or matcher set)`);
    }
    if (row.origin === 'not-logged' && row.at) bad.push(`${at}: a not-logged row has no log line, so it has no timestamp`);
    if (row.passed === true && row.outcome === 'info') bad.push(`${at}: an info row is counted as passed`);
    if (row.origin !== 'not-logged' && OUTCOMES.includes(row.outcome)) {
      if (row.basis === 'unverified-shape') { count.info += 1; count.unverified += 1; } else count[row.outcome] += 1;
    }
  }
  for (const [layer, state] of Object.entries(cov)) {
    if (!LAYERS.includes(layer)) { bad.push(`coverage names an unknown layer ${layer}`); continue; }
    if (!COVERAGE.includes(state)) { bad.push(`coverage ${layer}: ${state}`); continue; }
    const h = has[layer];
    // The tag must be exactly what the rows support: logged wins over response, which wins over simulated.
    const supported = h.logged ? 'logged' : h.response ? 'response' : h.simulated ? 'simulated' : null;
    if (state === 'logged' || state === 'response' || state === 'simulated') {
      if (!h[state]) bad.push(`coverage ${layer} says ${state} but no ${state} row exists`);
      else if (supported !== state) bad.push(`coverage ${layer} says ${state} but the rows support ${supported}`);
    } else if (supported) bad.push(`coverage ${layer} says ${state} but a ${supported} row exists for it`);
    if (state === 'not-logged' && !h['not-logged']) bad.push(`coverage ${layer} says not-logged but there is no not-logged row saying so`);
    if (state === 'logged' && r.source === 'mock') bad.push(`coverage ${layer}: a mock record cannot say logged`);
    if (state === 'response' && r.source === 'mock') bad.push(`coverage ${layer}: a mock record cannot say response`);
    if (state === 'simulated' && r.source === 'real') bad.push(`coverage ${layer}: a real record cannot say simulated`);
    if ((state === 'unreachable' || state === 'not-logged') && !(r.reasons && r.reasons[layer])) bad.push(`coverage ${layer}: ${state} needs a reason`);
    if (r.partial?.[layer] && !/not proof/.test(r.reasons?.[layer] ?? '')) bad.push(`coverage ${layer}: a partial search must say absence is not proof`);
  }
  if (r.summary) {
    for (const k of Object.keys(count)) if (r.summary[k] !== count[k]) bad.push(`summary.${k} is ${r.summary[k]} but the rows say ${count[k]} (an info row, or a row with an unverified shape, must never be counted as allowed, refused or blocked)`);
  }
  scan(r, bad);
  return [...new Set(bad)];
}
