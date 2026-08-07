import { defineCustomElements } from "@revolist/revogrid/loader";
import type { ColumnRegular, DataType } from "@revolist/revogrid";
import { formulaDiagnosticFromIssue } from "../../../src/formula-diagnostics.js";
import { spreadsheetColumnName } from "../../../src/formula-program.js";
import { EditorClientState, PREVIEW_DEBOUNCE_MS } from "../../../src/input.js";
import { setupEditorTabs } from "../../../src/tabs.js";
import { rhaiDiagnosticFromIssue } from "../../../src/rhai-diagnostics.js";
import type {
  DataSource,
  DataSourceRegistryView,
  DataSourceTable,
  DataTableCell,
  FormulaDataSource,
  RhaiDataSource,
  ValidationReport,
} from "../../../src/types.js";
import type {
  EditorHostMessage,
  EditorModelMessage,
  EditorRequest,
} from "../../../src/webview-protocol.js";
import { createMarkdownEditor } from "./markdown-editor.js";
import { createFormulaEditor } from "./formula-editor.js";
import { createRhaiEditor } from "./rhai-editor.js";

const RHAI_EVALUATION_DEBOUNCE_MS = 350;
const FORMULA_EVALUATION_DEBOUNCE_MS = 350;
const MAX_RHAI_SCRIPT_BYTES = 256 * 1024;
const MAX_FORMULA_PROGRAM_BYTES = 256 * 1024;

interface EditorUiState extends Record<string, unknown> {
  activeEditorTab?: string;
  selectedTableSource?: string;
}

interface HostApi {
  postMessage(message: EditorRequest): void;
  getState(): EditorUiState | undefined;
  setState(state: EditorUiState): EditorUiState;
}

declare function acquireVsCodeApi(): HostApi;

declare global {
  interface Window {
    /** Optional adapter for a browser host outside VS Code. */
    tmdEditorHost?: HostApi;
  }
}

const root = requireElement<HTMLElement>("tmd-editor-root");
const host = window.tmdEditorHost ?? acquireVsCodeApi();
const revision = new EditorClientState();
const cspNonce = requireElement<HTMLMetaElement>("tmd-csp-nonce").content;
const title = requireElement<HTMLInputElement>("title");
const markdown = createMarkdownEditor(requireElement("markdown"), cspNonce);
const attachments = requireElement<HTMLUListElement>("attachments");
const databaseObjects = requireElement<HTMLUListElement>("database-objects");
const tableSource = requireElement<HTMLSelectElement>("table-source");
const tableSourceStatus = requireElement<HTMLElement>("table-source-status");
const tableGridHost = requireElement<HTMLElement>("table-grid-host");
const formulaProgramPanel = requireElement<HTMLElement>("formula-program-panel");
const formulaProgramInput = requireElement<HTMLElement>("formula-program-input");
const formulaProgramStatus = requireElement<HTMLElement>("formula-program-status");
const formulaProgramError = requireElement<HTMLElement>("formula-program-error");
const formulaColumnLegend = requireElement<HTMLElement>("formula-column-legend");
const formulaEditor = createFormulaEditor(
  requireElement("formula-program-editor"),
  cspNonce,
);
const rhaiScriptPanel = requireElement<HTMLElement>("rhai-script-panel");
const rhaiScriptPath = requireElement<HTMLElement>("rhai-script-path");
const rhaiScriptStatus = requireElement<HTMLElement>("rhai-script-status");
const rhaiScriptError = requireElement<HTMLElement>("rhai-script-error");
const rhaiEditor = createRhaiEditor(
  requireElement("rhai-script-editor"),
  cspNonce,
);
const dataViewReferences = requireElement<HTMLUListElement>("data-view-references");
const dataSources = requireElement<HTMLElement>("data-sources");
const dataSourceRegistryIssue = requireElement<HTMLElement>(
  "data-source-registry-issue",
);
const dataSourceRegistryRaw = requireElement<HTMLPreElement>(
  "data-source-registry-raw",
);
const addSqliteDataSource = requireElement<HTMLButtonElement>(
  "add-sqlite-data-source",
);
const addRhaiDataSource = requireElement<HTMLButtonElement>("add-rhai-data-source");
const addFormulaDataSource = requireElement<HTMLButtonElement>(
  "add-formula-data-source",
);
const applyDataSources = requireElement<HTMLButtonElement>("apply-data-sources");
const dataSourceStatus = requireElement<HTMLElement>("data-source-status");
const validation = requireElement<HTMLElement>("validation");
const preview = requireElement<HTMLElement>("preview");

let previewTimer: ReturnType<typeof setTimeout> | undefined;
let rhaiEvaluationTimer: ReturnType<typeof setTimeout> | undefined;
let formulaEvaluationTimer: ReturnType<typeof setTimeout> | undefined;
let dataSourceDrafts: DataSource[] = [];
let tableSourceDefinitions: DataSource[] = [];
let dataSourcesEditable = false;
let dataSourceEditingLocked = true;
let pendingDataSourceRevision: number | undefined;
let pendingRhaiScriptRevision: number | undefined;
let pendingFormulaRevision: number | undefined;
let selectedTableSource = host.getState()?.selectedTableSource;
let tableRequestId = 0;
let rhaiScriptRequestId = 0;
let currentTable: DataSourceTable | undefined;
let tableGrid: HTMLRevoGridElement | undefined;
let currentRhaiScriptPath: string | undefined;
let rhaiEvaluationComplete = false;
let rhaiEvaluationIssue: string | undefined;
let formulaEvaluationComplete = false;
let formulaEvaluationIssue: string | undefined;

void Promise.resolve(defineCustomElements()).then(() => {
  const grid = document.createElement("revo-grid");
  grid.setAttribute("aria-label", "Selected data source table");
  grid.theme = "compact";
  grid.readonly = true;
  grid.resize = true;
  grid.rowHeaders = true;
  grid.range = true;
  grid.stretch = true;
  grid.useClipboard = true;
  tableGrid = grid;
  tableGridHost.replaceChildren(grid);
  if (currentTable) renderTableGrid(currentTable);
});

setupEditorTabs(
  {
    querySelectorAll(selector) {
      return [...document.querySelectorAll<HTMLElement>(selector)];
    },
  },
  host,
);

title.disabled = true;
markdown.disabled = true;
title.addEventListener("input", sendDocumentEdit);
markdown.addEventListener("input", () => {
  sendDocumentEdit();
  queuePreview();
});
rhaiEditor.disabled = true;
rhaiEditor.addEventListener("input", sendRhaiScriptEdit);
formulaEditor.disabled = true;
formulaEditor.addEventListener("input", queueFormulaProgramEdit);

requireElement("validate").addEventListener("click", () =>
  host.postMessage({ type: "validate" }),
);
requireElement("add-attachment").addEventListener("click", () =>
  host.postMessage({ type: "addAttachment" }),
);
requireElement("export-html").addEventListener("click", () =>
  host.postMessage({ type: "exportHtml" }),
);
preview.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest("a")) {
    event.preventDefault();
  }
});

tableSource.addEventListener("change", () => {
  clearTimeout(formulaEvaluationTimer);
  selectedTableSource = tableSource.value || undefined;
  host.setState({
    ...(host.getState() ?? {}),
    selectedTableSource,
  });
  requestTableSource();
  requestRhaiScript();
  renderFormulaProgram();
});

addSqliteDataSource.addEventListener("click", () => {
  dataSourceDrafts.push({
    name: nextDataSourceName("source"),
    type: "sqlite",
    query: "SELECT 1 AS value",
  });
  renderDataSourceDrafts();
  markDataSourceDraftChanged();
});

addRhaiDataSource.addEventListener("click", () => {
  const name = nextDataSourceName("view");
  const sqliteSource = dataSourceDrafts.find((source) => source.type === "sqlite");
  dataSourceDrafts.push({
    name,
    type: "rhai",
    script: `views/${name}.rhai`,
    inputs: [{ alias: "rows", source: sqliteSource?.name ?? "" }],
    outputColumns: ["value"],
  });
  renderDataSourceDrafts();
  markDataSourceDraftChanged();
});

addFormulaDataSource.addEventListener("click", () => {
  const name = nextDataSourceName("formula");
  const sqliteSource = dataSourceDrafts.find((source) => source.type === "sqlite");
  dataSourceDrafts.push({
    name,
    type: "formula",
    input: sqliteSource?.name ?? "",
    program: "B1 = SUM(A1:A1)",
    outputColumns: ["value", "total"],
  });
  renderDataSourceDrafts();
  markDataSourceDraftChanged();
});

applyDataSources.addEventListener("click", () => {
  const issue = validateDataSourceDrafts();
  if (issue) {
    setStatus(dataSourceStatus, issue, "invalid");
    return;
  }
  pendingDataSourceRevision = sendDataSourceEdit(
    dataSourceDrafts.map(cloneDataSource),
  );
  setStatus(dataSourceStatus, "Applying source changes…", "stale");
});

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (!isEditorHostMessage(event.data)) return;
  const message = event.data;
  if (message.type === "preview") {
    if (revision.acceptPreview(message)) preview.innerHTML = message.previewHtml;
    return;
  }
  if (message.type === "editAck") {
    if (!revision.acceptEditAcknowledgement(message)) return;
    if (message.clientRevision === pendingDataSourceRevision) {
      pendingDataSourceRevision = undefined;
      setStatus(
        dataSourceStatus,
        "Source changes applied. Save the document to persist them.",
        "valid",
      );
      renderTableSourceOptions(dataSourceDrafts);
    }
    if (message.clientRevision === pendingRhaiScriptRevision) {
      pendingRhaiScriptRevision = undefined;
      queueRhaiEvaluation();
    }
    if (message.clientRevision === pendingFormulaRevision) {
      pendingFormulaRevision = undefined;
      setStatus(
        dataSourceStatus,
        "Formula changes applied. Save the document to persist them.",
        "valid",
      );
      renderDataSourceDrafts();
      queueFormulaEvaluation();
    }
    return;
  }
  if (message.type === "dataSourceTable") {
    renderTableSourceResult(message);
    return;
  }
  if (message.type === "rhaiScript") {
    renderRhaiScriptResult(message);
    return;
  }
  applyModel(message);
});

host.postMessage({ type: "ready" });

function sendDocumentEdit(): void {
  const clientRevision = revision.nextEditRevision();
  if (clientRevision === undefined) return;
  host.postMessage({
    type: "edit",
    clientRevision,
    title: title.value,
    markdown: markdown.value,
  });
  renderValidation(undefined, false);
}

function sendDataSourceEdit(sources: DataSource[]): number | undefined {
  const clientRevision = revision.nextEditRevision();
  if (clientRevision === undefined) return undefined;
  host.postMessage({
    type: "editDataSources",
    clientRevision,
    dataSources: sources,
  });
  renderValidation(undefined, false);
  queuePreview();
  return clientRevision;
}

function sendRhaiScriptEdit(): void {
  const source = selectedRhaiSource();
  if (!source || !currentRhaiScriptPath) return;
  if (new TextEncoder().encode(rhaiEditor.value).length > MAX_RHAI_SCRIPT_BYTES) {
    const issue = `Rhai scripts must be at most ${MAX_RHAI_SCRIPT_BYTES} UTF-8 bytes.`;
    rhaiEvaluationComplete = true;
    rhaiEvaluationIssue = issue;
    rhaiEditor.setDiagnostic({ message: issue });
    updateRhaiScriptStatus();
    return;
  }
  const clientRevision = revision.nextEditRevision();
  if (clientRevision === undefined) return;
  pendingRhaiScriptRevision = clientRevision;
  rhaiEvaluationComplete = false;
  rhaiEvaluationIssue = undefined;
  rhaiEditor.setDiagnostic(undefined);
  updateRhaiScriptStatus();
  host.postMessage({
    type: "editRhaiScript",
    clientRevision,
    source: source.name,
    logicalPath: currentRhaiScriptPath,
    text: rhaiEditor.value,
  });
  renderValidation(undefined, false);
  queuePreview();
}

function queueFormulaProgramEdit(): void {
  const source = selectedFormulaSource();
  if (!source) return;
  clearTimeout(formulaEvaluationTimer);
  tableRequestId += 1;
  const program = formulaEditor.value;
  if (new TextEncoder().encode(program).length > MAX_FORMULA_PROGRAM_BYTES) {
    const issue = `Formula programs must be at most ${MAX_FORMULA_PROGRAM_BYTES} UTF-8 bytes.`;
    formulaEvaluationComplete = true;
    formulaEvaluationIssue = issue;
    formulaEditor.setDiagnostic({ message: issue });
    updateFormulaProgramStatus();
    return;
  }
  formulaEvaluationComplete = false;
  formulaEvaluationIssue = undefined;
  formulaEditor.setDiagnostic(undefined);
  updateFormulaProgramStatus();
  applyFormulaProgramEdit();
}

function applyFormulaProgramEdit(): void {
  const source = selectedFormulaSource();
  if (!source) return;
  const program = formulaEditor.value;
  source.program = program;
  const draft = dataSourceDrafts.find(
    (candidate) => candidate.name === source.name && candidate.type === "formula",
  );
  if (!draft || draft.type !== "formula") return;
  draft.program = program;
  pendingFormulaRevision = sendDataSourceEdit(
    dataSourceDrafts.map(cloneDataSource),
  );
  if (pendingFormulaRevision === undefined) return;
  setStatus(formulaProgramStatus, "Checking…", "stale");
}

function queuePreview(): void {
  if (!revision.initialized) return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    host.postMessage({
      type: "preview",
      clientRevision: revision.clientRevision,
      markdown: markdown.value,
    });
  }, PREVIEW_DEBOUNCE_MS);
}

function queueRhaiEvaluation(): void {
  clearTimeout(rhaiEvaluationTimer);
  rhaiEvaluationTimer = setTimeout(() => requestTableSource(), RHAI_EVALUATION_DEBOUNCE_MS);
}

function queueFormulaEvaluation(): void {
  clearTimeout(formulaEvaluationTimer);
  formulaEvaluationTimer = setTimeout(
    () => requestTableSource(),
    FORMULA_EVALUATION_DEBOUNCE_MS,
  );
}

function applyModel(model: EditorModelMessage): void {
  if (
    !revision.acceptAuthoritativeState({
      clientRevision: model.acknowledgedClientRevision,
      contentRevision: model.contentRevision,
    })
  ) {
    return;
  }
  clearTimeout(previewTimer);
  clearTimeout(rhaiEvaluationTimer);
  clearTimeout(formulaEvaluationTimer);
  pendingRhaiScriptRevision = undefined;
  pendingFormulaRevision = undefined;
  title.value = model.title;
  markdown.value = model.markdown;
  title.disabled = model.editingLocked;
  markdown.disabled = model.editingLocked;
  requireElement("format").textContent = model.inspection.format;
  requireElement("database-version").textContent = String(
    model.inspection.database_user_version,
  );
  renderDataViewReferences(model.inspection.validation, model.validationCurrent);
  renderDataSourceRegistry(model.dataSourceRegistry, model.editingLocked);
  renderTableSourceOptions(model.dataSourceRegistry.sources);
  renderAttachments(model);
  renderDatabaseObjects(model);
  renderValidation(model.inspection.validation, model.validationCurrent);
  preview.innerHTML = model.previewHtml;
  root.dataset.state = "ready";
}

function renderTableSourceOptions(sources: readonly DataSource[]): void {
  const tabularSources = sources.filter(isTabularSource);
  tableSourceDefinitions = tabularSources.map(cloneDataSource);
  const names = new Set(tabularSources.map((source) => source.name));
  if (!selectedTableSource || !names.has(selectedTableSource)) {
    selectedTableSource = tabularSources[0]?.name;
  }

  tableSource.replaceChildren();
  for (const source of tabularSources) {
    const option = document.createElement("option");
    option.value = source.name;
    option.textContent = `${source.name} · ${source.type}`;
    option.selected = source.name === selectedTableSource;
    tableSource.append(option);
  }
  tableSource.disabled = tabularSources.length === 0;
  host.setState({
    ...(host.getState() ?? {}),
    selectedTableSource,
  });
  requestTableSource();
  requestRhaiScript();
  renderFormulaProgram();
}

function isTabularSource(source: DataSource): boolean {
  return (
    source.type === "sqlite" ||
    source.type === "rhai" ||
    source.type === "formula"
  );
}

function requestTableSource(): void {
  tableRequestId += 1;
  currentTable = undefined;
  tableGridHost.hidden = true;
  if (!selectedTableSource) {
    setStatus(
      tableSourceStatus,
      "No table-compatible sources are defined. Add one in the Sources tab.",
      "stale",
    );
    return;
  }
  if (!revision.initialized) return;
  if (selectedRhaiSource()) {
    rhaiEvaluationComplete = false;
    rhaiEvaluationIssue = undefined;
    rhaiEditor.setDiagnostic(undefined);
    updateRhaiScriptStatus();
  }
  if (selectedFormulaSource()) {
    formulaEvaluationComplete = false;
    formulaEvaluationIssue = undefined;
    formulaEditor.setDiagnostic(undefined);
    updateFormulaProgramStatus();
  }
  setStatus(tableSourceStatus, `Loading ${selectedTableSource}…`, "stale");
  host.postMessage({
    type: "dataSourceTable",
    clientRevision: revision.clientRevision,
    requestId: tableRequestId,
    source: selectedTableSource,
  });
}

function renderTableSourceResult(
  message: Extract<EditorHostMessage, { type: "dataSourceTable" }>,
): void {
  if (
    message.requestId !== tableRequestId ||
    message.source !== selectedTableSource
  ) {
    return;
  }
  if (!message.table) {
    currentTable = undefined;
    tableGridHost.hidden = true;
    setStatus(
      tableSourceStatus,
      message.issue ?? "The selected source could not be displayed as a table.",
      "invalid",
    );
    applyRhaiEvaluationIssue(message.issue);
    applyFormulaEvaluationIssue(message.issue);
    return;
  }
  currentTable = message.table;
  tableGridHost.hidden = false;
  renderTableGrid(message.table);
  setStatus(
    tableSourceStatus,
    `${message.table.rows.length.toLocaleString()} row${message.table.rows.length === 1 ? "" : "s"} · ${message.table.columns.length.toLocaleString()} column${message.table.columns.length === 1 ? "" : "s"}`,
    "valid",
  );
  applyRhaiEvaluationIssue(undefined);
  applyFormulaEvaluationIssue(undefined);
}

function renderFormulaProgram(): void {
  clearTimeout(formulaEvaluationTimer);
  const source = selectedFormulaSource();
  if (!source) {
    formulaProgramPanel.hidden = true;
    formulaEditor.disabled = true;
    formulaEditor.value = "";
    formulaEditor.setDiagnostic(undefined);
    return;
  }
  formulaProgramPanel.hidden = false;
  formulaProgramInput.textContent = `Input: ${source.input} · source order`;
  formulaColumnLegend.replaceChildren(
    ...source.outputColumns.map((column, index) => {
      const label = document.createElement("code");
      label.textContent = `${spreadsheetColumnName(index)} · ${column}`;
      return label;
    }),
  );
  formulaEditor.value = source.program;
  formulaEditor.disabled = !dataSourcesEditable || dataSourceEditingLocked;
  updateFormulaProgramStatus();
}

function requestRhaiScript(): void {
  rhaiScriptRequestId += 1;
  currentRhaiScriptPath = undefined;
  rhaiEvaluationComplete = false;
  rhaiEvaluationIssue = undefined;
  rhaiEditor.setDiagnostic(undefined);
  const source = selectedRhaiSource();
  if (!source) {
    rhaiScriptPanel.hidden = true;
    rhaiEditor.disabled = true;
    rhaiEditor.value = "";
    return;
  }
  rhaiScriptPanel.hidden = false;
  rhaiScriptPath.textContent = source.script;
  rhaiScriptError.hidden = true;
  rhaiScriptError.textContent = "";
  rhaiEditor.disabled = true;
  setStatus(rhaiScriptStatus, "Loading script…", "stale");
  if (!revision.initialized) return;
  host.postMessage({
    type: "rhaiScript",
    clientRevision: revision.clientRevision,
    requestId: rhaiScriptRequestId,
    source: source.name,
  });
}

function renderRhaiScriptResult(
  message: Extract<EditorHostMessage, { type: "rhaiScript" }>,
): void {
  const source = selectedRhaiSource();
  if (
    !source ||
    message.requestId !== rhaiScriptRequestId ||
    message.source !== source.name
  ) {
    return;
  }
  if (!message.script) {
    currentRhaiScriptPath = undefined;
    rhaiEditor.disabled = true;
    rhaiScriptError.hidden = false;
    rhaiScriptError.textContent =
      message.issue ?? "The Rhai script attachment could not be loaded.";
    setStatus(rhaiScriptStatus, "Script unavailable", "invalid");
    return;
  }
  currentRhaiScriptPath = message.script.logicalPath;
  rhaiScriptPath.textContent = message.script.logicalPath;
  rhaiEditor.value = message.script.text;
  rhaiEditor.disabled = !dataSourcesEditable || dataSourceEditingLocked;
  rhaiScriptError.hidden = true;
  rhaiScriptError.textContent = "";
  updateRhaiScriptStatus();
}

function selectedRhaiSource(): RhaiDataSource | undefined {
  const source = tableSourceDefinitions.find(
    (candidate) => candidate.name === selectedTableSource,
  );
  return source?.type === "rhai" ? source : undefined;
}

function selectedFormulaSource(): FormulaDataSource | undefined {
  const source = tableSourceDefinitions.find(
    (candidate) => candidate.name === selectedTableSource,
  );
  return source?.type === "formula" ? source : undefined;
}

function applyRhaiEvaluationIssue(issue: string | undefined): void {
  if (!selectedRhaiSource()) return;
  rhaiEvaluationComplete = true;
  rhaiEvaluationIssue = issue;
  rhaiEditor.setDiagnostic(issue ? rhaiDiagnosticFromIssue(issue) : undefined);
  updateRhaiScriptStatus();
}

function updateRhaiScriptStatus(): void {
  if (!selectedRhaiSource() || currentRhaiScriptPath === undefined) return;
  if (rhaiEvaluationIssue) {
    setStatus(rhaiScriptStatus, "Error", "invalid");
    rhaiScriptError.hidden = false;
    rhaiScriptError.textContent = rhaiEvaluationIssue;
  } else if (!rhaiEvaluationComplete) {
    setStatus(rhaiScriptStatus, "Checking…", "stale");
    rhaiScriptError.hidden = true;
    rhaiScriptError.textContent = "";
  } else {
    setStatus(rhaiScriptStatus, "No errors", "valid");
    rhaiScriptError.hidden = true;
    rhaiScriptError.textContent = "";
  }
}

function applyFormulaEvaluationIssue(issue: string | undefined): void {
  if (!selectedFormulaSource()) return;
  formulaEvaluationComplete = true;
  formulaEvaluationIssue = issue;
  formulaEditor.setDiagnostic(
    issue ? formulaDiagnosticFromIssue(issue) : undefined,
  );
  updateFormulaProgramStatus();
}

function updateFormulaProgramStatus(): void {
  if (!selectedFormulaSource()) return;
  if (formulaEvaluationIssue) {
    setStatus(formulaProgramStatus, "Error", "invalid");
    formulaProgramError.hidden = false;
    formulaProgramError.textContent = formulaEvaluationIssue;
  } else if (!formulaEvaluationComplete) {
    setStatus(formulaProgramStatus, "Checking…", "stale");
    formulaProgramError.hidden = true;
    formulaProgramError.textContent = "";
  } else {
    setStatus(formulaProgramStatus, "No errors", "valid");
    formulaProgramError.hidden = true;
    formulaProgramError.textContent = "";
  }
}

function renderTableGrid(table: DataSourceTable): void {
  if (!tableGrid) return;
  tableGrid.columns = table.columns.map(
    (name, index): ColumnRegular => ({
      name,
      prop: tableColumnProp(index),
      readonly: true,
      sortable: true,
      size: Math.min(360, Math.max(120, name.length * 8 + 36)),
    }),
  );
  tableGrid.source = table.rows.map((row) =>
    Object.fromEntries(
      row.map((cell, index) => [tableColumnProp(index), tableCellValue(cell)]),
    ) as DataType,
  );
}

function tableColumnProp(index: number): string {
  return `column-${index}`;
}

function tableCellValue(cell: DataTableCell): string | number | boolean {
  switch (cell.type) {
    case "null":
      return "NULL";
    case "integer": {
      const number = Number(cell.value);
      return Number.isSafeInteger(number) ? number : cell.value;
    }
    default:
      return cell.value;
  }
}

function renderAttachments(model: EditorModelMessage): void {
  attachments.replaceChildren();
  for (const attachment of model.inspection.attachments) {
    const item = document.createElement("li");
    item.className = "attachment";
    const label = document.createElement("span");
    label.textContent = `${attachment.logical_path} (${attachment.length} bytes)`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.disabled = model.editingLocked;
    remove.addEventListener("click", () =>
      host.postMessage({
        type: "removeAttachment",
        logicalPath: attachment.logical_path,
      }),
    );
    item.append(label, remove);
    attachments.append(item);
  }
}

function renderDatabaseObjects(model: EditorModelMessage): void {
  databaseObjects.replaceChildren();
  for (const object of model.inspection.database.objects) {
    const item = document.createElement("li");
    item.textContent = `${object.type}: ${object.name}`;
    databaseObjects.append(item);
  }
}

function renderDataViewReferences(
  report: ValidationReport | undefined,
  current: boolean,
): void {
  dataViewReferences.replaceChildren();
  const references = report?.data_view_references ?? [];
  if (references.length === 0) {
    appendStatusItem(dataViewReferences, "No dynamic views found.", "stale");
  }
  for (const reference of references) {
    appendStatusItem(
      dataViewReferences,
      `view: ${reference.render} · source: ${reference.source}${
        reference.resolved ? "" : " (unresolved)"
      }`,
      reference.resolved ? "valid" : "invalid",
    );
  }
  if (!current) {
    appendStatusItem(
      dataViewReferences,
      "Save and validate to refresh this list.",
      "stale",
    );
  }
}

function renderValidation(
  report: ValidationReport | undefined,
  current: boolean,
): void {
  validation.replaceChildren();
  const status = document.createElement("p");
  if (!current || !report) {
    setStatus(status, "Validation required", "stale");
    validation.append(status);
    return;
  }
  setStatus(status, report.valid ? "Valid" : "Validation errors", report.valid ? "valid" : "invalid");
  validation.append(status);
  const issues = document.createElement("ul");
  for (const issue of report.issues) {
    const item = document.createElement("li");
    item.textContent = `${issue.severity} [${issue.code}]: ${issue.message}`;
    issues.append(item);
  }
  validation.append(issues);
}

function renderDataSourceRegistry(
  registry: DataSourceRegistryView,
  editingLocked: boolean,
): void {
  dataSourcesEditable = registry.editable;
  dataSourceEditingLocked = editingLocked;
  dataSourceDrafts = registry.sources.map(cloneDataSource);
  dataSourceRegistryIssue.textContent = registry.issue ?? "";
  dataSourceRegistryRaw.hidden = typeof registry.rawRegistry !== "string";
  dataSourceRegistryRaw.textContent = registry.rawRegistry ?? "";
  addSqliteDataSource.disabled = !dataSourcesEditable || dataSourceEditingLocked;
  addRhaiDataSource.disabled = !dataSourcesEditable || dataSourceEditingLocked;
  addFormulaDataSource.disabled = !dataSourcesEditable || dataSourceEditingLocked;
  applyDataSources.disabled = !dataSourcesEditable || dataSourceEditingLocked;
  setStatus(
    dataSourceStatus,
    dataSourcesEditable
      ? "Edit a source, then apply the changes to make the document dirty."
      : "This registry is read-only in the current editor.",
    dataSourcesEditable ? "stale" : "invalid",
  );
  renderDataSourceDrafts();
}

function renderDataSourceDrafts(): void {
  dataSources.replaceChildren();
  for (const [index, source] of dataSourceDrafts.entries()) {
    const card = document.createElement("section");
    card.className = "data-source-card";
    const heading = document.createElement("div");
    heading.className = "data-source-heading";
    const type = document.createElement("span");
    type.className = "data-source-type";
    type.textContent = `type: ${source.type}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.disabled = !dataSourcesEditable || dataSourceEditingLocked;
    remove.addEventListener("click", () => {
      dataSourceDrafts.splice(index, 1);
      renderDataSourceDrafts();
      markDataSourceDraftChanged();
    });
    heading.append(type, remove);
    card.append(heading);
    card.append(
      labelledInput("Source name", source.name, (value) => {
        source.name = value;
        markDataSourceDraftChanged();
      }),
    );
    if (source.type === "sqlite") {
      card.append(
        labelledTextarea("SQL query", source.query, "source-query", (value) => {
          source.query = value;
          markDataSourceDraftChanged();
        }),
      );
    } else if (source.type === "rhai") {
      card.append(
        labelledInput("Rhai script attachment path", source.script, (value) => {
          source.script = value;
          markDataSourceDraftChanged();
        }),
        labelledTextarea(
          "SQLite inputs (one alias = source mapping per line)",
          rhaiInputMappingsText(source.inputs),
          "source-definition",
          (value) => {
            source.inputs = parseRhaiInputMappings(value);
            markDataSourceDraftChanged();
          },
        ),
        labelledTextarea(
          "Table output columns (one per line, in display order)",
          source.outputColumns.join("\n"),
          "source-definition",
          (value) => {
            source.outputColumns = parseOutputColumns(value);
            markDataSourceDraftChanged();
          },
        ),
      );
    } else {
      card.append(
        labelledInput("SQLite input source", source.input, (value) => {
          source.input = value;
          markDataSourceDraftChanged();
        }),
        labelledTextarea(
          "Formula program (one cell assignment per line)",
          source.program,
          "source-query",
          (value) => {
            source.program = value;
            markDataSourceDraftChanged();
          },
        ),
        labelledTextarea(
          "Table output columns (input columns first, then derived columns)",
          source.outputColumns.join("\n"),
          "source-definition",
          (value) => {
            source.outputColumns = parseOutputColumns(value);
            markDataSourceDraftChanged();
          },
        ),
      );
    }
    dataSources.append(card);
  }
  if (dataSourceDrafts.length === 0 && dataSourcesEditable) {
    const empty = document.createElement("p");
    setStatus(empty, "No data sources are defined.", "stale");
    dataSources.append(empty);
  }
}

function labelledInput(
  labelText: string,
  value: string,
  onInput: (value: string) => void,
): HTMLElement {
  const field = document.createElement("label");
  field.className = "source-field";
  const label = document.createElement("span");
  label.textContent = labelText;
  const input = document.createElement("input");
  input.type = "text";
  input.value = value;
  input.disabled = !dataSourcesEditable || dataSourceEditingLocked;
  input.addEventListener("input", () => onInput(input.value));
  field.append(label, input);
  return field;
}

function labelledTextarea(
  labelText: string,
  value: string,
  className: string,
  onInput: (value: string) => void,
): HTMLElement {
  const field = document.createElement("label");
  field.className = "source-field";
  const label = document.createElement("span");
  label.textContent = labelText;
  const textarea = document.createElement("textarea");
  textarea.className = className;
  textarea.spellcheck = false;
  textarea.value = value;
  textarea.disabled = !dataSourcesEditable || dataSourceEditingLocked;
  textarea.addEventListener("input", () => onInput(textarea.value));
  field.append(label, textarea);
  return field;
}

function cloneDataSource(source: DataSource): DataSource {
  if (source.type === "rhai") {
    return {
      ...source,
      inputs: source.inputs.map((input) => ({ ...input })),
      outputColumns: [...source.outputColumns],
    };
  }
  return source.type === "formula"
    ? { ...source, outputColumns: [...source.outputColumns] }
    : { ...source };
}

function parseRhaiInputMappings(value: string): RhaiDataSource["inputs"] {
  return value
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const separator = line.indexOf("=");
      return separator < 0
        ? { alias: line.trim(), source: "" }
        : {
            alias: line.slice(0, separator).trim(),
            source: line.slice(separator + 1).trim(),
          };
    });
}

function rhaiInputMappingsText(inputs: RhaiDataSource["inputs"]): string {
  return inputs.map((input) => `${input.alias} = ${input.source}`).join("\n");
}

function parseOutputColumns(value: string): string[] {
  return value.split(/\r?\n/).filter((column) => column.length > 0);
}

function nextDataSourceName(prefix: string): string {
  const names = new Set(dataSourceDrafts.map((source) => source.name));
  let suffix = 1;
  while (names.has(`${prefix}-${suffix}`)) suffix += 1;
  return `${prefix}-${suffix}`;
}

function validateDataSourceDrafts(): string | undefined {
  const names = new Set<string>();
  for (const source of dataSourceDrafts) {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(source.name)) {
      return "Source names must use 1-128 ASCII letters, digits, '.', '_' or '-'.";
    }
    if (names.has(source.name)) return "Source names must be unique.";
    names.add(source.name);
  }
  const definitions = new Map(dataSourceDrafts.map((source) => [source.name, source]));
  for (const source of dataSourceDrafts) {
    if (source.type === "sqlite") {
      if (source.query.trim() === "") return "SQLite queries cannot be empty.";
      if (new TextEncoder().encode(source.query).length > 65_536) {
        return "SQLite queries must be at most 65536 UTF-8 bytes.";
      }
      continue;
    }
    if (source.type === "rhai") {
      const pathIssue = validateScriptPath(source.script);
      if (pathIssue) return pathIssue;
      if (source.inputs.length === 0 || source.inputs.length > 16) {
        return "Rhai sources require 1-16 SQLite input mappings.";
      }
      const aliases = new Set<string>();
      for (const input of source.inputs) {
        if (!/^[A-Za-z0-9._-]{1,128}$/.test(input.alias)) {
          return "Rhai input aliases use the same characters as source names.";
        }
        if (aliases.has(input.alias)) return "Rhai input aliases must be unique.";
        aliases.add(input.alias);
        if (!/^[A-Za-z0-9._-]{1,128}$/.test(input.source)) {
          return "Each Rhai input must name a SQLite source.";
        }
        const target = definitions.get(input.source);
        if (!target) return "Each Rhai input must reference an existing source.";
        if (target.type !== "sqlite") return "Rhai inputs can reference SQLite sources only.";
      }
    } else {
      if (new TextEncoder().encode(source.program).length > MAX_FORMULA_PROGRAM_BYTES) {
        return `Formula programs must be at most ${MAX_FORMULA_PROGRAM_BYTES} UTF-8 bytes.`;
      }
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(source.input)) {
        return "Formula inputs must name a SQLite source.";
      }
      const target = definitions.get(source.input);
      if (!target) return "Each Formula input must reference an existing source.";
      if (target.type !== "sqlite") return "Formula inputs can reference SQLite sources only.";
    }
    if (source.outputColumns.length === 0 || source.outputColumns.length > 128) {
      return `${source.type === "rhai" ? "Rhai" : "Formula"} table outputs require 1-128 columns.`;
    }
    const columns = new Set<string>();
    for (const column of source.outputColumns) {
      const length = new TextEncoder().encode(column).length;
      if (length === 0 || length > 256) {
        return `${source.type === "rhai" ? "Rhai" : "Formula"} output columns must use 1-256 UTF-8 bytes.`;
      }
      if (columns.has(column)) {
        return `${source.type === "rhai" ? "Rhai" : "Formula"} output columns must be unique.`;
      }
      columns.add(column);
    }
  }
  return undefined;
}

function validateScriptPath(script: string): string | undefined {
  if (script === "") return "Rhai script attachment paths cannot be empty.";
  if (script.includes("\\") || script.startsWith("/")) {
    return "Rhai script paths must be relative canonical paths using '/'.";
  }
  const parts = script.split("/");
  if (
    parts.some(
      (part) => part === "" || part === "." || part === ".." || part.includes(":"),
    ) ||
    /[\u0000-\u001f\u007f]/.test(script)
  ) {
    return "Rhai script paths must be canonical attachment paths without '.', '..', ':' or control characters.";
  }
  if (["manifest.json", "index.md", "attachments.json", "db/main.sqlite3"].includes(script)) {
    return "The selected Rhai script path is reserved by the TMD container.";
  }
  return undefined;
}

function markDataSourceDraftChanged(): void {
  setStatus(
    dataSourceStatus,
    "Source changes are not applied to the document yet.",
    "stale",
  );
}

function setStatus(
  element: HTMLElement,
  text: string,
  state: "valid" | "invalid" | "stale",
): void {
  element.className = state;
  element.textContent = text;
}

function appendStatusItem(
  list: HTMLUListElement,
  text: string,
  state: "valid" | "invalid" | "stale",
): void {
  const item = document.createElement("li");
  setStatus(item, text, state);
  list.append(item);
}

function requireElement<ElementType extends HTMLElement = HTMLElement>(
  id: string,
): ElementType {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`TMD editor element #${id} is missing.`);
  }
  return element as ElementType;
}

function isEditorHostMessage(value: unknown): value is EditorHostMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value.type === "model" ||
      value.type === "editAck" ||
      value.type === "preview" ||
      value.type === "dataSourceTable" ||
      value.type === "rhaiScript")
  );
}
