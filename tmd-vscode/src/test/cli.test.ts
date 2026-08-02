import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    assert.equal(error.kind, "missing-executable");
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

test(
  "CLI client waits for a timed-out process to close",
  { skip: process.platform === "win32" },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "tmd-cli-timeout-"));
    const marker = join(directory, "closed");
    try {
      const script = [
        'const fs = require("node:fs");',
        'process.on("SIGTERM", () => {',
        '  fs.writeFileSync(process.argv[1], "closed");',
        "  setTimeout(() => process.exit(0), 50);",
        "});",
        "setInterval(() => {}, 1_000);",
      ].join("\n");
      const client = new TmdCliClient(process.execPath, 200, [
        "--no-inspect",
        "-e",
        script,
        marker,
      ]);

      await assert.rejects(client.inspect("/tmp/document.tmd"), (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.match(error.message, /timed out/);
        return true;
      });
      assert.equal(readFileSync(marker, "utf8"), "closed");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
