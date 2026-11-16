// The vendored shared/verify-mark files (VerifyMark.jsx, VerifyMark.css) match their pin files byte for byte. They come from
// curtismu7/AI-DEMO-Standalone shared/verify-mark: change them there, re-pin, re-vendor; never edit them here.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

describe("vendored verify-mark", () => {
  it("matches VerifyMark.sha256 and VerifyMark.css.sha256", () => {
    const dir = path.join(process.cwd(), "src", "components");
    for (const [file, pinFile] of [["VerifyMark.jsx", "VerifyMark.sha256"], ["VerifyMark.css", "VerifyMark.css.sha256"]]) {
      const [hash, name] = fs.readFileSync(path.join(dir, pinFile), "utf8").trim().split(/\s+/);
      expect(name, pinFile).toBe(file);
      expect(createHash("sha256").update(fs.readFileSync(path.join(dir, file))).digest("hex"), file).toBe(hash);
    }
  });

  it("matches the canonical hashes from AI-DEMO-Standalone shared/verify-mark (#238)", () => {
    const dir = path.join(process.cwd(), "src", "components");
    const sha = (f) => createHash("sha256").update(fs.readFileSync(path.join(dir, f))).digest("hex");
    expect(sha("VerifyMark.jsx")).toBe("81c2532041c5a65aaf762e55c56e889df09dfde5811fc5cc788897ca8712c130");
    expect(sha("VerifyMark.css")).toBe("4774585cd47c3affc739d3d99fa6843d62f607d8d3e69b4438de756ac3d49dc5");
  });

  it("is imported by main.jsx and rendered once in App.jsx with this lab's shelf id", () => {
    const src = (f) => fs.readFileSync(path.join(process.cwd(), "src", f), "utf8");
    expect(src("main.jsx")).toContain('import "./components/VerifyMark.css"');
    expect(src("App.jsx").match(/<VerifyMark id="agent-gateway-inspector" \/>/g)).toHaveLength(1);
  });
});
