import { useState } from "react";
import { ScrollView, Switch, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { BUILTIN_SOURCES, SourceMeta } from "@/components/sources";
import { Card, ErrorBox, IconButton, Loading, PillButton, Pull, Screen, SectionTitle, TopBar, confirm, styles, toast, toastError } from "@/components/ui";
import { api, type Source } from "@/lib/api";
import { invalidate, useQuery } from "@/lib/query";
import { setSettings, useSettings } from "@/lib/settings";
import { colors } from "@/lib/theme";
import { track } from "@/lib/track";

// Settings → 索引源: which sources 按来源搜索 starts with (stored on the phone), and the Prowlarr
// indexers themselves (enable/disable/delete in Prowlarr, add more from its catalog).
export default function IndexersScreen() {
  const router = useRouter();
  const q = useQuery("sources", () => api<{ sources: Source[] }>("/v1/sources"), { staleMs: 60_000 });
  const mine = useSettings((s) => s.sources);
  const showAdult = useSettings((s) => s.showAdult);
  const defaults = mine ?? BUILTIN_SOURCES;
  const [busy, setBusy] = useState<number | null>(null);
  const all = q.data?.sources ?? [];
  const toggleDefault = (id: string) => setSettings({ sources: defaults.includes(id) ? defaults.filter((x) => x !== id) : [...defaults, id] });

  const act = async (s: Source, body: Record<string, unknown>, done: string) => {
    setBusy(s.pid ?? null);
    try {
      const r = await api<{ ok: boolean; error?: string }>("/v1/prowlarr", { body, timeoutMs: 95_000 });
      if (!r.ok) throw new Error(r.error || "Prowlarr 拒绝了操作");
      track("indexer.action", { action: String(body.action), name: s.name });
      invalidate("prowlarr:");
      await q.refresh();
      toast(done, s.name);
    } catch (e) {
      toastError("操作失败", e);
    } finally {
      setBusy(null);
    }
  };

  const row = (s: Source) => (
    <Card key={s.id} style={{ marginBottom: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{s.name}</Text>
          <SourceMeta s={s} />
        </View>
        <View style={{ alignItems: "center" }}>
          <Switch value={defaults.includes(s.id)} onValueChange={() => toggleDefault(s.id)} trackColor={{ true: colors.primary }} />
          <Text style={[styles.faint, { fontSize: 11, marginTop: 2 }]}>默认勾选</Text>
        </View>
      </View>
      {s.kind === "prowlarr" && s.pid ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderColor: colors.border }}>
          <Text style={[styles.body, { flex: 1 }]}>{s.excluded ? "在 Prowlarr 启用（插件配置里排除了，智能搜索不用它）" : "在 Prowlarr 启用（智能搜索也会用它）"}</Text>
          <Switch
            disabled={busy === s.pid}
            value={!!s.prowlarrEnabled}
            onValueChange={(v) => void act(s, { action: "update", id: s.pid, enable: v }, v ? "已启用" : "已停用")}
            trackColor={{ true: colors.success }}
          />
          <IconButton
            name="trash-outline"
            label="删除"
            color={colors.danger}
            onPress={() => confirm("从 Prowlarr 删除", `删除「${s.name}」？之后可以在「添加索引器」里重新加回来。`, "删除", () => void act(s, { action: "delete", id: s.pid }, "已删除"), true)}
          />
        </View>
      ) : null}
    </Card>
  );

  return (
    <Screen>
      <TopBar title="索引源" />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }} refreshControl={<Pull onRefresh={q.refresh} />}>
        <Text style={styles.faint}>「默认勾选」决定按来源搜索时预先选中哪些来源（只存在这台手机上）。Prowlarr 开关会直接改 NAS 上的 Prowlarr：启用的索引器也会被 MoviePilot 智能搜索使用，NAS 只有 2GB 内存，别一次开太多。</Text>
        {q.error ? <ErrorBox text={q.error} onRetry={q.refresh} /> : null}
        {q.loading && !q.data ? <Loading /> : null}
        {q.data ? (
          <>
            <SectionTitle title="直连（后端直接访问）" />
            {all.filter((s) => s.kind === "direct").map(row)}
            <SectionTitle title="Prowlarr 索引器" right={<Text style={styles.faint}>{all.filter((s) => s.kind === "prowlarr" && s.prowlarrEnabled).length} 个启用</Text>} />
            {row({ id: "prowlarr", name: "全部已启用索引器", kind: "prowlarr", enabled: true, note: "所有在 Prowlarr 里启用的索引器一起搜" })}
            {all.filter((s) => s.kind === "prowlarr").sort((a, b) => Number(!!b.prowlarrEnabled) - Number(!!a.prowlarrEnabled)).map(row)}
            <PillButton icon="add" label="添加 Prowlarr 索引器" onPress={() => router.push("/indexer-catalog")} style={{ marginTop: 6 }} />
            {showAdult ? (
              <>
                <SectionTitle title="成人" />
                {all.filter((s) => s.kind === "adult").map(row)}
              </>
            ) : null}
            {mine ? <PillButton small variant="soft" icon="refresh" label="恢复默认来源" onPress={() => setSettings({ sources: null })} style={{ marginTop: 14, alignSelf: "center" }} /> : null}
          </>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
