// Settings → JavDB 账号: JavDB keeps its 无码 section behind an account and a picture captcha. The backend
// fetches the login form through its proxy; this card shows the captcha, the owner types it, the backend
// logs in with "remember me" and keeps only the session cookies (never the password).
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { Image } from "expo-image";
import { Card, PillButton, confirm, styles, tap, toast, toastError } from "./ui";
import { api } from "@/lib/api";
import { logger } from "@/lib/log";
import { invalidate, useQuery } from "@/lib/query";
import { colors, radius } from "@/lib/theme";

const log = logger("javdb");
interface Status { loggedIn: boolean; user: string; since: number | null; expired: number | null }

export function JavdbAccount() {
  const st = useQuery("javdb:session", () => api<Status>("/v1/javdb/session"), { staleMs: 60_000 });
  const [form, setForm] = useState<{ id: string; captcha: string } | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const input = { height: 44, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.cardMuted, paddingHorizontal: 12, fontSize: 15, color: colors.text } as const;

  const start = async () => {
    setBusy("start");
    setCode("");
    try {
      setForm(await api<{ id: string; captcha: string }>("/v1/javdb/session/start", { body: {}, timeoutMs: 45_000 }));
    } catch (e) {
      log.warn("captcha failed", e);
      toastError("未能打开 JavDB 登录", e);
    } finally {
      setBusy(null);
    }
  };

  const submit = async () => {
    if (!form) return;
    setBusy("login");
    try {
      const r = await api<{ ok: boolean; error?: string }>("/v1/javdb/session", { body: { id: form.id, email: email.trim(), password, captcha: code }, timeoutMs: 45_000 });
      log.info("login", { ok: r.ok, error: r.error });
      if (!r.ok) {
        toast("未能登录 JavDB", r.error ?? "", undefined, true);
        await start();                 // a captcha is single-use
        return;
      }
      toast("已登录 JavDB", "无码排行和列表已可用");
      setForm(null);
      setPassword("");
      invalidate("javdb:");
      invalidate("catalog:");
    } catch (e) {
      toastError("未能登录 JavDB", e);
    } finally {
      setBusy(null);
    }
  };

  const s = st.data;
  return (
    <Card style={{ gap: 10 }}>
      <Text style={styles.body}>
        {s?.loggedIn ? `已登录：${s.user}` : s?.expired ? `登录已失效（${s.user}），请重新登录` : "未登录。JavDB 的无码列表、排行和详情需要账号。"}
      </Text>
      {form ? (
        <>
          <TextInput value={email} onChangeText={setEmail} placeholder="邮箱或用户名" placeholderTextColor={colors.textFaint} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" style={input} />
          <TextInput value={password} onChangeText={setPassword} placeholder="密码（不会保存）" placeholderTextColor={colors.textFaint} autoCapitalize="none" autoCorrect={false} secureTextEntry style={input} />
          <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
            <Pressable accessibilityLabel="换一张验证码" onPress={() => { tap(); void start(); }} style={{ borderRadius: radius.sm, overflow: "hidden", borderWidth: 1, borderColor: colors.border, backgroundColor: "#fff" }}>
              <Image source={{ uri: form.captcha }} style={{ width: 132, height: 44 }} contentFit="contain" />
            </Pressable>
            <TextInput value={code} onChangeText={setCode} placeholder="验证码" placeholderTextColor={colors.textFaint} autoCapitalize="none" autoCorrect={false} onSubmitEditing={() => void submit()} style={[input, { flex: 1 }]} />
          </View>
          <Text style={styles.faint}>看不清就点图片换一张。</Text>
          <View style={{ flexDirection: "row", gap: 10 }}>
            <PillButton label="登录" icon="log-in-outline" loading={busy === "login"} disabled={!email || !password || !code} onPress={() => void submit()} style={{ flex: 1 }} />
            <PillButton variant="soft" label="取消" onPress={() => setForm(null)} />
          </View>
        </>
      ) : (
        <View style={{ flexDirection: "row", gap: 10 }}>
          <PillButton label={s?.loggedIn ? "重新登录" : "登录 JavDB"} icon="log-in-outline" loading={busy === "start"} onPress={() => void start()} style={{ flex: 1 }} />
          {s?.loggedIn ? (
            <PillButton variant="soft" label="退出" onPress={() => confirm("退出 JavDB", "退出后无码列表和排行不可用。", "退出", async () => {
              await api("/v1/javdb/session", { method: "DELETE" });
              invalidate("javdb:");
              invalidate("catalog:");
            }, true)} />
          ) : null}
        </View>
      )}
    </Card>
  );
}
