# CLAUDE.md

Agent Gateway Inspector LAB (Tier: Tester, catalog D54, port 5850). An inspector for a simulated AI/agent gateway (PingOne Privilege) that allows, denies or holds agent tool calls for a human, keeps a decision buffer and a hash-chained audit trail, and is driven by an in-process stub gateway and three stub tool servers on loopback. Nothing real is touched. Details: [README.md](README.md), [docs/architecture.md](docs/architecture.md), [docs/safety.md](docs/safety.md). Presenter script: [docs/talk-track.md](docs/talk-track.md).

## Commands (from package.json)

```bash
npm ci
npm test            # server (node --test test/*.test.js) + web (vitest) + scripts/*.test.mjs
npm run build       # builds web/dist, served by the server itself
npm run doctor      # node 26, mode, bind, port range, policy tables, free ports (PORT=5865 npm run doctor to use another)
npm run reset       # POST /api/reset on the running app
npm run smoke       # minimum end-to-end check against the running app
npm run e2e         # headless Chromium on 5870; needs npm run build first (E2E_CHROMIUM=<binary> if the Playwright build is missing)
npm run content-pack  # generates and validates content-pack.json
node scripts/mutants.mjs   # source-level mutants of the release-claim code (slow; not in npm test)
npm start           # http://127.0.0.1:5850/ (PORT to change)
```

Port 5850; allowed range 5850-5899 (stubs 5851-5853, dev UI 5860, e2e 5870, tests 5861-5867 and 5880-5899). Docker: `HOST_PORT=5850 docker compose up --build -d` on OrbStack, never Docker Desktop. Node 26 only.

## Rules that bite here

- Mock/Live toggle in the header on every page, mode shown, banner says the same mode. **Live is refused** (no live gateway; `server/src/config.js` guards, `GET /api/info`). Do not add a path that makes it live without the owner. Settings: the shared file `~/Development/.env` (`STANDALONE_ENV` overrides), read with `util.parseEnv`, only `GATEWAY_INSPECTOR_MODE`; never a bare `MODE`, never `process.env.MODE`.
- Loopback only: bind `127.0.0.1`; keep the Host (421) and Origin/Sec-Fetch-Site (403) guards in front of every route, static files included.
- No real network, tenants or credentials. Mock data only; the approval code is labelled demo data. No identifiers from other projects: only `.example` / `.invalid` hosts.
- Inert text: every agent or upstream string is redacted and shown as text (hidden characters as `[U+XXXX]`), never as markup.
- CSS: the vendored `web/src/styles/standalone-ui.css` is byte-for-byte from `AI-DEMO-Standalone/shared/`; never edit it here. `web/src/app.css` uses tokens only (no colour literals, no `prefers-color-scheme`, no `!important`, no italics, breakpoints 600/900). Check: `bash ~/Development/AI-DEMO-Standalone/scripts/check-css.sh .`
- Test scripts use globs, never directories (`node --test test/*.test.js`). Never parse `node:test` stdout; use the exit code.
- Never use `crypto.generateKeyPairSync` or async `generateKeyPair` for EC keys (SIGABRT on Node 20 in CI); use `createECDH` + `createPrivateKey`.
- The forbidden-strings history scan must print 0 (`git log -p --all | grep -cF -f ~/.config/demo-kit/forbidden-strings.txt`). Never print or copy that file. gitleaks runs in `.githooks/pre-commit`; do not bypass it.
- Product claims are UNVERIFIED unless sourced. The four scope layers, the hold outcome and single-use approvals are the Ping release claim (2026-11-02), UNVERIFIED on our tenant: the banner stays on every tab, presenter mode included; the layer and hold names are lab-invented (no swagger field), and the approval field names are tagged as console swagger names, schema only.
- The claim holding the token id is `subject`, not `tokenId`: the redactor hides any field with `token` in its name.
- Policy lookups use `Object.hasOwn` or a `Map`, never an index by a user key. A new policy field needs a probe in `server/test/policymutation.test.js` that sees it change.
- The diagram is diagram-studio/1 data (rule 17): `server/diagrams/gateway-flow.json` and `gateway-flow-narrow.json`, validated at startup by `server/src/diagramData.js` (validator copied from diagram-studio, never edited), served by name at `GET /api/diagrams/:name`, fetched by `Flow.jsx`. No hand-built nodes or edges in the component. Edit both files together (the loader refuses files that disagree); `edge.ports` and `step.nodes` are small extensions the loader checks. It keeps rule 5: movable boxes, Simulate, Reset (also restores positions, from the header Reset too), speed.
- No k8s manifests, no SE build, no hosted mode, no per-visitor workspaces (all removed; the SE build is deferred by the owner, 2026-10-31).

## Where the safety claims are pinned

- `server/test/safety.test.js`: zero non-loopback connections, upstream target guard, source scan, ports.
- `server/test/guards.test.js`: Host guard, CSRF, credential refusal.
- `server/test/gateway.test.js`, `policy.test.js`: pause/approve, deny by default, scope, rate limit.
- `server/test/scopelayers.test.js`, `hold.test.js`, `holdapi.test.js`, `policymutation.test.js`: the four scope layers, holds, single-use call-bound approvals, zero outbound, Reset, mutation of every policy field.
- `server/test/audit.test.js`, `api.test.js`: append-only trail, tamper detection. `server/test/mode.test.js`: Live is refused, the settings reader takes one key.
- `server/test/static.test.js`, `web/src/test/`: UI CSP, inert text, code never rendered, the Mock/Live toggle, presenter mode.
- `scripts/compose.test.mjs`: loopback-only container publish. `scripts/docs.test.mjs`: docs match the code. `scripts/repo.test.mjs`: README standard, CSS standard, CI, Node 26, no k8s.

## Shelf and content pack

- Edit `content/terms.json` and `content/stories.json`, then `npm run content-pack` (regenerates and validates `content-pack.json`; do not hand-edit it).
- The shelf entry is `docs/shelf-entry.json` (port 5850, relative `composeFile`); `scripts/shelf-entry.test.mjs` checks it against `scripts/lib/shelf-registry-rules.mjs`. Change the port or id only with the shelf owner.
- Run check-drift, check-css and conformance by hand: `bash ~/Development/AI-DEMO-Standalone/scripts/check-drift.sh .`, `node ~/Development/demo-kit-base/scripts/conformance.mjs . --new`.
