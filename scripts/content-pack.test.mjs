import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { PACK_PATH, buildPack, serialize } from './build-content-pack.mjs';
import { validatePack } from './validate-content-pack.mjs';

test('content-pack.json is exactly what the generator produces (run: npm run content-pack)', () => {
  assert.equal(fs.readFileSync(PACK_PATH, 'utf8'), serialize(buildPack()), 'content-pack.json is stale; regenerate it and commit the result');
});

test('the generator is deterministic', () => assert.equal(serialize(buildPack()), serialize(buildPack())));

test('content-pack.json validates against docs/content-pack.schema.json', () => {
  assert.deepEqual(validatePack(JSON.parse(fs.readFileSync(PACK_PATH, 'utf8'))), []);
});

test('the validator rejects a broken pack', () => {
  const pack = buildPack();
  pack.cards[0].terms = ['no-such-term'];
  delete pack.title;
  assert.ok(validatePack(pack).length >= 2);
});

test('the pack covers the app: gateway, allow/deny/pause, deny by default, one-shot code, audit trail, decision buffer, redaction, inert text', () => {
  const pack = buildPack();
  for (const id of ['agent-gateway', 'allow-deny-pause', 'default-deny', 'one-shot-code', 'audit-trail', 'decision-buffer', 'redaction', 'inert-text', 'mock-mode', 'scope-layers', 'hold-for-human', 'single-use-approval', 'fail-closed', 'ping-release-claim']) assert.ok(pack.glossary.some((g) => g.id === id), id);
  assert.deepEqual(pack.sources, []);
  assert.equal(pack.demo.baseUrl, 'http://localhost:5850');
});

test('every story says exactly what the UI story strip says', () => {
  const jsx = fs.readFileSync(new URL('../web/src/components/Story.jsx', import.meta.url), 'utf8');
  for (const s of buildPack().stories) assert.ok(jsx.includes(`proves: "${s.say}"`), `Story.jsx does not carry the text of ${s.id}`);
});

test('a commit is recorded only when passed', () => {
  assert.equal(buildPack().source, undefined);
  assert.equal(buildPack({ commit: 'abc1234' }).source.commit, 'abc1234');
});

test('the release feature is labelled as a Ping claim everywhere the pack mentions it, and carries the Challenge, Technical and Business text', () => {
  const pack = buildPack();
  const why = pack.cards.find((c) => c.id === 'why-it-matters');
  assert.equal(why.group, 'concept');
  for (const word of ['Ping claims', 'UNVERIFIED on our tenant', 'Challenge:', 'Technical:', 'Business:']) assert.ok(why.description.includes(word), word);
  for (const id of ['scope-layers', 'hold-for-human', 'single-use-approval', 'ping-release-claim']) assert.match(pack.glossary.find((g) => g.id === id).definition, /UNVERIFIED on our tenant|Ping release claim/, id);
  for (const id of ['scope-layers', 'hold']) assert.match(pack.cards.find((c) => c.id === id).description, /UNVERIFIED on our tenant/, id);
  assert.match(pack.stories.find((s) => s.id === 'S06').say, /Ping release claim, unverified/);
});

// The retired word is assembled so this file does not contain it (the apps say P1 Privilege Agent App).
const RETIRED = new RegExp(`\\b${['do', 'or'].join('')}s?\\b`, 'i');
test('the pack uses no retired wording', () => {
  assert.doesNotMatch(JSON.stringify(buildPack()), RETIRED);
});
