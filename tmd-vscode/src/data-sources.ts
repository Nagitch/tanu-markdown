import type {
  ComputedFormulaDataSource,
  DataSource,
  DataSourceRegistryView,
  DataTableCell,
  JsonValue,
  ManagedCellConstraint,
  ManagedFormulaCell,
  ManagedFormulaDataSource,
  ManagedFormulaReferenceGroup,
  QueryFormulaDataSource,
  RhaiDataSource,
  RhaiDataSourceInput,
  SqliteEditDefinition,
} from "./types.js";

const REGISTRY_KEY = "tmd_data_sources";
const LEGACY_REGISTRY_SCHEMA_VERSION = 1;
const RHAI_REGISTRY_SCHEMA_VERSION = 2;
const FORMULA_REGISTRY_SCHEMA_VERSION = 3;
const EDITABLE_REGISTRY_SCHEMA_VERSION = 4;
const QUERY_REGISTRY_SCHEMA_VERSION = 5;
const MANAGED_FORMULA_REGISTRY_SCHEMA_VERSION = 6;
const LEGACY_REFERENCE_REGISTRY_SCHEMA_VERSION = 7;
const CURRENT_REGISTRY_SCHEMA_VERSION = 8;
const MAX_SOURCE_NAME_BYTES = 128;
const MAX_QUERY_BYTES = 64 * 1024;
const MAX_FORMULA_PROGRAM_BYTES = 256 * 1024;
const MAX_MANAGED_TEXT_BYTES = 1024 * 1024;
const MAX_RHAI_INPUTS = 16;
const MAX_TABLE_COLUMNS = 128;
const MAX_TABLE_ROWS = 1_000;
const MAX_TABLE_CELLS = 10_000;
const MAX_COLUMN_NAME_BYTES = 256;
const MAX_SQLITE_IDENTIFIER_BYTES = 128;
const SOURCE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const SQLITE_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_ATTACHMENT_PATHS = new Set([
  "manifest.json",
  "index.md",
  "attachments.json",
  "db/main.sqlite3",
]);

export function inspectDataSourceRegistry(extras: JsonValue): DataSourceRegistryView {
  if (extras === null) {
    return {
      editable: true,
      schemaVersion: CURRENT_REGISTRY_SCHEMA_VERSION,
      sources: [],
    };
  }
  if (!isObject(extras)) {
    return {
      editable: false,
      sources: [],
      issue: "manifest.extras is not an object, so data sources cannot be edited safely.",
    };
  }
  const registry = extras[REGISTRY_KEY];
  if (registry === undefined) {
    return {
      editable: true,
      schemaVersion: CURRENT_REGISTRY_SCHEMA_VERSION,
      sources: [],
    };
  }
  const rawRegistry = JSON.stringify(registry, null, 2);
  if (!isObject(registry)) {
    return invalidRegistry("The data-source registry is not an object.", rawRegistry);
  }
  if (hasUnknownKeys(registry, new Set(["schema_version", "sources"]))) {
    return invalidRegistry(
      "The data-source registry contains unsupported fields.",
      rawRegistry,
    );
  }
  const schemaVersion = registry.schema_version;
  if (
    schemaVersion !== LEGACY_REGISTRY_SCHEMA_VERSION &&
    schemaVersion !== RHAI_REGISTRY_SCHEMA_VERSION &&
    schemaVersion !== FORMULA_REGISTRY_SCHEMA_VERSION &&
    schemaVersion !== EDITABLE_REGISTRY_SCHEMA_VERSION &&
    schemaVersion !== QUERY_REGISTRY_SCHEMA_VERSION &&
    schemaVersion !== MANAGED_FORMULA_REGISTRY_SCHEMA_VERSION &&
    schemaVersion !== LEGACY_REFERENCE_REGISTRY_SCHEMA_VERSION &&
    schemaVersion !== CURRENT_REGISTRY_SCHEMA_VERSION
  ) {
    return invalidRegistry(
      `Data-source schema_version ${String(schemaVersion)} is not editable; expected 1 through 8.`,
      rawRegistry,
    );
  }
  if (!isObject(registry.sources)) {
    return invalidRegistry("The data-source registry has no valid sources object.", rawRegistry);
  }

  const sources: DataSource[] = [];
  for (const [name, definition] of Object.entries(registry.sources)) {
    if (!isObject(definition)) {
      return invalidRegistry(`Data source \`${name}\` is not an object.`, rawRegistry);
    }
    if (definition.type === "sqlite") {
      if (
        schemaVersion === QUERY_REGISTRY_SCHEMA_VERSION ||
        schemaVersion === MANAGED_FORMULA_REGISTRY_SCHEMA_VERSION ||
        schemaVersion === LEGACY_REFERENCE_REGISTRY_SCHEMA_VERSION ||
        schemaVersion === CURRENT_REGISTRY_SCHEMA_VERSION
      ) {
        return invalidRegistry(
          `Data source \`${name}\` uses the removed SQLite type; use a Formula query source.`,
          rawRegistry,
        );
      }
      const source = parseQueryFormulaDataSource(name, definition, "sqlite");
      if (!source) {
        return invalidRegistry(
          `Data source \`${name}\` is not an editable legacy SQLite source.`,
          rawRegistry,
        );
      }
      if (source.edit && schemaVersion !== EDITABLE_REGISTRY_SCHEMA_VERSION) {
        return invalidRegistry(
          `Editable SQLite data source \`${name}\` requires schema_version 4.`,
          rawRegistry,
        );
      }
      sources.push(source);
      continue;
    }
    if (definition.type === "rhai") {
      if (
        schemaVersion !== RHAI_REGISTRY_SCHEMA_VERSION &&
        schemaVersion !== FORMULA_REGISTRY_SCHEMA_VERSION &&
        schemaVersion !== EDITABLE_REGISTRY_SCHEMA_VERSION &&
        schemaVersion !== QUERY_REGISTRY_SCHEMA_VERSION &&
        schemaVersion !== MANAGED_FORMULA_REGISTRY_SCHEMA_VERSION &&
        schemaVersion !== LEGACY_REFERENCE_REGISTRY_SCHEMA_VERSION &&
        schemaVersion !== CURRENT_REGISTRY_SCHEMA_VERSION
      ) {
        return invalidRegistry(
          `Rhai data source \`${name}\` requires schema_version 2 through 8.`,
          rawRegistry,
        );
      }
      const source = parseRhaiDataSource(name, definition);
      if (!source) {
        return invalidRegistry(
          `Data source \`${name}\` is not an editable Rhai table source.`,
          rawRegistry,
        );
      }
      sources.push(source);
      continue;
    }
    if (definition.type === "formula") {
      if ("columns" in definition || "rows" in definition) {
        if (
          schemaVersion !== MANAGED_FORMULA_REGISTRY_SCHEMA_VERSION &&
          schemaVersion !== LEGACY_REFERENCE_REGISTRY_SCHEMA_VERSION &&
          schemaVersion !== CURRENT_REGISTRY_SCHEMA_VERSION
        ) {
          return invalidRegistry(
            `Managed Formula source \`${name}\` requires schema_version 6 through 8.`,
            rawRegistry,
          );
        }
        const source = parseManagedFormulaDataSource(
          name,
          definition,
          schemaVersion === LEGACY_REFERENCE_REGISTRY_SCHEMA_VERSION,
          schemaVersion === MANAGED_FORMULA_REGISTRY_SCHEMA_VERSION ||
            schemaVersion === LEGACY_REFERENCE_REGISTRY_SCHEMA_VERSION,
          schemaVersion === CURRENT_REGISTRY_SCHEMA_VERSION,
        );
        if (!source) {
          return invalidRegistry(
            `Data source \`${name}\` is not an editable managed Formula table.`,
            rawRegistry,
          );
        }
        sources.push(source);
        continue;
      }
      if ("query" in definition) {
        if (
          schemaVersion !== QUERY_REGISTRY_SCHEMA_VERSION &&
          schemaVersion !== MANAGED_FORMULA_REGISTRY_SCHEMA_VERSION &&
          schemaVersion !== LEGACY_REFERENCE_REGISTRY_SCHEMA_VERSION &&
          schemaVersion !== CURRENT_REGISTRY_SCHEMA_VERSION
        ) {
          return invalidRegistry(
            `Formula query source \`${name}\` requires schema_version 5 through 8.`,
            rawRegistry,
          );
        }
        const source = parseQueryFormulaDataSource(name, definition, "formula");
        if (!source) {
          return invalidRegistry(
            `Data source \`${name}\` is not an editable Formula query source.`,
            rawRegistry,
          );
        }
        sources.push(source);
        continue;
      }
      if (
        schemaVersion !== FORMULA_REGISTRY_SCHEMA_VERSION &&
        schemaVersion !== EDITABLE_REGISTRY_SCHEMA_VERSION &&
        schemaVersion !== QUERY_REGISTRY_SCHEMA_VERSION &&
        schemaVersion !== MANAGED_FORMULA_REGISTRY_SCHEMA_VERSION &&
        schemaVersion !== LEGACY_REFERENCE_REGISTRY_SCHEMA_VERSION &&
        schemaVersion !== CURRENT_REGISTRY_SCHEMA_VERSION
      ) {
        return invalidRegistry(
          `Computed Formula data source \`${name}\` requires schema_version 3 through 8.`,
          rawRegistry,
        );
      }
      const source = parseFormulaDataSource(name, definition);
      if (!source) {
        return invalidRegistry(
          `Data source \`${name}\` is not an editable Formula table source.`,
          rawRegistry,
        );
      }
      sources.push(source);
      continue;
    }
    return invalidRegistry(
      `Data source \`${name}\` has unsupported type \`${String(definition.type)}\`.`,
      rawRegistry,
    );
  }
  sources.sort((left, right) => left.name.localeCompare(right.name));
  if (
    schemaVersion === MANAGED_FORMULA_REGISTRY_SCHEMA_VERSION ||
    schemaVersion === LEGACY_REFERENCE_REGISTRY_SCHEMA_VERSION
  ) {
    try {
      migrateLegacyManagedReferences(sources);
    } catch (error) {
      return invalidRegistry(
        error instanceof Error ? error.message : String(error),
        rawRegistry,
      );
    }
  }
  try {
    validateDataSources(sources);
  } catch (error) {
    return invalidRegistry(error instanceof Error ? error.message : String(error), rawRegistry);
  }
  return { editable: true, schemaVersion, sources };
}

function migrateLegacyManagedReferences(sources: DataSource[]): void {
  const managed = sources.filter(isManagedFormulaDataSource);
  const definitions = new Map(managed.map((source) => [source.name, source]));
  const migratedIdentities = new Map<string, ReadonlyMap<string, string>>();
  for (const source of managed) {
    for (const column of source.columns) {
      if (!column.reference) continue;
      const target = definitions.get(column.reference.source);
      const identity = target?.columns.find(
        (candidate) => candidate.id === column.reference?.columnId,
      );
      if (!target || !identity) {
        throw new Error(`Legacy reference in \`${source.name}\` has no valid target identity column.`);
      }
      identity.identity = true;
      delete identity.hidden;
      const migrationKey = `${target.name}\u0000${identity.id}`;
      if (!migratedIdentities.has(migrationKey)) {
        migratedIdentities.set(
          migrationKey,
          migrateLegacyIdentityColumn(target, identity.id),
        );
      }
    }
  }

  for (const source of managed) {
    const legacy = source.columns
      .map((column, index) => ({ column, index }))
      .filter(({ column }) => column.reference !== undefined)
      .reverse();
    for (const { column: keyColumn, index: keyIndex } of legacy) {
      const reference = keyColumn.reference;
      const target = reference ? definitions.get(reference.source) : undefined;
      if (!reference || !target) continue;
      const identities = migratedIdentities.get(
        `${target.name}\u0000${reference.columnId}`,
      );
      if (!identities) {
        throw new Error(
          `Legacy reference column \`${keyColumn.name}\` in \`${source.name}\` has no migrated target identities.`,
        );
      }
      const rowIdentities = new Map<string, string | null>();
      for (const row of source.rows) {
        const cell = row.cells[keyIndex];
        if (cell?.content.kind !== "literal") {
          throw new Error(
            `Legacy reference column \`${keyColumn.name}\` in \`${source.name}\` requires literal identities for automatic migration.`,
          );
        }
        const identity = cell.content.value.type === "null"
          ? null
          : identities.get(legacyIdentityKey(cell.content.value));
        if (identity === undefined) {
          throw new Error(
            `Legacy reference column \`${keyColumn.name}\` in \`${source.name}\` contains an identity that is missing from \`${target.name}\`.`,
          );
        }
        rowIdentities.set(row.id, identity);
        for (const candidate of row.cells) {
          if (candidate.content.kind !== "formula") continue;
          const directTarget = identity === null
            ? parseLegacyDirectRefTarget(
                candidate.content.expression,
                keyColumn.name,
              )
            : undefined;
          candidate.content.expression = rewriteLegacyRefExpression(
            candidate.content.expression,
            keyColumn.name,
            reference.source,
            identity === null ? "NULL" : JSON.stringify(identity),
          );
          if (directTarget !== undefined) {
            candidate.content = {
              kind: "literal",
              value: { type: "null" },
            };
          }
        }
      }
      const mappings: ManagedFormulaReferenceGroup["columns"] = [];
      for (const sourceColumn of source.columns) {
        if (sourceColumn.id === keyColumn.id) continue;
        const sourceIndex = source.columns.findIndex(
          (candidate) => candidate.id === sourceColumn.id,
        );
        let targetColumnId: string | undefined;
        let direct = true;
        for (const row of source.rows) {
          const content = row.cells[sourceIndex]?.content;
          if (
            rowIdentities.get(row.id) === null &&
            content?.kind === "literal" &&
            content.value.type === "null"
          ) {
            continue;
          }
          const parsed = content?.kind === "formula"
            ? parseDirectRefLiteral(content.expression)
            : undefined;
          if (
            !parsed ||
            parsed.source !== reference.source ||
            parsed.identity.type !== "string" ||
            parsed.identity.value !== rowIdentities.get(row.id)
          ) {
            direct = false;
            break;
          }
          const targetColumn = target.columns.find(
            (candidate) => candidate.name === parsed.targetColumn,
          );
          if (!targetColumn || (targetColumnId && targetColumnId !== targetColumn.id)) {
            direct = false;
            break;
          }
          targetColumnId = targetColumn.id;
        }
        if (direct && targetColumnId) {
          mappings.push({ columnId: sourceColumn.id, targetColumnId });
        }
      }
      if (mappings.length > 0) {
        const groups = source.referenceGroups ?? [];
        groups.push({
          id: nextReferenceGroupId(groups),
          source: reference.source,
          rowIds: source.rows.map((row) => row.id),
          columns: mappings,
        });
        source.referenceGroups = groups;
      }
      const preserveKeyColumn = keyColumn.hidden && source.rows.some((row) =>
        row.cells.some(
          (cell) =>
            cell.content.kind === "formula" &&
            formulaRequiresLegacyColumn(
              cell.content.expression,
              keyColumn.name,
              keyIndex,
            ),
        ),
      );
      if (keyColumn.hidden && !preserveKeyColumn) {
        source.columns.splice(keyIndex, 1);
        for (const row of source.rows) row.cells.splice(keyIndex, 1);
      }
    }
    for (const column of source.columns) {
      delete column.hidden;
      delete column.reference;
    }
  }
}

function rewriteLegacyRefExpression(
  expression: string,
  referenceColumn: string,
  targetSource: string,
  identityExpression: string,
): string {
  const escaped = referenceColumn.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(
    `^REF\\s*\\(\\s*\\[@${escaped}\\]\\s*,\\s*(\"(?:\\\\.|[^\"\\\\])*\")\\s*\\)`,
    "iu",
  );
  let result = "";
  let index = 0;
  let inString = false;
  let escapedString = false;
  while (index < expression.length) {
    const character = expression[index] ?? "";
    if (inString) {
      result += character;
      if (character === '"' && !escapedString) inString = false;
      if (character === "\\" && !escapedString) escapedString = true;
      else escapedString = false;
      index += 1;
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
      index += 1;
      continue;
    }
    if (character === "/" && expression[index + 1] === "/") {
      result += expression.slice(index);
      break;
    }
    const match = pattern.exec(expression.slice(index));
    if (match && !/[A-Za-z0-9_]/u.test(expression[index - 1] ?? "")) {
      result += `REF(${JSON.stringify(targetSource)}, ${identityExpression}, ${match[1]})`;
      index += match[0].length;
      continue;
    }
    result += character;
    index += 1;
  }
  return result;
}

function parseLegacyDirectRefTarget(
  expression: string,
  referenceColumn: string,
): string | undefined {
  const escaped = referenceColumn.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const string = String.raw`"(?:\\.|[^"\\])*"`;
  const match = new RegExp(
    `^\\s*REF\\s*\\(\\s*\\[@${escaped}\\]\\s*,\\s*(${string})\\s*\\)\\s*$`,
    "iu",
  ).exec(expression);
  if (!match) return undefined;
  try {
    const target: unknown = JSON.parse(match[1] ?? "");
    return typeof target === "string" ? target : undefined;
  } catch {
    return undefined;
  }
}

function migrateLegacyIdentityColumn(
  source: ManagedFormulaDataSource,
  columnId: string,
): ReadonlyMap<string, string> {
  const columnIndex = source.columns.findIndex((column) => column.id === columnId);
  const column = source.columns[columnIndex];
  if (!column) return new Map();
  const literals: DataTableCell[] = [];
  const identities = new Map<string, string>();
  const used = new Set<string>();
  const seenKeys = new Set<string>();
  for (const row of source.rows) {
    const cell = row.cells[columnIndex];
    if (!cell || cell.content.kind !== "literal") {
      throw new Error(
        `Legacy identity column \`${column.name}\` in \`${source.name}\` requires literal values for automatic migration.`,
      );
    }
    literals.push(cell.content.value);
    if (cell.content.value.type === "null") continue;
    const key = legacyIdentityKey(cell.content.value);
    if (seenKeys.has(key)) {
      throw new Error(
        `Legacy identity column \`${column.name}\` in \`${source.name}\` contains duplicate identities.`,
      );
    }
    seenKeys.add(key);
    if (cell.content.value.type !== "string") continue;
    const identity = cell.content.value.value;
    identities.set(key, identity);
    used.add(identity);
  }
  let generated = 1;
  for (const [rowIndex, row] of source.rows.entries()) {
    const cell = row.cells[columnIndex];
    const literal = literals[rowIndex];
    if (!cell || cell.content.kind !== "literal" || !literal) continue;
    let identity: string;
    if (literal.type === "null") {
      while (used.has(`${source.name}-${generated}`)) generated += 1;
      identity = `${source.name}-${generated}`;
      generated += 1;
    } else {
      const key = legacyIdentityKey(literal);
      const existing = identities.get(key);
      if (existing !== undefined) {
        identity = existing;
      } else {
        const base = `${literal.type}:${legacyIdentityText(literal)}`;
        identity = base;
        let suffix = 2;
        while (used.has(identity)) {
          identity = `${base}-${suffix}`;
          suffix += 1;
        }
        identities.set(key, identity);
      }
    }
    used.add(identity);
    cell.content = {
      kind: "literal",
      value: { type: "string", value: identity },
    };
    delete cell.constraint;
  }
  column.constraint = "text";
  return identities;
}

function legacyIdentityText(value: Exclude<DataTableCell, { type: "null" }>): string {
  switch (value.type) {
    case "string":
    case "integer":
      return value.value;
    case "real":
    case "boolean":
      return String(value.value);
  }
}

function legacyIdentityKey(value: Exclude<DataTableCell, { type: "null" }>): string {
  return JSON.stringify(value);
}

function formulaRequiresLegacyColumn(
  expression: string,
  columnName: string,
  removedColumn: number,
): boolean {
  let index = 0;
  let inString = false;
  let escaped = false;
  while (index < expression.length) {
    const character = expression[index] ?? "";
    if (inString) {
      if (character === '"' && !escaped) inString = false;
      if (character === "\\" && !escaped) escaped = true;
      else escaped = false;
      index += 1;
      continue;
    }
    if (character === '"') {
      inString = true;
      index += 1;
      continue;
    }
    if (character === "/" && expression[index + 1] === "/") return false;
    if (character === "[") {
      const end = expression.indexOf("]", index + 1);
      if (end < 0) return false;
      const referencedName = expression
        .slice(index + 1, end)
        .replace(/^@/u, "");
      if (referencedName === columnName) return true;
      index = end + 1;
      continue;
    }
    const header = /^HEADER\s*\(\s*([A-Za-z]+)\s*\)/iu.exec(
      expression.slice(index),
    );
    if (
      header &&
      !/[A-Za-z0-9_]/u.test(expression[index - 1] ?? "") &&
      spreadsheetColumnIndex(header[1] ?? "") >= removedColumn
    ) {
      return true;
    }
    const cell = /^(?:\$?)([A-Za-z]+)(?:\$?)([1-9][0-9]*)/u.exec(
      expression.slice(index),
    );
    if (
      cell &&
      !/[A-Za-z0-9_]/u.test(expression[index - 1] ?? "") &&
      !/[A-Za-z0-9_]/u.test(expression[index + cell[0].length] ?? "") &&
      spreadsheetColumnIndex(cell[1] ?? "") >= removedColumn
    ) {
      return true;
    }
    index += 1;
  }
  return false;
}

function spreadsheetColumnIndex(label: string): number {
  let value = 0;
  for (const character of label.toUpperCase()) {
    value = value * 26 + character.charCodeAt(0) - 64;
  }
  return value - 1;
}

function parseDirectRefLiteral(expression: string):
  | { source: string; identity: DataTableCell; targetColumn: string }
  | undefined {
  const string = String.raw`"(?:\\.|[^"\\])*"`;
  const scalar = String.raw`(?:${string}|true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?)`;
  const match = new RegExp(
    `^\\s*REF\\s*\\(\\s*(${string})\\s*,\\s*(${scalar})\\s*,\\s*(${string})\\s*\\)\\s*$`,
    "iu",
  ).exec(expression);
  if (!match) return undefined;
  try {
    const identity = parseDirectRefIdentityLiteral(match[2] ?? "");
    if (!identity) return undefined;
    return {
      source: JSON.parse(match[1] ?? ""),
      identity,
      targetColumn: JSON.parse(match[3] ?? ""),
    };
  } catch {
    return undefined;
  }
}

function parseDirectRefIdentityLiteral(expression: string): DataTableCell | undefined {
  if (expression.startsWith('"')) {
    const value: unknown = JSON.parse(expression);
    return typeof value === "string" ? { type: "string", value } : undefined;
  }
  if (/^null$/iu.test(expression)) return { type: "null" };
  if (/^(?:true|false)$/iu.test(expression)) {
    return { type: "boolean", value: /^true$/iu.test(expression) };
  }
  if (/^-?(?:0|[1-9]\d*)$/u.test(expression)) {
    return { type: "integer", value: expression };
  }
  const value = Number(expression);
  return Number.isFinite(value) ? { type: "real", value } : undefined;
}

function nextReferenceGroupId(
  groups: readonly ManagedFormulaReferenceGroup[],
): string {
  const used = new Set(groups.map((group) => group.id));
  let number = 1;
  while (used.has(`ref${number}`)) number += 1;
  return `ref${number}`;
}

export function extrasWithDataSources(
  extras: JsonValue,
  sources: readonly DataSource[],
): JsonValue {
  const current = inspectDataSourceRegistry(extras);
  if (sameDataSources(current.sources, sources)) {
    return extras;
  }
  if (!current.editable) {
    throw new Error(current.issue ?? "The data-source registry is not editable.");
  }
  validateDataSources(sources);
  const root = isObject(extras) ? { ...extras } : {};
  const definitions = Object.fromEntries(
    [...sources]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((source) => [source.name, serializeDataSource(source)]),
  );
  root[REGISTRY_KEY] = {
    schema_version: CURRENT_REGISTRY_SCHEMA_VERSION,
    sources: definitions,
  };
  return root;
}

export function validateDataSources(sources: readonly DataSource[]): void {
  const definitions = new Map<string, DataSource>();
  for (const source of sources) {
    validateSourceName(source.name);
    if (definitions.has(source.name)) {
      throw new Error(`Duplicate data-source name \`${source.name}\`.`);
    }
    definitions.set(source.name, source);
  }

  for (const source of sources) {
    if (isQueryFormulaDataSource(source)) {
      if (source.query.trim() === "") {
        throw new Error(`Formula query source \`${source.name}\` has an empty query.`);
      }
      if (Buffer.byteLength(source.query, "utf8") > MAX_QUERY_BYTES) {
        throw new Error(
          `Formula query source \`${source.name}\` query exceeds ${MAX_QUERY_BYTES} bytes.`,
        );
      }
      if (source.edit) validateSqliteEditDefinition(source.name, source.edit);
      continue;
    }

    if (isManagedFormulaDataSource(source)) {
      validateManagedFormulaDataSource(source, definitions);
      continue;
    }

    if (source.type === "rhai") {
      validateRhaiDataSource(source, definitions);
    } else {
      validateFormulaDataSource(source, definitions);
    }
  }
}

export function sameDataSources(
  left: readonly DataSource[],
  right: readonly DataSource[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((source, index) => {
    const other = right[index];
    if (!other || source.name !== other.name || source.type !== other.type) {
      return false;
    }
    if (isQueryFormulaDataSource(source)) {
      return (
        isQueryFormulaDataSource(other) &&
        source.query === other.query &&
        sameSqliteEditDefinitions(source.edit, other.edit)
      );
    }
    if (isManagedFormulaDataSource(source)) {
      return (
        isManagedFormulaDataSource(other) &&
        JSON.stringify(serializeDataSource(source)) ===
          JSON.stringify(serializeDataSource(other))
      );
    }
    if (source.type === "rhai") {
      return (
        other.type === "rhai" &&
        source.script === other.script &&
        sameStrings(source.outputColumns, other.outputColumns) &&
        sameRhaiInputs(source.inputs, other.inputs)
      );
    }
    return (
      isComputedFormulaDataSource(other) &&
      source.input === other.input &&
      source.program === other.program &&
      sameStrings(source.outputColumns, other.outputColumns)
    );
  });
}

function parseQueryFormulaDataSource(
  name: string,
  definition: { [key: string]: JsonValue },
  serializedType: "sqlite" | "formula",
): QueryFormulaDataSource | undefined {
  if (
    definition.type !== serializedType ||
    hasUnknownKeys(definition, new Set(["type", "query", "edit"])) ||
    typeof definition.query !== "string"
  ) {
    return undefined;
  }
  if (definition.edit === undefined) {
    return { name, type: "formula", query: definition.query };
  }
  if (
    !isObject(definition.edit) ||
    hasUnknownKeys(definition.edit, new Set(["table", "key", "columns"])) ||
    typeof definition.edit.table !== "string" ||
    !isObject(definition.edit.key) ||
    hasUnknownKeys(definition.edit.key, new Set(["source_column", "table_column"])) ||
    typeof definition.edit.key.source_column !== "string" ||
    typeof definition.edit.key.table_column !== "string" ||
    !isObject(definition.edit.columns)
  ) {
    return undefined;
  }
  const columns: SqliteEditDefinition["columns"] = [];
  for (const [sourceColumn, tableColumn] of Object.entries(
    definition.edit.columns,
  )) {
    if (typeof tableColumn !== "string") return undefined;
    columns.push({ sourceColumn, tableColumn });
  }
  columns.sort((left, right) => left.sourceColumn.localeCompare(right.sourceColumn));
  return {
    name,
    type: "formula",
    query: definition.query,
    edit: {
      table: definition.edit.table,
      keySourceColumn: definition.edit.key.source_column,
      keyTableColumn: definition.edit.key.table_column,
      columns,
    },
  };
}

function parseRhaiDataSource(
  name: string,
  definition: { [key: string]: JsonValue },
): RhaiDataSource | undefined {
  if (
    hasUnknownKeys(definition, new Set(["type", "script", "inputs", "output"])) ||
    typeof definition.script !== "string" ||
    !isObject(definition.inputs) ||
    !isObject(definition.output) ||
    hasUnknownKeys(definition.output, new Set(["type", "columns"])) ||
    definition.output.type !== "table" ||
    !Array.isArray(definition.output.columns) ||
    !definition.output.columns.every((column) => typeof column === "string")
  ) {
    return undefined;
  }

  const inputs: RhaiDataSourceInput[] = [];
  for (const [alias, source] of Object.entries(definition.inputs)) {
    if (typeof source !== "string") return undefined;
    inputs.push({ alias, source });
  }
  inputs.sort((left, right) => left.alias.localeCompare(right.alias));
  return {
    name,
    type: "rhai",
    script: definition.script,
    inputs,
    outputColumns: definition.output.columns as string[],
  };
}

function parseFormulaDataSource(
  name: string,
  definition: { [key: string]: JsonValue },
): ComputedFormulaDataSource | undefined {
  if (
    hasUnknownKeys(definition, new Set(["type", "input", "program", "output"])) ||
    typeof definition.input !== "string" ||
    typeof definition.program !== "string" ||
    !isObject(definition.output) ||
    hasUnknownKeys(definition.output, new Set(["type", "columns"])) ||
    definition.output.type !== "table" ||
    !Array.isArray(definition.output.columns) ||
    !definition.output.columns.every((column) => typeof column === "string")
  ) {
    return undefined;
  }
  return {
    name,
    type: "formula",
    input: definition.input,
    program: definition.program,
    outputColumns: definition.output.columns as string[],
  };
}

function parseManagedFormulaDataSource(
  name: string,
  definition: { [key: string]: JsonValue },
  allowHiddenColumns: boolean,
  allowLegacyReferences: boolean,
  allowReferenceGroups: boolean,
): ManagedFormulaDataSource | undefined {
  if (
    hasUnknownKeys(
      definition,
      new Set(["type", "columns", "rows", "reference_groups"]),
    ) ||
    !Array.isArray(definition.columns) ||
    !Array.isArray(definition.rows) ||
    (definition.reference_groups !== undefined &&
      (!allowReferenceGroups || !Array.isArray(definition.reference_groups)))
  ) {
    return undefined;
  }
  const columns: ManagedFormulaDataSource["columns"] = [];
  for (const value of definition.columns) {
    if (
      !isObject(value) ||
      hasUnknownKeys(
        value,
        new Set([
          "id",
          "name",
          "constraint",
          "identity",
          "hidden",
          "reference",
        ]),
      ) ||
      typeof value.id !== "string" ||
      typeof value.name !== "string" ||
      (value.identity !== undefined &&
        (!allowReferenceGroups || typeof value.identity !== "boolean")) ||
      (value.hidden !== undefined &&
        (!allowHiddenColumns || typeof value.hidden !== "boolean")) ||
      !isManagedCellConstraint(value.constraint)
    ) {
      return undefined;
    }
    let reference: ManagedFormulaDataSource["columns"][number]["reference"];
    if (value.reference !== undefined) {
      if (!allowLegacyReferences) return undefined;
      if (
        !isObject(value.reference) ||
        hasUnknownKeys(value.reference, new Set(["source", "column_id"])) ||
        typeof value.reference.source !== "string" ||
        typeof value.reference.column_id !== "string"
      ) {
        return undefined;
      }
      reference = {
        source: value.reference.source,
        columnId: value.reference.column_id,
      };
    }
    columns.push({
      id: value.id,
      name: value.name,
      constraint: value.constraint,
      ...(value.identity === true ? { identity: true } : {}),
      ...(value.hidden === true ? { hidden: true } : {}),
      ...(reference ? { reference } : {}),
    });
  }
  const rows: ManagedFormulaDataSource["rows"] = [];
  for (const value of definition.rows) {
    if (
      !isObject(value) ||
      hasUnknownKeys(value, new Set(["id", "cells"])) ||
      typeof value.id !== "string" ||
      !Array.isArray(value.cells)
    ) {
      return undefined;
    }
    const cells: ManagedFormulaCell[] = [];
    for (const cellValue of value.cells) {
      const cell = parseManagedFormulaCell(cellValue);
      if (!cell) return undefined;
      cells.push(cell);
    }
    rows.push({ id: value.id, cells });
  }
  const referenceGroups: ManagedFormulaReferenceGroup[] = [];
  for (const value of definition.reference_groups ?? []) {
    const group = parseManagedFormulaReferenceGroup(value);
    if (!group) return undefined;
    referenceGroups.push(group);
  }
  return {
    name,
    type: "formula",
    columns,
    rows,
    ...(referenceGroups.length > 0 ? { referenceGroups } : {}),
  };
}

function parseManagedFormulaReferenceGroup(
  value: JsonValue,
): ManagedFormulaReferenceGroup | undefined {
  if (
    !isObject(value) ||
    hasUnknownKeys(value, new Set(["id", "source", "rows", "columns"])) ||
    typeof value.id !== "string" ||
    typeof value.source !== "string" ||
    !Array.isArray(value.rows) ||
    !value.rows.every((row) => typeof row === "string") ||
    !Array.isArray(value.columns)
  ) {
    return undefined;
  }
  const columns: ManagedFormulaReferenceGroup["columns"] = [];
  for (const mapping of value.columns) {
    if (
      !isObject(mapping) ||
      hasUnknownKeys(mapping, new Set(["column_id", "target_column_id"])) ||
      typeof mapping.column_id !== "string" ||
      typeof mapping.target_column_id !== "string"
    ) {
      return undefined;
    }
    columns.push({
      columnId: mapping.column_id,
      targetColumnId: mapping.target_column_id,
    });
  }
  return {
    id: value.id,
    source: value.source,
    rowIds: [...value.rows],
    columns,
  };
}

function parseManagedFormulaCell(value: JsonValue): ManagedFormulaCell | undefined {
  if (
    !isObject(value) ||
    hasUnknownKeys(value, new Set(["content", "constraint"])) ||
    (value.constraint !== undefined && !isManagedCellConstraint(value.constraint)) ||
    !isObject(value.content)
  ) {
    return undefined;
  }
  const constraint = value.constraint as ManagedCellConstraint | undefined;
  if (
    value.content.kind === "formula" &&
    !hasUnknownKeys(value.content, new Set(["kind", "expression"])) &&
    typeof value.content.expression === "string"
  ) {
    return {
      content: { kind: "formula", expression: value.content.expression },
      ...(constraint ? { constraint } : {}),
    };
  }
  if (
    value.content.kind === "literal" &&
    !hasUnknownKeys(value.content, new Set(["kind", "value"]))
  ) {
    const literal = parseDataTableCell(value.content.value);
    if (!literal) return undefined;
    return {
      content: { kind: "literal", value: literal },
      ...(constraint ? { constraint } : {}),
    };
  }
  return undefined;
}

function parseDataTableCell(value: JsonValue): DataTableCell | undefined {
  if (!isObject(value) || typeof value.type !== "string") return undefined;
  if (value.type === "null" && !hasUnknownKeys(value, new Set(["type"]))) {
    return { type: "null" };
  }
  if (
    value.type === "boolean" &&
    !hasUnknownKeys(value, new Set(["type", "value"])) &&
    typeof value.value === "boolean"
  ) {
    return { type: "boolean", value: value.value };
  }
  if (
    value.type === "integer" &&
    !hasUnknownKeys(value, new Set(["type", "value"])) &&
    typeof value.value === "string"
  ) {
    return { type: "integer", value: value.value };
  }
  if (
    value.type === "real" &&
    !hasUnknownKeys(value, new Set(["type", "value"])) &&
    typeof value.value === "number"
  ) {
    return { type: "real", value: value.value };
  }
  if (
    value.type === "string" &&
    !hasUnknownKeys(value, new Set(["type", "value"])) &&
    typeof value.value === "string"
  ) {
    return { type: "string", value: value.value };
  }
  return undefined;
}

function serializeDataSource(source: DataSource): JsonValue {
  if (isQueryFormulaDataSource(source)) {
    return {
      type: "formula",
      query: source.query,
      ...(source.edit
        ? {
            edit: {
              table: source.edit.table,
              key: {
                source_column: source.edit.keySourceColumn,
                table_column: source.edit.keyTableColumn,
              },
              columns: Object.fromEntries(
                [...source.edit.columns]
                  .sort((left, right) =>
                    left.sourceColumn.localeCompare(right.sourceColumn),
                  )
                  .map((column) => [column.sourceColumn, column.tableColumn]),
              ),
            },
          }
        : {}),
    };
  }
  if (isManagedFormulaDataSource(source)) {
    return {
      type: "formula",
      columns: source.columns.map((column) => ({
        id: column.id,
        name: column.name,
        constraint: column.constraint,
        ...(column.identity ? { identity: true } : {}),
      })),
      rows: source.rows.map((row) => ({
        id: row.id,
        cells: row.cells.map(serializeManagedFormulaCell),
      })),
      ...(source.referenceGroups?.length
        ? {
            reference_groups: source.referenceGroups.map((group) => ({
              id: group.id,
              source: group.source,
              rows: [...group.rowIds],
              columns: group.columns.map((mapping) => ({
                column_id: mapping.columnId,
                target_column_id: mapping.targetColumnId,
              })),
            })),
          }
        : {}),
    };
  }
  if (isComputedFormulaDataSource(source)) {
    return {
      type: "formula",
      input: source.input,
      program: source.program,
      output: {
        type: "table",
        columns: [...source.outputColumns],
      },
    };
  }
  return {
    type: "rhai",
    script: source.script,
    inputs: Object.fromEntries(
      [...source.inputs]
        .sort((left, right) => left.alias.localeCompare(right.alias))
        .map((input) => [input.alias, input.source]),
    ),
    output: {
      type: "table",
      columns: [...source.outputColumns],
    },
  };
}

function serializeManagedFormulaCell(cell: ManagedFormulaCell): JsonValue {
  const content: JsonValue =
    cell.content.kind === "formula"
      ? { kind: "formula", expression: cell.content.expression }
      : { kind: "literal", value: { ...cell.content.value } };
  return {
    content,
    ...(cell.constraint ? { constraint: cell.constraint } : {}),
  };
}

function validateManagedFormulaDataSource(
  source: ManagedFormulaDataSource,
  definitions: ReadonlyMap<string, DataSource>,
): void {
  if (source.columns.length === 0 || source.columns.length > MAX_TABLE_COLUMNS) {
    throw new Error(
      `Managed Formula source \`${source.name}\` requires 1-${MAX_TABLE_COLUMNS} columns.`,
    );
  }
  if (source.rows.length > MAX_TABLE_ROWS || source.rows.length * source.columns.length > MAX_TABLE_CELLS) {
    throw new Error(
      `Managed Formula source \`${source.name}\` exceeds the ${MAX_TABLE_ROWS}-row or ${MAX_TABLE_CELLS}-cell limit.`,
    );
  }
  const columnIds = new Set<string>();
  const columnNames = new Set<string>();
  let identityColumns = 0;
  for (const column of source.columns) {
    if (column.hidden || column.reference) {
      throw new Error(
        `Managed Formula source \`${source.name}\` uses a removed hidden-column reference definition.`,
      );
    }
    if (column.identity) identityColumns += 1;
    validateStableId(column.id, `Managed Formula source \`${source.name}\` column`);
    validateColumnName(column.name, source.name);
    if (columnIds.has(column.id) || columnNames.has(column.name)) {
      throw new Error(`Managed Formula source \`${source.name}\` requires unique column ids and names.`);
    }
    columnIds.add(column.id);
    columnNames.add(column.name);
  }
  if (identityColumns > 1) {
    throw new Error(
      `Managed Formula source \`${source.name}\` supports at most one identity column.`,
    );
  }
  const rowIds = new Set<string>();
  let formulaProgramBytes = 0;
  for (const row of source.rows) {
    validateStableId(row.id, `Managed Formula source \`${source.name}\` row`);
    if (rowIds.has(row.id)) throw new Error(`Managed Formula source \`${source.name}\` requires unique row ids.`);
    rowIds.add(row.id);
    if (row.cells.length !== source.columns.length) {
      throw new Error(`Managed Formula source \`${source.name}\` rows must match its column count.`);
    }
    for (const [index, cell] of row.cells.entries()) {
      if (cell.content.kind === "formula") {
        if (
          cell.content.expression.trim() === "" ||
          cell.content.expression.trimStart().startsWith("=") ||
          /[\r\n]/u.test(cell.content.expression)
        ) {
          throw new Error("Managed Formula expressions must be non-empty single-line RHS expressions without a leading '='.");
        }
        formulaProgramBytes += Buffer.byteLength(cell.content.expression, "utf8") + 16;
        continue;
      }
      validateManagedLiteral(cell.content.value, cell.constraint ?? source.columns[index].constraint);
    }
  }
  if (formulaProgramBytes > MAX_FORMULA_PROGRAM_BYTES) {
    throw new Error(`Managed Formula source \`${source.name}\` program exceeds ${MAX_FORMULA_PROGRAM_BYTES} bytes.`);
  }
  validateManagedReferenceGroups(source, definitions);
}

function validateManagedReferenceGroups(
  source: ManagedFormulaDataSource,
  definitions: ReadonlyMap<string, DataSource>,
): void {
  const groupIds = new Set<string>();
  const occupied = new Set<string>();
  for (const group of source.referenceGroups ?? []) {
    validateStableId(
      group.id,
      `Managed Formula source \`${source.name}\` reference group`,
    );
    if (groupIds.has(group.id)) {
      throw new Error(
        `Managed Formula source \`${source.name}\` repeats reference group id \`${group.id}\`.`,
      );
    }
    groupIds.add(group.id);
    const target = definitions.get(group.source);
    if (
      !isManagedFormulaDataSource(target) ||
      target.columns.filter((column) => column.identity).length !== 1
    ) {
      throw new Error(
        `Reference group \`${group.id}\` in \`${source.name}\` requires a managed Formula target with exactly one identity column.`,
      );
    }
    if (group.rowIds.length === 0 || group.columns.length === 0) {
      throw new Error(
        `Reference group \`${group.id}\` in \`${source.name}\` cannot be empty.`,
      );
    }
    const rowIds = new Set(group.rowIds);
    if (
      rowIds.size !== group.rowIds.length ||
      group.rowIds.some(
        (id) => !source.rows.some((candidate) => candidate.id === id),
      )
    ) {
      throw new Error(
        `Reference group \`${group.id}\` in \`${source.name}\` has invalid rows.`,
      );
    }
    const mapped = new Set<string>();
    const resolvedMappings: Array<{
      columnIndex: number;
      columnId: string;
      targetColumnName: string;
    }> = [];
    for (const mapping of group.columns) {
      const columnIndex = source.columns.findIndex(
        (column) => column.id === mapping.columnId,
      );
      const targetColumn = target.columns.find(
        (column) => column.id === mapping.targetColumnId,
      );
      if (
        mapped.has(mapping.columnId) ||
        columnIndex < 0 ||
        !targetColumn
      ) {
        throw new Error(
          `Reference group \`${group.id}\` in \`${source.name}\` has invalid column mappings.`,
        );
      }
      mapped.add(mapping.columnId);
      resolvedMappings.push({
        columnIndex,
        columnId: mapping.columnId,
        targetColumnName: targetColumn.name,
      });
      for (const rowId of group.rowIds) {
        const key = `${rowId}\u0000${mapping.columnId}`;
        if (occupied.has(key)) {
          throw new Error(
            `Managed Formula source \`${source.name}\` has overlapping reference groups.`,
          );
        }
        occupied.add(key);
      }
    }
    for (const rowId of group.rowIds) {
      const row = source.rows.find((candidate) => candidate.id === rowId);
      if (!row) continue;
      let selectedIdentity: string | null | undefined;
      let hasSelection = false;
      for (const mapping of resolvedMappings) {
        const content = row.cells[mapping.columnIndex]?.content;
        let identity: string | null;
        if (content?.kind === "literal" && content.value.type === "null") {
          identity = null;
        } else if (content?.kind === "formula") {
          const reference = parseDirectRefLiteral(content.expression);
          if (
            !reference ||
            reference.source !== group.source ||
            reference.targetColumn !== mapping.targetColumnName
          ) {
            throw new Error(
              `Reference group \`${group.id}\` in \`${source.name}\` row \`${rowId}\` column \`${mapping.columnId}\` requires its mapped direct three-argument REF or NULL.`,
            );
          }
          identity = JSON.stringify(reference.identity);
        } else {
          throw new Error(
            `Reference group \`${group.id}\` in \`${source.name}\` row \`${rowId}\` column \`${mapping.columnId}\` requires a direct three-argument REF or NULL.`,
          );
        }
        if (hasSelection && selectedIdentity !== identity) {
          throw new Error(
            `Reference group \`${group.id}\` in \`${source.name}\` row \`${rowId}\` mixes target identities or NULL cells.`,
          );
        }
        selectedIdentity = identity;
        hasSelection = true;
      }
    }
  }
}

function validateManagedLiteral(value: DataTableCell, constraint: ManagedCellConstraint): void {
  if (value.type === "real" && !Number.isFinite(value.value)) throw new Error("Managed real values must be finite.");
  if (value.type === "integer") {
    if (!/^(?:0|-?[1-9]\d*)$/u.test(value.value)) throw new Error("Managed integer values must be canonical decimal strings.");
    const integer = BigInt(value.value);
    if (integer < -(2n ** 63n) || integer > 2n ** 63n - 1n) {
      throw new Error("Managed integer values must fit in a signed 64-bit value.");
    }
  }
  if (value.type === "string" && Buffer.byteLength(value.value, "utf8") > MAX_MANAGED_TEXT_BYTES) {
    throw new Error(`Managed text values must be at most ${MAX_MANAGED_TEXT_BYTES} bytes.`);
  }
  if (value.type === "null" || constraint === "any") return;
  if (constraint === "text" && value.type !== "string") throw new Error("A managed Text cell contains a non-text literal.");
  if (constraint === "number" && value.type !== "integer" && value.type !== "real") throw new Error("A managed Number cell contains a non-number literal.");
  if (constraint === "boolean" && value.type !== "boolean") throw new Error("A managed Boolean cell contains a non-boolean literal.");
}

function validateStableId(value: string, owner: string): void {
  if (!SOURCE_NAME_PATTERN.test(value) || Buffer.byteLength(value, "utf8") > MAX_SOURCE_NAME_BYTES) {
    throw new Error(`${owner} id \`${value}\` is invalid.`);
  }
}

function isManagedCellConstraint(value: JsonValue): value is ManagedCellConstraint {
  return value === "any" || value === "text" || value === "number" || value === "boolean";
}

function validateSqliteEditDefinition(
  sourceName: string,
  edit: SqliteEditDefinition,
): void {
  validateSqliteIdentifier(
    edit.table,
    `Formula query source \`${sourceName}\` edit table`,
  );
  validateColumnName(edit.keySourceColumn, sourceName);
  validateSqliteIdentifier(
    edit.keyTableColumn,
    `Formula query source \`${sourceName}\` edit key table column`,
  );
  if (edit.columns.length === 0) {
    throw new Error(
      `Editable Formula query source \`${sourceName}\` requires at least one writable column.`,
    );
  }
  const sourceColumns = new Set<string>();
  for (const column of edit.columns) {
    validateColumnName(column.sourceColumn, sourceName);
    if (column.sourceColumn === edit.keySourceColumn) {
      throw new Error(
        `Editable Formula query source \`${sourceName}\` cannot make its stable key column \`${column.sourceColumn}\` writable.`,
      );
    }
    if (sourceColumns.has(column.sourceColumn)) {
      throw new Error(
        `Editable Formula query source \`${sourceName}\` repeats writable column \`${column.sourceColumn}\`.`,
      );
    }
    sourceColumns.add(column.sourceColumn);
    validateSqliteIdentifier(
      column.tableColumn,
      `Formula query source \`${sourceName}\` edit table column`,
    );
  }
}

function validateColumnName(column: string, sourceName: string): void {
  const length = Buffer.byteLength(column, "utf8");
  if (length === 0 || length > MAX_COLUMN_NAME_BYTES) {
    throw new Error(
      `Editable Formula query source \`${sourceName}\` has an empty or overlong query-result column.`,
    );
  }
}

function validateSqliteIdentifier(identifier: string, owner: string): void {
  if (
    Buffer.byteLength(identifier, "utf8") > MAX_SQLITE_IDENTIFIER_BYTES ||
    !SQLITE_IDENTIFIER_PATTERN.test(identifier)
  ) {
    throw new Error(
      `${owner} \`${identifier}\` must use at most ${MAX_SQLITE_IDENTIFIER_BYTES} ASCII letters, digits or underscores and start with a letter or underscore.`,
    );
  }
}

function validateRhaiDataSource(
  source: RhaiDataSource,
  definitions: ReadonlyMap<string, DataSource>,
): void {
  const normalizedScript = normalizeLogicalPath(source.script);
  if (normalizedScript !== source.script) {
    throw new Error(
      `Rhai source \`${source.name}\` script path must be canonical; use \`${normalizedScript}\`.`,
    );
  }
  if (source.inputs.length === 0) {
    throw new Error(
      `Rhai source \`${source.name}\` requires at least one Formula query input.`,
    );
  }
  if (source.inputs.length > MAX_RHAI_INPUTS) {
    throw new Error(
      `Rhai source \`${source.name}\` exceeds the ${MAX_RHAI_INPUTS}-input limit.`,
    );
  }
  const aliases = new Set<string>();
  for (const input of source.inputs) {
    validateSourceName(input.alias, `Rhai source \`${source.name}\` input alias`);
    if (aliases.has(input.alias)) {
      throw new Error(
        `Rhai source \`${source.name}\` repeats input alias \`${input.alias}\`.`,
      );
    }
    aliases.add(input.alias);
    validateSourceName(input.source, `Rhai source \`${source.name}\` input source`);
    const target = definitions.get(input.source);
    if (!target) {
      throw new Error(
        `Rhai source \`${source.name}\` input \`${input.alias}\` references undefined source \`${input.source}\`.`,
      );
    }
    if (!isQueryFormulaDataSource(target) && !isManagedFormulaDataSource(target)) {
      throw new Error(
        `Rhai source \`${source.name}\` input \`${input.alias}\` must reference a managed or query Formula table.`,
      );
    }
  }
  validateTableOutputColumns("Rhai", source.name, source.outputColumns);
}

function validateFormulaDataSource(
  source: ComputedFormulaDataSource,
  definitions: ReadonlyMap<string, DataSource>,
): void {
  if (Buffer.byteLength(source.program, "utf8") > MAX_FORMULA_PROGRAM_BYTES) {
    throw new Error(
      `Formula source \`${source.name}\` program exceeds ${MAX_FORMULA_PROGRAM_BYTES} bytes.`,
    );
  }
  validateSourceName(source.input, `Formula source \`${source.name}\` input source`);
  const target = definitions.get(source.input);
  if (!target) {
    throw new Error(
      `Formula source \`${source.name}\` input references undefined source \`${source.input}\`.`,
    );
  }
  if (!isQueryFormulaDataSource(target)) {
    throw new Error(
      `Computed Formula source \`${source.name}\` input must reference a Formula query source.`,
    );
  }
  validateTableOutputColumns("Formula", source.name, source.outputColumns);
}

function validateTableOutputColumns(
  sourceType: "Rhai" | "Formula",
  sourceName: string,
  outputColumns: readonly string[],
): void {
  if (outputColumns.length === 0) {
    throw new Error(
      `${sourceType} source \`${sourceName}\` table output requires at least one column.`,
    );
  }
  if (outputColumns.length > MAX_TABLE_COLUMNS) {
    throw new Error(
      `${sourceType} source \`${sourceName}\` table output exceeds ${MAX_TABLE_COLUMNS} columns.`,
    );
  }
  const columns = new Set<string>();
  for (const column of outputColumns) {
    const length = Buffer.byteLength(column, "utf8");
    if (length === 0 || length > MAX_COLUMN_NAME_BYTES) {
      throw new Error(
        `${sourceType} source \`${sourceName}\` has an empty or overlong output column.`,
      );
    }
    if (columns.has(column)) {
      throw new Error(
        `${sourceType} source \`${sourceName}\` repeats output column \`${column}\`.`,
      );
    }
    columns.add(column);
  }
}

function validateSourceName(name: string, owner = "Invalid source name"): void {
  const nameBytes = Buffer.byteLength(name, "utf8");
  if (
    nameBytes === 0 ||
    nameBytes > MAX_SOURCE_NAME_BYTES ||
    !SOURCE_NAME_PATTERN.test(name)
  ) {
    throw new Error(
      `${owner} \`${name}\`; use 1-${MAX_SOURCE_NAME_BYTES} ASCII letters, digits, '.', '_' or '-'.`,
    );
  }
}

function normalizeLogicalPath(input: string): string {
  if (input === "") {
    throw new Error("Rhai script attachment path must not be empty.");
  }
  const slashNormalized = input.replaceAll("\\", "/");
  if (slashNormalized.startsWith("/")) {
    throw new Error("Rhai script attachment path must not start with '/'.");
  }
  const components: string[] = [];
  for (const component of slashNormalized.split("/")) {
    if (component === "" || component === ".") continue;
    if (component === "..") {
      throw new Error("Rhai script attachment path must not contain '..'.");
    }
    if ([...component].some((character) => /\p{Cc}/u.test(character))) {
      throw new Error("Rhai script attachment path must not contain control characters.");
    }
    if (component.includes(":")) {
      throw new Error("Rhai script attachment path must not contain ':'.");
    }
    components.push(component);
  }
  if (components.length === 0) {
    throw new Error("Rhai script attachment path resolves to empty.");
  }
  const normalized = components.join("/");
  if (RESERVED_ATTACHMENT_PATHS.has(normalized)) {
    throw new Error(`Rhai script attachment path \`${normalized}\` is reserved.`);
  }
  return normalized;
}

function sameRhaiInputs(
  left: readonly RhaiDataSourceInput[],
  right: readonly RhaiDataSourceInput[],
): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort((a, b) => a.alias.localeCompare(b.alias));
  const sortedRight = [...right].sort((a, b) => a.alias.localeCompare(b.alias));
  return sortedLeft.every(
    (input, index) =>
      input.alias === sortedRight[index]?.alias &&
      input.source === sortedRight[index]?.source,
  );
}

function sameSqliteEditDefinitions(
  left: SqliteEditDefinition | undefined,
  right: SqliteEditDefinition | undefined,
): boolean {
  if (!left || !right) return left === right;
  if (
    left.table !== right.table ||
    left.keySourceColumn !== right.keySourceColumn ||
    left.keyTableColumn !== right.keyTableColumn ||
    left.columns.length !== right.columns.length
  ) {
    return false;
  }
  const sortedLeft = [...left.columns].sort((a, b) =>
    a.sourceColumn.localeCompare(b.sourceColumn),
  );
  const sortedRight = [...right.columns].sort((a, b) =>
    a.sourceColumn.localeCompare(b.sourceColumn),
  );
  return sortedLeft.every(
    (column, index) =>
      column.sourceColumn === sortedRight[index]?.sourceColumn &&
      column.tableColumn === sortedRight[index]?.tableColumn,
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function isQueryFormulaDataSource(
  source: DataSource | undefined,
): source is QueryFormulaDataSource {
  return source?.type === "formula" && "query" in source;
}

export function isComputedFormulaDataSource(
  source: DataSource | undefined,
): source is ComputedFormulaDataSource {
  return source?.type === "formula" && "input" in source;
}

export function isManagedFormulaDataSource(
  source: DataSource | undefined,
): source is ManagedFormulaDataSource {
  return source?.type === "formula" && "columns" in source;
}

function invalidRegistry(issue: string, rawRegistry: string): DataSourceRegistryView {
  return { editable: false, sources: [], issue, rawRegistry };
}

function isObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasUnknownKeys(
  value: { [key: string]: JsonValue },
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).some((key) => !allowed.has(key));
}
