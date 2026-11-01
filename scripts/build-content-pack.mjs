#!/usr/bin/env node
/**
 * Generates content-pack.json (repo root). Format: docs/content-pack.schema.json (a copy of the Learning Hub / ID-JAG kit schema).
 * Glossary from content/terms.json, stories from content/stories.json (same text as web/src/components/Story.jsx; a test checks that),
 * cards for the two UI views. Deterministic: lists sorted by id, 2-space JSON, no timestamps. The git commit is recorded only when
 * passed (--commit=<sha>), so a plain run is reproducible.
 *
 * Sources: none. No public documentation URL is cited in this repo that was verified, so the pack lists none.
 *
 *   node scripts/build-content-pack.mjs [--commit=<sha>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PACK_PATH = path.join(ROOT, 'content-pack.json');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// Paraphrased from the deck's value panel for slide 52 (feature test plan, section 10). Ping's claims, not our measurements.
const WHY = 'Ping claims (deck slide 52), UNVERIFIED on our tenant. Challenge: authorization sees only a tool name, but the risk is in the amount, counterparty, destination and hour. Technical: four layered scope checks read from the verified token, plus a third outcome that holds for a person; approvals are inputs, never bypasses. Business: high-stakes agent actions become approvable without standing human review, which unblocks unattended agents in regulated processes.';

// The UI has two views and no deep links, so both cards open the app root.
const CARDS = [
  { id: 'calls', label: 'Calls and decisions', description: 'Run a scenario, open a call, and see why the gateway allowed, denied or paused it.', group: 'try-it', href: '/', terms: ['allow-deny-pause', 'default-deny', 'scope', 'rate-limit', 'prompt-injection', 'redaction', 'inert-text'], story: 'S02' },
  { id: 'approval', label: 'Approve or deny a paused call', description: 'Hold a paused call, answer it with the one-shot code, then verify the audit chain.', group: 'try-it', href: '/', terms: ['one-shot-code', 'decision-buffer', 'audit-trail'], story: 'S04' },
  { id: 'scope-layers', label: 'Four scope layers (Ping release claim, unverified)', description: 'Run the surface, application and end-user scenarios and see which of the four scope checks refused the call and which were never reached. Ping release claim (2026-11-02), UNVERIFIED on our tenant.', group: 'try-it', href: '/', terms: ['scope-layers', 'default-deny', 'ping-release-claim'], story: 'S06' },
  { id: 'hold', label: 'Hold for a human, single-use approval (Ping release claim, unverified)', description: 'Run the unattended hold, approve the reference, let the agent retry the exact call once, then try the replay and the changed argument. Ping release claim (2026-11-02), UNVERIFIED on our tenant.', group: 'try-it', href: '/', terms: ['hold-for-human', 'single-use-approval', 'one-shot-code', 'fail-closed'], story: 'S04' },
  { id: 'why-it-matters', label: 'Why it matters: AI Policies, scope and hold for a human (Ping claims)', description: WHY, group: 'concept', href: '/', terms: ['ping-release-claim', 'scope-layers', 'hold-for-human'], story: 'S06' },
  { id: 'flow', label: 'Gateway flow', description: 'Agent, gateway policy, upstream tool, human approver, decision buffer and audit trail as a movable diagram with Simulate.', group: 'concept', href: '/', terms: ['agent-gateway', 'mock-mode'], story: 'S01' },
];

export function buildPack({ commit } = {}) {
  const pkg = readJson('package.json');
  const stories = readJson('content/stories.json').sort(byId);
  const ids = new Set(stories.map((s) => s.id));
  const pack = {
    schema: 'demo-content-pack/1',
    id: 'agent-gateway-inspector',
    title: 'Agent Gateway Inspector LAB',
    version: pkg.version,
    ...(commit ? { source: { repo: 'agent-gateway-inspector-LAB', commit } } : {}),
    demo: { id: 'agent-gateway-inspector', name: 'Agent Gateway Inspector LAB', catalog: 'D54', baseUrl: 'http://localhost:5850', doctor: '/api/health', tags: ['agent-gateway', 'allow-deny-pause', 'human-in-the-loop', 'audit', 'scope-layers', 'hold-for-human'] },
    glossary: readJson('content/terms.json').sort(byId),
    sources: [],
    cards: CARDS.map(({ href, ...c }) => ({ ...c, action: { type: 'route', href } })).sort(byId),
    diagrams: [{ id: 'flow', label: 'Gateway flow', href: '/' }],
    stories,
  };
  for (const c of pack.cards) if (c.story && !ids.has(c.story)) throw new Error(`card ${c.id} names unknown story ${c.story}`);
  return pack;
}

export const serialize = (pack) => `${JSON.stringify(pack, null, 2)}\n`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const commit = process.argv.find((a) => a.startsWith('--commit='))?.slice(9);
  fs.writeFileSync(PACK_PATH, serialize(buildPack({ commit })));
  console.log(`wrote ${path.relative(process.cwd(), PACK_PATH) || PACK_PATH}`);
}
