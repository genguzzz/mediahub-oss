import { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Linking, Pressable, ScrollView, Switch, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Card, CopyText, Chip, ChipRow, EmptyState, ErrorBox, IconButton, Loading, PillButton, Row, Screen, Sheet, Tag, TopBar, confirm, styles, tap, toast, toastError, Pull } from "@/components/ui";
import { SourceMeta } from "@/components/sources";
import { useConfig } from "@/lib/remoteConfig";
import { LANG_LABEL, api, type IngestResult, type MediaDetail, type Resource, type SearchName, type SearchResult, type Source } from "@/lib/api";
import { ago, bytes, ranges } from "@/lib/format";
import { useQuery } from "@/lib/query";
import { useSmartStream } from "@/lib/searchStream";
import { useSettings } from "@/lib/settings";
import { colors } from "@/lib/theme";

type Mode = "smart" | "raw" | "av" | "hentai";
type Sort = "score" | "seeders" | "size" | "date";

const ADULT_SOURCES: Record<"av" | "hentai", string[]> = { av: ["sukebei-av"], hentai: ["sukebei-anime"] };

export default function ResourcesScreen() {
  const p = useLocalSearchParams<{ mode?: string; tmdbid?: string; type?: string; season?: string; title?: string; keyword?: string }>();
  const router = useRouter();
  const showAdult = useSettings((s) => s.showAdult);
  const mySources = useSettings((s) => s.sources);
  const tmdbid = p.tmdbid ? Number(p.tmdbid) : undefined;
  const type = p.type === "movie" ? "movie" : "tv";
  const season = p.season ? Number(p.season) : undefined;
  const [mode, setMode] = useState<Mode>((p.mode as Mode) || (tmdbid ? "smart" : "raw"));
  // Multilingual names of the work (shared with the detail page's cache): the default keyword is the
  // first one (Chinese for Chinese works, Japanese for anime/Japanese, original otherwise).
  const detail = useQuery(tmdbid ? `media:${type}:${tmdbid}` : null, () => api<MediaDetail>(`/v1/media/${type}/${tmdbid}`), { staleMs: 60_000 });
  const names: SearchName[] = detail.data?.media.names ?? [];
  const [chosen, setChosen] = useState<string[] | null>(null);
  const keywords = chosen ?? [p.keyword || names[0]?.text || p.title || ""].filter(Boolean);
  const keyword = keywords[0] ?? "";
  const { defaultSources } = useConfig();
  const [pickedState, setPicked] = useState<string[] | null>(null);
  const picked = pickedState ?? (mode === "av" || mode === "hentai" ? ADULT_SOURCES[mode] : mySources ?? defaultSources);
  const [sourceSheet, setSourceSheet] = useState(false);
  // Raw searches wait for the names when there's a work, so the first search already uses the best keyword.
  const waiting = mode === "raw" && !!tmdbid && !p.keyword && !chosen && !detail.data && !detail.error;

  const body = mode === "smart"
    ? { tmdbid, type, season }
    : { tmdbid: mode === "raw" ? tmdbid : undefined, type, season: mode === "raw" ? season : undefined, keyword, keywords, sources: picked };
  const key = `res:${JSON.stringify(body)}`;
  // Smart search streams over SSE (keyword × indexer, sorted as each answers, next page on scroll). Source searches
  // go out one request per source (「全部已启用索引器」 = one per enabled Prowlarr indexer) and fill the list as each answers.
  const smart = useSmartStream(mode === "smart" && !waiting ? key : null, { tmdbid, type, season });
  const allSources = useQuery(mode !== "smart" ? "sources" : null, () => api<{ sources: Source[] }>("/v1/sources"), { staleMs: 60_000 });
  // The requests actually sent: 「全部已启用索引器」 expands to each enabled indexer. Sources that are switched off
  // or gone drop out quietly (a saved default can still name them); indexers Prowlarr has paused after failures
  // (downTill ahead) are left out and named in the header — Prowlarr would refuse them anyway.
  const [now] = useState(() => Date.now());
  const { expanded, skipped } = useMemo(() => {
    if (mode === "smart") return { expanded: null, skipped: [] as string[] };
    if (!allSources.data) return { expanded: picked.includes("prowlarr") ? null : picked, skipped: [] as string[] };
    const byId = new Map(allSources.data.sources.map((x) => [x.id, x]));
    const on = (id: string) => { const x = byId.get(id); return !!x && x.enabled !== false && x.prowlarrEnabled !== false; };
    const paused = (id: string) => { const x = byId.get(id); return !!x?.downTill && new Date(x.downTill).getTime() > now; };
    const all = picked.includes("prowlarr")
      ? [...new Set([...picked.filter((x) => x !== "prowlarr"), ...allSources.data.sources.filter((x) => x.kind === "prowlarr").map((x) => x.id)])]
      : picked;
    const live = all.filter(on);
    return { expanded: live.filter((x) => !paused(x)), skipped: live.filter(paused).map((x) => byId.get(x)?.name ?? x) };
  }, [mode, picked, allSources.data, now]);
  const streamQ = useStreamSearch(mode !== "smart" && !waiting ? key : null, body, expanded);
  const q = mode === "smart" ? smart : streamQ;
  const [kwText, setKwText] = useState<string | null>(null);
  const editKeyword = () => {
    const v = (kwText ?? "").trim();
    if (!v) return;
    setChosen([v, ...keywords.slice(1).filter((k) => k !== v)]);
    setKwText(null);
    if (mode === "smart") setMode("raw");
  };

  // ---- filters ----
  const [src, setSrc] = useState<string | null>(null);
  const [group, setGroup] = useState<string | null>(null);
  const [res, setRes] = useState<string | null>(null);
  const [cnOnly, setCnOnly] = useState(false);
  const [packOnly, setPackOnly] = useState(false);
  const [hideHave, setHideHave] = useState(false);
  const [hideExcluded, setHideExcluded] = useState(true);
  const [sort, setSort] = useState<Sort>("score");
  const [open, setOpen] = useState<Resource | null>(null);
  const [submitted, setSubmitted] = useState<Record<string, true>>({});

  const all = q.data?.results;
  const list = useMemo(() => {
    let r = all ?? [];
    if (src) r = r.filter((x) => x.source === src);
    if (group) r = r.filter((x) => x.group === group);
    if (res) r = r.filter((x) => (x.res || "").toLowerCase().includes(res.toLowerCase()));
    if (cnOnly) r = r.filter((x) => x.tags.includes("中字"));
    if (packOnly) r = r.filter((x) => x.episodes.length === 0 || x.episodes.length >= 6);
    if (hideHave) r = r.filter((x) => !(x.have > 0 && x.have >= Math.max(1, x.episodes.length)));
    if (hideExcluded) r = r.filter((x) => !x.excluded);
    const by: Record<Sort, (a: Resource, b: Resource) => number> = {
      score: (a, b) => Number(b.recommended) - Number(a.recommended) || (b.score ?? -999) - (a.score ?? -999) || b.seeders - a.seeders,
      seeders: (a, b) => b.seeders - a.seeders,
      size: (a, b) => b.size - a.size,
      date: (a, b) => b.pubdate.localeCompare(a.pubdate),
    };
    return [...r].sort(by[sort]);
  }, [all, src, group, res, cnOnly, packOnly, hideHave, hideExcluded, sort]);

  const excludedCount = (all ?? []).filter((x) => x.excluded).length;
  const kind = mode === "av" ? "av" : mode === "hentai" ? "hentai" : "media";
  const title = mode === "av" ? `AV · ${keyword}` : mode === "hentai" ? `里番 · ${keyword}` : `${p.title || keyword}${season !== undefined && type === "tv" ? ` 第 ${season} 季` : ""}`;

  return (
    <Screen>
      <TopBar title={title} right={<IconButton name="options-outline" label="来源" onPress={() => setSourceSheet(true)} />} />
      {tmdbid && (mode === "smart" || mode === "raw") ? (
        <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 16, marginBottom: 8 }}>
          <Chip label="智能搜索（MP 识别）" active={mode === "smart"} onPress={() => setMode("smart")} />
          <Chip label="按来源搜索" active={mode === "raw"} onPress={() => setMode("raw")} />
        </View>
      ) : null}
      {/* The keyword itself is editable here; more keywords and the sources are in the sheet. */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: 16, marginBottom: 6, paddingHorizontal: 12, height: 42, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card }}>
        <Ionicons name="search" size={16} color={colors.textFaint} />
        <TextInput
          value={kwText ?? keyword}
          onChangeText={setKwText}
          onSubmitEditing={editKeyword}
          returnKeyType="search"
          autoCorrect={false}
          autoCapitalize="none"
          clearButtonMode="while-editing"
          placeholder="关键词"
          placeholderTextColor={colors.textFaint}
          style={{ flex: 1, fontSize: 15, color: colors.text }}
        />
      </View>
      {mode !== "smart" ? (
        <Pressable onPress={() => { tap(); setSourceSheet(true); }} style={{ marginHorizontal: 16, marginBottom: 8 }}>
          <Text style={styles.faint} numberOfLines={2}>{keywords.length > 1 ? `另有 ${keywords.length - 1} 个关键词 · ` : ""}来源 {expanded?.length ?? picked.length} 个{skipped.length ? `（${skipped.join("、")} 暂停中，已跳过）` : ""}{q.progress && q.progress.done < q.progress.total ? ` · ${q.progress.done}/${q.progress.total} 个已返回` : ""} · 点这里修改</Text>
        </Pressable>
      ) : null}

      {q.data ? (
        <>
          <ChipRow style={{ marginBottom: 6 }}>
            <Chip label="全部来源" active={!src} onPress={() => setSrc(null)} count={q.data.results.length} />
            {q.data.sources.map(([s, n]) => <Chip key={s} label={s} active={src === s} onPress={() => setSrc(src === s ? null : s)} count={n} />)}
          </ChipRow>
          {q.data.groups.length ? (
            <ChipRow style={{ marginBottom: 6 }}>
              <Chip label="全部字幕组" active={!group} onPress={() => setGroup(null)} />
              {q.data.groups.slice(0, 40).map(([g, n]) => <Chip key={g} label={g} active={group === g} onPress={() => setGroup(group === g ? null : g)} count={n} />)}
            </ChipRow>
          ) : null}
          <ChipRow style={{ marginBottom: 8 }}>
            {(["score", "seeders", "size", "date"] as Sort[]).map((s) => (
              <Chip key={s} icon="swap-vertical" label={{ score: "推荐", seeders: "做种", size: "大小", date: "时间" }[s]} active={sort === s} onPress={() => setSort(s)} />
            ))}
            {["2160p", "1080p", "720p"].map((r) => <Chip key={r} label={r} active={res === r} onPress={() => setRes(res === r ? null : r)} />)}
            <Chip label="中字" active={cnOnly} onPress={() => setCnOnly(!cnOnly)} />
            <Chip label="合集" active={packOnly} onPress={() => setPackOnly(!packOnly)} />
            {q.data.library ? <Chip label="隐藏已有" active={hideHave} onPress={() => setHideHave(!hideHave)} /> : null}
            {excludedCount ? <Chip label={`显示被排除的 ${excludedCount}`} active={!hideExcluded} onPress={() => setHideExcluded(!hideExcluded)} /> : null}
          </ChipRow>
        </>
      ) : null}

      <FlatList
        data={list}
        keyExtractor={(r) => r.id}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 60, gap: 8 }}
        refreshControl={<Pull onRefresh={q.refresh} />}
        ListHeaderComponent={
          <>
            {q.error ? <ErrorBox text={q.error} onRetry={q.refresh} /> : null}
            {q.data?.error ? <ErrorBox text={`部分来源出错：${q.data.error}`} /> : null}
            {q.loading && !q.data ? <Loading text={q.progress ? `正在搜索 ${q.progress.total} 个来源，先返回的先显示（${q.progress.done}/${q.progress.total}）` : mode === "smart" ? "正在准备关键词和来源" : "正在搜索所选来源"} /> : null}
            {q.data ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <Text style={[styles.faint, { flex: 1 }]}>
                  {q.data.mode === "smart" ? "智能搜索" : "按来源"} · {q.data.results.length} 条，显示 {list.length} 条 · {q.data.elapsed} 秒
                  {q.progress && q.progress.done < q.progress.total ? ` · ${q.progress.done}/${q.progress.total} 个来源已返回` : ""}
                  {q.data.library && type === "tv" ? ` · 库里本季已有 ${q.data.library.have.length}/${q.data.library.aired.length} 集` : ""}
                </Text>
                {mode === "smart" && smart.busy && smart.open ? <PillButton small variant="soft" icon="stop-circle-outline" label="停止" onPress={smart.stop} /> : null}
              </View>
            ) : null}
          </>
        }
        ListEmptyComponent={q.data ? (
          hideExcluded && excludedCount && all?.length === excludedCount ? (
            <EmptyState icon="funnel-outline" text={`找到 ${excludedCount} 条，都被选片策略排除了（${[...new Set((all ?? []).map((x) => x.excluded).filter(Boolean))].slice(0, 2).join("；")}）`} action={<PillButton small variant="soft" icon="eye-outline" label="显示这些资源" onPress={() => setHideExcluded(false)} />} />
          ) : (
            <EmptyState icon="file-tray-outline" text={mode === "smart" ? "没有符合条件的资源。可以放宽筛选，或换成「按来源搜索」。" : "没有符合条件的资源。可以放宽筛选，换个关键词，或多选几个来源。"} />
          )
        ) : undefined}
        renderItem={({ item }) => <ResourceRow r={item} submitted={!!submitted[item.id]} onPress={() => setOpen(item)} />}
        onEndReached={mode === "smart" ? smart.more : undefined}
        onEndReachedThreshold={0.6}
        ListFooterComponent={mode === "smart" && smart.data ? (
          <Text style={[styles.faint, { textAlign: "center", paddingVertical: 12 }]}>
            {smart.loadingMore ? "正在取下一页…" : smart.hasMore ? "继续上滑加载更多" : smart.open || smart.data.results.length ? "各来源都没有更多了" : ""}
          </Text>
        ) : undefined}
      />

      <ResourceSheet
        r={open}
        kind={kind}
        canIngest={kind !== "media" || !!tmdbid}
        target={{ tmdbid, type, season: season ?? q.data?.season ?? undefined }}
        onClose={() => setOpen(null)}
        onDone={(id) => setSubmitted((s) => ({ ...s, [id]: true }))}
        onPickWork={() => { setOpen(null); router.push("/"); }}
      />
      <SourceSheet
        visible={sourceSheet}
        onClose={() => setSourceSheet(false)}
        picked={picked}
        keywords={keywords}
        names={names}
        showAdult={showAdult || mode === "av" || mode === "hentai"}
        onApply={(k, s) => { setChosen(k); setPicked(s); if (mode === "smart") setMode("raw"); setSourceSheet(false); }}
      />
    </Screen>
  );
}

function ResourceRow({ r, submitted, onPress }: { r: Resource; submitted: boolean; onPress: () => void }) {
  const eps = r.episodes.length ? (r.episodes.length > 1 ? `第 ${ranges(r.episodes)} 集` : `第 ${r.episodes[0]} 集`) : r.se;
  return (
    <Card onPress={onPress} style={{ padding: 12, opacity: r.excluded ? 0.6 : 1 }}>
      <View style={{ flexDirection: "row", gap: 6, alignItems: "center", marginBottom: 6, flexWrap: "wrap" }}>
        {r.recommended ? <Tag text="推荐" color={colors.success} solid /> : null}
        {submitted ? <Tag text="已提交" color={colors.primary} solid /> : null}
        {r.score !== null ? <Tag text={`${r.score} 分`} color={r.score >= 60 ? colors.success : r.score >= 35 ? colors.primary : colors.textSoft} /> : null}
        {r.group ? <Tag text={r.group} color={colors.warning} /> : null}
        {r.res ? <Tag text={r.res} color={colors.textSoft} /> : null}
        {r.tags.map((t) => <Tag key={t} text={t} color={t === "中字" || t === "内封" ? colors.primary : colors.textSoft} />)}
        {r.have ? <Tag text={`库里已有 ${r.have} 集`} color={colors.success} /> : null}
      </View>
      <Text style={{ fontSize: 14, lineHeight: 19, color: colors.text }} numberOfLines={3}>{r.title}</Text>
      <View style={{ flexDirection: "row", gap: 12, marginTop: 6, flexWrap: "wrap" }}>
        <Meta icon="server-outline" text={bytes(r.size)} />
        <Meta icon="arrow-up-circle-outline" text={String(r.seeders)} color={r.seeders >= 10 ? colors.success : r.seeders > 0 ? colors.textSoft : colors.danger} />
        <Meta icon="globe-outline" text={r.source} />
        {eps ? <Meta icon="albums-outline" text={eps} /> : null}
        {r.pubdate ? <Meta icon="time-outline" text={r.pubdate.slice(0, 10)} /> : null}
      </View>
      {r.excluded ? <Text style={[styles.faint, { marginTop: 4, color: colors.danger }]} numberOfLines={1}>{r.excluded}</Text> : null}
    </Card>
  );
}

function Meta({ icon, text, color }: { icon: keyof typeof Ionicons.glyphMap; text: string; color?: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
      <Ionicons name={icon} size={12} color={color ?? colors.textFaint} />
      <Text style={{ fontSize: 12, color: color ?? colors.textSoft }}>{text}</Text>
    </View>
  );
}

function ResourceSheet({ r, kind, canIngest, target, onClose, onDone, onPickWork }: {
  r: Resource | null;
  kind: "media" | "av" | "hentai";
  canIngest: boolean;
  target: { tmdbid?: number; type: "movie" | "tv"; season?: number };
  onClose: () => void;
  onDone: (id: string) => void;
  onPickWork: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [now] = useState(() => Date.now());
  if (!r) return null;

  const send = async (dryRun: boolean) =>
    api<IngestResult & { results?: unknown }>("/v1/ingest", {
      body: { kind, magnet: r.magnet, title: r.title, tmdbid: target.tmdbid, type: target.type, season: target.type === "tv" ? target.season : undefined, dryRun },
      timeoutMs: 95_000,
    });

  const ingest = async () => {
    setBusy(true);
    try {
      if (kind === "media") {
        const plan = await send(true);
        if (!plan.ok) throw new Error(plan.error || "未能计算保存目录");
        setBusy(false);
        const warn = plan.warnings?.length ? `\n\n⚠️ ${plan.warnings.join("\n⚠️ ")}` : "";
        confirm(warn ? "入库前请确认" : "入库到 115", `保存到：\n${plan.dir}${warn}\n\n提交 115 离线后会自动生成 strm、通知 Emby 刮削。`, warn ? "仍然入库" : "入库", async () => {
          setBusy(true);
          try {
            const out = await send(false);
            if (!out.ok) throw new Error(out.error || "提交失败");
            onDone(r.id);
            onClose();
            toast("已提交 115 离线", out.dir, { label: "查看进度", onPress: () => router.push("/pipeline") });
          } catch (e) {
            toastError("未能入库", e);
          } finally {
            setBusy(false);
          }
        });
        return;
      }
      const out = await send(false);
      const arr = Array.isArray(out) ? (out as unknown[]) : Array.isArray(out.results) ? out.results : null;
      const first = arr?.[0] as { ok?: boolean; error?: string } | undefined;
      const ok = first?.ok ?? out.ok;
      if (ok === false) throw new Error(out.error || first?.error || "提交失败");
      onDone(r.id);
      onClose();
      toast("已提交", kind === "av" ? "115 离线完成后交给 MDC 刮削" : "按系列入库，Bangumi 插件刮削", { label: "查看进度", onPress: () => router.push("/pipeline") });
    } catch (e) {
      toastError("未能入库", e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet visible={!!r} onClose={onClose} scroll>
      <CopyText style={{ fontSize: 15, lineHeight: 21, fontWeight: "600", color: colors.text }}>{r.title}</CopyText>
      <View style={{ marginTop: 10 }}>
        <Row label="来源" value={`${r.source}${r.indexer && r.indexer !== r.source ? ` · ${r.indexer}` : ""}`} />
        <Row label="字幕组" value={r.group} />
        <Row label="规格" value={[r.res, r.codec, r.rtype, r.effect].filter(Boolean).join(" · ")} />
        <Row label="大小" value={bytes(r.size)} />
        <Row label="做种 / 下载" value={`${r.seeders} / ${r.peers}`} />
        <Row label="季集" value={r.episodes.length ? `${r.season ? `S${r.season} ` : ""}${ranges(r.episodes)}` : r.se} />
        <Row label="发布" value={r.pubdate ? `${r.pubdate}（${ago(r.pubdate, now)}）` : ""} />
        <Row label="打分" value={r.excluded ? r.excluded : `${r.score} 分：${r.why.join(" ")}`} />
        {r.have ? <Row label="媒体库" value={`这些集里已有 ${r.have} 集，入库会替换成这个版本`} /> : null}
        <Row label="hash" value={r.id} />
      </View>
      {canIngest ? (
        <PillButton icon="cloud-download-outline" label={kind === "media" ? "入库（115 离线）" : kind === "av" ? "AV 入库" : "里番入库"} loading={busy} onPress={ingest} style={{ marginTop: 14 }} />
      ) : (
        <View style={{ marginTop: 14, gap: 8 }}>
          <Text style={styles.body}>按关键词搜到的资源要先选定作品（TMDb）才能入库，这样才知道放进哪个目录、哪一季。</Text>
          <PillButton icon="search" label="去搜索作品" onPress={onPickWork} />
        </View>
      )}
      <View style={{ flexDirection: "row", gap: 10, marginTop: 10 }}>
        <PillButton small variant="soft" icon="copy-outline" label="复制磁力" style={{ flex: 1 }} onPress={async () => { await Clipboard.setStringAsync(r.magnet); toast("已复制磁力链接"); }} />
        {r.page && r.page.startsWith("http") ? <PillButton small variant="soft" icon="open-outline" label="打开页面" style={{ flex: 1 }} onPress={() => void Linking.openURL(r.page)} /> : null}
      </View>
    </Sheet>
  );
}

function SourceSheet({ visible, onClose, picked, keywords, names, showAdult, onApply }: {
  visible: boolean;
  onClose: () => void;
  picked: string[];
  keywords: string[];
  names: SearchName[];
  showAdult: boolean;
  onApply: (keywords: string[], sources: string[]) => void;
}) {
  const router = useRouter();
  const q = useQuery(visible ? "sources" : null, () => api<{ sources: Source[] }>("/v1/sources"), { staleMs: 60_000 });
  const [sel, setSel] = useState<string[] | null>(null);
  const [kws, setKws] = useState<string[] | null>(null);
  const [text, setText] = useState("");
  const cur = sel ?? picked;
  const curKw = kws ?? keywords;
  const toggle = (id: string) => setSel(cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
  const toggleKw = (k: string) => setKws(curKw.includes(k) ? curKw.filter((x) => x !== k) : [...curKw, k].slice(-4));
  // Candidate chips: the work's names plus anything typed or chosen before.
  const cands: { text: string; label?: string }[] = [
    ...names.map((n) => ({ text: n.text, label: LANG_LABEL[n.lang] })),
    ...curKw.filter((k) => !names.some((n) => n.text === k)).map((k) => ({ text: k })),
  ];
  const final = [...new Set([...curKw, text.trim()].filter(Boolean))].slice(0, 4);
  const go = () => {
    if (!final.length || !cur.length) return;
    onApply(final, cur);
    setSel(null);
    setKws(null);
    setText("");
  };
  const groups: { title: string; items: Source[] }[] = [
    { title: "直连（后端直接访问）", items: (q.data?.sources ?? []).filter((s) => s.kind === "direct") },
    { title: "Prowlarr（NAS，可单选索引器）", items: [{ id: "prowlarr", name: "全部已启用索引器", kind: "prowlarr", enabled: true, note: "所有在 Prowlarr 里启用的索引器一起搜" } as Source, ...(q.data?.sources ?? []).filter((s) => s.kind === "prowlarr" && s.prowlarrEnabled !== false)] },
    ...(showAdult ? [{ title: "隐藏", items: (q.data?.sources ?? []).filter((s) => s.kind === "adult") }] : []),
  ];
  const searchButton = <PillButton label={`搜索 · ${final.length} 个关键词 · ${cur.length} 个来源`} icon="search" disabled={!cur.length || !final.length} onPress={go} />;
  return (
    <Sheet visible={visible} onClose={() => { setSel(null); setKws(null); onClose(); }} title="按来源搜索" scroll footer={searchButton}>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <TextInput
          value={text}
          onChangeText={setText}
          onSubmitEditing={go}
          returnKeyType="search"
          placeholder="添加关键词（可选多个，最多 4 个）"
          placeholderTextColor={colors.textFaint}
          autoCorrect={false}
          autoCapitalize="none"
          style={{ flex: 1, height: 44, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.cardMuted, paddingHorizontal: 12, fontSize: 15, color: colors.text }}
        />
        <Pressable
          accessibilityLabel="搜索"
          disabled={!cur.length || !final.length}
          onPress={() => { tap(); go(); }}
          style={({ pressed }) => ({ width: 44, height: 44, borderRadius: 12, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center", opacity: !cur.length || !final.length ? 0.4 : pressed ? 0.8 : 1 })}
        >
          <Ionicons name="search" size={20} color={colors.onPrimary} />
        </Pressable>
      </View>
      {cands.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 8 }} contentContainerStyle={{ gap: 6 }} keyboardShouldPersistTaps="handled">
          {cands.map((c) => <Chip key={c.text} label={c.label ? `${c.label} · ${c.text}` : c.text} active={curKw.includes(c.text)} onPress={() => toggleKw(c.text)} />)}
        </ScrollView>
      ) : null}
      <Text style={[styles.faint, { marginTop: 6 }]}>选中的每个关键词都会在所选来源里各搜一遍再合并。英文名、罗马音在 Nyaa 上更全，中文名适合 Mikan 和 dmhy。不做季过滤，结果原样列出并打分。</Text>
      {q.loading && !q.data ? <Loading /> : null}
      {q.error ? <ErrorBox text={q.error} onRetry={q.refresh} /> : null}
      {groups.map((g) => (
        <View key={g.title} style={{ marginTop: 12 }}>
          <Text style={[styles.title, { marginBottom: 4 }]}>{g.title}</Text>
          {g.items.map((s) => (
            <Pressable key={s.id} onPress={() => toggle(s.id)} style={{ flexDirection: "row", alignItems: "center", paddingVertical: 8, gap: 10, opacity: s.enabled ? 1 : 0.5 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 15, fontWeight: "600", color: colors.text }}>{s.name}{s.enabled ? "" : "（插件里已排除）"}</Text>
                <SourceMeta s={s} lines={1} />
              </View>
              <Switch value={cur.includes(s.id)} onValueChange={() => toggle(s.id)} trackColor={{ true: colors.primary }} />
            </Pressable>
          ))}
        </View>
      ))}
      <PillButton small variant="soft" icon="settings-outline" label="管理索引源（默认来源、添加 Prowlarr 索引器）" onPress={() => { onClose(); router.push("/indexers"); }} style={{ marginTop: 12, alignSelf: "center" }} />
    </Sheet>
  );
}

// Source search, one request per source, merged as they answer (de-duplicated by magnet); the chips'
// counts come from the merged list. `refresh` runs it again.
function useStreamSearch(key: string | null, body: Record<string, unknown>, sources: string[] | null) {
  const [nonce, setNonce] = useState(0);
  const [st, setSt] = useState<{ run: string; data: SearchResult | null; done: number; total: number } | null>(null);
  const bodyRef = useRef(body);
  useEffect(() => { bodyRef.current = body; });
  const run = key && sources ? `${key}#${sources.join(",")}#${nonce}` : null;
  useEffect(() => {
    if (!run || !sources?.length) return;
    let alive = true;
    const t0 = Date.now();
    const seen = new Set<string>();
    const errors: string[] = [];
    let merged: SearchResult | null = null;
    let done = 0;
    const count = (rs: Resource[], f: (r: Resource) => string | undefined): [string, number][] => {
      const m = new Map<string, number>();
      for (const r of rs) { const k = f(r); if (k) m.set(k, (m.get(k) ?? 0) + 1); }
      return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };
    for (const one of sources) {
      void api<SearchResult>("/v1/search", { body: { ...bodyRef.current, sources: [one] }, timeoutMs: 160_000 })
        .then((r) => {
          const add = r.results.filter((x) => { const k = x.magnet || x.id; if (seen.has(k)) return false; seen.add(k); return true; });
          const prev: SearchResult | null = merged;
          merged = { ...(prev ?? r), results: [...(prev?.results ?? []), ...add] };
          if (r.error && !errors.includes(r.error)) errors.push(r.error);
        })
        .catch((e: unknown) => { errors.push(`${one}：${e instanceof Error ? e.message : String(e)}`); })
        .finally(() => {
          done++;
          if (!alive) return;
          const m: SearchResult | null = merged;
          setSt({
            run,
            done,
            total: sources.length,
            data: m ? { ...m, sources: count(m.results, (x) => x.source), groups: count(m.results, (x) => x.group || undefined), elapsed: Math.round((Date.now() - t0) / 100) / 10, error: errors.join("；") || null } : null,
          });
        });
    }
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);
  const cur = st && st.run === run ? st : null;
  const failedAll = cur && cur.done === cur.total && !cur.data;
  const none = !!run && sources?.length === 0;   // every picked source is paused or switched off
  return {
    data: cur?.data ?? undefined,
    loading: !!run && !none && (!cur || cur.done < cur.total),
    error: none ? "选中的来源都暂停中或已停用，换几个来源再搜" : failedAll ? "所有来源都没有返回结果" : undefined,
    refresh: () => setNonce((n) => n + 1),
    progress: run && sources ? { done: cur?.done ?? 0, total: sources.length } : null,
  };
}

