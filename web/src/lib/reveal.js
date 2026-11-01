// Defence in depth: the server already shows hidden characters as [U+XXXX] before it stores or returns a string.
// This does the same on the client, so a raw invisible character can never reach the page unmarked.
const INVISIBLE =
  "\\u00AD\\u034F\\u061C\\u115F\\u1160\\u17B4\\u17B5\\u180B-\\u180F\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u206F\\u2800\\u3164\\uFE00-\\uFE0D\\uFEFF\\uFFA0\\uFFF9-\\uFFFB\\u{E0000}-\\u{E007F}\\u{E0100}-\\u{E01EF}";
const CONTROL = "\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F";
const UNSAFE = new RegExp(`[${INVISIBLE}${CONTROL}]`, "gu");

export const hasHidden = (s) => new RegExp(UNSAFE.source, "u").test(String(s ?? ""));

export function reveal(value) {
  return String(value ?? "").replace(UNSAFE, (ch) => `[U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}]`);
}

export const shortHash = (h) => (h ? String(h).replace(/^sha256:/, "").slice(0, 12) : "none");
