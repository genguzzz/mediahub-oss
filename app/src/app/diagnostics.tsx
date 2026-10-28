import { useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Updates from "expo-updates";
import { device as playerDevice, nativeCaps, type NativeCaps } from "../../modules/mediahub-player";
import { Card, PillButton, Screen, SectionTitle, TopBar, styles, toast } from "@/components/ui";
import { api, appVersion } from "@/lib/api";
import { authenticate, capabilities, connection, keepAwake, listenOnce, pickFile } from "@/lib/device";
import { collectLogs, logger } from "@/lib/log";
import { colors } from "@/lib/theme";
import { track } from "@/lib/track";
import { runningLabel } from "@/lib/updates";

const log = logger("diag");

type Result = { ok: boolean; note: string };

// Settings → 能力自检: shows what this binary carries and exercises each native capability once,
// so a new IPA can be checked on the phone in a minute (results also go to the log and events).
export default function Diagnostics() {
  const [caps, setCaps] = useState<NativeCaps | null>(null);
  const [results, setResults] = useState<Record<string, Result>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const mods = capabilities();

  useEffect(() => {
    void nativeCaps().then(setCaps);
  }, []);

  const run = async (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    try {
      const note = await fn();
      setResults((r) => ({ ...r, [key]: { ok: true, note } }));
      log.info("check ok", { key, note });
      track("diag", { key, ok: true });
    } catch (e) {
      const note = e instanceof Error ? e.message : String(e);
      setResults((r) => ({ ...r, [key]: { ok: false, note } }));
      log.warn("check failed", { key, note });
      track("diag", { key, ok: false, err: note });
    } finally {
      setBusy(null);
    }
  };

  const checks: { key: string; label: string; fn: () => Promise<string> }[] = [
    { key: "network", label: "网络类型", fn: async () => JSON.stringify(await connection()) },
    { key: "keepAwake", label: "屏幕常亮", fn: async () => { await keepAwake("diag", true); await keepAwake("diag", false); return "已开启并关闭"; } },
    { key: "brightness", label: "读取亮度", fn: async () => `亮度 ${Math.round(((await playerDevice.getBrightness()) ?? -1) * 100)}%` },
    { key: "volume", label: "读取音量", fn: async () => `音量 ${Math.round(((await playerDevice.getVolume()) ?? -1) * 100)}%` },
    { key: "faceid", label: "面容 ID", fn: async () => ((await authenticate("影库能力自检")) ? "验证通过" : "未通过或取消") },
    { key: "file", label: "从文件选取", fn: async () => { const f = await pickFile(); return f ? `${f.name} ${f.size ?? ""}` : "已取消"; } },
    { key: "speech", label: "语音识别（说一句话）", fn: async () => (await listenOnce()) ?? "没有识别到内容" },
    { key: "backend", label: "后端连通", fn: async () => { const t0 = Date.now(); await api("/v1/overview", { timeoutMs: 30_000 }); return `${Date.now() - t0} ms`; } },
    { key: "ota", label: "热更新检查", fn: async () => { if (!Updates.isEnabled) return "开发版本，不检查"; const r = await Updates.checkForUpdateAsync(); return r.isAvailable ? "有新版本" : "已是最新"; } },
  ];

  const upload = async () => {
    const r = await api<{ id: string }>("/v1/logs", { body: { log: await collectLogs(), meta: { version: appVersion, diag: results, caps, mods } }, timeoutMs: 60_000 });
    toast("自检结果已上传", `编号 ${r.id}`);
  };

  return (
    <Screen>
      <TopBar title="能力自检" />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
        <Card>
          <Text style={styles.title}>版本 {appVersion}</Text>
          <Text style={[styles.faint, { marginTop: 4 }]}>运行 {runningLabel()} · runtime {Updates.runtimeVersion ?? "dev"}</Text>
          <Text style={[styles.faint, { marginTop: 4 }]}>
            播放器 {caps ? `模块 v${caps.module}${caps.engine ? ` · AetherEngine ${caps.engine}` : ""}` : "未内置"}
          </Text>
          {caps && caps.module >= 3 ? (
            <Text style={[styles.faint, { marginTop: 4 }]}>
              屏幕：{[caps.dolbyVision ? "Dolby Vision" : "", caps.hdr10 ? "HDR10" : "", caps.hlg ? "HLG" : ""].filter(Boolean).join(" / ") || "SDR"} · 小窗 {caps.pip ? "支持" : "不支持"}
            </Text>
          ) : null}
        </Card>

        <SectionTitle title="内置的原生能力" />
        <Card style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {Object.entries(mods).map(([k, v]) => (
            <View key={k} style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, height: 26, borderRadius: 13, backgroundColor: (v ? colors.success : colors.danger) + "22" }}>
              <Ionicons name={v ? "checkmark" : "close"} size={12} color={v ? colors.success : colors.danger} />
              <Text style={{ fontSize: 12, color: colors.text }}>{k}</Text>
            </View>
          ))}
        </Card>

        <SectionTitle title="逐项测试" />
        {checks.map((c) => {
          const r = results[c.key];
          return (
            <Card key={c.key} style={{ marginBottom: 8, flexDirection: "row", alignItems: "center", gap: 12 }}>
              <View style={{ flex: 1 }}>
                <Text style={styles.title}>{c.label}</Text>
                {r ? <Text style={[styles.faint, { marginTop: 2, color: r.ok ? colors.success : colors.danger }]} numberOfLines={3}>{r.note}</Text> : null}
              </View>
              <PillButton small variant="soft" label="测试" loading={busy === c.key} onPress={() => void run(c.key, c.fn)} />
            </Card>
          );
        })}
        <PillButton icon="cloud-upload-outline" label="上传自检结果和日志" onPress={() => void upload()} style={{ marginTop: 12 }} />
      </ScrollView>
    </Screen>
  );
}
