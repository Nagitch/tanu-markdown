import assert from "node:assert/strict";
import { test } from "node:test";
import { CliError, TmdCliClient } from "../cli.js";

test("CLI client passes argument arrays without a shell and parses JSON", async () => {
  const client = new TmdCliClient("/usr/bin/printf", 2_000, [
    [
      '{"schema_version":1,"format":"tmd","markdown":"%s|%s|%s",',
      '"manifest":{"title":null,"authors":[],"tags":[]},',
      '"attachments":[],"database_user_version":0,',
      '"database":{"user_version":0,"objects":[]},',
      '"validation":{"valid":true,"issues":[],"attachment_references":[],',
      '"database_user_version":0}}',
    ].join(""),
  ]);
  const inspection = await client.inspect("/tmp/a document.tmd");
  assert.match(inspection.markdown, /inspect\|\/tmp\/a document\.tmd\|--json/);
});

test("CLI client returns an actionable executable error", async () => {
  const client = new TmdCliClient("/definitely/missing/tmd", 1_000);
  await assert.rejects(client.inspect("/tmp/document.tmd"), (error: unknown) => {
    assert.ok(error instanceof CliError);
    assert.match(error.message, /tanuMarkdown\.cliPath/);
    return true;
  });
});

test("CLI client rejects an incompatible JSON schema", async () => {
  const client = new TmdCliClient("/usr/bin/printf", 2_000, [
    '{"schema_version":2}',
  ]);
  await assert.rejects(client.inspect("/tmp/document.tmd"), (error: unknown) => {
    assert.ok(error instanceof CliError);
    assert.match(error.message, /expected 1/);
    return true;
  });
});

test("CLI client enforces its timeout", async () => {
  const client = new TmdCliClient(process.execPath, 50, [
    "--no-inspect",
    "-e",
    "setTimeout(() => {}, 10_000)",
  ]);
  await assert.rejects(client.inspect("/tmp/document.tmd"), (error: unknown) => {
    assert.ok(error instanceof CliError);
    assert.match(error.message, /timed out/);
    return true;
  });
});
