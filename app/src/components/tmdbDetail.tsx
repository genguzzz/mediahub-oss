// Building blocks of the 发现 work page, the TMDb twin of embyDetail: cast and crew (→ person timeline),
// tappable metadata (genre, network, company, keyword → TMDb lists), the collection and recommendations.
import { Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Img, PosterTile, Row } from "./media";
import { mediaCard, useOpenMedia } from "./mediaCards";
import { Chip, styles, tap } from "./ui";
import { api, img, type MediaDetail, type MediaRelated, type TmdbCredit } from "@/lib/api";
import { useQuery } from "@/lib/query";
import { colors } from "@/lib/theme";
import { track } from "@/lib/track";

export type BrowseFilter = "with_genres" | "with_networks" | "with_companies" | "with_keywords";

/** Open a TMDb list filtered by one genre / network / company / keyword. */
export function useBrowse() {
  const router = useRouter();
  return (title: string, type: "movie" | "tv", filter: BrowseFilter, id: number) => {
    tap();
    track("discover_browse", { filter });
    router.push({ pathname: "/discover/browse", params: { title, type, filter, value: String(id) } });
  };
}

export function TmdbPeopleRow({ people }: { people: TmdbCredit[] }) {
  const router = useRouter();
  if (!people.length) return null;
  return (
    <Row title="演职员">
      {people.map((p) => (
        <Pressable
          key={`${p.id}:${p.kind}`}
          onPress={() => { tap(); track("person_open", { src: "tmdb" }); router.push({ pathname: "/tmdb/person/[id]", params: { id: String(p.id), name: p.name } }); }}
          style={({ pressed }) => ({ width: 92, alignItems: "center", opacity: pressed ? 0.8 : 1 })}
        >
          <View style={{ width: 80, height: 80, borderRadius: 40, overflow: "hidden", borderWidth: 1, borderColor: colors.border }}>
            <Img source={img(p.photo)} style={{ width: 80, height: 80 }} icon="person-outline" iconSize={30} />
          </View>
          <Text style={{ fontSize: 13, fontWeight: "700", color: colors.text, marginTop: 6, textAlign: "center" }} numberOfLines={1}>{p.name}</Text>
          <Text style={[styles.faint, { textAlign: "center" }]} numberOfLines={2}>{p.role.replace(/\s*\(voice\)\s*$/i, " · 配音")}</Text>
        </Pressable>
      ))}
    </Row>
  );
}

export function TmdbMetaChips({ m, keywords }: { m: MediaDetail["media"]; keywords: MediaRelated["keywords"] }) {
  const browse = useBrowse();
  const groups: { label: string; chips: { key: string; text: string; onPress: () => void }[] }[] = [
    { label: "类型", chips: (m.genreList ?? []).map((g) => ({ key: `g${g.id}`, text: g.name, onPress: () => browse(g.name, m.type, "with_genres", g.id) })) },
    { label: "播出", chips: (m.networks ?? []).map((n) => ({ key: `n${n.id}`, text: n.name, onPress: () => browse(n.name, "tv", "with_networks", n.id) })) },
    { label: "出品", chips: (m.companies ?? []).map((c) => ({ key: `c${c.id}`, text: c.name, onPress: () => browse(c.name, m.type, "with_companies", c.id) })) },
    { label: "关键词", chips: keywords.slice(0, 12).map((k) => ({ key: `k${k.id}`, text: k.name, onPress: () => browse(k.name, m.type, "with_keywords", k.id) })) },
  ].filter((g) => g.chips.length);
  if (!groups.length) return null;
  return (
    <View style={{ marginTop: 16, gap: 10 }}>
      {groups.map((g) => (
        <View key={g.label} style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
          <Text style={[styles.faint, { width: 42, marginTop: 8 }]}>{g.label}</Text>
          <View style={{ flex: 1, flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {g.chips.map((c) => <Chip key={c.key} label={c.text} onPress={c.onPress} />)}
          </View>
        </View>
      ))}
    </View>
  );
}

/** Keywords, collection and recommendations load after the page (they are slower than the detail). */
export function useRelated(type: string, id: string) {
  return useQuery(`media:${type}:${id}:related`, () => api<MediaRelated>(`/v1/media/${type}/${id}/related`, { timeoutMs: 45_000 }), { staleMs: 60 * 60_000 });
}

export function RelatedRows({ related, selfId }: { related: MediaRelated | undefined; selfId: number }) {
  const open = useOpenMedia();
  if (!related) return null;
  const col = related.collection;
  return (
    <>
      {col && col.parts.length > 1 ? (
        <Row title={col.name || "系列作品"}>
          {col.parts.map((p) => (
            <View key={p.tmdbid ?? p.title} style={{ opacity: p.tmdbid === selfId ? 0.5 : 1 }}>
              <PosterTile c={{ ...mediaCard(p, () => void open(p)), subtitle: p.year || "未上映", overview: undefined }} />
            </View>
          ))}
        </Row>
      ) : null}
      {related.recommendations.length ? (
        <Row title="相关推荐">
          {related.recommendations.map((r) => <PosterTile key={`${r.type}:${r.tmdbid}`} c={{ ...mediaCard(r, () => void open(r)), overview: undefined }} />)}
        </Row>
      ) : null}
    </>
  );
}
