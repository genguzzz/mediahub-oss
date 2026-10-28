// 管理: maintain the Emby library (browse a library, delete a work with or without its 115 files)
// and the downloaders (115 offline, qBittorrent, OpenList; formerly their own tab).
import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ActionSheet, type SheetAction } from "@/components/ActionSheet";
import { DownloadsPanel } from "@/components/Downloads";
import { Img } from "@/components/media";
import { Chip, ChipRow, EmptyState, ErrorBox, Loading, MoreFooter, Pull, Segmented, TAB_BAR_SPACE, TabHeader, styles, tap } from "@/components/ui";
import { embyApi, posterOf, type Item } from "@/lib/emby";
import { deleteFromLibrary } from "@/lib/libraryDelete";
import { useAutoMore, usePaged, useQuery } from "@/lib/query";
import { useSettings } from "@/lib/settings";
import { colors, radius } from "@/lib/theme";

type Seg = "library" | "downloads";
type Sort = "added" | "name" | "year";
const ADULT = new Set(["AV", "里番"]);
const PAGE = 40;

export default function ManageTab() {
  const params = useLocalSearchParams<{ seg?: Seg }>();
  const [seg, setSeg] = useState<Seg>(params.seg === "downloads" ? "downloads" : "library");
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <TabHeader title="管理" />
      <Segmented value={seg} onChange={setSeg} options={[{ value: "library", label: "媒体库" }, { value: "downloads", label: "下载器" }]} style={{ marginHorizontal: 16, marginBottom: 10 }} />
      {seg === "library" ? <LibraryManager /> : <DownloadsPanel />}
    </View>
  );
}

function LibraryManager() {
  const router = useRouter();
  const showAdult = useSettings((s) => s.showAdult);
  const views = useQuery("emby:views", () => embyApi.views(), { staleMs: 10 * 60_000 });
  const libs = (views.data?.Items ?? []).filter((v) => showAdult || !ADULT.has(v.Name));
  const [lib, setLib] = useState<string | null>(null);
  const cur = lib ?? libs[0]?.Id ?? null;
  const [sort, setSort] = useState<Sort>("added");
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [sheet, setSheet] = useState<Item | null>(null);
  const list = usePaged(
    cur ? `emby:manage:${cur}:${sort}:${search}` : "emby:manage:none",
    async (page) => {
      if (!cur) return [];
      const r = await embyApi.items({ parentId: cur, search: search || undefined, start: (page - 1) * PAGE, limit: PAGE, sort, types: "Movie,Series,Video" });
      return { items: r.Items, total: r.TotalRecordCount };
    },
    { id: (i) => i.Id, maxPages: 100, staleMs: 60_000 },
  );
  const scroll = useAutoMore(list.autoMore);

  const actions = (it: Item): SheetAction[] => [
    { label: "查看详情", icon: "information-circle-outline", note: it.Type === "Series" ? "可在详情里按季、按集删除" : undefined, run: () => router.push({ pathname: "/emby/[id]", params: { id: it.Id } }) },
    { label: "从媒体库删除", icon: "remove-circle-outline", destructive: true, note: "删 strm、目录和 Emby 记录，115 原文件保留", run: () => deleteFromLibrary({ id: it.Id, name: it.Name }, false, list.refresh) },
    { label: "删除并删 115 原文件", icon: "trash-outline", destructive: true, note: "连 strm 指向的 115 视频和同名字幕一起删", run: () => deleteFromLibrary({ id: it.Id, name: it.Name }, true, list.refresh) },
  ];

  return (
    <View style={{ flex: 1 }}>
      <ChipRow style={{ marginBottom: 8 }}>
        {libs.map((v) => <Chip key={v.Id} label={v.Name} active={cur === v.Id} onPress={() => setLib(v.Id)} />)}
      </ChipRow>
      <View style={{ marginHorizontal: 16, marginBottom: 8, flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, height: 40 }}>
        <Ionicons name="search" size={16} color={colors.textFaint} />
        <TextInput value={text} onChangeText={(v) => { setText(v); if (!v) setSearch(""); }} onSubmitEditing={() => setSearch(text.trim())} returnKeyType="search" placeholder="在这个库里搜索" placeholderTextColor={colors.textFaint} autoCorrect={false} clearButtonMode="while-editing" style={{ flex: 1, fontSize: 15, color: colors.text }} />
      </View>
      <ChipRow style={{ marginBottom: 6 }}>
        {([["added", "最近入库"], ["name", "名称"], ["year", "年份"]] as const).map(([k, l]) => <Chip key={k} label={l} active={sort === k} onPress={() => setSort(k)} />)}
        {list.total !== undefined ? <Text style={[styles.faint, { alignSelf: "center", marginLeft: 4 }]}>共 {list.total} 项</Text> : null}
      </ChipRow>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: TAB_BAR_SPACE, gap: 8 }} refreshControl={<Pull onRefresh={() => { void views.refresh(); void list.refresh(); }} />} {...scroll}>
        {views.error ? <ErrorBox text={views.error} onRetry={views.refresh} /> : null}
        {list.error ? <ErrorBox text={list.error} onRetry={list.refresh} /> : null}
        {!list.hasData && list.loading ? <Loading /> : null}
        {list.hasData && !list.items.length ? <EmptyState icon="albums-outline" text={search ? "没有找到" : "这个库是空的"} /> : null}
        {list.items.map((it) => <ManageRow key={it.Id} it={it} onPress={() => setSheet(it)} />)}
        <MoreFooter show={list.hasMore} error={list.moreError} onRetry={() => void list.more()} />
      </ScrollView>
      <ActionSheet visible={!!sheet} onClose={() => setSheet(null)} title={sheet?.Name ?? ""} message={sheet ? describe(sheet) : undefined} actions={sheet ? actions(sheet) : []} />
    </View>
  );
}

function describe(it: Item) {
  const type = it.Type === "Series" ? `剧集 · ${it.ChildCount ?? "?"} 季` : it.Type === "Movie" ? "电影" : it.Type;
  return [type, it.ProductionYear, it.Path ? it.Path.split("/").slice(-2).join("/") : ""].filter(Boolean).join(" · ");
}

function ManageRow({ it, onPress }: { it: Item; onPress: () => void }) {
  return (
    <Pressable onPress={() => { tap(); onPress(); }} style={({ pressed }) => ({ flexDirection: "row", gap: 12, padding: 10, borderRadius: radius.md, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, opacity: pressed ? 0.85 : 1 })}>
      <View style={{ borderRadius: 8, overflow: "hidden" }}>
        <Img source={posterOf(it, 160)} style={{ width: 48, height: 72 }} iconSize={18} />
      </View>
      <View style={{ flex: 1, justifyContent: "center" }}>
        <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text }} numberOfLines={2}>{it.Name}</Text>
        <Text style={[styles.faint, { marginTop: 3 }]} numberOfLines={1}>{describe(it)}</Text>
      </View>
      <Ionicons name="ellipsis-horizontal" size={18} color={colors.textFaint} style={{ alignSelf: "center" }} />
    </Pressable>
  );
}
