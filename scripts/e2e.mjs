#!/usr/bin/env node
// Real-browser run of the web UI against the real server, which serves the UI itself (server/src/index.js).
//
//   npm run build          (once; the server serves web/dist)
//   npm run e2e            starts the server on E2E_PORT (default 5870), drives it, stops it
//   E2E_SHOTS=/some/dir    where screenshots go (default .data/e2e-screenshots, git-ignored)
//
// The stub upstreams use 5851-5853, so stop any other running agent-gateway-inspector first. Uses the Chromium the
// installed Playwright resolves (`npx playwright install chromium` if missing). The run makes no outbound request.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.env.E2E_SHOTS || path.join(root, '.data', 'e2e-screenshots');
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures += 1; };

const port = Number(process.env.E2E_PORT) || 5870;
if (port < 5850 || port > 5899) { console.error('E2E_PORT must be inside 5850-5899'); process.exit(2); }
const base = `http://127.0.0.1:${port}`;
if (!fs.existsSync(path.join(root, 'web', 'dist', 'index.html'))) { console.error('Run `npm run build` first.'); process.exit(2); }
const env = { ...process.env, PORT: String(port) };
delete env.GATEWAY_INSPECTOR_BIND;
const server = spawn(process.execPath, ['server/src/index.js'], { cwd: root, env, stdio: 'inherit' });
let up = false;
for (let i = 0; i < 60 && !up; i++) { try { up = (await fetch(`${base}/api/health`)).ok; } catch { await sleep(250); } }
if (!up) { server.kill(); console.error('server did not start'); process.exit(2); }
fs.mkdirSync(shots, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM || undefined });
try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, colorScheme: 'light' });
  const external = []; const errors = []; const dialogs = [];
  page.on('request', (r) => { if (!r.url().startsWith(base) && !/^(data|blob):/.test(r.url())) external.push(r.url()); });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
  const shot = (name) => page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
  const active = () => page.evaluate(() => `${document.activeElement?.tagName}|${document.activeElement?.textContent?.trim().slice(0, 40)}`);
  const status = () => page.getByTestId('run-status').innerText();
  const runDone = (re) => page.waitForFunction((s) => new RegExp(s).test(document.querySelector('[data-testid="run-status"]').textContent), re.source);

  await page.goto(`${base}/`);
  await page.getByTestId('mode-badge').waitFor();
  check((await page.getByTestId('mode-badge').innerText()).includes('Mode: Mock'), 'header shows Mode: Mock');
  check((await page.getByTestId('release-banner').innerText()).startsWith('Mock mode.'), 'the banner says Mock mode');
  check((await page.getByText('No calls yet').count()) === 1, 'call list starts empty');
  const csp = (await (await fetch(`${base}/`)).headers.get('content-security-policy')) || '';
  check(/script-src 'self'/.test(csp) && !/unsafe-eval/.test(csp), 'the page is served with a same-origin CSP');

  await page.getByRole('button', { name: 'Run', exact: true }).and(page.locator(':enabled')).waitFor();

  // Keyboard only: skip link first, then Tab to Run, press Enter on the default scenario (benign).
  await page.keyboard.press('Tab');
  check((await active()).includes('Skip to content'), 'first Tab stop is the skip link');
  let reached = false;
  for (let i = 0; i < 14 && !reached; i++) { await page.keyboard.press('Tab'); reached = (await active()).endsWith('|Run'); }
  check(reached, 'Tab reaches the Run button');
  await page.keyboard.press('Enter');
  await runDone(/^Ran "Benign call"/);
  check((await page.getByTestId('run-status').getAttribute('aria-live')) === 'polite', 'run result region is aria-live');
  check(/1 allow/.test(await status()) && /Matches the expected/.test(await status()), `benign run announced: "${await status()}"`);
  check((await page.locator('.call[data-call-id] [data-decision="allow"]').count()) === 1, 'the list shows an Allow badge (word and glyph)');
  check((await page.locator('[data-decision="allow"]').first().innerText()).includes('Allow'), 'the badge carries the word, not colour alone');

  // Keyboard only: Tab on to a call and open its detail with Enter.
  let onCall = false;
  for (let i = 0; i < 6 && !onCall; i++) { await page.keyboard.press('Tab'); onCall = (await active()).includes('call-'); }
  check(onCall, 'Tab reaches a call in the list');
  await page.keyboard.press('Enter');
  await page.getByTestId('detail').waitFor();
  check(await page.locator('#detail-title').evaluate((el) => el === document.activeElement), 'detail heading receives focus');
  const detailText = await page.getByTestId('detail').innerText();
  check(/support-bot/.test(detailText) && /tickets\.read/.test(detailText) && /allow-ticket-read/.test(detailText) && /Why/.test(detailText), 'detail shows agent, tool, matched rule and why');
  await shot('1-allow-light');

  // Deny, with a hidden-character-free injection shown as text and marked.
  await page.locator('#scenario-select').selectOption('prompt-injection');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await runDone(/^Ran "Prompt-injected tool argument"/);
  check(/1 deny/.test(await status()), `injection run announced: "${await status()}"`);
  const det2 = page.getByTestId('detail');
  await det2.locator('mark').first().waitFor();
  check((await det2.locator('mark').count()) > 0, 'instruction-like text in the arguments is marked');
  check((await det2.innerText()).includes('Ignore previous instructions'), 'the injected text is shown as text');
  check((await det2.locator('[data-decision="deny"]').count()) === 1 && /prompt_injection/.test(await det2.innerText()), 'detail shows Deny and the reason');
  await shot('2-deny-light');

  // Rate burst: allows and denies in one list.
  await page.locator('#scenario-select').selectOption('rate-burst');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await runDone(/^Ran "Rate burst"/);
  check(/5 allow, 2 deny/.test(await status()), `rate burst: "${await status()}"`);

  // Paused call, held, approved from the UI.
  await page.locator('#scenario-select').selectOption('paused-approved');
  check(await page.getByLabel('Wait for me to answer a held call').isChecked(), 'hold is on by default');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await runDone(/waiting for you/);
  const pauseBox = page.getByTestId('pause');
  await pauseBox.waitFor();
  check((await page.getByTestId('detail').locator('[data-decision="pause"]').innerText()).includes('Hold for a human'), 'the held call shows a Hold for a human badge with the word');
  check((await page.getByTestId('detail').locator('[data-outcome="pending"]').count()) === 1, 'the paused call is waiting for a human');
  await shot('3-pause-light');
  await page.getByRole('button', { name: 'Approve and forward' }).click();
  await page.getByTestId('detail').locator('[data-outcome="forwarded"]').waitFor();
  check(/Approved call-\d+/.test(await status()), `approval announced: "${await status()}"`);
  check((await page.getByTestId('pause').innerText()).includes('approved'), 'pause state is approved');
  check((await page.getByRole('button', { name: 'Approve and forward' }).count()) === 0, 'the code is spent: no approve button remains');

  // A paused call denied by the human
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.getByRole('button', { name: 'Deny', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Deny', exact: true }).click();
  await page.getByTestId('detail').locator('[data-outcome="denied_by_human"]').waitFor();
  check(true, 'a held pause can be denied from the UI');

  // Ping release claim (2026-11-02), UNVERIFIED on our tenant: the banner, the four scope checks, an unattended hold,
  // the approval bound to the exact call, one retry, and the refused replay.
  check(await page.getByTestId('release-banner').isVisible() && /UNVERIFIED on our tenant/.test(await page.getByTestId('release-banner').innerText()), 'the release claim banner is visible on the Inspector tab');
  await page.locator('#scenario-select').selectOption('end-user-denied');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await runDone(/^Ran "Scope layer 4/);
  const strip = page.getByTestId('scope-strip');
  await strip.waitFor();
  check((await strip.locator('[data-state="pass"]').count()) === 3 && (await strip.locator('[data-state="fail"]').count()) === 1, 'the four scope checks show three passed and the end-user layer refused');
  check(/Refused/.test(await strip.innerText()) && /scope_end_user/.test(await page.getByTestId('detail').innerText()), 'the refusal is in words, with its reason');
  await page.locator('#scenario-select').selectOption('hold-unattended');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.getByRole('button', { name: 'Approve this exact call' }).waitFor();
  const holdBox = page.getByTestId('hold');
  check(/hold-[0-9a-f]{16}/.test(await holdBox.innerText()) && !/[0-9a-f]{32}/.test((await holdBox.innerText()).replace(/[0-9a-f]{64}/g, '')), 'the hold shows its reference and never the human code');
  await page.getByRole('button', { name: 'Approve this exact call' }).click();
  await holdBox.getByText(/Approved: waiting for the agent's exact retry \(works once\)/).waitFor(); // the retry button also shows before the answer, so wait for the state itself
  await page.getByRole('button', { name: 'Agent retries the exact call' }).and(page.locator(':enabled')).waitFor();
  check((await holdBox.innerText()).includes('works once'), 'approved: waiting for the exact retry, which works once');
  const hitsBefore = (await (await fetch(`${base}/api/calls`)).json()).calls.filter((c) => c.outcome === 'forwarded').length;
  await page.getByRole('button', { name: 'Agent retries the exact call' }).click();
  await runDone(/The agent retried call-\d+ as call-\d+: Allow, hold_approved/);
  const hitsAfter = (await (await fetch(`${base}/api/calls`)).json()).calls.filter((c) => c.outcome === 'forwarded').length;
  check(hitsAfter === hitsBefore + 1, 'the exact retry was forwarded once');
  await page.getByRole('button', { name: 'Replay the same approval' }).click();
  await runDone(/Deny, approval_consumed/);
  check((await (await fetch(`${base}/api/calls`)).json()).calls.filter((c) => c.outcome === 'forwarded').length === hitsAfter, 'the replay of the spent approval was refused and forwarded nothing');
  await shot('3b-hold-light');

  // Audit trail and Verify chain
  await page.getByRole('button', { name: 'Verify chain' }).click();
  await page.locator('.verify--ok').waitFor();
  const ok = await page.getByTestId('verify-result').innerText();
  check(/Chain verified/.test(ok), `verify chain OK: "${ok}"`);
  const rows = await page.locator('table.inv tbody tr').count();
  check(rows > 10, `audit trail lists entries (${rows})`);
  // Tamper result: the server cannot be tampered through the API, so answer the verify call with a failure to see the UI path.
  await page.route('**/api/audit/verify', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ mode: 'mock', ok: false, length: 12, firstBadSeq: 7, reason: 'hash_mismatch' }) }));
  await page.getByRole('button', { name: 'Verify chain' }).click();
  await page.locator('.verify--bad').waitFor();
  const bad = await page.getByTestId('verify-result').innerText();
  check(/TAMPERED/.test(bad) && /#7/.test(bad), `tamper result is visible: "${bad}"`);
  await page.unroute('**/api/audit/verify');
  await shot('4-audit-tamper-light');

  // Dark theme + diagram
  await page.getByTestId('theme-select').selectOption('dark');
  check((await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark', 'theme toggles to dark');
  await shot('5-inspector-dark');
  await page.getByRole('button', { name: 'Diagram' }).click();
  await page.locator('.react-flow__node').first().waitFor();
  check(await page.getByTestId('release-banner').isVisible(), 'the release claim banner is visible on the Diagram tab');
  check((await page.locator('.react-flow__node').count()) === 7, 'seven diagram boxes');
  check(await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('.react-flow__edge-textbg')].map((e) => e.getBoundingClientRect());
    const nodes = [...document.querySelectorAll('.react-flow__node')].map((e) => e.getBoundingClientRect());
    const hit = (a, b) => a.left < b.right + 4 && b.left < a.right + 4 && a.top < b.bottom + 4 && b.top < a.bottom + 4;
    return boxes.length === 7 && boxes.every((b, i) => boxes.every((c, j) => i === j || !hit(b, c)) && nodes.every((n) => !hit(b, n)));
  }), 'edge labels overlap neither each other nor a box');
  const node = page.locator('.react-flow__node', { hasText: 'Audit trail' }).first();
  await node.scrollIntoViewIfNeeded(); // the Diagram tab's release banner pushes the bottom row below a 900px fold
  const before = await node.boundingBox();
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down(); await page.mouse.move(before.x + before.width / 2 + 60, before.y + before.height / 2 + 30, { steps: 6 }); await page.mouse.up();
  const after = await node.boundingBox();
  check(Math.abs(after.x - before.x) > 20 || Math.abs(after.y - before.y) > 10, 'a box can be dragged');
  await page.locator('#scenario-select').selectOption('scope-exceeding');
  await page.getByLabel('Speed').selectOption('4');
  const callsBefore = (await (await fetch(`${base}/api/calls`)).json()).calls.length;
  await page.getByRole('button', { name: 'Simulate' }).click();
  await page.getByTestId('caption').filter({ hasText: 'Step 1 of 6' }).waitFor();
  check((await page.locator('.fbox[data-on="true"]').count()) > 0, 'Simulate highlights boxes');
  await page.getByTestId('caption').filter({ hasText: 'Step 6 of 6' }).waitFor({ timeout: 10000 });
  const cap = await page.getByTestId('caption').innerText();
  check(/audit trail/i.test(cap), `final step reflects the real run: "${cap}"`);
  const callsAfter = (await (await fetch(`${base}/api/calls`)).json()).calls.length;
  check(callsAfter === callsBefore + 1, 'Simulate drove a real scenario run on the server');
  await shot('6-diagram-dark');
  await page.getByRole('button', { name: 'Reset diagram' }).click();
  check((await page.getByTestId('caption').innerText()).includes('Press Simulate') && (await page.locator('.fbox[data-on="true"]').count()) === 0, 'diagram Reset clears the highlight');
  await page.getByTestId('theme-select').selectOption('light');
  await shot('7-diagram-light');

  // Reset
  await page.getByRole('button', { name: 'Inspector' }).click();
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.getByText('No calls yet').waitFor();
  check(true, 'Reset empties the call list');
  await page.getByRole('button', { name: 'Verify chain' }).click();
  await page.locator('.verify--ok').waitFor();
  check(/Chain verified/.test(await page.getByTestId('verify-result').innerText()), 'after Reset the new audit epoch verifies');

  // Narrow viewport
  await page.locator('#scenario-select').selectOption('rate-burst');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await runDone(/^Ran "Rate burst"/);
  await page.setViewportSize({ width: 390, height: 800 });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal page scroll at 390px (inspector)');
  await shot('8-phone-light');
  await page.getByRole('button', { name: 'Diagram' }).click();
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal page scroll at 390px (diagram)');

  check(external.length === 0, `no request left the origin ${JSON.stringify(external)}`);
  check(errors.length === 0, `no page or console errors ${JSON.stringify(errors)}`);
  check(dialogs.length === 0, 'no JavaScript dialog fired');
} catch (e) {
  console.error(e); failures += 1;
} finally {
  await browser.close();
  server.kill();
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
