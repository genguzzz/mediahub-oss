// One work from a catalog: artwork, rating, facts, tags and people (each opens the filtered list),
// the other parts of the series, online stream sources and the way to search resources for ingest.
import { Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Img, MiniTag, PosterTile, Row } from "@/components/media";
import { Card, Chip, ErrorBox, Loading, PillButton, Pull, Row as InfoRow, styles, tap } from "@/components/ui";
import { img } from "@/lib/api";
import { catalogApi, catalogCard, compact, usePlaySource, type StreamSource } from "@/lib/catalog";
import { useQuery } from "@/lib/query";
import { colors, radius } from "@/lib/theme";
import { track } from "@/lib/track";

export default function CatalogItemScreen() {
  const { p, id } = useLocalSearchParams<{ p: string; id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const q = useQuery(`catalog:${p}:item:${id}`, () => catalogApi.item(p, id), { staleMs: 5 * 60_000 });
  const play = usePlaySource();
  const providers = useQuery("catalog:providers", catalogApi.providers, { staleMs: 60 * 60_000 });
  const tagFilter = !!providers.data?.providers.find((x) => x.id === p)?.tagFilter;
  const it = q.data?.item;
  const kind = q.data?.kind;
  const library = q.data?.library ?? null;
  // Online sources (Jable…) need page loads on the server: fetched after the detail is shown.
  const online = useQuery(q.data?.moreStreams ? `catalog:${p}:streams:${id}` : null, () => catalogApi.streams(p, id), { staleMs: 10 * 60_000 });
  const streams = online.data?.streams ?? [];
  const heroH = Math.round(width * 0.6);
  const list = (title: string, params: Record<string, string>) => router.push({ pathname: "/catalog/[p]", params: { p, title, ...params } });
  const ingest = () => {
    if (!it || !kind) return;
    track("catalog_ingest_search", { p, kind });
    router.push({ pathname: "/resources", params: { mode: kind, keyword: it.keyword } });
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ paddingBottom: 60 }} refreshControl={<Pull onRefresh={q.refresh} />}>
        <View style={{ height: heroH }}>
          <Img source={img(it?.landscape ?? it?.poster)} style={{ position: "absolute", top: 0, left: 0, right: 0, height: heroH }} icon="image-outline" />
          {Array.from({ length: 16 }, (_, i) => (
            <View key={i} style={{ position: "absolute", left: 0, right: 0, top: heroH * (0.45 + i * 0.035), height: heroH * 0.035 + 1, backgroundColor: `${colors.fade}${((i + 1) / 16) ** 1.6})` }} />
          ))}
          <View style={{ position: "absolute", left: 0, right: 0, top: heroH * 0.99, height: heroH * 0.02, backgroundColor: colors.bg }} />
        </View>
        {q.error ? <ErrorBox text={q.error} onRetry={q.refresh} /> : null}
        {!it && q.loading ? <Loading /> : null}
        {it ? (
          <View style={{ paddingHorizontal: 18, marginTop: -heroH * 0.32 }}>
            <View style={{ flexDirection: "row", gap: 14, alignItems: "flex-end" }}>
              <View style={{ borderRadius: radius.md, overflow: "hidden", borderWidth: 1, borderColor: colors.border }}>
                <Img source={img(it.poster)} right={it.posterCrop === "right"} style={{ width: 104, height: 104 / (it.posterAspect ?? 2 / 3) }} />
              </View>
              <View style={{ flex: 1, paddingBottom: 4 }}>
                {it.code ? <Text selectable style={{ fontSize: 13, fontWeight: "800", color: colors.primary, letterSpacing: 0.5 }}>{it.code}</Text> : null}
                <Text selectable style={{ fontSize: 21, fontWeight: "800", color: colors.text, lineHeight: 27 }} numberOfLines={4}>{it.title}</Text>
                {it.originalTitle ? <Text selectable style={[styles.faint, { marginTop: 4, fontSize: 13 }]} numberOfLines={2}>{it.originalTitle}</Text> : null}
                <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 6 }}>
                  {it.rating ? (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                      <Ionicons name="star" size={13} color="#F5C451" />
                      <Text style={{ color: colors.text, fontWeight: "800" }}>{it.rating.toFixed(1)}</Text>
                      {it.votes ? <Text style={styles.faint}>{compact(it.votes)} 人评价</Text> : null}
                    </View>
                  ) : null}
                  {it.inLibrary ? <MiniTag text="已入库" color={colors.success} /> : null}
                </View>
              </View>
            </View>

            {library ? (
              <PillButton icon={library.folder ? "folder-open-outline" : "play"} label={library.folder ? "去 Emby 查看" : "去 Emby 播放"} onPress={() => play.library(library)} style={{ marginTop: 18 }} />
            ) : null}

            {q.data?.moreStreams ? (
              <>
                <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text, marginTop: 20, marginBottom: 8 }}>在线播放</Text>
                {streams.length ? (
                  <View style={{ gap: 8 }}>
                    {streams.map((s, i) => <SourceRow key={`${s.provider}:${i}`} s={s} onPress={() => play.online(s, `${it.code ? `${it.code} ` : ""}${it.title}`)} />)}
                  </View>
                ) : (
                  <Card muted>
                    <Text style={styles.faint}>{online.error ? `未能查找在线源：${online.error}` : !online.data ? "正在查找在线源…" : "没有找到在线源"}</Text>
                  </Card>
                )}
                {online.data?.errors.length ? <Text style={[styles.faint, { marginTop: 6, color: colors.danger }]}>{online.data.errors.join("；")}</Text> : null}
              </>
            ) : null}

            <PillButton icon="cloud-download-outline" variant={library || streams.length ? "soft" : "primary"} label={kind === "av" ? `搜索资源入库（${it.keyword}）` : "搜索资源入库"} onPress={ingest} style={{ marginTop: 12 }} />

            {it.people?.length ? (
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 18 }}>
                {it.people.map((x) => <Chip key={x.id} icon="person-outline" label={x.name} onPress={() => list(x.name, { person: x.id })} />)}
              </View>
            ) : null}

            {it.tags.length ? (
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 14 }}>
                {it.tags.map((t) => <Chip key={t} label={t} onPress={tagFilter ? () => list(t, { tag: t }) : undefined} />)}
              </View>
            ) : null}

            {it.overview ? <Text selectable style={[styles.body, { marginTop: 16 }]}>{it.overview}</Text> : null}

            {it.facts.length ? (
              <View style={{ marginTop: 16 }}>
                {it.facts.map((f) => (
                  <InfoRow key={f.label} label={f.label} value={f.value} selectable onPress={p === "hanime" && f.label === "厂牌" && it.brand ? () => list(it.brand!, { person: it.brand! }) : undefined} />
                ))}
              </View>
            ) : null}
          </View>
        ) : null}

        {it && it.episodes.length > 1 ? (
          <Row title={`本系列 · ${it.episodes.length} 部`}>
            {it.episodes.map((e) => (
              <PosterTile key={e.id} c={{ ...catalogCard(e, () => e.id !== it.id && router.push({ pathname: "/catalog/[p]/item/[id]", params: { p, id: e.id } })), badge: e.id === it.id ? { text: "当前", color: colors.primary } : e.inLibrary ? { text: "已入库", color: colors.success } : undefined }} />
            ))}
          </Row>
        ) : null}
      </ScrollView>
      <View style={{ position: "absolute", top: insets.top + 6, left: 12 }}>
        <Pressable hitSlop={10} accessibilityLabel="返回" onPress={() => { tap(); router.back(); }} style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "center" }}>
          <Ionicons name="chevron-back" size={22} color="#fff" />
        </Pressable>
      </View>
    </View>
  );
}

function SourceRow({ s, onPress }: { s: StreamSource; onPress: () => void }) {
  return (
    <Pressable onPress={() => { tap(); onPress(); }} style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: radius.md, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, opacity: pressed ? 0.85 : 1 })}>
      <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" }}>
        <Ionicons name={s.embyFolder ? "folder-open" : "play"} size={17} color={colors.onPrimary} style={{ marginLeft: s.embyFolder ? 0 : 2 }} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text }}>{s.label}</Text>
        {s.note ? <Text style={styles.faint}>{s.note}</Text> : null}
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
    </Pressable>
  );
}
