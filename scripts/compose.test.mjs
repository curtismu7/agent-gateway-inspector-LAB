import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

// Every published port must be bound to loopback on the host. A small line parser (no YAML dependency):
// the list items under each `ports:` key.
export function publishedPorts(text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)ports:\s*$/.exec(lines[i]);
    if (!m) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const item = /^\s*-\s*["']?([^"'\s#]+)["']?/.exec(lines[j]);
      if (!item || lines[j].search(/\S/) <= m[1].length) break;
      out.push(item[1]);
    }
  }
  return out;
}

const strip = (t) => t.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const compose = fs.readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
const code = strip(compose);
const df = strip(fs.readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8'));

test('docker-compose.yml publishes only on 127.0.0.1, in 5850-5899', () => {
  const ports = publishedPorts(compose);
  assert.ok(ports.length > 0, 'the parser found the published port');
  for (const p of ports) {
    assert.match(p, /^127\.0\.0\.1:/, `${p} must start with 127.0.0.1:`);
    for (const n of p.replace(/^127\.0\.0\.1:/, '').match(/\d+/g).map(Number)) assert.ok(n >= 5850 && n <= 5899, `${p}: port ${n} outside 5850-5899`);
  }
});

test('the parser flags an unbound or wildcard publish', () => {
  for (const bad of ['- "5850:5850"', '- "0.0.0.0:5850:5850"', '- 5850', '- "[::]:5850:5850"']) {
    const ports = publishedPorts(`services:\n  a:\n    ports:\n      ${bad}\n`);
    assert.equal(ports.length, 1);
    assert.doesNotMatch(ports[0], /^127\.0\.0\.1:/);
  }
});

test('compose gives the container no host access: no mounts, docker socket, host network or privilege', () => {
  assert.doesNotMatch(code, /^\s*volumes:/m);
  assert.doesNotMatch(code, /docker\.sock/);
  assert.doesNotMatch(code, /network_mode|privileged|pid:\s*host/);
  assert.match(code, /read_only:\s*true/);
  assert.match(code, /cap_drop:\s*\[ALL\]/);
});

test('the Dockerfile runs as non-root, carries no host-inspection tools, and exposes only 5850', () => {
  assert.match(df, /^USER node$/m);
  assert.doesNotMatch(df, /docker-cli|lsof|procps/);
  assert.deepEqual([...df.matchAll(/^EXPOSE\s+(.+)$/gm)].map((m) => m[1].trim()), ['5850']);
});

test('the healthcheck uses /api/health', () => {
  assert.match(code, /\/api\/health/);
});

test('compose keeps no-new-privileges, and the container port setting is the published and health-checked 5850', () => {
  assert.match(code, /security_opt:\s*\[\s*["']no-new-privileges:true["']\s*\]/);
  const port = /PORT:\s*["']?(\d+)["']?/.exec(code);
  assert.ok(port, 'PORT is set');
  const n = Number(port[1]);
  assert.ok(n >= 5850 && n <= 5899, `port ${n} outside 5850-5899`);
  assert.notEqual(n, 8080);
  for (const p of publishedPorts(compose)) assert.ok(p.endsWith(`:${n}`), `${p} publishes the container port ${n}`);
  assert.ok(code.includes(`127.0.0.1:${n}/api/health`), 'the healthcheck uses the same port');
  assert.deepEqual([...df.matchAll(/^EXPOSE\s+(\d+)/gm)].map((m) => Number(m[1])), [n]);
});

test('compose passes a usable SHELF_URL so the header Shelf button shows in Docker', () => {
  assert.match(code, /SHELF_URL:\s*\$\{SHELF_URL:-http:\/\/127\.0\.0\.1:4400\}/);
});

test('docker-compose.yml allows the lab-proxy name for this lab by default, never the bare proxy name', () => {
  const m = /LAB_ALLOWED_HOSTS: \$\{LAB_ALLOWED_HOSTS:-([^}]*)\}/.exec(compose);
  assert.ok(m, 'LAB_ALLOWED_HOSTS has a default');
  assert.deepEqual(m[1].split(',').map((n) => n.trim()), ['agent-gateway-inspector.local.ping-devops.com']);
});
