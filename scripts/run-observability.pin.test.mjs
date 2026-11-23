// Rule 27: the vendored shared/run-observability files match web/src/run-observability/run-observability.sha256 byte for byte.
// They come from curtismu7/AI-DEMO-Standalone shared/run-observability: change them there, re-pin, re-vendor; never edit them here.
// This lab reads no logs (Mock rows are the stub's own, Real rows are the replies of one gateway check), so it vendors the core only
// (no server/src/runObservabilityReaders.js); checkPin skips that pin line.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPin } from './run-observability-checkPin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('every vendored run-observability file matches its pin, and the core is present', () => {
  assert.deepEqual(checkPin(root), []);
});

test('this lab reads no logs: no readers file, and nothing in the server names a reader, a run-observability setting or a log source, comments included', () => {
  assert.ok(!fs.existsSync(path.join(root, 'server/src/runObservabilityReaders.js')));
  const core = read('server/src/runObservability.js');
  assert.ok(!/^\s*import\s/m.test(core), 'the core has no imports');
  assert.ok(!/ElasticsearchReader|DockerLogReader|readersFromEnv|\bfetch\s*\(|node:http|node:fs/.test(core), 'the core names no reader, no network and no file access, not even in a comment');
  const files = fs.readdirSync(path.join(root, 'server/src')).filter((f) => f.endsWith('.js') && f !== 'runObservability.js');
  assert.ok(files.includes('runObs.js'));
  for (const f of files) assert.ok(!/ElasticsearchReader|DockerLogReader|readersFromEnv|RUN_OBS_|docker\.sock/.test(read(`server/src/${f}`)), `${f} names no reader, no RUN_OBS_ setting and no Docker socket`);
  // The page code outside the vendored folder carries no RUN_OBS_ name either (a JS constant with that prefix reads like a setting).
  const walk = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) return rel === 'web/src/run-observability' ? [] : walk(rel);
    return /\.(jsx?|mjs)$/.test(e.name) ? [rel] : [];
  });
  for (const f of walk('web/src')) assert.ok(!/RUN_OBS_/.test(read(f)), `${f} carries no RUN_OBS_ name`);
});

test('compose, the Dockerfile and .env.example never mount the Docker socket and pass no run-observability settings (nothing reads them)', () => {
  for (const f of ['docker-compose.yml', 'Dockerfile', '.env.example']) {
    const text = read(f);
    assert.ok(!/docker\.sock/.test(text), `${f}: no Docker socket mount`);
    assert.ok(!/RUN_OBS_/.test(text), `${f}: no reader settings in the container`);
  }
});

test('the README says what the panel does not verify or back-date: the no-reply reading, the late expiry, the outcome table and what Reset keeps', () => {
  const readme = read('README.md');
  assert.match(readme, /\*\*Not verified:\*\* the shared hop `gatewayReal\.js` keeps only an error's status and message and drops its error code/);
  assert.match(readme, /would be read the same way, as "read as no connection", never as a pass/);
  assert.match(readme, /the `blocked` row's time is when it noticed, the same time as its stdout line, and is never back-dated/);
  assert.match(readme, /A lapsed approval is `refused` when it is presented on a retry .* and `blocked` when the wait itself ran out/);
  assert.match(readme, /The panel's counts are check rows, not calls/);
  assert.match(readme, /\*\*Reset\*\* forgets the scenario runs .* keeps Real gateway checks/);
  assert.match(readme, /any other method is a 405 with `Allow: GET`/);
});
