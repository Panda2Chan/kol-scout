import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getExtensionBuildConfig } from "../backend/services/config-service.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const args = new Set(process.argv.slice(2));
const target = getArgValue("--target") || process.env.BUILD_TARGET || "production";
const dryRun = args.has("--dry-run");
const outDir = resolve(rootDir, process.env.EXTENSION_OUT_DIR || "dist/kol-scout-extension");
const buildConfig = getExtensionBuildConfig(process.env, { target });

const manifest = JSON.parse(await readFile(resolve(rootDir, "manifest.json"), "utf8"));
manifest.host_permissions = buildConfig.hostPermissions;

if (dryRun) {
  console.log(`extension target: ${buildConfig.target}`);
  console.log(`api base url: ${buildConfig.apiBaseUrl}`);
  console.log(`host permissions: ${buildConfig.hostPermissions.join(", ")}`);
  process.exit(0);
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await cp(resolve(rootDir, "assets"), join(outDir, "assets"), { recursive: true });
await cp(resolve(rootDir, "src"), join(outDir, "src"), { recursive: true });
await writeFile(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(
  join(outDir, "src/shared/generated-config.js"),
  [
    "export const BACKEND_CONFIG = Object.freeze({",
    `  apiBaseUrl: ${JSON.stringify(buildConfig.apiBaseUrl)},`,
    `  authToken: ${JSON.stringify(process.env.KOL_API_AUTH_TOKEN || "")}`,
    "});",
    ""
  ].join("\n")
);

console.log(`KOL Scout extension package created: ${outDir}`);

function getArgValue(name) {
  const prefix = `${name}=`;
  const arg = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : "";
}
