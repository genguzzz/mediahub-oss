// Self-hosted Expo Updates (protocol v1) server.
// Layout: <updatesDir>/<runtimeVersion>/<updateId>/{update.json, dist files...}
// update.json holds the precomputed manifest per platform; assets are served by
// nginx from /updates/assets/ (immutable: an update dir is never modified).
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.ts";

const SAFE = /^[A-Za-z0-9._-]+$/;
const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  svg: "image/svg+xml", ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2",
  json: "application/json", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav",
};

interface Asset {
  hash: string;
  key: string;
  contentType: string;
  fileExtension?: string;
  url: string;
}

interface Manifest {
  id: string;
  createdAt: string;
  runtimeVersion: string;
  launchAsset: Asset;
  assets: Asset[];
  metadata: Record<string, string>;
  extra: Record<string, unknown>;
}

export interface UpdateRecord {
  id: string;
  createdAt: string;
  runtimeVersion: string;
  message: string;
  commit: string;
  manifests: Record<string, Manifest>; // by platform
}

function b64url(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function md5(buf: Buffer): string {
  return createHash("md5").update(buf).digest("hex");
}

function runTar(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("tar", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}: ${err.slice(0, 300)}`))));
  });
}

// Accepts a .tar.gz of `expo export` output plus expoConfig.json at its root.
export async function storeUpdate(input: { tarball: Buffer; runtimeVersion: string; message: string; commit: string }): Promise<UpdateRecord> {
  if (!SAFE.test(input.runtimeVersion)) throw new Error("bad runtimeVersion");
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const rvDir = path.join(config.updatesDir, input.runtimeVersion);
  const tmp = path.join(config.updatesDir, `.incoming-${id}`);
  await mkdir(tmp, { recursive: true });
  try {
    const tarPath = path.join(tmp, "..", `.incoming-${id}.tgz`);
    await writeFile(tarPath, input.tarball);
    await runTar(["-xzf", tarPath, "-C", tmp, "--no-same-owner", "--no-same-permissions"]);
    await rm(tarPath, { force: true });

    const metadata = JSON.parse(await readFile(path.join(tmp, "metadata.json"), "utf8")) as {
      fileMetadata: Record<string, { bundle: string; assets: { path: string; ext: string }[] }>;
    };
    let expoConfig: unknown = {};
    try {
      expoConfig = JSON.parse(await readFile(path.join(tmp, "expoConfig.json"), "utf8"));
    } catch {
      // optional
    }

    const urlBase = `${config.updatesBase}/assets/${input.runtimeVersion}/${id}`;
    const describe = async (rel: string, launch: boolean, ext?: string): Promise<Asset> => {
      if (rel.includes("..")) throw new Error(`bad asset path ${rel}`);
      const buf = await readFile(path.join(tmp, rel));
      return {
        hash: b64url(buf),
        key: md5(buf),
        contentType: launch ? "application/javascript" : MIME[ext ?? ""] ?? "application/octet-stream",
        ...(launch ? {} : { fileExtension: `.${ext}` }),
        url: `${urlBase}/${rel}`,
      };
    };

    const manifests: Record<string, Manifest> = {};
    for (const [platform, fm] of Object.entries(metadata.fileMetadata)) {
      manifests[platform] = {
        id,
        createdAt,
        runtimeVersion: input.runtimeVersion,
        launchAsset: await describe(fm.bundle, true),
        assets: await Promise.all(fm.assets.map((a) => describe(a.path, false, a.ext))),
        metadata: {},
        extra: { expoClient: expoConfig, message: input.message, commit: input.commit },
      };
    }
    if (Object.keys(manifests).length === 0) throw new Error("metadata.json has no platforms");

    const record: UpdateRecord = { id, createdAt, runtimeVersion: input.runtimeVersion, message: input.message, commit: input.commit, manifests };
    await writeFile(path.join(tmp, "update.json"), JSON.stringify(record));
    await mkdir(rvDir, { recursive: true });
    await rename(tmp, path.join(rvDir, id));
    return record;
  } catch (e) {
    await rm(tmp, { recursive: true, force: true });
    throw e;
  }
}

export async function listUpdates(runtimeVersion: string): Promise<UpdateRecord[]> {
  if (!SAFE.test(runtimeVersion)) return [];
  const rvDir = path.join(config.updatesDir, runtimeVersion);
  let ids: string[];
  try {
    ids = await readdir(rvDir);
  } catch {
    return [];
  }
  const out: UpdateRecord[] = [];
  for (const id of ids) {
    if (id.startsWith(".")) continue;
    try {
      out.push(JSON.parse(await readFile(path.join(rvDir, id, "update.json"), "utf8")));
    } catch {
      // incomplete dir; ignore
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// Builds the protocol response. Returns null for "nothing to do" (HTTP 204).
export async function manifestResponse(h: { platform: string; runtimeVersion: string; currentUpdateId?: string; accept: string }):
  Promise<null | { contentType: string; body: string; updateId: string }> {
  const latest = (await listUpdates(h.runtimeVersion)).find((u) => u.manifests[h.platform]);
  if (!latest || latest.id === h.currentUpdateId) return null;
  const manifest = JSON.stringify(latest.manifests[h.platform]);
  if (!h.accept.includes("multipart/mixed") && /application\/(expo\+)?json/.test(h.accept)) {
    return { contentType: "application/expo+json", body: manifest, updateId: latest.id };
  }
  const boundary = `mediahub-${randomUUID()}`;
  const body =
    `--${boundary}\r\n` +
    `content-disposition: form-data; name="manifest"\r\n` +
    `content-type: application/json; charset=utf-8\r\n\r\n` +
    `${manifest}\r\n` +
    `--${boundary}--\r\n`;
  return { contentType: `multipart/mixed; boundary=${boundary}`, body, updateId: latest.id };
}
