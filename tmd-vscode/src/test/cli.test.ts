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

test("CLI client requests schema-versioned dynamic preview HTML", async () => {
  const script = [
    'process.stdin.setEncoding("utf8");',
    'let input = "";',
    'process.stdin.on("data", (chunk) => input += chunk);',
    'process.stdin.on("end", () => {',
    '  const request = JSON.parse(input);',
    '  process.stdout.write(JSON.stringify({',
    '    schema_version: request.schema_version,',
    '    preview_html: `<p>${request.markdown}</p>`',
    '  }));',
    '});',
  ].join("\n");
  const client = new TmdCliClient(process.execPath, 2_000, [
    "--no-inspect",
    "-e",
    script,
  ]);

  assert.equal(
    await client.preview("/tmp/document.tmd", "dynamic value", {
      tmd_data_sources: { schema_version: 1, sources: {} },
    }),
    "<p>dynamic value</p>",
  );
});

test("CLI client requests and validates typed table source data", async () => {
  const script = [
    'process.stdin.setEncoding("utf8");',
    'let input = "";',
    'process.stdin.on("data", (chunk) => input += chunk);',
    'process.stdin.on("end", () => {',
    '  const request = JSON.parse(input);',
    '  process.stdout.write(JSON.stringify({',
    '    schema_version: request.schema_version,',
    '    source: request.source,',
    '    kind: "table",',
    '    columns: ["id", "label"],',
    '    rows: [[{ type: "integer", value: "9007199254740993" }, { type: "string", value: request.text_attachments[0]?.text ?? "safe" }]]',
    '  }));',
    '});',
  ].join("\n");
  const client = new TmdCliClient(process.execPath, 2_000, [
    "--no-inspect",
    "-e",
    script,
  ]);

  assert.deepEqual(
    await client.dataSource("/tmp/document.tmd", "rows", {
      tmd_data_sources: { schema_version: 1, sources: {} },
    }, [
      { logicalPath: "views/rows.rhai", text: "edited" },
    ]),
    {
      source: "rows",
      kind: "table",
      columns: ["id", "label"],
      rows: [
        [
          { type: "integer", value: "9007199254740993" },
          { type: "string", value: "edited" },
        ],
      ],
    },
  );
});

test("CLI client reads UTF-8 text attachments", async () => {
  const client = new TmdCliClient("/usr/bin/printf", 2_000, [
    '{"schema_version":1,"logical_path":"views/summary.rhai","text":"let value = 1;"}',
  ]);

  assert.deepEqual(
    await client.textAttachment(
      "/tmp/document.tmd",
      "views/summary.rhai",
    ),
    {
      logicalPath: "views/summary.rhai",
      text: "let value = 1;",
    },
  );
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
