// Poster layouts shared by the library, discover and search screens. Every poster is 2:3 and every
// landscape card 16:9, so rows and columns line up whatever the source images are.
import { type ReactNode } from "react";
import { Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import type { SheetAction } from "./ActionSheet";
import { openPeek } from "@/lib/peek";
import { setSettings, useSettings } from "@/lib/settings";
import { colors, radius, shadow } from "@/lib/theme";
import { IconButton, styles, tap } from "./ui";

type Src = { uri: string; headers?: Record<string, string> } | undefined;

export interface CardData {
  key: string;
  title: string;
  subtitle?: string;     // year · type, "S1E3", …
  overview?: string;
  poster?: Src;
  posterRight?: boolean;  // wide DVD cover: show its right half (the front)
  aspect?: number;        // poster width / height when the source isn't 2:3 (shown at its own shape)
  badge?: { text: string; color: string };
  rating?: number;
  rank?: number;         // position in a ranking (Top250, 口碑榜, 高分)
  progress?: number;     // 0..1 watched
  played?: boolean;
  unplayed?: number;     // unwatched episodes
  tags?: string[];
  embyId?: string;       // Emby item: the long-press sheet offers played/favourite/feedback
  playable?: boolean;    // movie / episode / video (casting); default true when embyId is set
  link?: { name: string; url: string }; // source page, opened as H5
  actions?: SheetAction[]; // extra long-press actions
  onPress: () => void;
}

const peek = (c: CardData) => () => { tap(); openPeek(c); };

export function Img({ source, style, icon = "film-outline", iconSize = 28, right }: { source: Src; style: object; icon?: keyof typeof Ionicons.glyphMap; iconSize?: number; right?: boolean }) {
  return (
    <View style={[{ backgroundColor: colors.cardMuted, overflow: "hidden", alignItems: "center", justifyContent: "center" }, style]}>
      <Ionicons name={icon} size={iconSize} color={colors.textFaint} style={{ position: "absolute" }} />
      {source ? <Image source={source} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }} contentFit="cover" contentPosition={right ? "right" : "center"} transition={180} cachePolicy="disk" /> : null}
    </View>
  );
}

function Overlays({ c }: { c: CardData }) {
  return (
    <>
      {c.badge ? (
        <View style={{ position: "absolute", top: 8, left: 8, backgroundColor: c.badge.color, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
          <Text style={{ color: "#fff", fontSize: 10, fontWeight: "800" }}>{c.badge.text}</Text>
        </View>
      ) : null}
      {c.rating ? (
        <View style={{ position: "absolute", top: 8, right: 8, backgroundColor: "rgba(0,0,0,0.62)", borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, flexDirection: "row", alignItems: "center", gap: 2 }}>
          <Ionicons name="star" size={9} color="#F5C451" />
          <Text style={{ color: "#fff", fontSize: 10, fontWeight: "700" }}>{c.rating.toFixed(1)}</Text>
        </View>
      ) : null}
      {c.rank ? (
        <View style={{ position: "absolute", left: 0, bottom: 0, minWidth: 30, paddingHorizontal: 7, paddingVertical: 3, borderTopRightRadius: 10, backgroundColor: c.rank <= 3 ? "#E8B04B" : "rgba(0,0,0,0.7)" }}>
          <Text style={{ color: c.rank <= 3 ? "#1A1206" : "#fff", fontSize: c.rank < 100 ? 16 : 13, fontWeight: "900", textAlign: "center" }}>{c.rank}</Text>
        </View>
      ) : null}
      {c.played ? (
        <View style={{ position: "absolute", bottom: 8, right: 8, width: 22, height: 22, borderRadius: 11, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" }}>
          <Ionicons name="checkmark" size={14} color={colors.onPrimary} />
        </View>
      ) : c.unplayed ? (
        <View style={{ position: "absolute", bottom: 8, right: 8, minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 6, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ color: colors.onPrimary, fontSize: 11, fontWeight: "800" }}>{c.unplayed > 99 ? "99+" : c.unplayed}</Text>
        </View>
      ) : null}
      {c.progress && c.progress > 0.01 && c.progress < 0.99 ? (
        <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 4, backgroundColor: "rgba(0,0,0,0.5)" }}>
          <View style={{ width: `${c.progress * 100}%`, height: 4, backgroundColor: colors.primary }} />
        </View>
      ) : null}
    </>
  );
}

// ---------- grid: two-column waterfall ----------

function estimate(c: CardData, w: number) {
  const perLine = Math.max(6, Math.floor(w / 14));
  const t = Math.min(2, Math.ceil(c.title.length / perLine));
  const o = c.overview ? Math.min(3, Math.ceil(c.overview.length / (perLine + 2))) : 0;
  return w / (c.aspect ?? 2 / 3) + 8 + t * 19 + (c.subtitle ? 16 : 0) + o * 16 + (c.tags?.length ? 22 : 0);
}

function GridCard({ c, w }: { c: CardData; w: number }) {
  return (
    <Pressable onPress={() => { tap(); c.onPress(); }} onLongPress={peek(c)} delayLongPress={350} style={({ pressed }) => ({ width: w, marginBottom: 16, opacity: pressed ? 0.85 : 1 })}>
      <View style={{ borderRadius: radius.md, overflow: "hidden", ...shadow() }}>
        <Img source={c.poster} right={c.posterRight} style={{ width: w, height: w / (c.aspect ?? 2 / 3) }} iconSize={w * 0.2} />
        <Overlays c={c} />
      </View>
      <Text style={{ fontSize: 14, fontWeight: "700", color: colors.text, marginTop: 8, lineHeight: 19 }} numberOfLines={2}>{c.title}</Text>
      {c.subtitle ? <Text style={[styles.faint, { marginTop: 2 }]} numberOfLines={1}>{c.subtitle}</Text> : null}
      {c.tags?.length ? (
        <View style={{ flexDirection: "row", gap: 4, marginTop: 5, flexWrap: "wrap" }}>
          {c.tags.slice(0, 3).map((t) => <MiniTag key={t} text={t} />)}
        </View>
      ) : null}
      {c.overview ? <Text style={{ fontSize: 12, lineHeight: 16, color: colors.textSoft, marginTop: 4 }} numberOfLines={3}>{c.overview}</Text> : null}
    </Pressable>
  );
}

export function Waterfall({ items, padding = 16, gap = 12 }: { items: CardData[]; padding?: number; gap?: number }) {
  const { width } = useWindowDimensions();
  const w = Math.floor((width - padding * 2 - gap) / 2);
  const cols: CardData[][] = [[], []];
  const h = [0, 0];
  for (const c of items) {
    const i = h[0] <= h[1] ? 0 : 1;
    cols[i].push(c);
    h[i] += estimate(c, w);
  }
  return (
    <View style={{ flexDirection: "row", gap, paddingHorizontal: padding }}>
      {cols.map((col, i) => (
        <View key={i} style={{ width: w }}>
          {col.map((c) => <GridCard key={c.key} c={c} w={w} />)}
        </View>
      ))}
    </View>
  );
}

// ---------- list: large poster with details ----------

export function ListCard({ c }: { c: CardData }) {
  const w = 112;
  return (
    <Pressable
      onPress={() => { tap(); c.onPress(); }}
      onLongPress={peek(c)}
      delayLongPress={350}
      style={({ pressed }) => ({ flexDirection: "row", gap: 14, padding: 12, borderRadius: radius.lg, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, opacity: pressed ? 0.88 : 1, ...shadow() })}
    >
      <View style={{ borderRadius: radius.md, overflow: "hidden" }}>
        <Img source={c.poster} right={c.posterRight} style={{ width: w, height: w / (c.aspect ?? 2 / 3) }} />
        <Overlays c={{ ...c, rating: undefined }} />
      </View>
      <View style={{ flex: 1, paddingVertical: 2 }}>
        <Text style={{ fontSize: 17, fontWeight: "800", color: colors.text, lineHeight: 22 }} numberOfLines={2}>{c.title}</Text>
        {c.subtitle ? <Text style={[styles.faint, { marginTop: 4, fontSize: 13 }]} numberOfLines={1}>{c.subtitle}</Text> : null}
        <View style={{ flexDirection: "row", gap: 5, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
          {c.rating ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 3, marginRight: 2 }}>
              <Ionicons name="star" size={12} color="#F5C451" />
              <Text style={{ fontSize: 13, fontWeight: "800", color: colors.text }}>{c.rating.toFixed(1)}</Text>
            </View>
          ) : null}
          {(c.tags ?? []).slice(0, 4).map((t) => <MiniTag key={t} text={t} />)}
        </View>
        {c.overview ? <Text style={{ fontSize: 13, lineHeight: 19, color: colors.textSoft, marginTop: 8 }} numberOfLines={4}>{c.overview}</Text> : null}
        {c.progress && c.progress > 0.01 && c.progress < 0.99 ? (
          <View style={{ marginTop: "auto", paddingTop: 8 }}>
            <View style={{ height: 4, borderRadius: 2, backgroundColor: colors.cardMuted }}>
              <View style={{ width: `${c.progress * 100}%`, height: 4, borderRadius: 2, backgroundColor: colors.primary }} />
            </View>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

export function PosterList({ items, padding = 16 }: { items: CardData[]; padding?: number }) {
  return <View style={{ paddingHorizontal: padding, gap: 12 }}>{items.map((c) => <ListCard key={c.key} c={c} />)}</View>;
}

export function Posters({ items, layout }: { items: CardData[]; layout?: "grid" | "list" }) {
  const pref = useSettings((s) => s.layout);
  return (layout ?? pref) === "list" ? <PosterList items={items} /> : <Waterfall items={items} />;
}

export function LayoutToggle() {
  const layout = useSettings((s) => s.layout);
  return <IconButton name={layout === "grid" ? "list-outline" : "grid-outline"} label={layout === "grid" ? "列表" : "网格"} onPress={() => setSettings({ layout: layout === "grid" ? "list" : "grid" })} />;
}

export function MiniTag({ text, color }: { text: string; color?: string }) {
  return (
    <View style={{ borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2, backgroundColor: (color ?? colors.textSoft) + "22" }}>
      <Text style={{ fontSize: 10, fontWeight: "700", color: color ?? colors.textSoft }}>{text}</Text>
    </View>
  );
}

// ---------- horizontal rows ----------

export function Row({ title, onMore, children }: { title: string; onMore?: () => void; children: ReactNode }) {
  return (
    <View style={{ marginTop: 22 }}>
      <Pressable disabled={!onMore} onPress={() => { tap(); onMore?.(); }} style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, marginBottom: 10 }}>
        <Text style={{ fontSize: 19, fontWeight: "800", color: colors.text, flex: 1 }}>{title}</Text>
        {onMore ? <Ionicons name="chevron-forward" size={18} color={colors.textFaint} /> : null}
      </Pressable>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, gap: 12 }} style={{ flexGrow: 0, flexShrink: 0 }}>
        {children}
      </ScrollView>
    </View>
  );
}

export function PosterTile({ c, w = 118 }: { c: CardData; w?: number }) {
  return (
    <Pressable onPress={() => { tap(); c.onPress(); }} onLongPress={peek(c)} delayLongPress={350} style={({ pressed }) => ({ width: w, opacity: pressed ? 0.85 : 1 })}>
      <View style={{ borderRadius: radius.md, overflow: "hidden", ...shadow() }}>
        <Img source={c.poster} right={c.posterRight} style={{ width: w, height: w / (c.aspect ?? 2 / 3) }} />
        <Overlays c={c} />
      </View>
      <Text style={{ fontSize: 13, fontWeight: "700", color: colors.text, marginTop: 7 }} numberOfLines={1}>{c.title}</Text>
      <Text style={[styles.faint, { marginTop: 1 }]} numberOfLines={1}>{c.subtitle ?? " "}</Text>
    </Pressable>
  );
}

export function LandscapeTile({ c, w = 260 }: { c: CardData; w?: number }) {
  return (
    <Pressable onPress={() => { tap(); c.onPress(); }} onLongPress={peek(c)} delayLongPress={350} style={({ pressed }) => ({ width: w, opacity: pressed ? 0.85 : 1 })}>
      <View style={{ borderRadius: radius.md, overflow: "hidden", ...shadow() }}>
        <Img source={c.poster} style={{ width: w, height: w * 0.5625 }} icon="tv-outline" />
        <View style={{ position: "absolute", left: 10, bottom: 12, width: 34, height: 34, borderRadius: 17, backgroundColor: "rgba(0,0,0,0.55)", alignItems: "center", justifyContent: "center" }}>
          <Ionicons name="play" size={16} color="#fff" style={{ marginLeft: 2 }} />
        </View>
        <Overlays c={c} />
      </View>
      <Text style={{ fontSize: 14, fontWeight: "700", color: colors.text, marginTop: 8 }} numberOfLines={1}>{c.title}</Text>
      {c.subtitle ? <Text style={[styles.faint, { marginTop: 1 }]} numberOfLines={1}>{c.subtitle}</Text> : null}
    </Pressable>
  );
}
