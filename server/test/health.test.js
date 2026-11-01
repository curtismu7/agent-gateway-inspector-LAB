import test from 'node:test';
import assert from 'node:assert/strict';
import { allPassed, runChecks } from '../src/doctor.js';
import { AGENTS, RULES } from '../src/policy.js';

test('the doctor passes with defaults and fails for a bad port or bind, and never prints settings values', () => {
  const checks = runChecks({ env: {} });
  assert.ok(allPassed(checks));
  assert.deepEqual(checks.map((c) => c.id), ['mode', 'node', 'bind', 'port-range', 'policy', 'scope-layers', 'diagrams', 'outbound']);
  assert.ok(!allPassed(runChecks({ env: { PORT: '80' } })));
  assert.ok(!allPassed(runChecks({ env: { PORT: 'abc' } })));
  assert.match(checks.find((c) => c.id === 'policy').detail, new RegExp(`${Object.keys(AGENTS).length} agents.*${RULES.length} rules.*deny by default`));
});
