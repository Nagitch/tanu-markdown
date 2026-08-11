import type {
  DataSource,
  DataTableCell,
  ManagedCellConstraint,
  ManagedFormulaCell,
  ManagedFormulaColumn,
  ManagedFormulaRow,
  SqliteEditDefinition,
} from "./types.js";

/** Parse the structured-cloned data-source payload received from the webview. */
export function parseEditorDataSources(value: unknown): DataSource[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const sources: DataSource[] = [];
  for (const source of value) {
    if (
      typeof source !== "object" ||
      source === null ||
      !("name" in source) ||
      typeof source.name !== "string" ||
      !("type" in source)
    ) {
      return undefined;
    }
    if (
      source.type === "formula" &&
      hasOnlyKeys(source, ["name", "type", "columns", "rows"]) &&
      "columns" in source &&
      Array.isArray(source.columns) &&
      "rows" in source &&
      Array.isArray(source.rows)
    ) {
      const columns: ManagedFormulaColumn[] = [];
      for (const column of source.columns) {
        const parsed = parseManagedFormulaColumn(column);
        if (!parsed) return undefined;
        columns.push(parsed);
      }
      const rows: ManagedFormulaRow[] = [];
      for (const row of source.rows) {
        const parsed = parseManagedFormulaRow(row);
        if (!parsed) return undefined;
        rows.push(parsed);
      }
      sources.push({ name: source.name, type: "formula", columns, rows });
      continue;
    }
    if (
      source.type === "formula" &&
      hasOnlyKeys(source, ["name", "type", "query", "edit"]) &&
      "query" in source &&
      typeof source.query === "string"
    ) {
      const edit = "edit" in source ? parseSqliteEditDefinition(source.edit) : undefined;
      if ("edit" in source && !edit) return undefined;
      sources.push({
        name: source.name,
        type: "formula",
        query: source.query,
        ...(edit ? { edit } : {}),
      });
      continue;
    }
    if (
      source.type === "formula" &&
      hasOnlyKeys(source, ["name", "type", "input", "program", "outputColumns"]) &&
      "input" in source &&
      typeof source.input === "string" &&
      "program" in source &&
      typeof source.program === "string" &&
      "outputColumns" in source &&
      Array.isArray(source.outputColumns) &&
      source.outputColumns.every((column: unknown) => typeof column === "string")
    ) {
      sources.push({
        name: source.name,
        type: "formula",
        input: source.input,
        program: source.program,
        outputColumns: [...source.outputColumns],
      });
      continue;
    }
    if (
      source.type !== "rhai" ||
      !hasOnlyKeys(source, ["name", "type", "script", "inputs", "outputColumns"]) ||
      !("script" in source) ||
      typeof source.script !== "string" ||
      !("inputs" in source) ||
      !Array.isArray(source.inputs) ||
      !("outputColumns" in source) ||
      !Array.isArray(source.outputColumns) ||
      !source.outputColumns.every((column: unknown) => typeof column === "string")
    ) {
      return undefined;
    }
    const inputs: Array<{ alias: string; source: string }> = [];
    for (const input of source.inputs) {
      if (
        typeof input !== "object" ||
        input === null ||
        !hasOnlyKeys(input, ["alias", "source"]) ||
        !("alias" in input) ||
        typeof input.alias !== "string" ||
        !("source" in input) ||
        typeof input.source !== "string"
      ) {
        return undefined;
      }
      inputs.push({ alias: input.alias, source: input.source });
    }
    inputs.sort((left, right) => left.alias.localeCompare(right.alias));
    sources.push({
      name: source.name,
      type: "rhai",
      script: source.script,
      inputs,
      outputColumns: [...source.outputColumns],
    });
  }
  return sources;
}

function parseManagedFormulaColumn(value: unknown): ManagedFormulaColumn | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !hasOnlyKeys(value, ["id", "name", "constraint", "hidden", "reference"]) ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !("constraint" in value) ||
    !isManagedConstraint(value.constraint)
  ) {
    return undefined;
  }
  const hidden = "hidden" in value ? value.hidden : undefined;
  if (hidden !== undefined && typeof hidden !== "boolean") return undefined;
  let reference: ManagedFormulaColumn["reference"];
  if ("reference" in value) {
    const candidate = value.reference;
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      !hasOnlyKeys(candidate, ["source", "columnId"]) ||
      !("source" in candidate) ||
      typeof candidate.source !== "string" ||
      !("columnId" in candidate) ||
      typeof candidate.columnId !== "string"
    ) {
      return undefined;
    }
    reference = { source: candidate.source, columnId: candidate.columnId };
  }
  return {
    id: value.id,
    name: value.name,
    constraint: value.constraint,
    ...(hidden === true ? { hidden: true } : {}),
    ...(reference ? { reference } : {}),
  };
}

function parseManagedFormulaRow(value: unknown): ManagedFormulaRow | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !hasOnlyKeys(value, ["id", "cells"]) ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !("cells" in value) ||
    !Array.isArray(value.cells)
  ) {
    return undefined;
  }
  const cells: ManagedFormulaCell[] = [];
  for (const cell of value.cells) {
    const parsed = parseManagedFormulaCell(cell);
    if (!parsed) return undefined;
    cells.push(parsed);
  }
  return { id: value.id, cells };
}

function parseManagedFormulaCell(value: unknown): ManagedFormulaCell | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !hasOnlyKeys(value, ["content", "constraint"]) ||
    !("content" in value) ||
    typeof value.content !== "object" ||
    value.content === null ||
    ("constraint" in value && !isManagedConstraint(value.constraint))
  ) {
    return undefined;
  }
  let constraint: ManagedCellConstraint | undefined;
  if ("constraint" in value && isManagedConstraint(value.constraint)) {
    constraint = value.constraint;
  }
  const content = value.content;
  if (
    hasOnlyKeys(content, ["kind", "expression"]) &&
    "kind" in content &&
    content.kind === "formula" &&
    "expression" in content &&
    typeof content.expression === "string"
  ) {
    return {
      content: { kind: "formula", expression: content.expression },
      ...(constraint ? { constraint } : {}),
    };
  }
  if (
    hasOnlyKeys(content, ["kind", "value"]) &&
    "kind" in content &&
    content.kind === "literal" &&
    "value" in content &&
    isDataTableCell(content.value)
  ) {
    return {
      content: { kind: "literal", value: { ...content.value } },
      ...(constraint ? { constraint } : {}),
    };
  }
  return undefined;
}

function parseSqliteEditDefinition(value: unknown): SqliteEditDefinition | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !hasOnlyKeys(value, ["table", "keySourceColumn", "keyTableColumn", "columns"]) ||
    !("table" in value) ||
    typeof value.table !== "string" ||
    !("keySourceColumn" in value) ||
    typeof value.keySourceColumn !== "string" ||
    !("keyTableColumn" in value) ||
    typeof value.keyTableColumn !== "string" ||
    !("columns" in value) ||
    !Array.isArray(value.columns)
  ) {
    return undefined;
  }
  const columns: SqliteEditDefinition["columns"] = [];
  for (const column of value.columns) {
    if (
      typeof column !== "object" ||
      column === null ||
      !hasOnlyKeys(column, ["sourceColumn", "tableColumn"]) ||
      !("sourceColumn" in column) ||
      typeof column.sourceColumn !== "string" ||
      !("tableColumn" in column) ||
      typeof column.tableColumn !== "string"
    ) {
      return undefined;
    }
    columns.push({
      sourceColumn: column.sourceColumn,
      tableColumn: column.tableColumn,
    });
  }
  return {
    table: value.table,
    keySourceColumn: value.keySourceColumn,
    keyTableColumn: value.keyTableColumn,
    columns,
  };
}

function isManagedConstraint(
  value: unknown,
): value is "any" | "text" | "number" | "boolean" {
  return value === "any" || value === "text" || value === "number" || value === "boolean";
}

function isDataTableCell(value: unknown): value is DataTableCell {
  if (typeof value !== "object" || value === null || !("type" in value)) return false;
  if (value.type === "null") return hasOnlyKeys(value, ["type"]);
  if (!hasOnlyKeys(value, ["type", "value"]) || !("value" in value)) return false;
  return (
    (value.type === "boolean" && typeof value.value === "boolean") ||
    (value.type === "integer" &&
      typeof value.value === "string" &&
      /^-?\d+$/u.test(value.value)) ||
    (value.type === "real" &&
      typeof value.value === "number" &&
      Number.isFinite(value.value)) ||
    (value.type === "string" && typeof value.value === "string")
  );
}

function hasOnlyKeys(value: object, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}
