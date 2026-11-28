// The vendored shared/mode-modal files (ModeModal.jsx, mode-modal.css) match mode-modal.sha256 byte for byte, and the pin lists exactly those two.
// They come from curtismu7/AI-DEMO-Standalone shared/mode-modal: change them there, re-pin, re-vendor; never edit them here.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

describe("vendored mode-modal", () => {
  it("matches mode-modal.sha256 and nothing else sits beside the pinned files", () => {
    const dir = path.join(process.cwd(), "src", "mode-modal");
    const pinned = fs.readFileSync(path.join(dir, "mode-modal.sha256"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => l.split(/\s+/));
    expect(pinned.map(([, name]) => name).sort()).toEqual(["ModeModal.jsx", "mode-modal.css"]);
    for (const [hash, name] of pinned) {
      expect(createHash("sha256").update(fs.readFileSync(path.join(dir, name))).digest("hex"), name).toBe(hash);
    }
    expect(fs.readdirSync(dir).sort()).toEqual(["ModeModal.jsx", "mode-modal.css", "mode-modal.sha256"]);
  });
});
