// Renders the assistant's blocks. ```cards: refs whose card data the server sent (CardsBlock, below) —
// posters / round avatars / 16:9 videos as horizontal rows, tasks and subscriptions as list lines, in the
// order listed. ```media: a row of poster cards (tap → the work's page; long press → the
// usual 更多 sheet), each with its one-line reason; works already in the library carry 已入库, the others
// get 入库, and the row 全部入库 (one /v1/ingest/auto call for all of them, after a confirm). ```video:
// Bilibili / YouTube cards that open the site's app (or the page in the in-app browser). Cards appear as
// soon as each object in the block has streamed; the rest show shimmering placeholders.
import { useEffect, useState } from "react";
import { Animated, Easing, Linking, Pressable, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Img, PosterTile, type CardData } from "@/components/media";
import { openPage } from "@/lib/device";
import { confirm, tap, toast, toastError } from "@/components/ui";
import { api, img } from "@/lib/api";
import type { AiCard, CardMap } from "@/lib/ai";
import { logger } from "@/lib/log";
import type { CardLine, Segment } from "./blocks";
import { appRoute, goFromAi, openLink } from "./Markdown";
import { colors, fs, radius } from "./look";

const log = logger("ai-block");
const W = 118;
type Work = { type?: string; tmdbid?: number; title?: string; year?: string; poster?: string; why?: string; inLibrary?: boolean };

const posterUrl = (p?: string) => (p ? (/^https?:\/\//.test(p) ? p : `https://image.tmdb.org/t/p/w342/${p.replace(/^\/+/, "")}`) : undefined);
const valid = (w: Work) => !!w && (w.type === "movie" || w.type === "tv") && !!w.tmdbid;

/** The complete top-level objects of a JSON array that is still streaming ("[{…},{…},{"). */
function completeObjects(raw: string): Work[] {
  const out: Work[] = [];
  let depth = 0, start = -1, str = false, esc = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (str) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') str = false;
      continue;
    }
    if (ch === '"') str = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          out.push(JSON.parse(raw.slice(start, i + 1)));
        } catch {
          // a malformed object: skip it
        }
        start = -1;
      }
    }
  }
  return out;
}

function card(w: Work, i: number, added: boolean): CardData {
  const uri = posterUrl(w.poster);
  return {
    key: `${w.type}:${w.tmdbid}:${i}`,
    title: w.title || "未命名",
    subtitle: [w.year, w.type === "movie" ? "电影" : "剧集"].filter(Boolean).join(" · "),
    poster: uri ? { uri } : undefined,
    badge: w.inLibrary ? { text: "已入库", color: colors.success } : added ? { text: "已提交", color: colors.primary } : undefined,
    onPress: () => goFromAi({ pathname: "/media/[type]/[id]", params: { type: w.type!, id: String(w.tmdbid) } }),
  };
}

function Shimmer({ w = W, h = W * 1.5 }: { w?: number; h?: number }) {
  const [a] = useState(() => new Animated.Value(0));
  useEffect(() => {
    const l = Animated.loop(Animated.timing(a, { toValue: 1, duration: 1100, easing: Easing.inOut(Easing.quad), useNativeDriver: true }));
    l.start();
    return () => l.stop();
  }, [a]);
  const opacity = a.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.35, 0.8, 0.35] });
  return (
    <Animated.View style={{ width: w, opacity }}>
      <View style={{ width: w, height: h, borderRadius: radius.md, backgroundColor: colors.raised }} />
      <View style={{ width: w * 0.8, height: 11, borderRadius: 4, marginTop: 9, backgroundColor: colors.raised }} />
      <View style={{ width: w * 0.5, height: 9, borderRadius: 4, marginTop: 6, backgroundColor: colors.raised }} />
    </Animated.View>
  );
}

async function ingest(works: Work[]) {
  return api<{ ok: boolean; job?: string; error?: string }>("/v1/ingest/auto", { body: { items: works.map((w) => ({ tmdbid: w.tmdbid, type: w.type })) }, timeoutMs: 60_000 });
}

export function AiBlock({ seg, cards, live }: { seg: Extract<Segment, { k: "block" }>; cards?: CardMap; live?: boolean }) {
  if (seg.type === "cards") return <CardsBlock lines={(seg.data ?? []) as CardLine[]} cards={cards ?? {}} open={seg.open || !!live} />;
  return seg.type === "video" ? <VideoBlock seg={seg} /> : <MediaBlock seg={seg} />;
}

// ---------- ```cards ----------

// a function: theme colours change after this module loads
const tone = (t: NonNullable<AiCard["badge"]>["tone"]) => ({ success: colors.success, primary: colors.primary, live: "rgba(239,68,68,0.95)", warn: colors.warn, bilibili: "rgba(251,114,153,0.92)", youtube: "rgba(230,33,23,0.92)" })[t] ?? colors.primary;
const AV = 76;

/** In-app path → its page; a web link → the site's app (URL scheme) when installed, else the in-app browser. */
async function openCard(c: AiCard) {
  if (!c.link) return;
  if (appRoute(c.link) || !c.app) return openLink(c.link);
  tap();
  try {
    await Linking.openURL(c.app);
  } catch {
    void openPage(c.link);
  }
}

function Badge({ b, float }: { b: NonNullable<AiCard["badge"]>; float?: boolean }) {
  return (
    <View style={{ ...(float ? { position: "absolute", left: 6, top: 6 } : {}), alignSelf: "flex-start", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, backgroundColor: tone(b.tone) }}>
      <Text style={{ fontSize: 10, fontWeight: "700", color: "#fff" }}>{b.text}</Text>
    </View>
  );
}

function Note({ text, w }: { text?: string; w: number }) {
  return text ? <Text numberOfLines={3} style={{ width: w, fontSize: fs.xs, lineHeight: 16, color: colors.textSoft, marginTop: 2 }}>{text}</Text> : null;
}

type Item = { ref: string; note?: string; card: AiCard };

function CardsBlock({ lines, cards, open }: { lines: CardLine[]; cards: CardMap; open: boolean }) {
  const [added, setAdded] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const items: Item[] = lines.flatMap((l) => (cards[l.ref] ? [{ ...l, card: cards[l.ref]! }] : []));
  const waiting = lines.filter((l) => !(l.ref in cards)).length;
  if (!items.length && !(open && (waiting || !lines.length))) return null;

  // consecutive cards of one shape share a row (posters and avatars side by side would look ragged)
  const runs: Item[][] = [];
  for (const it of items) {
    const prev = runs[runs.length - 1];
    if (prev && prev[0].card.shape === it.card.shape) prev.push(it);
    else runs.push([it]);
  }
  const canAdd = (it: Item) => !!it.card.ingest && !added.has(it.ref);
  const missing = items.filter(canAdd);
  const run = async (list: Item[], key: string) => {
    setBusy(key);
    try {
      const r = await api<{ ok: boolean; error?: string }>("/v1/ingest/auto", { body: { items: list.map((i) => i.card.ingest) }, timeoutMs: 60_000 });
      if (r.ok === false) throw new Error(r.error || "提交失败");
      setAdded((s) => new Set([...s, ...list.map((i) => i.ref)]));
      toast(list.length > 1 ? `已提交 ${list.length} 部` : "已提交入库", "进度在 任务 里看");
    } catch (e) {
      log.warn("ingest failed", e);
      toastError("未能提交入库", e);
    } finally {
      setBusy(null);
    }
  };
  const submit = (list: Item[], key: string) => {
    tap();
    const names = list.map((i) => `《${i.card.title}》`).join("");
    confirm(list.length > 1 ? `入库这 ${list.length} 部？` : `入库${names}？`, list.length > 1 ? `${names}\n系统按选片策略自动挑资源，进度在 任务 里看` : "系统按选片策略自动挑资源，进度在 任务 里看", "入库", () => void run(list, key));
  };

  const tile = (it: Item, i: number) => {
    const c = it.card;
    const src = img(c.image);
    if (c.shape === "poster") {
      const d: CardData = {
        key: `${it.ref}:${i}`, title: c.title, subtitle: c.sub, poster: src, embyId: c.embyId, onPress: () => void openCard(c),
        badge: added.has(it.ref) ? { text: "已提交", color: colors.primary } : c.badge ? { text: c.badge.text, color: tone(c.badge.tone) } : undefined,
      };
      return (
        <View key={d.key} style={{ width: W }}>
          <PosterTile c={d} w={W} />
          <Note text={it.note} w={W} />
          {canAdd(it) ? (
            <Pressable disabled={!!busy} onPress={() => submit([it], it.ref)} style={({ pressed }) => ({ marginTop: 6, alignSelf: "flex-start", paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.primary, opacity: pressed || busy ? 0.6 : 1 })}>
              <Text style={{ fontSize: fs.xs, color: colors.primary, fontWeight: "600" }}>{busy === it.ref ? "提交中…" : "入库"}</Text>
            </Pressable>
          ) : null}
        </View>
      );
    }
    if (c.shape === "avatar") {
      return (
        <Pressable key={`${it.ref}:${i}`} onPress={() => void openCard(c)} style={({ pressed }) => ({ width: AV + 12, alignItems: "center", opacity: pressed ? 0.85 : 1 })}>
          <Img label={c.title} where="ai-card" source={src} style={{ width: AV, height: AV, borderRadius: AV / 2 }} icon="person-outline" />
          <Text numberOfLines={1} style={{ fontSize: fs.md, fontWeight: "700", color: colors.text, marginTop: 7, textAlign: "center" }}>{c.title}</Text>
          {c.sub ? <Text numberOfLines={2} style={{ fontSize: fs.xs, color: colors.textFaint, marginTop: 1, textAlign: "center" }}>{c.sub}</Text> : null}
          <Note text={it.note} w={AV + 12} />
        </Pressable>
      );
    }
    // wide
    return (
      <Pressable key={`${it.ref}:${i}`} onPress={() => void openCard(c)} style={({ pressed }) => ({ width: VW, opacity: pressed ? 0.85 : 1 })}>
        <View style={{ borderRadius: radius.md, overflow: "hidden", backgroundColor: colors.raised }}>
          <Img label={c.title} where="ai-card" source={src} style={{ width: VW, height: VW * 0.5625 }} icon="play-circle-outline" />
          {c.badge ? <Badge b={c.badge} float /> : null}
        </View>
        <Text numberOfLines={2} style={{ fontSize: fs.md, lineHeight: 18, fontWeight: "600", color: colors.text, marginTop: 7 }}>{c.title}</Text>
        {c.sub ? <Text numberOfLines={1} style={{ fontSize: fs.xs, color: colors.textFaint, marginTop: 2 }}>{c.sub}</Text> : null}
        <Note text={it.note} w={VW} />
      </Pressable>
    );
  };

  const row = (it: Item, i: number) => {
    const c = it.card;
    const src = img(c.image);
    return (
      <Pressable key={`${it.ref}:${i}`} onPress={() => void openCard(c)} style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, paddingHorizontal: 10, borderRadius: radius.md, backgroundColor: pressed ? colors.cardMuted : colors.raised })}>
        {src ? <Img label={c.title} where="ai-card" source={src} style={{ width: 34, height: 51, borderRadius: 4 }} /> : <Ionicons name="layers-outline" size={18} color={colors.textSoft} />}
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={{ fontSize: fs.md, fontWeight: "600", color: colors.text }}>{c.title}</Text>
          {c.sub || it.note ? <Text numberOfLines={2} style={{ fontSize: fs.xs, color: colors.textFaint, marginTop: 2 }}>{[c.sub, it.note].filter(Boolean).join(" · ")}</Text> : null}
        </View>
        {c.badge ? <Badge b={c.badge} /> : null}
        <Ionicons name="chevron-forward" size={14} color={colors.textFaint} />
      </Pressable>
    );
  };

  const last = runs[runs.length - 1]?.[0].card.shape;
  return (
    <View style={{ marginVertical: 8, gap: 12 }}>
      {runs.map((r, ri) =>
        r[0].card.shape === "row" ? (
          <View key={ri} style={{ gap: 6 }}>{r.map(row)}</View>
        ) : (
          <ScrollView key={ri} horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16 }} contentContainerStyle={{ paddingHorizontal: 16, gap: 12 }}>
            {r.map(tile)}
            {open && waiting && ri === runs.length - 1 ? <Shimmer w={last === "wide" ? VW : W} h={last === "wide" ? VW * 0.5625 : W * 1.5} /> : null}
          </ScrollView>
        ),
      )}
      {open && waiting && (!runs.length || last === "row") ? <View style={{ flexDirection: "row", gap: 12 }}><Shimmer /></View> : null}
      {!open && missing.length > 1 ? (
        <Pressable disabled={!!busy} onPress={() => submit(missing, "all")} style={({ pressed }) => ({ alignSelf: "flex-start", paddingHorizontal: 14, paddingVertical: 7, borderRadius: radius.pill, backgroundColor: colors.primary, opacity: pressed || busy ? 0.7 : 1 })}>
          <Text style={{ fontSize: fs.sm, color: colors.onPrimary, fontWeight: "700" }}>{busy === "all" ? "提交中…" : `全部入库（${missing.length} 部）`}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// ---------- ```video ----------

type Vid = { site?: string; id?: string; title?: string; author?: string; duration?: string; views?: number; cover?: string; published?: string; live?: boolean; online?: number; area?: string };
const VW = 220;
// videos: BV id / YouTube id; live: the Bilibili room number, or the YouTube video id of the stream
const bLive = (v: Vid) => !!v.live && v.site === "bilibili";
const okVid = (v: Vid) => !!v && (v.site === "bilibili" || v.site === "youtube") && !!v.id && (bLive(v) ? /^\d{1,12}$/.test(String(v.id)) : /^[\w-]{6,20}$/.test(String(v.id)));
const coverOf = (v: Vid) => (v.site === "youtube" ? `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg` : v.cover ? (/^https?:\/\//.test(v.cover) ? v.cover : `https://${v.cover.replace(/^\/+/, "")}`) : undefined);
const count = (n?: number) => (n == null ? "" : n >= 1e8 ? `${(n / 1e8).toFixed(1)}亿` : n >= 1e4 ? `${(n / 1e4).toFixed(1)}万` : String(n));

/** The site's app when installed (its URL scheme), else the page in the in-app browser. */
async function openVideo(v: Vid) {
  tap();
  const web = bLive(v) ? `https://live.bilibili.com/${v.id}` : v.site === "bilibili" ? `https://www.bilibili.com/video/${v.id}` : `https://www.youtube.com/watch?v=${v.id}`;
  const app = bLive(v) ? `bilibili://live/${v.id}` : v.site === "bilibili" ? `bilibili://video/${v.id}` : `youtube://www.youtube.com/watch?v=${v.id}`;
  try {
    await Linking.openURL(app);
  } catch {
    void openPage(web);
  }
}

function VideoBlock({ seg }: { seg: Extract<Segment, { k: "block" }> }) {
  const list = (seg.open ? (completeObjects(seg.raw) as Vid[]) : Array.isArray(seg.data) ? (seg.data as Vid[]) : []).filter(okVid);
  if (!seg.open && (seg.error || !list.length)) return <Text selectable style={{ fontSize: fs.sm, color: colors.textFaint, marginVertical: 6 }}>{seg.raw}</Text>;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginVertical: 8, marginHorizontal: -16 }} contentContainerStyle={{ paddingHorizontal: 16, gap: 12 }}>
      {list.map((v, i) => {
        const uri = coverOf(v);
        return (
          <Pressable key={`${v.site}:${v.id}:${i}`} onPress={() => void openVideo(v)} style={({ pressed }) => ({ width: VW, opacity: pressed ? 0.85 : 1 })}>
            <View style={{ borderRadius: radius.md, overflow: "hidden", backgroundColor: colors.raised }}>
              <Img label={v.title} where="ai-video" source={uri ? { uri } : undefined} style={{ width: VW, height: VW * 0.5625 }} icon="play-circle-outline" />
              <View style={{ position: "absolute", left: 8, top: 8, flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, backgroundColor: v.live ? "rgba(239,68,68,0.95)" : v.site === "bilibili" ? "rgba(251,114,153,0.92)" : "rgba(230,33,23,0.92)" }}>
                <Ionicons name={v.live ? "radio-outline" : v.site === "bilibili" ? "tv-outline" : "logo-youtube"} size={11} color="#fff" />
                <Text style={{ fontSize: 10, fontWeight: "700", color: "#fff" }}>{v.live ? "直播中" : v.site === "bilibili" ? "B站" : "YouTube"}</Text>
              </View>
              {v.duration ? (
                <View style={{ position: "absolute", right: 8, bottom: 8, paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, backgroundColor: "rgba(0,0,0,0.7)" }}>
                  <Text style={{ fontSize: 11, color: "#fff", fontVariant: ["tabular-nums"] }}>{v.duration}</Text>
                </View>
              ) : null}
            </View>
            <Text numberOfLines={2} style={{ fontSize: fs.md, lineHeight: 18, fontWeight: "600", color: colors.text, marginTop: 7 }}>{v.title}</Text>
            <Text numberOfLines={1} style={{ fontSize: fs.xs, color: colors.textFaint, marginTop: 2 }}>{(v.live ? [v.author, v.online != null ? `人气 ${count(v.online)}` : "", v.area] : [v.author, v.views != null ? `${count(v.views)}播放` : "", v.published]).filter(Boolean).join(" · ")}</Text>
          </Pressable>
        );
      })}
      {seg.open ? <View style={{ width: VW, height: VW * 0.5625 + 44 }}><Shimmer w={VW} h={VW * 0.5625} /></View> : null}
    </ScrollView>
  );
}

// ---------- ```media ----------

function MediaBlock({ seg }: { seg: Extract<Segment, { k: "block" }> }) {
  const [added, setAdded] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const list = (seg.open ? completeObjects(seg.raw) : Array.isArray(seg.data) ? (seg.data as Work[]) : []).filter(valid);
  if (!seg.open && (seg.error || !list.length)) return <Text selectable style={{ fontSize: fs.sm, color: colors.textFaint, marginVertical: 6 }}>{seg.raw}</Text>;

  const id = (w: Work) => `${w.type}:${w.tmdbid}`;
  const missing = list.filter((w) => !w.inLibrary && !added.has(id(w)));
  const run = async (works: Work[], key: string) => {
    setBusy(key);
    try {
      const r = await ingest(works);
      if (r.ok === false) throw new Error(r.error || "提交失败");
      setAdded((s) => new Set([...s, ...works.map(id)]));
      toast(works.length > 1 ? `已提交 ${works.length} 部` : "已提交入库", "进度在 任务 里看");
    } catch (e) {
      log.warn("ingest failed", e);
      toastError("未能提交入库", e);
    } finally {
      setBusy(null);
    }
  };
  const submit = (works: Work[], key: string) => {
    tap();
    const names = works.map((w) => `《${w.title}》`).join("");
    confirm(works.length > 1 ? `入库这 ${works.length} 部？` : `入库${names}？`, works.length > 1 ? `${names}\n系统按选片策略自动挑资源，进度在 任务 里看` : "系统按选片策略自动挑资源，进度在 任务 里看", "入库", () => void run(works, key));
  };

  return (
    <View style={{ marginVertical: 8 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16 }} contentContainerStyle={{ paddingHorizontal: 16, gap: 12 }}>
        {list.map((w, i) => {
          const c = card(w, i, added.has(id(w)));
          const canAdd = !w.inLibrary && !added.has(id(w)) && !seg.open;
          return (
            <View key={c.key} style={{ width: W }}>
              <PosterTile c={c} w={W} />
              {w.why ? <Text numberOfLines={3} style={{ fontSize: fs.xs, lineHeight: 16, color: colors.textSoft, marginTop: 2 }}>{w.why}</Text> : null}
              {canAdd ? (
                <Pressable disabled={!!busy} onPress={() => submit([w], c.key)} style={({ pressed }) => ({ marginTop: 6, alignSelf: "flex-start", paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.primary, opacity: pressed || busy ? 0.6 : 1 })}>
                  <Text style={{ fontSize: fs.xs, color: colors.primary, fontWeight: "600" }}>{busy === c.key ? "提交中…" : "入库"}</Text>
                </Pressable>
              ) : null}
            </View>
          );
        })}
        {seg.open ? <Shimmer /> : null}
        {seg.open && !list.length ? <Shimmer /> : null}
      </ScrollView>
      {!seg.open && missing.length > 1 ? (
        <Pressable disabled={!!busy} onPress={() => submit(missing, "all")} style={({ pressed }) => ({ marginTop: 10, alignSelf: "flex-start", paddingHorizontal: 14, paddingVertical: 7, borderRadius: radius.pill, backgroundColor: colors.primary, opacity: pressed || busy ? 0.7 : 1 })}>
          <Text style={{ fontSize: fs.sm, color: colors.onPrimary, fontWeight: "700" }}>{busy === "all" ? "提交中…" : `全部入库（${missing.length} 部）`}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
