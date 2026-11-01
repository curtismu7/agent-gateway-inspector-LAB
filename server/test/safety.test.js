import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, startHttpServer } from '../src/app.js';
import { createHealth } from '../src/health.js';
import { createRuntime } from '../src/runtime.js';
import { runChecks } from '../src/doctor.js';
import { assertBindAllowed, assertUpstreamTarget, isLoopbackHost, portInRange, parseHost, SERVER_PORT, STUB_BASE_PORT, STUB_LAST_PORT } from '../src/safety.js';
import { SCENARIOS } from '../src/scenarios.js';
import { forwardTo } from '../src/upstreams.js';
import { fakeClock } from './fixtures.js';
import { freeBase, request } from './helpers.js';
import { guardNetwork } from './netguard.js';

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src');

test('loopback helpers and strict Host parsing', () => {
  for (const h of ['127.0.0.1', '127.9.9.9', 'localhost', '::1', '[::1]', 'LOCALHOST']) assert.equal(isLoopbackHost(h), true, h);
  for (const h of ['0.0.0.0', '10.0.0.1', '128.0.0.1', 'example.com', '127.0.0.1.evil.com', '127.0.0.256', '']) assert.equal(isLoopbackHost(h), false, h);
  assert.equal(parseHost('127.0.0.1:5850').port, 5850);
  assert.equal(parseHost('127.0.0.1:99999'), null);
  assert.equal(parseHost('[::1]junk'), null);
});

test('ports: the app lives in 5850-5899, the stubs in 5851-5859', () => {
  assert.equal(SERVER_PORT, 5850);
  assert.ok(STUB_BASE_PORT === 5851 && STUB_LAST_PORT === 5859);
  for (const p of [5850, 5899]) assert.ok(portInRange(p));
  for (const p of [5849, 5900, 8080, 5173, 3900, 4000, 4400, 4510, 18080, NaN, 5850.5]) assert.ok(!portInRange(p), String(p));
  const ok = runChecks({ env: {} });
  assert.ok(ok.every((c) => c.level !== 'fail'));
  assert.equal(runChecks({ env: { PORT: '8080' } }).find((c) => c.id === 'port-range').level, 'fail');
  assert.equal(runChecks({ env: { PORT: '5900' } }).find((c) => c.id === 'port-range').level, 'fail');
  assert.equal(runChecks({ env: { PORT: '5899' } }).find((c) => c.id === 'port-range').level, 'pass');
});

test('binds loopback by default; any other address needs GATEWAY_INSPECTOR_BIND', () => {
  assert.equal(assertBindAllowed('127.0.0.1', {}), '127.0.0.1');
  assert.throws(() => assertBindAllowed('0.0.0.0', {}), /loopback only/);
  assert.throws(() => assertBindAllowed('192.168.1.5', {}), /loopback only/);
  assert.equal(assertBindAllowed('0.0.0.0', { GATEWAY_INSPECTOR_BIND: '0.0.0.0' }), '0.0.0.0');
  assert.equal(runChecks({ env: { GATEWAY_INSPECTOR_BIND: '0.0.0.0' } }).find((c) => c.id === 'bind').level, 'pass');
});

test('a started server is actually listening on loopback only, and refuses a wildcard bind', async (t) => {
  const base = await freeBase('safety', 4);
  const rt = await createRuntime({ stubBase: base });
  await assert.rejects(startHttpServer({ port: base + 3, host: '0.0.0.0', env: {}, runtime: rt }), /loopback only/);
  const s = await startHttpServer({ port: base + 3, runtime: rt });
  t.after(() => s.close());
  assert.equal(s.url, `http://127.0.0.1:${base + 3}/`);
  const addr = await new Promise((resolve) => { const c = net.connect(base + 3, '127.0.0.1', () => { resolve(c.remoteAddress); c.destroy(); }); });
  assert.equal(addr, '127.0.0.1');
  for (const p of [base, base + 1, base + 2]) {
    const c = await new Promise((resolve) => { const k = net.connect(p, '127.0.0.1', () => { resolve(true); k.destroy(); }); k.on('error', () => resolve(false)); });
    assert.ok(c, 'stub upstream is up');
  }
});

test('upstream target guard: only 127.0.0.1 and only a running stub port; the server itself and foreign ports are refused', async () => {
  const allowed = new Set([5851, 5852, 5853]);
  assert.doesNotThrow(() => assertUpstreamTarget('127.0.0.1', 5851, allowed));
  for (const [host, port] of [['localhost', 5851], ['example.com', 5851], ['10.0.0.1', 5851], ['169.254.169.254', 5851], ['127.0.0.1', 5850], ['127.0.0.1', 5854], ['127.0.0.1', 80], ['127.0.0.1', 8080], ['127.0.0.1', 5173], ['127.0.0.1', 5900]]) {
    assert.throws(() => assertUpstreamTarget(host, port, allowed), { code: 'bad_upstream' }, `${host}:${port}`);
  }
  assert.throws(() => assertUpstreamTarget('127.0.0.1', 5851), { code: 'bad_upstream' }, 'no allow-set means no target');
  assert.throws(() => assertUpstreamTarget('127.0.0.1', 5900, new Set([5900])), { code: 'bad_upstream' }, 'an allow-set cannot widen the 5850-5899 range');
  assert.throws(() => assertUpstreamTarget('127.0.0.1', 8080, new Set([8080])), { code: 'bad_upstream' });
  // forwardTo applies the same check before any socket is opened
  await assert.rejects(async () => forwardTo({ host: 'example.com', port: 5851, allowedPorts: allowed, tool: 't', args: {} }), { code: 'bad_upstream' });
  await assert.rejects(async () => forwardTo({ port: 80, allowedPorts: new Set([80]), tool: 't', args: {} }), { code: 'bad_upstream' });
});

test('the guard itself works: it blocks and records a non-loopback socket, DNS lookup and fetch', async () => {
  const g = guardNetwork();
  try {
    await assert.rejects(fetch('http://example.com/'), /network blocked/);
    await assert.rejects(fetch('http://169.254.169.254/'), /network blocked/);
    assert.throws(() => net.connect(80, '203.0.113.9'), /network blocked/);
    const dns = (await import('node:dns')).default;
    await new Promise((r) => dns.lookup('example.com', () => r()));
  } finally { g.restore(); }
  assert.deepEqual(g.attempts, ['fetch:example.com', 'fetch:169.254.169.254', 'socket:203.0.113.9', 'dns:example.com']);
});

test('default mode: every scenario, a human approval, an audit verify and a reset make zero non-loopback connections', async (t) => {
  const base = await freeBase('safety', 4);
  const g = guardNetwork();
  const clock = fakeClock();
  let rt; let server; let health;
  try {
    rt = await createRuntime({ stubBase: base, now: clock.now, sleep: async (ms) => clock.advance(ms) });
    health = createHealth();
    server = createApp({ runtime: rt, health }).listen(base + 3, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    for (const sc of SCENARIOS) assert.equal((await request(base + 3, 'POST', `/api/scenarios/${sc.id}/run`)).json.matched, true, sc.id);
    const held = await request(base + 3, 'POST', '/api/scenarios/paused-approved/run', { body: { hold: true } });
    const id = held.json.calls[0].id;
    const code = (await request(base + 3, 'GET', `/api/calls/${id}`)).json.call.pause.approvalCode;
    assert.equal((await request(base + 3, 'POST', `/api/calls/${id}/decision`, { body: { decision: 'approve', approvalCode: code } })).status, 200);
    await request(base + 3, 'GET', '/api/audit/verify');
    await request(base + 3, 'POST', '/api/reset');
    assert.ok(rt.upstreams.hits.length === 0);
  } finally {
    health?.stop();
    if (server) { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
    await rt?.close();
    g.restore();
  }
  assert.deepEqual(g.attempts, [], 'no non-loopback socket, DNS lookup or fetch was attempted');
});

test('with the network guard on, a denied or paused call opens no upstream connection at all', async (t) => {
  const base = await freeBase('safety', 4);
  const rt = await createRuntime({ stubBase: base });
  t.after(() => rt.close());
  const g = guardNetwork();
  const sockets = [];
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function spy(...a) { sockets.push(a); return realConnect.apply(this, a); };
  try {
    await rt.runScenario('scope-exceeding');
    await rt.runScenario('prompt-injection');
    await rt.runScenario('paused-approved', { hold: true });
  } finally { net.Socket.prototype.connect = realConnect; g.restore(); }
  assert.equal(sockets.length, 0);
  assert.deepEqual(rt.upstreams.hits, []);
});

test('source scan: only upstreams.js opens connections; no child process, no fetch, no eval, no env credential reads', () => {
  const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.js'));
  for (const f of files) {
    const code = fs.readFileSync(path.join(srcDir, f), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    assert.doesNotMatch(code, /child_process|(?<![.\w])exec(Sync)?\(|\bspawn\(|\beval\(|new Function\(/, `${f}: no process or code execution`);
    assert.doesNotMatch(code, /\bfetch\(/, `${f}: no fetch`);
    assert.doesNotMatch(code, /from 'node:(dns|tls|https|net|dgram)'/, `${f}: no other network modules`);
    if (f !== 'upstreams.js' && f !== 'app.js') assert.doesNotMatch(code, /node:http'|\.request\(/, `${f}: only upstreams.js makes requests`);
    assert.doesNotMatch(code, /process\.env\.(?!GATEWAY_INSPECTOR_)/, `${f}: only GATEWAY_INSPECTOR_* settings are read`);
  }
});

// GW2 pins: the stub upstreams and the forwarder's limits.
import http from 'node:http';
import { startUpstreams } from '../src/upstreams.js';

test('stub upstream: loopback Host only, POST /tools/call only, bounded request body', async (t) => {
  const base = await freeBase('safety', 3);
  const up = await startUpstreams({ basePort: base });
  t.after(() => up.close());
  const good = { tool: 'tickets.read', args: { ticketId: 'T-1' } };
  assert.equal((await request(base, 'POST', '/tools/call', { body: good })).status, 200);
  assert.equal(up.hits.length, 1);
  assert.equal((await request(base, 'POST', '/tools/call', { body: good, host: 'evil.example' })).status, 421);
  assert.equal((await request(base, 'POST', '/other', { body: good })).status, 404);
  assert.equal((await request(base, 'POST', '/tools/call/x', { body: good })).status, 404);
  assert.equal((await request(base, 'GET', '/tools/call')).status, 404);
  assert.equal((await request(base, 'POST', '/tools/call', { body: { tool: 5, args: {} } })).status, 400);
  assert.equal((await request(base, 'POST', '/tools/call', { body: '{nope' })).status, 400);
  assert.equal(up.hits.length, 1, 'none of the refused requests reached a handler');
  const big = { tool: 'tickets.read', args: { pad: 'x'.repeat(6000) } };
  const outcome = await request(base, 'POST', '/tools/call', { body: big }).then((r) => r.status, () => 'reset');
  assert.notEqual(outcome, 200);
  assert.equal(up.hits.length, 1, 'an oversized body is not processed');
});

async function oneShot(t, handler) {
  const port = await freeBase('safety', 1);
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return port;
}

test('forwardTo: an oversized answer, a non-200, bad JSON and a refusal each fail the call', async (t) => {
  const port = await oneShot(t, (req, res) => {
    req.resume();
    req.on('end', () => {
      const mode = { '/tools/call': 'big' }[req.url];
      if (mode === 'big') res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result: { pad: 'x'.repeat(10_000) } }));
    });
  });
  const r = await forwardTo({ port, allowedPorts: new Set([port]), tool: 't', args: {} });
  assert.deepEqual(r, { ok: false, error: 'upstream_too_large' });
  for (const [reply, expected] of [[() => ({ code: 500, body: '{}' }), 'upstream_status_500'], [() => ({ code: 200, body: 'not json' }), 'upstream_bad_json'], [() => ({ code: 200, body: '{"ok":false}' }), 'upstream_refused']]) {
    const p = await oneShot(t, (req, res) => { req.resume(); req.on('end', () => { const { code, body } = reply(); res.writeHead(code).end(body); }); });
    assert.equal((await forwardTo({ port: p, allowedPorts: new Set([p]), tool: 't', args: {} })).error, expected);
  }
});

test('forwardTo: a hung upstream fails the call after the default timeout instead of hanging', { timeout: 15_000 }, async (t) => {
  const port = await oneShot(t, (req) => { req.resume(); /* never answers */ });
  const t0 = Date.now();
  const r = await forwardTo({ port, allowedPorts: new Set([port]), tool: 't', args: {} });
  const took = Date.now() - t0;
  assert.deepEqual(r, { ok: false, error: 'upstream_timeout' });
  assert.ok(took >= 1000 && took < 5000, `took ${took} ms`);
});

test('forwardTo: only POST /tools/call with a JSON body is sent, and redirects are not followed', async (t) => {
  const seen = [];
  const port = await oneShot(t, (req, res) => { seen.push([req.method, req.url, req.headers['content-type']]); req.resume(); req.on('end', () => res.writeHead(302, { location: 'http://127.0.0.1:1/x' }).end()); });
  const r = await forwardTo({ port, allowedPorts: new Set([port]), tool: 't', args: { a: 1 } });
  assert.equal(r.error, 'upstream_status_302');
  assert.deepEqual(seen, [['POST', '/tools/call', 'application/json']]);
});

test('index.js runs the doctor first: a bad port setting stops the server before it listens', async () => {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [path.join(srcDir, 'index.js')], { env: { ...process.env, PORT: '8080' }, encoding: 'utf8', timeout: 10_000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing to start: port-range/);
});
