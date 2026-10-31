// A person on TMDb (from a 发现 work page or a name search): photo, facts, biography, and every work they
// acted in or made, as a timeline grouped by year (newest first) with their role. Filters: movie / series,
// acting / behind the camera, only what is in the library, appearances as themself; or sort by rating.
import { type ComponentRef, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { Img, LayoutToggle, MiniTag, Posters, type CardData } from "@/components/media";
import { mediaCard, useOpenMedia } from "@/components/mediaCards";
import { Chip, ChipRow, EmptyState, ErrorBox, Loading, Pull, Screen, Segmented, TopBar, styles, tap } from "@/components/ui";
import { api, img, type PersonWork, type TmdbPerson } from "@/lib/api";
import { openPeek } from "@/lib/peek";
import { useQuery } from "@/lib/query";
import { colors, radius } from "@/lib/theme";

type Kind = "all" | "movie" | "tv";
type Side = "all" | "acting" | "crew";
type Sort = "time" | "rating";

const DEPT: Record<string, string> = { Acting: "演员", Directing: "导演", Writing: "编剧", Production: "制片", Sound: "音乐", Camera: "摄影", Editing: "剪辑", Art: "美术", Creator: "主创", "Visual Effects": "视效", Crew: "幕后" };
const JOB: Record<string, string> = {
  Director: "导演", Writer: "编剧", Screenplay: "编剧", Story: "故事", Novel: "原著", Characters: "角色原案", Author: "原著", Creator: "主创",
  Producer: "制片", "Executive Producer": "监制", "Co-Producer": "联合制片", "Original Music Composer": "作曲", Music: "音乐",
  "Director of Photography": "摄影", Editor: "剪辑", "Original Concept": "原案", "Series Composition": "系列构成", "Animation Director": "作画监督",
  "Character Designer": "角色设计", "Theme Song Performance": "主题曲", Thanks: "鸣谢",
};

function age(born: string, died: string) {
  if (!born) return "";
  const b = new Date(born);
  const e = died ? new Date(died) : new Date();
  let y = e.getFullYear() - b.getFullYear();
  if (e.getMonth() < b.getMonth() || (e.getMonth() === b.getMonth() && e.getDate() < b.getDate())) y -= 1;
  return died ? `享年 ${y} 岁` : `${y} 岁`;
}

function roleLine(w: PersonWork) {
  const parts = w.roles.map((r) => JOB[r] ?? r.replace(/\s*\(voice\)\s*$/i, "（配音）"));
  const line = [...new Set(parts)].slice(0, 3).join(" / ");
  return [line, w.type === "tv" && w.episodes > 1 ? `${w.episodes} 集` : ""].filter(Boolean).join(" · ");
}

export default function TmdbPersonScreen() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const open = useOpenMedia();
  const q = useQuery(`tmdb:person:${id}`, () => api<TmdbPerson>(`/v1/tmdb/person/${id}`, { timeoutMs: 45_000 }), { staleMs: 60 * 60_000 });
  const [kind, setKind] = useState<Kind>("all");
  const [side, setSide] = useState<Side>("all");
  const [sort, setSort] = useState<Sort>("time");
  const [inLib, setInLib] = useState(false);
  const [minor, setMinor] = useState(false);
  const [more, setMore] = useState(false);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const yearY = useRef<Record<string, number>>({});
  const listY = useRef(0);
  const p = q.data;

  const all = useMemo(() => p?.works ?? [], [p]);
  const acting = all.some((w) => w.dept.includes("Acting"));
  const crew = all.some((w) => w.dept.some((d) => d !== "Acting"));
  const works = useMemo(() => {
    const list = all.filter((w) =>
      (kind === "all" || w.type === kind)
      && (side === "all" || (side === "acting" ? w.dept.includes("Acting") : w.dept.some((d) => d !== "Acting")))
      && (!inLib || !!w.library)
      && (minor || !w.minor));
    return sort === "rating" ? [...list].sort((a, b) => (b.votes >= 50 ? b.vote : 0) - (a.votes >= 50 ? a.vote : 0)) : list;
  }, [all, kind, side, inLib, minor, sort]);
  const years = useMemo(() => {
    const g: { year: string; items: PersonWork[] }[] = [];
    for (const w of works) {
      const y = w.year || "待定";
      if (g[g.length - 1]?.year !== y) g.push({ year: y, items: [] });
      g[g.length - 1].items.push(w);
    }
    return g;
  }, [works]);
  const decades = [...new Set(years.map((y) => (/^\d{4}$/.test(y.year) ? `${y.year.slice(0, 3)}0` : "")).filter(Boolean))];
  const jump = (d: string) => {
    tap();
    const first = years.find((y) => y.year.startsWith(d.slice(0, 3)));
    const y = first ? yearY.current[first.year] : undefined;
    if (y !== undefined) scroll.current?.scrollTo({ y: listY.current + y - 8, animated: true });
  };
  const card = (w: PersonWork): CardData => ({ ...mediaCard(w, () => void open(w)), subtitle: [w.year, w.type === "movie" ? "电影" : "剧集", roleLine(w)].filter(Boolean).join(" · ") });

  const facts = p ? [p.birthday ? `${p.birthday} 出生` : "", p.deathday ? `${p.deathday} 去世` : "", age(p.birthday, p.deathday), p.place].filter(Boolean) : [];
  const libCount = all.filter((w) => w.library).length;

  return (
    <Screen>
      <TopBar title={p?.name ?? name ?? "人物"} right={sort === "rating" ? <LayoutToggle /> : undefined} />
      <ScrollView ref={scroll} contentContainerStyle={{ paddingBottom: 60 }} refreshControl={<Pull onRefresh={q.refresh} />}>
        {q.error ? <ErrorBox text={q.error} onRetry={q.refresh} /> : null}
        {!p && q.loading ? <Loading text="正在读取 TMDb" /> : null}
        {p ? (
          <>
            <View style={{ flexDirection: "row", gap: 16, paddingHorizontal: 16, paddingTop: 4 }}>
              <View style={{ width: 110, height: 150, borderRadius: 14, overflow: "hidden", borderWidth: 1, borderColor: colors.border }}>
                <Img source={img(p.photo)} style={{ width: 110, height: 150 }} icon="person-outline" iconSize={40} />
              </View>
              <View style={{ flex: 1, justifyContent: "center" }}>
                <Text selectable style={{ fontSize: 22, fontWeight: "800", color: colors.text }}>{p.name}</Text>
                {p.aka.find((a) => /^[\x20-\x7E]+$/.test(a) && a !== p.name) ? <Text style={[styles.faint, { marginTop: 2 }]} numberOfLines={1}>{p.aka.find((a) => /^[\x20-\x7E]+$/.test(a) && a !== p.name)}</Text> : null}
                {p.dept ? <Text style={[styles.faint, { marginTop: 4, fontSize: 13 }]}>{DEPT[p.dept] ?? p.dept}</Text> : null}
                {facts.map((f) => <Text key={f} style={[styles.faint, { marginTop: 3, fontSize: 13 }]}>{f}</Text>)}
                <Text style={[styles.faint, { marginTop: 3, fontSize: 13 }]}>{all.filter((w) => !w.minor).length} 部作品{libCount ? ` · 库中 ${libCount} 部` : ""}</Text>
              </View>
            </View>
            <View style={{ paddingHorizontal: 16 }}>
              {p.bio ? (
                <Pressable onPress={() => { tap(); setMore((x) => !x); }}>
                  <Text selectable style={[styles.body, { marginTop: 14 }]} numberOfLines={more ? undefined : 4}>{p.bio}</Text>
                  <Text style={{ color: colors.primary, fontSize: 13, marginTop: 4 }}>{more ? "收起" : "展开"}</Text>
                </Pressable>
              ) : null}
              <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
                <Chip icon="open-outline" label="TMDb" onPress={() => void WebBrowser.openBrowserAsync(`https://www.themoviedb.org/person/${p.id}`)} />
                {p.imdb ? <Chip icon="open-outline" label="IMDb" onPress={() => void WebBrowser.openBrowserAsync(`https://www.imdb.com/name/${p.imdb}/`)} /> : null}
              </View>
              <Segmented value={kind} onChange={setKind} options={[{ value: "all", label: "全部" }, { value: "movie", label: "电影" }, { value: "tv", label: "剧集" }]} style={{ marginTop: 18 }} />
            </View>
            <ChipRow style={{ marginTop: 10 }}>
              <Chip label="时间线" active={sort === "time"} onPress={() => setSort("time")} />
              <Chip label="按评分" active={sort === "rating"} onPress={() => setSort("rating")} />
              {acting && crew ? (
                <>
                  <Chip label="表演" active={side === "acting"} onPress={() => setSide(side === "acting" ? "all" : "acting")} />
                  <Chip label="幕后" active={side === "crew"} onPress={() => setSide(side === "crew" ? "all" : "crew")} />
                </>
              ) : null}
              {libCount ? <Chip label="仅库中" icon="checkmark-circle-outline" active={inLib} onPress={() => setInLib(!inLib)} /> : null}
              <Chip label="含本人出镜" active={minor} onPress={() => setMinor(!minor)} />
            </ChipRow>
            {sort === "time" && decades.length > 2 ? (
              <ChipRow style={{ marginTop: 6 }}>
                {decades.map((d) => <Chip key={d} label={`${d}s`} onPress={() => jump(d)} />)}
              </ChipRow>
            ) : null}
            {!works.length ? <EmptyState icon="film-outline" text={inLib ? "库里没有这个分类的作品" : "没有这个分类的作品"} /> : null}
            {sort === "rating" ? (
              <View style={{ marginTop: 12 }}><Posters items={works.map(card)} /></View>
            ) : (
              <View style={{ marginTop: 12, paddingHorizontal: 16 }} onLayout={(e) => { listY.current = e.nativeEvent.layout.y; }}>
                {years.map((g, gi) => (
                  <View key={g.year} onLayout={(e) => { yearY.current[g.year] = e.nativeEvent.layout.y; }} style={{ flexDirection: "row" }}>
                    <View style={{ width: 54, alignItems: "flex-start" }}>
                      <Text style={{ fontSize: 15, fontWeight: "800", color: g.year === "待定" ? colors.textFaint : colors.text, marginTop: 2 }}>{g.year}</Text>
                    </View>
                    <View style={{ width: 14, alignItems: "center" }}>
                      <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: colors.primary, marginTop: 7 }} />
                      {gi < years.length - 1 ? <View style={{ flex: 1, width: 2, backgroundColor: colors.border, marginTop: 2 }} /> : null}
                    </View>
                    <View style={{ flex: 1, paddingLeft: 10, paddingBottom: 18, gap: 10 }}>
                      {g.items.map((w) => <TimelineRow key={`${w.type}:${w.tmdbid}`} w={w} c={card(w)} />)}
                    </View>
                  </View>
                ))}
              </View>
            )}
          </>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

function TimelineRow({ w, c }: { w: PersonWork; c: CardData }) {
  return (
    <Pressable
      onPress={() => { tap(); c.onPress(); }}
      onLongPress={() => { tap(); openPeek(c); }}
      delayLongPress={350}
      style={({ pressed }) => ({ flexDirection: "row", gap: 10, padding: 8, borderRadius: radius.md, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, opacity: pressed ? 0.85 : 1 })}
    >
      <View style={{ borderRadius: 6, overflow: "hidden" }}>
        <Img source={c.poster} style={{ width: 50, height: 75 }} iconSize={18} />
      </View>
      <View style={{ flex: 1, justifyContent: "center", gap: 3 }}>
        <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text }} numberOfLines={2}>{w.title}</Text>
        {roleLine(w) ? <Text style={styles.faint} numberOfLines={1}>{roleLine(w)}</Text> : null}
        <View style={{ flexDirection: "row", gap: 5, alignItems: "center", flexWrap: "wrap" }}>
          <MiniTag text={w.type === "movie" ? "电影" : "剧集"} />
          {w.vote && w.votes >= 20 ? <MiniTag text={`★ ${w.vote.toFixed(1)}`} color={colors.warning} /> : null}
          {w.library ? <MiniTag text={`已入库 · ${w.library.lib}`} color={colors.success} /> : null}
          {!w.year ? <MiniTag text="未上映" color={colors.textFaint} /> : null}
        </View>
      </View>
    </Pressable>
  );
}
