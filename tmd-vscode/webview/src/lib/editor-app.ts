import { defineCustomElements } from "@revolist/revogrid/loader";
import type {
  BeforeRangeSaveDataDetails,
  BeforeSaveDataDetails,
  ChangedRange,
  ColumnRegular,
  DataType,
  FocusAfterRenderEvent,
  InitialHeaderClick,
  RangeArea,
} from "@revolist/revogrid";
import { formulaDiagnosticFromIssue } from "../../../src/formula-diagnostics.js";
import {
  isComputedFormulaDataSource,
  isManagedFormulaDataSource,
  isQueryFormulaDataSource,
} from "../../../src/data-sources.js";
import {
  cloneManagedFormulaSource,
  createManagedFormulaDataSource,
  duplicateManagedColumn,
  duplicateManagedRow,
  effectiveCellConstraint,
  extractManagedRange,
  findNormalizationCandidate,
  insertManagedColumn,
  insertManagedRow,
  managedCellText,
  managedLiteralConstraintIssue,
  managedVisibleColumnCount,
  normalizeManagedColumns,
  applyReferenceGroupSelection,
  managedReferenceGroupAt,
  referenceGroupSelection,
  releaseManagedReferenceGroup,
  renameManagedColumn,
  renameManagedReferencedColumn,
  renameManagedReferenceIdentity,
  renameManagedReferencedSource,
  setManagedCellText,
  type ManagedTableRange,
  type NormalizationCandidate,
} from "../../../src/managed-table.js";
import {
  formulaExpressionForCell,
  insertFormulaColumns,
  insertFormulaRows,
  setFormulaCellExpression,
  spreadsheetCellName,
  spreadsheetColumnName,
  translateFormulaExpression,
} from "../../../src/formula-program.js";
import { EditorClientState, PREVIEW_DEBOUNCE_MS } from "../../../src/input.js";
import { setupEditorTabs } from "../../../src/tabs.js";
import { rhaiDiagnosticFromIssue } from "../../../src/rhai-diagnostics.js";
import {
  changedTableCells,
  tablesHaveSameShape,
} from "../../../src/table-refresh.js";
import type {
  DataSource,
  DataSourceRegistryView,
  DataSourceTable,
  DataTableCell,
  DatabaseCellEdit,
  ComputedFormulaDataSource,
  FormulaDataSource,
  ManagedCellConstraint,
  ManagedFormulaDataSource,
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
const MAX_TABLE_ROWS = 1_000;
const MAX_TABLE_COLUMNS = 128;
const MAX_TABLE_CELLS = 10_000;

interface EditorUiState extends Record<string, unknown> {
  activeEditorTab?: string;
  selectedTableSource?: string;
  previewVisible?: boolean;
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
const cellFormulaBar = requireElement<HTMLFormElement>("cell-formula-bar");
const cellName = requireElement<HTMLInputElement>("cell-name");
const cellInputField = requireElement<HTMLElement>("cell-input-field");
const cellInput = requireElement<HTMLInputElement>("cell-input");
const referenceTargetField = requireElement<HTMLElement>("reference-target-field");
const referenceTargetLabel = requireElement<HTMLElement>("reference-target-label");
const referenceTarget = requireElement<HTMLSelectElement>("reference-target");
const applyCellEdit = requireElement<HTMLButtonElement>("apply-cell-edit");
const cancelCellEdit = requireElement<HTMLButtonElement>("cancel-cell-edit");
const cellEditStatus = requireElement<HTMLElement>("cell-edit-status");
const tableStructureActions = requireElement<HTMLElement>(
  "table-structure-actions",
);
const addTableRow = requireElement<HTMLButtonElement>("add-table-row");
const duplicateTableRow = requireElement<HTMLButtonElement>(
  "duplicate-table-row",
);
const insertTableRow = requireElement<HTMLButtonElement>("insert-table-row");
const addTableColumn = requireElement<HTMLButtonElement>("add-table-column");
const duplicateTableColumn = requireElement<HTMLButtonElement>(
  "duplicate-table-column",
);
const insertTableColumn = requireElement<HTMLButtonElement>(
  "insert-table-column",
);
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
const addManagedFormulaDataSource = requireElement<HTMLButtonElement>(
  "add-managed-formula-data-source",
);
const addRhaiDataSource = requireElement<HTMLButtonElement>("add-rhai-data-source");
const applyDataSources = requireElement<HTMLButtonElement>("apply-data-sources");
const dataSourceStatus = requireElement<HTMLElement>("data-source-status");
const validation = requireElement<HTMLElement>("validation");
const preview = requireElement<HTMLElement>("preview");
const previewCard = requireElement<HTMLElement>("preview-card");
const togglePreview = requireElement<HTMLButtonElement>("toggle-preview");
const cellConstraint = requireElement<HTMLSelectElement>("cell-constraint");
const columnConstraint = requireElement<HTMLSelectElement>("column-constraint");
const columnName = requireElement<HTMLInputElement>("column-name");
const extractTableRange = requireElement<HTMLButtonElement>("extract-table-range");
const normalizationStatus = requireElement<HTMLElement>("normalization-status");
const normalizationSummary = requireElement<HTMLElement>("normalization-summary");
const normalizeTableRange = requireElement<HTMLButtonElement>("normalize-table-range");
const tableContextMenu = requireElement<HTMLElement>("table-context-menu");
const normalizationDialog = requireElement<HTMLDialogElement>("normalization-dialog");
const normalizationDialogSummary = requireElement<HTMLElement>(
  "normalization-dialog-summary",
);
const normalizationTableName = requireElement<HTMLInputElement>(
  "normalization-table-name",
);
const confirmNormalization = requireElement<HTMLButtonElement>(
  "confirm-normalization",
);

let previewTimer: ReturnType<typeof setTimeout> | undefined;
let rhaiEvaluationTimer: ReturnType<typeof setTimeout> | undefined;
let formulaEvaluationTimer: ReturnType<typeof setTimeout> | undefined;
let dataSourceDrafts: DataSource[] = [];
let tableSourceDefinitions: DataSource[] = [];
let dataSourcesEditable = false;
let dataSourceEditingLocked = true;
let dataSourceDraftDirty = false;
let pendingDataSourceRevision: number | undefined;
let pendingRhaiScriptRevision: number | undefined;
let pendingFormulaRevision: number | undefined;
let pendingSpreadsheetEdit: SpreadsheetEditMeasurement | undefined;
let tableRenderMeasurement: TableRenderMeasurement | undefined;
let selectedTableSource = host.getState()?.selectedTableSource;
let previewVisible = host.getState()?.previewVisible ?? true;
let tableRequestId = 0;
let referenceTargetRequestId = 0;
const referenceTargetRequests = new Map<string, number>();
const referenceTargetTables = new Map<string, DataSourceTable>();
const referenceTargetIssues = new Map<string, string>();
let rhaiScriptRequestId = 0;
let currentTable: DataSourceTable | undefined;
let currentTableSource: string | undefined;
let tableGrid: HTMLRevoGridElement | undefined;
let currentRhaiScriptPath: string | undefined;
let rhaiEvaluationComplete = false;
let rhaiEvaluationIssue: string | undefined;
let formulaEvaluationComplete = false;
let formulaEvaluationIssue: string | undefined;
let selectedCell: TableCellPosition | undefined;
let editingCell: TableCellPosition | undefined;
let formulaBarEditing = false;
let insertedReference: { start: number; end: number } | undefined;
let pendingPreviewCell: HTMLTableCellElement | undefined;
let previewCellEdit: PreviewCellEdit | undefined;
let deferredPreviewHtml: string | undefined;
let tableStructurePending = false;
let selectedTableRange: ManagedTableRange | undefined;
let normalizationCandidate: NormalizationCandidate | undefined;
let pendingTableSourcesRollback: DataSource[] | undefined;
let pendingTableSourceOptionsRefresh = false;

interface TableCellPosition {
  row: number;
  column: number;
}

interface PreviewCellEdit {
  cell: HTMLTableCellElement;
  source: string;
  row: number;
  column: number;
  originalText: string;
}

interface SpreadsheetEditMeasurement {
  clientRevision: number;
  startedAt: number;
  operation: "Cell edit" | "Range edit" | "Fill" | "Structure edit";
  optimisticRenderMs?: number;
}

interface TableRenderMeasurement
  extends Omit<SpreadsheetEditMeasurement, "clientRevision"> {
  requestId: number;
}

void Promise.resolve(defineCustomElements()).then(() => {
  const grid = document.createElement("revo-grid");
  grid.setAttribute("aria-label", "Selected data source table");
  grid.theme = "compact";
  grid.readonly = false;
  grid.resize = true;
  grid.autoSizeColumn = { allColumns: true };
  grid.rowHeaders = true;
  grid.range = true;
  grid.stretch = true;
  grid.useClipboard = true;
  grid.addEventListener("afterfocus", handleTableFocus);
  grid.addEventListener("beforeeditstart", handleTableEditStart);
  grid.addEventListener("beforeedit", handleTableEdit);
  grid.addEventListener("beforerangeedit", handleTableRangeEdit);
  grid.addEventListener("beforeautofill", handleTableAutofill);
  grid.addEventListener("beforerange", handleTableRangeSelection);
  grid.addEventListener("setrange", handleTableSetRange);
  grid.addEventListener("beforeheaderclick", handleTableHeaderClick);
  grid.addEventListener("contextmenu", handleTableContextMenu);
  tableGrid = grid;
  tableGridHost.replaceChildren(grid);
  if (currentTable) void renderTableGrid(currentTable);
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
cellFormulaBar.addEventListener("submit", (event) => {
  event.preventDefault();
  applyFormulaBarEdit();
});
cellInput.addEventListener("focus", () => {
  if (!selectedCell) return;
  editingCell = { ...selectedCell };
  formulaBarEditing = true;
  insertedReference = undefined;
});
cellInput.addEventListener("input", () => {
  formulaBarEditing = true;
  insertedReference = undefined;
});
referenceTarget.addEventListener("change", applySelectedReferenceTarget);
cancelCellEdit.addEventListener("click", () => {
  formulaBarEditing = false;
  editingCell = undefined;
  insertedReference = undefined;
  renderSelectedCell();
});
cellConstraint.addEventListener("change", applySelectedCellConstraint);
columnConstraint.addEventListener("change", () => {
  if (selectedCell && isManagedConstraint(columnConstraint.value)) {
    applyColumnConstraint(selectedCell.column, columnConstraint.value);
  }
});
columnName.addEventListener("change", applySelectedColumnName);
columnName.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  applySelectedColumnName();
});
addTableRow.addEventListener("click", () => addFormulaTableRow());
duplicateTableRow.addEventListener("click", () => duplicateFormulaTableRow());
insertTableRow.addEventListener("click", () => insertFormulaTableRow());
addTableColumn.addEventListener("click", () => addFormulaTableColumn());
duplicateTableColumn.addEventListener("click", () =>
  duplicateFormulaTableColumn(),
);
insertTableColumn.addEventListener("click", () => insertFormulaTableColumn());
extractTableRange.addEventListener("click", extractSelectedManagedRange);
normalizeTableRange.addEventListener("click", openNormalizationDialog);
confirmNormalization.addEventListener("click", applyNormalization);
document.addEventListener("pointerdown", (event) => {
  if (event.target instanceof Node && !tableContextMenu.contains(event.target)) {
    tableContextMenu.hidden = true;
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") tableContextMenu.hidden = true;
});

requireElement("validate").addEventListener("click", () =>
  host.postMessage({ type: "validate" }),
);
requireElement("add-attachment").addEventListener("click", () =>
  host.postMessage({ type: "addAttachment" }),
);
requireElement("export-html").addEventListener("click", () =>
  host.postMessage({ type: "exportHtml" }),
);
togglePreview.addEventListener("click", () => {
  previewVisible = !previewVisible;
  renderPreviewVisibility();
  host.setState({
    ...(host.getState() ?? {}),
    previewVisible,
  });
});
renderPreviewVisibility();
preview.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest("a")) {
    event.preventDefault();
  }
});
preview.addEventListener("dblclick", handlePreviewDoubleClick);
preview.addEventListener("keydown", handlePreviewKeydown);
preview.addEventListener("focusout", handlePreviewFocusOut);

tableSource.addEventListener("change", () => {
  clearTimeout(formulaEvaluationTimer);
  selectedTableSource = tableSource.value || undefined;
  resetCellEditor();
  host.setState({
    ...(host.getState() ?? {}),
    selectedTableSource,
  });
  requestTableSource();
  requestRhaiScript();
  renderFormulaProgram();
});

addManagedFormulaDataSource.addEventListener("click", () => {
  dataSourceDrafts.push(
    createManagedFormulaDataSource(nextDataSourceName("table")),
  );
  renderDataSourceDrafts();
  markDataSourceDraftChanged();
});

addRhaiDataSource.addEventListener("click", () => {
  const name = nextDataSourceName("view");
  const formulaSource = dataSourceDrafts.find(
    (candidate) => candidate.type === "formula",
  );
  dataSourceDrafts.push({
    name,
    type: "rhai",
    script: `views/${name}.rhai`,
    inputs: [{ alias: "rows", source: formulaSource?.name ?? "" }],
    outputColumns: ["value"],
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
  applyDataSources.disabled = true;
  setStatus(dataSourceStatus, "Applying source changes…", "stale");
});

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (!isEditorHostMessage(event.data)) return;
  const message = event.data;
  if (message.type === "preview") {
    if (revision.acceptPreview(message)) {
      replacePreviewHtml(message.previewHtml);
    }
    return;
  }
  if (message.type === "editRejected") {
    if (!revision.acceptEditAcknowledgement(message)) return;
    handleRejectedEdit(message.clientRevision, message.issue);
    return;
  }
  if (message.type === "editAck") {
    if (!revision.acceptEditAcknowledgement(message)) return;
    if (message.applied === false) {
      handleRejectedEdit(
        message.clientRevision,
        message.notice ?? "This edit was superseded and was not applied.",
      );
      return;
    }
    if (message.notice) setCellEditStatus(message.notice, "stale");
    if (message.clientRevision === pendingDataSourceRevision) {
      pendingDataSourceRevision = undefined;
      dataSourceDraftDirty = false;
      pendingTableSourcesRollback = undefined;
      setStatus(
        dataSourceStatus,
        "Source changes applied. Save the document to persist them.",
        "valid",
      );
      renderTableSourceOptions(dataSourceDrafts);
      applyDataSources.disabled =
        !dataSourcesEditable || dataSourceEditingLocked || !dataSourceDraftDirty;
      configurePreviewTables();
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
    if (message.clientRevision === pendingSpreadsheetEdit?.clientRevision) {
      const measurement = pendingSpreadsheetEdit;
      pendingSpreadsheetEdit = undefined;
      pendingTableSourcesRollback = undefined;
      if (pendingTableSourceOptionsRefresh) {
        pendingTableSourceOptionsRefresh = false;
        renderTableSourceOptions(tableSourceDefinitions, measurement);
      } else {
        requestTableSource(measurement);
      }
    }
    return;
  }
  if (message.type === "dataSourceTable") {
    void renderTableSourceResult(message);
    return;
  }
  if (message.type === "referenceTargetTable") {
    renderReferenceTargetTableResult(message);
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
  invalidateReferenceTargetTables();
  host.postMessage({
    type: "editDataSources",
    clientRevision,
    dataSources: sources,
  });
  renderValidation(undefined, false);
  queuePreview();
  return clientRevision;
}

function handleRejectedEdit(clientRevision: number, issue: string): void {
  const rejectedDataSources = clientRevision === pendingDataSourceRevision;
  const rejectedSpreadsheet = clientRevision === pendingSpreadsheetEdit?.clientRevision;
  const rejectedFormula = clientRevision === pendingFormulaRevision;
  const rejectedRhai = clientRevision === pendingRhaiScriptRevision;
  const ownsSourceRollback =
    pendingTableSourcesRollback !== undefined &&
    (rejectedDataSources || rejectedSpreadsheet);
  if (rejectedDataSources) pendingDataSourceRevision = undefined;
  if (rejectedSpreadsheet) pendingSpreadsheetEdit = undefined;
  if (rejectedFormula) pendingFormulaRevision = undefined;
  if (rejectedRhai) pendingRhaiScriptRevision = undefined;
  if (rejectedSpreadsheet) tableStructurePending = false;
  if (ownsSourceRollback) {
    rollbackAuthoritativeSources();
    renderDataSourceDrafts();
    renderTableSourceOptions(tableSourceDefinitions);
  }
  applyDataSources.disabled =
    !dataSourcesEditable || dataSourceEditingLocked || !dataSourceDraftDirty;
  if (rejectedDataSources) setStatus(dataSourceStatus, issue, "invalid");
  if (rejectedFormula) {
    formulaEvaluationComplete = true;
    formulaEvaluationIssue = issue;
    updateFormulaProgramStatus();
  }
  if (rejectedRhai) {
    rhaiEvaluationComplete = true;
    rhaiEvaluationIssue = issue;
    updateRhaiScriptStatus();
  }
  setCellEditStatus(issue, "invalid");
  renderTableStructureActions();
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
  const source = selectedComputedFormulaSource();
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
  const source = selectedComputedFormulaSource();
  if (!source) return;
  const program = formulaEditor.value;
  source.program = program;
  const draft = dataSourceDrafts.find(
    (candidate) => candidate.name === source.name && candidate.type === "formula",
  );
  if (!isComputedFormulaDataSource(draft)) return;
  draft.program = program;
  pendingSpreadsheetEdit = undefined;
  tableRenderMeasurement = undefined;
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

function renderPreviewVisibility(): void {
  previewCard.hidden = !previewVisible;
  root.dataset.previewVisible = String(previewVisible);
  togglePreview.textContent = previewVisible ? "Hide preview" : "Show preview";
  togglePreview.setAttribute("aria-expanded", String(previewVisible));
}

function configurePreviewTables(): void {
  pendingPreviewCell = undefined;
  for (const table of preview.querySelectorAll<HTMLTableElement>(
    "table.tmd-view-table[data-tmd-source]",
  )) {
    const source = tableSourceDefinitions.find(
      (candidate) => candidate.name === table.dataset.tmdSource,
    );
    const editable =
      dataSourcesEditable &&
      !dataSourceEditingLocked &&
      !dataSourceDraftDirty &&
      pendingDataSourceRevision === undefined &&
      pendingSpreadsheetEdit === undefined &&
      (isManagedFormulaDataSource(source) ||
        isComputedFormulaDataSource(source) ||
        (isQueryFormulaDataSource(source) && source.edit !== undefined));
    table.classList.toggle("tmd-view-table-editable", editable);
    if (!editable) continue;
    for (const cell of table.querySelectorAll<HTMLTableCellElement>(
      "td[data-tmd-row][data-tmd-column]",
    )) {
      if (isPreviewCellEditable(source, table, cell)) {
        cell.tabIndex = 0;
        cell.title = "Double-click to edit this Formula table cell";
      }
    }
  }
}

function replacePreviewHtml(html: string): void {
  if (previewCellEdit) {
    deferredPreviewHtml = html;
    return;
  }
  deferredPreviewHtml = undefined;
  preview.innerHTML = html;
  configurePreviewTables();
}

function isPreviewCellEditable(
  source: DataSource | undefined,
  table: HTMLTableElement,
  cell: HTMLTableCellElement,
): boolean {
  if (isManagedFormulaDataSource(source)) return true;
  if (isComputedFormulaDataSource(source)) return true;
  if (!isQueryFormulaDataSource(source) || !source.edit) return false;
  const column = Number(cell.dataset.tmdColumn);
  if (!Number.isSafeInteger(column)) return false;
  const heading = table.querySelectorAll<HTMLTableCellElement>("thead th")[column];
  const columnName = heading?.textContent ?? "";
  return source.edit.columns.some(
    (mapping) => mapping.sourceColumn === columnName,
  );
}

function handlePreviewDoubleClick(event: MouseEvent): void {
  const cell = previewCellFromEvent(event);
  if (!cell) return;
  const table = cell.closest<HTMLTableElement>("table[data-tmd-source]");
  const sourceName = table?.dataset.tmdSource;
  const source = tableSourceDefinitions.find(
    (candidate) => candidate.name === sourceName,
  );
  if (
    !table ||
    !sourceName ||
    !dataSourcesEditable ||
    dataSourceEditingLocked ||
    !isPreviewCellEditable(source, table, cell) ||
    (!isManagedFormulaDataSource(source) &&
      !isComputedFormulaDataSource(source) &&
      !(isQueryFormulaDataSource(source) && source.edit))
  ) {
    return;
  }
  if (
    selectedTableSource !== sourceName ||
    currentTableSource !== sourceName ||
    !currentTable
  ) {
    pendingPreviewCell = cell;
    selectedTableSource = sourceName;
    tableSource.value = sourceName;
    resetCellEditor();
    host.setState({
      ...(host.getState() ?? {}),
      selectedTableSource,
    });
    requestTableSource();
    requestRhaiScript();
    renderFormulaProgram();
    setCellEditStatus(`Loading ${sourceName} for preview editing…`, "stale");
    return;
  }
  beginPreviewCellEdit(cell);
}

function handlePreviewKeydown(event: KeyboardEvent): void {
  const cell = previewCellFromEvent(event);
  if (!cell || cell !== previewCellEdit?.cell) return;
  if (event.key === "Escape") {
    event.preventDefault();
    cancelPreviewCellEdit();
  } else if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    commitPreviewCellEdit(cell);
  }
}

function handlePreviewFocusOut(event: FocusEvent): void {
  const cell = previewCellFromEvent(event);
  if (cell && cell === previewCellEdit?.cell) commitPreviewCellEdit(cell);
}

function previewCellFromEvent(
  event: Event,
): HTMLTableCellElement | undefined {
  return event.target instanceof Element
    ? (event.target.closest(
        "td[data-tmd-row][data-tmd-column]",
      ) as HTMLTableCellElement | null) ?? undefined
    : undefined;
}

function beginPreviewCellEdit(cell: HTMLTableCellElement): void {
  const row = Number(cell.dataset.tmdRow);
  const column = Number(cell.dataset.tmdColumn);
  if (
    !currentTable ||
    !Number.isSafeInteger(row) ||
    !Number.isSafeInteger(column)
  ) {
    return;
  }
  const source = selectedFormulaSource();
  const sourceName = cell.closest<HTMLTableElement>("table[data-tmd-source]")
    ?.dataset.tmdSource;
  if (
    !source ||
    !sourceName ||
    source.name !== sourceName ||
    !dataSourcesEditable ||
    dataSourceEditingLocked ||
    dataSourceDraftDirty
    || pendingDataSourceRevision !== undefined
    || pendingSpreadsheetEdit !== undefined
  ) {
    return;
  }
  if (isQueryFormulaDataSource(source) && !isDirectCellEditable({ row, column })) {
    setCellEditStatus("This preview cell has no write-back mapping.", "invalid");
    return;
  }
  selectedCell = { row, column };
  selectedTableRange = { top: row, bottom: row, left: column, right: column };
  const managed = selectedManagedFormulaSource();
  if (managed && managedReferenceGroupAt(managed, row, column)) {
    renderSelectedCell();
    referenceTarget.focus();
    setCellEditStatus(
      "This protected reference is edited by choosing a linked row.",
      "valid",
    );
    return;
  }
  previewCellEdit = {
    cell,
    source: sourceName,
    row,
    column,
    originalText: cell.textContent ?? "",
  };
  const expression = formulaExpressionForCell(
    selectedComputedFormulaSource()?.program ?? "",
    row,
    column,
  );
  cell.textContent = managed
    ? managedCellText(managed, row, column)
    : expression
      ? `=${expression.replace(/^=/u, "")}`
      : cellTextForEditing(currentTable.rows[row]?.[column]);
  cell.contentEditable = "plaintext-only";
  cell.classList.add("is-editing");
  cell.focus();
  window.getSelection()?.selectAllChildren(cell);
  renderSelectedCell();
}

function commitPreviewCellEdit(cell: HTMLTableCellElement): void {
  const edit = previewCellEdit;
  if (!edit || cell !== edit.cell) return;
  const text = cell.textContent ?? "";
  if (
    selectedTableSource !== edit.source ||
    currentTableSource !== edit.source ||
    selectedFormulaSource()?.name !== edit.source
  ) {
    cancelPreviewCellEdit();
    setCellEditStatus(
      "Preview edit was canceled because the selected source changed.",
      "invalid",
    );
    return;
  }
  const originalText = edit.originalText;
  finishPreviewCellEdit(false);
  void applyCellText({ row: edit.row, column: edit.column }, text).then(
    (applied) => {
      if (!applied && cell.isConnected) cell.textContent = originalText;
    },
  );
}

function cancelPreviewCellEdit(): void {
  const edit = previewCellEdit;
  if (!edit) return;
  edit.cell.textContent = edit.originalText;
  finishPreviewCellEdit(true);
}

function finishPreviewCellEdit(applyDeferredPreview: boolean): void {
  const edit = previewCellEdit;
  if (!edit) return;
  previewCellEdit = undefined;
  edit.cell.contentEditable = "false";
  edit.cell.classList.remove("is-editing");
  const deferred = deferredPreviewHtml;
  deferredPreviewHtml = undefined;
  if (applyDeferredPreview && deferred !== undefined) {
    replacePreviewHtml(deferred);
  }
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
  pendingDataSourceRevision = undefined;
  pendingRhaiScriptRevision = undefined;
  pendingFormulaRevision = undefined;
  pendingSpreadsheetEdit = undefined;
  tableStructurePending = false;
  tableRenderMeasurement = undefined;
  pendingTableSourcesRollback = undefined;
  pendingTableSourceOptionsRefresh = false;
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
  replacePreviewHtml(model.previewHtml);
  if (
    model.persisted &&
    !cellEditStatus.hidden &&
    cellEditStatus.textContent?.includes("Save the document to persist it")
  ) {
    setCellEditStatus("All table edits are saved.", "valid");
  }
  root.dataset.state = "ready";
}

function renderTableSourceOptions(
  sources: readonly DataSource[],
  measurement?: SpreadsheetEditMeasurement,
): void {
  invalidateReferenceTargetTables();
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
  requestTableSource(measurement);
  requestRhaiScript();
  renderFormulaProgram();
}

function isTabularSource(source: DataSource): boolean {
  return source.type === "rhai" || source.type === "formula";
}

function requestTableSource(
  measurement?: SpreadsheetEditMeasurement,
): void {
  tableRequestId += 1;
  tableRenderMeasurement = measurement
    ? {
        requestId: tableRequestId,
        startedAt: measurement.startedAt,
        operation: measurement.operation,
        ...(measurement.optimisticRenderMs === undefined
          ? {}
          : { optimisticRenderMs: measurement.optimisticRenderMs }),
      }
    : undefined;
  if (!selectedTableSource) {
    currentTable = undefined;
    currentTableSource = undefined;
    cellFormulaBar.hidden = true;
    tableGridHost.hidden = true;
    renderTableStructureActions();
    setStatus(
      tableSourceStatus,
      "No table-compatible sources are defined. Add one in the Sources tab.",
      "stale",
    );
    return;
  }
  const canKeepCurrentTable =
    currentTable !== undefined && currentTableSource === selectedTableSource;
  if (!canKeepCurrentTable) {
    currentTable = undefined;
    currentTableSource = undefined;
    cellFormulaBar.hidden = true;
    tableGridHost.hidden = true;
    renderTableStructureActions();
  }
  if (!revision.initialized) return;
  if (selectedRhaiSource()) {
    rhaiEvaluationComplete = false;
    rhaiEvaluationIssue = undefined;
    rhaiEditor.setDiagnostic(undefined);
    updateRhaiScriptStatus();
  }
  if (selectedComputedFormulaSource()) {
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

async function renderTableSourceResult(
  message: Extract<EditorHostMessage, { type: "dataSourceTable" }>,
): Promise<void> {
  if (
    message.requestId !== tableRequestId ||
    message.source !== selectedTableSource
  ) {
    return;
  }
  if (!message.table) {
    if (pendingPreviewCell?.closest("table")?.dataset.tmdSource === message.source) {
      pendingPreviewCell = undefined;
    }
    const measurement = takeTableRenderMeasurement(message.requestId);
    if (measurement?.operation === "Structure edit") {
      tableStructurePending = false;
      renderTableStructureActions();
    }
    if (tableStructurePending && pendingSpreadsheetEdit === undefined) {
      tableStructurePending = false;
      renderTableStructureActions();
    }
    if (!currentTable || currentTableSource !== message.source) {
      currentTable = undefined;
      currentTableSource = undefined;
      tableGridHost.hidden = true;
      resetCellEditor();
    }
    normalizationStatus.hidden = true;
    normalizationCandidate = undefined;
    setStatus(
      tableSourceStatus,
      message.issue ?? "The selected source could not be displayed as a table.",
      "invalid",
    );
    applyRhaiEvaluationIssue(message.issue);
    applyFormulaEvaluationIssue(message.issue);
    if (measurement) {
      setCellEditStatus(
        `${measurement.operation} failed after ${formatDuration(performance.now() - measurement.startedAt)}: ${message.issue ?? "the table could not be evaluated"}`,
        "invalid",
      );
    }
    return;
  }
  const previousTable =
    currentTableSource === message.source ? currentTable : undefined;
  tableGridHost.hidden = false;
  const preservedGrid = await renderTableGrid(message.table, previousTable);
  if (
    message.requestId !== tableRequestId ||
    message.source !== selectedTableSource
  ) {
    return;
  }
  currentTable = message.table;
  currentTableSource = message.source;
  renderNormalizationPresence();
  if (
    selectedFormulaSource() &&
    message.table.rows.length > 0 &&
    message.table.columns.length > 0
  ) {
    if (
      !selectedCell ||
      selectedCell.row >= message.table.rows.length ||
      selectedCell.column >= message.table.columns.length
    ) {
      selectedCell = { row: 0, column: 0 };
      selectedTableRange = { top: 0, bottom: 0, left: 0, right: 0 };
    }
    renderSelectedCell();
    if (!preservedGrid) {
      void tableGrid?.setCellsFocus(
        { x: selectedCell.column, y: selectedCell.row },
        { x: selectedCell.column, y: selectedCell.row },
      );
    }
  }
  if (pendingPreviewCell?.closest("table")?.dataset.tmdSource === message.source) {
    const cell = pendingPreviewCell;
    pendingPreviewCell = undefined;
    beginPreviewCellEdit(cell);
  }
  setStatus(
    tableSourceStatus,
    `${message.table.rows.length.toLocaleString()} row${message.table.rows.length === 1 ? "" : "s"} · ${message.table.columns.length.toLocaleString()} column${message.table.columns.length === 1 ? "" : "s"}` +
      (selectedRhaiSource()
        ? " · Rhai output (read-only)"
        : selectedManagedFormulaSource()
          ? " · Managed Formula (editable)"
          : ""),
    "valid",
  );
  applyRhaiEvaluationIssue(undefined);
  applyFormulaEvaluationIssue(undefined);
  const measurement = takeTableRenderMeasurement(message.requestId);
  if (measurement) {
    if (measurement.operation === "Structure edit") {
      tableStructurePending = false;
    }
    const optimistic =
      measurement.optimisticRenderMs === undefined
        ? ""
        : ` (input shown in ${formatDuration(measurement.optimisticRenderMs)})`;
    setCellEditStatus(
      `${measurement.operation} rendered in ${formatDuration(performance.now() - measurement.startedAt)}${optimistic}. Save the document to persist it.`,
      "valid",
    );
  }
  if (tableStructurePending && pendingSpreadsheetEdit === undefined) {
    tableStructurePending = false;
  }
  renderTableStructureActions();
}

function renderFormulaProgram(): void {
  clearTimeout(formulaEvaluationTimer);
  const source = selectedComputedFormulaSource();
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

function selectedComputedFormulaSource(): ComputedFormulaDataSource | undefined {
  const source = selectedFormulaSource();
  return isComputedFormulaDataSource(source) ? source : undefined;
}

function selectedManagedFormulaSource(): ManagedFormulaDataSource | undefined {
  const source = selectedFormulaSource();
  return isManagedFormulaDataSource(source) ? source : undefined;
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
  if (!selectedComputedFormulaSource()) return;
  formulaEvaluationComplete = true;
  formulaEvaluationIssue = issue;
  formulaEditor.setDiagnostic(
    issue ? formulaDiagnosticFromIssue(issue) : undefined,
  );
  updateFormulaProgramStatus();
}

function updateFormulaProgramStatus(): void {
  if (!selectedComputedFormulaSource()) return;
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

function handleTableFocus(event: CustomEvent<FocusAfterRenderEvent>): void {
  const position = tablePositionFromFocus(event.detail);
  if (!position || !selectedFormulaSource()) return;
  if (
    (selectedComputedFormulaSource() || selectedManagedFormulaSource()) &&
    formulaBarEditing &&
    editingCell &&
    cellInput.value.startsWith("=")
  ) {
    insertFormulaReference({
      x: position.column,
      x1: position.column,
      y: position.row,
      y1: position.row,
    });
    return;
  }
  selectedCell = position;
  selectedTableRange = {
    top: position.row,
    bottom: position.row,
    left: position.column,
    right: position.column,
  };
  editingCell = undefined;
  insertedReference = undefined;
  renderSelectedCell();
  renderTableStructureActions();
}

function handleTableRangeSelection(event: CustomEvent<ChangedRange>): void {
  selectedTableRange = rangeAreaToManagedRange(event.detail.newRange);
  renderTableStructureActions();
  if (!formulaBarEditing || !editingCell || !cellInput.value.startsWith("=")) {
    return;
  }
  insertFormulaReference(event.detail.newRange);
}

function handleTableSetRange(
  event: CustomEvent<RangeArea & { type: string }>,
): void {
  if (event.detail.type !== "rgRow" || !selectedFormulaSource()) return;
  selectedTableRange = rangeAreaToManagedRange(event.detail);
  renderTableStructureActions();
  if (formulaBarEditing && editingCell && cellInput.value.startsWith("=")) {
    insertFormulaReference(event.detail);
  }
}

function rangeAreaToManagedRange(range: RangeArea): ManagedTableRange {
  return {
    top: Math.min(range.y, range.y1),
    bottom: Math.max(range.y, range.y1),
    left: Math.min(range.x, range.x1),
    right: Math.max(range.x, range.x1),
  };
}

function handleTableEditStart(event: CustomEvent<BeforeSaveDataDetails>): void {
  const position = tablePositionFromEdit(event.detail);
  if (
    !position ||
    !selectedFormulaSource() ||
    !currentTable ||
    dataSourceDraftDirty
  ) {
    event.preventDefault();
    if (dataSourceDraftDirty) {
      setCellEditStatus(
        "Apply the pending source-definition changes before editing table cells.",
        "stale",
      );
    }
    return;
  }
  const managed = selectedManagedFormulaSource();
  if (managed && managedReferenceGroupAt(managed, position.row, position.column)) {
    event.preventDefault();
    selectedCell = position;
    renderSelectedCell();
    referenceTarget.focus();
    setCellEditStatus(
      "This protected reference is edited by choosing a linked row.",
      "valid",
    );
    return;
  }
  const expression = formulaExpressionForCell(
    selectedComputedFormulaSource()?.program ?? "",
    position.row,
    position.column,
  );
  event.detail.val = managed
    ? managedCellText(managed, position.row, position.column)
    : expression
      ? `=${expression.replace(/^=/u, "")}`
      : cellTextForEditing(currentTable.rows[position.row]?.[position.column]);
}

function handleTableEdit(event: CustomEvent<BeforeSaveDataDetails>): void {
  event.preventDefault();
  const position = tablePositionFromEdit(event.detail);
  if (!position) return;
  void applyCellText(position, String(event.detail.val ?? ""));
}

async function handleTableRangeEdit(
  event: CustomEvent<BeforeRangeSaveDataDetails>,
): Promise<void> {
  event.preventDefault();
  const source = selectedManagedFormulaSource();
  if (!source) {
    setCellEditStatus(
      "Multi-cell paste and clear are available for managed Formula tables.",
      "invalid",
    );
    return;
  }
  if (
    dataSourceDraftDirty ||
    dataSourceEditingLocked ||
    pendingDataSourceRevision !== undefined ||
    pendingSpreadsheetEdit !== undefined ||
    tableStructurePending
  ) {
    setCellEditStatus(
      dataSourceDraftDirty
        ? "Apply the pending source-definition changes before editing table cells."
        : "Wait for the current table edit to finish.",
      "stale",
    );
    return;
  }
  const startedAt = performance.now();
  try {
    const updated = cloneManagedFormulaSource(source);
    const optimisticCells: Array<{
      position: TableCellPosition;
      value: DataTableCell;
    }> = [];
    for (const [displayRowText, values] of Object.entries(event.detail.data)) {
      const displayRow = Number(displayRowText);
      const row = tableRowIndex(event.detail.models[displayRow], displayRow);
      for (const [prop, value] of Object.entries(values)) {
        const column = tableColumnIndex(prop);
        if (column === undefined) continue;
        if (source.columns[column]?.identity) {
          throw new Error(
            "Identity cells must be edited one at a time so linked REF formulas can be updated safely.",
          );
        }
        const literal = setManagedCellText(
          updated,
          row,
          column,
          value === null || value === undefined ? "" : String(value),
        );
        if (literal) optimisticCells.push({ position: { row, column }, value: literal });
      }
    }
    if (event.detail.newRange) {
      selectedTableRange = rangeAreaToManagedRange(event.detail.newRange);
      selectedCell = {
        row: selectedTableRange.top,
        column: selectedTableRange.left,
      };
    }
    setCellEditStatus("Applying range edit…", "stale");
    const optimisticRenderMs = await renderOptimisticCells(
      optimisticCells,
      startedAt,
    );
    commitManagedSource(updated, {
      startedAt,
      operation: "Range edit",
      ...(optimisticRenderMs === undefined ? {} : { optimisticRenderMs }),
    });
    setCellEditStatus(
      optimisticRenderMs === undefined
        ? "Recalculating range…"
        : `Input shown in ${formatDuration(optimisticRenderMs)}; recalculating range…`,
      "stale",
    );
  } catch (error) {
    setCellEditStatus(errorMessage(error), "invalid");
  }
}

async function handleTableAutofill(
  event: CustomEvent<ChangedRange>,
): Promise<void> {
  event.preventDefault();
  const source = selectedFormulaSource();
  const managedSource = selectedManagedFormulaSource();
  const computedSource = selectedComputedFormulaSource();
  if (!source || !currentTable) return;
  if (managedSource) {
    applyManagedAutofill(event.detail, managedSource);
    return;
  }
  const startedAt = performance.now();
  try {
    let program = computedSource?.program;
    const databaseEdits: DatabaseCellEdit[] = [];
    const optimisticCells: Array<{
      position: TableCellPosition;
      value: DataTableCell;
    }> = [];
    for (const [destinationRowText, rowMapping] of Object.entries(
      event.detail.mapping,
    )) {
      const destinationRow = Number(destinationRowText);
      for (const [destinationProp, origin] of Object.entries(rowMapping)) {
        const destinationColumn = tableColumnIndex(destinationProp);
        if (destinationColumn === undefined) continue;
        const destination = { row: destinationRow, column: destinationColumn };
        const originPosition = { row: origin.rowIndex, column: origin.colIndex };
        if (
          destination.row === originPosition.row &&
          destination.column === originPosition.column
        ) {
          continue;
        }
        const expression = computedSource
          ? formulaExpressionForCell(
              computedSource.program,
              originPosition.row,
              originPosition.column,
            )
          : undefined;
        if (expression !== undefined && program !== undefined) {
          program = setFormulaCellExpression(
            program,
            destination.row,
            destination.column,
            translateFormulaExpression(
              expression,
              destination.row - originPosition.row,
              destination.column - originPosition.column,
            ),
          );
          continue;
        }
        const copiedValue =
          directInputCell(originPosition) ??
          currentTable.rows[originPosition.row]?.[originPosition.column];
        if (!copiedValue) {
          throw new Error(
            `Cell ${spreadsheetCellName(originPosition.row, originPosition.column)} has no Formula or rendered value to copy.`,
          );
        }
        if (
          computedSource &&
          program !== undefined &&
          !isDirectCellEditable(destination)
        ) {
          program = setFormulaCellExpression(
            program,
            destination.row,
            destination.column,
            formulaLiteral(copiedValue),
          );
          optimisticCells.push({ position: destination, value: copiedValue });
          continue;
        }
        databaseEdits.push(databaseEditForCell(destination, copiedValue));
        optimisticCells.push({ position: destination, value: copiedValue });
        if (program !== undefined) {
          program = setFormulaCellExpression(
            program,
            destination.row,
            destination.column,
            undefined,
          );
        }
      }
    }
    if (program === computedSource?.program && databaseEdits.length === 0) return;
    setCellEditStatus("Applying fill…", "stale");
    const optimisticRenderMs = await renderOptimisticCells(
      optimisticCells,
      startedAt,
    );
    sendSpreadsheetEdit(program, databaseEdits, {
      startedAt,
      operation: "Fill",
      ...(optimisticRenderMs === undefined ? {} : { optimisticRenderMs }),
    });
    setCellEditStatus(
      optimisticRenderMs === undefined
        ? "Recalculating fill…"
        : `Input shown in ${formatDuration(optimisticRenderMs)}; recalculating fill…`,
      "stale",
    );
  } catch (error) {
    setCellEditStatus(errorMessage(error), "invalid");
  }
}

function applyFormulaBarEdit(): void {
  const position = editingCell ?? selectedCell;
  if (!position) return;
  void applyCellText(position, cellInput.value);
}

function addFormulaTableRow(): void {
  const managed = managedStructureContext();
  if (managed) {
    const row = managed.rows.length;
    insertManagedRow(managed, row, currentTable ?? undefined);
    applyManagedStructure(managed, { row, column: selectedCell?.column ?? 0 }, "Adding row…");
    return;
  }
  const context = formulaStructureContext();
  if (!context) return;
  const row = context.table.rows.length;
  const program = setFormulaCellExpression(context.source.program, row, 0, "NULL");
  applyFormulaRowStructure(context.source, program, row, "Adding row…");
}

function duplicateFormulaTableRow(): void {
  const managed = managedStructureContext(true);
  if (managed && selectedCell) {
    const row = managed.rows.length;
    duplicateManagedRow(
      managed,
      selectedCell.row,
      row,
      currentTable ?? undefined,
    );
    applyManagedStructure(managed, { row, column: selectedCell.column }, "Duplicating row…");
    return;
  }
  const context = formulaStructureContext(true);
  if (!context || !selectedCell) return;
  const destinationRow = context.table.rows.length;
  let program = context.source.program;
  for (let column = 0; column < context.table.columns.length; column += 1) {
    const expression = formulaExpressionForCell(
      context.source.program,
      selectedCell.row,
      column,
    );
    program = setFormulaCellExpression(
      program,
      destinationRow,
      column,
      expression === undefined
        ? formulaLiteral(context.table.rows[selectedCell.row]?.[column])
        : translateFormulaExpression(
            expression,
            destinationRow - selectedCell.row,
            0,
          ),
    );
  }
  applyFormulaRowStructure(
    context.source,
    program,
    destinationRow,
    "Duplicating row…",
  );
}

function insertFormulaTableRow(): void {
  const managed = managedStructureContext(true);
  if (managed && selectedCell) {
    insertManagedRow(managed, selectedCell.row, currentTable ?? undefined);
    applyManagedStructure(managed, { ...selectedCell }, "Inserting row…");
    return;
  }
  const context = formulaStructureContext(true);
  if (!context || !selectedCell) return;
  const inputRows = context.table.inputRowCount;
  if (inputRows === undefined || selectedCell.row < inputRows) {
    setCellEditStatus(
      "Rows backed by the query cannot be shifted safely. Select a Formula-only row, or use Add row.",
      "invalid",
    );
    return;
  }
  let program = insertFormulaRows(context.source.program, selectedCell.row);
  program = setFormulaCellExpression(program, selectedCell.row, 0, "NULL");
  applyFormulaRowStructure(
    context.source,
    program,
    selectedCell.row,
    "Inserting row…",
  );
}

function applyFormulaRowStructure(
  source: ComputedFormulaDataSource,
  program: string,
  selectedRow: number,
  message: string,
): void {
  if (
    !validateFormulaStructure(
      currentTable?.rows.length === undefined
        ? 0
        : currentTable.rows.length + 1,
      source.outputColumns.length,
      program,
    )
  ) {
    return;
  }
  const startedAt = performance.now();
  setCellEditStatus(message, "stale");
  sendSpreadsheetEdit(program, [], {
    startedAt,
    operation: "Structure edit",
  });
  selectedCell = { row: selectedRow, column: selectedCell?.column ?? 0 };
  updateLocalFormulaProgram(source.name, program);
}

function addFormulaTableColumn(): void {
  const managed = managedStructureContext();
  if (managed) {
    const column = managedVisibleColumnCount(managed);
    insertManagedColumn(managed, column);
    applyManagedStructure(managed, { row: selectedCell?.row ?? 0, column }, "Adding column…");
    return;
  }
  const context = formulaStructureContext();
  if (!context) return;
  const columns = [...context.source.outputColumns];
  columns.push(uniqueColumnName(columns, "Column"));
  applyFormulaColumnStructure(
    context.source,
    context.source.program,
    columns,
    columns.length - 1,
    "Adding column…",
  );
}

function duplicateFormulaTableColumn(): void {
  const managed = managedStructureContext(true);
  if (managed && selectedCell) {
    const column = managedVisibleColumnCount(managed);
    duplicateManagedColumn(managed, selectedCell.column, column);
    applyManagedStructure(managed, { row: selectedCell.row, column }, "Duplicating column…");
    return;
  }
  const context = formulaStructureContext(true);
  if (!context || !selectedCell) return;
  const destinationColumn = context.source.outputColumns.length;
  const columns = [...context.source.outputColumns];
  columns.push(
    uniqueColumnName(
      columns,
      `${context.source.outputColumns[selectedCell.column] ?? "Column"} copy`,
    ),
  );
  let program = context.source.program;
  for (let row = 0; row < context.table.rows.length; row += 1) {
    const expression = formulaExpressionForCell(
      context.source.program,
      row,
      selectedCell.column,
    );
    program = setFormulaCellExpression(
      program,
      row,
      destinationColumn,
      expression === undefined
        ? formulaLiteral(context.table.rows[row]?.[selectedCell.column])
        : translateFormulaExpression(
            expression,
            0,
            destinationColumn - selectedCell.column,
          ),
    );
  }
  applyFormulaColumnStructure(
    context.source,
    program,
    columns,
    destinationColumn,
    "Duplicating column…",
  );
}

function insertFormulaTableColumn(): void {
  const managed = managedStructureContext(true);
  if (managed && selectedCell) {
    insertManagedColumn(managed, selectedCell.column);
    applyManagedStructure(managed, { ...selectedCell }, "Inserting column…");
    return;
  }
  const context = formulaStructureContext(true);
  if (!context || !selectedCell) return;
  const inputColumns = context.table.inputColumnCount;
  if (inputColumns === undefined || selectedCell.column < inputColumns) {
    setCellEditStatus(
      "Query-backed columns cannot be shifted safely. Select a derived Formula column, or use Add column.",
      "invalid",
    );
    return;
  }
  const columns = [...context.source.outputColumns];
  columns.splice(
    selectedCell.column,
    0,
    uniqueColumnName(columns, "Column"),
  );
  const program = insertFormulaColumns(
    context.source.program,
    selectedCell.column,
  );
  applyFormulaColumnStructure(
    context.source,
    program,
    columns,
    selectedCell.column,
    "Inserting column…",
  );
}

function applyFormulaColumnStructure(
  source: ComputedFormulaDataSource,
  program: string,
  outputColumns: string[],
  selectedColumn: number,
  message: string,
): void {
  if (
    !validateFormulaStructure(
      currentTable?.rows.length ?? 0,
      outputColumns.length,
      program,
    )
  ) {
    return;
  }
  const startedAt = performance.now();
  for (const sources of [tableSourceDefinitions, dataSourceDrafts]) {
    const candidate = sources.find((item) => item.name === source.name);
    if (isComputedFormulaDataSource(candidate)) {
      candidate.program = program;
      candidate.outputColumns = [...outputColumns];
    }
  }
  formulaEditor.value = program;
  setCellEditStatus(message, "stale");
  const clientRevision = sendDataSourceEdit(dataSourceDrafts.map(cloneDataSource));
  if (clientRevision === undefined) return;
  clearTimeout(formulaEvaluationTimer);
  tableRequestId += 1;
  pendingFormulaRevision = undefined;
  pendingSpreadsheetEdit = {
    clientRevision,
    startedAt,
    operation: "Structure edit",
  };
  tableStructurePending = true;
  selectedCell = { row: selectedCell?.row ?? 0, column: selectedColumn };
  renderFormulaProgram();
  renderTableStructureActions();
}

function managedStructureContext(
  requireSelection = false,
): ManagedFormulaDataSource | undefined {
  const source = selectedManagedFormulaSource();
  if (!source || !currentTable) return undefined;
  if (
    tableStructurePending ||
    pendingSpreadsheetEdit !== undefined ||
    pendingDataSourceRevision !== undefined
  ) {
    setCellEditStatus(
      "Wait for the current table edit to finish before changing its structure.",
      "stale",
    );
    return undefined;
  }
  if (!dataSourcesEditable || dataSourceEditingLocked) {
    setCellEditStatus("The Formula table is currently read-only.", "invalid");
    return undefined;
  }
  if (dataSourceDraftDirty) {
    setCellEditStatus(
      "Apply the pending source-definition changes before changing table structure.",
      "stale",
    );
    return undefined;
  }
  if (requireSelection && !selectedCell) {
    setCellEditStatus("Select a table cell first.", "invalid");
    return undefined;
  }
  return cloneManagedFormulaSource(source);
}

function applyManagedStructure(
  source: ManagedFormulaDataSource,
  selection: TableCellPosition,
  message: string,
): void {
  if (!validateFormulaStructure(source.rows.length, source.columns.length, "")) {
    return;
  }
  selectedCell = selection;
  selectedTableRange = {
    top: selection.row,
    bottom: selection.row,
    left: selection.column,
    right: selection.column,
  };
  setCellEditStatus(message, "stale");
  commitManagedSource(source, {
    startedAt: performance.now(),
    operation: "Structure edit",
  });
}

function formulaStructureContext(requireSelection = false):
  | { source: ComputedFormulaDataSource; table: DataSourceTable }
  | undefined {
  const source = selectedComputedFormulaSource();
  if (!source || !currentTable) return undefined;
  if (
    tableStructurePending ||
    pendingSpreadsheetEdit !== undefined ||
    pendingDataSourceRevision !== undefined
  ) {
    setCellEditStatus(
      "Wait for the current table edit to finish before changing its structure.",
      "stale",
    );
    return undefined;
  }
  if (!dataSourcesEditable || dataSourceEditingLocked) {
    setCellEditStatus("The Formula table is currently read-only.", "invalid");
    return undefined;
  }
  if (dataSourceDraftDirty) {
    setCellEditStatus(
      "Apply the pending source-definition changes before changing table structure.",
      "stale",
    );
    return undefined;
  }
  if (requireSelection && !selectedCell) {
    setCellEditStatus("Select a table cell first.", "invalid");
    return undefined;
  }
  return { source, table: currentTable };
}

function validateFormulaStructure(
  rowCount: number,
  columnCount: number,
  program: string,
): boolean {
  let issue: string | undefined;
  if (rowCount > MAX_TABLE_ROWS) {
    issue = `Formula tables support at most ${MAX_TABLE_ROWS.toLocaleString()} rows.`;
  } else if (columnCount > MAX_TABLE_COLUMNS) {
    issue = `Formula tables support at most ${MAX_TABLE_COLUMNS.toLocaleString()} columns.`;
  } else if (rowCount * columnCount > MAX_TABLE_CELLS) {
    issue = `Formula tables support at most ${MAX_TABLE_CELLS.toLocaleString()} cells.`;
  } else if (
    new TextEncoder().encode(program).length > MAX_FORMULA_PROGRAM_BYTES
  ) {
    issue = `Formula programs must be at most ${MAX_FORMULA_PROGRAM_BYTES.toLocaleString()} UTF-8 bytes.`;
  }
  if (!issue) return true;
  setCellEditStatus(issue, "invalid");
  return false;
}

function formulaLiteral(cell: DataTableCell | undefined): string {
  if (!cell || cell.type === "null") return "NULL";
  if (cell.type === "boolean") return cell.value ? "TRUE" : "FALSE";
  if (cell.type === "string") return JSON.stringify(cell.value);
  return String(cell.value);
}

function formulaLiteralFromText(text: string): string {
  const value = text.trim();
  if (value === "" || /^null$/iu.test(value)) return "NULL";
  if (/^(true|false)$/iu.test(value)) return value.toUpperCase();
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/iu.test(value)) {
    const number = Number(value);
    if (Number.isFinite(number)) return value;
  }
  return JSON.stringify(text);
}

function uniqueColumnName(columns: readonly string[], base: string): string {
  const names = new Set(columns);
  if (!names.has(base)) return base;
  let suffix = 2;
  while (names.has(`${base} ${suffix}`)) suffix += 1;
  return `${base} ${suffix}`;
}

async function applyCellText(
  position: TableCellPosition,
  text: string,
): Promise<boolean> {
  const source = selectedFormulaSource();
  const managedSource = selectedManagedFormulaSource();
  const computedSource = selectedComputedFormulaSource();
  if (!source || !currentTable) return false;
  if (dataSourceDraftDirty) {
    setCellEditStatus(
      "Apply the pending source-definition changes before editing table cells.",
      "stale",
    );
    return false;
  }
  if (
    pendingSpreadsheetEdit !== undefined ||
    pendingDataSourceRevision !== undefined ||
    tableStructurePending
  ) {
    setCellEditStatus("Wait for the current table edit to finish.", "stale");
    return false;
  }
  const startedAt = performance.now();
  try {
    if (managedSource) {
      if (managedSource.columns[position.column]?.identity) {
        const previousIdentity = currentTable.rows[position.row]?.[position.column];
        if (!previousIdentity || previousIdentity.type === "null") {
          throw new Error("Identity cells require evaluated non-null scalar values.");
        }
        const nextSources = tableSourceDefinitions.map(cloneDataSource);
        const updated = nextSources.find(
          (candidate): candidate is ManagedFormulaDataSource =>
            isManagedFormulaDataSource(candidate) &&
            candidate.name === managedSource.name,
        );
        if (!updated) throw new Error("The identity table changed before the edit was applied.");
        setManagedCellText(updated, position.row, position.column, text);
        const next = updated.rows[position.row]?.cells[position.column];
        if (
          next?.content.kind !== "literal" ||
          next.content.value.type === "null"
        ) {
          throw new Error("Identity edits require non-null literal scalar values.");
        }
        const nextIdentity = next.content.value;
        if (
          currentTable.rows.some(
            (row, index) =>
              index !== position.row &&
              dataTableCellsEqual(row[position.column], nextIdentity),
          )
        ) {
          throw new Error("Identity values must be unique within their table.");
        }
        renameManagedReferenceIdentity(
          nextSources.filter(isManagedFormulaDataSource),
          updated.name,
          previousIdentity,
          nextIdentity,
        );
        selectedCell = { ...position };
        setCellEditStatus("Updating identity and linked REF formulas…", "stale");
        commitManagedSources(nextSources, updated.name, {
          startedAt,
          operation: "Cell edit",
        });
        return true;
      }
      const updated = cloneManagedFormulaSource(managedSource);
      const literal = setManagedCellText(updated, position.row, position.column, text);
      setCellEditStatus("Applying cell edit…", "stale");
      const optimisticRenderMs = literal
        ? await renderOptimisticCells([{ position, value: literal }], startedAt)
        : undefined;
      selectedCell = { ...position };
      selectedTableRange = {
        top: position.row,
        bottom: position.row,
        left: position.column,
        right: position.column,
      };
      formulaBarEditing = false;
      editingCell = undefined;
      insertedReference = undefined;
      commitManagedSource(updated, {
        startedAt,
        operation: "Cell edit",
        ...(optimisticRenderMs === undefined ? {} : { optimisticRenderMs }),
      });
      setCellEditStatus(
        optimisticRenderMs === undefined
          ? "Recalculating cell…"
          : `Input shown in ${formatDuration(optimisticRenderMs)}; recalculating cell…`,
        "stale",
      );
      return true;
    }
    let program = computedSource?.program;
    const databaseEdits: DatabaseCellEdit[] = [];
    const optimisticCells: Array<{
      position: TableCellPosition;
      value: DataTableCell;
    }> = [];
    if (text.startsWith("=")) {
      if (!computedSource || program === undefined) {
        throw new Error(
          "This Formula query table accepts direct values only. Add a computed Formula source to use expressions.",
        );
      }
      const expression = text.slice(1).trim();
      if (expression === "") throw new Error("Formula expressions cannot be empty.");
      program = setFormulaCellExpression(
        program,
        position.row,
        position.column,
        expression,
      );
    } else if (!isDirectCellEditable(position) && program !== undefined) {
      program = setFormulaCellExpression(
        program,
        position.row,
        position.column,
        formulaLiteralFromText(text),
      );
    } else {
      const value = parseDirectCellValue(position, text);
      databaseEdits.push(databaseEditForCell(position, value));
      optimisticCells.push({ position, value });
      if (program !== undefined) {
        program = setFormulaCellExpression(
          program,
          position.row,
          position.column,
          undefined,
        );
      }
    }
    setCellEditStatus("Applying cell edit…", "stale");
    const optimisticRenderMs = await renderOptimisticCells(
      optimisticCells,
      startedAt,
    );
    sendSpreadsheetEdit(program, databaseEdits, {
      startedAt,
      operation: "Cell edit",
      ...(optimisticRenderMs === undefined ? {} : { optimisticRenderMs }),
    });
    selectedCell = { ...position };
    formulaBarEditing = false;
    editingCell = undefined;
    insertedReference = undefined;
    cellFormulaBar.hidden = false;
    cellName.value = spreadsheetCellName(position.row, position.column);
    cellInput.value = text;
    setCellEditStatus(
      optimisticRenderMs === undefined
        ? "Recalculating cell…"
        : `Input shown in ${formatDuration(optimisticRenderMs)}; recalculating cell…`,
      "stale",
    );
    return true;
  } catch (error) {
    setCellEditStatus(errorMessage(error), "invalid");
    return false;
  }
}

function sendSpreadsheetEdit(
  program: string | undefined,
  databaseEdits: DatabaseCellEdit[],
  measurement: Omit<SpreadsheetEditMeasurement, "clientRevision">,
): void {
  const source = selectedFormulaSource();
  if (!source) return;
  const clientRevision = revision.nextEditRevision();
  if (clientRevision === undefined) return;
  invalidateReferenceTargetTables();
  if (program !== undefined) updateLocalFormulaProgram(source.name, program);
  clearTimeout(formulaEvaluationTimer);
  tableRequestId += 1;
  tableRenderMeasurement = undefined;
  pendingFormulaRevision = undefined;
  pendingSpreadsheetEdit = { clientRevision, ...measurement };
  if (measurement.operation === "Structure edit") {
    tableStructurePending = true;
  }
  formulaEvaluationComplete = false;
  formulaEvaluationIssue = undefined;
  formulaEditor.setDiagnostic(undefined);
  setStatus(formulaProgramStatus, "Checking…", "stale");
  host.postMessage({
    type: "editSpreadsheet",
    clientRevision,
    source: source.name,
    ...(program === undefined ? {} : { formulaProgram: program }),
    databaseEdits,
  });
  renderValidation(undefined, false);
  queuePreview();
  renderTableStructureActions();
}

function commitManagedSource(
  source: ManagedFormulaDataSource,
  measurement: Omit<SpreadsheetEditMeasurement, "clientRevision">,
): void {
  const nextSources = tableSourceDefinitions.map((candidate) =>
    candidate.name === source.name
      ? cloneManagedFormulaSource(source)
      : cloneDataSource(candidate),
  );
  commitManagedSources(nextSources, source.name, measurement);
}

function commitManagedSources(
  nextSources: DataSource[],
  expectedSourceName: string,
  measurement: Omit<SpreadsheetEditMeasurement, "clientRevision">,
): void {
  if (!nextSources.some((candidate) => candidate.name === expectedSourceName)) {
    setCellEditStatus("The managed Formula source changed before the edit was applied.", "invalid");
    return;
  }
  stageAuthoritativeSources(nextSources);
  clearTimeout(formulaEvaluationTimer);
  tableRequestId += 1;
  tableRenderMeasurement = undefined;
  pendingFormulaRevision = undefined;
  const clientRevision = sendDataSourceEdit(nextSources.map(cloneDataSource));
  if (clientRevision === undefined) {
    rollbackAuthoritativeSources();
    return;
  }
  pendingSpreadsheetEdit = { clientRevision, ...measurement };
  if (measurement.operation === "Structure edit") tableStructurePending = true;
  renderTableStructureActions();
  renderNormalizationPresence();
}

function stageAuthoritativeSources(sources: readonly DataSource[]): void {
  pendingTableSourcesRollback ??= tableSourceDefinitions.map(cloneDataSource);
  tableSourceDefinitions = sources.map(cloneDataSource);
  if (!dataSourceDraftDirty) {
    dataSourceDrafts = sources.map(cloneDataSource);
  }
}

function rollbackAuthoritativeSources(): void {
  if (!pendingTableSourcesRollback) return;
  tableSourceDefinitions = pendingTableSourcesRollback.map(cloneDataSource);
  if (!dataSourceDraftDirty) {
    dataSourceDrafts = pendingTableSourcesRollback.map(cloneDataSource);
  }
  pendingTableSourcesRollback = undefined;
  pendingTableSourceOptionsRefresh = false;
}

function applyManagedAutofill(
  detail: ChangedRange,
  source: ManagedFormulaDataSource,
): void {
  const startedAt = performance.now();
  try {
    for (const [destinationRowText, rowMapping] of Object.entries(detail.mapping)) {
      const destinationRow = Number(destinationRowText);
      for (const destinationProp of Object.keys(rowMapping)) {
        const destinationColumn = tableColumnIndex(destinationProp);
        if (
          destinationColumn !== undefined &&
          (managedReferenceGroupAt(source, destinationRow, destinationColumn) ||
            source.columns[destinationColumn]?.identity)
        ) {
          throw new Error(
            source.columns[destinationColumn]?.identity
              ? "Identity cells must be edited one at a time so linked REF formulas can be updated safely."
              : "Protected reference cells are changed with their linked-row picker. Release the reference group before filling them freely.",
          );
        }
      }
    }
    const updated = cloneManagedFormulaSource(source);
    for (const [destinationRowText, rowMapping] of Object.entries(detail.mapping)) {
      const destinationRow = Number(destinationRowText);
      for (const [destinationProp, origin] of Object.entries(rowMapping)) {
        const destinationColumn = tableColumnIndex(destinationProp);
        if (destinationColumn === undefined) continue;
        const original = source.rows[origin.rowIndex]?.cells[origin.colIndex];
        const destination = updated.rows[destinationRow]?.cells[destinationColumn];
        if (!original || !destination) continue;
        destination.constraint = original.constraint;
        destination.content =
          original.content.kind === "formula"
            ? {
                kind: "formula",
                expression: translateFormulaExpression(
                  original.content.expression,
                  destinationRow - origin.rowIndex,
                  destinationColumn - origin.colIndex,
                ),
              }
            : { kind: "literal", value: { ...original.content.value } };
      }
    }
    setCellEditStatus("Applying fill…", "stale");
    commitManagedSource(updated, { startedAt, operation: "Fill" });
  } catch (error) {
    setCellEditStatus(errorMessage(error), "invalid");
  }
}

function updateLocalFormulaProgram(sourceName: string, program: string): void {
  for (const sources of [tableSourceDefinitions, dataSourceDrafts]) {
    const source = sources.find(
      (candidate) => candidate.name === sourceName && candidate.type === "formula",
    );
    if (isComputedFormulaDataSource(source)) source.program = program;
  }
  formulaEditor.value = program;
}

function renderSelectedCell(): void {
  const source = selectedFormulaSource();
  const managedSource = selectedManagedFormulaSource();
  const computedSource = selectedComputedFormulaSource();
  const position = selectedCell;
  if (!source || !currentTable || !position) {
    cellFormulaBar.hidden = true;
    return;
  }
  cellFormulaBar.hidden = false;
  cellName.value = spreadsheetCellName(position.row, position.column);
  const expression = formulaExpressionForCell(
    computedSource?.program ?? "",
    position.row,
    position.column,
  );
  cellInput.value = managedSource
    ? managedCellText(managedSource, position.row, position.column)
    : expression
      ? `=${expression.replace(/^=/u, "")}`
      : cellTextForEditing(currentTable.rows[position.row]?.[position.column]);
  const referenceGroup = managedSource
    ? managedReferenceGroupAt(managedSource, position.row, position.column)
    : undefined;
  const disabled =
    !dataSourcesEditable ||
    dataSourceEditingLocked ||
    dataSourceDraftDirty ||
    (isQueryFormulaDataSource(source) && !isDirectCellEditable(position));
  cellInput.disabled = disabled;
  cellInputField.hidden = referenceGroup !== undefined;
  referenceTargetField.hidden = referenceGroup === undefined;
  if (managedSource && referenceGroup) {
    renderReferenceTargetPicker(managedSource, referenceGroup, position.row);
    referenceTarget.disabled =
      disabled || !referenceTargetTables.has(referenceGroup.source);
  } else {
    referenceTarget.replaceChildren();
  }
  cellConstraint.hidden = !managedSource;
  cellConstraint.disabled = disabled || !managedSource || referenceGroup !== undefined;
  columnConstraint.hidden = !managedSource;
  columnConstraint.disabled = disabled || !managedSource || referenceGroup !== undefined;
  columnName.hidden = !managedSource;
  columnName.disabled = disabled || !managedSource || referenceGroup !== undefined;
  if (managedSource) {
    cellConstraint.value =
      managedSource.rows[position.row]?.cells[position.column]?.constraint ??
      "inherit";
    columnConstraint.value =
      managedSource.columns[position.column]?.constraint ?? "any";
    columnName.value = managedSource.columns[position.column]?.name ?? "";
  }
  cancelCellEdit.disabled = disabled;
  cancelCellEdit.hidden = referenceGroup !== undefined;
  applyCellEdit.hidden = referenceGroup !== undefined;
  applyCellEdit.disabled = disabled;
  const direct = isDirectCellEditable(position);
  cellInput.title = referenceGroup
    ? `Protected reference to ${referenceGroup.source}. Choose a referenced row from the list.`
    : managedSource
    ? `Enter a literal or start with = for a Formula. Effective type: ${effectiveCellConstraint(managedSource, position.row, position.column)}.`
    : computedSource
    ? direct
      ? "Enter a value to update the query table, or start with = to apply a Formula."
      : "Enter a value or start with = to apply a Formula. This cell is not mapped to a writable query column."
    : direct
      ? "Enter a value to update the Formula query table."
      : "This Formula query cell is read-only because it has no write-back mapping.";
}

function renderReferenceTargetPicker(
  source: ManagedFormulaDataSource,
  group: NonNullable<ManagedFormulaDataSource["referenceGroups"]>[number],
  row: number,
): void {
  referenceTarget.replaceChildren();
  referenceTargetLabel.textContent = `🔒 ${group.source}`;
  const target = tableSourceDefinitions.find(
    (candidate): candidate is ManagedFormulaDataSource =>
      isManagedFormulaDataSource(candidate) && candidate.name === group.source,
  );
  if (!target) {
    referenceTarget.append(new Option("Referenced table is unavailable", ""));
    referenceTarget.disabled = true;
    return;
  }
  const evaluatedTarget = referenceTargetTables.get(group.source);
  if (!evaluatedTarget) {
    const issue = referenceTargetIssues.get(group.source);
    referenceTarget.append(
      new Option(issue ? `Referenced table unavailable: ${issue}` : "Loading referenced rows…", ""),
    );
    referenceTarget.disabled = true;
    if (!issue) requestReferenceTargetTable(group.source);
    return;
  }
  const currentIdentity = referenceGroupSelection(source, group, row);
  referenceTarget.append(new Option("Choose a referenced row…", ""));
  for (const [targetRow, evaluatedRow] of evaluatedTarget.rows.entries()) {
    const identityColumn = target.columns.findIndex((column) => column.identity);
    const identityCell = identityColumn >= 0
      ? evaluatedRow[identityColumn]
      : undefined;
    if (!identityCell || identityCell.type === "null") continue;
    const labels = group.columns
      .map((mapping) =>
        target.columns.findIndex(
          (column) => column.id === mapping.targetColumnId,
        ),
      )
      .filter((index) => index >= 0)
      .slice(0, 2)
      .map((index) => cellTextForEditing(evaluatedRow[index]))
      .filter((value) => value !== "");
    const identityLabel = cellTextForEditing(identityCell);
    const label = `${labels.join(" · ") || identityLabel} · ${identityLabel}`;
    const option = new Option(label, String(targetRow));
    option.selected = dataTableCellsEqual(identityCell, currentIdentity);
    referenceTarget.append(option);
  }
}

function requestReferenceTargetTable(source: string): void {
  if (
    !revision.initialized ||
    referenceTargetTables.has(source) ||
    referenceTargetRequests.has(source)
  ) {
    return;
  }
  referenceTargetRequestId += 1;
  referenceTargetRequests.set(source, referenceTargetRequestId);
  host.postMessage({
    type: "referenceTargetTable",
    clientRevision: revision.clientRevision,
    requestId: referenceTargetRequestId,
    source,
  });
}

function renderReferenceTargetTableResult(
  message: Extract<EditorHostMessage, { type: "referenceTargetTable" }>,
): void {
  if (referenceTargetRequests.get(message.source) !== message.requestId) return;
  referenceTargetRequests.delete(message.source);
  if (message.table) {
    referenceTargetTables.set(message.source, message.table);
    referenceTargetIssues.delete(message.source);
  } else {
    referenceTargetTables.delete(message.source);
    referenceTargetIssues.set(
      message.source,
      message.issue ?? "the table could not be evaluated",
    );
  }
  const managed = selectedManagedFormulaSource();
  const position = selectedCell;
  const group = managed && position
    ? managedReferenceGroupAt(managed, position.row, position.column)
    : undefined;
  if (group?.source === message.source) renderSelectedCell();
}

function invalidateReferenceTargetTables(): void {
  referenceTargetTables.clear();
  referenceTargetRequests.clear();
  referenceTargetIssues.clear();
}

function dataTableCellsEqual(
  left: DataTableCell | undefined,
  right: DataTableCell | undefined,
): boolean {
  return left !== undefined && right !== undefined &&
    JSON.stringify(left) === JSON.stringify(right);
}

function applySelectedReferenceTarget(): void {
  const source = selectedManagedFormulaSource();
  const position = selectedCell;
  if (referenceTarget.value === "") return;
  const targetRow = Number(referenceTarget.value);
  if (!source || !position || !Number.isSafeInteger(targetRow)) return;
  const group = managedReferenceGroupAt(source, position.row, position.column);
  const target = group
    ? tableSourceDefinitions.find(
        (candidate): candidate is ManagedFormulaDataSource =>
          isManagedFormulaDataSource(candidate) && candidate.name === group.source,
      )
    : undefined;
  if (!group || !target) return;
  try {
    const updated = cloneManagedFormulaSource(source);
    applyReferenceGroupSelection(
      updated,
      target,
      group.id,
      position.row,
      targetRow,
      referenceTargetTables.get(target.name),
    );
    setCellEditStatus(`Updating linked ${group.source} row…`, "stale");
    commitManagedSource(updated, {
      startedAt: performance.now(),
      operation: "Cell edit",
    });
  } catch (error) {
    setCellEditStatus(errorMessage(error), "invalid");
    renderSelectedCell();
  }
}

function resetCellEditor(): void {
  selectedCell = undefined;
  editingCell = undefined;
  formulaBarEditing = false;
  insertedReference = undefined;
  selectedTableRange = undefined;
  cellFormulaBar.hidden = true;
  renderTableStructureActions();
}

function renderTableStructureActions(): void {
  const visible =
    (selectedManagedFormulaSource() !== undefined ||
      selectedComputedFormulaSource() !== undefined) &&
    currentTable !== undefined;
  tableStructureActions.hidden = !visible;
  const disabled =
    !visible ||
    !dataSourcesEditable ||
    dataSourceEditingLocked ||
    dataSourceDraftDirty ||
    pendingDataSourceRevision !== undefined ||
    tableStructurePending ||
    pendingSpreadsheetEdit !== undefined;
  for (const button of [
    addTableRow,
    duplicateTableRow,
    insertTableRow,
    addTableColumn,
    duplicateTableColumn,
    insertTableColumn,
    extractTableRange,
  ]) {
    button.disabled = disabled;
  }
  duplicateTableRow.disabled ||= selectedCell === undefined;
  insertTableRow.disabled ||= selectedCell === undefined;
  duplicateTableColumn.disabled ||= selectedCell === undefined;
  insertTableColumn.disabled ||= selectedCell === undefined;
  extractTableRange.disabled ||=
    selectedManagedFormulaSource() === undefined || selectedTableRange === undefined;
}

function applySelectedCellConstraint(): void {
  const source = selectedManagedFormulaSource();
  if (
    !source ||
    !selectedCell ||
    dataSourceEditingLocked ||
    dataSourceDraftDirty ||
    pendingDataSourceRevision !== undefined ||
    pendingSpreadsheetEdit !== undefined
  ) return;
  const updated = cloneManagedFormulaSource(source);
  const cell = updated.rows[selectedCell.row]?.cells[selectedCell.column];
  if (!cell) return;
  const value = cellConstraint.value;
  if (value === "inherit") {
    delete cell.constraint;
  } else if (isManagedConstraint(value)) {
    cell.constraint = value;
  } else {
    return;
  }
  const issue = managedLiteralConstraintIssue(
    cell,
    cell.constraint ?? updated.columns[selectedCell.column]?.constraint ?? "any",
  );
  if (issue) {
    setCellEditStatus(`${spreadsheetCellName(selectedCell.row, selectedCell.column)} ${issue}.`, "invalid");
    renderSelectedCell();
    return;
  }
  setCellEditStatus("Applying cell type constraint…", "stale");
  commitManagedSource(updated, {
    startedAt: performance.now(),
    operation: "Cell edit",
  });
}

function applyColumnConstraint(
  column: number,
  constraint: ManagedCellConstraint,
): void {
  const source = selectedManagedFormulaSource();
  if (
    !source ||
    !source.columns[column] ||
    dataSourceEditingLocked ||
    dataSourceDraftDirty ||
    pendingDataSourceRevision !== undefined ||
    pendingSpreadsheetEdit !== undefined
  ) return;
  const updated = cloneManagedFormulaSource(source);
  updated.columns[column].constraint = constraint;
  for (const [rowIndex, row] of updated.rows.entries()) {
    const cell = row.cells[column];
    if (!cell || cell.constraint) continue;
    const issue = managedLiteralConstraintIssue(cell, constraint);
    if (issue) {
      setCellEditStatus(
        `${spreadsheetCellName(rowIndex, column)} ${issue}; add a cell override or fix the value first.`,
        "invalid",
      );
      renderSelectedCell();
      return;
    }
  }
  setCellEditStatus(`Applying ${constraintLabel(constraint)} column constraint…`, "stale");
  commitManagedSource(updated, {
    startedAt: performance.now(),
    operation: "Structure edit",
  });
}

function applySelectedColumnName(): void {
  const source = selectedManagedFormulaSource();
  if (
    !source ||
    !selectedCell ||
    dataSourceEditingLocked ||
    dataSourceDraftDirty ||
    pendingDataSourceRevision !== undefined ||
    pendingSpreadsheetEdit !== undefined
  ) {
    return;
  }
  try {
    const nextSources = tableSourceDefinitions.map(cloneDataSource);
    const updated = nextSources.find(
      (candidate): candidate is ManagedFormulaDataSource =>
        isManagedFormulaDataSource(candidate) && candidate.name === source.name,
    );
    if (!updated) throw new Error("The managed Formula source changed before the edit was applied.");
    const previousName = updated.columns[selectedCell.column]?.name;
    if (!previousName) throw new Error("The selected managed column no longer exists.");
    const nextName = columnName.value.trim();
    renameManagedColumn(updated, selectedCell.column, nextName);
    renameManagedReferencedColumn(
      nextSources.filter(isManagedFormulaDataSource),
      updated.name,
      previousName,
      nextName,
    );
    setCellEditStatus("Renaming column…", "stale");
    commitManagedSources(nextSources, updated.name, {
      startedAt: performance.now(),
      operation: "Structure edit",
    });
  } catch (error) {
    setCellEditStatus(errorMessage(error), "invalid");
    renderSelectedCell();
  }
}

function handleTableHeaderClick(event: CustomEvent<InitialHeaderClick>): void {
  const original = event.detail.originalEvent;
  if (original.button !== 2) return;
  const source = selectedManagedFormulaSource();
  if (!source || dataSourceEditingLocked || dataSourceDraftDirty) return;
  original.preventDefault();
  showColumnContextMenu(event.detail.index, original.clientX, original.clientY);
}

function showColumnContextMenu(column: number, x: number, y: number): void {
  const source = selectedManagedFormulaSource();
  if (!source?.columns[column]) return;
  showTableContextMenu(
    x,
    y,
    [
      { label: `Column: ${source.columns[column]?.name ?? column + 1}`, disabled: true },
      ...managedConstraints().map((constraint) => ({
        label: `${constraintIcon(constraint)}  Constrain as ${constraintLabel(constraint)}`,
        action: () => applyColumnConstraint(column, constraint),
      })),
    ],
  );
}

function handleTableContextMenu(event: MouseEvent): void {
  const path = event.composedPath();
  const inHeader = path.some(
    (item) => item instanceof Element && item.tagName === "REVOGR-HEADER",
  );
  if (inHeader) {
    const headerCell = path.find(
      (item) => item instanceof Element && item.hasAttribute("data-rgcol"),
    );
    const column =
      headerCell instanceof Element
        ? Number(headerCell.getAttribute("data-rgcol"))
        : Number.NaN;
    if (Number.isSafeInteger(column)) {
      event.preventDefault();
      showColumnContextMenu(column, event.clientX, event.clientY);
    }
    return;
  }
  const source = selectedManagedFormulaSource();
  if (
    !source ||
    !selectedCell ||
    dataSourceEditingLocked ||
    dataSourceDraftDirty
  ) return;
  event.preventDefault();
  const position = { ...selectedCell };
  const effective = effectiveCellConstraint(source, position.row, position.column);
  const referenceGroup = managedReferenceGroupAt(
    source,
    position.row,
    position.column,
  );
  showTableContextMenu(
    event.clientX,
    event.clientY,
    [
      {
        label: `${spreadsheetCellName(position.row, position.column)} · ${constraintLabel(effective)}`,
        disabled: true,
      },
      ...(referenceGroup
        ? [
            {
              label: `🔒 Linked to ${referenceGroup.source}`,
              disabled: true as const,
            },
            { separator: true as const },
            {
              label: "Release reference group",
              action: () => releaseSelectedReferenceGroup(referenceGroup.id),
            },
            { separator: true as const },
          ]
        : []),
      {
        label: "Inherit column type",
        action: () => setCellConstraintAt(position, undefined),
      },
      ...managedConstraints().map((constraint) => ({
        label: `${constraintIcon(constraint)}  Override as ${constraintLabel(constraint)}`,
        action: () => setCellConstraintAt(position, constraint),
      })),
      { separator: true },
      { label: "Copy selection to new table", action: extractSelectedManagedRange },
    ],
  );
}

function releaseSelectedReferenceGroup(groupId: string): void {
  const source = selectedManagedFormulaSource();
  if (!source) return;
  const updated = cloneManagedFormulaSource(source);
  if (!releaseManagedReferenceGroup(updated, groupId)) return;
  setCellEditStatus(
    "Releasing reference group; existing REF formulas remain unchanged…",
    "stale",
  );
  commitManagedSource(updated, {
    startedAt: performance.now(),
    operation: "Structure edit",
  });
}

function setCellConstraintAt(
  position: TableCellPosition,
  constraint: ManagedCellConstraint | undefined,
): void {
  const source = selectedManagedFormulaSource();
  if (!source) return;
  const updated = cloneManagedFormulaSource(source);
  const cell = updated.rows[position.row]?.cells[position.column];
  if (!cell) return;
  if (constraint) cell.constraint = constraint;
  else delete cell.constraint;
  const issue = managedLiteralConstraintIssue(
    cell,
    cell.constraint ?? updated.columns[position.column]?.constraint ?? "any",
  );
  if (issue) {
    setCellEditStatus(`${spreadsheetCellName(position.row, position.column)} ${issue}.`, "invalid");
    return;
  }
  selectedCell = position;
  setCellEditStatus("Applying cell type constraint…", "stale");
  commitManagedSource(updated, {
    startedAt: performance.now(),
    operation: "Cell edit",
  });
}

type ContextMenuItem =
  | { label: string; action?: () => void; disabled?: boolean; separator?: never }
  | { separator: true; label?: never; action?: never; disabled?: never };

function showTableContextMenu(
  x: number,
  y: number,
  items: readonly ContextMenuItem[],
): void {
  tableContextMenu.replaceChildren();
  for (const item of items) {
    if (item.separator) {
      tableContextMenu.append(document.createElement("hr"));
      continue;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.role = "menuitem";
    button.textContent = item.label;
    button.disabled = item.disabled ?? false;
    if (item.action) {
      button.addEventListener("click", () => {
        tableContextMenu.hidden = true;
        item.action?.();
      });
    }
    tableContextMenu.append(button);
  }
  tableContextMenu.hidden = false;
  tableContextMenu.style.left = `${Math.min(x, window.innerWidth - 240)}px`;
  tableContextMenu.style.top = `${Math.min(y, window.innerHeight - tableContextMenu.offsetHeight - 8)}px`;
  tableContextMenu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
}

function extractSelectedManagedRange(): void {
  const source = selectedManagedFormulaSource();
  const range = selectedTableRange;
  if (!source || !range) {
    setCellEditStatus("Select a managed Formula table range first.", "invalid");
    return;
  }
  if (
    dataSourceDraftDirty ||
    pendingSpreadsheetEdit !== undefined ||
    pendingDataSourceRevision !== undefined
  ) {
    setCellEditStatus("Wait for the current source edit to finish.", "stale");
    return;
  }
  try {
    const name = nextDataSourceName(`${source.name}-extract`);
    const extracted = extractManagedRange(source, range, name);
    const nextSources = [...tableSourceDefinitions.map(cloneDataSource), extracted];
    stageAuthoritativeSources(nextSources);
    const clientRevision = sendDataSourceEdit(nextSources.map(cloneDataSource));
    if (clientRevision === undefined) {
      rollbackAuthoritativeSources();
      return;
    }
    pendingDataSourceRevision = clientRevision;
    setCellEditStatus(
      `Copied ${rangeLabel(range)} to ${name}. Save the document to persist it.`,
      "valid",
    );
    renderDataSourceDrafts();
  } catch (error) {
    setCellEditStatus(errorMessage(error), "invalid");
  }
}

function renderNormalizationPresence(): void {
  const source = selectedManagedFormulaSource();
  normalizationCandidate = source
    ? findNormalizationCandidate(source)
    : undefined;
  normalizationStatus.hidden = normalizationCandidate === undefined;
  normalizeTableRange.disabled =
    dataSourceDraftDirty ||
    dataSourceEditingLocked ||
    pendingSpreadsheetEdit !== undefined ||
    pendingDataSourceRevision !== undefined;
  if (!source || !normalizationCandidate) {
    normalizationSummary.textContent = "";
    return;
  }
  normalizationSummary.textContent =
    `Normalization candidate: ${rangeLabel(normalizationCandidate)} contains ` +
    `${normalizationCandidate.duplicateRows} duplicate row${normalizationCandidate.duplicateRows === 1 ? "" : "s"}.`;
}

function openNormalizationDialog(): void {
  const source = selectedManagedFormulaSource();
  if (
    !source ||
    !normalizationCandidate ||
    dataSourceDraftDirty ||
    pendingSpreadsheetEdit !== undefined ||
    pendingDataSourceRevision !== undefined
  ) return;
  normalizationTableName.value = nextDataSourceName(`${source.name}-detail`);
  normalizationDialogSummary.textContent =
    `${rangeLabel(normalizationCandidate)} will become a ${normalizationCandidate.uniqueRows}-row table. ` +
    `${source.name} will keep the displayed columns linked to it.`;
  normalizationDialog.showModal();
  normalizationTableName.select();
}

function applyNormalization(): void {
  const source = selectedManagedFormulaSource();
  const candidate = normalizationCandidate;
  const name = normalizationTableName.value.trim();
  if (!source || !candidate) return;
  if (
    dataSourceDraftDirty ||
    pendingSpreadsheetEdit !== undefined ||
    pendingDataSourceRevision !== undefined
  ) {
    setCellEditStatus("Wait for the current source edit to finish.", "stale");
    return;
  }
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(name) || tableSourceDefinitions.some((item) => item.name === name)) {
    normalizationTableName.setCustomValidity("Enter a unique valid source name.");
    normalizationTableName.reportValidity();
    return;
  }
  normalizationTableName.setCustomValidity("");
  try {
    const normalized = normalizeManagedColumns(source, candidate, name);
    const nextSources = tableSourceDefinitions.map(cloneDataSource);
    const sourceIndex = nextSources.findIndex((item) => item.name === source.name);
    if (sourceIndex < 0) throw new Error("The source changed before normalization could be applied.");
    nextSources[sourceIndex] = normalized.source;
    nextSources.push(normalized.target);
    stageAuthoritativeSources(nextSources);
    const startedAt = performance.now();
    const clientRevision = sendDataSourceEdit(nextSources.map(cloneDataSource));
    if (clientRevision === undefined) {
      rollbackAuthoritativeSources();
      return;
    }
    pendingSpreadsheetEdit = { clientRevision, startedAt, operation: "Structure edit" };
    pendingTableSourceOptionsRefresh = true;
    tableStructurePending = true;
    normalizationDialog.close();
    setCellEditStatus("Applying normalization…", "stale");
    renderDataSourceDrafts();
    renderTableStructureActions();
  } catch (error) {
    setCellEditStatus(errorMessage(error), "invalid");
  }
}

function rangeLabel(range: ManagedTableRange): string {
  return `${spreadsheetCellName(range.top, range.left)}:${spreadsheetCellName(range.bottom, range.right)}`;
}

function managedConstraints(): readonly ManagedCellConstraint[] {
  return ["any", "text", "number", "boolean"];
}

function isManagedConstraint(value: string): value is ManagedCellConstraint {
  return managedConstraints().includes(value as ManagedCellConstraint);
}

function constraintLabel(constraint: ManagedCellConstraint): string {
  return constraint[0].toUpperCase() + constraint.slice(1);
}

function constraintIcon(constraint: ManagedCellConstraint): string {
  switch (constraint) {
    case "text":
      return "Abc";
    case "number":
      return "123";
    case "boolean":
      return "T/F";
    default:
      return "◇";
  }
}

function insertFormulaReference(range: RangeArea): void {
  const start = {
    row: Math.min(range.y, range.y1),
    column: Math.min(range.x, range.x1),
  };
  const end = {
    row: Math.max(range.y, range.y1),
    column: Math.max(range.x, range.x1),
  };
  const reference =
    start.row === end.row && start.column === end.column
      ? spreadsheetCellName(start.row, start.column)
      : `${spreadsheetCellName(start.row, start.column)}:${spreadsheetCellName(end.row, end.column)}`;
  const selectionStart =
    insertedReference?.start ??
    cellInput.selectionStart ??
    cellInput.value.length;
  const selectionEnd =
    insertedReference?.end ?? cellInput.selectionEnd ?? selectionStart;
  if (cellInput.value.slice(selectionStart, selectionEnd) === reference) return;
  cellInput.setRangeText(reference, selectionStart, selectionEnd, "end");
  insertedReference = {
    start: selectionStart,
    end: selectionStart + reference.length,
  };
}

function parseDirectCellValue(
  position: TableCellPosition,
  text: string,
): DataTableCell {
  if (!isDirectCellEditable(position)) {
    throw new Error(
      `Cell ${spreadsheetCellName(position.row, position.column)} is not mapped to a writable SQLite column; start with = to enter a Formula.`,
    );
  }
  if (text === "") return { type: "null" };
  const current = directInputCell(position);
  switch (current?.type) {
    case "boolean":
      if (!/^(true|false)$/iu.test(text.trim())) {
        throw new Error("Boolean cells accept true or false.");
      }
      return { type: "boolean", value: text.trim().toLowerCase() === "true" };
    case "integer": {
      const value = text.trim();
      if (!/^-?\d+$/u.test(value)) throw new Error("Integer cells require a whole number.");
      const integer = BigInt(value);
      if (integer < -(2n ** 63n) || integer > 2n ** 63n - 1n) {
        throw new Error("Integer cells must fit in a signed 64-bit value.");
      }
      return { type: "integer", value };
    }
    case "real": {
      const value = Number(text.trim());
      if (!Number.isFinite(value)) throw new Error("Real cells require a finite number.");
      return { type: "real", value };
    }
    case "null":
    case "string":
    default:
      return { type: "string", value: text };
  }
}

function databaseEditForCell(
  position: TableCellPosition,
  value: DataTableCell,
): DatabaseCellEdit {
  const editable = currentTable?.editable;
  const column = currentTable?.columns[position.column];
  const key = editable?.rowKeys[position.row];
  if (
    !editable ||
    !column ||
    !key ||
    !editable.editableColumns.includes(column)
  ) {
    throw new Error(
      `Cell ${spreadsheetCellName(position.row, position.column)} is not writable through the Formula query mapping.`,
    );
  }
  return {
    source: editable.inputSource,
    key: { ...key },
    column,
    value: { ...value },
  };
}

function directInputCell(position: TableCellPosition): DataTableCell | undefined {
  return currentTable?.editable?.inputRows[position.row]?.[position.column];
}

function isDirectCellEditable(position: TableCellPosition): boolean {
  const editable = currentTable?.editable;
  const column = currentTable?.columns[position.column];
  return (
    editable !== undefined &&
    editable.rowKeys[position.row] !== undefined &&
    column !== undefined &&
    editable.editableColumns.includes(column)
  );
}

function tablePositionFromFocus(
  detail: FocusAfterRenderEvent,
): TableCellPosition | undefined {
  const row = tableRowIndex(detail.model, detail.rowIndex);
  return Number.isSafeInteger(row) && Number.isSafeInteger(detail.colIndex)
    ? { row, column: detail.colIndex }
    : undefined;
}

function tablePositionFromEdit(
  detail: BeforeSaveDataDetails,
): TableCellPosition | undefined {
  const row = tableRowIndex(detail.model, detail.rowIndex);
  const column = tableColumnIndex(String(detail.prop));
  return column === undefined ? undefined : { row, column };
}

function tableRowIndex(model: DataType | undefined, fallback: number): number {
  const value = model?.__tmdRowIndex;
  return typeof value === "number" && Number.isSafeInteger(value) ? value : fallback;
}

function tableColumnIndex(prop: string): number | undefined {
  const match = /^column-(\d+)$/u.exec(prop);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}

function cellTextForEditing(cell: DataTableCell | undefined): string {
  if (!cell || cell.type === "null") return "";
  return cell.type === "integer" ? cell.value : String(cell.value);
}

function setCellEditStatus(
  message: string,
  state: "valid" | "invalid" | "stale",
): void {
  cellEditStatus.hidden = false;
  setStatus(cellEditStatus, message, state);
}

async function renderOptimisticCells(
  cells: ReadonlyArray<{
    position: TableCellPosition;
    value: DataTableCell;
  }>,
  startedAt: number,
): Promise<number | undefined> {
  const table = currentTable;
  const grid = tableGrid;
  if (cells.length === 0 || !table || !grid) return undefined;
  const updates: Array<{
    position: TableCellPosition;
    value: DataTableCell;
  }> = [];
  for (const { position, value } of cells) {
    const displayRow = table.rows[position.row];
    if (!displayRow || position.column >= displayRow.length) continue;
    displayRow[position.column] = { ...value };
    const inputRow = table.editable?.inputRows[position.row];
    if (inputRow && position.column < inputRow.length) {
      inputRow[position.column] = { ...value };
    }
    updates.push({ position, value });
  }
  await Promise.all(
    updates.map(({ position, value }) =>
      grid.setDataAt({
        row: position.row,
        col: position.column,
        rowType: "rgRow",
        colType: "rgCol",
        val: tableCellValue(value),
      }),
    ),
  );
  return performance.now() - startedAt;
}

function takeTableRenderMeasurement(
  requestId: number,
): TableRenderMeasurement | undefined {
  if (tableRenderMeasurement?.requestId !== requestId) return undefined;
  const measurement = tableRenderMeasurement;
  tableRenderMeasurement = undefined;
  return measurement;
}

function formatDuration(durationMs: number): string {
  return durationMs < 1 ? "<1 ms" : `${Math.round(durationMs)} ms`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function renderTableGrid(
  table: DataSourceTable,
  previousTable?: DataSourceTable,
): Promise<boolean> {
  if (!tableGrid) return false;
  const formulaSource = selectedFormulaSource();
  const spreadsheetEditable =
    dataSourcesEditable &&
    !dataSourceEditingLocked &&
    !dataSourceDraftDirty &&
    (isManagedFormulaDataSource(formulaSource) ||
      isComputedFormulaDataSource(formulaSource) ||
      (isQueryFormulaDataSource(formulaSource) && table.editable !== undefined));
  tableGrid.readonly = !spreadsheetEditable;
  const queryEditableColumns = new Set(
    isQueryFormulaDataSource(formulaSource)
      ? (table.editable?.editableColumns ?? [])
      : [],
  );
  if (
    spreadsheetEditable &&
    !isManagedFormulaDataSource(formulaSource) &&
    previousTable &&
    tablesHaveSameShape(previousTable, table)
  ) {
    await Promise.all(
      changedTableCells(previousTable, table).map(({ row, column }) =>
        tableGrid?.setDataAt({
          row,
          col: column,
          rowType: "rgRow",
          colType: "rgCol",
          val: tableCellValue(table.rows[row][column]),
        }),
      ),
    );
    return true;
  }
  const managedCandidate = isManagedFormulaDataSource(formulaSource)
    ? findNormalizationCandidate(formulaSource)
    : undefined;
  tableGrid.columns = table.columns.map(
    (name, index): ColumnRegular => ({
      name: isManagedFormulaDataSource(formulaSource)
        ? managedColumnLabel(formulaSource, index, name)
        : name,
      prop: tableColumnProp(index),
      readonly:
        !spreadsheetEditable ||
        (isQueryFormulaDataSource(formulaSource) &&
          !queryEditableColumns.has(name)),
      sortable: !spreadsheetEditable,
      size: Math.min(360, Math.max(120, name.length * 8 + 36)),
      ...(isManagedFormulaDataSource(formulaSource)
        ? {
            cellProperties: (properties) => {
              const row = tableRowIndex(properties.model, properties.rowIndex);
              const style =
                referenceGroupCellOutline(formulaSource, row, index) ??
                (managedCandidate
                  ? normalizationCellOutline(managedCandidate, row, index)
                  : undefined);
              return style ? { style: { boxShadow: style } } : undefined;
            },
            cellTemplate: (createElement, properties) => {
              const row = tableRowIndex(properties.model, properties.rowIndex);
              const marker = managedCellMarker(formulaSource, table, row, index);
              return createElement(
                "span",
                {
                  title: marker.title,
                  style: {
                    display: "flex",
                    alignItems: "center",
                    gap: ".35rem",
                    minWidth: "0",
                  },
                },
                [
                  createElement(
                    "span",
                    {
                      style: {
                        flex: "0 0 auto",
                        color: "var(--vscode-descriptionForeground)",
                        fontSize: ".72em",
                        fontWeight: "600",
                      },
                    },
                    marker.label,
                  ),
                  createElement(
                    "span",
                    { style: { overflow: "hidden", textOverflow: "ellipsis" } },
                    String(properties.value ?? ""),
                  ),
                ],
              );
            },
          }
        : {}),
    }),
  );
  tableGrid.source = table.rows.map(
    (row, rowIndex) =>
      ({
        ...Object.fromEntries(
          row.map((cell, index) => [tableColumnProp(index), tableCellValue(cell)]),
        ),
        __tmdRowIndex: rowIndex,
      }) as DataType,
  );
  return false;
}

function managedColumnLabel(
  source: ManagedFormulaDataSource,
  index: number,
  fallbackName: string,
): string {
  const column = source.columns[index];
  const protectedReference = source.referenceGroups?.some((group) =>
    group.columns.some((mapping) => mapping.columnId === column?.id),
  );
  const role = column?.identity
    ? "🔑  "
    : protectedReference
      ? "🔒↗  "
      : "";
  return `${role}${constraintIcon(column?.constraint ?? "any")}  ${column?.name ?? fallbackName}`;
}

function managedCellMarker(
  source: ManagedFormulaDataSource,
  table: DataSourceTable,
  row: number,
  column: number,
): { label: string; title: string } {
  const cell = source.rows[row]?.cells[column];
  const constraint = effectiveCellConstraint(source, row, column);
  const referenceGroup = managedReferenceGroupAt(source, row, column);
  if (referenceGroup) {
    return {
      label: "🔒",
      title: `Protected reference to ${referenceGroup.source} · choose a linked row to edit`,
    };
  }
  if (cell?.content.kind === "formula") {
    const result = table.rows[row]?.[column]?.type ?? "unknown";
    return { label: "fx", title: `Formula · ${constraintLabel(constraint)} constraint · ${result} result` };
  }
  const result = table.rows[row]?.[column]?.type;
  const label =
    result === "string"
      ? "Abc"
      : result === "integer" || result === "real"
        ? "123"
        : result === "boolean"
          ? "T/F"
          : "∅";
  return {
    label,
    title: `${constraintLabel(constraint)} constraint · ${result ?? "null"} value`,
  };
}

function referenceGroupCellOutline(
  source: ManagedFormulaDataSource,
  row: number,
  column: number,
): string | undefined {
  const group = managedReferenceGroupAt(source, row, column);
  if (!group) return undefined;
  const columnId = source.columns[column]?.id;
  const rowId = source.rows[row]?.id;
  if (!columnId || !rowId) return undefined;
  const columns = new Set(group.columns.map((mapping) => mapping.columnId));
  const rows = new Set(group.rowIds);
  const shadows: string[] = [];
  const color = "var(--vscode-descriptionForeground)";
  if (!columns.has(source.columns[column - 1]?.id ?? "")) {
    shadows.push(`inset 2px 0 ${color}`);
  }
  if (!columns.has(source.columns[column + 1]?.id ?? "")) {
    shadows.push(`inset -2px 0 ${color}`);
  }
  if (!rows.has(source.rows[row - 1]?.id ?? "")) {
    shadows.push(`inset 0 2px ${color}`);
  }
  if (!rows.has(source.rows[row + 1]?.id ?? "")) {
    shadows.push(`inset 0 -2px ${color}`);
  }
  return shadows.length > 0 ? shadows.join(",") : undefined;
}

function normalizationCellOutline(
  range: ManagedTableRange,
  row: number,
  column: number,
): string | undefined {
  if (
    row < range.top ||
    row > range.bottom ||
    column < range.left ||
    column > range.right
  ) {
    return undefined;
  }
  const shadows: string[] = [];
  if (column === range.left) shadows.push("inset 2px 0 var(--vscode-focusBorder)");
  if (column === range.right) shadows.push("inset -2px 0 var(--vscode-focusBorder)");
  if (row === range.top) shadows.push("inset 0 2px var(--vscode-focusBorder)");
  if (row === range.bottom) shadows.push("inset 0 -2px var(--vscode-focusBorder)");
  return shadows.length > 0 ? shadows.join(",") : undefined;
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
  const preserveDrafts = dataSourceDraftDirty;
  dataSourcesEditable = registry.editable;
  dataSourceEditingLocked = editingLocked;
  if (!preserveDrafts) {
    dataSourceDraftDirty = false;
    dataSourceDrafts = registry.sources.map(cloneDataSource);
  }
  dataSourceRegistryIssue.textContent = registry.issue ?? "";
  dataSourceRegistryRaw.hidden = typeof registry.rawRegistry !== "string";
  dataSourceRegistryRaw.textContent = registry.rawRegistry ?? "";
  addManagedFormulaDataSource.disabled =
    !dataSourcesEditable || dataSourceEditingLocked;
  addRhaiDataSource.disabled = !dataSourcesEditable || dataSourceEditingLocked;
  applyDataSources.disabled =
    !dataSourcesEditable || dataSourceEditingLocked || !dataSourceDraftDirty;
  setStatus(
    dataSourceStatus,
    dataSourcesEditable
      ? preserveDrafts
        ? "Unapplied source changes were retained while the document refreshed. Review and apply them when ready."
        : "Edit a source, then apply the changes to make the document dirty."
      : "This registry is read-only in the current editor.",
    dataSourcesEditable ? "stale" : "invalid",
  );
  renderTableStructureActions();
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
    type.textContent =
      source.type === "rhai"
        ? "type: rhai"
        : isManagedFormulaDataSource(source)
          ? "type: formula · managed table"
        : isQueryFormulaDataSource(source)
          ? "type: formula · query table"
          : "type: formula · computed";
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
        const previousName = source.name;
        source.name = value;
        if (previousName !== value) {
          rewriteDraftSourceReferences(previousName, value);
        }
        markDataSourceDraftChanged();
      }),
    );
    if (isManagedFormulaDataSource(source)) {
      const summary = document.createElement("p");
      summary.className = "section-description";
      summary.textContent =
        `${source.rows.length} rows · ${source.columns.length} columns` +
        (source.referenceGroups?.length
          ? ` · ${source.referenceGroups.length} protected reference group${source.referenceGroups.length === 1 ? "" : "s"}`
          : "") +
        " · edit cells and constraints in the Table tab";
      card.append(summary);
    } else if (isQueryFormulaDataSource(source)) {
      card.append(
        labelledTextarea("SQL query", source.query, "source-query", (value) => {
          source.query = value;
          markDataSourceDraftChanged();
        }),
      );
      const toggleEdit = document.createElement("button");
      toggleEdit.type = "button";
      toggleEdit.textContent = source.edit
        ? "Disable table write-back"
        : "Enable table write-back";
      toggleEdit.disabled = !dataSourcesEditable || dataSourceEditingLocked;
      toggleEdit.addEventListener("click", () => {
        if (source.edit) {
          delete source.edit;
        } else {
          source.edit = {
              table: "table_name",
              keySourceColumn: "id",
              keyTableColumn: "id",
              columns: [{ sourceColumn: "value", tableColumn: "value" }],
          };
        }
        renderDataSourceDrafts();
        markDataSourceDraftChanged();
      });
      card.append(toggleEdit);
      if (source.edit) {
        card.append(
          labelledInput("Write-back table", source.edit.table, (value) => {
            if (source.edit) source.edit.table = value;
            markDataSourceDraftChanged();
          }),
          labelledInput("Query key column", source.edit.keySourceColumn, (value) => {
            if (source.edit) source.edit.keySourceColumn = value;
            markDataSourceDraftChanged();
          }),
          labelledInput("Table key column", source.edit.keyTableColumn, (value) => {
            if (source.edit) source.edit.keyTableColumn = value;
            markDataSourceDraftChanged();
          }),
          labelledTextarea(
            "Writable columns (one query_column = table_column mapping per line)",
            sqliteEditMappingsText(source.edit.columns),
            "source-definition",
            (value) => {
              if (source.edit) source.edit.columns = parseSqliteEditMappings(value);
              markDataSourceDraftChanged();
            },
          ),
        );
      }
    } else if (source.type === "rhai") {
      card.append(
        labelledInput("Rhai script attachment path", source.script, (value) => {
          source.script = value;
          markDataSourceDraftChanged();
        }),
        labelledTextarea(
          "Formula table inputs (one alias = source mapping per line)",
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
        labelledInput("Formula query input source", source.input, (value) => {
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
  if (isManagedFormulaDataSource(source)) {
    return cloneManagedFormulaSource(source);
  }
  if (isComputedFormulaDataSource(source)) {
    return { ...source, outputColumns: [...source.outputColumns] };
  }
  const { edit, ...querySource } = source;
  return edit
    ? {
        ...querySource,
        edit: {
          ...edit,
          columns: edit.columns.map((column) => ({ ...column })),
        },
      }
    : querySource;
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

function parseSqliteEditMappings(
  value: string,
): NonNullable<Extract<FormulaDataSource, { query: string }>["edit"]>["columns"] {
  return value
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const separator = line.indexOf("=");
      return separator < 0
        ? { sourceColumn: line.trim(), tableColumn: "" }
        : {
            sourceColumn: line.slice(0, separator).trim(),
            tableColumn: line.slice(separator + 1).trim(),
          };
    });
}

function sqliteEditMappingsText(
  columns: NonNullable<
    Extract<FormulaDataSource, { query: string }>["edit"]
  >["columns"],
): string {
  return columns
    .map((column) => `${column.sourceColumn} = ${column.tableColumn}`)
    .join("\n");
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

function rewriteDraftSourceReferences(previousName: string, nextName: string): void {
  renameManagedReferencedSource(
    dataSourceDrafts.filter(isManagedFormulaDataSource),
    previousName,
    nextName,
  );
  for (const source of dataSourceDrafts) {
    if (source.type === "rhai") {
      for (const input of source.inputs) {
        if (input.source === previousName) input.source = nextName;
      }
    } else if (isComputedFormulaDataSource(source) && source.input === previousName) {
      source.input = nextName;
    }
  }
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
    if (isManagedFormulaDataSource(source)) {
      if (source.columns.length === 0 || source.columns.length > MAX_TABLE_COLUMNS) {
        return `Managed Formula tables require 1-${MAX_TABLE_COLUMNS} columns.`;
      }
      if (
        source.rows.length > MAX_TABLE_ROWS ||
        source.rows.length * source.columns.length > MAX_TABLE_CELLS
      ) {
        return `Managed Formula tables support at most ${MAX_TABLE_ROWS} rows and ${MAX_TABLE_CELLS} cells.`;
      }
      if (new Set(source.columns.map((column) => column.id)).size !== source.columns.length ||
          new Set(source.columns.map((column) => column.name)).size !== source.columns.length) {
        return "Managed Formula column ids and names must be unique.";
      }
      const visibleColumns = managedVisibleColumnCount(source);
      if (
        visibleColumns === 0 ||
        source.columns.slice(visibleColumns).some((column) => column.hidden !== true)
      ) {
        return "Managed Formula internal columns, when present, must form a trailing suffix after at least one visible column.";
      }
      if (new Set(source.rows.map((row) => row.id)).size !== source.rows.length ||
          source.rows.some((row) => row.cells.length !== source.columns.length)) {
        return "Managed Formula row ids must be unique and each row must match the column count.";
      }
      continue;
    }
    if (isQueryFormulaDataSource(source)) {
      if (source.query.trim() === "") return "Formula table queries cannot be empty.";
      if (new TextEncoder().encode(source.query).length > 65_536) {
        return "Formula table queries must be at most 65536 UTF-8 bytes.";
      }
      if (source.edit) {
        const identifier = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
        if (
          !identifier.test(source.edit.table) ||
          !identifier.test(source.edit.keyTableColumn)
        ) {
          return "SQLite write-back table identifiers must use ASCII letters, digits or underscores and start with a letter or underscore.";
        }
        if (
          source.edit.keySourceColumn.length === 0 ||
          source.edit.columns.length === 0
        ) {
          return "SQLite write-back requires a query key and at least one writable column.";
        }
        const writable = new Set<string>();
        for (const column of source.edit.columns) {
          if (
            column.sourceColumn.length === 0 ||
            !identifier.test(column.tableColumn) ||
            column.sourceColumn === source.edit.keySourceColumn ||
            writable.has(column.sourceColumn)
          ) {
            return "SQLite write-back mappings must be unique, non-empty, and cannot make the stable key writable.";
          }
          writable.add(column.sourceColumn);
        }
      }
      continue;
    }
    if (source.type === "rhai") {
      const pathIssue = validateScriptPath(source.script);
      if (pathIssue) return pathIssue;
      if (source.inputs.length === 0 || source.inputs.length > 16) {
        return "Rhai sources require 1-16 Formula query input mappings.";
      }
      const aliases = new Set<string>();
      for (const input of source.inputs) {
        if (!/^[A-Za-z0-9._-]{1,128}$/.test(input.alias)) {
          return "Rhai input aliases use the same characters as source names.";
        }
        if (aliases.has(input.alias)) return "Rhai input aliases must be unique.";
        aliases.add(input.alias);
        if (!/^[A-Za-z0-9._-]{1,128}$/.test(input.source)) {
          return "Each Rhai input must name a Formula query source.";
        }
        const target = definitions.get(input.source);
        if (!target) return "Each Rhai input must reference an existing source.";
        if (!target || target.type !== "formula" || isComputedFormulaDataSource(target)) {
          return "Rhai inputs can reference managed or query Formula tables only.";
        }
      }
    } else {
      if (new TextEncoder().encode(source.program).length > MAX_FORMULA_PROGRAM_BYTES) {
        return `Formula programs must be at most ${MAX_FORMULA_PROGRAM_BYTES} UTF-8 bytes.`;
      }
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(source.input)) {
        return "Computed Formula inputs must name a Formula query source.";
      }
      const target = definitions.get(source.input);
      if (!target) return "Each Formula input must reference an existing source.";
      if (!isQueryFormulaDataSource(target)) {
        return "Computed Formula inputs can reference Formula query sources only.";
      }
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
  dataSourceDraftDirty = true;
  applyDataSources.disabled =
    !dataSourcesEditable || dataSourceEditingLocked || pendingDataSourceRevision !== undefined;
  if (tableGrid) tableGrid.readonly = true;
  renderSelectedCell();
  renderTableStructureActions();
  renderNormalizationPresence();
  configurePreviewTables();
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
  element.classList.remove("valid", "invalid", "stale");
  element.classList.add(state);
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
      value.type === "editRejected" ||
      value.type === "preview" ||
      value.type === "dataSourceTable" ||
      value.type === "referenceTargetTable" ||
      value.type === "rhaiScript")
  );
}
