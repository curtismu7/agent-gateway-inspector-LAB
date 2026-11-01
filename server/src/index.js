import { startHttpServer } from './app.js';
import { allPassed, runChecks } from './doctor.js';
import { applySharedSettings } from './settings.js';

// The shared settings file (~/Development/.env, or STANDALONE_ENV) supplies the one key this app takes; real env vars win.
applySharedSettings();

const checks = runChecks();
if (!allPassed(checks)) {
  for (const c of checks.filter((x) => x.level === 'fail')) console.error(`[agent-gateway-inspector] refusing to start: ${c.id}: ${c.detail}`);
  process.exit(1);
}
const { url, runtime } = await startHttpServer();
console.log(`[agent-gateway-inspector] mock mode (live is refused) at ${url} (loopback unless GATEWAY_INSPECTOR_BIND is set)`);
console.log(`[agent-gateway-inspector] API: GET ${url}api/health | GET ${url}api/info | GET ${url}api/scenarios | POST ${url}api/scenarios/:id/run | GET ${url}api/calls | GET ${url}api/audit/verify`);
console.log(`[agent-gateway-inspector] stub upstreams on 127.0.0.1:${[...runtime.upstreams.ports.values()].join(', ')}`);
