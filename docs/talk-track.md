# Talk track (4-6 minutes)

Start: `npm run build && npm start`, open http://127.0.0.1:5850/ on the Inspector tab, with a fresh Reset.

> **Say this first on every run:** the banner at the top starts "Mock mode." and then reads "Ping release claim (2026-11-02), UNVERIFIED on our tenant". The four scope layers, the hold outcome and the single-use approvals are what Ping's release is claimed to do. This app simulates them. The header shows "Mode: Mock" and the banner says "Mock mode."; press Live to show that it is refused, because there is no live gateway and no live path until the release is on our tenant. Press P for presenter mode (the banner and the mode stay), Esc to leave.

## Pitch

"When AI agents call tools, something has to decide allow, deny or pause for a human, and leave a record nobody can quietly edit. This simulator shows that decision point, with scripted agents and stub tools, so you can see every outcome in under five minutes."

## Live steps

1. **Orient (20s).** Point at the "Mode: Mock" chip in the header, the call list on the left, call detail on the right. Say: "Everything here is simulated and local. No real gateway, no tenant." Press Live in the header toggle: a note says Live is refused and the page stays in Mock (the chip and the banner still say Mock). Press P for presenter mode: the mode chip and the banner stay, the toggle, Reset and theme buttons go; Esc leaves.
2. **Allow.** In the Scenario picker choose "Benign call", press Run. Click the call. Say: "A support agent reads a ticket it is entitled to. Allow, forwarded, and the rule that matched is shown."
3. **Deny on scope.** Choose "Scope-exceeding call", Run. Say: "Same agent tries to move money. It never held that scope, so no rule is even consulted."
4. **Deny on injection.** Choose "Prompt-injected tool argument", Run. Open the detail. Say: "Instruction-like text in an argument is denied before the tool sees it. Note the text is shown inert, hidden characters as chips."
5. **Rate limit.** Choose "Rate burst", Run. Say: "A runaway loop: five pass, two are denied."
6. **Pause and approve.** Leave "Hold a paused call for me to answer" ticked. Choose "Paused, then approved", Run, click the held call, press "Approve and forward". Say: "Above the 500 limit the gateway holds the call for a human (the code calls this outcome pause). A human answers with a one-shot code; only then does it reach the tool. The page never prints the code."
7. **Pause and expire.** Choose "Paused, then expired", untick the hold box, Run. Say: "Nobody answers, the pause expires, a late approval is refused."
8. **Audit.** In the Audit trail panel press "Verify chain". Say: "Every decision is hash-chained, so editing or deleting an entry is detected."
9. **Diagram.** Open the Diagram tab, press Simulate, optionally drag a box. Say: "Agent, gateway policy, tool, approver, buffer, audit trail, with this run's real numbers." (The boxes and arrows are diagram-studio data, so they can be reshaped in the studio without touching code.)
10. **Four scope layers (release claim).** Choose "Scope layer 1: wrong surface", Run, open the call. Say: "Four checks read the token before any rule: surface, application, action, end user. The first that fails refuses the call; the rest show Not reached. Here the injection text in the arguments was never even read." Then "Scope layer 2" and "Scope layer 4": "Same agent, same scope. The application is not registered for the tool, or the person the token acts for may not do it." The action layer is "Scope-exceeding call" from step 3.
11. **Hold for a human, unattended (release claim).** Choose "Unattended hold, approved, retried once", leave the hold box ticked, Run. Say: "No human is in the session, so the gateway keeps no connection open. It refused at once with a reference and an expiry." Press "Approve this exact call", then "Agent retries the exact call". Say: "Approving forwarded nothing. The approval is bound to a hash of the exact call and works once." Press "Replay the same approval": "Refused. A second replay of the same approval never works."
12. **Bound to the exact call.** Untick the hold box and run "An approval is bound to the exact call": "The agent retried with 901 instead of 900 and was refused. The approval was still unspent, so the exact call then went through."
13. **Close.** Say what to try next, then reset (below).

## If asked: honesty lines

- Simulated: the gateway, the agents, the three tool servers and every number. The audit key lives in memory only.
- UNVERIFIED: any claim that this matches a specific product's behaviour, formats or limits, and above all everything about the four scope layers, the hold outcome and single-use approvals (Ping release claim, 2026-11-02). The rules, the 500 limit, the 30 s hold and the 60 s grant window are this demo's own.
- Not proven: that a real gateway is safe, that injection detection is complete (it is a short list of English patterns plus hidden characters), or that the audit trail is anchored outside this process.
- The approver here is whoever can reach the page; a real one is a separate, authenticated channel.

## Why it matters (Ping's claims, UNVERIFIED on our tenant)

Paraphrased from the deck's value panel for slide 52. Put the Challenge first.

- **Challenge.** Authorization sees only a tool name, but the risk is in the amount, counterparty, destination and hour.
- **Technical value.** Four layered scope checks read from the verified token, plus a third outcome that holds for a person; approvals are inputs, never bypasses.
- **Business value.** High-stakes agent actions become approvable without standing human review, which unblocks unattended agents in regulated processes.

## Where the names come from (say it if asked)

- Console swagger names (2026-10-31, schema only, so they prove the name exists, not the behaviour): `RequestID`, `FieldHash`, `ExpiresAt`, `GrantTTLSec`, `DecidedAt`, `ConsumedAt`, `ConsumedByRequestID`, `DeniedBy`, `ExpiredAt` on the approval objects. The call detail has a "Where these field names come from" section that says so.
- Lab-invented, no swagger field: the four scope layers, the hold outcome, attended versus unattended, the stub token tables. Lab reading: how the hash is computed and what a retry must match.
- Not modelled: more than one approver, approver notifications, the Jira, ServiceNow and Slack hooks, and the behaviour attribute. The console API did not rename: the object is still `NonHumanIdentity`.

## Likely questions

1. **Is this a real gateway?** No. A stub driven by scripts, loopback only.
2. **Can it catch every prompt injection?** No. A clean result means nothing matched.
3. **Can the audit trail be tampered with?** Not through the API; editing in memory is detected by Verify chain, but there is no external anchor.
4. **What if nobody approves?** The hold expires after 30 seconds and the call is never forwarded. An approval that is given but not used expires after 60 seconds.
5. **Can another web page approve a call?** No. Cross-origin requests get 403 and wrong Host headers get 421.
6. **Is the token real?** No. It is a lookup in a table this lab owns: no signature, issuer or lifetime.
7. **What if the policy errors?** The call is denied. There is no scenario for it because nothing a scripted agent sends can make the evaluator fail; a test injects a failing one.

## Reset before the next demo

Press Reset in the header (clears calls, holds, approvals and the audit trail, and starts a new audit epoch), and press Reset diagram on the Diagram tab to put the boxes and the view back. Confirm the call list says "No calls yet", select "Benign call" again and, if you changed it, tick the hold box. If the server was restarted or a port was busy, run `npm run doctor`.
