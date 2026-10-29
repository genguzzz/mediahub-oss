// A person in the library (actor, director…): photo, birth date and place, biography, external
// links, and every movie / series in the library they appear in, newest first.
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ExternalLinks } from "@/components/embyDetail";
import { itemCard } from "@/components/embyCards";
import { Img, LayoutToggle, Posters } from "@/components/media";
import { EmptyState, ErrorBox, Loading, MoreFooter, Pull, Screen, Segmented, TopBar, styles, tap } from "@/components/ui";
import { embyApi, embyImage, type Item } from "@/lib/emby";
import { useAutoMore, usePaged, useQuery } from "@/lib/query";
import { colors } from "@/lib/theme";

type Kind = "all" | "Movie" | "Series";
const PAGE = 60;

function age(born?: string, died?: string) {
  if (!born) return "";
  const b = new Date(born);
  const e = died ? new Date(died) : new Date();
  let y = e.getFullYear() - b.getFullYear();
  if (e.getMonth() < b.getMonth() || (e.getMonth() === b.getMonth() && e.getDate() < b.getDate())) y -= 1;
  return died ? `享年 ${y} 岁` : `${y} 岁`;
}

export default function PersonScreen() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const router = useRouter();
  const [kind, setKind] = useState<Kind>("all");
  const [more, setMore] = useState(false);
  const p = useQuery(`emby:person:${id}`, () => embyApi.person(id), { staleMs: 60 * 60_000 });
  const works = usePaged(
    `emby:person:${id}:works:${kind}`,
    async (page) => {
      const r = await embyApi.filtered({ personId: id, types: kind === "all" ? "Movie,Series" : kind, sort: "year", start: (page - 1) * PAGE, limit: PAGE });
      return { items: r.Items, total: r.TotalRecordCount };
    },
    { id: (i: Item) => i.Id, maxPages: 30, staleMs: 10 * 60_000 },
  );
  const scroll = useAutoMore(works.autoMore);
  const it = p.data;
  const born = it?.PremiereDate?.slice(0, 10);
  const died = it?.EndDate?.slice(0, 10);
  const facts = [born ? `${born} 出生` : "", died ? `${died} 去世` : "", age(it?.PremiereDate, it?.EndDate), (it?.ProductionLocations ?? []).map((l) => l.trim()).join(" ")].filter(Boolean);

  return (
    <Screen>
      <TopBar title={it?.Name ?? name ?? "人物"} right={<LayoutToggle />} />
      <ScrollView contentContainerStyle={{ paddingBottom: 60 }} refreshControl={<Pull onRefresh={() => { void p.refresh(); void works.refresh(); }} />} {...scroll}>
        {p.error ? <ErrorBox text={p.error} onRetry={p.refresh} /> : null}
        <View style={{ flexDirection: "row", gap: 16, paddingHorizontal: 16, paddingTop: 4 }}>
          <View style={{ width: 110, height: 150, borderRadius: 14, overflow: "hidden", borderWidth: 1, borderColor: colors.border }}>
            <Img source={it?.ImageTags?.Primary ? embyImage(id, "Primary", { tag: it.ImageTags.Primary, w: 400 }) : undefined} style={{ width: 110, height: 150 }} icon="person-outline" iconSize={40} />
          </View>
          <View style={{ flex: 1, justifyContent: "center" }}>
            <Text selectable style={{ fontSize: 22, fontWeight: "800", color: colors.text }}>{it?.Name ?? name}</Text>
            {facts.map((f) => <Text key={f} style={[styles.faint, { marginTop: 4, fontSize: 13 }]}>{f}</Text>)}
            {works.total !== undefined ? <Text style={[styles.faint, { marginTop: 4, fontSize: 13 }]}>库中 {works.total} 部作品</Text> : null}
          </View>
        </View>
        <View style={{ paddingHorizontal: 16 }}>
          {it?.Overview ? (
            <Pressable onPress={() => { tap(); setMore((m) => !m); }}>
              <Text selectable style={[styles.body, { marginTop: 14 }]} numberOfLines={more ? undefined : 4}>{it.Overview}</Text>
              <Text style={{ color: colors.primary, fontSize: 13, marginTop: 4 }}>{more ? "收起" : "展开"}</Text>
            </Pressable>
          ) : null}
          {it ? <ExternalLinks item={it} /> : null}
          <Segmented value={kind} onChange={setKind} options={[{ value: "all", label: "全部" }, { value: "Movie", label: "电影" }, { value: "Series", label: "剧集" }]} style={{ marginTop: 18, marginBottom: 12 }} />
        </View>
        {works.error ? <ErrorBox text={works.error} onRetry={works.refresh} /> : null}
        {!works.hasData && works.loading ? <Loading /> : null}
        {works.hasData && !works.items.length ? <EmptyState icon="film-outline" text="库里没有这个分类的作品" /> : null}
        <Posters items={works.items.map((i) => itemCard(i, (x) => router.push({ pathname: "/emby/[id]", params: { id: x.Id } })))} />
        <MoreFooter show={works.hasMore} error={works.moreError} onRetry={() => void works.more()} />
      </ScrollView>
    </Screen>
  );
}
