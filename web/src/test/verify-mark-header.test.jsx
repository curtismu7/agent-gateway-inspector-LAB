import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App.jsx";

// The header shows this lab's own Verified / In progress mark, read from the same /api/shelf call the Shelf link makes (through the lab-proxy
// that call reaches the shelf, whose payload lists every demo with its mark). The lab's own /api/shelf has no demos, so there is no mark then.
const json = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
const mark = (status, label, extra = {}) => ({ status, label, note: "", updatedAt: "2026-11-15", source: "shipped", ...extra });

function fakeApi(shelf) {
  globalThis.fetch = vi.fn((url) => {
    if (url === "/api/shelf") return shelf === null ? json({ error: "x" }, 500) : json(shelf);
    if (url === "/api/health") return json({ schema: "demo-health/1", state: "ready" });
    if (url === "/api/info") return json({ mode: "mock", source: "mock", requested: "mock", modes: ["mock", "live"], live: { available: false, failed: ["live-gateway"], needs: ["x"] }, realAvailable: false, realReason: "Real is not available in this lab." });
    if (url === "/api/scenarios") return json({ scenarios: [] });
    if (url.startsWith("/api/calls?")) return json({ calls: [], cursor: 1, epoch: 1 });
    if (url === "/api/audit?limit=500") return json({ entries: [], size: 0, headSeq: 0 });
    if (url === "/api/audit/verify") return json({ ok: true, length: 0, headSeq: 0, headHash: "" });
    return json({ error: "not_found" }, 404);
  });
}

afterEach(() => { vi.restoreAllMocks(); });

test("shows this lab's own mark beside the Shelf link, and no other lab's", async () => {
  fakeApi({ shelfUrl: "http://shelf.example", demos: [{ id: "other-lab", verification: mark("in-progress", "In progress") }, { id: "agent-gateway-inspector", verification: mark("verified", "Verified", { note: "Every scenario run on the mock" }) }] });
  render(<App />);
  const bar = within(await screen.findByTestId("top-menu"));
  expect(await bar.findByText("Verified")).toBeInTheDocument();
  expect(await bar.findByRole("link", { name: "Shelf" })).toBeInTheDocument();
  expect(bar.queryByText("In progress")).toBeNull();
  expect(document.querySelectorAll(".verify")).toHaveLength(1);
  expect(bar.getByText("Verified").closest(".verify")).toHaveAttribute("title", expect.stringContaining("Every scenario run on the mock"));
});

test("shows an In progress mark for this lab", async () => {
  fakeApi({ shelfUrl: "http://shelf.example", demos: [{ id: "agent-gateway-inspector", verification: mark("in-progress", "In progress") }] });
  render(<App />);
  const bar = within(await screen.findByTestId("top-menu"));
  expect((await bar.findByText("In progress")).closest(".verify")).toHaveAttribute("data-status", "in-progress");
});

test("shows nothing when the lab is on its own port ({shelfUrl} only), the shelf has no mark for it, or the shelf is unreachable", async () => {
  for (const payload of [{ shelfUrl: "http://shelf.example" }, { shelfUrl: "http://shelf.example", demos: [{ id: "agent-gateway-inspector", verification: null }] }, { shelfUrl: "http://shelf.example", demos: [{ id: "agent-gateway-inspector", verification: mark("none", "") }] }]) {
    fakeApi(payload);
    const { unmount } = render(<App />);
    const bar = within(await screen.findByTestId("top-menu"));
    expect(await bar.findByRole("link", { name: "Shelf" })).toBeInTheDocument(); // the shelf answered, and still no badge
    expect(document.querySelector(".verify")).toBeNull();
    unmount();
  }
  fakeApi(null);
  render(<App />);
  await screen.findByTestId("top-menu");
  await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith("/api/shelf", expect.anything()));
  await new Promise((r) => setTimeout(r, 50));
  expect(document.querySelector(".verify")).toBeNull();
});

test("the badge line is in App.jsx: removing it fails this test", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const src = fs.readFileSync(path.resolve(process.cwd(), "src/App.jsx"), "utf8");
  expect(src).toMatch(/<VerifyMark id="agent-gateway-inspector" \/>/);
});

// Class clash: the vendored VerifyMark.css styles a generic `.verify` class for the header badge. This lab's own audit chain status line must not use it
// (its border, padding and bold would restyle the badge, and the badge's flex rules would restyle the line): it is `.audit-verify`.
test("the audit chain line does not share the badge's `verify` class: exactly one element has it while both are on screen", async () => {
  fakeApi({ shelfUrl: "http://shelf.example", demos: [{ id: "agent-gateway-inspector", verification: mark("verified", "Verified") }] });
  render(<App />);
  const bar = within(await screen.findByTestId("top-menu"));
  expect(await bar.findByText("Verified")).toBeInTheDocument();
  await userEvent.click(await screen.findByRole("button", { name: "Verify chain" }));
  const line = await waitFor(() => {
    const el = document.querySelector(".audit-verify--ok");
    expect(el).not.toBeNull();
    return el;
  });
  expect(line).toHaveClass("audit-verify");
  expect(line).not.toHaveClass("verify");
  expect(document.querySelectorAll(".verify")).toHaveLength(1);
  expect(bar.getByText("Verified").closest(".verify")).not.toBeNull();
  expect(screen.getByTestId("verify-result")).toHaveTextContent(/Chain verified/);
});

test("this lab's app.css and AuditPanel.jsx do not define or use the bare `.verify` classes (they belong to the vendored badge)", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const css = fs.readFileSync(path.resolve(process.cwd(), "src/app.css"), "utf8");
  expect(css).not.toMatch(/(^|[\s,}])\.verify(--[a-z]+|__[a-z]+)?\s*[{,:[]/m);
  expect(css).toMatch(/\.audit-verify\s*\{/);
  const panel = fs.readFileSync(path.resolve(process.cwd(), "src/components/AuditPanel.jsx"), "utf8");
  expect(panel).not.toMatch(/className="(?:[^"]*\s)?verify(?:--[a-z]+)?(?:\s|")/);
});
