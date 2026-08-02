import { existsSync } from "node:fs";
import * as path from "node:path";

export type CliSource = "configured" | "bundled" | "path";

export interface CliExecutable {
  executable: string;
  source: CliSource;
}

export function bundledCliPath(
  extensionPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return path.join(extensionPath, "bin", platform === "win32" ? "tmd.exe" : "tmd");
}

export function resolveCliExecutable(
  extensionPath: string,
  configuredPath: string | undefined,
  fileExists: (candidate: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
): CliExecutable {
  const configured = configuredPath?.trim();
  if (configured) {
    return { executable: configured, source: "configured" };
  }

  const bundled = bundledCliPath(extensionPath, platform);
  if (fileExists(bundled)) {
    return { executable: bundled, source: "bundled" };
  }

  return { executable: "tmd", source: "path" };
}
