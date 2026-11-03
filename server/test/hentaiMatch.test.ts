// 里番 library matching: a series is known by its Japanese title and its (Simplified) Chinese name; titles from
// hanime (Japanese) and Hanime1 (often Traditional Chinese) both find it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "mh-hm-"));
const { hentaiLibrary } = await import("../src/catalog/emby.ts");
const { normTitle } = await import("../src/catalog/hanime.ts");

const series = [
  { Id: "s1", Name: "姐妹调教饲育者", OriginalTitle: "シスターブリーダー" },
  { Id: "s2", Name: "楓与铃", OriginalTitle: "らぶみー「楓と鈴」THE ANIMATION" },
  { Id: "s3", Name: "OVA", OriginalTitle: "" },                 // too short to match by name
];
const embyGet = async (p: string) => (p === "/Library/VirtualFolders" ? [{ Name: "里番", ItemId: "lib" }] : { Items: series });
const titles = (...t: string[]) => t.map(normTitle).join("|");

test("Traditional Chinese title (Hanime1) matches the Simplified library name", async () => {
  const match = await hentaiLibrary(embyGet as never).matcher();
  assert.equal(match(titles("姐妹調教飼育者 5 [中文字幕]")), "s1");
});

test("Japanese title (hanime / Hanime1 detail) still matches", async () => {
  const match = await hentaiLibrary(embyGet as never).matcher();
  assert.equal(match(titles("OVA シスターブリーダー ＃5")), "s1");
  assert.equal(match(titles("らぶみー「楓と鈴」 2")), "s2");
});

test("short names don't match unrelated titles; unknown works don't match", async () => {
  const match = await hentaiLibrary(embyGet as never).matcher();
  assert.equal(match(titles("OVA 某某某 1")), undefined);
  assert.equal(match(titles("完全不同的作品 1")), undefined);
});
