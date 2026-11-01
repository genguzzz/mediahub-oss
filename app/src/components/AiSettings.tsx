// Settings → AI 助手: API key, endpoint (an Anthropic-compatible base URL; empty = official API), default
// model and web search. Values set here are stored on the server and win over its environment
// (AI_API_KEY / AI_BASE_URL / AI_MODEL); clearing one falls back to the server's value. The key is never
// sent back — the card only shows that it is set. Model calls always leave the server through its proxy.
import { useState } from "react";
import { Switch, Text, TextInput, View } from "react-native";
import { Card, PillButton, Segmented, styles, tap, toast, toastError } from "./ui";
import { api } from "@/lib/api";
import { logger } from "@/lib/log";
import { invalidate, useQuery } from "@/lib/query";
import { colors, radius } from "@/lib/theme";

const log = logger("ai-settings");
interface Status {
  configured: boolean; apiKey: string; apiKeyFrom: "app" | "server" | null; baseUrl: string; baseUrlFrom: "app" | "server" | null;
  model: string; modelFrom: "app" | "server" | null; effort: string; effortFrom: "app" | "server" | null; efforts: { value: string; label: string }[]; webSearch: boolean; proxy: string | null; models: { value: string; label: string }[];
}
const FROM = { app: "在 App 里设置", server: "来自服务端配置" } as const;

export function AiSettings() {
  const st = useQuery("ai:settings", () => api<Status>("/v1/ai/settings"), { staleMs: 60_000 });
  const [key, setKey] = useState("");
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = { height: 44, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.cardMuted, paddingHorizontal: 12, fontSize: 15, color: colors.text } as const;
  const s = st.data;

  const save = async (patch: Record<string, unknown>, done = "已保存") => {
    setBusy(true);
    try {
      await api<Status>("/v1/ai/settings", { method: "PUT", body: patch });
      invalidate("ai:settings");
      setKey("");
      setUrl(null);
      toast(done);
    } catch (e) {
      log.warn("save failed", e);
      toastError("未能保存", e);
    } finally {
      setBusy(false);
    }
  };

  if (!s) return <Card><Text style={styles.faint}>{st.error ? "读取失败" : "正在读取…"}</Text></Card>;
  return (
    <Card>
      <Text style={styles.body}>{s.configured ? "已可用：点右下角的光球提问，按住说话。" : s.proxy ? "填入 API Key 后即可使用。" : "服务端没有配置 AI_PROXY，模型请求不会直连，暂不可用。"}</Text>
      <Text style={[styles.faint, { marginTop: 4 }]}>出口：{s.proxy ?? "未配置"}</Text>

      <Text style={[styles.faint, { marginTop: 12 }]}>API Key{s.apiKey ? ` · ${s.apiKey}${s.apiKeyFrom ? ` · ${FROM[s.apiKeyFrom]}` : ""}` : ""}</Text>
      <TextInput value={key} onChangeText={setKey} placeholder={s.apiKey ? "填新的 Key 替换" : "sk-ant-…"} placeholderTextColor={colors.textFaint} autoCapitalize="none" autoCorrect={false} secureTextEntry style={[input, { marginTop: 6 }]} />
      <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
        <PillButton small label="保存 Key" disabled={!key.trim() || busy} onPress={() => void save({ apiKey: key.trim() })} />
        {s.apiKeyFrom === "app" ? <PillButton small variant="soft" label="清除" disabled={busy} onPress={() => void save({ apiKey: "" }, "已清除")} /> : null}
      </View>

      <Text style={[styles.faint, { marginTop: 14 }]}>接口地址（留空 = Anthropic 官方）{s.baseUrlFrom ? ` · ${FROM[s.baseUrlFrom]}` : ""}</Text>
      <TextInput value={url ?? s.baseUrl} onChangeText={setUrl} placeholder="https://api.anthropic.com" placeholderTextColor={colors.textFaint} autoCapitalize="none" autoCorrect={false} keyboardType="url" style={[input, { marginTop: 6 }]} />
      {url !== null && url !== s.baseUrl ? <PillButton small label="保存地址" disabled={busy} onPress={() => void save({ baseUrl: url.trim() })} style={{ marginTop: 8, alignSelf: "flex-start" }} /> : null}

      <Text style={[styles.faint, { marginTop: 14 }]}>默认模型{s.modelFrom ? ` · ${FROM[s.modelFrom]}` : ""}</Text>
      <Segmented value={s.models.some((m) => m.value === s.model) ? s.model : s.models[0].value} options={s.models} onChange={(v) => { tap(); void save({ model: v }); }} style={{ marginTop: 6 }} />

      <Text style={[styles.faint, { marginTop: 14 }]}>思考程度（越低越省 token、越快；复杂的找片和推荐用中或高）{s.effortFrom ? ` · ${FROM[s.effortFrom]}` : ""}</Text>
      {s.efforts?.length ? <Segmented value={s.effort} options={s.efforts} onChange={(v) => { tap(); void save({ effort: v }); }} style={{ marginTop: 6 }} /> : null}

      <View style={{ flexDirection: "row", alignItems: "center", marginTop: 14 }}>
        <View style={{ flex: 1 }}>
          <Text style={styles.body}>联网搜索</Text>
          <Text style={styles.faint}>找片、查剧情时搜索网页（第三方接口不支持时关掉）</Text>
        </View>
        <Switch value={s.webSearch} onValueChange={(v) => { tap(); void save({ webSearch: v }); }} />
      </View>
    </Card>
  );
}
