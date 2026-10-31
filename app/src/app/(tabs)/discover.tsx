import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { CatalogHome } from "@/components/CatalogHome";
import { mediaCard, useOpenMedia, type DiscoverItem } from "@/components/mediaCards";
import { Img, LayoutToggle, PosterTile, Posters, Row } from "@/components/media";
import { useBrowse, type BrowseFilter } from "@/components/tmdbDetail";
import { Chip, ChipRow, EmptyState, ErrorBox, Loading, Segmented, TAB_BAR_SPACE, TabHeader, tap, Pull, styles } from "@/components/ui";
import { api, img, type MediaBrief, type PersonHit } from "@/lib/api";
import { PROVIDER_FOR } from "@/lib/catalog";
import { useQuery } from "@/lib/query";
import { has, listenOnce } from "@/lib/device";
import { useSettings } from "@/lib/settings";
import { colors, radius } from "@/lib/theme";
import { track } from "@/lib/track";

// 发现 has two indexes as tabs — TMDb (trending, popular, top rated, browse by genre / network) and Douban
// (Top250, weekly 口碑榜, hot lists) — plus the adult indexes when enabled. The search box searches TMDb
// works and people in both index tabs (Douban entries resolve to TMDb when opened).
type Mode = "tmdb" | "douban" | "av" | "hentai";
interface SectionInfo { id: string; title: string; group: "tmdb" | "douban"; ranked: boolean }

// Shortcuts into /discover/browse (TMDb genre ids differ between movies and series; network ids are TMDb's).
const BROWSE: { label: string; type: "movie" | "tv"; filter: BrowseFilter; id: number }[] = [
  { label: "动画剧集", type: "tv", filter: "with_genres", id: 16 },
  { label: "动画电影", type: "movie", filter: "with_genres", id: 16 },
  { label: "科幻电影", type: "movie", filter: "with_genres", id: 878 },
  { label: "科幻奇幻剧", type: "tv", filter: "with_genres", id: 10765 },
  { label: "悬疑剧", type: "tv", filter: "with_genres", id: 9648 },
  { label: "犯罪剧", type: "tv", filter: "with_genres", id: 80 },
  { label: "惊悚片", type: "movie", filter: "with_genres", id: 53 },
  { label: "喜剧片", type: "movie", filter: "with_genres", id: 35 },
  { label: "爱情片", type: "movie", filter: "with_genres", id: 10749 },
  { label: "恐怖片", type: "movie", filter: "with_genres", id: 27 },
  { label: "纪录片", type: "movie", filter: "with_genres", id: 99 },
  { label: "战争片", type: "movie", filter: "with_genres", id: 10752 },
];
const NETWORKS: { label: string; id: number }[] = [
  { label: "Netflix", id: 213 }, { label: "HBO", id: 49 }, { label: "Apple TV+", id: 2552 }, { label: "Disney+", id: 2739 },
  { label: "Prime Video", id: 1024 }, { label: "BBC One", id: 4 }, { label: "富士电视台", id: 1 }, { label: "东京电视台", id: 98 },
];

export default function DiscoverTab() {
  const router = useRouter();
  const showAdult = useSettings((s) => s.showAdult);
  const [mode, setMode] = useState<Mode>("tmdb");
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [listening, setListening] = useState(false);
  const open = useOpenMedia();
  const index = mode === "tmdb" || mode === "douban";
  const results = useQuery(q ? `search:${q}` : null, () => api<{ items: MediaBrief[]; people?: PersonHit[] }>(`/v1/media/search?q=${encodeURIComponent(q)}`), { staleMs: 10 * 60_000 });
  const sections = useQuery("discover:sections", () => api<{ sections: SectionInfo[] }>("/v1/discover"), { staleMs: 24 * 3600_000 });

  const submit = () => {
    const v = text.trim();
    if (!v) return;
    track("search", { mode });
    if (!index) {
      searchAdult(v);
      return;
    }
    setQ(v);
  };
  // AV (JavDB) and 里番 (hanime) searches open the index; its list links on to resource search.
  const searchAdult = (v: string) => {
    const kind = mode === "hentai" ? "hentai" : "av";
    router.push({ pathname: "/catalog/[p]", params: { p: PROVIDER_FOR[kind], q: v, title: `${kind === "av" ? "AV" : "里番"} · ${v}` } });
  };
  const modes = [{ value: "tmdb" as Mode, label: "TMDb" }, { value: "douban" as Mode, label: "豆瓣" }, ...(showAdult ? [{ value: "av" as Mode, label: "AV" }, { value: "hentai" as Mode, label: "里番" }] : [])];

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <TabHeader title="发现" right={q ? <LayoutToggle /> : undefined} />
      <Segmented value={mode} options={modes} onChange={(m) => { setMode(m); if (!(m === "tmdb" || m === "douban")) setQ(""); }} style={{ marginHorizontal: 16, marginBottom: 10 }} />
      <View style={{ marginHorizontal: 16, flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, height: 46 }}>
        <Ionicons name="search" size={18} color={colors.textFaint} />
        <TextInput
          value={text}
          onChangeText={(v) => { setText(v); if (!v) setQ(""); }}
          onSubmitEditing={submit}
          returnKeyType="search"
          autoCorrect={false}
          autoCapitalize="none"
          clearButtonMode="while-editing"
          placeholder={index ? "搜电影、剧集、番剧、演员" : mode === "av" ? "番号或女优，如 SSIS-001" : "搜索引：罗马音、英文或日文名"}
          placeholderTextColor={colors.textFaint}
          style={{ flex: 1, fontSize: 16, color: colors.text }}
        />
        {has("speech") ? (
          <Pressable
            hitSlop={10}
            accessibilityLabel="语音搜索"
            onPress={async () => {
              tap();
              setListening(true);
              const said = await listenOnce();
              setListening(false);
              if (said) {
                setText(said);
                track("search_voice", { mode });
                if (index) setQ(said);
                else searchAdult(said);
              }
            }}
          >
            <Ionicons name={listening ? "mic" : "mic-outline"} size={20} color={listening ? colors.primary : colors.textFaint} />
          </Pressable>
        ) : null}
      </View>
      {index && q ? (
        <ScrollView contentContainerStyle={{ paddingTop: 12, paddingBottom: TAB_BAR_SPACE }} refreshControl={<Pull onRefresh={results.refresh} />}>
          {results.error ? <ErrorBox text={results.error} onRetry={results.refresh} /> : null}
          {results.loading && !results.data ? <Loading text="正在查询 TMDb" /> : null}
          <Pressable onPress={() => { tap(); router.push({ pathname: "/resources", params: { mode: "raw", keyword: q } }); }} style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 16, paddingBottom: 12 }}>
            <Ionicons name="flash-outline" size={15} color={colors.primary} />
            <Text style={{ color: colors.primary, fontSize: 14, fontWeight: "600" }}>不识别作品，直接按关键词搜资源</Text>
          </Pressable>
          {results.data?.people?.length ? <PeopleHits people={results.data.people} /> : null}
          {results.data && !results.data.items.length && !results.data.people?.length ? <EmptyState icon="search-outline" text="TMDb 没有找到这个名字，换个写法试试" /> : null}
          <Posters items={(results.data?.items ?? []).map((m) => mediaCard(m, () => void open(m)))} />
        </ScrollView>
      ) : mode === "av" || mode === "hentai" ? (
        <CatalogHome key={mode} kind={mode} />
      ) : (
        <ScrollView key={mode} contentContainerStyle={{ paddingBottom: TAB_BAR_SPACE }} refreshControl={<Pull onRefresh={sections.refresh} />}>
          {sections.error ? <ErrorBox text={sections.error} onRetry={sections.refresh} /> : null}
          {!sections.data && sections.loading ? <Loading /> : null}
          {(sections.data?.sections ?? []).filter((x) => x.group === mode).map((x, i) => (
            <View key={x.id}>
              <Section s={x} />
              {mode === "tmdb" && i === 0 ? <BrowseShortcuts /> : null}
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

function Section({ s }: { s: SectionInfo }) {
  const router = useRouter();
  const open = useOpenMedia();
  const q = useQuery(`discover:${s.id}:1`, () => api<{ title: string; items: DiscoverItem[] }>(`/v1/discover/${s.id}?page=1`, { timeoutMs: 45_000 }), { staleMs: 30 * 60_000 });
  if (q.error) return null;
  if (!q.data) return <Row title={s.title}><View style={{ height: 210, justifyContent: "center" }}><Loading /></View></Row>;
  if (!q.data.items.length) return null;
  return (
    <Row title={s.title} onMore={() => router.push({ pathname: "/discover/[id]", params: { id: s.id, title: s.title, ...(s.ranked ? { ranked: "1" } : {}) } })}>
      {q.data.items.slice(0, 20).map((m, i) => <PosterTile key={`${m.source}:${m.sourceId}`} c={{ ...mediaCard(m, () => void open(m), s.ranked ? i + 1 : undefined), overview: undefined }} />)}
    </Row>
  );
}

function BrowseShortcuts() {
  const browse = useBrowse();
  return (
    <View style={{ marginTop: 22 }}>
      <Text style={{ fontSize: 19, fontWeight: "800", color: colors.text, paddingHorizontal: 16, marginBottom: 10 }}>按类型浏览</Text>
      <ChipRow>
        {BROWSE.map((b) => <Chip key={`${b.type}:${b.id}`} label={b.label} onPress={() => browse(b.label, b.type, b.filter, b.id)} />)}
      </ChipRow>
      <ChipRow style={{ marginTop: 8 }}>
        {NETWORKS.map((n) => <Chip key={n.id} label={n.label} icon="tv-outline" onPress={() => browse(n.label, "tv", "with_networks", n.id)} />)}
      </ChipRow>
    </View>
  );
}

function PeopleHits({ people }: { people: PersonHit[] }) {
  const router = useRouter();
  return (
    <Row title="人物">
      {people.map((p) => (
        <Pressable
          key={p.id}
          onPress={() => { tap(); track("person_open", { src: "search" }); router.push({ pathname: "/tmdb/person/[id]", params: { id: String(p.id), name: p.name } }); }}
          style={({ pressed }) => ({ width: 84, alignItems: "center", opacity: pressed ? 0.8 : 1 })}
        >
          <View style={{ width: 72, height: 72, borderRadius: 36, overflow: "hidden", borderWidth: 1, borderColor: colors.border }}>
            <Img source={img(p.photo)} style={{ width: 72, height: 72 }} icon="person-outline" iconSize={26} />
          </View>
          <Text style={{ fontSize: 13, fontWeight: "700", color: colors.text, marginTop: 6, textAlign: "center" }} numberOfLines={1}>{p.name}</Text>
          <Text style={[styles.faint, { textAlign: "center" }]} numberOfLines={1}>{p.original || p.dept}</Text>
        </Pressable>
      ))}
    </Row>
  );
}
