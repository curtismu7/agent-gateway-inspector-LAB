import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { shelfProblems } from './lib/shelf-registry-rules.mjs';

const read = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
const entry = JSON.parse(read('../docs/shelf-entry.json'));

test('docs/shelf-entry.json passes the shelf registry rules (copied into scripts/lib/shelf-registry-rules.mjs)', () => {
  assert.deepEqual(shelfProblems(entry.demos), []);
});

test('the entry matches this app: id, catalog id D54, port 5850, /api/health, a relative compose file', () => {
  const [d] = entry.demos;
  assert.equal(d.id, 'agent-gateway-inspector');
  assert.equal(d.catalogId, 'D54');
  assert.equal(d.kind, 'Tester');
  assert.equal(d.composeFile, 'agent-gateway-inspector-LAB/docker-compose.yml');
  assert.ok(!path.isAbsolute(d.composeFile), 'composeFile must be relative or a placeholder');
  assert.ok(!/\/Users\//.test(JSON.stringify(entry)), 'no absolute home path');
  assert.equal(d.url, 'http://localhost:5850');
  assert.equal(d.healthPath, '/api/health');
  assert.match(d.composeFile, /\/docker-compose\.yml$/);
  const pkg = JSON.parse(read('../package.json'));
  assert.ok(pkg.scripts.start && pkg.scripts.doctor);
  assert.match(read('../docker-compose.yml'), /127\.0\.0\.1:\$\{HOST_PORT:-5850\}:5850/);
});

test('the copied rules reject a bad entry', () => {
  const bad = [{ ...entry.demos[0], url: 'http://evil.example:5850', healthPath: '//x', composeFile: '../x;y.yml', surprise: 1 }];
  assert.ok(shelfProblems(bad).length >= 4);
});
