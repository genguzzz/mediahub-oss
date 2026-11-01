// Settings → AI 助手: API key and endpoint (an Anthropic-compatible base URL; empty = official API). Values set
// here are stored on the server and win over its environment (AI_API_KEY / AI_BASE_URL); clearing one falls
// back to the server's value. Model, thinking effort and web search are picked in the chat (ModelMenu). The key is never
// sent back — the card only shows that it is set. Model calls always leave the server through its proxy.
import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { Card, PillButton, styles, toast, toastError } from "./ui";
import { api } from "@/lib/api";
import { logger } from "@/lib/log";
import { invalidate, useQuery } from "@/lib/query";
import { colors, radius } from "@/lib/theme";

const log = logger("ai-settings");
interface Status {
  configured: boolean; apiKey: string; apiKeyFrom: "app" | "server" | null; baseUrl: string; baseUrlFrom: "app" | "server" | null;
  proxy: string | null;
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

    </Card>
  );
}
