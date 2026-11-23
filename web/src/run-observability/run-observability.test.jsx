// RunObservability tests (vitest + Testing Library + jsdom). Run where the folder is vendored
// (web/src/run-observability/, next to web/src/components/JsonPane.jsx).
import { render, screen, within, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import RunObservability from "./RunObservability";
import { setJsonView } from "../components/JsonPane";
import { mockRecord, realRecord, longRecord, emptyRecord, partialRecord, errorRecord, streams } from "./fixtures";

beforeEach(() => setJsonView("raw"));

describe("RunObservability", () => {
  test("always says it is an excerpt with masked ids, tokens and addresses", () => {
    render(<RunObservability record={null} source="mock" />);
    expect(screen.getByText("Excerpt of this run's logs. Ids, tokens and addresses are masked.")).toBeInTheDocument();
  });

  test("no record yet: an explicit empty state, no table", () => {
    render(<RunObservability record={null} source="real" />);
    expect(screen.getByTestId("ro-empty")).toHaveTextContent(/Run the demo/);
    expect(screen.queryByTestId("ro-table")).toBeNull();
  });

  test("a failed collection (structured JSON error) is shown as an alert, never as an empty table", () => {
    render(<RunObservability record={errorRecord} source="real" />);
    expect(screen.getByRole("alert")).toHaveTextContent(/could not be collected/);
    expect(screen.getByRole("alert")).toHaveTextContent(/endedAt is before startedAt/);
    expect(screen.queryByTestId("ro-table")).toBeNull();
  });

  test("a record from the other mode is refused, not shown under the wrong label", () => {
    render(<RunObservability record={mockRecord} source="real" />);
    expect(screen.getByTestId("ro-mismatch")).toHaveTextContent(/mock mode but the page is in real mode/);
    expect(screen.queryByTestId("ro-table")).toBeNull();
  });

  test("every layer unreachable: six Unreachable chips with the reason, and a no-rows line", () => {
    render(<RunObservability record={emptyRecord} source="real" />);
    for (const id of ["person", "agent", "authorize", "privilege", "gateway", "resource"]) {
      expect(screen.getByTestId(`ro-coverage-${id}`)).toHaveTextContent("Unreachable");
      expect(screen.getByTestId(`ro-reason-${id}`)).toHaveTextContent(/RUN_OBS_ES_URL and RUN_OBS_ES_READ_APIKEY/);
    }
    expect(screen.getByTestId("ro-no-rows")).toBeInTheDocument();
    expect(screen.getByTestId("ro-summary")).toHaveTextContent("No log lines in this excerpt.");
  });

  test("mock: says the rows are simulated, every origin chip reads simulated, and information is counted apart from a pass", () => {
    render(<RunObservability record={mockRecord} source="mock" />);
    expect(screen.getByTestId("ro-basis")).toHaveTextContent(/None of them was read from a product log/);
    const table = screen.getByTestId("ro-table");
    const origins = within(table).getAllByText(/^(simulated|not logged)$/).map((e) => e.textContent);
    expect(origins.filter((o) => o === "simulated")).toHaveLength(5);
    expect(within(table).queryByText("logged")).toBeNull();
    expect(screen.getByTestId("ro-summary")).toHaveTextContent("2 allowed, 1 refused, 1 blocked, 1 for information (information is not a pass)");
    expect(screen.getByTestId("ro-coverage-person")).toHaveTextContent("Simulated");
    expect(screen.getByTestId("ro-coverage-authorize")).toHaveTextContent("Not logged");
  });

  test("real: logged rows show the log line's own timestamp to the nanosecond; a not-logged row says so and has no timestamp", () => {
    render(<RunObservability record={realRecord} source="real" />);
    expect(screen.getByTestId("ro-basis")).toHaveTextContent(/read, read-only, from the product's own log/);
    expect(screen.getByText("2026-11-22T10:00:01.120456789Z")).toBeInTheDocument();
    const nl = screen.getByTestId("ro-row-n-agent-line");
    expect(nl).toHaveTextContent("no timestamp");
    expect(nl).toHaveTextContent("not logged");
    expect(nl).toHaveTextContent(/No matching line was found/);
    expect(screen.getByTestId("ro-coverage-agent")).toHaveTextContent("Not logged");
    expect(screen.getByTestId("ro-coverage-person")).toHaveTextContent("Logged");
  });

  test("a response row (a decision the lab holds as an API response) is tagged response, never logged, in the chip, the lane and the legend", () => {
    render(<RunObservability record={realRecord} source="real" />);
    const r2 = screen.getByTestId("ro-row-r2-line");
    expect(r2).toHaveTextContent("response");
    expect(within(r2).queryByText("logged")).toBeNull();
    expect(r2.querySelector(".ro-chip[data-origin]")).toHaveAttribute("data-origin", "response");
    expect(screen.getByTestId("ro-coverage-authorize")).toHaveTextContent("Response");
    expect(within(screen.getByTestId("ro-legend")).getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByTestId("ro-legend")).toHaveTextContent(/not read from a log/);
    fireEvent.click(within(r2).getByRole("button"));
    expect(screen.getByTestId("ro-detail-r2")).toHaveTextContent(/not read from a product log, so it is not marked logged/);
  });

  test("an UNVERIFIED shape and a time-window match are tagged on the row", () => {
    render(<RunObservability record={realRecord} source="real" />);
    const r5 = screen.getByTestId("ro-row-r5-line");
    expect(r5).toHaveTextContent("UNVERIFIED shape");
    expect(r5).toHaveTextContent("time window");
    expect(screen.getByTestId("ro-row-r1-line")).not.toHaveTextContent("UNVERIFIED shape");
  });

  test("rows are in time order whatever order they arrive in; the not-logged row (no time) goes last", () => {
    const shuffled = { ...realRecord, rows: [...realRecord.rows].reverse() };
    render(<RunObservability record={shuffled} source="real" />);
    const ids = within(screen.getByTestId("ro-table")).getAllByTestId(/^ro-row-.*-line$/).map((e) => e.getAttribute("data-testid"));
    expect(ids).toEqual(["ro-row-r1-line", "ro-row-r2-line", "ro-row-r3-line", "ro-row-r4-line", "ro-row-r5-line", "ro-row-n-agent-line"]);
  });

  test("a row expands to its JSON through the shared JsonPane (full view, never capped), and collapses again", () => {
    render(<RunObservability record={realRecord} source="real" />);
    expect(screen.queryByTestId("ro-detail-r1")).toBeNull();
    fireEvent.click(within(screen.getByTestId("ro-row-r1-line")).getByRole("button"));
    const body = screen.getByTestId("ro-row-r1");
    expect(body.textContent).toContain('"origin": "logged"');
    expect(body.textContent).toContain('"atExact": "2026-11-22T10:00:01.120456789Z"');
    expect(getComputedStyle(body).maxHeight === "" || getComputedStyle(body).maxHeight === "none").toBe(true);
    expect(screen.getByTestId("ro-detail-r1")).toHaveTextContent(/read, read-only, from the product's own log/);
    fireEvent.click(within(screen.getByTestId("ro-row-r1-line")).getByRole("button"));
    expect(screen.queryByTestId("ro-detail-r1")).toBeNull();
  });

  test("an expanded UNVERIFIED row says so; a simulated row says it was computed by the mock", () => {
    const { unmount } = render(<RunObservability record={realRecord} source="real" />);
    fireEvent.click(within(screen.getByTestId("ro-row-r5-line")).getByRole("button"));
    expect(screen.getByTestId("ro-unverified-r5")).toHaveTextContent(/has not been measured/);
    unmount();
    render(<RunObservability record={mockRecord} source="mock" />);
    fireEvent.click(within(screen.getByTestId("ro-row-r3-line")).getByRole("button"));
    expect(screen.getByTestId("ro-detail-r3")).toHaveTextContent(/Computed by the lab's mock/);
  });

  test("a lane filters the table to its layer and can be cleared", () => {
    render(<RunObservability record={realRecord} source="real" />);
    fireEvent.click(within(screen.getByTestId("ro-lane-gateway")).getByRole("button", { name: "Agent gateway" }));
    expect(screen.getByTestId("ro-filter-note")).toHaveTextContent("Showing 1 of 6 rows");
    expect(screen.getAllByTestId(/^ro-row-.*-line$/)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Show all layers" }));
    expect(screen.getAllByTestId(/^ro-row-.*-line$/)).toHaveLength(6);
  });

  test("long names and an unreachable layer render whole, with the reason", () => {
    render(<RunObservability record={longRecord} source="real" />);
    expect(screen.getAllByText(/a-very-long-agent-client-name/).length).toBeGreaterThan(0);
    expect(screen.getByTestId("ro-coverage-agent")).toHaveTextContent("Unreachable");
    expect(screen.getByTestId("ro-reason-resource")).toHaveTextContent("Docker has no container named mcp-server");
  });

  test("source is required: a missing or invalid source prop is an alert, never a guess from the record", () => {
    const { unmount } = render(<RunObservability record={realRecord} />);
    expect(screen.getByTestId("ro-no-source")).toHaveTextContent(/needs source="mock" or source="real"/);
    expect(screen.queryByTestId("ro-basis")).toBeNull();
    expect(screen.queryByTestId("ro-table")).toBeNull();
    unmount();
    render(<RunObservability record={realRecord} source="simulated" />);
    expect(screen.getByTestId("ro-no-source")).toBeInTheDocument();
  });

  test("an object where text belongs (an API's error message, a row's message, a stream's fields) is shown as text and does not crash", () => {
    const { unmount } = render(<RunObservability record={{ error: "x", message: { reason: "bad window", code: 400 } }} source="real" />);
    expect(screen.getByRole("alert")).toHaveTextContent(/bad window/);
    unmount();
    const odd = { ...realRecord, rows: [{ ...realRecord.rows[0], message: { not: "a string" }, product: ["a", "b"] }, null, 7, ...realRecord.rows.slice(1)] };
    render(<RunObservability record={odd} source="real" streams={[{ product: { p: 1 }, lives: 3, streams: null }]} />);
    expect(screen.getByTestId("ro-row-r1-line")).toHaveTextContent('{"not":"a string"}');
    expect(screen.getByTestId("ro-streams")).toHaveTextContent('{"p":1}');
  });

  test("a new record starts a clean panel: open rows and the layer filter do not carry over to another run's rows", () => {
    const { rerender } = render(<RunObservability record={realRecord} source="real" />);
    fireEvent.click(within(screen.getByTestId("ro-row-r4-line")).getByRole("button"));
    fireEvent.click(within(screen.getByTestId("ro-lane-gateway")).getByRole("button", { name: "Agent gateway" }));
    expect(screen.getByTestId("ro-detail-r4")).toBeInTheDocument();
    expect(screen.getByTestId("ro-filter-note")).toBeInTheDocument();
    rerender(<RunObservability record={{ ...realRecord, runId: "run-2" }} source="real" />);
    expect(screen.queryByTestId("ro-detail-r4")).toBeNull();
    expect(screen.queryByTestId("ro-filter-note")).toBeNull();
    expect(screen.getAllByTestId(/^ro-row-.*-line$/)).toHaveLength(6);
  });

  test("aria-controls only points at a row that exists (none while collapsed)", () => {
    render(<RunObservability record={realRecord} source="real" />);
    const btn = within(screen.getByTestId("ro-row-r1-line")).getByRole("button");
    expect(btn).not.toHaveAttribute("aria-controls");
    fireEvent.click(btn);
    expect(document.getElementById(btn.getAttribute("aria-controls"))).not.toBeNull();
  });

  test("the table keeps its native semantics on a wide screen (no redundant roles) and gets table roles where the CSS turns it into blocks", () => {
    const { unmount } = render(<RunObservability record={realRecord} source="real" />);
    const wide = screen.getByTestId("ro-table");
    expect(wide).not.toHaveAttribute("role");
    expect(wide.querySelectorAll("[role]")).toHaveLength(0);
    unmount();
    const original = window.matchMedia;
    window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
    try {
      render(<RunObservability record={realRecord} source="real" />);
      const table = screen.getByTestId("ro-table");
      expect(table).toHaveAttribute("role", "table");
      expect(table.querySelectorAll('[role="rowgroup"]')).toHaveLength(2);
      expect(table.querySelectorAll('[role="columnheader"]')).toHaveLength(6);
      expect(table.querySelectorAll('tr:not([role="row"])')).toHaveLength(0);
      expect(table.querySelectorAll('td:not([role="cell"])')).toHaveLength(0);
    } finally { window.matchMedia = original; }
  });

  test("the panel is keyed by the run id: a new run resets, the same run keeps its open rows; a repeated row id cannot collide", () => {
    const { rerender } = render(<RunObservability record={realRecord} source="real" />);
    fireEvent.click(within(screen.getByTestId("ro-row-r1-line")).getByRole("button"));
    rerender(<RunObservability record={{ ...realRecord }} source="real" />);
    expect(screen.getByTestId("ro-detail-r1")).toBeInTheDocument();
    rerender(<RunObservability record={{ ...realRecord, runId: "run-3" }} source="real" />);
    expect(screen.queryByTestId("ro-detail-r1")).toBeNull();
    const dup = { ...realRecord, runId: "run-dup", rows: realRecord.rows.map((r) => ({ ...r, id: "same" })) };
    rerender(<RunObservability record={dup} source="real" />);
    expect(screen.getAllByTestId(/^ro-row-.*-line$/)).toHaveLength(6);
    fireEvent.click(within(screen.getAllByTestId(/^ro-row-.*-line$/)[0]).getByRole("button"));
    expect(document.querySelectorAll("tr.ro-xrow")).toHaveLength(1);
  });

  test("an UNVERIFIED-shape row is counted as information in the summary, whatever outcome it carries, and says so", () => {
    render(<RunObservability record={realRecord} source="real" />);
    expect(screen.getByTestId("ro-summary")).toHaveTextContent("1 allowed, 1 refused, 1 blocked, 2 for information (information is not a pass; 1 UNVERIFIED-shape row is counted here whatever outcome it carries)");
    expect(screen.getByTestId("ro-row-r5-line")).toHaveTextContent("REFUSED");
  });

  test("a partial search says absence is not proof: the chip reads Not found (partial search), and the reason is shown", () => {
    render(<RunObservability record={partialRecord} source="real" />);
    expect(screen.getByTestId("ro-coverage-agent")).toHaveTextContent("Not found (partial search)");
    expect(screen.getByTestId("ro-reason-agent")).toHaveTextContent(/absence is not proof/);
    expect(screen.getByTestId("ro-coverage-person")).toHaveTextContent("Logged");
    expect(screen.getByTestId("ro-truncated")).toBeInTheDocument();
  });

  test("a truncated excerpt says so", () => {
    render(<RunObservability record={{ ...realRecord, truncated: true }} source="real" />);
    expect(screen.getByTestId("ro-truncated")).toBeInTheDocument();
  });

  test("where the logs live and where they stream: a collapsible block from the streams prop, and an honest line when it is empty", () => {
    const { unmount } = render(<RunObservability record={realRecord} source="real" streams={streams} />);
    const block = screen.getByTestId("ro-streams");
    expect(block).toHaveTextContent("Where these logs live and where they stream");
    expect(block).toHaveTextContent("PingFederate audit.log");
    expect(block).toHaveTextContent(/streams to Vector to Elasticsearch/);
    unmount();
    render(<RunObservability record={realRecord} source="real" />);
    expect(screen.getByTestId("ro-streams-empty")).toHaveTextContent(/has not said/);
  });

  test("nothing secret-looking is rendered for any fixture", () => {
    for (const record of [mockRecord, realRecord, longRecord, emptyRecord, partialRecord]) {
      const { container, unmount } = render(<RunObservability record={record} source={record.source} streams={streams} />);
      expect(container.textContent).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{8,}|eyJ[\w-]{8,}\.|client_secret|\b\d{1,3}(\.\d{1,3}){3}\b/);
      unmount();
    }
  });
});
