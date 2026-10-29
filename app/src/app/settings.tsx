import { useState } from "react";
import { Pressable, ScrollView, Switch, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Application from "expo-application";
import { useRouter } from "expo-router";
import { Card, PillButton, Row, Screen, SectionTitle, Segmented, TopBar, confirm, styles, tap, toast, toastError } from "@/components/ui";
import { api, appVersion, type Overview } from "@/lib/api";
import { embyApi, login, logout } from "@/lib/emby";
import { collectLogs } from "@/lib/log";
import { ensureNotifyPermission } from "@/lib/notify";
import { invalidate } from "@/lib/query";
import { DEFAULT_EMBY_SERVER } from "@/lib/instance";
import { DEFAULT_SERVER, setSettings, useSettings } from "@/lib/settings";
import { STYLES, colors, radius, scheme, type StyleId } from "@/lib/theme";
import { track } from "@/lib/track";
import { checkAndFetch, restartToApply, runningLabel } from "@/lib/updates";

export default function SettingsScreen() {
  const router = useRouter();
  const s = useSettings((x) => x);
  const [srv, setSrv] = useState(s.server);
  const [tok, setTok] = useState(s.token);
  const [embySrv, setEmbySrv] = useState(s.emby.server || DEFAULT_EMBY_SERVER);
  const [embyUser, setEmbyUser] = useState(s.emby.username);
  const [embyPass, setEmbyPass] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const input = { height: 44, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.cardMuted, paddingHorizontal: 12, fontSize: 15, color: colors.text } as const;

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  const saveServer = () =>
    run("test", async () => {
      setSettings({ server: srv || DEFAULT_SERVER, token: tok.trim() });
      try {
        const o = await api<Overview>("/v1/overview", { timeoutMs: 45_000 });
        invalidate("");
        toast("已连接", o.errors.length ? `部分服务未响应：${o.errors.join("；").slice(0, 120)}` : `订阅 ${o.subscriptions ?? "—"} 个，进行中任务 ${o.pipeline?.downloading ?? 0} 个`);
      } catch (e) {
        toastError("未能连接", e);
      }
    });

  const embyLogin = () =>
    run("emby", async () => {
      try {
        // Blank fields fall back to the account kept on the server.
        let user = embyUser.trim();
        let pass = embyPass;
        if (!user || !pass) {
          const acc = await api<{ password: string; username: string }>("/v1/emby/account");
          if (!user) user = acc.username;
          if (!pass && user === acc.username) pass = acc.password;
        }
        const a = await login(embySrv, user, pass);
        setEmbyUser(a.username);
        await embyApi.views();
        invalidate("emby:");
        track("emby_login", { ok: true });
        toast("已登录 Emby", `${a.username} · ${a.server}`);
        setEmbyPass("");
      } catch (e) {
        track("emby_login", { ok: false });
        toastError("未能登录 Emby", e);
      }
    });

  const upload = () =>
    run("log", async () => {
      try {
        const log = await collectLogs();
        const r = await api<{ id: string }>("/v1/logs", { body: { log, meta: { version: appVersion, emby: s.emby.server, user: s.emby.username } }, timeoutMs: 60_000 });
        toast("日志已上传", `编号 ${r.id}，把编号发给我即可定位`);
      } catch (e) {
        toastError("未能上传日志", e);
      }
    });

  const update = () =>
    run("update", async () => {
      if (await checkAndFetch("manual")) toast("新版本已下载", undefined, { label: "立即重启", onPress: () => void restartToApply() });
      else toast("已是最新版本");
    });

  return (
    <Screen>
      <TopBar title="设置" />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }} keyboardShouldPersistTaps="handled">
        <SectionTitle title="外观" style={{ marginTop: 0 }} />
        <Card style={{ gap: 12 }}>
          <View style={{ flexDirection: "row", gap: 10 }}>
            {(Object.keys(STYLES) as StyleId[]).map((id) => {
              const st = STYLES[id];
              const p = st[scheme];
              const on = s.style === id;
              return (
                <Pressable key={id} onPress={() => { tap(); track("theme", { style: id }); setSettings({ style: id }); }} style={{ flex: 1, borderRadius: radius.md, borderWidth: 2, borderColor: on ? colors.primary : colors.border, overflow: "hidden" }}>
                  <View style={{ height: 70, backgroundColor: p.bg, padding: 8, gap: 5 }}>
                    <View style={{ flexDirection: "row", gap: 4 }}>
                      <View style={{ width: 18, height: 26, borderRadius: 3, backgroundColor: p.card, borderWidth: 1, borderColor: p.border }} />
                      <View style={{ width: 18, height: 26, borderRadius: 3, backgroundColor: p.cardMuted }} />
                      <View style={{ width: 18, height: 26, borderRadius: 3, backgroundColor: p.card, borderWidth: 1, borderColor: p.border }} />
                    </View>
                    <View style={{ height: 10, width: 46, borderRadius: 5, backgroundColor: p.primary }} />
                  </View>
                  <View style={{ padding: 8, backgroundColor: colors.card }}>
                    <Text style={{ fontWeight: "800", color: colors.text }}>{st.name}</Text>
                    <Text style={[styles.faint, { fontSize: 11 }]} numberOfLines={1}>{st.note}</Text>
                  </View>
                  {on ? <Ionicons name="checkmark-circle" size={18} color={colors.primary} style={{ position: "absolute", top: 6, right: 6 }} /> : null}
                </Pressable>
              );
            })}
          </View>
          <Segmented value={s.theme} onChange={(v) => setSettings({ theme: v })} options={[{ value: "system", label: "跟随系统" }, { value: "light", label: "浅色" }, { value: "dark", label: "深色" }]} />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <Text style={[styles.title, { flex: 1 }]}>海报排列</Text>
            <Segmented value={s.layout} onChange={(v) => setSettings({ layout: v })} options={[{ value: "grid", label: "瀑布流" }, { value: "list", label: "列表" }]} style={{ width: 180 }} />
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <Text style={[styles.title, { flex: 1 }]}>字幕大小</Text>
            <Segmented value={String(s.subtitleScale)} onChange={(v) => setSettings({ subtitleScale: Number(v) })} options={[{ value: "0.8", label: "小" }, { value: "1", label: "中" }, { value: "1.2", label: "大" }, { value: "1.4", label: "特大" }]} style={{ width: 220 }} />
          </View>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>成人内容</Text>
              <Text style={styles.faint}>AV、里番的库、搜索模式和 sukebei 来源</Text>
            </View>
            <Switch value={s.showAdult} onValueChange={(v) => setSettings({ showAdult: v })} trackColor={{ true: colors.primary }} />
          </View>
        </Card>

        <SectionTitle title="Emby（直连播放）" />
        <Card style={{ gap: 10 }}>
          {s.emby.token ? <Text style={styles.body}>已登录：{s.emby.username} · {s.emby.server}</Text> : <Text style={styles.body}>未登录。连接服务器后会自动用服务器上配置的账号登录。</Text>}
          <TextInput value={embySrv} onChangeText={setEmbySrv} placeholder={DEFAULT_EMBY_SERVER} placeholderTextColor={colors.textFaint} autoCapitalize="none" autoCorrect={false} keyboardType="url" style={input} />
          <TextInput value={embyUser} onChangeText={setEmbyUser} placeholder="用户名（留空用服务器上保存的）" placeholderTextColor={colors.textFaint} autoCapitalize="none" autoCorrect={false} style={input} />
          <TextInput value={embyPass} onChangeText={setEmbyPass} placeholder="密码（留空用服务器上保存的）" placeholderTextColor={colors.textFaint} autoCapitalize="none" autoCorrect={false} secureTextEntry style={input} />
          <View style={{ flexDirection: "row", gap: 10 }}>
            <PillButton label={s.emby.token ? "重新登录" : "登录"} icon="log-in-outline" loading={busy === "emby"} onPress={embyLogin} style={{ flex: 1 }} />
            {s.emby.token ? <PillButton variant="soft" label="退出" onPress={() => confirm("退出 Emby", "退出后需要重新登录才能浏览和播放。", "退出", () => { logout(); invalidate("emby:"); }, true)} /> : null}
          </View>
        </Card>

        <SectionTitle title="入库服务器" />
        <Card style={{ gap: 10 }}>
          <TextInput value={srv} onChangeText={setSrv} placeholder={DEFAULT_SERVER} placeholderTextColor={colors.textFaint} autoCapitalize="none" autoCorrect={false} keyboardType="url" style={input} />
          <TextInput value={tok} onChangeText={setTok} placeholder="访问令牌" placeholderTextColor={colors.textFaint} autoCapitalize="none" autoCorrect={false} secureTextEntry style={input} />
          <PillButton label="保存并测试连接" icon="link" loading={busy === "test"} onPress={saveServer} />
        </Card>

        <SectionTitle title="搜索" />
        <Card>
          <Text style={styles.body}>按来源搜索默认用哪些来源；查看每个索引源的语言、内容和简介，添加或停用 Prowlarr 索引器。</Text>
          <PillButton small variant="soft" icon="globe-outline" label="索引源" onPress={() => router.push("/indexers")} style={{ marginTop: 10, alignSelf: "flex-start" }} />
        </Card>

        <SectionTitle title="通知" />
        <Card>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>入库结果通知</Text>
              <Text style={styles.faint}>任务入库完成或失败时提醒。iOS 决定后台检查的时机，通常间隔 15 分钟以上。</Text>
            </View>
            <Switch
              value={s.notify}
              onValueChange={async (v) => {
                if (v && !(await ensureNotifyPermission())) {
                  toast("通知权限未开启", "请在系统设置里允许影库发送通知", undefined, true);
                  return;
                }
                setSettings({ notify: v });
              }}
              trackColor={{ true: colors.primary }}
            />
          </View>
        </Card>

        <SectionTitle title="关于与排错" />
        <Card>
          <Row label="版本" value={`${Application.nativeApplicationVersion ?? "dev"} (${Application.nativeBuildVersion ?? "0"})`} />
          <Row label="运行中" value={runningLabel()} />
          <Text style={[styles.faint, { marginTop: 6 }]}>遇到问题时点「上传日志」，把编号发给我。日志里有请求编号、播放状态和错误，不含账号密码。</Text>
          <View style={{ flexDirection: "row", gap: 10, marginTop: 10 }}>
            <PillButton small variant="soft" icon="cloud-download-outline" label="检查更新" loading={busy === "update"} onPress={update} style={{ flex: 1 }} />
            <PillButton small variant="soft" icon="document-text-outline" label="上传日志" loading={busy === "log"} onPress={upload} style={{ flex: 1 }} />
          </View>
          <PillButton small variant="soft" icon="construct-outline" label="能力自检" onPress={() => router.push("/diagnostics")} style={{ marginTop: 10 }} />
        </Card>
      </ScrollView>
    </Screen>
  );
}
