import assert from "node:assert/strict";
import { test } from "node:test";
import { CliError } from "../cli.js";
import { renderPreviewFallback } from "../preview.js";

test("fallback preview reports a missing CLI and keeps safe Markdown", () => {
  const output = renderPreviewFallback(
    "# Document\n\n**Fallback content**",
    new CliError(
      "Could not start TMD CLI `tmd`: spawn tmd ENOENT.",
      null,
      "",
      "",
      "missing-executable",
    ),
  );

  assert.match(output, /Dynamic preview unavailable/);
  assert.match(output, /executable could not be found/);
  assert.match(output, /TMD: Select CLI Executable/);
  assert.match(output, /<h1>Document<\/h1>/);
  assert.match(output, /<strong>Fallback content<\/strong>/);
});

test("fallback preview identifies an outdated CLI", () => {
  const output = renderPreviewFallback(
    "```tmd-view:table\nsource = \"notes\"\n```",
    new CliError(
      "TMD CLI command `preview` failed (exit 2)",
      2,
      "",
      "error: unrecognized subcommand 'preview'",
    ),
  );

  assert.match(output, /does not support dynamic preview and must be updated/);
  assert.match(output, /<pre><code>/);
});

test("fallback preview escapes and bounds diagnostic details", () => {
  const unsafe = `<script>alert("diagnostic")</script>${"x".repeat(3_000)}`;
  const output = renderPreviewFallback("<img src=x onerror=alert(1)>", new Error(unsafe));

  assert.doesNotMatch(output, /<script>/);
  assert.doesNotMatch(output, /<img/);
  assert.match(output, /&lt;script&gt;alert\(&quot;diagnostic&quot;\)&lt;\/script&gt;/);
  assert.match(output, /…<\/code>/);
});
