// Building blocks of the Emby item page (modelled on Infuse / Swiftfin / Streamyfin): cast and
// crew with photos, tappable metadata (genres, studios, tags → filtered library lists), external
// links, technical media info, and the "more like this" / extras rows.
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { itemCard } from "./embyCards";
import { Img, LandscapeTile, PosterTile, Row } from "./media";
import { Chip, styles, tap } from "./ui";
import { bytes } from "@/lib/format";
import { embyApi, embyImage, type Item, type MediaStream, type Person } from "@/lib/emby";
import { useQuery } from "@/lib/query";
import { colors, radius } from "@/lib/theme";
import { track } from "@/lib/track";

const ROLE: Record<string, string> = { Director: "导演", Writer: "编剧", Producer: "制片", Composer: "作曲", GuestStar: "客串", Creator: "主创" };

// "Reito Naoi (voice)" → "Reito Naoi · 配音"
function roleText(p: Person) {
  if (p.Type !== "Actor" && p.Type !== "GuestStar") return ROLE[p.Type] ?? p.Type;
  const r = (p.Role ?? "").trim();
  if (!r) return p.Type === "GuestStar" ? "客串" : "";
  return r.replace(/\s*\((voice|声优|配音)\)\s*$/i, " · 配音");
}

// ---------- cast & crew ----------

export function PeopleRow({ people, title = "演职员" }: { people: Person[]; title?: string }) {
  const router = useRouter();
  if (!people.length) return null;
  // Actors in billing order first, then the crew (directors before writers…).
  const order = (p: Person) => (p.Type === "Actor" ? 0 : p.Type === "GuestStar" ? 1 : p.Type === "Director" ? 2 : 3);
  const list = [...people].map((p, i) => ({ p, i })).sort((a, b) => order(a.p) - order(b.p) || a.i - b.i).map((x) => x.p);
  return (
    <Row title={title}>
      {list.slice(0, 40).map((p) => (
        <Pressable
          key={`${p.Id}:${p.Type}:${p.Role ?? ""}`}
          onPress={() => { tap(); track("person_open", { type: p.Type }); router.push({ pathname: "/emby/person/[id]", params: { id: p.Id, name: p.Name } }); }}
          style={({ pressed }) => ({ width: 92, alignItems: "center", opacity: pressed ? 0.8 : 1 })}
        >
          <View style={{ width: 80, height: 80, borderRadius: 40, overflow: "hidden", borderWidth: 1, borderColor: colors.border }}>
            <Img source={p.PrimaryImageTag ? embyImage(p.Id, "Primary", { tag: p.PrimaryImageTag, w: 240 }) : undefined} style={{ width: 80, height: 80 }} icon="person-outline" iconSize={30} />
          </View>
          <Text style={{ fontSize: 13, fontWeight: "700", color: colors.text, marginTop: 6, textAlign: "center" }} numberOfLines={1}>{p.Name}</Text>
          <Text style={[styles.faint, { textAlign: "center" }]} numberOfLines={2}>{roleText(p)}</Text>
        </Pressable>
      ))}
    </Row>
  );
}

// ---------- metadata chips ----------

export function MetaChips({ item }: { item: Item }) {
  const router = useRouter();
  const list = (title: string, params: Record<string, string>) => {
    tap();
    router.push({ pathname: "/emby/list", params: { title, ...params } });
  };
  const groups: { label: string; chips: { text: string; onPress?: () => void }[] }[] = [
    { label: "类型", chips: (item.Genres ?? []).map((g) => ({ text: g, onPress: () => list(g, { genre: g }) })) },
    { label: "出品", chips: (item.Studios ?? []).map((s) => ({ text: s.Name, onPress: s.Id !== undefined ? () => list(s.Name, { studioId: String(s.Id) }) : undefined })) },
    { label: "标签", chips: (item.Tags ?? []).map((t) => ({ text: t, onPress: () => list(t, { tag: t }) })) },
    { label: "地区", chips: (item.ProductionLocations ?? []).map((l) => ({ text: l.trim() })) },
    { label: "年份", chips: item.ProductionYear ? [{ text: String(item.ProductionYear), onPress: () => list(`${item.ProductionYear} 年`, { year: String(item.ProductionYear) }) }] : [] },
  ].filter((g) => g.chips.length);
  if (!groups.length) return null;
  return (
    <View style={{ marginTop: 16, gap: 10 }}>
      {groups.map((g) => (
        <View key={g.label} style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
          <Text style={[styles.faint, { width: 30, marginTop: 8 }]}>{g.label}</Text>
          <View style={{ flex: 1, flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {g.chips.map((c) => <Chip key={c.text} label={c.text} onPress={c.onPress} />)}
          </View>
        </View>
      ))}
    </View>
  );
}

// ---------- external links ----------

const LINK_NAME: Record<string, string> = { TheMovieDb: "TMDb", TheTVDB: "TVDB", Trakt: "Trakt", IMDb: "IMDb", Douban: "豆瓣" };

export function ExternalLinks({ item }: { item: Item }) {
  const links = (item.ExternalUrls ?? []).filter((l) => /^https?:\/\//.test(l.Url));
  if (!links.length) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 14 }}>
      {links.map((l) => (
        <Chip key={l.Url} icon="open-outline" label={LINK_NAME[l.Name] ?? l.Name} onPress={() => { track("external_link", { name: l.Name }); void WebBrowser.openBrowserAsync(l.Url); }} />
      ))}
    </View>
  );
}

// ---------- technical info ----------

function streamLine(s: MediaStream) {
  if (s.Type === "Video") {
    const res = s.Height ? (s.Height >= 2000 ? "4K" : s.Height >= 1000 ? "1080p" : s.Height >= 700 ? "720p" : `${s.Height}p`) : "";
    return [res, s.Codec?.toUpperCase(), s.ExtendedVideoSubTypeDescription || (s.VideoRange && s.VideoRange !== "SDR" ? s.VideoRange : ""), s.Profile].filter(Boolean).join(" · ");
  }
  return s.DisplayTitle || [s.Language, s.Codec?.toUpperCase(), s.ChannelLayout].filter(Boolean).join(" · ");
}

export function MediaInfo({ item }: { item: Item }) {
  const [open, setOpen] = useState(false);
  const sources = item.MediaSources ?? [];
  const [src, setSrc] = useState(0);
  const s = sources[src];
  if (!s) return null;
  const streams = s.MediaStreams ?? item.MediaStreams ?? [];
  const video = streams.filter((x) => x.Type === "Video");
  const audio = streams.filter((x) => x.Type === "Audio");
  const subs = streams.filter((x) => x.Type === "Subtitle");
  // strm sources carry the OpenList URL (with its sign=): show only the decoded file name.
  const file = (() => {
    const last = (s.Path ?? item.Path ?? "").split("?")[0].split("/").pop() ?? "";
    try {
      return decodeURIComponent(last);
    } catch {
      return last;
    }
  })();
  const summary = [video[0] ? streamLine(video[0]) : "", audio.length ? `${audio.length} 条音轨` : "", subs.length ? `${subs.length} 条字幕` : "", s.Size ? bytes(s.Size) : ""].filter(Boolean).join(" · ");
  return (
    <View style={{ marginTop: 18, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, overflow: "hidden" }}>
      <Pressable onPress={() => { tap(); setOpen((o) => !o); }} style={{ flexDirection: "row", alignItems: "center", gap: 8, padding: 12 }}>
        <Ionicons name="information-circle-outline" size={18} color={colors.textSoft} />
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 14, fontWeight: "700", color: colors.text }}>媒体信息{sources.length > 1 ? ` · ${sources.length} 个版本` : ""}</Text>
          <Text style={[styles.faint, { marginTop: 2 }]} numberOfLines={1}>{summary || "还没有探测过（strm 首次播放后 Emby 才会记录编码信息）"}</Text>
        </View>
        <Ionicons name={open ? "chevron-up" : "chevron-down"} size={16} color={colors.textFaint} />
      </Pressable>
      {open ? (
        <View style={{ paddingHorizontal: 12, paddingBottom: 12, gap: 10 }}>
          {sources.length > 1 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
              {sources.map((x, i) => <Chip key={x.Id} label={x.Name || `版本 ${i + 1}`} active={i === src} onPress={() => setSrc(i)} />)}
            </ScrollView>
          ) : null}
          <InfoLines title="视频" lines={video.map(streamLine)} />
          <InfoLines title="音频" lines={audio.map(streamLine)} />
          <InfoLines title="字幕" lines={subs.map((x) => `${streamLine(x)}${x.IsExternal ? " · 外挂" : ""}`)} />
          <InfoLines title="文件" lines={[file, [s.Container?.toUpperCase(), s.Size ? bytes(s.Size) : "", s.Bitrate ? `${(s.Bitrate / 1e6).toFixed(1)} Mbps` : ""].filter(Boolean).join(" · ")].filter(Boolean)} />
        </View>
      ) : null}
    </View>
  );
}

function InfoLines({ title, lines }: { title: string; lines: string[] }) {
  if (!lines.length) return null;
  return (
    <View style={{ flexDirection: "row", gap: 10 }}>
      <Text style={[styles.faint, { width: 30 }]}>{title}</Text>
      <View style={{ flex: 1, gap: 3 }}>
        {lines.map((l, i) => <Text key={i} selectable style={{ fontSize: 13, color: colors.text }}>{l}</Text>)}
      </View>
    </View>
  );
}

// ---------- related rows ----------

export function SimilarRow({ id }: { id: string }) {
  const router = useRouter();
  const q = useQuery(`emby:similar:${id}`, () => embyApi.similar(id), { staleMs: 30 * 60_000 });
  const items = q.data?.Items ?? [];
  if (!items.length) return null;
  return (
    <Row title="更多类似">
      {items.map((i) => <PosterTile key={i.Id} c={{ ...itemCard(i, (x) => router.push({ pathname: "/emby/[id]", params: { id: x.Id } })), overview: undefined }} />)}
    </Row>
  );
}

export function ExtrasRow({ item, onPlay }: { item: Item; onPlay: (x: Item) => void }) {
  const q = useQuery(item.SpecialFeatureCount ? `emby:extras:${item.Id}` : null, () => embyApi.specialFeatures(item.Id), { staleMs: 30 * 60_000 });
  const items = q.data ?? [];
  if (!items.length) return null;
  return (
    <Row title="花絮与特典">
      {items.map((i) => <LandscapeTile key={i.Id} c={{ ...itemCard(i, onPlay, true), subtitle: undefined }} w={220} />)}
    </Row>
  );
}
