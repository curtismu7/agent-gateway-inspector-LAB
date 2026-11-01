// Node runs test files in parallel processes. Port slices are only 4 ports wide (5880-5899 holds five), so two files
// may share a slice. That is safe only when the server suite runs its files one at a time.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(dir, '..', 'package.json'), 'utf8'));

test('a port slice shared by two test files requires the server suite to run its files serially', () => {
  const owners = {};
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.test.js'))) {
    const src = fs.readFileSync(path.join(dir, name), 'utf8');
    for (const m of src.matchAll(/freeBase\('([a-z]+)'/g)) (owners[m[1]] ??= new Set()).add(name);
  }
  assert.ok(Object.keys(owners).length >= 5, 'the slice scan found the test files');
  const shared = Object.entries(owners).filter(([, files]) => files.size > 1);
  assert.ok(shared.length === 0 || pkg.scripts.test.includes('--test-concurrency=1'), `shared slices ${shared.map(([s, f]) => `${s}: ${[...f].join(', ')}`).join('; ')} need --test-concurrency=1 in the test script`);
});
