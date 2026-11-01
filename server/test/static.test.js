import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, UI_CSP } from '../src/app.js';
import { createHealth } from '../src/health.js';
import { createRuntime } from '../src/runtime.js';
import { freeBase, request } from './helpers.js';

// Uses the 'static' slice (5861-5864): three stub upstreams plus the app.
async function boot(t, webDist) {
  const base = await freeBase('static', 4);
  const rt = await createRuntime({ stubBase: base });
  const health = createHealth();
  const port = base + 3;
  const server = createApp({ runtime: rt, health, webDist }).listen(port, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(async () => { health.stop(); server.closeAllConnections(); await new Promise((r) => server.close(r)); await rt.close(); });
  return port;
}

test('the built UI is served by the server itself with a same-origin CSP; the Host guard still applies', async (t) => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'agi-dist-'));
  t.after(() => fs.rmSync(dist, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>ui</title>');
  fs.mkdirSync(path.join(dist, 'assets'));
  fs.writeFileSync(path.join(dist, 'assets', 'a.js'), 'console.log(1)');
  fs.writeFileSync(path.join(dist, '.secret'), 'x');
  const port = await boot(t, dist);
  const root = await request(port, 'GET', '/');
  assert.equal(root.status, 200);
  assert.match(root.headers['content-type'], /text\/html/);
  const csp = root.headers['content-security-policy'];
  assert.equal(csp, UI_CSP);
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /connect-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-eval|script-src[^;]*unsafe-inline|https?:|\*/);
  assert.equal(root.headers['x-content-type-options'], 'nosniff');
  assert.equal((await request(port, 'GET', '/assets/a.js')).status, 200);
  assert.equal((await request(port, 'GET', '/.secret')).status, 404);
  assert.equal((await request(port, 'GET', '/', { host: 'evil.example.com' })).status, 421);
  assert.equal((await request(port, 'GET', '/assets/a.js', { host: 'evil.example.com' })).status, 421);
  assert.ok((await request(port, 'GET', '/%ZZ')).status < 500);
  // the API keeps default-src 'none'
  assert.equal((await request(port, 'GET', '/api/health')).headers['content-security-policy'], "default-src 'none'");
  assert.equal((await request(port, 'GET', '/api/nothing')).headers['content-security-policy'], "default-src 'none'");
  // static serving does not open a write path: cross-origin POSTs are still refused
  assert.equal((await request(port, 'POST', '/', { headers: { origin: 'http://evil.example' } })).status, 403);
  assert.equal((await request(port, 'POST', '/api/reset', { headers: { origin: 'http://evil.example' } })).status, 403);
});

test('without a built UI, GET / is a JSON 404', async (t) => {
  const port = await boot(t, path.join(os.tmpdir(), 'agi-no-such-dist'));
  const res = await request(port, 'GET', '/');
  assert.equal(res.status, 404);
  assert.equal(res.json.error, 'not_found');
});

test('webDist null disables static serving', async (t) => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'agi-dist-'));
  t.after(() => fs.rmSync(dist, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dist, 'index.html'), 'x');
  const port = await boot(t, null);
  assert.equal((await request(port, 'GET', '/')).status, 404);
});

// GW2 pins.
function distWith(t, files = {}) {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'agi-dist-'));
  t.after(() => { for (const f of Object.keys(files)) { try { fs.chmodSync(path.join(dist, f), 0o644); } catch { /* gone */ } } fs.rmSync(dist, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>ui</title>');
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dist, f), c);
  return dist;
}

test('the UI CSP forbids framing, plugins, base-tag and form navigation (click-jacking of Approve)', async (t) => {
  const port = await boot(t, distWith(t));
  const csp = (await request(port, 'GET', '/')).headers['content-security-policy'];
  const dir = (name) => csp.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${name} `));
  assert.equal(dir('frame-ancestors'), "frame-ancestors 'none'");
  assert.equal(dir('object-src'), "object-src 'none'");
  assert.equal(dir('base-uri'), "base-uri 'none'");
  assert.equal(dir('form-action'), "form-action 'none'");
  assert.equal(dir('connect-src'), "connect-src 'self'");
  assert.equal(dir('script-src'), "script-src 'self'");
  assert.match(UI_CSP, /frame-ancestors 'none'/);
});

test('static files are not cached, send no referrer, and refuse credentials like every other route', async (t) => {
  const port = await boot(t, distWith(t));
  const r = await request(port, 'GET', '/');
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
  for (const headers of [{ authorization: 'x' }, { 'x-api-key': 'k' }, { 'proxy-authorization': 'y' }]) {
    const res = await request(port, 'GET', '/', { headers });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'credentials_not_accepted');
  }
});

test('an error outside /api is a 500 that says nothing about the cause', async (t) => {
  const dist = distWith(t, { 'locked.txt': 'x' });
  const port = await boot(t, dist);
  fs.chmodSync(path.join(dist, 'locked.txt'), 0o000);
  if (process.getuid?.() === 0) return; // root can read anything
  const res = await request(port, 'GET', '/locked.txt');
  assert.equal(res.status, 500);
  assert.deepEqual(res.json, { error: 'server_error' });
  assert.ok(!/EACCES|locked|permission|agi-dist/i.test(res.raw), res.raw);
});
