import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { HeroBack, HeroBackdrop, HeroHeader } from "@/components/DetailHero";
import { RelatedRows, TmdbMetaChips, TmdbPeopleRow, useRelated } from "@/components/tmdbDetail";
import { Card, Chip, CopyText, SourceLink, ErrorBox, Loading, PillButton, ProgressBar, SectionTitle, Tag, TopBar, confirm, styles, toast, toastError, Pull } from "@/components/ui";
import { api, img, type MediaDetail } from "@/lib/api";
import { ranges } from "@/lib/format";
import { load, useQuery } from "@/lib/query";
import { colors } from "@/lib/theme";

export default function MediaScreen() {
  const { type, id } = useLocalSearchParams<{ type: string; id: string }>();
  const router = useRouter();
  const key = `media:${type}:${id}`;
  const { data, error, loading, refresh } = useQuery(key, () => api<MediaDetail>(`/v1/media/${type}/${id}`), { staleMs: 60_000 });
  const related = useRelated(String(type), String(id));
  const [busy, setBusy] = useState<string | null>(null);
  const m = data?.media;
  const lib = data?.library?.found ? data.library : null;

  const search = (season?: number) =>
    router.push({ pathname: "/resources", params: { mode: "smart", tmdbid: id, type: String(type), season: season === undefined ? "" : String(season), title: m?.title ?? "" } });

  // 自动入库: the plugin searches, picks by the 选片 policy and downloads (airing seasons get a subscription instead).
  const autoIngest = async (season?: number) => {
    if (!m) return;
    setBusy(`auto:${season ?? "m"}`);
    try {
      const r = await api<{ ok: boolean; job?: string; error?: string }>("/v1/ingest/auto", { body: { tmdbid: Number(id), type: m.type, ...(season !== undefined ? { seasons: [season] } : {}) } });
      if (!r.ok) throw new Error(r.error || "提交失败");
      toast("正在自动入库", "后台搜索并按选片规则挑选资源，选中后会出现在入库列表", { label: "查看入库", onPress: () => router.push("/pipeline") });
      if (r.job) void pollAuto(r.job);
    } catch (e) {
      toastError("未能自动入库", e);
    } finally {
      setBusy(null);
    }
  };
  // Report the outcome once the batch job ends (it takes 10–60 s): what was picked, or why nothing was.
  const pollAuto = async (job: string) => {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const j = await api<{ status?: string; results?: { error?: string; seasons: { season: number | null; action?: string; chosen?: { title: string }[] }[] }[] }>(`/v1/ingest/auto/${job}`).catch(() => null);
      if (!j || j.status !== "done") continue;
      const r = j.results?.[0];
      const lines = r?.error ? [r.error] : (r?.seasons ?? []).map((x) => `${x.season ? `第 ${x.season} 季：` : ""}${x.action ?? ""}${x.chosen?.[0] ? `（${x.chosen[0].title.slice(0, 60)}）` : ""}`);
      const okAny = (r?.seasons ?? []).some((x) => /已提交|订阅/.test(x.action ?? ""));
      toast(okAny ? "自动入库已完成选片" : "自动入库没有选到资源", lines.join("\n").slice(0, 300), okAny ? { label: "查看入库", onPress: () => router.push("/pipeline") } : undefined, !okAny);
      return;
    }
  };

  const subscribe = async (season?: number) => {
    if (!m) return;
    setBusy(`sub:${season ?? "m"}`);
    try {
      const r = await api<{ ok: boolean; message: string }>("/v1/subscriptions", { body: { tmdbid: Number(id), type: m.type, title: m.title, year: m.year, season } });
      if (r.ok) toast("已订阅", season !== undefined ? `第 ${season} 季，MoviePilot 会定时搜索缺的集` : "MoviePilot 会定时搜索");
      else toast("未能订阅", r.message, undefined, true);
      await load(key, () => api<MediaDetail>(`/v1/media/${type}/${id}`));
    } catch (e) {
      toastError("未能订阅", e);
    } finally {
      setBusy(null);
    }
  };

  const unsubscribe = (subId: number) =>
    confirm("取消订阅", "MoviePilot 将不再自动搜索这一季。已下载的内容不受影响。", "取消订阅", async () => {
      try {
        await api(`/v1/subscriptions/${subId}`, { method: "DELETE" });
        toast("已取消订阅");
        await load(key, () => api<MediaDetail>(`/v1/media/${type}/${id}`));
      } catch (e) {
        toastError("未能取消订阅", e);
      }
    }, true);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {!m ? <TopBar title="" /> : null}
      {error ? <ErrorBox text={error} onRetry={refresh} /> : null}
      {!m && loading ? <Loading /> : null}
      {m ? (
        <ScrollView contentContainerStyle={{ paddingBottom: 60 }} refreshControl={<Pull onRefresh={() => { void refresh(); void related.refresh(); }} />}>
          <HeroBackdrop source={img(m.backdrop ?? m.poster)} />
          <HeroHeader poster={img(m.poster)}>
            <View style={{ gap: 6 }}>
              <CopyText style={{ fontSize: 24, fontWeight: "800", color: colors.text, lineHeight: 29 }} numberOfLines={3}>{m.title}</CopyText>
              {m.originalTitle && m.originalTitle !== m.title ? <CopyText style={styles.faint}>{m.originalTitle}</CopyText> : null}
              <Text style={styles.faint}>{[m.date, m.country.join("/"), m.status === "Ended" ? "已完结" : m.status === "Returning Series" ? "连载中" : m.status].filter(Boolean).join(" · ")}</Text>
              <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
                <Tag text={m.type === "movie" ? "电影" : `剧集 · ${m.seasons ?? "?"} 季 ${m.episodes ?? "?"} 集`} color={colors.textSoft} />
                {m.vote ? <Tag text={`★ ${m.vote.toFixed(1)}`} color={colors.warning} /> : null}
                {m.genres.slice(0, 3).map((g) => <Tag key={g} text={g} color={colors.primary} />)}
              </View>
            </View>
          </HeroHeader>
          <View style={{ paddingHorizontal: 16, marginTop: 16 }}>
            {m.tagline ? <Text style={[styles.body, { fontStyle: "italic", color: colors.textSoft, marginBottom: 8 }]}>{m.tagline}</Text> : null}
            <CopyText label="简介" style={styles.body} numberOfLines={6}>{m.overview || "没有简介"}</CopyText>
            <SourceLink name="TMDb" url={`https://www.themoviedb.org/${m.type === "movie" ? "movie" : "tv"}/${id}`} style={{ marginTop: 14 }} />
            <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
              {m.imdb ? <Chip icon="open-outline" label="IMDb" onPress={() => void WebBrowser.openBrowserAsync(`https://www.imdb.com/title/${m.imdb}/`)} /> : null}
              <Chip icon="open-outline" label="豆瓣" onPress={() => void WebBrowser.openBrowserAsync(`https://search.douban.com/movie/subject_search?search_text=${encodeURIComponent(m.title)}`)} />
            </View>
            <TmdbMetaChips m={m} keywords={related.data?.keywords ?? []} />

            <SectionTitle title="Emby 媒体库" />
            <Card>
              {lib ? (
                <>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Tag text={`已入库 · ${lib.lib}`} color={colors.success} />
                    {lib.numbering === "tvdb" ? <Tag text="TVDB 分季" color={colors.textSoft} /> : null}
                  </View>
                  <CopyText style={[styles.faint, { marginTop: 8 }]}>{lib.path}</CopyText>
                  {Object.entries(lib.seasons ?? {}).map(([s, eps]) => (
                    <Text key={s} style={[styles.body, { marginTop: 4 }]}>{s === "0" ? "特别篇" : `第 ${s} 季`}：{eps.length} 集（{ranges(eps)}）</Text>
                  ))}
                  <PillButton small variant="soft" icon="albums-outline" label="在媒体库中查看" onPress={() => router.push({ pathname: "/emby/[id]", params: { id: lib.id ?? "" } })} style={{ marginTop: 12, alignSelf: "flex-start" }} />
                </>
              ) : (
                <Text style={styles.body}>媒体库里还没有这部作品。</Text>
              )}
            </Card>

            {m.type === "movie" ? (
              <View style={{ flexDirection: "row", gap: 10, marginTop: 18 }}>
                <PillButton small icon="search" label="搜索资源" onPress={() => search()} style={{ flex: 1 }} />
                <PillButton small variant="soft" icon="flash-outline" label="自动入库" loading={busy === "auto:m"} onPress={() => void autoIngest()} style={{ flex: 1 }} />
                {data.subscriptions.length ? (
                  <PillButton small variant="soft" label="已订阅" icon="checkmark" onPress={() => unsubscribe(data.subscriptions[0].id)} style={{ flex: 1 }} />
                ) : (
                  <PillButton small variant="soft" label="订阅" icon="bookmark-outline" loading={busy === "sub:m"} onPress={() => subscribe()} style={{ flex: 1 }} />
                )}
              </View>
            ) : (
              <>
                <SectionTitle title="分季" right={<Text style={styles.faint}>TMDb 集数 / 库里已有</Text>} />
                {data.seasons.filter((s) => s.season > 0 || s.episodes > 0).map((s) => {
                  const have = lib?.numbering === "tmdb" ? lib?.seasons?.[String(s.season)]?.length ?? 0 : null;
                  const sub = data.subscriptions.find((x) => x.season === s.season);
                  return (
                    <Card key={s.season} style={{ marginBottom: 10 }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                        <Text style={[styles.title, { flex: 1 }]}>{s.name}</Text>
                        <Text style={styles.faint}>{s.airDate?.slice(0, 4)} · {s.episodes} 集{have !== null ? ` / ${have}` : ""}</Text>
                      </View>
                      {have !== null && s.episodes ? <View style={{ marginTop: 8 }}><ProgressBar value={(have / s.episodes) * 100} color={have >= s.episodes ? colors.success : colors.primary} /></View> : null}
                      {sub ? <Text style={[styles.faint, { marginTop: 6 }]}>已订阅{sub.lack !== null ? `，还缺 ${sub.lack} 集` : ""}{sub.state === "S" ? "（暂停）" : ""}</Text> : null}
                      <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
                        <PillButton small icon="search" label="搜索资源" onPress={() => search(s.season)} />
                        <PillButton small variant="soft" icon="flash-outline" label="自动入库" loading={busy === `auto:${s.season}`} onPress={() => void autoIngest(s.season)} />
                        {s.season > 0 ? (
                          sub ? (
                            <PillButton small variant="soft" icon="checkmark" label="已订阅" onPress={() => unsubscribe(sub.id)} />
                          ) : (
                            <PillButton small variant="soft" icon="bookmark-outline" label="订阅" loading={busy === `sub:${s.season}`} onPress={() => subscribe(s.season)} />
                          )
                        ) : null}
                      </View>
                    </Card>
                  );
                })}
                {lib?.numbering === "tvdb" ? <Text style={styles.faint}>动漫库按 TheTVDB 分季，和 TMDb 的季可能对不上；以上面「Emby 媒体库」里的集数为准。</Text> : null}
              </>
            )}
          </View>
          <TmdbPeopleRow people={m.people ?? []} />
          <RelatedRows related={related.data} selfId={Number(id)} />
        </ScrollView>
      ) : null}
      <HeroBack />
    </View>
  );
}
