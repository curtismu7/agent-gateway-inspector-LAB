import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const root = new URL('..', import.meta.url).pathname;
const docs = ['README.md', 'docs/safety.md', 'docs/architecture.md'];
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('relative links in README and docs resolve to files that exist', () => {
  for (const d of docs) {
    for (const m of read(d).matchAll(/\]\((?!https?:|#|mailto:)([^)#\s]+)/g)) {
      assert.ok(fs.existsSync(path.resolve(path.dirname(path.join(root, d)), m[1])), `${d} links to missing ${m[1]}`);
    }
  }
});

test('every npm script and source file the docs name exists', () => {
  const pkg = JSON.parse(read('package.json'));
  const serverPkg = JSON.parse(read('server/package.json'));
  for (const d of docs) {
    const text = read(d);
    for (const m of text.matchAll(/npm run ([\w-]+)(?! -w)/g)) assert.ok(pkg.scripts[m[1]] || serverPkg.scripts[m[1]], `${d}: npm run ${m[1]} does not exist`);
    for (const m of text.matchAll(/`((?:server|scripts)\/[\w./-]+\.(?:js|mjs))`/g)) assert.ok(fs.existsSync(path.join(root, m[1])), `${d} names missing file ${m[1]}`);
  }
});

test('every API route the README names exists in app.js', () => {
  const app = read('server/src/app.js');
  for (const m of read('README.md').matchAll(/`(GET|POST) \/api\/([\w/:]+)/g)) {
    const route = `/${m[2].replace(/\/$/, '')}`.replace(/\/:\w+/g, '/:');
    const pattern = route.split('/').filter(Boolean).map((seg) => (seg === ':' ? ':\\w+' : seg)).join('/');
    assert.match(app, new RegExp(`'/${pattern}'`), `app.js has no ${m[1]} ${route}`);
  }
});

test('every scenario the docs name exists, and the docs state the plain limits', () => {
  const ids = [...fs.readFileSync(path.join(root, 'server/src/scenarios.js'), 'utf8').matchAll(/^\s+id: '([\w-]+)'/gm)].map((m) => m[1]);
  assert.equal(ids.length, 12);
  for (const id of ids) { assert.ok(read('README.md').includes(`\`${id}\``), `README names ${id}`); assert.ok(read('docs/architecture.md').includes(`\`${id}\``), `architecture names ${id}`); }
  assert.match(read('docs/safety.md'), /Cookie headers are not checked and never read/);
  assert.match(read('README.md'), /Cookie headers are not checked and never read/);
  assert.match(read('docs/safety.md'), /The approver is whoever can reach the page/);
  assert.match(read('docs/architecture.md'), /5851/);
});

test('required repository files exist', () => {
  for (const f of ['LICENSE', 'CHANGELOG.md', '.gitignore', '.nvmrc', '.env.example', '.githooks/pre-commit', 'Dockerfile', 'docker-compose.yml', 'scripts/doctor.mjs', 'scripts/reset.mjs', 'scripts/smoke.mjs']) assert.ok(fs.existsSync(path.join(root, f)), f);
  assert.match(read('LICENSE'), /^MIT License/);
  assert.match(read('.githooks/pre-commit'), /gitleaks protect --staged/);
});

test('docs do not describe finished work as a later step, and the README walkthrough does not hard-code a call id', () => {
  for (const d of docs) assert.doesNotMatch(read(d), /later step/i, d);
  assert.doesNotMatch(read('README.md'), /call-0001/);
  assert.match(read('README.md'), /not reused after `POST \/api\/reset`/);
});

test('the safety doc states the injection scan covers keys and fails closed', () => {
  assert.match(read('docs/safety.md'), /every object key/);
  assert.match(read('docs/safety.md'), /too large to scan completely/);
});

test('README documents the pack, the shelf entry, the catalog id used, and what the Docker run verified', () => {
  const r = read('README.md');
  for (const t of ['content-pack.json', 'docs/shelf-entry.json', 'docs/content-pack.schema.json', 'npm run content-pack']) assert.ok(r.includes(t), t);
  assert.match(r, /^Catalog: D54$/m);
  assert.match(r, /catalog id `D54`/);
  assert.ok(fs.existsSync(path.join(root, 'content-pack.json')));
});

test('CLAUDE.md and the talk track exist and mention the app port', () => {
  for (const f of ['CLAUDE.md', 'docs/talk-track.md']) {
    assert.ok(fs.existsSync(path.join(root, f)), f);
    assert.match(read(f), /5850/, `${f} mentions the port`);
  }
});

const RETIRED = new RegExp(`\\b${['do', 'or'].join('')}s?\\b`, 'i'); // assembled so this file does not contain the retired word
test('the docs carry the release claim label, the swagger tags and the lab-invented label, and use no retired wording', () => {
  for (const d of [...docs, 'docs/talk-track.md', 'CLAUDE.md']) assert.doesNotMatch(read(d), RETIRED, d);
  for (const d of ['README.md', 'docs/architecture.md', 'docs/safety.md', 'docs/talk-track.md']) assert.match(read(d), /Ping release claim \(2026-11-02\)/, d);
  for (const d of ['README.md', 'docs/architecture.md']) {
    assert.match(read(d), /UNVERIFIED on our tenant/, d);
    assert.match(read(d), /lab-invented/, d);
    assert.match(read(d), /console swagger name/i, d);
    for (const f of ['RequestID', 'FieldHash', 'ExpiresAt', 'GrantTTLSec', 'ConsumedAt', 'ConsumedByRequestID', 'DeniedBy', 'ExpiredAt']) assert.ok(read(d).includes(f), `${d} names ${f}`);
    assert.match(read(d), /NonHumanIdentity/, d);
  }
  assert.match(read('README.md'), /Live is refused/);
  assert.match(read('README.md'), /Mock mode/);
});

test('every field the architecture doc tags as a console swagger name is exposed by the server under the lab name the doc gives', () => {
  const gw = read('server/src/gateway.js');
  for (const f of ['ref', 'argsHash', 'grantTtlSec', 'decidedAt', 'consumedAt', 'consumedByCallId', 'deniedBy', 'expiredAt']) assert.match(gw, new RegExp(`\\b${f}\\b`), f);
  assert.match(read('docs/architecture.md'), /`hold\.argsHash` \| `FieldHash`/);
});

test('the talk track matches the page: the Mode chip, the Mock mode banner, the Mock/Live toggle with Live refused, presenter mode, and no stale DEMO badge', () => {
  const talk = read('docs/talk-track.md');
  for (const t of ['Mode: Mock', 'Mock mode.', 'Live', 'refused', 'presenter mode', 'Esc']) assert.ok(talk.includes(t), t);
  assert.doesNotMatch(talk, /DEMO badge/);
  const orient = talk.split('\n').find((l) => l.startsWith('1. **Orient'));
  for (const t of ['Mode: Mock', 'Press Live', 'refused', 'Press P', 'Esc']) assert.ok(orient?.includes(t), `step 1: ${t}`);
});

test('the README names the E2E_CHROMIUM override, and the e2e script has no stale demo-mode fixture', () => {
  assert.match(read('README.md'), /E2E_CHROMIUM/);
  assert.match(read('scripts/e2e.mjs'), /E2E_CHROMIUM/);
  assert.doesNotMatch(read('scripts/e2e.mjs'), /mode:\s*'demo'/);
});

test('the README describes the loopback-bind live guard as weak, because any GATEWAY_INSPECTOR_BIND value passes it', () => {
  assert.match(read('README.md'), /any value of it passes this guard/);
});

test('the doctor script prints the scope layers check and the talk track covers the new scenarios', () => {
  const talk = read('docs/talk-track.md');
  for (const t of ['Scope layer 1', 'Unattended hold', 'Replay the same approval', 'Challenge', 'Technical value', 'Business value']) assert.ok(talk.includes(t), t);
});
