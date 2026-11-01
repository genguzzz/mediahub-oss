// Renders the assistant's ```media blocks: a row of poster cards (tap → the work's page; long press → the
// usual 更多 sheet), each with its one-line reason. Bad JSON shows the raw text; an open block a skeleton.
import { ScrollView, Text, View } from "react-native";
import { PosterTile, type CardData } from "@/components/media";
import type { Segment } from "./blocks";
import { goFromAi } from "./Markdown";
import { colors, fs, radius } from "./look";

type Work = { type?: string; tmdbid?: number; title?: string; year?: string; poster?: string; why?: string };

const posterUrl = (p?: string) => (p ? (/^https?:\/\//.test(p) ? p : `https://image.tmdb.org/t/p/w342/${p.replace(/^\/+/, "")}`) : undefined);

function card(w: Work, i: number): CardData | null {
  if (!w || (w.type !== "movie" && w.type !== "tv") || !w.tmdbid) return null;
  const uri = posterUrl(w.poster);
  return {
    key: `${w.type}:${w.tmdbid}:${i}`,
    title: w.title || "未命名",
    subtitle: [w.year, w.type === "movie" ? "电影" : "剧集"].filter(Boolean).join(" · "),
    poster: uri ? { uri } : undefined,
    onPress: () => goFromAi({ pathname: "/media/[type]/[id]", params: { type: w.type!, id: String(w.tmdbid) } }),
  };
}

export function AiBlock({ seg }: { seg: Extract<Segment, { k: "block" }> }) {
  if (seg.open) return <View style={{ height: 210, marginVertical: 8, borderRadius: radius.md, backgroundColor: colors.raised, opacity: 0.6 }} />;
  const list = Array.isArray(seg.data) ? (seg.data as Work[]) : [];
  const cards = list.map((w, i) => ({ w, c: card(w, i) })).filter((x): x is { w: Work; c: CardData } => !!x.c);
  if (seg.error || !cards.length) return <Text selectable style={{ fontSize: fs.sm, color: colors.textFaint, marginVertical: 6 }}>{seg.raw}</Text>;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginVertical: 8, marginHorizontal: -16 }} contentContainerStyle={{ paddingHorizontal: 16, gap: 12 }}>
      {cards.map(({ w, c }) => (
        <View key={c.key} style={{ width: 118 }}>
          <PosterTile c={c} w={118} />
          {w.why ? <Text numberOfLines={3} style={{ fontSize: fs.xs, lineHeight: 16, color: colors.textSoft, marginTop: 2 }}>{w.why}</Text> : null}
        </View>
      ))}
    </ScrollView>
  );
}
