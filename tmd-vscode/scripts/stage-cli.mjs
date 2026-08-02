import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [, , sourceArgument, target] = process.argv;
if (!sourceArgument || !target) {
  throw new Error("Usage: node scripts/stage-cli.mjs <binary> <vsce-target>");
}

const targets = new Map([
  ["darwin-arm64", "darwin-arm64"],
  ["darwin-x64", "darwin-x64"],
  ["linux-arm64", "linux-arm64"],
  ["linux-x64", "linux-x64"],
  ["win32-arm64", "win32-arm64"],
  ["win32-x64", "win32-x64"],
]);
const hostTarget = targets.get(`${process.platform}-${process.arch}`);
if (hostTarget !== target) {
  throw new Error(`Cannot stage ${target} from ${process.platform}-${process.arch}.`);
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const extensionDirectory = resolve(scriptDirectory, "..");
const binDirectory = join(extensionDirectory, "bin");
const source = resolve(extensionDirectory, sourceArgument);
const expectedName = process.platform === "win32" ? "tmd.exe" : "tmd";
if (basename(source).toLowerCase() !== expectedName) {
  throw new Error(`Expected a ${expectedName} binary, received ${basename(source)}.`);
}

await rm(binDirectory, { force: true, recursive: true });
await mkdir(binDirectory, { recursive: true });
const destination = join(binDirectory, expectedName);
await copyFile(source, destination);
if (process.platform !== "win32") {
  await chmod(destination, 0o755);
}
console.log(`Staged ${target} CLI at ${destination}`);
