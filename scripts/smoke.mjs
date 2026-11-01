#!/usr/bin/env node
// The minimum end-to-end check against a RUNNING app (npm start, or the Docker container): health, the mode, one scenario run,
// the audit chain, and that Live is not on offer. Prints one line per check and exits 1 on the first failure. Loopback only.
//   node scripts/smoke.mjs [base-url]      (default http://127.0.0.1:${PORT:-5850})
import { isLoopbackHost } from '../server/src/safety.js';

const base = new URL(process.argv[2] || `http://127.0.0.1:${process.env.PORT || 5850}`);
if (!isLoopbackHost(base.hostname)) { console.error(`refusing ${base.hostname}: loopback only`); process.exit(1); }
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failed += 1; };
const get = async (p) => { const r = await fetch(new URL(p, base)); return { status: r.status, json: await r.json() }; };
const post = async (p, body) => { const r = await fetch(new URL(p, base), { method: 'POST', headers: { 'content-type': 'application/json', origin: base.origin }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };

try {
  const h = await get('/api/health');
  check(h.status === 200 && h.json.schema === 'demo-health/1' && h.json.state === 'ready', 'GET /api/health is demo-health/1 and ready');
  const i = await get('/api/info');
  check(i.status === 200 && i.json.mode === 'mock' && i.json.live?.available === false, 'GET /api/info: the mode is mock and Live is refused');
  const r = await post('/api/scenarios/benign/run', {});
  check(r.status === 200 && r.json.mode === 'mock' && r.json.matched === true, 'POST /api/scenarios/benign/run: allowed and forwarded, as expected');
  const v = await get('/api/audit/verify');
  check(v.status === 200 && v.json.ok === true, 'GET /api/audit/verify: the chain verifies');
  const z = await post('/api/reset', {});
  check(z.status === 200 && z.json.ok === true, 'POST /api/reset: ok');
} catch (e) { check(false, `the app did not answer at ${base.origin}: ${e.message}`); }
process.exit(failed ? 1 : 0);
