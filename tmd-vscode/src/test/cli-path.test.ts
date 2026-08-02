import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { bundledCliPath, resolveCliExecutable } from "../cli-path.js";

test("explicit CLI configuration overrides bundled and PATH executables", () => {
  assert.deepEqual(
    resolveCliExecutable("/extension", " /opt/tmd/bin/tmd ", () => true, "linux"),
    { executable: "/opt/tmd/bin/tmd", source: "configured" },
  );
});

test("bundled CLI is preferred when no override is configured", () => {
  const expected = path.join("/extension", "bin", "tmd");
  assert.deepEqual(
    resolveCliExecutable("/extension", "", (candidate) => candidate === expected, "linux"),
    { executable: expected, source: "bundled" },
  );
});

test("CLI resolution falls back to PATH for development packages", () => {
  assert.deepEqual(resolveCliExecutable("/extension", undefined, () => false, "darwin"), {
    executable: "tmd",
    source: "path",
  });
});

test("Windows packages resolve the executable suffix", () => {
  assert.equal(bundledCliPath("C:\\extension", "win32"), path.join("C:\\extension", "bin", "tmd.exe"));
});
