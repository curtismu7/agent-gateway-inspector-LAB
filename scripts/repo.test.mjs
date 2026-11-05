// Repo-level pins for the -LAB standard: files, README standard, CSS standard, CI, Node 26, no SE build, no bare MODE.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const WEB_FILES = ['App.jsx', 'components/AuditPanel.jsx', 'components/Badges.jsx', 'components/CallDetail.jsx', 'components/CallList.jsx', 'components/Flow.jsx', 'components/Story.jsx', 'components/Untrusted.jsx', 'lib/diagram.js'];

test('the files the standalone rules ask for are present', () => {
  for (const f of ['README.md', 'CLAUDE.md', 'LICENSE', 'Dockerfile', 'docker-compose.yml', '.dockerignore', '.nvmrc', '.env.example', '.gitignore', '.github/workflows/ci.yml', 'docs/talk-track.md', 'docs/safety.md', 'docs/content-pack.schema.json', 'docs/shelf-entry.json', 'content-pack.json', 'scripts/doctor.mjs', 'scripts/reset.mjs', 'scripts/smoke.mjs', 'web/src/styles/standalone-ui.css']) {
    assert.ok(fs.existsSync(path.join(root, f)), f);
  }
});

test('the Docker image copies the diagram files, and the diagram is data: Flow.jsx fetches it and builds no boxes', () => {
  assert.match(read('Dockerfile'), /^COPY server\/diagrams server\/diagrams$/m);
  for (const f of ['server/diagrams/gateway-flow.json', 'server/diagrams/gateway-flow-narrow.json']) assert.equal(JSON.parse(read(f)).schema, 'diagram-studio/1', f);
  const flow = read('web/src/components/Flow.jsx');
  assert.match(flow, /getDiagram\(DIAGRAM_NAMES/);
  assert.doesNotMatch(flow, /\bNODES\b|\bEDGES\b|\bLAYOUTS\b|position: \{ x: \d/);
});

test('package.json has the standard scripts and requires Node 26; the Dockerfile uses a Node 26 base', () => {
  const pkg = JSON.parse(read('package.json'));
  for (const s of ['start', 'dev', 'test', 'build', 'doctor', 'reset', 'prepare', 'smoke']) assert.ok(pkg.scripts[s], s);
  assert.equal(pkg.engines.node, '>=26');
  assert.ok((read('Dockerfile').match(/^FROM node:26-alpine/gm) || []).length === 2);
  assert.match(pkg.scripts.test, /node --test scripts\/\*\.test\.mjs/, 'the scripts tests run by glob, never a directory');
});

test('README follows the README standard: title ends in LAB, plain Tier, Repo and Catalog lines, the port text, the twelve sections in order; no internal names', () => {
  const r = read('README.md');
  assert.match(r.split('\n')[0], /^# .* LAB$/);
  assert.match(r, /^Tier: Tester$/m);
  assert.match(r, /^Repo: https:\/\/github\.com\/curtismu7\/agent-gateway-inspector-LAB$/m);
  assert.match(r, /^Catalog: D54$/m);
  const at = (h) => r.indexOf(`\n## ${h}`);
  const order = ['What is simulated', 'Run from a clone', 'Settings file', 'Ports, and what to do if the port is taken', 'Mock and live modes', 'Health, doctor and reset', 'Docker (optional)', 'Tests', 'Troubleshooting', 'Ownership'].map(at);
  assert.ok(order.every((i) => i > 0), order.join());
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'sections are in order');
  assert.match(r, /lsof -iTCP:5850 -sTCP:LISTEN -n -P/);
  assert.match(r, /PORT=<other port> npm start/);
  assert.match(r, /util\.parseEnv/);
  assert.doesNotMatch(r, /Rule 17 gap/, 'the diagram is diagram-studio data now');
  assert.match(r, /diagram-studio\/1 data in `server\/diagrams\/`/, 'the README says how the diagram is loaded');
  assert.ok(!/ping-devops|cmuir|curtismu/i.test(r));
  assert.ok(!/TEST_COUNTS_PLACEHOLDER/.test(r), 'the test counts are filled in');
});

test('app CSS follows the CSS standard: tokens only, no dark-mode media query, no forced priority, no italics, breakpoints 600 and 900 only, no purple, shared stylesheet first', () => {
  const css = read('web/src/app.css');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(css), 'no colour literal');
  assert.ok(!/prefers-color-scheme/.test(css)); assert.ok(!/!important/.test(css)); assert.ok(!/font-style:\s*italic/.test(css));
  const widths = [...css.matchAll(/@media \((?:max|min)-width: (\d+)px\)/g)].map((m) => m[1]);
  assert.ok(widths.every((w) => w === '600' || w === '900'), widths.join());
  assert.ok(!/purple|violet|magenta|indigo/i.test(css));
  const main = read('web/src/main.jsx');
  assert.ok(main.indexOf('standalone-ui.css') >= 0 && main.indexOf('standalone-ui.css') < main.indexOf('app.css'), 'the shared stylesheet loads before the app stylesheet');
  assert.ok(!/<em>|<i>/.test(WEB_FILES.map((f) => read(`web/src/${f}`)).join('\n')), 'no <em> or <i>: emphasis is weight');
});

test('the CI workflow is GitHub-hosted, Node 26 only, and carries the forbidden-strings and gitleaks jobs', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /runs-on: ubuntu-latest/);
  assert.ok(!/self-hosted/.test(ci));
  const versions = [...ci.matchAll(/node-version: (\S+)/g)].map((m) => m[1]);
  assert.ok(versions.length >= 3 && versions.every((v) => v === '26'), versions.join());
  assert.match(ci, /forbidden-strings:/);
  assert.match(ci, /gitleaks/);
  assert.match(ci, /actions\/checkout@v5/);
  assert.match(ci, /PORT=5865 npm run doctor/);
});

test('the repo ships no k8s manifests, no deploy scripts, no hosted mode, no workspace header and no bare MODE', () => {
  for (const d of ['k8s', 'deploy', 'server/src/workspaces.js']) assert.ok(!fs.existsSync(path.join(root, d)), d);
  const skip = new Set(['node_modules', 'dist', '.git', 'package-lock.json']);
  const hits = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      if (skip.has(name)) continue;
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (/\.(m?jsx?|json|ya?ml|html|css)$/.test(name) || name === 'Dockerfile') {
        const t = fs.readFileSync(p, 'utf8');
        if (/process\.env\.MODE\b|se-mock|SE_HOST|__IMAGE__|X-Workspace-Id|VITE_BASE_PATH/.test(t) && !/\.test\.m?jsx?$/.test(p)) hits.push(path.relative(root, p));
      }
    }
  };
  walk(root);
  assert.deepEqual(hits, []);
  for (const f of WEB_FILES) assert.ok(!/type="password"|process\.env\.MODE/.test(read(`web/src/${f}`)), f);
});

test('no shipped text names a real customer, company or tenant, and uses no retired wording', () => {
  const retired = new RegExp(`\\b${['do', 'or'].join('')}s?\\b`, 'i');
  const skip = new Set(['node_modules', 'dist', '.git', 'package-lock.json']);
  const hits = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      if (skip.has(name)) continue;
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (!/(repo|docs|content-pack|shelf-entry)\.test\.mjs$/.test(p)) {
        const t = fs.readFileSync(p, 'utf8');
        for (const w of ['united airlines', 'mileageplus', 'datapower', 'optum', 'unitedhealth', 'uhg', 'personal-agent', 'ping-devops', 'amazonaws.com']) if (t.toLowerCase().includes(w)) hits.push(`${path.relative(root, p)}: ${w}`);
        if (/\.(md|json)$/.test(name) && retired.test(t)) hits.push(`${path.relative(root, p)}: retired wording`);
      }
    }
  };
  walk(root);
  assert.deepEqual(hits, []);
});
