import { test } from "node:test";
import assert from "node:assert/strict";
import { extractText } from "../core/adapters/reply-text.mjs";

test("extractText returns '' for null/undefined events", () => {
  assert.equal(extractText(null), "");
  assert.equal(extractText(undefined), "");
});

test("extractText reads a string content under .data", () => {
  assert.equal(extractText({ data: { content: "hello" } }), "hello");
});

test("extractText falls back to the event itself when there is no .data", () => {
  assert.equal(extractText({ content: "direct" }), "direct");
});

test("extractText joins an array of string parts", () => {
  assert.equal(extractText({ data: { content: ["a", "b", "c"] } }), "abc");
});

test("extractText joins {text} parts and tolerates strings and missing text", () => {
  assert.equal(
    extractText({ data: { content: [{ text: "x" }, { text: "y" }, {}, "z"] } }),
    "xyz",
  );
});

test("extractText returns '' when content is neither string nor array", () => {
  assert.equal(extractText({ data: { content: { nested: true } } }), "");
  assert.equal(extractText({ data: {} }), "");
});
