import type {
  DataSource,
  DataSourceRegistryView,
  FormulaDataSource,
  JsonValue,
  RhaiDataSource,
  RhaiDataSourceInput,
} from "./types.js";

const REGISTRY_KEY = "tmd_data_sources";
const LEGACY_REGISTRY_SCHEMA_VERSION = 1;
const RHAI_REGISTRY_SCHEMA_VERSION = 2;
const CURRENT_REGISTRY_SCHEMA_VERSION = 3;
const MAX_SOURCE_NAME_BYTES = 128;
const MAX_QUERY_BYTES = 64 * 1024;
const MAX_FORMULA_PROGRAM_BYTES = 256 * 1024;
const MAX_RHAI_INPUTS = 16;
const MAX_TABLE_COLUMNS = 128;
const MAX_COLUMN_NAME_BYTES = 256;
const SOURCE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
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
      schemaVersion: LEGACY_REGISTRY_SCHEMA_VERSION,
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
      schemaVersion: LEGACY_REGISTRY_SCHEMA_VERSION,
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
    schemaVersion !== CURRENT_REGISTRY_SCHEMA_VERSION
  ) {
    return invalidRegistry(
      `Data-source schema_version ${String(schemaVersion)} is not editable; expected 1, 2 or 3.`,
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
        hasUnknownKeys(definition, new Set(["type", "query"])) ||
        typeof definition.query !== "string"
      ) {
        return invalidRegistry(
          `Data source \`${name}\` is not an editable SQLite source.`,
          rawRegistry,
        );
      }
      sources.push({ name, type: "sqlite", query: definition.query });
      continue;
    }
    if (definition.type === "rhai") {
      if (
        schemaVersion !== RHAI_REGISTRY_SCHEMA_VERSION &&
        schemaVersion !== CURRENT_REGISTRY_SCHEMA_VERSION
      ) {
        return invalidRegistry(
          `Rhai data source \`${name}\` requires schema_version 2 or 3.`,
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
      if (schemaVersion !== CURRENT_REGISTRY_SCHEMA_VERSION) {
        return invalidRegistry(
          `Formula data source \`${name}\` requires schema_version 3.`,
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
  try {
    validateDataSources(sources);
  } catch (error) {
    return invalidRegistry(error instanceof Error ? error.message : String(error), rawRegistry);
  }
  return { editable: true, schemaVersion, sources };
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
  const schemaVersion =
    current.schemaVersion === CURRENT_REGISTRY_SCHEMA_VERSION ||
    sources.some((source) => source.type === "formula")
      ? CURRENT_REGISTRY_SCHEMA_VERSION
      : current.schemaVersion === RHAI_REGISTRY_SCHEMA_VERSION ||
          sources.some((source) => source.type === "rhai")
        ? RHAI_REGISTRY_SCHEMA_VERSION
        : LEGACY_REGISTRY_SCHEMA_VERSION;
  const definitions = Object.fromEntries(
    [...sources]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((source) => [source.name, serializeDataSource(source)]),
  );
  root[REGISTRY_KEY] = {
    schema_version: schemaVersion,
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
    if (source.type === "sqlite") {
      if (source.query.trim() === "") {
        throw new Error(`SQLite source \`${source.name}\` has an empty query.`);
      }
      if (Buffer.byteLength(source.query, "utf8") > MAX_QUERY_BYTES) {
        throw new Error(
          `SQLite source \`${source.name}\` query exceeds ${MAX_QUERY_BYTES} bytes.`,
        );
      }
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
    if (source.type === "sqlite") {
      return other.type === "sqlite" && source.query === other.query;
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
      other.type === "formula" &&
      source.input === other.input &&
      source.program === other.program &&
      sameStrings(source.outputColumns, other.outputColumns)
    );
  });
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
): FormulaDataSource | undefined {
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

function serializeDataSource(source: DataSource): JsonValue {
  if (source.type === "sqlite") {
    return { type: "sqlite", query: source.query };
  }
  if (source.type === "formula") {
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
    throw new Error(`Rhai source \`${source.name}\` requires at least one SQLite input.`);
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
    if (target.type !== "sqlite") {
      throw new Error(
        `Rhai source \`${source.name}\` input \`${input.alias}\` must reference a SQLite source; \`${input.source}\` is Rhai.`,
      );
    }
  }
  validateTableOutputColumns("Rhai", source.name, source.outputColumns);
}

function validateFormulaDataSource(
  source: FormulaDataSource,
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
  if (target.type !== "sqlite") {
    throw new Error(
      `Formula source \`${source.name}\` input must reference a SQLite source; \`${source.input}\` is ${target.type}.`,
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

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
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
