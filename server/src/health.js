// GET /api/health, contract demo-health/1 (the demo shelf's docs/health-contract.md).
// Public, GET only, no counts or detail. The state comes from the doctor checks, refreshed in the background every
// 60 s; a request never runs them.
import fs from 'node:fs';
import express from 'express';
import { allPassed, runChecks as defaultChecks } from './doctor.js';

const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const DEMO = { id: 'agent-gateway-inspector', name: 'Agent Gateway Inspector LAB', version };

export function createHealth({ runChecks = defaultChecks, now = () => new Date(), intervalMs = 60_000, env = process.env } = {}) {
  let last = { state: 'unknown', at: null };
  function refresh() {
    try { last = { state: allPassed(runChecks({ env })) ? 'ready' : 'broken', at: now().toISOString() }; }
    catch { last = { state: 'unknown', at: now().toISOString() }; }
  }
  refresh();
  const timer = setInterval(refresh, intervalMs);
  timer.unref();

  const router = express.Router();
  router.get('/', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ schema: 'demo-health/1', at: last.at || now().toISOString(), state: last.state, runtime: 'offline', demo: DEMO });
  });
  router.all('/', (_req, res) => res.set('Allow', 'GET').status(405).json({ error: 'method_not_allowed' }));
  return { router, refresh, stop: () => clearInterval(timer) };
}
