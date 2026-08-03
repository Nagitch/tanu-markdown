import type {
  DataSourceRegistryView,
  JsonValue,
  SqliteDataSource,
} from "./types.js";

const REGISTRY_KEY = "tmd_data_sources";
const REGISTRY_SCHEMA_VERSION = 1;
const MAX_SOURCE_NAME_BYTES = 128;
const MAX_QUERY_BYTES = 64 * 1024;
const SOURCE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export function inspectDataSourceRegistry(extras: JsonValue): DataSourceRegistryView {
  if (extras === null) {
    return { editable: true, sources: [] };
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
    return { editable: true, sources: [] };
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
  if (registry.schema_version !== REGISTRY_SCHEMA_VERSION) {
    return invalidRegistry(
      `Data-source schema_version ${String(registry.schema_version)} is not editable; expected 1.`,
      rawRegistry,
    );
  }
  if (!isObject(registry.sources)) {
    return invalidRegistry("The data-source registry has no valid sources object.", rawRegistry);
  }

  const sources: SqliteDataSource[] = [];
  for (const [name, definition] of Object.entries(registry.sources)) {
    if (!isObject(definition)) {
      return invalidRegistry(`Data source \`${name}\` is not an object.`, rawRegistry);
    }
    if (hasUnknownKeys(definition, new Set(["type", "query"]))) {
      return invalidRegistry(
        `Data source \`${name}\` contains unsupported fields.`,
        rawRegistry,
      );
    }
    if (definition.type !== "sqlite" || typeof definition.query !== "string") {
      return invalidRegistry(
        `Data source \`${name}\` is not an editable SQLite source.`,
        rawRegistry,
      );
    }
    sources.push({ name, type: "sqlite", query: definition.query });
  }
  sources.sort((left, right) => left.name.localeCompare(right.name));
  try {
    validateDataSources(sources);
  } catch (error) {
    return invalidRegistry(error instanceof Error ? error.message : String(error), rawRegistry);
  }
  return { editable: true, sources };
}

export function extrasWithDataSources(
  extras: JsonValue,
  sources: readonly SqliteDataSource[],
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
    sources.map((source) => [
      source.name,
      { type: "sqlite", query: source.query } satisfies JsonValue,
    ]),
  );
  root[REGISTRY_KEY] = {
    schema_version: REGISTRY_SCHEMA_VERSION,
    sources: definitions,
  };
  return root;
}

export function validateDataSources(sources: readonly SqliteDataSource[]): void {
  const names = new Set<string>();
  for (const source of sources) {
    const nameBytes = Buffer.byteLength(source.name, "utf8");
    if (
      nameBytes === 0 ||
      nameBytes > MAX_SOURCE_NAME_BYTES ||
      !SOURCE_NAME_PATTERN.test(source.name)
    ) {
      throw new Error(
        `Invalid source name \`${source.name}\`; use 1-${MAX_SOURCE_NAME_BYTES} ASCII letters, digits, '.', '_' or '-'.`,
      );
    }
    if (names.has(source.name)) {
      throw new Error(`Duplicate data-source name \`${source.name}\`.`);
    }
    names.add(source.name);
    if (source.type !== "sqlite") {
      throw new Error(`Data source \`${source.name}\` must have type \`sqlite\`.`);
    }
    if (source.query.trim() === "") {
      throw new Error(`SQLite source \`${source.name}\` has an empty query.`);
    }
    if (Buffer.byteLength(source.query, "utf8") > MAX_QUERY_BYTES) {
      throw new Error(
        `SQLite source \`${source.name}\` query exceeds ${MAX_QUERY_BYTES} bytes.`,
      );
    }
  }
}

export function sameDataSources(
  left: readonly SqliteDataSource[],
  right: readonly SqliteDataSource[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (source, index) =>
        source.name === right[index]?.name &&
        source.type === right[index]?.type &&
        source.query === right[index]?.query,
    )
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
