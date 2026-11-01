import React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CallList from "../components/CallList.jsx";
import CallDetail from "../components/CallDetail.jsx";
import AuditPanel from "../components/AuditPanel.jsx";
import { call, paused, entry } from "./fixtures.js";

test("the call list shows allow, deny and pause as a word plus a glyph, newest first", () => {
  const calls = [call({ id: "call-0001" }), call({ id: "call-0002", decision: "deny", outcome: "blocked", reason: "scope_exceeded", ruleId: null }), paused({ id: "call-0003" })];
  render(<CallList calls={calls} selectedId="call-0002" onSelect={() => {}} />);
  const items = screen.getAllByRole("listitem");
  expect(items.map((li) => li.querySelector(".mono").textContent)).toEqual(["call-0003", "call-0002", "call-0001"]);
  expect(items[0].textContent).toMatch(/Hold for a human/);
  expect(items[1].textContent).toMatch(/Deny/);
  expect(items[2].textContent).toMatch(/Allow/);
  expect(items[0].textContent).toMatch(/Waiting for a human/);
  expect(items[1].querySelector("button").getAttribute("aria-current")).toBe("true");
  expect(items[1].querySelector('[aria-hidden="true"]').textContent).not.toBe("");
});

test("selecting a call works from the keyboard", async () => {
  const onSelect = vi.fn();
  render(<CallList calls={[call()]} selectedId={null} onSelect={onSelect} />);
  await userEvent.tab();
  await userEvent.keyboard("{Enter}");
  expect(onSelect).toHaveBeenCalledWith("call-0001", expect.any(HTMLElement));
});

test("an empty list says what to do", () => {
  render(<CallList calls={[]} selectedId={null} onSelect={() => {}} />);
  expect(screen.getByText(/No calls yet/)).toBeInTheDocument();
});

test("detail shows agent, tool, matched rule and why", () => {
  render(<CallDetail call={call()} onDecide={() => {}} />);
  const d = screen.getByTestId("detail");
  expect(d).toHaveTextContent("support-bot");
  expect(d).toHaveTextContent("tickets.read");
  expect(d).toHaveTextContent("allow-ticket-read");
  expect(d).toHaveTextContent("rule_allow");
  expect(d).toHaveTextContent('"ticketId": "T-100"');
});

test("a denied call shows no rule and the reason, and has no approve button", () => {
  render(<CallDetail call={call({ decision: "deny", outcome: "blocked", reason: "scope_exceeded", ruleId: null })} onDecide={() => {}} />);
  expect(screen.getByTestId("detail")).toHaveTextContent("scope_exceeded");
  expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
});

test("only a pending call offers approve and deny, and they call back with the decision", async () => {
  const onDecide = vi.fn();
  const { rerender } = render(<CallDetail call={paused()} onDecide={onDecide} />);
  await userEvent.click(screen.getByRole("button", { name: "Approve and forward" }));
  await userEvent.click(screen.getByRole("button", { name: "Deny" }));
  expect(onDecide.mock.calls).toEqual([["approve"], ["deny"]]);
  for (const outcome of ["forwarded", "expired", "denied_by_human"]) {
    rerender(<CallDetail call={paused({ outcome, pause: { state: outcome, ttlMs: 1, expiresAt: new Date().toISOString() } })} onDecide={onDecide} />);
    expect(screen.queryByRole("button", { name: "Approve and forward" })).toBeNull();
  }
});

test("the approval code is never printed on the page", () => {
  const { container } = render(<CallDetail call={paused()} onDecide={() => {}} />);
  expect(container.textContent).not.toContain("demo-code-1");
});

test("audit panel: a verified chain and a tampered chain both show in words", () => {
  const { rerender } = render(<AuditPanel entries={[entry(1), entry(2)]} size={2} verify={{ ok: true, length: 2, headSeq: 2, headHash: "ab".repeat(32) }} onVerify={() => {}} />);
  expect(screen.getByTestId("verify-result")).toHaveTextContent(/Chain verified: 2 entries, head #2/);
  rerender(<AuditPanel entries={[entry(1), entry(2)]} size={2} verify={{ ok: false, length: 2, firstBadSeq: 2, reason: "hash_mismatch" }} onVerify={() => {}} />);
  const r = screen.getByTestId("verify-result");
  expect(r).toHaveTextContent(/TAMPERED/);
  expect(r).toHaveTextContent("#2");
  expect(within(r).getByRole("alert")).toBeInTheDocument();
  expect(screen.getByTestId("verify-result").getAttribute("aria-live")).toBe("polite");
});

test("audit panel lists newest first and the verify button calls back", async () => {
  const onVerify = vi.fn();
  render(<AuditPanel entries={[entry(1), entry(2), entry(3)]} size={3} verify={null} onVerify={onVerify} />);
  const rows = screen.getAllByRole("row").slice(1);
  expect(rows.map((r) => r.querySelector("th").textContent)).toEqual(["3", "2", "1"]);
  await userEvent.click(screen.getByRole("button", { name: "Verify chain" }));
  expect(onVerify).toHaveBeenCalled();
});
