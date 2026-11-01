import test from 'node:test';
import assert from 'node:assert/strict';
import { redactText, redactUrl, redactRecord } from '../src/redaction.js';

// Token-shaped fixtures are assembled at run time so the repo holds no secret-looking literal.
const jwt = ['eyJ' + 'hbGciOiJIUzI1NiJ9', 'eyJ' + 'zdWIiOiJkZW1vIn0', 'sig' + 'nature123'].join('.');
const aws = (p) => p + 'IOSFODNN7' + 'EXAMPLE';
const sk = 'sk' + '-' + 'abcdefghijklmnopqrstuvwx';
const ghp = 'ghp' + '_' + 'abcdefghijklmnopqrstuvwx';
const MARK = '[REDACTED]';
const DASH = '-----';
const pem = (kind, body, end = true) => `${DASH}BEGIN ${kind}${DASH}\n${body}${end ? `\n${DASH}END ${kind}${DASH}` : ''}`;
const kv = 'abc' + '123' + 'def456';

test('each text rule removes its secret and leaves the sentence readable', () => {
  const rules = {
    'PEM block': [`key: ${pem('PRIVATE KEY', 'MIIabc')} done`, ['MIIabc']],
    'PEM block without an end line': [pem('RSA PRIVATE KEY', 'MIIabcdef', false), ['MIIabcdef']],
    'AWS AKIA key': [`id ${aws('AKIA')} end`, [aws('AKIA')]],
    'AWS ASIA key': [`id ${aws('ASIA')} end`, [aws('ASIA')]],
    'sk- token': [`token is ${sk}!`, [sk]],
    'ghp_ token': [`use ${ghp} now`, [ghp]],
    'xoxb token': [`slack ${'xoxb' + '-' + 'abcdefghijklmnopqrstuvwx'} ok`, ['abcdefghijklmnop']],
    'JWT': [`got ${jwt} back`, [jwt, 'nature123']],
    'Cookie line': ['Cookie: session=abc123def456; theme=dark', ['abc123def456']],
    'Set-Cookie line': ['Set-Cookie: sid=zzz999yyy888', ['zzz999yyy888']],
    'Authorization line': ['Authorization: Token abcdef123456', ['abcdef123456']],
    'Proxy-Authorization line': ['Proxy-Authorization: Negotiate abcdef123456', ['abcdef123456']],
    'Bearer': ['Authorization is Bearer abcdef123456xyz', ['abcdef123456xyz']],
    'password pair': ['password=hunter2hunter2 next', ['hunter2hunter2']],
    'json pair': [`{"api_key": "${kv}"}`, [kv]],
    'cli flag': ['run --api-key abc123def456 now', ['abc123def456']],
  };
  for (const [name, [input, gone]] of Object.entries(rules)) {
    const out = redactText(input);
    assert.ok(out.includes(MARK), `${name}: marker present in ${out}`);
    for (const g of gone) assert.ok(!out.includes(g), `${name}: ${g} still in ${out}`);
  }
  assert.equal(redactText('nothing secret here'), 'nothing secret here');
  assert.equal(redactText('Cookie: ' + MARK), 'Cookie: ' + MARK);
});

test('the Authorization and Cookie rules work on their own (header text with no other secret shape)', () => {
  assert.equal(redactText('Authorization: opaque value'), `Authorization: ${MARK}`);
  assert.equal(redactText('x\nCookie: a=b\ny'), `x\nCookie: ${MARK}\ny`);
});

test('URLs: secret query pairs, fragment pairs and userinfo are removed; the rest is kept', () => {
  const u = redactUrl('https://alice:s3cretpw@example.test/p?keep=1&access_token=abc&api_key=zzz#id=7&access_token=frag123&state=ok');
  assert.ok(!u.includes('s3cretpw') && !u.includes('alice'), u);
  assert.ok(!u.includes('abc') && !u.includes('zzz'), u);
  assert.ok(!u.includes('frag123'), u);
  assert.match(u, /keep=1/);
  assert.match(u, /#id=7&state=ok$/);
  assert.equal(redactUrl('https://example.test/#access_token=onlyone'), 'https://example.test/');
  assert.equal(redactUrl('https://example.test/#%61ccess_token=enc'), 'https://example.test/');
  assert.equal(redactUrl('not a url'), 'not a url');
  assert.equal(redactUrl(5), 5);
  assert.ok(!redactText('see https://bob:pw12345@example.test/x#token=t0k3n now').match(/pw12345|t0k3n/));
});

test('records: secret-named keys, headers/env keys, nested strings; inputs are not mutated', () => {
  const input = { a: { password: 'x', Authorization: 'y', headers: { h: 1 }, env: { E: 1 }, note: `see ${sk}` }, list: [`Cookie: q=1`], n: 5, nul: null };
  const out = redactRecord(input);
  assert.equal(out.a.password, MARK);
  assert.equal(out.a.Authorization, MARK);
  assert.ok(!('headers' in out.a) && !('env' in out.a));
  assert.ok(!out.a.note.includes(sk));
  assert.equal(out.list[0], `Cookie: ${MARK}`);
  assert.equal(out.n, 5);
  assert.equal(out.nul, null);
  assert.equal(input.a.password, 'x');
});

test('schema property names are data, not secrets', () => {
  const out = redactRecord({ inputSchema: { properties: { token: { type: 'string' } } } });
  assert.deepEqual(out.inputSchema.properties.token, { type: 'string' });
});
