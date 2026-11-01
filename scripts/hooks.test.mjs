import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const hook = new URL('../.githooks/pre-commit', import.meta.url).pathname;

test('the pre-commit hook refuses the commit when gitleaks is missing, and does not promise a CI that does not exist', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'agi-nopath-'));
  try {
    const r = spawnSync('/bin/sh', [hook], { env: { PATH: empty }, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /gitleaks is not installed/);
    assert.doesNotMatch(r.stderr, /CI/);
  } finally { fs.rmSync(empty, { recursive: true, force: true }); }
});

test('the pre-commit hook hands the staged changes to gitleaks when it is installed', () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'agi-fakebin-'));
  try {
    fs.writeFileSync(path.join(bin, 'gitleaks'), '#!/bin/sh\necho "args:$*"\nexit 7\n', { mode: 0o755 });
    const r = spawnSync('/bin/sh', [hook], { env: { PATH: bin }, encoding: 'utf8' });
    assert.equal(r.status, 7, 'the hook exits with gitleaks\' status');
    assert.match(r.stdout, /args:protect --staged/);
  } finally { fs.rmSync(bin, { recursive: true, force: true }); }
});

test('engines.node is Node 26 only (rulebook, owner 2026-10-31), and .nvmrc says 26', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.engines.node, '>=26');
  assert.equal(fs.readFileSync(new URL('../.nvmrc', import.meta.url), 'utf8').trim(), '26');
});
