// gateway-real/gatewayClient.js — the shared real Privilege-gateway hop for standalone labs.
//
// One dependency-free MCP-over-HTTP client plus a settings loader. Real mode in a lab means:
// an agent access key from the one shared settings file (~/Development/.env, or STANDALONE_ENV)
// calling a live Privilege MCP door (https://<gateway>/<app>/mcp). This is the wire that
// mcp-tools-LAB, aggregate-entitlement-LAB and privilege-logging-LAB measured live (2026-11).
//
// Rules carried over from the family's measured client:
// - redirects are never followed (never forward an auth header to a redirect target)
// - replies are capped in size and time
// - the agent key is write-only: it is scrubbed from every message, error and log line
// - a 404 mid-session restarts the session once (the spec's "session not found" signal)
//
// No dependencies. ESM. Node >= 22.

export const PROTOCOL_VERSION = '2025-06-18';
const MAX_BYTES = 4 * 1024 * 1024;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

const APP = /^[a-z0-9][a-z0-9-]{0,62}$/;
const NAME = /^[A-Z0-9][A-Z0-9_]{0,31}$/;

export function rpcError(message, code, extra = {}) {
  return Object.assign(new Error(String(message).slice(0, 300)), { code, ...extra });
}

// Messages in an SSE body: each event's data lines joined, parsed as JSON.
export function sseMessages(text) {
  const out = [];
  for (const ev of text.split(/\r?\n\r?\n/)) {
    const data = ev.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
    if (!data) continue;
    try { out.push(JSON.parse(data)); } catch { /* not JSON: ignore */ }
  }
  return out;
}

async function readReply(res, id) {
  const sse = /text\/event-stream/i.test(res.headers.get('content-type') || '');
  const reader = res.body?.getReader();
  if (!reader) return undefined;
  const dec = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > MAX_BYTES) throw rpcError(`reply larger than ${MAX_BYTES} bytes`, 'mcp_reply_too_large');
      text += dec.decode(value, { stream: true });
      if (sse && sseMessages(text).some((m) => m && m.id === id)) break; // a stream that stays open is not waited on
    }
  } finally { reader.cancel().catch(() => {}); }
  text = text.trim();
  if (!text) return undefined;
  if (sse) { const msgs = sseMessages(text); return msgs.find((m) => m && m.id === id) ?? msgs.at(-1); }
  try { return JSON.parse(text); } catch { throw rpcError('reply is not JSON', 'mcp_bad_reply'); }
}

export function createHttpClient({ url, getAuth, timeoutMs = 15_000, clientInfo = { name: 'standalone-lab', version: '0.1.0' } }) {
  const state = { sessionId: null, protocolVersion: null, initialized: false, pending: null, info: null };
  let msgId = 0;

  async function post(method, params, id) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    const auth = getAuth?.();
    if (auth) headers[auth[0]] = auth[1];
    if (state.sessionId) headers['Mcp-Session-Id'] = state.sessionId;
    if (method !== 'initialize') headers['MCP-Protocol-Version'] = state.protocolVersion || PROTOCOL_VERSION;
    let res;
    try {
      res = await fetch(url, {
        method: 'POST', headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify(id === undefined ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params }),
      });
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw rpcError(`MCP HTTP request timed out after ${timeoutMs}ms`, 'mcp_timeout');
      throw rpcError(`MCP HTTP request unreachable (${err?.cause?.code || err?.code || 'network error'})`, 'mcp_unreachable');
    }
    if (res.status >= 300 && res.status < 400) { res.body?.cancel().catch(() => {}); throw rpcError(`MCP HTTP ${res.status}: redirects are not followed`, 'mcp_http_error', { httpStatus: res.status }); }
    if (!res.ok) {
      const raw = (await res.text().catch(() => '')).slice(0, 2000);
      const body = raw.slice(0, 300);
      throw rpcError(`MCP HTTP ${res.status}${body ? `: ${body}` : ''}`, 'mcp_http_error', { httpStatus: res.status });
    }
    const sid = res.headers.get('mcp-session-id');
    if (sid) state.sessionId = sid;
    const json = id === undefined ? (res.body?.cancel().catch(() => {}), undefined) : await readReply(res, id);
    if (json?.error) throw rpcError(json.error.message || 'MCP JSON-RPC error', 'mcp_rpc_error', { mcpCode: json.error.code });
    return json?.result;
  }

  async function handshake() {
    const result = await post('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo }, ++msgId);
    state.protocolVersion = result?.protocolVersion || PROTOCOL_VERSION;
    state.info = { protocolVersion: state.protocolVersion, serverInfo: result?.serverInfo || null, capabilities: result?.capabilities || {} };
    await post('notifications/initialized', {});
    state.initialized = true;
  }
  const ensure = () => {
    if (state.initialized) return Promise.resolve();
    state.pending ||= handshake().finally(() => { state.pending = null; });
    return state.pending;
  };

  async function rpc(method, params = {}) {
    await ensure();
    try { return await post(method, params, ++msgId); } catch (err) {
      if (err.httpStatus === 404 && state.sessionId) {
        state.initialized = false; state.sessionId = null;
        await ensure();
        return post(method, params, ++msgId);
      }
      throw err;
    }
  }

  return {
    ensure, rpc,
    info: () => state.info,
    async close() {
      if (!state.sessionId) return;
      const headers = { 'Mcp-Session-Id': state.sessionId };
      const auth = getAuth?.();
      if (auth) headers[auth[0]] = auth[1];
      await fetch(url, { method: 'DELETE', headers, redirect: 'manual', signal: AbortSignal.timeout(3000) }).catch(() => {});
      state.sessionId = null; state.initialized = false;
    },
  };
}

// ---- Settings from the one shared settings file ---------------------------------------------------

export function readFileSettings(file, prefix) {
  const out = {};
  try {
    const re = new RegExp(`^${prefix}_GW_[A-Z0-9_]+=(.*)$`);
    for (const line of String(file ?? '').split('\n')) {
      const m = line.match(re);
      if (m) out[re.exec(line)[0].split('=')[0]] = m[1].trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* no file */ }
  return out;
}

// -> { ok:true, origin, apps, callers:[{id,label,key}], version } | { ok:false, problem }
export function doorConfig(text, prefix) {
  const s = { ...readFileSettings(text, prefix) };
  const notSet = `Set ${prefix}_GW_URL, ${prefix}_GW_APPS and at least one ${prefix}_GW_KEY_<NAME> in ~/Development/.env (or STANDALONE_ENV). Mock keeps working.`;
  if (!s[`${prefix}_GW_URL`]) return { ok: false, problem: `Real is not configured: no gateway URL. ${notSet}` };
  let url;
  try { url = new URL(s[`${prefix}_GW_URL`]); } catch { return { ok: false, problem: `Real is not configured: ${prefix}_GW_URL is not a URL. ${notSet}` }; }
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname)))) return { ok: false, problem: 'Real is not configured: the gateway URL must be https (http only on loopback).' };
  const apps = String(s[`${prefix}_GW_APPS`] || '').split(',').map((a) => a.trim()).filter(Boolean);
  if (!apps.length || apps.some((a) => !APP.test(a))) return { ok: false, problem: `Real is not configured: ${prefix}_GW_APPS must list door names (lowercase letters, digits, dashes), comma-separated. ${notSet}` };
  const callers = Object.entries(s).filter(([k]) => k.startsWith(`${prefix}_GW_KEY_`)).map(([k, key]) => ({ id: k.slice(`${prefix}_GW_KEY_`.length), key }))
    .filter((c) => NAME.test(c.id) && c.key && !/[\s\u0000-\u001f]/.test(c.key))
    .map((c) => ({ ...c, id: c.id.toLowerCase(), label: c.id.charAt(0) + c.id.slice(1).toLowerCase().replace(/_/g, ' ') }));
  if (!callers.length) return { ok: false, problem: `Real is not configured: no agent key. ${notSet}` };
  const version = /^[A-Za-z0-9._+-]{1,40}$/.test(s[`${prefix}_GW_VERSION`] || '') ? s[`${prefix}_GW_VERSION`] : null;
  return { ok: true, origin: url.origin, apps, callers, version };
}

// Scrub every key occurrence from a message (a key is never shown, logged or echoed).
export function scrub(text, keys) {
  let out = String(text ?? '');
  for (const k of keys) if (k) out = out.split(k).join('<redacted>');
  return out;
}

// Which layer a gateway refusal came from. Our reading of the gateway's words, not a field it sends.
export function readRefusal(err) {
  const msg = String(err?.message || '');
  if (err?.httpStatus === 401) return 'key';
  if (/refused by policy|blocked by policy|not allowed|forbidden|Access Denied/i.test(msg) || err?.httpStatus === 403) return 'policy';
  if (/failed to connect|unreachable|connection refused|timed out/i.test(msg)) return 'unreachable';
  if (/unknown tool|tool not found|no such tool/i.test(msg)) return 'unknown';
  return 'other';
}

// ---- The lab-facing API ---------------------------------------------------------------------------

// text = the full shared settings file contents. Each lab wires: read file -> doorConfig(text, 'XYZ').
export function createRealDoor({ config, client = createHttpClient, clientInfo } = {}) {
  if (!config?.ok) return null;
  const secrets = () => config.callers.map((c) => c.key);
  const refusal = (err) => ({ status: err?.httpStatus ?? null, message: scrub(err?.message || 'the gateway refused', secrets()).slice(0, 400), layer: readRefusal(err) });

  function open(app, callerId) {
    const c = config.callers.find((x) => x.id === callerId) ?? config.callers[0];
    return client({ url: `${config.origin}/${app}/mcp`, getAuth: () => ['Authorization', `Bearer ${c.key}`], clientInfo });
  }

  // One tools/list through the door. -> { ok, tools, ms } | { ok:false, refusal, ms }
  async function list(app, callerId) {
    const mcp = open(app, callerId);
    const started = Date.now();
    try {
      const r = await mcp.rpc('tools/list', {});
      const tools = (Array.isArray(r?.tools) ? r.tools : []).slice(0, 400).map((t) => ({ name: String(t?.name ?? '').slice(0, 160), description: String(t?.description ?? '').slice(0, 300) }));
      return { ok: true, tools: JSON.parse(scrub(JSON.stringify(tools), secrets())), ms: Date.now() - started, serverInfo: mcp.info()?.serverInfo ?? null };
    } catch (err) {
      return { ok: false, refusal: refusal(err), ms: Date.now() - started };
    } finally { await mcp.close().catch(() => {}); }
  }

  // One tools/call through the door. -> { ok, isError, text, ms } | { ok:false, refusal, ms }
  async function call(app, callerId, tool, args = {}) {
    const mcp = open(app, callerId);
    const started = Date.now();
    try {
      const r = await mcp.rpc('tools/call', { name: tool, arguments: args });
      const text = Array.isArray(r?.content) ? r.content.map((x) => (x?.type === 'text' ? x.text : `[${x?.type}]`)).join('\n') : '';
      return { ok: true, isError: r?.isError === true, text: scrub(text, secrets()).slice(0, 800), ms: Date.now() - started };
    } catch (err) {
      return { ok: false, refusal: refusal(err), ms: Date.now() - started };
    } finally { await mcp.close().catch(() => {}); }
  }

  return { origin: config.origin, apps: config.apps, callers: config.callers.map(({ id, label }) => ({ id, label })), version: config.version, list, call };
}

// Standard /api/info fields for a lab whose real mode is this hop.
export function rule19View(door, wantedMode) {
  return {
    source: wantedMode,
    realAvailable: Boolean(door),
    realReason: door ? null : 'Real needs the gateway settings (see the README): gateway URL, door names and an agent key in the shared settings file.',
  };
}
