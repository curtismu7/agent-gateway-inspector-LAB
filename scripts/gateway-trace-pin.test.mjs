// Rule 25 pin: the "What Privilege did" files are vendored byte-for-byte from AI-DEMO-Standalone/shared/gateway-trace/ and never edited here.
// gateway-trace.sha256 holds the canonical hashes; an edited or stale copy fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = 'web/src/gateway-trace';
const WHERE = { 'GatewayTrace.jsx': WEB, 'gateway-trace.css': WEB, 'gateway-trace.test.jsx': WEB, 'gatewayTrace.js': 'server/src' };
const sha = (rel) => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex');
const pins = Object.fromEntries(fs.readFileSync(path.join(root, WEB, 'gateway-trace.sha256'), 'utf8').split('\n')
  .filter((l) => l && !l.startsWith('#')).map((l) => l.trim().split(/\s+/)).map(([h, f]) => [f, h]));

test('the pin file names exactly the four vendored files', () => {
  assert.deepEqual(Object.keys(pins).sort(), Object.keys(WHERE).sort());
});

for (const [file, dir] of Object.entries(WHERE)) {
  test(`${dir}/${file} matches gateway-trace.sha256 (vendored byte-for-byte, never hand-edited)`, () => {
    assert.match(pins[file], /^[0-9a-f]{64}$/);
    assert.equal(sha(`${dir}/${file}`), pins[file], `${file} differs from the pin: re-vendor it from AI-DEMO-Standalone/shared/gateway-trace/ and copy the pin file`);
  });
}

test('the lab builds its trace in its own file and does not reach into the vendored one', () => {
  const own = fs.readFileSync(path.join(root, 'server/src/callTrace.js'), 'utf8');
  assert.match(own, /from '\.\/gatewayTrace\.js'/);
  assert.match(fs.readFileSync(path.join(root, WEB, 'GatewayTrace.jsx'), 'utf8'), /from "\.\.\/components\/JsonPane"/);
});
