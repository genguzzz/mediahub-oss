// Upsert one app into a 全能签 / AltStore-style software source JSON (stdin → stdout).
//   node scripts/lib/source-json.mjs <bundleId> <version> <build> <name> <minIos> <size> <downUrl> <iconUrl> <sourceUrl> [sourceName] [--force]
// Notes are read from the MEDIAHUB_NOTES env var. An empty stdin starts a new source.
// Writes both field sets (全能签: bundleId/downUrl/icon/minIos…, AltStore: bundleIdentifier/downloadURL/iconURL…)
// so either client can read it. Exits 3 when the version is already listed and --force is not given.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const force = args.includes("--force");
const [bundleId, version, build, name, minIos, size, downUrl, iconUrl, sourceUrl, sourceName] = args.filter((a) => a !== "--force");
const input = readFileSync(0, "utf8").trim();
const source = input ? JSON.parse(input) : {};
source.name ??= sourceName || "影库";
source.identifier ??= bundleId.split(".").slice(0, -1).join(".") + ".source";
source.sourceURL ??= sourceUrl;
source.apps ??= [];

const index = source.apps.findIndex((a) => a.bundleId === bundleId || a.bundleIdentifier === bundleId);
const old = index >= 0 ? source.apps[index] : undefined;
if (old && old.version === version && !force) {
  console.error(`source already lists ${bundleId} ${version}; use --force to replace it`);
  process.exit(3);
}
const notes = process.env.MEDIAHUB_NOTES || `${name} ${version}`;
const app = {
  ...old,
  name,
  type: "4",
  version,
  build,
  versionDate: new Date().toISOString(),
  versionDescription: notes,
  bundleId,
  icon: iconUrl,
  downUrl,
  minIos,
  size: Number(size),
  bundleIdentifier: bundleId,
  downloadURL: downUrl,
  iconURL: iconUrl,
  localizedDescription: notes,
};
if (index >= 0) source.apps[index] = app;
else source.apps.push(app);
process.stdout.write(JSON.stringify(source, null, 2) + "\n");
