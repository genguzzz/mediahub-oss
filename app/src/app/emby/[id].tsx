import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Image } from "expo-image";
import * as WebBrowser from "expo-web-browser";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ExternalLinks, ExtrasRow, MediaInfo, MetaChips, PeopleRow, SimilarRow } from "@/components/embyDetail";
import { itemCard } from "@/components/embyCards";
import { Img, MiniTag, PosterTile, Row } from "@/components/media";
import { Chip, CopyText, ChipRow, ErrorBox, IconButton, Loading, PillButton, confirm, styles, tap, toast, toastError, Pull } from "@/components/ui";
import { api } from "@/lib/api";
import { backdropOf, embyApi, embyImage, landscapeOf, posterOf, runtime, seconds, techBadges, warmPlayback, type Item } from "@/lib/emby";
import { deleteFromLibrary } from "@/lib/libraryDelete";
import { openPeek } from "@/lib/peek";
import { load, useQuery } from "@/lib/query";
import { colors, radius } from "@/lib/theme";
import { track } from "@/lib/track";

export default function EmbyItemScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const key = `emby:item:${id}`;
  const q = useQuery(key, () => embyApi.item(id), { staleMs: 15_000 });
  const it = q.data;
  const isSeries = it?.Type === "Series";
  const isFolder = it && ["BoxSet", "Folder", "CollectionFolder", "Season"].includes(it.Type);
  const seasons = useQuery(isSeries ? `emby:seasons:${id}` : null, () => embyApi.seasons(id), { staleMs: 60_000 });
  const [season, setSeason] = useState<string | null>(null);
  const curSeason = season ?? seasons.data?.Items.find((s) => (s.IndexNumber ?? 0) > 0 && !s.UserData?.Played)?.Id ?? seasons.data?.Items[0]?.Id ?? null;
  const episodes = useQuery(isSeries && curSeason ? `emby:eps:${id}:${curSeason}` : null, () => embyApi.episodes(id, curSeason!), { staleMs: 15_000 });
  const children = useQuery(isFolder ? `emby:children:${id}` : null, () => embyApi.items({ parentId: id, limit: 100, sort: "year", types: "Movie,Series,Episode,Video" }), { staleMs: 60_000 });
  const nextUp = useQuery(isSeries ? `emby:nextup:${id}` : null, () => embyApi.nextUp(1, id), { staleMs: 15_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [clock, setClock] = useState(() => Date.now());   // for "结束于", refreshed each minute
  useEffect(() => {
    const t = setInterval(() => setClock(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const refreshAll = () => {
    void q.refresh();
    if (isSeries) {
      void seasons.refresh();
      void episodes.refresh();
      void nextUp.refresh();
    }
  };

  const play = (target: Item, fromStart = false) => {
    track("play_tap", { type: target.Type, resume: !fromStart && !!target.UserData?.PlaybackPositionTicks });
    router.push({ pathname: "/player", params: { id: target.Id, resume: fromStart ? "0" : "1" } });
  };

  const toggle = async (what: "played" | "fav") => {
    if (!it) return;
    setBusy(what);
    try {
      if (what === "played") await embyApi.setPlayed(it.Id, !it.UserData?.Played);
      else await embyApi.setFavorite(it.Id, !it.UserData?.IsFavorite);
      await load(key, () => embyApi.item(id));
      if (isSeries) void episodes.refresh();
    } catch (e) {
      toastError("操作失败", e);
    } finally {
      setBusy(null);
    }
  };

  const rescrape = (replace: boolean) =>
    confirm(replace ? "替换全部元数据" : "重新刮削", replace ? "丢弃现有标题、简介和图片，按当前识别结果重新下载。" : "补全缺失的元数据和图片，已有的保留。", "开始", async () => {
      try {
        await api(`/v1/emby/item/${id}/refresh`, { body: { replace } });
        toast("已提交刮削", "Emby 在后台处理，稍后下拉刷新查看");
      } catch (e) {
        toastError("未能提交", e);
      }
    });

  const target: Item | undefined = isSeries ? nextUp.data?.Items[0] ?? episodes.data?.Items[0] : it;
  // Warm the Play button's file (PlaybackInfo + first 8 MB) while the user reads the page.
  const warmId = target && (target.Type === "Movie" || target.Type === "Episode" || target.Type === "Video") ? target.Id : null;
  useEffect(() => {
    if (warmId) void warmPlayback(warmId);
  }, [warmId]);
  const pos = seconds(target?.UserData?.PlaybackPositionTicks);
  const playLabel = !target ? "播放" : isSeries ? `${pos ? "继续" : "播放"} S${target.ParentIndexNumber ?? 1}E${target.IndexNumber ?? 1}` : pos ? `继续播放 ${Math.floor(pos / 60)} 分` : "播放";
  const backdrop = it ? backdropOf(it) ?? landscapeOf(it, 1280) : undefined;
  const heroH = Math.round(width * 0.62);
  const tmdb = it?.ProviderIds?.Tmdb;
  // When a movie / episode would end if started now (or resumed), like Infuse and Emby's web client.
  const total = seconds(it?.RunTimeTicks);
  const left = total ? total - (it && !isSeries ? seconds(it.UserData?.PlaybackPositionTicks) : 0) : 0;
  const endsAt = left > 60 && it && !isSeries && !isFolder ? new Date(clock + left * 1000).toTimeString().slice(0, 5) : "";
  const logo = it?.ImageTags?.Logo ? embyImage(it.Id, "Logo", { tag: it.ImageTags.Logo, w: 600 }) : undefined;
  const hasTrailer = !!(it?.LocalTrailerCount || it?.RemoteTrailers?.length);
  const playTrailer = async () => {
    if (!it) return;
    track("trailer_tap", { local: !!it.LocalTrailerCount });
    try {
      if (it.LocalTrailerCount) {
        const t = await embyApi.localTrailers(it.Id);
        if (t[0]) return router.push({ pathname: "/player", params: { id: t[0].Id, resume: "0" } });
      }
      const url = it.RemoteTrailers?.[0]?.Url;
      if (url) await WebBrowser.openBrowserAsync(url);
    } catch (e) {
      toastError("未能打开预告片", e);
    }
  };
  const people = it?.People ?? [];

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ paddingBottom: 60 }} refreshControl={<Pull onRefresh={refreshAll} />}>
        <View style={{ height: heroH }}>
          <Img source={backdrop} style={{ position: "absolute", top: 0, left: 0, right: 0, height: heroH }} icon="image-outline" />
          {/* Fade the hero into the page background. */}
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
                <Img source={posterOf(it, 400)} style={{ width: 104, height: 156 }} />
              </View>
              <View style={{ flex: 1, paddingBottom: 4 }}>
                {logo ? <Image source={logo} style={{ width: "100%", height: 56, marginBottom: 6 }} contentFit="contain" contentPosition="left" transition={180} /> : null}
                <CopyText style={logo ? { fontSize: 15, fontWeight: "700", color: colors.textSoft } : { fontSize: 24, fontWeight: "800", color: colors.text, lineHeight: 29 }} numberOfLines={3}>{(it.Type === "Episode" ? it.SeriesName : it.Name) ?? ""}</CopyText>
                {it.Taglines?.[0] ? <Text style={{ fontSize: 13, fontStyle: "italic", color: colors.textSoft, marginTop: 3 }} numberOfLines={2}>{it.Taglines[0]}</Text> : null}
                {it.Type === "Episode" ? <Text style={[styles.body, { marginTop: 2 }]}>S{it.ParentIndexNumber}E{it.IndexNumber} · {it.Name}</Text> : null}
                <Text style={[styles.faint, { marginTop: 6, fontSize: 13 }]}>
                  {[it.ProductionYear, runtime(it.RunTimeTicks), it.OfficialRating, isSeries ? (it.Status === "Ended" ? "已完结" : it.Status === "Continuing" ? "连载中" : "") : "", endsAt ? `结束于 ${endsAt}` : ""].filter(Boolean).join(" · ")}
                </Text>
                {it.CommunityRating || it.CriticRating ? (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 6 }}>
                    {it.CommunityRating ? (
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                        <Ionicons name="star" size={13} color="#F5C451" />
                        <Text style={{ color: colors.text, fontWeight: "800" }}>{it.CommunityRating.toFixed(1)}</Text>
                      </View>
                    ) : null}
                    {it.CriticRating ? <Text style={{ color: colors.text, fontWeight: "700" }}>{it.CriticRating >= 60 ? "🍅" : "🤢"} {it.CriticRating}%</Text> : null}
                  </View>
                ) : null}
              </View>
            </View>

            <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap", marginTop: 14 }}>
              {techBadges(it).map((b) => <MiniTag key={b} text={b} color={/Dolby|HDR|Atmos|4K/.test(b) ? colors.primary : undefined} />)}
            </View>

            {!isFolder ? (
              <View style={{ flexDirection: "row", gap: 10, marginTop: 16 }}>
                <PillButton icon="play" label={playLabel} disabled={!target} onPress={() => target && play(target)} style={{ flex: 1 }} />
                {pos && target ? <IconCircle name="refresh" label="从头播放" onPress={() => play(target, true)} /> : null}
                <IconCircle name={it.UserData?.Played ? "checkmark-circle" : "checkmark-circle-outline"} label="已看" active={!!it.UserData?.Played} busy={busy === "played"} onPress={() => void toggle("played")} />
                <IconCircle name={it.UserData?.IsFavorite ? "heart" : "heart-outline"} label="收藏" active={!!it.UserData?.IsFavorite} busy={busy === "fav"} onPress={() => void toggle("fav")} />
                {hasTrailer ? <IconCircle name="film-outline" label="预告片" onPress={() => void playTrailer()} /> : null}
              </View>
            ) : null}

            {it.Overview ? <CopyText label="简介" style={[styles.body, { marginTop: 16 }]} numberOfLines={8}>{it.Overview}</CopyText> : null}
            {it.Type === "Episode" && it.SeriesId ? (
              <Pressable onPress={() => { tap(); router.push({ pathname: "/emby/[id]", params: { id: it.SeriesId! } }); }} style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 12 }}>
                <Ionicons name="albums-outline" size={15} color={colors.primary} />
                <Text style={{ color: colors.primary, fontSize: 14, fontWeight: "600" }}>查看整部剧 · {it.SeriesName}{it.SeasonName ? ` · ${it.SeasonName}` : ""}</Text>
              </Pressable>
            ) : null}
            <MetaChips item={it} />
            <ExternalLinks item={it} />
            {!isSeries && !isFolder ? <MediaInfo item={it} /> : null}
          </View>
        ) : null}

        {people.length ? <PeopleRow people={people} /> : null}

        {isSeries && seasons.data?.Items.length ? (
          <>
            <ChipRow style={{ marginTop: 22, marginBottom: 12 }}>
              {seasons.data.Items.map((s) => (
                <Chip key={s.Id} label={(s.IndexNumber ?? 0) === 0 ? "特别篇" : s.Name} count={s.ChildCount ?? undefined} active={curSeason === s.Id} onPress={() => setSeason(s.Id)} />
              ))}
            </ChipRow>
            {episodes.loading && !episodes.data ? <Loading /> : null}
            <View style={{ paddingHorizontal: 16, gap: 14 }}>
              {(episodes.data?.Items ?? []).map((e) => <EpisodeRow key={e.Id} e={e} onPlay={() => play(e)} onInfo={() => router.push({ pathname: "/emby/[id]", params: { id: e.Id } })} />)}
            </View>
          </>
        ) : null}

        {it ? <ExtrasRow item={it} onPlay={(x) => play(x, true)} /> : null}
        {it && (it.Type === "Movie" || isSeries || it.Type === "Episode") ? <SimilarRow id={it.Type === "Episode" && it.SeriesId ? it.SeriesId : it.Id} /> : null}

        {isFolder && children.data?.Items.length ? (
          <Row title="内容">
            {children.data.Items.map((c) => <PosterTile key={c.Id} c={itemCard(c, (x) => router.push({ pathname: "/emby/[id]", params: { id: x.Id } }))} />)}
          </Row>
        ) : null}

        {it ? (
          <View style={{ paddingHorizontal: 16, marginTop: 26, gap: 10 }}>
            <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text }}>管理</Text>
            <View style={{ flexDirection: "row", gap: 10 }}>
              <PillButton small variant="soft" icon="refresh" label="重新刮削" onPress={() => rescrape(false)} style={{ flex: 1 }} />
              <PillButton small variant="soft" icon="sync" label="替换元数据" onPress={() => rescrape(true)} style={{ flex: 1 }} />
            </View>
            {tmdb && (it.Type === "Movie" || isSeries) ? (
              <PillButton small variant="soft" icon="search" label="搜索资源 / 补集" onPress={() => router.push({ pathname: "/media/[type]/[id]", params: { type: it.Type === "Movie" ? "movie" : "tv", id: tmdb } })} />
            ) : null}
            <View style={{ flexDirection: "row", gap: 10 }}>
              <PillButton small variant="soft" icon="remove-circle-outline" label="从媒体库删除" onPress={() => void deleteFromLibrary({ id: it.Id, name: it.Name }, false, () => router.back())} style={{ flex: 1 }} />
              <PillButton small variant="soft" icon="trash-outline" label="连 115 原文件删" onPress={() => void deleteFromLibrary({ id: it.Id, name: it.Name }, true, () => router.back())} style={{ flex: 1 }} />
            </View>
            {it.Path ? <CopyText style={[styles.faint, { marginTop: 4 }]}>{it.Path}</CopyText> : null}
          </View>
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

function IconCircle({ name, label, onPress, active, busy }: { name: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void; active?: boolean; busy?: boolean }) {
  return (
    <Pressable accessibilityLabel={label} disabled={busy} onPress={() => { tap(); onPress(); }} style={({ pressed }) => ({ width: 50, height: 50, borderRadius: 25, alignItems: "center", justifyContent: "center", backgroundColor: colors.cardMuted, borderWidth: 1, borderColor: colors.border, opacity: pressed || busy ? 0.6 : 1 })}>
      <Ionicons name={name} size={22} color={active ? colors.primary : colors.text} />
    </Pressable>
  );
}

function EpisodeRow({ e, onPlay, onInfo }: { e: Item; onPlay: () => void; onInfo: () => void }) {
  // Long-press: the same 更多 sheet as posters (cast, played, favourite, feedback…).
  const more = () => { tap(); openPeek(itemCard(e, () => onPlay(), true)); };
  const pos = seconds(e.UserData?.PlaybackPositionTicks);
  const total = seconds(e.RunTimeTicks);
  return (
    <Pressable onPress={() => { tap(); onPlay(); }} onLongPress={more} delayLongPress={350} style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}>
      <View style={{ flexDirection: "row", gap: 12 }}>
        <View style={{ borderRadius: 10, overflow: "hidden" }}>
          <Img source={landscapeOf(e, 480)} style={{ width: 150, height: 84 }} icon="tv-outline" />
          {pos && total ? (
            <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 3, backgroundColor: "rgba(0,0,0,0.5)" }}>
              <View style={{ width: `${(pos / total) * 100}%`, height: 3, backgroundColor: colors.primary }} />
            </View>
          ) : null}
          <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" }}>
            <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "center" }}>
              <Ionicons name="play" size={14} color="#fff" style={{ marginLeft: 2 }} />
            </View>
          </View>
        </View>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 6 }}>
            <Text style={{ flex: 1, fontSize: 14, fontWeight: "700", color: colors.text }} numberOfLines={2}>{e.IndexNumber ?? "?"}. {e.Name}</Text>
            {e.UserData?.Played ? <Ionicons name="checkmark-circle" size={17} color={colors.primary} /> : null}
            <IconButton name="information-circle-outline" size={19} label="详情" onPress={onInfo} />
          </View>
          <Text style={[styles.faint, { marginTop: 2 }]}>{[runtime(e.RunTimeTicks), e.PremiereDate?.slice(0, 10)].filter(Boolean).join(" · ")}</Text>
          {e.Overview ? <Text style={{ fontSize: 12, lineHeight: 17, color: colors.textSoft, marginTop: 3 }} numberOfLines={2}>{e.Overview}</Text> : null}
        </View>
      </View>
    </Pressable>
  );
}
