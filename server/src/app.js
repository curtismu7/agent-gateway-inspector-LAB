// One Express app: the API under /api. createApp() is what the tests use.
// Every agent- and upstream-provided string in a response was made inert and redacted when it was stored,
// and is served as JSON only.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHealth } from './health.js';
import { DEFAULT_DIAGRAMS_DIR, diagramByName, loadDiagrams } from './diagramData.js';
import { MODES, liveRefusal, modeFrom } from './config.js';
import { createRuntime } from './runtime.js';
import { assertBindAllowed, bindHost, credentialGuard, hostGuard, makeOriginGuard, serverPort } from './safety.js';
import { SCENARIOS, describeScenario, getScenario } from './scenarios.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, message, status = 400) => res.status(status).json({ error: status === 404 ? 'not_found' : 'bad_request', message });
export const DEFAULT_WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
const API_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'", 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
// The built UI: same-origin scripts, styles, images and fetches only. (style-src allows inline styles: React Flow sets them.)
export const UI_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const ID_RE = /^[a-z0-9-]{1,40}$/;
const CALL_ID_RE = /^call-\d{4,9}$/;
const uint = (v, max = 1e9) => { if (v === undefined) return 0; if (!/^\d{1,10}$/.test(String(v))) return null; const n = Number(v); return n <= max ? n : null; };
const onlyKeys = (body, allowed) => !body || Object.keys(body).every((k) => allowed.includes(k));
const methods = (allow) => (_req, res) => res.set('Allow', allow).status(405).json({ error: 'method_not_allowed' });

// webDist: directory with the built UI (web/dist). null (the default here, so API tests never depend on a build) disables static
// serving; startHttpServer passes DEFAULT_WEB_DIST. A missing directory serves a JSON 404 at /.
// env: where the default mode comes from (GATEWAY_INSPECTOR_MODE). The mode is always mock: GET /api/info says so and says why live is refused.
// diagramsDir: the diagram-studio/1 files (server/diagrams). They are read and validated here, so a bad file stops the server from starting.
export function createApp({ runtime, health = createHealth(), webDist = null, env = process.env, diagramsDir = DEFAULT_DIAGRAMS_DIR } = {}) {
  const diagrams = loadDiagrams(diagramsDir);
  const app = express();
  app.disable('x-powered-by');
  app.use(hostGuard);
  app.use(credentialGuard); // every route, static files included
  app.use(makeOriginGuard());
  app.use((_req, res, next) => { res.set(API_HEADERS); next(); });
  if (webDist && fs.existsSync(path.join(webDist, 'index.html'))) {
    app.use(express.static(webDist, {
      index: 'index.html', dotfiles: 'ignore',
      setHeaders: (res) => res.set({ ...API_HEADERS, 'Content-Security-Policy': UI_CSP }),
    }));
  }

  const api = express.Router();
  api.use('/health', health.router);
  api.use(express.json({ limit: '2kb' }));
  api.use((req, _res, next) => { req.rt = runtime; next(); });

  // The Mock/Live toggle. The page opens in the default mode from the settings and the server says whether live can be selected.
  // It cannot: every guard in config.js must pass and the last one never does. There is no route that switches the server's mode:
  // it has one, mock. A bad mode value never gets this far: startHttpServer calls modeFrom first and refuses to start (createApp
  // used directly would fall back to mock here, and the doctor reports the bad value).
  api.get('/info', (_req, res) => {
    let requested = 'mock';
    try { requested = modeFrom(env); } catch { /* the doctor reports it */ }
    const refusal = liveRefusal(env);
    res.json({ mode: 'mock', requested, modes: MODES, live: refusal ? { available: false, ...refusal } : { available: true } });
  });

  // The flow diagram, as diagram-studio/1 data, by name. Only the names in the allow-list answer; anything else is a plain 404
  // that does not repeat what was asked for.
  api.get('/diagrams/:name', (req, res) => {
    const doc = diagramByName(diagrams, req.params.name);
    if (!doc) return bad(res, 'no such diagram', 404);
    res.json(doc);
  });

  api.get('/scenarios', (_req, res) => res.json({ scenarios: SCENARIOS.map(describeScenario) }));
  api.post('/scenarios/:id/run', wrap(async (req, res) => {
    if (!ID_RE.test(req.params.id) || !getScenario(req.params.id)) return bad(res, 'no such scenario', 404);
    // The only accepted field is hold (leave a paused call pending). Credentials, targets and calls are never accepted.
    if (!onlyKeys(req.body, ['hold']) || (req.body?.hold !== undefined && typeof req.body.hold !== 'boolean')) return bad(res, 'the only accepted body field is { "hold": true|false }');
    let result;
    try { result = await req.rt.runScenario(req.params.id, { hold: req.body?.hold === true }); } catch (e) {
      if (e?.code === 'scenario_queue_full') return res.set('Retry-After', '2').status(429).json({ error: 'scenario_queue_full', message: 'a scenario is running and another is already queued; try again shortly' });
      throw e;
    }
    res.json({ mode: req.rt.mode, ...result });
  }));

  api.get('/calls', (req, res) => {
    const since = uint(req.query.since); const limit = uint(req.query.limit ?? '200', 200);
    if (since === null || limit === null || limit < 1) return bad(res, 'since and limit must be small non-negative integers');
    res.json({ mode: req.rt.mode, ...req.rt.gateway.list({ since, limit }), stats: req.rt.gateway.stats() });
  });
  api.get('/calls/:id', (req, res) => {
    if (!CALL_ID_RE.test(req.params.id)) return bad(res, 'malformed call id');
    const call = req.rt.gateway.get(req.params.id);
    if (!call) return bad(res, 'no such call', 404);
    res.json({ mode: req.rt.mode, call });
  });
  api.post('/calls/:id/decision', wrap(async (req, res) => {
    if (!CALL_ID_RE.test(req.params.id)) return bad(res, 'malformed call id');
    const b = req.body;
    if (!b || !onlyKeys(b, ['decision', 'approvalCode']) || typeof b.decision !== 'string' || typeof b.approvalCode !== 'string' || b.approvalCode.length > 64) {
      return bad(res, 'body must be { "decision": "approve"|"deny", "approvalCode": "<code from the call>" }');
    }
    const r = await req.rt.gateway.decide(req.params.id, b);
    if (r.status === 200) return res.json({ mode: req.rt.mode, call: r.call });
    res.status(r.status).json({ error: r.error, ...(r.call ? { call: r.call } : {}) });
  }));

  // The simulated agent retries a held call with its approval reference (a lab step: a real agent would call the gateway again).
  // No body: the retry is the original call exactly as it was first sent, so nothing in it can be changed from here.
  api.post('/calls/:id/retry', wrap(async (req, res) => {
    if (!CALL_ID_RE.test(req.params.id)) return bad(res, 'malformed call id');
    if (req.body && Object.keys(req.body).length) return bad(res, 'POST /api/calls/:id/retry takes no parameters');
    const r = await req.rt.gateway.retry(req.params.id);
    if (r.status === 200) return res.json({ mode: req.rt.mode, call: r.call });
    res.status(r.status).json({ error: r.error });
  }));

  // The audit trail is read-only through the API: GET only. Nothing here can add, change or remove an entry.
  api.route('/audit').get((req, res) => {
    const after = uint(req.query.after); const limit = uint(req.query.limit ?? '200', 500);
    if (after === null || limit === null || limit < 1) return bad(res, 'after and limit must be small non-negative integers');
    res.json({ mode: req.rt.mode, entries: req.rt.gateway.audit.list({ after, limit }), headSeq: req.rt.gateway.audit.headSeq, size: req.rt.gateway.audit.size });
  }).all(methods('GET'));
  api.route('/audit/verify').get((req, res) => res.json({ mode: req.rt.mode, ...req.rt.gateway.audit.verify() })).all(methods('GET'));

  api.post('/reset', (req, res) => {
    if (req.body && Object.keys(req.body).length) return bad(res, 'POST /api/reset takes no parameters');
    req.rt.reset();
    res.json({ ok: true, mode: req.rt.mode });
  });

  api.use((_req, res) => bad(res, 'no such endpoint', 404));
  api.use((err, _req, res, _next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large', message: 'request body is too large' });
    if (err.type === 'entity.parse.failed') return bad(res, 'request body is not valid JSON');
    if (err instanceof URIError || err.status === 400) return bad(res, 'malformed request');
    console.error('[agent-gateway-inspector] api error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  });
  app.use('/api', api);
  app.use((_req, res) => bad(res, 'no such endpoint', 404));
  app.use((err, _req, res, _next) => (err instanceof URIError || err.status === 400 ? bad(res, 'malformed request') : res.status(500).json({ error: 'server_error' })));
  return app;
}

// Boot on `port`. Refuses a non-loopback host unless GATEWAY_INSPECTOR_BIND is set.
export async function startHttpServer({ port = serverPort(), host = bindHost(), env = process.env, runtime, webDist = DEFAULT_WEB_DIST, diagramsDir = DEFAULT_DIAGRAMS_DIR } = {}) {
  modeFrom(env);
  assertBindAllowed(host, env);
  loadDiagrams(diagramsDir); // a bad diagram file refuses the start, before anything is opened
  const rt = runtime || await createRuntime();
  const health = createHealth({ env });
  return new Promise((resolve, reject) => {
    const httpServer = createApp({ runtime: rt, health, webDist, env, diagramsDir }).listen(port, host);
    httpServer.once('error', async (e) => { health.stop(); await rt.close(); reject(e); });
    httpServer.once('listening', () => {
      const { port: bound } = httpServer.address();
      resolve({
        port: bound, runtime: rt,
        url: `http://127.0.0.1:${bound}/`,
        close: async () => { health.stop(); await new Promise((r) => { httpServer.closeAllConnections?.(); httpServer.close(r); }); await rt.close(); },
      });
    });
  });
}
