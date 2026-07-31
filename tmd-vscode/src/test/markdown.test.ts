import assert from "node:assert/strict";
import { test } from "node:test";
import { renderSafeMarkdown } from "../markdown.js";

test("safe preview escapes source HTML and executable URLs", () => {
  const output = renderSafeMarkdown(
    "# Heading\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))",
  );
  assert.match(output, /<h1>Heading<\/h1>/);
  assert.match(output, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(output, /<script/);
  assert.doesNotMatch(output, /href="javascript:/);
});

test("safe preview retains supported links and formatting", () => {
  const output = renderSafeMarkdown(
    "**Bold** [site](https://example.com/?a=1&b=2) [file](attach:files/note.txt)",
  );
  assert.match(output, /<strong>Bold<\/strong>/);
  assert.match(output, /href="https:\/\/example\.com\/\?a=1&amp;b=2"/);
  assert.doesNotMatch(output, /&amp;amp;/);
  assert.match(output, /href="attach:files\/note\.txt"/);
});

test("safe preview escapes fenced code blocks", () => {
  const output = renderSafeMarkdown("```\n<img src=x onerror=alert(1)>\n```");
  assert.match(output, /<pre><code>/);
  assert.match(output, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(output, /<img/);
});
