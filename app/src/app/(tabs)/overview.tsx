import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, type Href } from "expo-router";
import { PosterTile, Row } from "@/components/media";
import { useOpenMedia } from "@/components/mediaCards";
import { ErrorBox, Loading, ProgressBar, Pull, TAB_BAR_SPACE, TabHeader, styles, tap } from "@/components/ui";
import { LibraryGrid, StorageCard } from "@/components/SystemCards";
import { api, img, pipelineQuery, statsQuery, type EmbyActivity, type Health, type HistoryItem, type Overview } from "@/lib/api";
import { useSettings } from "@/lib/settings";
import { ago, pct, speed } from "@/lib/format";
import { useQuery } from "@/lib/query";
import { colors, radius, shadow } from "@/lib/theme";

// Everything at a glance: pipeline counts, what is being ingested right now, MoviePilot's latest
// downloads (tap → the same detail page as search), Emby jobs.
export default function OverviewTab() {
  const router = useRouter();
  const open = useOpenMedia();
  const ov = useQuery("overview", () => api<Overview>("/v1/overview", { timeoutMs: 45_000 }), { interval: 30_000, staleMs: 10_000 });
  const pipe = useQuery("pipeline", pipelineQuery, { interval: 15_000, staleMs: 10_000 });
  const emby = useQuery("emby:activity", () => api<EmbyActivity>("/v1/emby/activity"), { interval: 30_000 });
  const hist = useQuery("history:1", () => api<{ items: HistoryItem[] }>("/v1/history?page=1"), { staleMs: 60_000 });
  const stats = useQuery("stats", () => statsQuery(), { interval: 120_000, staleMs: 60_000 });
  const health = useQuery("health", () => api<Health>("/v1/health"), { staleMs: 300_000 });
  const issues = (health.data?.ok ? health.data.checks : []).filter((c) => c.count && c.severity !== "info");
  const showAdult = useSettings((s) => s.showAdult);
  const libs = (stats.data?.libraries ?? []).filter((l) => showAdult || !l.adult);
  const [now] = useState(() => Date.now());
  const p = ov.data?.pipeline;
  const running = emby.data?.running ?? [];
  const active = (pipe.data?.tasks ?? []).filter((t) => ["downloading", "buffer", "uploaded"].includes(t.status) || (t.status === "done" && !t.emby)).slice(0, 4);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <TabHeader title="概览" />
      <ScrollView
        contentContainerStyle={{ paddingBottom: TAB_BAR_SPACE }}
        refreshControl={<Pull onRefresh={() => Promise.all([ov.refresh(), pipe.refresh(), emby.refresh(), hist.refresh(), stats.refresh(), health.refresh()])} />}
      >
        <View style={{ paddingHorizontal: 16 }}>
          {ov.error ? <ErrorBox text={ov.error} onRetry={ov.refresh} /> : null}
          {ov.data?.errors.length ? <ErrorBox text={`部分服务未响应：${ov.data.errors.join("；").slice(0, 160)}`} /> : null}
          {!ov.data && ov.loading ? <Loading /> : null}

          <View style={{ flexDirection: "row", gap: 10 }}>
            <Stat icon="cloud-download" tint={colors.primary} label="下载中" value={p?.downloading} href="/pipeline" />
            <Stat icon="sparkles" tint={colors.success} label="待刮削" value={p?.waiting} href="/pipeline" />
            <Stat icon="alert-circle" tint={colors.danger} label="失败" value={p?.failed} href="/pipeline" warn />
          </View>
          <View style={{ flexDirection: "row", gap: 10, marginTop: 10 }}>
            <Stat icon="speedometer" tint={colors.warning} label="qB 下行" value={ov.data?.qb ? speed(ov.data.qb.dl) : undefined} href="/manage?seg=downloads" small />
            <Stat icon="bookmarks" tint={colors.primary} label="订阅" value={ov.data?.subscriptions ?? undefined} href="/subscriptions" small />
            <Stat icon="film" tint={colors.textSoft} label="AV 刮削" value={p?.av} href="/pipeline" small />
          </View>
        </View>

        {issues.length ? (
          <View style={{ paddingHorizontal: 16, marginTop: 24 }}>
            <Header title="需要处理" onMore={() => router.push("/health")} />
            <Pressable onPress={() => { tap(); router.push("/health"); }} style={({ pressed }) => ({ backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.warning + "66", padding: 14, gap: 8, opacity: pressed ? 0.85 : 1, ...shadow() })}>
              {issues.map((c) => (
                <View key={c.key} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Ionicons name={c.severity === "error" ? "alert-circle" : "warning"} size={16} color={c.severity === "error" ? colors.danger : colors.warning} />
                  <Text style={[styles.body, { flex: 1 }]}>{c.title}</Text>
                  <Text style={{ fontWeight: "800", color: colors.text }}>{c.count}</Text>
                </View>
              ))}
            </Pressable>
          </View>
        ) : null}

        <View style={{ paddingHorizontal: 16, marginTop: 24 }}>
          <Header title="存储" onMore={() => router.push("/stats")} />
          <StorageCard s={stats.data?.storage} onPress={() => router.push("/stats")} />
        </View>

        {libs.length ? (
          <View style={{ paddingHorizontal: 16, marginTop: 24 }}>
            <Header title="媒体库" onMore={() => router.push("/stats")} />
            <LibraryGrid libs={libs} onPress={() => router.push("/stats")} />
          </View>
        ) : stats.loading && !stats.data ? <Loading /> : null}

        {active.length ? (
          <View style={{ paddingHorizontal: 16, marginTop: 24 }}>
            <Header title="正在入库" onMore={() => router.push("/pipeline")} />
            <View style={{ backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, ...shadow() }}>
              {active.map((t, i) => (
                <Pressable key={t.hash} onPress={() => { tap(); router.push({ pathname: "/task/[hash]", params: { hash: t.hash } }); }} style={({ pressed }) => ({ padding: 14, borderTopWidth: i ? 1 : 0, borderColor: colors.border, opacity: pressed ? 0.85 : 1 })}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Text style={[styles.title, { flex: 1 }]} numberOfLines={1}>{t.title}{t.type === "tv" && t.season ? ` · 第 ${t.season} 季` : ""}</Text>
                    <Text style={{ fontSize: 12, color: colors.primary, fontWeight: "700" }}>{t.status === "downloading" || t.status === "buffer" ? pct(t.percent) || t.stage : t.stage}</Text>
                  </View>
                  {t.status === "downloading" || t.status === "buffer" ? <View style={{ marginTop: 8 }}><ProgressBar value={t.percent} /></View> : null}
                </Pressable>
              ))}
            </View>
          </View>
        ) : null}

        {hist.data?.items.length ? (
          <Row title="最近下载" onMore={() => router.push("/history")}>
            {hist.data.items.slice(0, 20).map((h) => (
              <PosterTile
                key={h.id}
                w={124}
                c={{
                  key: String(h.id),
                  title: h.title,
                  subtitle: [h.se, ago(h.date, now)].filter(Boolean).join(" · "),
                  poster: img(h.poster),
                  onPress: () => void open({ type: h.type, tmdbid: h.tmdbid, title: h.title, year: h.year }),
                }}
              />
            ))}
          </Row>
        ) : hist.loading ? <Loading /> : null}

        <View style={{ paddingHorizontal: 16, marginTop: 24 }}>
          <Header title="Emby" onMore={() => router.push("/")} />
          <View style={{ backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: 14, ...shadow() }}>
            {running.length ? (
              running.map((r) => (
                <View key={r.id} style={{ marginBottom: 10 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Ionicons name="sync" size={15} color={colors.primary} />
                    <Text style={[styles.title, { flex: 1 }]}>{r.name === "Scan media library" ? "正在扫描媒体库" : `正在运行：${r.name}`}</Text>
                    <Text style={styles.faint}>{pct(r.progress)}</Text>
                  </View>
                  <View style={{ marginTop: 8 }}><ProgressBar value={r.progress} /></View>
                </View>
              ))
            ) : (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Ionicons name="checkmark-circle" size={16} color={colors.success} />
                <Text style={styles.body}>没有正在运行的扫描或刮削任务</Text>
              </View>
            )}
            {(emby.data?.log ?? []).filter((l) => !/Authentication|Session/i.test(l.type)).slice(0, 6).map((l, i) => (
              <View key={`${l.date}${i}`} style={{ flexDirection: "row", gap: 10, marginTop: 10 }}>
                <Text style={[styles.faint, { width: 64 }]}>{ago(l.date, now)}</Text>
                <Text style={[styles.faint, { flex: 1, color: colors.textSoft }]} numberOfLines={2}>{l.name}</Text>
              </View>
            ))}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

function Header({ title, onMore }: { title: string; onMore?: () => void }) {
  return (
    <Pressable disabled={!onMore} onPress={() => { tap(); onMore?.(); }} style={{ flexDirection: "row", alignItems: "center", marginBottom: 10 }}>
      <Text style={{ fontSize: 19, fontWeight: "800", color: colors.text, flex: 1 }}>{title}</Text>
      {onMore ? <Ionicons name="chevron-forward" size={18} color={colors.textFaint} /> : null}
    </Pressable>
  );
}

function Stat({ icon, tint, label, value, warn, small, href }: { icon: keyof typeof Ionicons.glyphMap; tint: string; label: string; value: number | string | undefined; warn?: boolean; small?: boolean; href: Href }) {
  const router = useRouter();
  const n = typeof value === "number" ? value : 0;
  const hot = warn && n > 0;
  return (
    <Pressable
      onPress={() => { tap(); router.push(href); }}
      style={({ pressed }) => ({ flex: 1, backgroundColor: hot ? colors.danger + "18" : colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: hot ? colors.danger + "55" : colors.border, padding: 12, opacity: pressed ? 0.85 : 1, ...shadow() })}
    >
      <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: tint + "22", alignItems: "center", justifyContent: "center" }}>
        <Ionicons name={icon} size={15} color={tint} />
      </View>
      <Text style={{ fontSize: small ? 17 : 26, fontWeight: "800", color: hot ? colors.danger : colors.text, marginTop: 8 }} numberOfLines={1}>{value ?? "—"}</Text>
      <Text style={[styles.faint, { marginTop: 2 }]}>{label}</Text>
    </Pressable>
  );
}
