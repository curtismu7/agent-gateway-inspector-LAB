// The Mock/Live toggle: Live is refused. The page opens in mock whatever the settings ask for, the server says which guards fail,
// and the shared settings file gives this app one key and nothing else. A bare MODE is never read.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, startHttpServer } from '../src/app.js';
import { MODES, MODE_KEY, liveGuards, liveRefusal, modeFrom } from '../src/config.js';
import { allPassed, runChecks } from '../src/doctor.js';
import { createHealth } from '../src/health.js';
import { createRuntime } from '../src/runtime.js';
import { SETTINGS_KEYS, applySharedSettings, readSharedSettings, settingsPath } from '../src/settings.js';
import { freeBase, request } from './helpers.js';

async function boot(t, env) {
  const base = await freeBase('spare', 4);
  const rt = await createRuntime({ stubBase: base });
  const health = createHealth({ env });
  const port = base + 3;
  const server = createApp({ runtime: rt, health, env }).listen(port, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(async () => { health.stop(); server.closeAllConnections(); await new Promise((r) => server.close(r)); await rt.close(); });
  return port;
}
const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agi-settings-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

test('GET /api/info: the mode is mock, both modes are named, and Live is not available', async (t) => {
  const port = await boot(t, {});
  const res = await request(port, 'GET', '/api/info');
  assert.equal(res.status, 200);
  assert.equal(res.json.mode, 'mock');
  assert.equal(res.json.requested, 'mock');
  assert.deepEqual(res.json.modes, ['mock', 'live']);
  assert.equal(res.json.live.available, false);
  assert.ok(res.json.live.failed.includes('live-gateway') && res.json.live.failed.includes('owner-opt-in'));
  assert.equal(res.json.live.failed.length, res.json.live.needs.length);
});

test('a settings request for live is reported but not obeyed: the effective mode stays mock and every guard that fails is named', async (t) => {
  const port = await boot(t, { [MODE_KEY]: 'live' });
  const res = await request(port, 'GET', '/api/info');
  assert.equal(res.json.mode, 'mock');
  assert.equal(res.json.requested, 'live');
  assert.equal(res.json.live.available, false);
  assert.deepEqual(res.json.live.failed, ['live-gateway']);
});

test('every API answer that names a mode says mock, and there is no route that switches the server to live', async (t) => {
  const port = await boot(t, { [MODE_KEY]: 'live' });
  assert.equal((await request(port, 'POST', '/api/scenarios/benign/run')).json.mode, 'mock');
  assert.equal((await request(port, 'GET', '/api/calls')).json.mode, 'mock');
  assert.equal((await request(port, 'GET', '/api/audit/verify')).json.mode, 'mock');
  for (const m of ['POST', 'PUT', 'PATCH']) {
    const res = await request(port, m, '/api/mode', { body: { mode: 'live' } });
    assert.equal(res.status, 404, `${m} /api/mode`);
  }
  assert.equal((await request(port, 'POST', '/api/info', { body: { mode: 'live' } })).status, 404);
  assert.equal((await request(port, 'GET', '/api/info')).json.mode, 'mock');
});

test('the live guards: owner opt-in, loopback bind and a live gateway; the last one never passes, so live is refused whatever is set', () => {
  assert.deepEqual(liveGuards({}).map((g) => g.id), ['owner-opt-in', 'loopback-bind', 'live-gateway']);
  for (const env of [{}, { [MODE_KEY]: 'live' }, { [MODE_KEY]: 'live', GATEWAY_INSPECTOR_BIND: '127.0.0.1' }, { [MODE_KEY]: 'live', GATEWAY_INSPECTOR_BIND: '0.0.0.0' }]) {
    const r = liveRefusal(env);
    assert.ok(r, JSON.stringify(env));
    assert.ok(r.failed.includes('live-gateway'));
  }
  assert.equal(liveGuards({ [MODE_KEY]: 'live' }).find((g) => g.id === 'owner-opt-in').ok, true);
  assert.equal(liveGuards({}).find((g) => g.id === 'owner-opt-in').ok, false);
});

test('modeFrom: mock by default, live is a known value, anything else is an error and never a silent fallback; a bare MODE is ignored', () => {
  assert.deepEqual(MODES, ['mock', 'live']);
  assert.equal(modeFrom({}), 'mock');
  assert.equal(modeFrom({ [MODE_KEY]: '' }), 'mock');
  assert.equal(modeFrom({ [MODE_KEY]: 'live' }), 'live');
  for (const bad of ['Mock', 'demo', 'se-mock', 'local', 'live ', '1']) assert.throws(() => modeFrom({ [MODE_KEY]: bad }), /is not a mode/, bad);
  assert.equal(modeFrom({ MODE: 'live' }), 'mock', 'MODE is another app\'s variable');
  assert.equal(modeFrom({ MODE: 'se-mock' }), 'mock');
  assert.throws(() => modeFrom({ [MODE_KEY]: 'x\u0000\u001b[31m' }), (e) => !/[\u0000\u001b]/.test(e.message));
});

test('the doctor reports the mode first, passes with live requested (it is refused, not fatal), and fails on an unknown value', () => {
  const ok = runChecks({ env: {} });
  assert.equal(ok[0].id, 'mode');
  assert.equal(ok[0].level, 'pass');
  const live = runChecks({ env: { [MODE_KEY]: 'live' } });
  assert.equal(live[0].level, 'pass');
  assert.match(live[0].detail, /REFUSED/);
  assert.ok(allPassed(live));
  const bad = runChecks({ env: { [MODE_KEY]: 'hosted' } });
  assert.equal(bad[0].level, 'fail');
  assert.ok(!allPassed(bad));
  assert.equal(runChecks({ env: { MODE: 'se-mock' } })[0].level, 'pass', 'a bare MODE changes nothing');
});

test('the doctor says Node 26 is needed', () => {
  assert.match(runChecks({ env: {} }).find((c) => c.id === 'node').detail, /need >= 26/);
});

test('settings: one key is taken from the shared file, everything else in it is ignored, real env vars win, and STANDALONE_ENV picks the file', (t) => {
  assert.deepEqual(SETTINGS_KEYS, [MODE_KEY]);
  const dir = tmp(t);
  const file = path.join(dir, 'shared.env');
  fs.writeFileSync(file, `# another app's keys are in here too\nMODE=live\nPINGONE_CLIENT_SECRET=not-a-real-secret\nPORT=9999\n${MODE_KEY}=live\n`);
  assert.deepEqual(readSharedSettings(file), { [MODE_KEY]: 'live' });
  const env = { STANDALONE_ENV: file };
  assert.equal(settingsPath(env), file);
  applySharedSettings(env);
  assert.deepEqual(Object.keys(env).sort(), [MODE_KEY, 'STANDALONE_ENV'].sort(), 'nothing but the one key entered the environment');
  const env2 = { [MODE_KEY]: 'mock' };
  applySharedSettings(env2, file);
  assert.equal(env2[MODE_KEY], 'mock', 'a real environment variable wins');
});

test('settings: a missing, empty or unreadable file gives the defaults', (t) => {
  const dir = tmp(t);
  assert.deepEqual(readSharedSettings(path.join(dir, 'nope.env')), {});
  fs.writeFileSync(path.join(dir, 'empty.env'), '');
  assert.deepEqual(readSharedSettings(path.join(dir, 'empty.env')), {});
  fs.writeFileSync(path.join(dir, 'blank.env'), `${MODE_KEY}=\n`);
  assert.deepEqual(readSharedSettings(path.join(dir, 'blank.env')), {});
  assert.deepEqual(readSharedSettings(dir), {}, 'a directory is not a settings file');
  assert.match(settingsPath({}), /Development[\\/]\.env$/);
});

test('the server source never reads a bare MODE', () => {
  const src = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../src');
  for (const f of fs.readdirSync(src)) {
    const text = fs.readFileSync(path.join(src, f), 'utf8');
    assert.doesNotMatch(text, /process\.env\.MODE\b|env\.MODE\b|env\[['"]MODE['"]\]/, f);
  }
});

test('startHttpServer refuses to start on a bad mode value (so /api/info never has to show one)', async () => {
  const rt = await createRuntime({ stubBase: await freeBase('spare', 4) });
  let started = null;
  try {
    await assert.rejects(async () => { started = await startHttpServer({ port: 0, runtime: rt, env: { [MODE_KEY]: 'hosted' } }); }, /is not a mode/);
  } finally { if (started) await started.close(); else await rt.close(); }
});

test('the loopback-bind guard passes for any GATEWAY_INSPECTOR_BIND value, and its detail says so instead of claiming the server is bound to loopback', () => {
  const g = (env) => liveGuards(env).find((x) => x.id === 'loopback-bind');
  assert.equal(g({}).ok, true);
  assert.equal(g({ GATEWAY_INSPECTOR_BIND: '0.0.0.0' }).ok, true);
  assert.match(g({}).detail, /any value of GATEWAY_INSPECTOR_BIND passes this guard/);
});
