import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { CatalogHome } from "@/components/CatalogHome";
import { mediaCard, useOpenMedia, type DiscoverItem } from "@/components/mediaCards";
import { LayoutToggle, PosterTile, Posters, Row } from "@/components/media";
import { EmptyState, ErrorBox, Loading, Segmented, TAB_BAR_SPACE, TabHeader, tap, Pull } from "@/components/ui";
import { api, type MediaBrief } from "@/lib/api";
import { PROVIDER_FOR } from "@/lib/catalog";
import { useQuery } from "@/lib/query";
import { has, listenOnce } from "@/lib/device";
import { useSettings } from "@/lib/settings";
import { colors, radius } from "@/lib/theme";
import { track } from "@/lib/track";

type Mode = "media" | "av" | "hentai";
const SECTIONS = ["trending", "bangumi", "tvs", "movies", "douban_tv", "douban_anime", "douban_movie"];

export default function DiscoverTab() {
  const router = useRouter();
  const showAdult = useSettings((s) => s.showAdult);
  const [mode, setMode] = useState<Mode>("media");
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [listening, setListening] = useState(false);
  const open = useOpenMedia();
  const results = useQuery(q ? `search:${q}` : null, () => api<{ items: MediaBrief[] }>(`/v1/media/search?q=${encodeURIComponent(q)}`), { staleMs: 10 * 60_000 });

  const submit = () => {
    const v = text.trim();
    if (!v) return;
    track("search", { mode });
    if (mode !== "media") {
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
  const modes = [{ value: "media" as Mode, label: "影视" }, ...(showAdult ? [{ value: "av" as Mode, label: "AV 番号" }, { value: "hentai" as Mode, label: "里番" }] : [])];

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <TabHeader title="发现" right={q ? <LayoutToggle /> : undefined} />
      {modes.length > 1 ? <Segmented value={mode} options={modes} onChange={(m) => { setMode(m); setQ(""); }} style={{ marginHorizontal: 16, marginBottom: 10 }} /> : null}
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
          placeholder={mode === "media" ? "搜电影、剧集、番剧" : mode === "av" ? "番号或女优，如 SSIS-001" : "搜索引：罗马音、英文或日文名"}
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
                if (mode === "media") setQ(said);
                else searchAdult(said);
              }
            }}
          >
            <Ionicons name={listening ? "mic" : "mic-outline"} size={20} color={listening ? colors.primary : colors.textFaint} />
          </Pressable>
        ) : null}
      </View>
      {mode === "media" && q ? (
        <ScrollView contentContainerStyle={{ paddingTop: 12, paddingBottom: TAB_BAR_SPACE }} refreshControl={<Pull onRefresh={results.refresh} />}>
          {results.error ? <ErrorBox text={results.error} onRetry={results.refresh} /> : null}
          {results.loading && !results.data ? <Loading text="正在查询 TMDb" /> : null}
          <Pressable onPress={() => { tap(); router.push({ pathname: "/resources", params: { mode: "raw", keyword: q } }); }} style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 16, paddingBottom: 12 }}>
            <Ionicons name="flash-outline" size={15} color={colors.primary} />
            <Text style={{ color: colors.primary, fontSize: 14, fontWeight: "600" }}>不识别作品，直接按关键词搜资源</Text>
          </Pressable>
          {results.data && !results.data.items.length ? <EmptyState icon="search-outline" text="TMDb 没有找到这个名字，换个写法试试" /> : null}
          <Posters items={(results.data?.items ?? []).map((m) => mediaCard(m, () => void open(m)))} />
        </ScrollView>
      ) : mode !== "media" ? (
        <CatalogHome key={mode} kind={mode} />
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: TAB_BAR_SPACE }}>
          {SECTIONS.map((id) => <Section key={id} id={id} />)}
        </ScrollView>
      )}
    </View>
  );
}

function Section({ id }: { id: string }) {
  const router = useRouter();
  const open = useOpenMedia();
  const q = useQuery(`discover:${id}:1`, () => api<{ title: string; items: DiscoverItem[] }>(`/v1/discover/${id}?page=1`, { timeoutMs: 45_000 }), { staleMs: 30 * 60_000 });
  if (q.error) return null;
  if (!q.data) return <Row title=" "><View style={{ height: 210, justifyContent: "center" }}><Loading /></View></Row>;
  if (!q.data.items.length) return null;
  return (
    <Row title={q.data.title} onMore={() => router.push({ pathname: "/discover/[id]", params: { id, title: q.data!.title } })}>
      {q.data.items.slice(0, 20).map((m) => <PosterTile key={`${m.source}:${m.sourceId}`} c={{ ...mediaCard(m, () => void open(m)), overview: undefined }} />)}
    </Row>
  );
}
