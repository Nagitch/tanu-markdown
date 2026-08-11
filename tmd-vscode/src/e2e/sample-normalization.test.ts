import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { TmdCliClient } from "../cli.js";
import {
  extrasWithDataSources,
  inspectDataSourceRegistry,
  isManagedFormulaDataSource,
} from "../data-sources.js";
import { parseEditorDataSources } from "../editor-data-sources.js";
import {
  findNormalizationCandidate,
  normalizeManagedColumns,
} from "../managed-table.js";

test("sample contacts normalization crosses the editor boundary and preserves output", async () => {
  const configuredCli = process.env.TMD_E2E_CLI;
  assert.ok(configuredCli, "TMD_E2E_CLI must name the built tmd executable");
  const cliPath = resolve(process.cwd(), configuredCli);
  const repositoryRoot = resolve(process.cwd(), "..");
  const samplePath = resolve(repositoryRoot, "tmd-sample/sample.tmd");
  const client = new TmdCliClient(cliPath, 15_000);
  const inspection = await client.inspect(samplePath);
  const before = await client.dataSource(
    samplePath,
    "contacts",
    inspection.manifest.extras,
  );
  const registry = inspectDataSourceRegistry(inspection.manifest.extras);
  assert.equal(registry.editable, true);
  const contacts = registry.sources.find(
    (source) => source.name === "contacts" && isManagedFormulaDataSource(source),
  );
  assert.ok(contacts && isManagedFormulaDataSource(contacts));
  const candidate = findNormalizationCandidate(contacts);
  assert.ok(candidate, "sample contacts must keep its normalization candidate");
  const normalized = normalizeManagedColumns(
    contacts,
    candidate,
    "contacts-detail-e2e",
  );
  const nextSources = registry.sources.map((source) =>
    source.name === contacts.name ? normalized.source : source,
  );
  nextSources.push(normalized.target);

  const editorPayload = JSON.parse(JSON.stringify(nextSources));
  const acceptedSources = parseEditorDataSources(editorPayload);
  assert.ok(acceptedSources, "the extension host must accept normalized Schema v7 sources");
  const draftExtras = extrasWithDataSources(
    inspection.manifest.extras,
    acceptedSources,
  );
  const after = await client.dataSource(samplePath, "contacts", draftExtras);

  assert.deepEqual(after.columns, before.columns);
  assert.deepEqual(after.rows, before.rows);
  assert.equal(normalized.source.columns.at(-1)?.hidden, true);
  assert.equal(normalized.target.columns.at(-1)?.hidden, true);
});
