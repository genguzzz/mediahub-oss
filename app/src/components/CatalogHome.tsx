// 发现 → AV / 里番 without a search: rows from a catalog provider (rankings, hot, recent, top
// rated…), a tag strip where the provider filters by tag and, for AV, the actress index. AV has
// several providers (JavDB rankings, Jable hot lists, the own library); a switch picks one.
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Img, PosterTile, Row } from "./media";
import { Chip, ChipRow, ErrorBox, Loading, Pull, Segmented, TAB_BAR_SPACE, styles, tap } from "./ui";
import { img } from "@/lib/api";
import { AV_PROVIDERS, catalogApi, catalogCard, PROVIDER_FOR, useOpenCatalog, type CatalogKind, type ListQuery, type Person } from "@/lib/catalog";
import { useQuery } from "@/lib/query";
import { colors } from "@/lib/theme";
import { track } from "@/lib/track";

export function CatalogHome({ kind }: { kind: CatalogKind }) {
  const [avProvider, setAvProvider] = useState(PROVIDER_FOR.av);
  const p = kind === "av" ? avProvider : PROVIDER_FOR[kind];
  const router = useRouter();
  const open = useOpenCatalog(p);
  const providers = useQuery("catalog:providers", catalogApi.providers, { staleMs: 60 * 60_000 });
  const info = providers.data?.providers.find((x) => x.id === p);
  const home = useQuery(`catalog:${p}:home`, () => catalogApi.home(p), { staleMs: 10 * 60_000 });
  const tags = useQuery(info?.tagFilter ? `catalog:${p}:tags` : null, () => catalogApi.tags(p), { staleMs: 60 * 60_000 });
  const persons = useQuery(info?.people ? `catalog:${p}:persons:home` : null, () => catalogApi.persons(p, info?.personIndexSorts[0]?.id ?? "", 1), { staleMs: 30 * 60_000 });
  const list = (title: string, q: ListQuery) => router.push({ pathname: "/catalog/[p]", params: { p, title, ...q } });

  return (
    <ScrollView contentContainerStyle={{ paddingBottom: TAB_BAR_SPACE }} refreshControl={<Pull onRefresh={() => { void home.refresh(); void tags.refresh(); void persons.refresh(); }} />}>
      {kind === "av" ? (
        <Segmented value={avProvider} options={AV_PROVIDERS} onChange={(v) => { track("catalog_provider", { p: v }); setAvProvider(v); }} style={{ marginHorizontal: 16, marginTop: 12 }} />
      ) : null}
      {tags.data?.tags.length ? (
        <ChipRow style={{ marginTop: 14 }}>
          <Chip label="全部" icon="apps-outline" onPress={() => list(kind === "av" ? "全部 AV" : "全部里番", {})} />
          {tags.data.tags.slice(0, 24).map((t) => <Chip key={t.name} label={t.name} count={t.count} onPress={() => list(t.name, { tag: t.name })} />)}
        </ChipRow>
      ) : null}

      {persons.data?.items.length ? (
        <PersonRow persons={persons.data.items} onMore={() => router.push({ pathname: "/catalog/[p]/persons", params: { p } })} onOpen={(x) => list(x.name, { person: x.id })} />
      ) : null}

      {home.error ? <ErrorBox text={home.error} onRetry={home.refresh} /> : null}
      {!home.data && home.loading ? <View style={{ height: 240, justifyContent: "center" }}><Loading text={p === "hanime" ? "正在载入里番索引" : p === "emby-av" ? "正在读取媒体库" : `正在读取 ${info?.name ?? "索引"}`} /></View> : null}
      {home.data?.rows.filter((r) => r.items.length).map((r) => (
        <Row key={r.id} title={r.title} onMore={() => list(r.title, r.query)}>
          {r.items.map((c) => <PosterTile key={c.id} c={{ ...catalogCard(c, () => open(c)), overview: undefined }} />)}
        </Row>
      ))}
      {home.data && !home.data.rows.some((r) => r.items.length) ? (
        <Text style={[styles.faint, { padding: 24, textAlign: "center" }]}>{p === "emby-av" ? "AV 库还是空的，搜番号入库后会出现在这里" : "暂时没有读到内容，下拉重试"}</Text>
      ) : null}
    </ScrollView>
  );
}

export function PersonRow({ persons, onMore, onOpen }: { persons: Person[]; onMore: () => void; onOpen: (p: Person) => void }) {
  return (
    <Row title="女优" onMore={onMore}>
      {persons.slice(0, 20).map((x) => <PersonTile key={x.id} p={x} onPress={() => onOpen(x)} />)}
    </Row>
  );
}

export function PersonTile({ p, onPress, size = 76 }: { p: Person; onPress: () => void; size?: number }) {
  return (
    <Pressable onPress={() => { tap(); onPress(); }} style={({ pressed }) => ({ width: size + 8, alignItems: "center", opacity: pressed ? 0.8 : 1 })}>
      <View style={{ width: size, height: size, borderRadius: size / 2, overflow: "hidden", borderWidth: 2, borderColor: colors.border }}>
        {/* The library has no actress photos: her newest cover stands in there. */}
        <Img source={img(p.poster)} style={{ width: size, height: size }} icon="person-outline" iconSize={size * 0.4} />
      </View>
      <Text style={{ fontSize: 13, fontWeight: "700", color: colors.text, marginTop: 6 }} numberOfLines={1}>{p.name}</Text>
      {p.count ? <Text style={styles.faint} numberOfLines={1}>{p.count} 部</Text> : null}
    </Pressable>
  );
}
