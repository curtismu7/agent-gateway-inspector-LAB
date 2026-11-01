import test from 'node:test';
import assert from 'node:assert/strict';
import { hasInvisible, inertValue, revealText } from '../src/sanitize.js';
import { redactRecord, redactText } from '../src/redaction.js';

test('hidden and control characters are shown as [U+XXXX]', () => {
  assert.equal(revealText('a\u200Bb'), 'a[U+200B]b');
  assert.equal(revealText('x\u202Ey'), 'x[U+202E]y');
  assert.equal(revealText('l1\u2028l2'), 'l1[U+2028]l2');
  assert.equal(revealText('tag\u{E0041}'), 'tag[U+E0041]');
  assert.equal(revealText('bell\u0007'), 'bell[U+0007]');
  assert.equal(revealText('plain text, emoji \u2764\uFE0F ok'), 'plain text, emoji \u2764\uFE0F ok');
  assert.ok(hasInvisible('a\uFEFF'));
});

test('size, depth and key counts are bounded', () => {
  assert.equal(revealText('x'.repeat(5000)).length, 2001);
  const deep = inertValue({ a: { b: { c: { d: { e: { f: { g: 1 } } } } } } });
  assert.equal(deep.a.b.c.d.e.f, '[truncated]');
  assert.equal(inertValue(Array.from({ length: 500 }, (_, i) => i)).length, 100);
  assert.equal(Object.keys(inertValue(Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, i])))).length, 50);
});

test('secret-looking strings are redacted in text and by key name', () => {
  const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJkZW1vIn0', 'c2lnbmF0dXJl'].join('.');
  const out = redactText(`Authorization: Bearer abcdef123456 and ${jwt} and password=hunter2hunter2 and https://x.test/cb?access_token=zzzzzzzz&a=1`);
  assert.doesNotMatch(out, /abcdef123456|hunter2|zzzzzzzz|eyJ/);
  assert.match(out, /a=1/);
  const fake = ['abc', '123', '456789'].join('');
  const rec = redactRecord({ ticketId: 'T-1', api_key: 'k', nested: { clientSecret: 'x', headers: { a: 1 }, note: `token=${fake}` } });
  assert.equal(rec.api_key, '[REDACTED]');
  assert.equal(rec.nested.clientSecret, '[REDACTED]');
  assert.equal(rec.nested.headers, undefined);
  assert.doesNotMatch(JSON.stringify(rec), new RegExp(fake));
  assert.equal(rec.ticketId, 'T-1');
});

test('object KEYS are revealed and bounded too', () => {
  const out = inertValue({ ['k​ey']: 1, ['t\u{E0041}']: { ['n‮est']: 2 }, [`${'x'.repeat(300)}`]: 3 });
  assert.deepEqual(Object.keys(out).slice(0, 2), ['k[U+200B]ey', 't[U+E0041]']);
  assert.ok(Object.keys(out['t[U+E0041]'])[0] === 'n[U+202E]est');
  assert.ok(Object.keys(out).every((k) => k.length <= 129));
});
