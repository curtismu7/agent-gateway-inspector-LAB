#!/usr/bin/env node
// Source-level mutation run for the release-claim code (Ping release claim 2026-11-02, UNVERIFIED on our tenant).
// Each mutant changes one thing in a COPY of server/ (the working tree is never touched), the focused tests are run, and a
// mutant is "killed" when the test run exits non-zero. A mutant that survives the fast files also gets the port-using files.
// Exit 0 only when every mutant is killed. Not part of `npm test` (it starts many test runs):  node scripts/mutants.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAST = ['test/hold.test.js', 'test/scopelayers.test.js', 'test/policymutation.test.js'];
const SLOW = ['test/holdapi.test.js', 'test/gateway.test.js', 'test/scenarios.test.js', 'test/api.test.js', 'test/policy.test.js'];

const sub = (file, from, to) => ({ file, apply: (src) => { if (!src.includes(from)) throw new Error(`mutant anchor not found in ${file}: ${from.slice(0, 50)}`); return src.replace(from, to); } });
const MUTANTS = [
  ['drop the surface layer', sub('src/policy.js', "if (typeof where !== 'string' || !token.surfaces.includes(where)) return stop('surface', 'scope_surface');", '')],
  ['drop the application layer', sub('src/policy.js', "if (!app || !listMatches(app.tools, tool)) return stop('application', 'scope_application');", '')],
  ['drop the action layer', sub('src/policy.js', "if (!agent.scopes.includes(spec.scope)) return stop('action', 'scope_exceeded');", '')],
  ['drop the end-user layer', sub('src/policy.js', "if (!user || !user.scopes.includes(spec.scope)) return stop('endUser', 'scope_end_user');", '')],
  ['swap the surface and application layers', { file: 'src/policy.js', apply: (src) => {
    const s1 = "  if (typeof where !== 'string' || !token.surfaces.includes(where)) return stop('surface', 'scope_surface');\n  layers.surface = 'pass';\n";
    const s2 = "  const app = has(registry.applications, token.application) ? registry.applications[token.application] : null;\n  if (!app || !listMatches(app.tools, tool)) return stop('application', 'scope_application');\n  layers.application = 'pass';\n";
    if (!src.includes(s1 + s2)) throw new Error('mutant anchor not found: layer block');
    return src.replace(s1 + s2, s2 + s1);
  } }],
  ['rate limit checked before the layers', sub('src/policy.js', "  const wantToken =", "  if (rateExceeded) return out('deny', 'rate_limited', null, base);\n  const wantToken =")],
  ['token not required to belong to the agent', sub('src/policy.js', "&& registry.tokens[wantToken].agentId === agent.id", '')],
  ['evaluation error returns allow', sub('src/gateway.js', 'catch { verdict = null; }', "catch { verdict = { decision: 'allow', reason: 'rule_allow', ruleId: null, layers: notReached(), claims: null }; }")],
  ['a verdict that is not allow, deny or pause is trusted', sub('src/gateway.js', "const verdictOk = (v) => Boolean(v) && typeof v === 'object' && DECISIONS.includes(v.decision) && typeof v.reason === 'string';", 'const verdictOk = (v) => Boolean(v);')],
  ['remove consume-on-use', sub('src/gateway.js', "redeemed.hold.state = 'consumed'; ", '')],
  ['drop the argument-hash binding', sub('src/gateway.js', "if (hash !== h.argsHash) return { reason: 'approval_mismatch' };", '')],
  ['the hash ignores the token', sub('src/approval.js', 'canonical([agentId, tool, tokenId, args])', 'canonical([agentId, tool, args])')],
  ['the hash depends on key order', sub('src/approval.js', '.sort(byKey)', '')],
  ['remove the expiry sweep for holds', sub('src/gateway.js', 'waiting(c) && c.hold.expiresAtMs <= t', 'waiting(c) && false')],
  ['the grant window never starts', sub('src/gateway.js', 'c.hold.expiresAtMs = now() + grantTtlMs;', '')],
  ['hold keeps the connection open', sub('src/gateway.js', "c.outcome = 'held'; // returns now: no connection is kept open for the human", "c.outcome = 'held'; await new Promise((r) => { setTimeout(r, 2500); });")],
  ['approving a hold forwards the call', sub('src/gateway.js', "      touch(c);\n      audit.append('hold_approved'", "      touch(c);\n      await forwardCall(c, retryInputs.get(id).args);\n      audit.append('hold_approved'")],
  ['an approval applies to any verdict, not only a hold', sub('src/gateway.js', "if (verdict.decision === 'pause' && approvalRef !== undefined)", 'if (approvalRef !== undefined)')],
  ['a denied or locked hold can be redeemed', sub('src/gateway.js', "if (h.state !== 'approved') return { reason: 'approval_denied' };", '')],
  ['a hold that nobody answered can be redeemed', sub('src/gateway.js', "if (h.state === 'pending') return { reason: 'approval_pending' };", '')],
  ['attended and unattended are swapped', sub('src/gateway.js', 'verdict.claims?.attended === false', 'verdict.claims?.attended === true')],
  ['holds do not count against the waiting cap', sub('src/gateway.js', "(c.outcome === 'held' && (c.hold.state === 'pending' || c.hold.state === 'approved'))", 'false')],
  ['a waiting hold can be evicted from the ring', sub('src/gateway.js', 'find((c) => !waiting(c))', "find((c) => c.outcome !== 'pending')")],
  ['the retry route accepts a body', sub('src/app.js', "if (req.body && Object.keys(req.body).length) return bad(res, 'POST /api/calls/:id/retry takes no parameters');", '')],
  ['the retry route skips the call-id check', sub('src/app.js', "    if (!CALL_ID_RE.test(req.params.id)) return bad(res, 'malformed call id');\n    if (req.body && Object.keys(req.body).length) return bad(res, 'POST /api/calls/:id/retry", "    if (req.body && Object.keys(req.body).length) return bad(res, 'POST /api/calls/:id/retry")],
  ['the hold window is 1 ms', sub('src/policy.js', 'PAUSE_TTL_MS = 30_000', 'PAUSE_TTL_MS = 1')],
  ['the grant window is 1 ms', sub('src/policy.js', 'GRANT_TTL_MS = 60_000', 'GRANT_TTL_MS = 1')],
  ['the grant window is an hour', sub('src/policy.js', 'GRANT_TTL_MS = 60_000', 'GRANT_TTL_MS = 3_600_000')],
  ['the rate limit allows six', sub('src/policy.js', 'max: 5, windowMs', 'max: 6, windowMs')],
  ['the tool upstream is swapped', sub('src/policy.js', "'payments.transfer': Object.freeze({ upstream: 'payments'", "'payments.transfer': Object.freeze({ upstream: 'files'")],
  ['the claim holding the token id is named tokenId (the redactor hides it)', { file: 'src/policy.js', apply: (src) => src.replace('{ subject: wantToken,', '{ tokenId: wantToken,') }],
];

const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agi-mutants-'));
fs.cpSync(path.join(root, 'server'), path.join(tmp, 'server'), { recursive: true });
fs.symlinkSync(path.join(root, 'node_modules'), path.join(tmp, 'node_modules')); // a throwaway copy, never served
const run = (files) => spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=spec', ...files], { cwd: path.join(tmp, 'server'), encoding: 'utf8', env: { ...process.env, STANDALONE_ENV: '/nonexistent/none.env' }, timeout: 600_000 });
const failing = (r) => [...r.stdout.matchAll(/^✖ (.+?) \(\d/gm)].map((m) => m[1]).filter((v, i, a) => a.indexOf(v) === i).slice(0, 2); // for the report only; the verdict is the exit code

const base = run([...FAST, ...SLOW]);
if (base.status !== 0) { console.error(`the unmutated copy does not pass; fix that first (${failing(base).join(' | ') || `exit ${base.status}`})`); process.exit(2); }
let survived = 0;
const rows = [];
for (const [name, m] of MUTANTS) {
  if (only.length && !only.some((o) => name.includes(o))) continue;
  const file = path.join(tmp, 'server', m.file);
  const original = fs.readFileSync(path.join(root, 'server', m.file), 'utf8');
  const mutated = m.apply(original);
  if (mutated === original) throw new Error(`mutant changed nothing: ${name}`);
  fs.writeFileSync(file, mutated);
  let r = run(FAST);
  let where = 'fast';
  if (r.status === 0) { r = run(SLOW); where = 'slow'; }
  fs.writeFileSync(file, original);
  const killed = r.status !== 0;
  if (!killed) survived += 1;
  rows.push(`${killed ? 'KILLED  ' : 'SURVIVED'}  ${name}${killed ? `  <- ${failing(r).join(' | ') || `exit ${r.status} (${where})`}` : ''}`);
  console.log(rows[rows.length - 1]);
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${rows.length} mutants, ${rows.length - survived} killed, ${survived} survived`);
process.exit(survived ? 1 : 0);
