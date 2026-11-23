// One Express app: the API under /api. createApp() is what the tests use.
// Every agent- and upstream-provided string in a response was made inert and redacted when it was stored,
// and is served as JSON only.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHealth } from './health.js';
import { allPassed, runChecks as defaultChecks } from './doctor.js';
import { DEFAULT_DIAGRAMS_DIR, diagramByName, loadDiagrams } from './diagramData.js';
import { MODES, liveRefusal, modeFrom } from './config.js';
import { RunObsError } from './runObservability.js';
import { stdoutLine } from './runObs.js';

// The reason the Mock/Real toggle gives for Real when the gateway settings are absent.
export const LIVE_REFUSAL = 'Real is not configured: set AGI_GW_URL, AGI_GW_APPS and at least one AGI_GW_KEY_<NAME> in the shared settings file (~/Development/.env, or STANDALONE_ENV). Mock keeps working.';
// Real mode reads the one shared settings file for the gateway-hop keys this app allows (prefix AGI_).
// The agent key is write-only: gatewayReal scrubs it from every message and error.
import fsReal from 'node:fs';
import { readFileSettings, doorConfig, createRealDoor } from './gatewayReal.js';
export function realDoorFrom(env = process.env) {
  const p = env.STANDALONE_ENV || `${env.HOME || ''}/Development/.env`;
  let text = '';
  try { text = fsReal.readFileSync(p, 'utf8'); } catch { /* no file: the environment may still carry the keys */ }
  // The environment wins over the file (the family rule), so overlay the AGI_* variables on the parsed text.
  for (const [k, v] of Object.entries(env)) if (k.startsWith('AGI_GW_') && v) text += `\n${k}=${v}`;
  const cfg = doorConfig(text, 'AGI');
  return cfg.ok ? createRealDoor({ config: cfg, clientInfo: { name: 'agent-gateway-inspector', version: '0.2.0' } }) : null;
}
import { createRuntime } from './runtime.js';
import { assertBindAllowed, bindHost, credentialGuard, makeHostGuard, makeOriginGuard, parseAllowedHosts, serverPort } from './safety.js';
import { SCENARIOS, describeScenario, getScenario } from './scenarios.js';
import { shelfInfo } from './shelfLink.js';

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
export function createApp({ runtime, health, webDist = null, env = process.env, diagramsDir = DEFAULT_DIAGRAMS_DIR, allowedHosts = parseAllowedHosts(env), port = serverPort(env) } = {}) {
  // The default health is built after env is bound (its doctor reads the environment); a caller-provided one wins.
  health ||= createHealth({ demoId: 'agent-gateway-inspector', demoName: 'Agent Gateway Inspector LAB', version: '0.2.0', runChecks: (a) => defaultChecks(a), allPassed, env });
  const diagrams = loadDiagrams(diagramsDir);
  const app = express();
  app.disable('x-powered-by');
  app.use(makeHostGuard({ allowed: allowedHosts, port }));
  app.use(credentialGuard); // every route, static files included
  app.use(makeOriginGuard({ allowed: allowedHosts, port }));
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
    // Rule 19: what the Mock/Real toggle needs. Real is the shared gateway hop: an agent key from the
    // shared settings file calling a live Privilege MCP door. Available only when the settings are usable.
    const door = realDoorFrom(env);
    let version = null;
    try { version = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || null; } catch { /* no version */ }
    res.json({
      mode: 'mock', source: 'mock', requested, modes: MODES, live: refusal ? { available: false, ...refusal } : { available: true },
      realAvailable: Boolean(door), realReason: door ? null : LIVE_REFUSAL, version,
    });
  });

  // Rule 19: the runtime mode is server-side. Switching to Real stores the door; the gateway checks run against it.
  let realDoor = null;
  api.post('/mode', (req, res) => {
    const next = req.body?.source;
    if (next !== 'mock' && next !== 'real') return bad(res, 'source must be exactly "mock" or "real"');
    if (next === 'real') {
      realDoor = realDoorFrom(env);
      if (!realDoor) return res.status(409).json({ error: 'real_not_available', source: 'mock', realAvailable: false, realReason: LIVE_REFUSAL, message: LIVE_REFUSAL });
      return res.json({ source: 'real', realAvailable: true, realReason: null, doors: realDoor.apps, gateway: realDoor.origin });
    }
    realDoor = null;
    return res.json({ source: 'mock', realAvailable: Boolean(realDoorFrom(env)), realReason: null, message: 'Back in mock: every call runs through the in-process stub gateway again.' });
  });

  // One real gateway check: tools/list through the door with the agent key, then the refusal shape for a
  // tool the key's policy does not grant. The gateway's own words come back unaltered (keys scrubbed).
  api.post('/gateway-check', wrap(async (req, res) => {
    if (!realDoor) return res.status(409).json({ error: 'real_not_available', realReason: LIVE_REFUSAL });
    if (!onlyKeys(req.body, ['app', 'caller'])) return bad(res, 'the only accepted body fields are { "app", "caller" }');
    const app = String(req.body?.app || realDoor.apps[0]);
    if (!realDoor.apps.includes(app)) return bad(res, `app must be one of ${realDoor.apps.join(', ')}`);
    const caller = req.body?.caller && realDoor.callers.some((c) => c.id === req.body.caller) ? req.body.caller : realDoor.callers[0].id;
    const log = req.rt.runLog; // rule 27: each reply the lab received is stamped once and recorded as one Real run
    const startedAt = log.stamp();
    const listing = await realDoor.list(app, caller);
    const listedAt = log.stamp();
    const out = { app, caller, gateway: realDoor.origin, ...(realDoor.version ? { version: realDoor.version } : {}), listing };
    let probedAt;
    if (listing.ok) {
      // The refusal probe: a tool name nothing grants. The gateway's refusal layer is the evidence.
      out.refusal = await realDoor.call(app, caller, 'gateway_inspector_refusal_probe_tool', {});
      probedAt = log.stamp();
    }
    log.recordGatewayCheck({ app, caller, startedAt, listing, listedAt, probe: out.refusal, probedAt });
    res.json(out);
  }));

  // Rule 27: the record of ONE run, in the CURRENT mode only (a run made in the other mode is never returned): the run named by ?runId, else the
  // newest. Mock runs are scenario runs; Real runs are gateway checks (scenarios run through the stub in every mode, so they are never Real).
  const NO_RUN = { mock: 'No run yet: pick a scenario and press Run.', real: 'No gateway check yet in Real mode. Scenarios always run through the in-process stub, so their record is shown in Mock mode.' };
  const runQuery = (req, res) => {
    const asked = req.query.runId;
    if (asked === undefined || (typeof asked === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(asked))) return { asked };
    bad(res, 'runId must be 1 to 64 characters from A-Z a-z 0-9 . _ -');
    return null;
  };
  // A cheap answer the page polls: it changes when the run gets a row, so the record is only built again then.
  api.route('/run-observability/head').get((req, res) => {
    const q = runQuery(req, res);
    if (!q) return undefined;
    const source = realDoor ? 'real' : 'mock';
    return res.json({ source, ...(req.rt.runLog.head(source, q.asked) ?? { runId: null }) });
  }).all(methods('GET'));
  api.route('/run-observability').get(wrap(async (req, res) => {
    const q = runQuery(req, res);
    if (!q) return undefined;
    const source = realDoor ? 'real' : 'mock';
    let run;
    try { run = await req.rt.runLog.record(source, q.asked); } catch (e) {
      if (e instanceof RunObsError) return res.status(e.status).json({ error: e.code, message: e.message });
      throw e;
    }
    if (!run) return res.json({ source, record: null, message: q.asked === undefined ? NO_RUN[source] : `No run with that id in ${source} mode: it was made in the other mode, never started, or is no longer kept.` });
    return res.json({ source, ...run });
  })).all(methods('GET'));

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
  app.get('/api/shelf', (_req, res) => { res.set('Cache-Control', 'no-store'); res.json(shelfInfo()); }); // the header "Shelf" button
  app.use('/api', api);
  app.use((_req, res) => bad(res, 'no such endpoint', 404));
  app.use((err, _req, res, _next) => (err instanceof URIError || err.status === 400 ? bad(res, 'malformed request') : res.status(500).json({ error: 'server_error' })));
  return app;
}

// Boot on `port`. Refuses a non-loopback host unless GATEWAY_INSPECTOR_BIND is set.
export async function startHttpServer({ port = serverPort(), host = bindHost(), env = process.env, runtime, webDist = DEFAULT_WEB_DIST, diagramsDir = DEFAULT_DIAGRAMS_DIR } = {}) {
  modeFrom(env);
  const allowedHosts = parseAllowedHosts(env); // the lab-proxy's names; before any server or timer starts
  assertBindAllowed(host, env);
  loadDiagrams(diagramsDir); // a bad diagram file refuses the start, before anything is opened
  const rt = runtime || await createRuntime({ log: stdoutLine }); // the boot path writes the decision log (rule 27) to stdout
  const health = createHealth({ demoId: 'agent-gateway-inspector', demoName: 'Agent Gateway Inspector LAB', version: '0.2.0', runChecks: defaultChecks, allPassed, env });
  return new Promise((resolve, reject) => {
    const httpServer = createApp({ runtime: rt, health, webDist, env, diagramsDir, allowedHosts, port }).listen(port, host);
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
