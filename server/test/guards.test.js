// Host guard, CSRF guard, credential guard. Each test names the attack it stops; the red checks are in docs/safety.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createHealth } from '../src/health.js';
import { createRuntime } from '../src/runtime.js';
import { fakeClock } from './fixtures.js';
import { freeBase, request } from './helpers.js';

async function boot(t) {
  const base = await freeBase('guards', 4);
  const clock = fakeClock();
  const rt = await createRuntime({ stubBase: base, now: clock.now, sleep: async (ms) => clock.advance(ms), upstreamTimeoutMs: 30_000 });
  const health = createHealth();
  const port = base + 3;
  const server = createApp({ runtime: rt, health }).listen(port, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(async () => { health.stop(); server.closeAllConnections(); await new Promise((r) => server.close(r)); await rt.close(); });
  return { port, rt };
}
const sameOrigin = (port) => ({ origin: `http://127.0.0.1:${port}` });

test('Host guard: a non-loopback, malformed or missing Host gets 421 on every route (DNS rebinding)', async (t) => {
  const { port } = await boot(t);
  for (const host of ['evil.example', 'evil.example:5850', '127.0.0.1.evil.example', '127.999.999.999', '[::1]junk', 'localhost.evil.example', '10.0.0.5:5850', '0.0.0.0']) {
    for (const path of ['/api/health', '/api/calls', '/api/audit/verify', '/api/scenarios']) {
      const res = await request(port, 'GET', path, { host });
      assert.equal(res.status, 421, `${host} ${path}`);
      assert.equal(res.json.error, 'bad_host');
    }
    assert.equal((await request(port, 'POST', '/api/reset', { host })).status, 421, `${host} POST`);
  }
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, '127.0.0.1']) assert.equal((await request(port, 'GET', '/api/health', { host })).status, 200, host);
});

test('Host guard: HTTP/1.0 without a Host header is refused', async (t) => {
  const { port } = await boot(t);
  const { default: net } = await import('node:net');
  const raw = await new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write('GET /api/health HTTP/1.0\r\n\r\n'));
    let buf = ''; s.on('data', (d) => { buf += d; }); s.on('close', () => resolve(buf));
  });
  assert.match(raw, /^HTTP\/1\.\d 421/);
});

test('CSRF: a cross-origin page cannot run a scenario, reset, or answer a paused call', async (t) => {
  const { port, rt } = await boot(t);
  const held = await request(port, 'POST', '/api/scenarios/paused-approved/run', { body: { hold: true }, headers: sameOrigin(port) });
  const id = held.json.calls[0].id;
  const code = rt.gateway.get(id).pause.approvalCode;
  const attacks = [
    { headers: { origin: 'https://evil.example' } },
    { headers: { origin: 'http://127.0.0.1:1' } },                    // another local app
    { headers: { origin: 'http://localhost:' + port } },              // same port, different host name than Host
    { headers: { origin: 'null' } },
    { headers: { origin: `http://127.0.0.1:${port}.evil.example` } },
    { headers: { origin: `http://user:pw@127.0.0.1:${port}` } },
    { headers: { 'sec-fetch-site': 'cross-site' } },
    { headers: { 'sec-fetch-site': 'cross-site', origin: `http://127.0.0.1:${port}` } },
    { headers: { 'content-type': 'text/plain' }, raw: true },
    { headers: { 'content-type': 'application/x-www-form-urlencoded' }, raw: true },
  ];
  for (const a of attacks) {
    const body = a.raw ? JSON.stringify({ decision: 'approve', approvalCode: code }) : { decision: 'approve', approvalCode: code };
    const res = await request(port, 'POST', `/api/calls/${id}/decision`, { body, headers: a.headers });
    assert.ok([403, 415].includes(res.status), `${JSON.stringify(a.headers)} -> ${res.status}`);
    if (a.raw) continue; // a bodyless POST with no Origin is curl, not a browser; a browser always sends Origin or Sec-Fetch-Site
    assert.equal((await request(port, 'POST', '/api/scenarios/benign/run', { body: { hold: false }, headers: a.headers })).status === 200, false, 'run');
    assert.equal((await request(port, 'POST', '/api/reset', { headers: a.headers })).status === 200, false, 'reset');
  }
  assert.equal(rt.gateway.get(id).outcome, 'pending', 'the paused call is untouched');
  assert.deepEqual(rt.upstreams.hits, [], 'nothing was forwarded');
  assert.equal(rt.gateway.list().calls.length, 1, 'no scenario ran, no reset happened');
  // the legitimate same-origin request still works
  const ok = await request(port, 'POST', `/api/calls/${id}/decision`, { body: { decision: 'approve', approvalCode: code }, headers: sameOrigin(port) });
  assert.equal(ok.status, 200);
  // and so does a request with no Origin at all (curl, the e2e script)
  assert.equal((await request(port, 'POST', '/api/scenarios/benign/run')).status, 200);
});

test('CSRF: the guard also applies to a text/plain "simple" POST that carries a JSON-looking body', async (t) => {
  const { port } = await boot(t);
  const res = await request(port, 'POST', '/api/scenarios/benign/run', { body: '{"hold":false}', headers: { 'content-type': 'text/plain' } });
  assert.equal(res.status, 415);
});

test('credentials are refused, not ignored, on every route (including health)', async (t) => {
  const { port } = await boot(t);
  for (const h of [{ authorization: 'Bearer abc' }, { 'proxy-authorization': 'Basic abc' }, { 'x-api-key': 'k' }, { Authorization: 'x' }]) {
    for (const [m, p] of [['GET', '/api/health'], ['GET', '/api/calls'], ['POST', '/api/reset'], ['POST', '/api/scenarios/benign/run'], ['GET', '/api/audit/verify']]) {
      const res = await request(port, m, p, { headers: h });
      assert.equal(res.status, 400, `${m} ${p} ${Object.keys(h)}`);
      assert.equal(res.json.error, 'credentials_not_accepted');
    }
  }
});

test('no body field can carry a credential or a target: the run endpoint takes only { hold }', async (t) => {
  const { port } = await boot(t);
  for (const body of [{ token: 'x' }, { url: 'http://evil.example' }, { upstream: 'http://169.254.169.254' }, { agentId: 'finance-agent' }, { authorization: 'Bearer x' }]) {
    assert.equal((await request(port, 'POST', '/api/scenarios/benign/run', { body })).status, 400, JSON.stringify(body));
  }
});

test('no route accepts a URL or host to forward to: the only POSTs are run, decision and reset', async (t) => {
  const { port } = await boot(t);
  for (const p of ['/api/calls', '/api/forward', '/api/policy', '/api/upstreams', '/api/agents', '/api/scenarios']) {
    const res = await request(port, 'POST', p, { body: { url: 'http://example.com', agentId: 'x' } });
    assert.ok([404, 405].includes(res.status), `${p} -> ${res.status}`);
  }
});

// GW2 pins.
import { originGuard, parseHost } from '../src/safety.js';

const fakeRes = () => { const r = { code: null, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
const guard = (headers, method = 'POST') => { const res = fakeRes(); let passed = false; originGuard({ method, headers }, res, () => { passed = true; }); return { passed, code: res.code, error: res.body?.error }; };

test('Host parsing is anchored at the start: a name that merely ends in a loopback address is refused', () => {
  for (const h of ['evil127.0.0.1', 'xlocalhost', 'evil.localhost.', 'a[::1]', 'evil127.0.0.1:5850', 'xlocalhost:5850', '1127.0.0.1']) assert.equal(parseHost(h), null, h);
  assert.equal(parseHost('127.0.0.1').hostname, '127.0.0.1');
  assert.equal(parseHost('localhost:5850').hostname, 'localhost');
});

test('Host guard over HTTP: a Host that only ends in a loopback address gets 421', async (t) => {
  const { port } = await boot(t);
  for (const host of ['evil127.0.0.1', 'xlocalhost:5850']) assert.equal((await request(port, 'GET', '/api/health', { host })).status, 421, host);
});

test('JSON-only: a chunked body, or a content type that merely starts with application/json, is refused', () => {
  assert.equal(guard({ host: '127.0.0.1:5850', 'transfer-encoding': 'chunked', 'content-type': 'text/plain' }).code, 415);
  assert.equal(guard({ host: '127.0.0.1:5850', 'transfer-encoding': 'chunked' }).code, 415);
  for (const ct of ['application/jsonx', 'application/json-seq', 'application/jsonp', 'text/plain', '']) assert.equal(guard({ host: '127.0.0.1:5850', 'content-length': '2', 'content-type': ct }).code, 415, ct);
  for (const ct of ['application/json', 'application/json; charset=utf-8', 'APPLICATION/JSON']) assert.equal(guard({ host: '127.0.0.1:5850', 'content-length': '2', 'content-type': ct }).passed, true, ct);
  assert.equal(guard({ host: '127.0.0.1:5850', 'transfer-encoding': 'chunked', 'content-type': 'application/json' }).passed, true);
});

test('Origin scheme: only an http loopback origin that matches the Host passes (https is refused)', () => {
  assert.equal(guard({ host: '127.0.0.1:5850', origin: 'http://127.0.0.1:5850' }).passed, true);
  for (const origin of ['https://127.0.0.1:5850', 'ftp://127.0.0.1:5850', 'http://127.0.0.1:5851', 'http://localhost:5850', 'null', 'http://127.0.0.1:5850/x', 'http://u:p@127.0.0.1:5850']) {
    assert.equal(guard({ host: '127.0.0.1:5850', origin }).code, 403, origin);
  }
  assert.equal(guard({ host: '127.0.0.1:5850', 'sec-fetch-site': 'cross-site' }).code, 403);
  assert.equal(guard({ host: '127.0.0.1:5850', 'sec-fetch-site': 'same-origin' }).passed, true);
  assert.equal(guard({ host: 'evil.example', origin: 'https://evil.example' }, 'GET').passed, true, 'reads are not the CSRF guard\'s job');
});

test('a chunked text/plain POST cannot run a scenario', async (t) => {
  const { port, rt } = await boot(t);
  const res = await request(port, 'POST', '/api/scenarios/benign/run', { headers: { 'transfer-encoding': 'chunked', 'content-type': 'text/plain' } });
  assert.equal(res.status, 415);
  assert.equal(rt.gateway.stats().calls, 0);
});

test('API responses are never cached and send no referrer', async (t) => {
  const { port } = await boot(t);
  const res = await request(port, 'GET', '/api/calls');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
});

// Behind the family lab-proxy (https://local.ping-devops.com:8443): Host is this lab's LAB_ALLOWED_HOSTS name with its port,
// the browser's Origin is the proxy's, and the proxy says so in X-Forwarded-Host/-Proto.
test('lab-proxy: launcher Host accepted, proxied same-origin write accepted, everything else still refused', async (t) => {
  const { parseAllowedHosts } = await import('../src/safety.js');
  assert.deepEqual([...parseAllowedHosts({})], []);
  assert.deepEqual([...parseAllowedHosts({ LAB_ALLOWED_HOSTS: ' Agent-Gateway-Inspector.local.ping-devops.com , ' })], ['agent-gateway-inspector.local.ping-devops.com']);
  for (const bad of ['a.example:5850', 'https://a.example', 'a b']) assert.throws(() => parseAllowedHosts({ LAB_ALLOWED_HOSTS: bad }), /not a host name/);
  const name = 'agent-gateway-inspector.local.ping-devops.com';
  const base = await freeBase('guards', 4);
  const clock = fakeClock();
  const rt = await createRuntime({ stubBase: base, now: clock.now, sleep: async (ms) => clock.advance(ms), upstreamTimeoutMs: 30_000 });
  const health = createHealth();
  const port = base + 3;
  const server = createApp({ runtime: rt, health, allowedHosts: parseAllowedHosts({ LAB_ALLOWED_HOSTS: name }), port }).listen(port, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(async () => { health.stop(); server.closeAllConnections(); await new Promise((r) => server.close(r)); await rt.close(); });
  const proxy = 'https://local.ping-devops.com:8443';
  const fwd = { 'x-forwarded-host': 'local.ping-devops.com:8443', 'x-forwarded-proto': 'https' };
  // launcher Host accepted (and loopback still is)
  assert.equal((await request(port, 'GET', '/api/health', { host: `${name}:${port}` })).status, 200);
  assert.equal((await request(port, 'GET', '/api/health', { host: `127.0.0.1:${port}` })).status, 200);
  // proxied same-origin write accepted
  const ok = await request(port, 'POST', '/api/reset', { host: `${name}:${port}`, headers: { ...fwd, origin: proxy }, body: {} });
  assert.equal(ok.status, 200, ok.raw);
  // foreign Origin refused, and an Origin that does not match the forwarded host or scheme
  for (const origin of ['https://evil.example', 'http://local.ping-devops.com:8443', 'https://local.ping-devops.com']) {
    const res = await request(port, 'POST', '/api/reset', { host: `${name}:${port}`, headers: { ...fwd, origin }, body: {} });
    assert.equal(res.status, 403, origin);
    assert.equal(res.json.error, 'bad_origin');
  }
  assert.equal((await request(port, 'POST', '/api/reset', { host: `${name}:${port}`, headers: { 'x-forwarded-host': 'local.ping-devops.com:8443', 'x-forwarded-proto': 'ftp', origin: 'ftp://local.ping-devops.com:8443' }, body: {} })).status, 403);
  assert.equal((await request(port, 'POST', '/api/reset', { host: `${name}:${port}`, headers: { 'x-forwarded-host': '', 'x-forwarded-proto': 'https', origin: 'https://' }, body: {} })).status, 403);
  // forwarded headers on a loopback Host are ignored
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
    assert.equal((await request(port, 'POST', '/api/reset', { host, headers: { ...fwd, origin: proxy }, body: {} })).status, 403, host);
  }
  // a Host outside the set is refused: the bare proxy name, another name, the right name on another port, no port
  for (const host of [`local.ping-devops.com:${port}`, 'local.ping-devops.com:8443', `evil.example:${port}`, `${name}:${port + 1}`, name]) {
    assert.equal((await request(port, 'GET', '/api/health', { host })).status, 421, host);
    assert.equal((await request(port, 'POST', '/api/reset', { host, headers: { ...fwd, origin: proxy }, body: {} })).status, 421, host);
  }
});
