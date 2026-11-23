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
});

test('compose, the Dockerfile and .env.example never mount the Docker socket and pass no run-observability settings (nothing reads them)', () => {
  for (const f of ['docker-compose.yml', 'Dockerfile', '.env.example']) {
    const text = read(f);
    assert.ok(!/docker\.sock/.test(text), `${f}: no Docker socket mount`);
    assert.ok(!/RUN_OBS_/.test(text), `${f}: no reader settings in the container`);
  }
});
