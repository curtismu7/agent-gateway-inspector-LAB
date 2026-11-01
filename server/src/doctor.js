// Preflight checks shared by `npm run doctor` and GET /api/health. Synchronous, no network, never prints a secret.
// Each check: { id, level: 'pass' | 'info' | 'fail', detail }.
import { PORT_MAX, PORT_MIN, STUB_BASE_PORT, STUB_LAST_PORT, assertBindAllowed, bindHost, portInRange, serverPort } from './safety.js';
import { AGENTS, APPLICATIONS, END_USERS, RULES, TOKENS, TOOLS, registryProblems } from './policy.js';
import { DEFAULT_DIAGRAMS_DIR, DIAGRAM_NAMES, loadDiagrams } from './diagramData.js';
import { MODE_KEY, liveRefusal, modeFrom } from './config.js';

export function runChecks({ env = process.env, registry, diagramsDir = DEFAULT_DIAGRAMS_DIR } = {}) {
  const checks = [];
  const add = (id, level, detail) => checks.push({ id, level, detail });

  // The default mode the page opens in. Live is refused (see config.js), so a request for it is reported, not obeyed.
  try {
    const mode = modeFrom(env);
    const refusal = mode === 'live' ? liveRefusal(env) : null;
    add('mode', 'pass', refusal ? `${MODE_KEY}=live is requested and REFUSED (${refusal.failed.join(', ')}): the page opens in mock` : `${MODE_KEY}=${mode}${mode === 'mock' ? ' (default); live is refused: no live gateway path' : ''}`);
  } catch (e) { add('mode', 'fail', e.message); }

  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 26 ? 'pass' : 'fail', `v${process.versions.node} (need >= 26)`);

  try { add('bind', 'pass', `${assertBindAllowed(bindHost(env), env)}${env.GATEWAY_INSPECTOR_BIND ? ' (GATEWAY_INSPECTOR_BIND opt-in)' : ' (loopback)'}`); }
  catch (e) { add('bind', 'fail', e.message); }

  const port = serverPort(env);
  add('port-range', portInRange(port) ? 'pass' : 'fail', portInRange(port) ? `server port ${port}, stub upstreams ${STUB_BASE_PORT}-${STUB_LAST_PORT} (all within ${PORT_MIN}-${PORT_MAX})` : `server port ${port} is outside ${PORT_MIN}-${PORT_MAX}`);

  const scopes = new Set(Object.values(AGENTS).flatMap((a) => a.scopes));
  const orphan = Object.entries(TOOLS).filter(([, t]) => !scopes.has(t.scope)).map(([n]) => n);
  add('policy', RULES.length > 0 && orphan.length === 0 ? 'pass' : 'fail', `${Object.keys(AGENTS).length} agents, ${Object.keys(TOOLS).length} tools, ${RULES.length} rules, deny by default${orphan.length ? `; no agent holds the scope for ${orphan.join(', ')}` : ''}`);

  const layerProblems = registryProblems(registry);
  add('scope-layers', layerProblems.length ? 'fail' : 'pass', layerProblems.length ? layerProblems.join('; ') : `${Object.keys(TOKENS).length} tokens, ${Object.keys(APPLICATIONS).length} applications, ${Object.keys(END_USERS).length} end users: surface, application, action, end-user (Ping release claim 2026-11-02, UNVERIFIED on our tenant)`);

  try { loadDiagrams(diagramsDir); add('diagrams', 'pass', `${DIAGRAM_NAMES.length} diagram-studio/1 files (${DIAGRAM_NAMES.join(', ')}) load and validate`); }
  catch (e) { add('diagrams', 'fail', e.message); }

  add('outbound', 'pass', 'no outbound settings: the gateway forwards to 127.0.0.1 stub upstreams only, credentials are never accepted or sent');
  return checks;
}

export const allPassed = (checks) => checks.every((c) => c.level !== 'fail');
