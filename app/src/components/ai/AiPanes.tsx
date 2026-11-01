// History and memory as panes inside the AI sheet (they slide over the chat). They used to be modal
// routes pushed from the sheet, and a modal presented from a form sheet showed but took no touches.
import { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { addNote, deleteChat, deleteNote, loadChats, loadNotes, openChat, useAi } from "@/lib/ai";
import { colors, fs, radius } from "@/components/ai/look";
import { EmptyState, ErrorBox, Loading, Pull, confirm, tap, toastError, styles } from "@/components/ui";

function PaneHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingTop: Platform.OS === "web" ? 12 : 18, paddingHorizontal: 8, paddingBottom: 8, borderBottomWidth: 1, borderColor: colors.border }}>
      <Pressable hitSlop={10} accessibilityLabel="返回对话" onPress={() => { tap(); onClose(); }} style={{ width: 40, height: 36, justifyContent: "center", alignItems: "center" }}>
        <Ionicons name="chevron-back" size={24} color={colors.text} />
      </Pressable>
      <Text style={{ flex: 1, fontSize: 17, fontWeight: "600", color: colors.text }}>{title}</Text>
    </View>
  );
}

const ago = (t: number) => {
  const s = (Date.now() - t) / 1000;
  return s < 60 ? "刚刚" : s < 3600 ? `${Math.floor(s / 60)} 分钟前` : s < 86400 ? `${Math.floor(s / 3600)} 小时前` : `${Math.floor(s / 86400)} 天前`;
};

export function HistoryPane({ onClose }: { onClose: () => void }) {
  const s = useAi();
  const [state, setState] = useState<"loading" | "ok" | string>(s.chats.length ? "ok" : "loading");
  const load = () =>
    loadChats()
      .then(() => setState("ok"))
      .catch((e) => setState(e instanceof Error ? e.message : String(e)));
  useEffect(() => {
    void load();
  }, []);

  const pick = (id: number) => {
    tap();
    onClose();
    openChat(id).catch((e) => toastError("未能打开对话", e));
  };
  const remove = (id: number, title: string) =>
    confirm("删除对话", `「${title}」会从服务器删除。`, "删除", () => void deleteChat(id).catch((e) => toastError("未能删除", e)), true);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <PaneHeader title="历史对话" onClose={onClose} />
      {state === "loading" && !s.chats.length ? (
        <Loading text="加载对话" />
      ) : state !== "ok" && state !== "loading" && !s.chats.length ? (
        <ErrorBox text={state} onRetry={load} />
      ) : (
        <ScrollView contentContainerStyle={{ padding: 8, paddingBottom: 40 }} refreshControl={<Pull onRefresh={load} />}>
          {!s.chats.length ? <EmptyState icon="chatbubbles-outline" text="还没有对话" /> : null}
          {s.chats.map((c) => (
            <Pressable key={c.id} onPress={() => pick(c.id)} style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 10, paddingLeft: 10, paddingRight: 4, borderRadius: 10, backgroundColor: c.id === s.chatId ? colors.primarySoft : pressed ? colors.raised : undefined })}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text numberOfLines={1} style={{ fontSize: fs.lg, color: colors.text }}>{c.title}</Text>
                <Text style={{ fontSize: fs.xs, color: colors.textFaint, marginTop: 2 }}>
                  {ago(c.updated)}
                  {c.costUsd ? ` · $${c.costUsd.toFixed(2)}` : ""}
                  {c.running ? <Text style={{ color: colors.primary }}>  进行中</Text> : null}
                </Text>
              </View>
              <Pressable hitSlop={8} accessibilityLabel="删除" onPress={() => { tap(); remove(c.id, c.title); }} style={({ pressed }) => ({ width: 36, height: 36, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? colors.cardMuted : undefined })}>
                <Ionicons name="trash-outline" size={16} color={colors.textDim} />
              </Pressable>
            </Pressable>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const day = (t: number) => {
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

export function NotesPane({ onClose }: { onClose: () => void }) {
  const s = useAi();
  const [state, setState] = useState<string>(s.notes.length ? "ok" : "loading");
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const load = () =>
    loadNotes()
      .then(() => setState("ok"))
      .catch((e) => setState(e instanceof Error ? e.message : String(e)));
  useEffect(() => {
    void load();
  }, []);

  const save = async () => {
    const t = text.trim();
    if (!t || saving) return;
    tap();
    setSaving(true);
    try {
      await addNote(t);
      setText("");
    } catch (e) {
      toastError("未能保存", e);
    } finally {
      setSaving(false);
    }
  };
  const remove = (id: number) => confirm("删除这条记忆", "AI 之后的回答不再参考它。", "删除", () => void deleteNote(id).catch((e) => toastError("未能删除", e)), true);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <PaneHeader title="偏好与记忆" onClose={onClose} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={{ padding: 12, paddingBottom: 40 }} keyboardShouldPersistTaps="handled" refreshControl={<Pull onRefresh={load} />}>
          <Text style={[styles.faint, { marginHorizontal: 4, marginBottom: 10 }]}>AI 每次回答都会参考这些偏好；在对话里说“记住…/我喜欢…”也会自动加到这里。</Text>
          <View style={{ flexDirection: "row", gap: 6, marginBottom: 8 }}>
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder="例如：杠杆偏好，多空都用 8 倍"
              placeholderTextColor={colors.textDim}
              maxLength={300}
              returnKeyType="done"
              onSubmitEditing={() => void save()}
              style={{ flex: 1, height: 40, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.raised, color: colors.text, paddingHorizontal: 12, fontSize: 16 }}
            />
            <Pressable accessibilityLabel="添加" disabled={!text.trim() || saving} onPress={() => void save()} style={({ pressed }) => ({ width: 40, height: 40, borderRadius: radius.md, alignItems: "center", justifyContent: "center", backgroundColor: colors.primarySoft, opacity: !text.trim() || saving ? 0.5 : pressed ? 0.7 : 1 })}>
              <Ionicons name="add" size={20} color={colors.primary} />
            </Pressable>
          </View>
          {state === "loading" && !s.notes.length ? <Loading /> : state !== "ok" && state !== "loading" && !s.notes.length ? <ErrorBox text={state} onRetry={load} /> : null}
          {state === "ok" && !s.notes.length ? <EmptyState icon="bulb-outline" text="还没有记忆" /> : null}
          {s.notes.map((n) => (
            <View key={n.id} style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, paddingVertical: 10, paddingLeft: 10, paddingRight: 4, borderBottomWidth: 1, borderColor: colors.border }}>
              <View style={{ flex: 1 }}>
                <Text selectable style={{ fontSize: fs.lg, lineHeight: 21, color: colors.text }}>{n.text}</Text>
                <Text style={{ fontSize: fs.xs, color: colors.textFaint, marginTop: 3 }}>{n.by === "ai" ? "AI 记录" : "手动添加"} · {day(n.ts)}</Text>
              </View>
              <Pressable hitSlop={8} accessibilityLabel="删除" onPress={() => { tap(); remove(n.id); }} style={({ pressed }) => ({ width: 36, height: 36, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? colors.cardMuted : undefined })}>
                <Ionicons name="trash-outline" size={16} color={colors.textDim} />
              </Pressable>
            </View>
          ))}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}
