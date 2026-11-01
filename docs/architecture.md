# Architecture

Agent Gateway Inspector is an inspector for an AI/agent gateway that makes allow / deny / pause decisions on agent tool calls. This repository holds the server core and the web UI (`web/`).

> **Ping release claim (2026-11-02), UNVERIFIED on our tenant.** The four scope layers, the third outcome (hold for a human, shown by the code as `pause`) and the single-use, call-bound approvals described below are what Ping's release is claimed to do (deck slide 52). They are simulated here. Our tenant has an earlier version of the gateway, so there is no live path: the header has a Mock/Live toggle and Live is refused. Names marked *lab-invented* have no field in the console swagger; names marked *console swagger name* exist there (2026-10-31, schema only: the schema proves the name, not the behaviour).

Nothing real is involved. The gateway is a stub that runs inside the server process; the agents are scripts; the tool servers behind it are three tiny HTTP servers on loopback.

```
 scripted agent  -->  stub gateway  -->  policy engine  -->  allow  -->  stub upstream (127.0.0.1:5851-5853)
 (scenarios.js)       (gateway.js)       (policy.js)         deny   -->  blocked, never forwarded
                           |                                 pause  -->  hold for a human (approve / deny / expire; unattended: refused with a reference)
                           v
              decision buffer (bounded ring)      audit trail (append-only, HMAC hash chain)
```

## Ports

| Port | Use |
| --- | --- |
| 5850 | the API (`PORT` to change; 5850-5899 only) |
| 5851 | stub upstream `tickets` (`tickets.read`) |
| 5852 | stub upstream `payments` (`payments.read`, `payments.transfer`) |
| 5853 | stub upstream `files` (`files.read`, `files.delete`) |
| 5854-5859 | reserved for more stubs |
| 5860 | Vite dev server (`npm run dev`) |
| 5870 | end-to-end script (`npm run e2e`) |
| 5861-5867 | tests (static and upstream test slices) |
| 5880-5899 | tests, through a free-port helper that gives each test file its own slice |

## Files (`server/src/`)

| File | Role |
| --- | --- |
| `safety.js` | Port range, loopback checks, the Host guard, the CSRF (Origin / Sec-Fetch-Site / JSON-only) guard, the credential guard, the one function that decides where a call may be forwarded. |
| `policy.js` | The policy engine: registered agents and their scopes, the tool catalog, the stub token issuer tables (tokens, applications, end users), the rules, `evaluate()`. Pure, no I/O. |
| `approval.js` | What an approval is bound to: `callHash()`, a hash of the canonical call, and the hold reference format. |
| `gateway.js` | The stub gateway: rate limit, decision, forwarding, pauses, the decision buffer, the polling cursor. |
| `audit.js` | The append-only audit trail with an HMAC hash chain and `verify()`. |
| `upstreams.js` | The three stub upstream servers and `forwardTo()`, the gateway's only way out. |
| `scenarios.js` | The twelve scripted agent scenarios and their expected decisions. |
| `runtime.js` | Wires upstreams, gateway and a scenario queue together. Always mock. |
| `config.js`, `settings.js` | The Mock/Live mode and its guards (Live is refused), and the shared settings file reader (`~/Development/.env`, `STANDALONE_ENV`), which takes only `GATEWAY_INSPECTOR_MODE`. |
| `diagramData.js`, `diagramStudioValidate.js` | Loads and checks the two diagram-studio/1 files in `server/diagrams/` when the server starts (a bad file refuses the start) and looks one up by name from an allow-list. The validator is a copy of the diagram-studio one, unchanged. |
| `app.js`, `index.js` | The Express app and the boot script. |
| `sanitize.js`, `redaction.js` | Make every agent- or upstream-supplied string inert and redact secret-looking text. |
| `doctor.js`, `health.js` | The preflight checks and `GET /api/health` (`demo-health/1`). |

## The decision

`evaluate()` runs these checks in a fixed order and the first that applies decides:

1. The agent must be in the registry, else `deny unknown_agent`. A call never carries its own scopes; the registry grants them.
2. The tool must be in the catalog, else `deny unknown_tool`.
3. The arguments must be a plain object, else `deny bad_arguments`.
4. The token is read. A call may name a token (`tokenId`) but never carries claims; the claims come from the issuer table in `policy.js` and the token must belong to the calling agent, else `deny token_invalid`. Then **four layered scope checks** (lab-invented names), in this order, the first that fails decides and the later ones are reported as not reached:
   1. surface: the token is valid on the surface the call arrived on, else `deny scope_surface`;
   2. application: the token's application is registered for the tool, else `deny scope_application`;
   3. action: the agent holds the tool's scope, else `deny scope_exceeded` (this is the old scope check; no rule can grant a scope);
   4. end user: the user the token acts for holds the tool's scope, else `deny scope_end_user`.
5. The agent must be under the rate limit (5 calls per 10 s per agent), else `deny rate_limited`.
6. Rules (`policy.js`, `RULES`): every rule that matches the agent, the tool and its argument conditions is collected, and the strongest effect wins: deny, then pause, then allow.
7. If no rule matched: `deny default_deny`.

All four scope checks run before any rule and before the rate limit: a call refused at the surface is never inspected for injection text. The gateway wraps this in a fail-closed guard: if `evaluate()` throws, or returns anything that is not `allow`, `deny` or `pause` with a reason, the call is denied as `evaluation_error`.

`evaluate()` returns the layer results (`pass`, `fail` or `skipped`) and the claims it read (`subject`, `application`, `surface`, `endUser`, `attended`). The claim holding the token id is called `subject` because the redactor hides any field whose name contains `token`.

Rule conditions are on named arguments (`gt`, `gte`, `lt`, `lte`, `eq`, `under` for a directory), plus `injection`, which looks at every string anywhere in the arguments. A condition on an argument that is missing never matches. The rules are code; no API route edits them.

## Pause: hold for a human (human in the loop)

The third outcome is the `pause` decision, shown to people as "hold for a human" (lab-invented name). Whether a human is present is a claim of the token, `attended`. An **attended** pause is the original behaviour below. An **unattended** one is described in the next section.

An attended `pause` decision does not forward the call. It opens a pending record with a random one-shot approval code and an expiry (30 s). The agent's response never carries the code. The approver reads it with `GET /api/calls/:id` and answers with `POST /api/calls/:id/decision` and the code. The code is consumed by the first correct use; the call changes state to `forwarding` before the upstream is contacted, so two simultaneous approvals forward once. Three wrong codes lock the pause. A pause past its expiry becomes `expired`; a late approval with the right code is refused (409). At most 20 calls can be pending; a further would-be pause is denied (`pause_queue_full`).

Outcomes of a call: `forwarded`, `blocked`, `pending`, `held`, `expired`, `denied_by_human`, `upstream_error`.

## Unattended hold and the single-use, call-bound approval

When the token says `attended: false` the gateway keeps **no connection open**: `handle()` returns at once, outcome `held`, nothing forwarded, with a `hold` object: a reference (`hold-` plus 16 hex characters), an expiry (30 s), the state and a hash of the exact call. A test proves the response arrives without waiting for anyone.

1. A human answers `POST /api/calls/:id/decision` with the same one-shot code as above. **Approve forwards nothing.** It moves the hold to `approved` and opens a grant window (60 s).
2. The agent retries the call, presenting the reference (the lab's `POST /api/calls/:id/retry` is the simulated agent re-sending exactly what it first sent; it takes no body, so nothing can be changed from the API).
3. The retry is evaluated like any call: layers, rate limit, rules. Only if the verdict is again a hold does the approval apply. It is checked in this order, and the first failure denies the retry: unknown reference (`approval_unknown`), already used (`approval_consumed`), expired (`approval_expired`), no human answer yet (`approval_pending`), denied or locked (`approval_denied`), not the same call (`approval_mismatch`: the hash of agent, tool, token and every argument must match).
4. If it matches, the approval is spent before anything is awaited (so simultaneous retries forward once) and the retry is allowed with reason `hold_approved`.

A refusal never spends the approval; a changed call is refused and the exact call can still go through. An approval cannot turn a deny into an allow: a retry the policy now denies (for example rate limited, or on a surface the token lacks) stays denied. An approval presented on a call that is not held changes nothing. A spent hold that scrolls out of the buffer is refused as unknown. Reset forgets every hold.

The hash is lab-invented in method (SHA-256 over a canonical JSON form with sorted keys, built with `Object.entries`, never by indexing with a user key, nesting limited to 64 levels: deeper arguments are denied as `evaluation_error` rather than held).

| Field shown by the lab | Console swagger name (2026-10-31, schema only) | Note |
| --- | --- | --- |
| `hold.ref` | `RequestID` on `imodelAgentApprovalSpec` | name only; the lab's format |
| `hold.argsHash` | `FieldHash` | lab reading: a hash of the bound call |
| `hold.expiresAt` | `ExpiresAt` | |
| `hold.grantTtlSec` | `GrantTTLSec` | |
| `hold.decidedAt` | `DecidedAt` on `imodelAgentApprovalStatus` | |
| `hold.consumedAt`, `hold.consumedByCallId` | `ConsumedAt`, `ConsumedByRequestID` | |
| `hold.deniedBy` | `DeniedBy` | the lab only ever records `human` |
| `hold.expiredAt` | `ExpiredAt` | |
| not modelled | `RequiredApprovals`, `RequireDistinctApprovers`, `Approvers`, `GrantShape`, `ApproverNotifications` (new), `RetiredAt` (new), `Hitl` on Jira, ServiceNow and Slack specs (new), the `context.behaviour` policy attribute | one approver, one approval; no notifications |
| the four scope layers, the hold outcome, attended versus unattended, the token tables | none | **lab-invented / deck claim**: the swagger has no field for them |

The console API did not rename: the API object is still `NonHumanIdentity`; Federated Identity is a display name only. This app uses neither.

## Decision buffer and polling

The decision buffer is a ring of 200 call records (the oldest non-pending one is dropped first). Each change to a call bumps a global revision. `GET /api/calls?since=<cursor>` returns the calls that changed after that revision and a new `cursor`; `epoch` increases on every reset so a client can tell its cursor is stale.

## Audit trail

Every step is appended: `decision` (with the layer results and the token subject), `forwarded`, `upstream_error`, `pause_opened`, `pause_approved`, `pause_denied`, `pause_bad_code`, `pause_locked`, `pause_expired`, the same five for unattended holds with `hold_` in place of `pause_`, `hold_consumed`, `reset`. Each entry has `hash = HMAC-SHA256(key, canonical JSON of {seq, at, type, callId, data, prevHash})`. The key is random per process and never leaves it. `GET /api/audit/verify` recomputes the chain and reports `ok` or the first bad sequence number with a reason (`hash_mismatch`, `chain_broken`, `sequence_gap`). The trail is capped at 2000 entries; dropping the oldest re-anchors the chain so the rest still verify.

The API exposes the trail with `GET` only. `POST /api/reset` is the one operator action that discards history; it starts a new epoch whose first entry (`reset`) records the head hash and length of the chain it discarded.

## Scenarios

| Id | Agent | What happens | Ends in |
| --- | --- | --- | --- |
| `benign` | support-bot | reads a ticket it may read | `allow`, forwarded |
| `scope-exceeding` | support-bot | tries `payments.transfer` | `deny scope_exceeded` |
| `prompt-injection` | support-bot | passes "ignore previous instructions ..." in an argument | `deny prompt_injection` |
| `rate-burst` | support-bot | seven calls at once | five forwarded, two `deny rate_limited` |
| `paused-approved` | finance-agent | 900 transfer, above the 500 limit | `pause`, approved by the script with the real code, forwarded |
| `paused-expired` | finance-agent | 750 transfer | `pause`, nobody answers, expires, late approval refused |
| `surface-denied` | support-bot | a token for the MCP surface presented on the LLM surface, with injection text in the arguments | `deny scope_surface` (layer 1; the rules never read the arguments) |
| `application-denied` | finance-agent | `tickets.read` with the finance application's token | `deny scope_application` (layer 2) |
| `end-user-denied` | finance-agent | a 50 transfer with a token acting for an analyst who may only read payments | `deny scope_end_user` (layer 4) |
| `hold-unattended` | finance-agent | 900 transfer with an unattended token | `pause` held with a reference; approved; the exact retry is `allow hold_approved`, forwarded once |
| `hold-replay-refused` | finance-agent | the same, then the approval used again | second retry `deny approval_consumed` |
| `hold-args-changed` | finance-agent | the same, retried with 901, then with 900 | `deny approval_mismatch`, then `allow hold_approved` (the refusal did not spend it) |

`scope-exceeding` above is the action layer (layer 3). Evaluation error has no scenario: nothing a scripted agent can send makes the evaluator fail, so it is tested by giving the gateway an evaluator that throws (`server/test/hold.test.js`), not by pretending.

A run with `{ "hold": true }` leaves a pause or hold waiting so a person or an API client can answer it; for the hold scenarios the agent's retries are then not run (use the retry route or the Retry button).

## Web UI (`web/`)

React + Vite, built to `web/dist`, which `createApp()` serves with `express.static` after the Host and Origin guards (so the guards cover static files too). The UI CSP (`UI_CSP` in `app.js`) allows same-origin scripts, styles (inline styles for React Flow), images and fetches only; API responses keep `default-src 'none'`. `startHttpServer()` passes `web/dist`; `createApp()` defaults `webDist` to `null` (no static serving), so the API tests never depend on a build. A missing `web/dist` leaves `GET /` a JSON 404.

Every tab carries a banner: "Ping release claim (2026-11-02), UNVERIFIED on our tenant" (the same banner shows in presenter mode, and it names the mode: "Mock mode."). The call detail shows the four scope checks with a word and a glyph for each, the token's claims, and for a hold its reference, bound-to hash, expiry, the Approve and Deny buttons, the agent's retry and the replay. The diagram is diagram-studio/1 data (see "The diagram" below). It has a "Four scope layers" box between the agent and the gateway policy and walks six steps; under 600px wide it uses a two-column arrangement so the text stays above 10px.

The page polls `GET /api/calls` and `GET /api/audit` every 2 seconds and after each action. Selecting a call reads `GET /api/calls/:id`; for a pending call that includes the approval code, which the page sends back in the JSON body of `POST /api/calls/:id/decision` and never renders. Simulate is `POST /api/scenarios/:id/run` with `{"hold": false}` followed by a client-side walk through the returned calls.

## The diagram

The flow diagram (rule 17) is data, not code. `server/diagrams/gateway-flow.json` (one row) and `server/diagrams/gateway-flow-narrow.json` (two columns, used under 600px) are `diagram-studio/1` files: seven boxes, seven arrows, five groups and six steps. `server/src/diagramData.js` reads and validates both with the studio's own validator when the server starts, and also checks the two things the format has no field for: `edge.ports` (which side of a box an arrow leaves and enters) and `step.nodes` (the boxes a step lights, including a step with no arrow). It also checks that the two files describe the same boxes, arrows and steps. A bad file stops the server from starting; `npm run doctor` reports it. The Docker image copies `server/diagrams`.

`GET /api/diagrams/:name` serves a file by name. The name is matched against a fixed list of two names, never used to build a path; an unknown name, a `__proto__` or `constructor` name or a name with odd characters gets a JSON 404 that does not repeat what was asked for.

`web/src/components/Flow.jsx` fetches both names, normalizes the data (`web/src/lib/diagram.js`) and hands it to React Flow. It builds no node or edge itself. The six step texts still come from the run (Simulate runs the scenario for real, and the captions use its numbers); the data says which boxes and arrows each step can light, and the run decides which of those it really used (for example the arrow to the human approver only lights when a call was held). To change the diagram, edit the JSON in both files, or open one in diagram-studio, and keep the two in step: the loader refuses files that disagree.

## API

| Route | Does |
| --- | --- |
| `GET /api/health` | `demo-health/1`, `runtime: offline`. |
| `GET /api/info` | The mode (`mock`), the mode the settings asked for, and whether Live can be selected (it cannot, and which guards fail). |
| `GET /api/diagrams/:name` | One diagram-studio/1 file, by name: `gateway-flow` (wide) or `gateway-flow-narrow` (under 600px). Any other name is a JSON 404 that does not repeat it. |
| `GET /api/scenarios` | The twelve scenarios. |
| `POST /api/scenarios/:id/run` | Runs one. Body is empty or `{ "hold": true\|false }`. Returns the calls, the expected decisions and `matched`. One may wait, a third gets 429. |
| `GET /api/calls?since=&limit=` | The decision buffer, changed since a cursor. No approval codes. |
| `GET /api/calls/:id` | One call. A pending call or hold includes its approval code. |
| `POST /api/calls/:id/decision` | `{ "decision": "approve"\|"deny", "approvalCode": "..." }`. 200, 400, 403 (bad code), 404, 409 (not pending or expired). |
| `POST /api/calls/:id/retry` | The simulated agent retries a held call exactly as first sent, presenting its reference. No body. 200 with the new call (allowed or refused), 400, 404, 409 (`not_held`). |
| `GET /api/audit?after=&limit=` | Audit entries. |
| `GET /api/audit/verify` | Verifies the chain. |
| `POST /api/reset` | Clears the buffer, pauses and rate state, starts a new audit epoch. No body. |
