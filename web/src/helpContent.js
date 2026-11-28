// What the Help dialog says. Plain, and as hedged as the rest of the lab (rule 2): what was measured, what is simulated, what is UNVERIFIED.
export const HELP_SECTIONS = [
  {
    heading: "What this lab is",
    body: [
      "When AI agents call tools, something has to decide allow, deny or pause-for-a-human, and leave a record nobody can quietly edit. This lab shows that decision point with a stub gateway and stub tool servers on loopback. No real gateway, no tenant, nothing real is called."
    ]
  },
  {
    heading: "What is simulated, and what is UNVERIFIED",
    body: [
      "Simulated: the gateway, the scripted agents, the three tool servers, every number. The audit key lives in memory only.",
      "UNVERIFIED on our tenant: the Ping release claim (2026-11-02) — the four layered scope checks, the third \"hold for a human\" outcome, and approvals that work once and are bound to the exact call. The banner says so on every tab. The rules, the 500 limit, the 30 s hold and the 60 s grant window are this demo's own, not a product claim.",
      "Not proven: that a real gateway is safe, that injection detection is complete (it is a short list of English patterns plus hidden characters), or that the audit trail is anchored outside this process."
    ]
  },
  {
    heading: "How to use the page",
    body: [
      "Two views: Inspector and Diagram (buttons in the header nav).",
      "1. In \"Run a scenario\", pick a Scenario (\"Benign call\", \"Scope-exceeding call\", \"Prompt-injected tool argument\", \"Rate burst\", \"Paused, then approved\", \"Paused, then expired\", the \"Scope layer\" and hold scenarios) and press Run.",
      "2. Optionally tick \"Wait for me to answer a held call\" before Run.",
      "3. Calls list on the left, call detail on the right. For a held call press \"Approve and forward\" or deny; for an unattended hold use \"Approve this exact call\", then \"Agent retries the exact call\", then try \"Replay the same approval\" — refused.",
      "4. In the Audit trail panel press \"Verify chain\"; every decision is hash-chained inside this process.",
      "5. Diagram tab: press Simulate, drag boxes if you like.",
      "6. Press P for presenter mode (the banner and mode stay); Esc leaves."
    ]
  },
  {
    heading: "Mode honesty",
    body: [
      "Mock only. The header chip says \"Mode: Mock\" and the banner says \"Mock mode.\" Pressing Live is refused with the server's reason: there is no live gateway to talk to, so no live path until the release is on our tenant.",
      "The approver here is whoever can reach the page; a real one is a separate, authenticated channel. The page never prints the approval code."
    ]
  },
  {
    heading: "Where the field names come from",
    body: [
      "Console swagger names (schema only — they prove the name exists, not the behaviour): RequestID, FieldHash, ExpiresAt, GrantTTLSec, ConsumedAt and friends. Lab-invented, no swagger field: the four scope layers, the hold outcome, the stub token tables. The call detail's \"Where these field names come from\" section says the same."
    ]
  }
];
