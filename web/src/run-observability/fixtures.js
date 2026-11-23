// fixtures.js — records for RunObservability tests and for a lab's own tests. Vendor to web/src/run-observability/fixtures.js.
// Everything here is already masked, the way collectRun returns it. Only placeholders: no real host, tenant or id.
const WINDOW = { from: '2026-11-22T10:00:00.000Z', to: '2026-11-22T10:00:09.000Z' };
const t = (s, ms = '000') => `2026-11-22T10:00:0${s}.${ms}Z`;

export const streams = [
  { product: 'PingFederate audit.log', lives: 'the pingfederate container stdout (the image tails the file)', streams: 'Vector to Elasticsearch index ping-logs-pingfederate, then your SIEM' },
  { product: 'Privilege gateway', lives: 'cyonproxy.log in the gateway log volume', streams: 'Vector to ping-logs-privilege-gateway; the Privilege SIEM export to ping-siem-events-v2' },
];

// Mock mode: every row is simulated. The authorize layer was not simulated, so it says so.
export const mockRecord = {
  runId: 'run-mock-1', window: WINDOW, source: 'mock', excerpt: true, truncated: false,
  rows: [
    { id: 'r1', at: t(1), atExact: t(1), layer: 'person', product: 'lab mock IdP', outcome: 'allowed', message: 'Mock sign-in of user-7 succeeded', origin: 'simulated', detail: { sub: 'user-7', amr: ['pwd'] } },
    { id: 'r2', at: t(2), atExact: t(2), layer: 'agent', product: 'lab mock IdP', outcome: 'allowed', message: 'Token exchange: act.client_id agent-1 on behalf of user-7', origin: 'simulated', detail: { act: { sub: 'agent-1' } } },
    { id: 'r3', at: t(4), atExact: t(4), layer: 'privilege', product: 'lab mock Privilege', outcome: 'blocked', message: 'AI Guard blocked the prompt (prompt_injection)', origin: 'simulated', detail: { category: 'prompt_injection', score: 0.99 } },
    { id: 'r4', at: t(5), atExact: t(5), layer: 'gateway', product: 'lab mock gateway', outcome: 'refused', message: 'The gateway refused tools/call pay_tuition_balance: no grant', origin: 'simulated' },
    { id: 'r5', at: t(6), atExact: t(6), layer: 'resource', product: 'lab mock MCP server', outcome: 'info', message: 'Tool call was not reached', origin: 'simulated' },
    { id: 'n-authorize', at: null, layer: 'authorize', product: 'none', outcome: 'info', message: 'The lab mock produced no event for this layer.', origin: 'not-logged' },
  ],
  coverage: { person: 'simulated', agent: 'simulated', authorize: 'not-logged', privilege: 'simulated', gateway: 'simulated', resource: 'simulated' },
  reasons: { authorize: 'The lab mock produced no event for this layer.' },
  summary: { allowed: 2, refused: 1, blocked: 1, info: 1, unverified: 0 },
};

// Real mode: logged rows with their own timestamps, a layer the product did not log, and one that could not be read.
export const realRecord = {
  runId: 'run-real-1', window: WINDOW, source: 'real', excerpt: true, truncated: false,
  rows: [
    { id: 'r1', at: t(1, '120'), atExact: '2026-11-22T10:00:01.120456789Z', layer: 'person', product: 'pingfederate', outcome: 'info', message: 'PingFederate OAuth inprogress (client ab12…9f)', origin: 'logged', basis: 'measured-shape', matchedBy: 'id', matcher: 'pf-audit', detail: { tid: 'a1b2…9f', subject: 'user-7', ip: '<ip>', status: 'inprogress' } },
    { id: 'r2', at: t(2, '300'), atExact: t(2, '300'), layer: 'authorize', product: 'PingOne Authorize (API response)', outcome: 'allowed', message: 'PERMIT for tool whoami under policy tools-for-staff (read from the decision response, not from a log)', origin: 'response', detail: { decision: 'PERMIT', policy: 'tools-for-staff', tool: 'whoami' } },
    { id: 'r3', at: t(3, '050'), atExact: t(3, '050'), layer: 'privilege', product: 'privilege-gateway', outcome: 'blocked', message: 'AI Guard blocked an MCP response (malicious_content) for client main-agent', origin: 'logged', basis: 'measured-shape', matchedBy: 'window', matcher: 'pgw-aiguard-blocked', detail: { client: 'main-agent', category: 'malicious_content' } },
    { id: 'r4', at: t(4, '800'), atExact: t(4, '800'), layer: 'gateway', product: 'privilege-gateway', outcome: 'refused', message: 'The gateway refused user ab12…9f access to a2a app worker-agent (policy denied)', origin: 'logged', basis: 'measured-shape', matchedBy: 'id', matcher: 'pgw-policy-denied' },
    { id: 'r5', at: t(6, '000'), atExact: t(6, '000'), layer: 'resource', product: 'mcp-server', outcome: 'refused', message: 'MCP server: tool call denied: insufficient scope', origin: 'logged', basis: 'unverified-shape', matchedBy: 'window', matcher: 'mcp-server-refused' },
    { id: 'n-agent', at: null, layer: 'agent', product: 'pingfederate, privilege-gateway', outcome: 'info', message: 'No matching line was found for this run in the window. The product may not log this event.', origin: 'not-logged' },
  ],
  coverage: { person: 'logged', agent: 'not-logged', authorize: 'response', privilege: 'logged', gateway: 'logged', resource: 'logged' },
  reasons: { agent: 'No matching line was found for this run in the window. The product may not log this event.' },
  summary: { allowed: 1, refused: 1, blocked: 1, info: 2, unverified: 1 },
};

// Long names and an unreachable layer: the layout must wrap, never cut or scroll.
const LONG = 'a-very-long-agent-client-name-that-keeps-going-and-going-without-a-single-break-to-wrap-on-a-phone-screen';
export const longRecord = {
  ...realRecord, runId: `run-${LONG}`,
  rows: [
    { ...realRecord.rows[0], message: `PingFederate OAuth failure: ${LONG} (client ${LONG})`, outcome: 'refused', detail: { subject: LONG, description: LONG } },
    realRecord.rows[1], realRecord.rows[2], realRecord.rows[3],
  ],
  coverage: { person: 'logged', agent: 'unreachable', authorize: 'response', privilege: 'logged', gateway: 'logged', resource: 'unreachable' },
  reasons: { agent: 'elasticsearch: no source configured for pingfederate | docker: Docker socket not reachable (ENOENT).', resource: 'elasticsearch: Elasticsearch refused the read credential (HTTP 401). | docker: Docker has no container named mcp-server.' },
  summary: { allowed: 1, refused: 2, blocked: 1, info: 0, unverified: 0 },
};

// A search cut at its cap: the agent layer found nothing in what was read, which is NOT proof that nothing was logged.
export const partialRecord = {
  ...realRecord, runId: 'run-partial-1', truncated: true,
  reasons: { agent: 'No matching line was found in what was read. pingfederate: the search was cut at the cap, so absence is not proof' },
  partial: { agent: true },
};

// A run that read fine and found nothing.
export const emptyRecord = {
  runId: 'run-empty', window: WINDOW, source: 'real', excerpt: true, truncated: false, rows: [],
  coverage: { person: 'unreachable', agent: 'unreachable', authorize: 'unreachable', privilege: 'unreachable', gateway: 'unreachable', resource: 'unreachable' },
  reasons: Object.fromEntries(['person', 'agent', 'authorize', 'privilege', 'gateway', 'resource'].map((k) => [k, 'no log reader is configured: set RUN_OBS_ES_URL and RUN_OBS_ES_READ_APIKEY (a read-only Elasticsearch key; see the README), or RUN_OBS_DOCKER=1 with RUN_OBS_CONTAINERS for an ad-hoc run'])),
  summary: { allowed: 0, refused: 0, blocked: 0, info: 0, unverified: 0 },
};

// What a lab's API answers when the collection itself failed (Rule 23: structured JSON, never an HTML page).
export const errorRecord = { error: 'run_observability_failed', message: 'The run observability collector could not start: endedAt is before startedAt.' };
