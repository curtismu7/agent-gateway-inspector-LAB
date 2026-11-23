# Agent Gateway Inspector LAB

An inspector for an AI/agent gateway (PingOne Privilege) that allows, denies or pauses (holds for a human) agent tool calls, keeps a decision buffer and a hash-chained audit trail, and is driven by an in-process stub gateway. Nothing real is touched.

Tier: Tester
Repo: https://github.com/curtismu7/agent-gateway-inspector-LAB
Catalog: D54

> **Ping release claim (2026-11-02), UNVERIFIED on our tenant.** The four layered scope checks, the third outcome that holds for a human (attended or unattended), and approvals that work once and are bound to the exact call are what Ping's release is claimed to do (deck slide 52). This app simulates them. The header has a Mock/Live toggle and shows the mode, but **Live is refused**: there is no live gateway to talk to, and the feature has no live path until the release is on our tenant. The banner on every tab, presenter mode included, names the mode and carries this notice. See "The release claim" below for what is a console swagger name and what is lab-invented.

## What is simulated

**Mock mode (the only mode that runs).** Everything. Scripted agents call tools, a stub gateway decides allow, deny or hold, and allowed calls reach three stub tool servers on `127.0.0.1:5851-5853` inside the same process. The four scope layers, the hold outcome, the tokens, applications and end users, the approval codes and the audit key are all simulated and held in memory. There is no real gateway, no tenant, no credential, and no network beyond `127.0.0.1`. The banner in the app says the same.

**Live mode (refused).** The toggle is there on every page, as the standard asks, and pressing Live shows why it is refused and leaves the page in Mock. Live would be a real gateway run by the owner, and this app has no client for one: the Ping release it simulates is not on our tenant. `GET /api/info` lists which guards fail. Setting `GATEWAY_INSPECTOR_MODE=live` is refused in the same way (the doctor says so and the page opens in Mock). This is a gap against "every page has a real and a mock version", and it is deliberate; see "Known gaps and not done".

Product source: the AI-DEMO2 Agent Gateway Inspector page. Only its ideas (allow / deny / pause, decision buffer, audit trail) were taken; the code here is new and shares nothing with it.

## Run from a clone

Prerequisites: Node 26 or newer (`.nvmrc` says 26). Docker only for the Docker form.

```bash
git clone https://github.com/curtismu7/agent-gateway-inspector-LAB.git
cd agent-gateway-inspector-LAB
npm ci
npm run doctor      # node, mode, bind, port range, policy tables, free ports (5850 and the stubs 5851-5853)
npm run build       # builds web/dist, which the server serves itself
npm start           # then open http://127.0.0.1:5850/
```

Mock mode needs no setup at all: no settings file, no account, no network.

```bash
curl -s http://127.0.0.1:5850/api/health
curl -s http://127.0.0.1:5850/api/info
curl -s http://127.0.0.1:5850/api/scenarios
curl -s -X POST http://127.0.0.1:5850/api/scenarios/benign/run
curl -s -X POST http://127.0.0.1:5850/api/scenarios/rate-burst/run
curl -s http://127.0.0.1:5850/api/calls
curl -s http://127.0.0.1:5850/api/audit/verify
npm run smoke       # the minimum end-to-end check against the running app
```

Answer a held call yourself (hold keeps it pending; the code is in the call detail):

```bash
J='JSON.parse(require("fs").readFileSync(0,"utf8"))'
ID=$(curl -s -X POST http://127.0.0.1:5850/api/scenarios/paused-approved/run -H 'content-type: application/json' -d '{"hold":true}' | node -pe "$J.calls[0].id")
CODE=$(curl -s http://127.0.0.1:5850/api/calls/$ID | node -pe "$J.call.pause.approvalCode")
curl -s -X POST http://127.0.0.1:5850/api/calls/$ID/decision -H 'content-type: application/json' \
  -d "{\"decision\":\"approve\",\"approvalCode\":\"$CODE\"}"
```

Call ids keep counting up and are not reused after `POST /api/reset`, so take the id from the run response as above. The pause lasts 30 seconds. After that the call is `expired` and the code no longer works.

Development: `npm run dev` starts the Vite dev server on `127.0.0.1:5860` and proxies `/api` to the server (start the server too). `npm run e2e` drives headless Chromium against the built UI on port 5870 (needs `npm run build` first and `npx playwright install chromium`; if the installed Chromium build does not match the pinned Playwright, set `E2E_CHROMIUM` to the path of a Chromium or headless shell binary).

## Settings file

All standalone apps read one settings file, `~/Development/.env` (mode 600). `STANDALONE_ENV=/path/to/file` overrides the path. This app reads it with `util.parseEnv` and takes only the key below; every other key in the file is ignored and never enters the server's environment. A bare `MODE` is never read.

| Key | Required | What it does |
| --- | --- | --- |
| `GATEWAY_INSPECTOR_MODE` | optional | The mode the page opens in: `mock` (the default) or `live`. `live` is refused (see "Mock and live modes"), so the page opens in Mock either way. Anything else stops the server with an error. |

The server port is not in the file: apps keep their port defaults in code. `PORT` and `GATEWAY_INSPECTOR_BIND` are environment variables (see the next section and the Docker section). This app needs no credential of any kind and lists no admin or worker key.

## Ports, and what to do if the port is taken

Ports: agent-gateway-inspector listens on 5850 (set with PORT, default 5850).
Port range for this app: 5850-5899.

If the port is taken:
1. Find what is using it:
   lsof -iTCP:5850 -sTCP:LISTEN -n -P
2. If it is an old copy of this app, stop that process: kill <PID>.
3. If it is something else, stop it, or start this app on another port:
   PORT=<other port> npm start
4. Do not use 8080, 5173, 3000, 4000, 4400, 4510, 4600-4601, 18080, 19080 or 19090.
   Those are taken by other demos or other tools.

Other ports this app uses, all inside 5850-5899: the stub tool servers on 5851-5853 (reserved up to 5859; fixed, so stop an old copy that holds them), the Vite dev server on 5860 (`VITE_PORT`), `npm run e2e` on 5870 (`E2E_PORT`), the tests on 5861-5867 and 5880-5899, and the Docker host port `HOST_PORT` (default 5850).

## Mock and live modes

- The header has a **Mock / Live** toggle on every page (the Inspector and the Diagram tab). It shows the mode as `Mode: Mock`, and the banner under it says the same ("Mock mode.").
- **Mock** is the in-process stub gateway and the three stub tool servers. Everything in this README runs in Mock.
- **Live** is refused. `GET /api/info` answers `{"mode":"mock","live":{"available":false,"failed":[...]}}`. Live passes only when every guard passes: the owner opted in with `GATEWAY_INSPECTOR_MODE=live`, the server is bound to loopback or `GATEWAY_INSPECTOR_BIND` is set (any value of it passes this guard, so it is a weak check and says nothing about the address), and there is a live gateway to talk to. The last guard cannot pass because there is none. Pressing Live changes nothing and sends no request; it shows the reason and leaves Mock selected. Pressing Mock clears the message.
- **What Privilege did** (under the Run result): for each call of the run, the request the simulated agent sent to the stub gateway, the answer it got and the decisions in between, in the order `policy.js` evaluates them (agent, tool, arguments, token, the four scope layers, rate limit, rules, then the approval and the tool server). It is the family's shared trace panel, vendored and pinned in `web/src/gateway-trace/`. There is no HTTP call here, so the request and answer are a lab-shaped rendering of the in-process call (host `agent-gateway.invalid`); the decisions are labelled as computed by the stub, and a call still waiting for you appears once you answer it.
- **Presenter mode** (press `P`, or the Presenter button; `Esc` leaves). It enlarges the text and removes the toggle, Reset and theme buttons. The mode chip and the banner stay.
- **Reset** (header button) clears the calls and starts a new audit epoch, and puts the diagram boxes back where they started.
- Dark and light themes: the Dark/Light button sets `data-theme`; the shared stylesheet does the rest.

## Health, doctor and reset

```bash
npm run doctor   # checks node, mode, bind, port range, policy tables, scope layers, free ports
npm run reset    # clears run state in a running app; there are no saved settings to lose
npm run smoke    # health, mode, one scenario run, audit chain, reset, against the running app
```

`GET /api/health` answers `demo-health/1` (`{ schema, at, state, runtime: "offline", demo: { id, name, version } }`), public, GET only, no detail. `npm run doctor` prints one line per check and exits 1 on a failure. `npm run reset` posts to `POST /api/reset`; the UI Reset button does the same and also resets the diagram boxes, which a script cannot do in a browser tab.

## Docker (optional)

```bash
HOST_PORT=5850 docker compose up --build -d    # OrbStack, never Docker Desktop
curl -s http://127.0.0.1:5850/api/health
docker compose down
```

The container publishes on `127.0.0.1` only (a test pins it), runs as the non-root `node` user with a read-only root filesystem, all capabilities dropped and no mounts, and the server binds `0.0.0.0` inside it only because `GATEWAY_INSPECTOR_BIND` is set in the image. Host port: `HOST_PORT`, within 5850-5899.

## Tests

```bash
npm test      # server (node:test), web (vitest) and the script tests (node --test scripts/*.test.mjs)
```

On Node 26, with the counts from the last run in this repo: 241 server tests (node:test), 178 web tests (vitest) and 56 script tests (node:test), 475 in all.

## Troubleshooting

- **The port is taken, or "refusing to start: port-range".** See "Ports, and what to do if the port is taken". `PORT` must be inside 5850-5899.
- **The stub ports 5851-5853 are in use.** An old copy of this app is still running. `npm run doctor` names the ports; stop the old process.
- **`GET /` answers a JSON 404.** The UI is not built. Run `npm run build`, then restart.
- **Pressing Live does nothing but show a message.** That is the designed behaviour: Live is refused. The page stays in Mock.
- **The browser console shows 4xx lines after you press Approve, Deny, Replay or run a scenario that is refused on purpose.** The deliberate refusals are real HTTP 4xx answers, and the browser logs them. They are not errors.

## Ownership

- Owner: the Ping demo-family owner (this repo is part of the `-LAB` family under the owner's `curtismu7` account).
- License: MIT, see `LICENSE`.
- Found a problem? Open an issue on the repo.

## Known gaps and not done

- **Live is refused, so "every page has a real and a mock version" is not met.** There is a Mock/Live toggle and a visible mode, but no live gateway. Rule 1 allows Live to be optional and owner-run; the standard's "real and mock on every page" is the gap. Reinstating a live path needs the Ping release on a tenant and an owner decision.
- **The SE k8s mock build is deferred (owner, 2026-10-31).** The manifests, the deploy script, the hosted mode and the per-visitor workspaces of the old repo were removed here. Docker is the only packaged form.
- **No per-workspace isolation.** There is one in-memory workspace; the `X-Workspace-Id` header of the old hosted build is gone. Tester tier does not require it.
- **Not run again in this repo:** the 31 source-level mutants in `scripts/mutants.mjs` (see Verification).
- **Catalog id D54** was assigned by the coordinator in the old repo; it is not recorded in the standalone plan here.

## What it does

Twelve scripted scenarios, each with an expected decision (the run response says whether it `matched`). The last six are the Ping release claim (2026-11-02), UNVERIFIED on our tenant:

| Scenario | Result |
| --- | --- |
| `benign` | allowed and forwarded |
| `scope-exceeding` | denied: the agent does not hold the tool's scope |
| `prompt-injection` | denied: instruction-like text in a tool argument |
| `rate-burst` | five allowed, two denied by the rate limit |
| `paused-approved` | paused above the 500 limit, approved with the one-shot code, then forwarded |
| `paused-expired` | paused, nobody answers, expires; a late approval is refused |
| `surface-denied` | scope layer 1: the token is not valid on the surface the call arrived on (`scope_surface`) |
| `application-denied` | scope layer 2: the token's application is not registered for the tool (`scope_application`) |
| `end-user-denied` | scope layer 4: the user the token acts for lacks the scope (`scope_end_user`) |
| `hold-unattended` | an unattended call is refused at once with a reference and an expiry; a human approves; the exact retry is forwarded once |
| `hold-replay-refused` | the same, then the approval is used a second time and refused (`approval_consumed`) |
| `hold-args-changed` | the retry changes an argument and is refused (`approval_mismatch`); the exact call then goes through |

`scope-exceeding` is scope layer 3, the action layer. There is no evaluation-error scenario (see [docs/safety.md](docs/safety.md)).

Anything no rule allows is denied. See [docs/architecture.md](docs/architecture.md) for the decision order, the pause rules, the API and the audit chain, and [docs/safety.md](docs/safety.md) for each safety rule with the test that enforces it and a list of what is not covered.

## The UI

Open `http://127.0.0.1:5850/` after `npm run build` and `npm start`. Call list on the left, call detail on the right.

- **Scenario picker and Run.** Pick one of the twelve scenarios and press Run. "Wait for me to answer a held call" is on by default, so a held call stays waiting (30 seconds) until you answer it.
- **Call list.** Newest first, with a decision badge (`Allow`, `Deny`, `Hold for a human`: a word and a glyph, never colour alone) and an outcome badge.
- **Call detail.** Agent, tool, scope needed, the rule that matched, why, the arguments and any upstream answer. Every string from an agent or upstream is shown as inert text: markup is displayed, not run, hidden characters appear as `[U+XXXX]` chips, and instruction-like text, paths and addresses are marked. Under the marked arguments and the marked upstream answer, the same value is also a JSON pane (Form | JSON toggle, full view): there hidden characters show as `[U+XXXX]` text and the keys that matter (`ticketId`, `amount`, `to`, `path`, `transferId`, `status`, `deleted`) stand out. The four scope checks are shown in order, each as Passed, Refused or Not reached (a word and a glyph), with the claims the token carried. An attended held call has Approve and Deny buttons. An unattended hold shows its reference, the hash it is bound to and its expiry, with Approve this exact call, Agent retries the exact call and Replay the same approval. The page reads the one-shot code from the server and sends it in the JSON body, and never prints it.
- **Audit trail.** The newest 100 entries and a Verify chain button. A failed verification shows `TAMPERED` with the first bad entry number and the reason. The API cannot tamper with the trail, so the UI tests and the e2e run feed the verify answer a failure to prove the display.
- **Diagram** (React Flow, boxes can be dragged; drawn from diagram-studio/1 data in `server/diagrams/`, fetched by name from `GET /api/diagrams/:name`; the server checks the files when it starts): agent, four scope layers, gateway policy, upstream tool, human approver, decision buffer, audit trail (a two-column arrangement under 600px). Simulate runs the selected scenario for real, then walks six steps that use that run's numbers, with Speed and Reset diagram controls. The story strip highlights the matching step.

The server serves `web/dist` itself with a same-origin CSP (`default-src 'self'`, no inline script, no `unsafe-eval`); the Host and CSRF guards apply to it too. The UI makes only same-origin requests with no credentials. The web CSS is the vendored shared stylesheet `web/src/styles/standalone-ui.css` (byte-for-byte from the AI-DEMO-Standalone parent) plus `web/src/app.css`, which uses tokens only.

## What each layer logged for this run (rule 27)

Under the Run result the page shows the family's shared run-observability panel (vendored and pinned in `web/src/run-observability/`, `server/src/runObservability.js`): one run, in time order, across the six layers, each row with its time and an origin tag. This lab reads no product log, so a row is `simulated` (Mock) or `response` (Real), never `logged`, and a layer with nothing to show says `not logged` and why.

- **Mock: one run is one scenario run.** Each decision the stub gateway makes is an audit entry, stamped once by the audit; the same entry is the row and the stdout line (the same time on both). Rows are never rebuilt by running the scenario again. **Agent** is the stub agent registry. **Person** is the end-user layer of the four scope layers: the end user is a name in the stub issuer's table, and nobody signs in. **Privilege** is this lab's own policy engine, a stand-in for Privilege (`policy.js`: the other scope layers, the rate limit, the rules, and the approvals). **Agent gateway** is what the stub gateway did with the call (let through, held, turned away): it follows from the policy engine's decision and is computed by no check of its own, so it is always `information` ("the decision above seen at the gateway"), and one decision is never counted twice. **Resource server** is the stub tool server's answer, only for a call that was really forwarded. **Authorize** is not logged: this lab never calls PingOne Authorize. A held call keeps its run open: the human's answer and the agent's retry join the run that made the call, until the approval is used; an event after that is on stdout only.
- **What the counts mean.** The panel's counts are check rows, not calls: one call makes several checks (the registry, the end-user layer, the policy engine), so a refused call shows one refusal plus the checks that passed before it. The registry and end-user passes are real results of the stub's own checks (the audit entry stores each scope layer's result, and the registry is consulted first), so they stay `allowed`.

| Outcome | What it is here |
| --- | --- |
| `allowed` | a check of the stub passed: the registry knows the agent, the end user holds the scope, a rule allows the call, a human approves an attended call |
| `refused` | an ordinary check refused the call: unknown agent or tool, a scope layer, a rule (injection, amount, no rule), a wrong approval code, an unusable approval presented on a retry (`approval-lapsed`, `approval-spent`, ...), a human's denial |
| `blocked` | the lab's own stop: the rate limit, a full approval queue, the fail-closed guard, three wrong codes, and a wait that ran out |
| `info` | a hold (neither a pass nor a refusal), an approval opened, a grant for the retry, an approval spent, the gateway row, the tool server's answer |

A lapsed approval is `refused` when it is presented on a retry (a policy decision on that call) and `blocked` when the wait itself ran out (the lab's own stop); both say `lapsed` in the stdout `cause`/`step`.
- **An expiry is noticed late.** The stub only notices that a wait ran out when something next looks (a poll, an answer), so the `blocked` row's time is when it noticed, the same time as its stdout line, and is never back-dated. The row says "ran out at <time>; the gateway noticed it only now" and carries `lapsedAt` and `noticedAt` in its detail.
- **Real: one gateway check is one run.** `POST /api/gateway-check` (tools/list, then a refusal probe through a real Privilege gateway with an agent key) is the only Real call. Each reply the lab received is one `response` row under Agent gateway, stamped when the lab had it: a 401 or 403, or a 200 carrying a JSON-RPC error or `isError`, is `refused`; a server error, any other status or an unreadable body is `information`; a call that did not complete is no reply and no row. A check whose refusal probe got no reply is shown as partial: the lane's reason names the missing probe (the record's `partial` flag is set, the lane keeps only the `tools/list` row) and the page says so under the panel. A refused `tools/list` means the probe is never sent, and the lane says that too. Person, Agent, Privilege and Resource server say they are not logged: the lab reads no gateway log, so it does not claim who decided inside the gateway. Scenarios still run through the in-process stub in every mode, so they are Mock runs and never appear in a Real answer. A run is returned only in the mode it was made in. **Not verified:** the shared hop `gatewayReal.js` keeps only an error's status and message and drops its error code, so the lab reads the replies it could not receive by the lab's own words (`MCP HTTP request timed out` or `unreachable`). A gateway's HTTP 200 JSON-RPC error whose message began with exactly that text would be read the same way, as "read as no connection", never as a pass; the real fix is in the shared hop and is not made here.
- **Where the run leaves logs.** One line per row on the lab's stdout: `<time> agent-gateway-inspector decision layer=<layer> step=<step> actor=<who> result=<passed|stopped|unclear|no-reply> cause=<cause> ref=<call or app> run=<id|-> mode=<mock|real>`; no credential, no approval code, and none of the words the family's log matchers read. **Time is when the lab recorded it** (the stub decided, or the lab had the reply), not a product's own time. The server's boot path writes the lines; a runtime made without a writer (the tests) is silent.
- **Where they can stream.** The container's stdout; the family log collector (`shared/ping-log-collector`) does not list this lab's container today, so nothing ships them. If it did, they would reach `demo-logs-<service>` and a SIEM with Docker's wall-clock time as `@timestamp`. Privilege's own logs (the gateway's `cyonproxy.log`, the SIEM index `ping-siem-events-v2`) are not read here.
- **Not logged today.** PingOne Authorize has no container log, and this lab does not call it. PingFederate's `audit.log` is not shipped. A gateway's refusal or block line shape is not confirmed. The PingOne audit reader does not exist. No `RUN_OBS_*` setting exists in this lab, and it mounts no Docker socket.
- **Reset** forgets the scenario runs (they are the stub engine's) and keeps Real gateway checks, which the engine's reset has no bearing on.
- **Routes.** `GET /api/run-observability[?runId=<id>]` is the record of one run in the current mode (the named run, else the newest; `{ "record": null, "message": ... }` when there is none; a bad id is a 400; any other method is a 405 with `Allow: GET`). `GET /api/run-observability/head[?runId=<id>]` is the cheap answer the page polls: it changes only when the run gets a row, and the record is read again then.

## API

`GET /api/health`, `GET /api/info`, `GET /api/run-observability`, `GET /api/run-observability/head`, `GET /api/diagrams/:name`, `GET /api/scenarios`, `POST /api/scenarios/:id/run`, `GET /api/calls`, `GET /api/calls/:id`, `POST /api/calls/:id/decision`, `POST /api/calls/:id/retry`, `GET /api/audit`, `GET /api/audit/verify`, `POST /api/reset`. The table is in [docs/architecture.md](docs/architecture.md). `GET /api/calls?since=<cursor>` is the polling-friendly feed: it returns what changed since the cursor and a new cursor.

## Safety in one paragraph

Binds `127.0.0.1` only; a wrong `Host` gets 421; a cross-origin or cross-site POST gets 403 and a non-JSON body 415, so another web page cannot run scenarios or approve a paused call; `Authorization`, `Proxy-Authorization` and `X-API-Key` headers are refused; the gateway can only forward to the running stub ports; every agent- or upstream-provided string is redacted and has its hidden characters shown as `[U+XXXX]`; the audit trail can be read but not written through the API. Cookie headers are not checked and never read.

## The release claim

Everything below is Ping's claim for the release dated 2026-11-02, UNVERIFIED on our tenant, and simulated here.

| Part | How it is tagged |
| --- | --- |
| The four scope layers (surface, application, action, end user) and their order | lab-invented / deck claim: no swagger field names exist for them |
| The hold outcome (the code's `pause`) and attended versus unattended | lab-invented / deck claim |
| The stub token tables (tokens, applications, end users) | lab-invented; there is no signature, issuer or lifetime |
| Approval reference, bound-to hash, expiry, grant window, decided, spent, spent by, denied by, expired | console swagger names `RequestID`, `FieldHash`, `ExpiresAt`, `GrantTTLSec`, `DecidedAt`, `ConsumedAt`, `ConsumedByRequestID`, `DeniedBy`, `ExpiredAt` (2026-10-31, schema only: the schema proves the name, not the behaviour); the hash method and what a retry must match are lab readings |
| Single use, bound to the exact call, an input never a bypass, an evaluation error denies | deck claims, simulated; the tests prove the simulation, not the product |
| `RequiredApprovals`, `RequireDistinctApprovers`, `Approvers`, `GrantShape`, `ApproverNotifications`, `RetiredAt`, `Hitl` on Jira, ServiceNow and Slack, `context.behaviour` | exist in the swagger; not modelled |

The console API did not rename: the object is still `NonHumanIdentity`; Federated Identity is a display name only, and this app uses neither. Why it matters (Ping's claims, paraphrased from slide 52): the challenge is that authorization sees only a tool name while the risk is in the amount, counterparty, destination and hour; the technical value is four layered scope checks read from the verified token plus a third outcome that holds for a person, with approvals that are inputs and never bypasses; the business value is that high-stakes agent actions become approvable without standing human review, which unblocks unattended agents in regulated processes.

## Packaging files

`content-pack.json` is the Learning Hub pack (`demo-content-pack/1`), generated from `content/terms.json` and `content/stories.json` by `npm run content-pack` (it also validates; do not hand-edit it). Its schema, `docs/content-pack.schema.json`, is a copy of the Learning Hub's `server/schema/content-pack.schema.json`. `docs/shelf-entry.json` is the Demo Shelf registry entry (port 5850, catalog id `D54`, a relative `composeFile`); `scripts/lib/shelf-registry-rules.mjs` is a copy of the shelf's validation rules, tested against the entry. The presenter script is [docs/talk-track.md](docs/talk-track.md).

## Verification

Carried over from the old repo and not re-run in full here, except where this README says a command was run in this repo: release claim work (2026-10-31) has level 1 tests for every row of the AI Policies (scope and HITL) feature test plan, each with a negative control: `server/test/scopelayers.test.js`, `hold.test.js`, `holdapi.test.js`, `policymutation.test.js`, `web/src/test/release.test.jsx` and the e2e script. `server/test/policymutation.test.js` mutates every editable policy field and no mutant survives except two listed equivalent ones. `node scripts/mutants.mjs` applies 31 source-level mutants to a copy of `server/` and every one was killed by a named test in the old repo (slow; not in `npm test`; not re-run here).

The UI tests were checked by mutation in the old repo: removing the pending-only gate on Approve, the hidden-character reveal, the tamper wording, `credentials: "omit"`, the decision word in the badge and the rule that keeps the approval code off the page each fail a test; so do removing the Host guard in front of the static files, adding `unsafe-eval` to the UI CSP and serving dotfiles.

## Layout

```
server/src/     the app (see docs/architecture.md)
server/diagrams/ the two diagram-studio/1 files the Diagram tab is drawn from (wide and narrow)
server/test/    node:test suites; tests use ports 5861-5867 and 5880-5899 only
web/            React + Vite UI (vitest + testing-library tests in web/src/test); styles/standalone-ui.css is the vendored shared stylesheet
scripts/        doctor.mjs, reset.mjs, smoke.mjs, e2e.mjs (Playwright), build/validate-content-pack.mjs, lib/shelf-registry-rules.mjs, compose, docs, repo, content-pack and shelf-entry tests
docs/           architecture.md, safety.md, talk-track.md, content-pack.schema.json, shelf-entry.json
content/        terms.json and stories.json, the source of content-pack.json
Dockerfile, docker-compose.yml   loopback-only publish (OrbStack: HOST_PORT=5850 docker compose up --build -d)
```

---

## Real mode: through the PingOne Privilege gateway

Real mode here is one live call through a PingOne Privilege gateway
(the origin you set in `AGI_GW_URL`) with an agent access key from the shared settings
file (`~/Development/.env`, or the file `STANDALONE_ENV` names).

**Privilege objects this lab uses:**

| Object | Value |
|---|---|
| Gateway | the origin in `AGI_GW_URL` (a PingOne Privilege gateway you can reach) |
| Agentic App | one named in `AGI_GW_APPS` (for example `aggregate-limited`), client path `/<app>/mcp` |
| Caller | agent access key `AGI_GW_KEY_LAB_AGENT` (write-only, never shown) |
| Backend | `aggregate` = the gateway's MCP aggregate over `opensearch` (9 tools) + `banking-mcp` (33 tools); `aggregate-limited` = the same members with a tool filter |

**What runs in Real:** the **Privilege gateway check** (`POST /api/gateway-check`, card on the
page) — one live `tools/list` through the Agentic App with the key, then one `tools/call` probe of a
tool no policy grants, so you see the gateway's own refusal shape. The gateway's words come
back unaltered (keys scrubbed). Settings keys: `AGI_GW_URL`, `AGI_GW_APPS`,
`AGI_GW_KEY_<NAME>` (optional `AGI_GW_VERSION`).
