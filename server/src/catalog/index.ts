// Catalog and stream registries plus their /v1 routes. To add a source: write a CatalogProvider or
// StreamProvider (see types.ts) and list it here; the app reads /v1/catalog for what exists.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { embyCatalog, embyStreams, hentaiLibrary, type EmbyGet } from "./emby.ts";
import { hanime, titlesOf } from "./hanime.ts";
import { jable, jableStreams } from "./jable.ts";
import { javdb } from "./javdb.ts";
import type { CatalogDetail, CatalogItem, CatalogProvider, StreamProvider, StreamSource } from "./types.ts";

export function registerCatalog(app: FastifyInstance, embyGet: EmbyGet) {
  const catalogs: CatalogProvider[] = [javdb, jable, embyCatalog(embyGet), hanime];
  const hentaiLib = hentaiLibrary(embyGet);
  const streams: StreamProvider[] = [embyStreams(embyGet, hentaiLib), jableStreams];

  // Keep the web home rows warm: a cold Jable home is ~5 FlareSolverr page loads.
  const warm = () => { for (const c of [javdb, jable]) c.home().catch((e: Error) => app.log.warn({ p: c.id, err: e.message }, "catalog warm failed")); };
  setTimeout(warm, 5_000);
  setInterval(warm, 25 * 60_000).unref();

  // Mark 里番 index entries that are in the library (AV entries come from the library already).
  async function owned<T extends CatalogItem>(c: CatalogProvider, items: T[]): Promise<T[]> {
    if (c.id !== "hanime") return items;
    const match = await hentaiLib.matcher().catch(() => null);
    return match ? items.map((i) => ({ ...i, inLibrary: !!match(titlesOf(i.id)) })) : items;
  }

  const catalog = (id: string) => {
    const c = catalogs.find((x) => x.id === id);
    if (!c) throw Object.assign(new Error("没有这个索引源"), { statusCode: 404 });
    return c;
  };

  async function sources(c: CatalogProvider, d: CatalogDetail, slow: boolean): Promise<{ items: StreamSource[]; errors: string[] }> {
    const errors: string[] = [];
    const found = await Promise.all(streams.filter((s) => s.kinds.includes(c.kind) && !!s.slow === slow).map((s) =>
      s.find(d, c.kind).catch((e: Error) => {
        errors.push(`${s.name}：${e.message}`);
        return [] as StreamSource[];
      })));
    return { items: found.flat(), errors };
  }

  app.get("/v1/catalog", async () => ({
    providers: catalogs.map((c) => ({ id: c.id, name: c.name, kind: c.kind, note: c.note, sorts: c.sorts, personSorts: c.personSorts ?? c.sorts, personIndexSorts: c.personIndexSorts ?? [], tagFilter: c.tagFilter, people: !!c.persons })),
    streams: streams.map((s) => ({ id: s.id, name: s.name, kinds: s.kinds })),
  }));

  app.get<{ Params: { p: string } }>("/v1/catalog/:p/home", async (req) => {
    const c = catalog(req.params.p);
    return { rows: await Promise.all((await c.home()).map(async (r) => ({ ...r, items: await owned(c, r.items) }))) };
  });

  app.get<{ Params: { p: string } }>("/v1/catalog/:p/list", async (req) => {
    const c = catalog(req.params.p);
    const q = z.object({
      sort: z.string().max(20).default(c.sorts[0].id),
      tag: z.string().max(60).optional(),
      person: z.string().max(80).optional(),
      q: z.string().max(100).optional(),
      since: z.string().regex(/^\d{4}(-\d{2}-\d{2})?$/).optional(),
      page: z.coerce.number().int().min(1).max(500).default(1),
      size: z.coerce.number().int().min(1).max(60).default(30),
    }).parse(req.query);
    const page = await c.list(q);
    return { ...page, items: await owned(c, page.items) };
  });

  app.get<{ Params: { p: string } }>("/v1/catalog/:p/tags", async (req) => ({ tags: await catalog(req.params.p).tags() }));

  app.get<{ Params: { p: string } }>("/v1/catalog/:p/persons", async (req) => {
    const c = catalog(req.params.p);
    const q = z.object({ sort: z.string().max(20).default(c.personIndexSorts?.[0]?.id ?? "count"), page: z.coerce.number().int().min(1).max(500).default(1) }).parse(req.query);
    if (!c.persons) throw Object.assign(new Error("这个索引源没有人物索引"), { statusCode: 400 });
    const r = await c.persons(q.sort, q.page);
    return { ...r, persons: r.items };
  });

  app.get<{ Params: { p: string; id: string } }>("/v1/catalog/:p/item/:id", async (req) => {
    const c = catalog(req.params.p);
    const id = z.string().regex(/^[\w-]{1,60}$/).parse(req.params.id);
    const d = await c.item(id);
    if (!d) throw Object.assign(new Error("索引里没有这一部"), { statusCode: 404 });
    // Emby is not an "online source": a work already in the library gets its own play button.
    const lib = (await sources(c, d, false)).items.find((x) => x.provider === "emby");
    d.episodes = await owned(c, d.episodes);
    d.sourceName = d.sourceName ?? c.name;
    d.inLibrary = !!lib || d.inLibrary;
    return {
      item: d, kind: c.kind,
      library: lib ? { embyId: lib.embyId, folder: !!lib.embyFolder, note: lib.note } : null,
      streams: [] as StreamSource[], streamErrors: [] as string[],
      moreStreams: streams.some((x) => x.slow && x.kinds.includes(c.kind)),
    };
  });

  // Sources that need page fetches (Jable…), asked for separately so the detail shows at once.
  app.get<{ Params: { p: string; id: string } }>("/v1/catalog/:p/item/:id/streams", async (req) => {
    const c = catalog(req.params.p);
    const id = z.string().regex(/^[\w-]{1,60}$/).parse(req.params.id);
    const d = await c.item(id);
    if (!d) throw Object.assign(new Error("索引里没有这一部"), { statusCode: 404 });
    const s = await sources(c, d, true);
    return { streams: s.items, errors: s.errors };
  });

  app.get<{ Params: { s: string } }>("/v1/stream/:s/resolve", async (req) => {
    const s = streams.find((x) => x.id === req.params.s);
    if (!s?.resolve) throw Object.assign(new Error("这个播放源不需要解析"), { statusCode: 400 });
    const { ref } = z.object({ ref: z.string().min(1).max(500) }).parse(req.query);
    return s.resolve(ref);
  });
}
