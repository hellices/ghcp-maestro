import test from "node:test";
import assert from "node:assert/strict";
import { renderConsoleHtml } from "../vscode-extension/views/console-panel.mjs";

const snap = (task) => ({ runs: [{ id: "r1", task, status: "running", phases: [] }] });

test("embedded state escapes U+2028/U+2029 so the inline script stays parseable", () => {
  // U+2028 (line separator) is legal in JSON but a JS line terminator inside <script>.
  const html = renderConsoleHtml(snap("line\u2028sep\u2029end"), {});
  const stateScript = html.match(/window\.__MAESTRO_STATE__ = (.+?);<\/script>/s)[1];
  assert.ok(!stateScript.includes("\u2028"), "raw U+2028 must not survive into the embedded script");
  assert.ok(!stateScript.includes("\u2029"), "raw U+2029 must not survive into the embedded script");
  assert.ok(stateScript.includes("\\u2028"), "U+2028 must be emitted as an escape sequence");
  assert.ok(stateScript.includes("\\u2029"), "U+2029 must be emitted as an escape sequence");
});

test("embedded state escapes < so it cannot break out of the script element", () => {
  const html = renderConsoleHtml(snap("</script><script>alert(1)"), {});
  assert.ok(!html.includes("</script><script>alert(1)"), "must not emit a raw closing script tag from data");
  assert.ok(html.includes("\\u003c/script"), "< must be escaped as \\u003c");
});

test("CSP forbids inline scripts and only allows the document nonce", () => {
  const html = renderConsoleHtml(snap("t"), {});
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)[1];
  assert.ok(!/script-src[^;]*'unsafe-inline'/.test(csp), "script-src must not allow 'unsafe-inline'");
  const nonce = csp.match(/script-src[^;]*'nonce-([^']+)'/)?.[1];
  assert.ok(nonce, "script-src must carry a nonce");

  // Every <script> tag must be nonced with that exact value.
  const scriptTags = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
  assert.ok(scriptTags.length >= 1);
  for (const attrs of scriptTags) {
    assert.match(attrs, new RegExp(`nonce="${nonce}"`), "every <script> must carry the CSP nonce");
  }
});

test("nonce is unique per render (not a fixed constant)", () => {
  const a = renderConsoleHtml(snap("t"), {}).match(/'nonce-([^']+)'/)[1];
  const b = renderConsoleHtml(snap("t"), {}).match(/'nonce-([^']+)'/)[1];
  assert.notEqual(a, b);
});
