// The chat header's model chip and the card it opens: model, thinking effort, web search for the next
// questions. The choices come from the server (OPTIONS_PATH), so every app shows the same menu and a new
// model or level needs no app release; this phone keeps only what it picked (lib/ai.ts). Nothing picked =
// nothing sent: the server's default applies (the efforts list starts with 默认 = "").
import { useEffect, useState } from "react";
import { Pressable, Switch, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ai, setEffort, setModel, setWebSearch, useAiSelect, type ChatOption, type ChatOptions } from "@/lib/ai";
import { api } from "@/lib/api";
import { haptic } from "@/lib/device";
import { useQuery } from "@/lib/query";
import { colors, fs, radius } from "./look";

const OPTIONS_PATH = "/v1/ai/options";
const loadOptions = () => api<ChatOptions>(OPTIONS_PATH);

export function useModelChoice() {
  const opts = useQuery("ai:options", loadOptions, { staleMs: 10 * 60_000 }).data;
  // selected values only: the chat store changes on every streamed token
  const pickedModel = useAiSelect((a) => a.model);
  const pickedEffort = useAiSelect((a) => a.effort);
  const pickedWeb = useAiSelect((a) => a.webSearch);
  // a pick the server no longer offers falls back to its default
  useEffect(() => {
    if (!opts) return;
    if (ai.model && !opts.models.some((m) => m.value === ai.model)) setModel(null);
    if (ai.effort && !opts.efforts.some((e) => e.value === ai.effort)) setEffort(null);
  }, [opts]);
  const model = opts?.models.find((m) => m.value === (pickedModel ?? opts.defaults.model)) ?? null;
  const effort = opts?.efforts.find((e) => e.value === (pickedEffort ?? opts.defaults.effort)) ?? null;
  return { opts, model, effort, webSearch: pickedWeb ?? opts?.webSearch.default ?? true };
}

/** The chip under the chat title: "Sonnet · 思考低" (the level only when one is picked); tap opens the menu. */
export function ModelChip({ onPress }: { onPress: () => void }) {
  const { model, effort } = useModelChoice();
  const level = effort?.value ? ` · 思考${effort.label}` : "";
  return (
    <Pressable
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={`模型 ${model?.label ?? "默认"}，思考${effort?.label ?? "默认"}，点按调整`}
      onPress={() => { void haptic("select"); onPress(); }}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 3, alignSelf: "flex-start", opacity: pressed ? 0.6 : 1 })}
    >
      <Text style={{ fontSize: fs.xs, color: colors.textFaint }}>{model?.label ?? "模型"}{level}</Text>
      <Ionicons name="chevron-down" size={11} color={colors.textFaint} />
    </Pressable>
  );
}

function Option({ o, on, onPress }: { o: ChatOption; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected: on }}
      onPress={() => { void haptic("select"); onPress(); }}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 7, paddingHorizontal: 10, borderRadius: radius.sm, backgroundColor: on || pressed ? colors.raised : "transparent" })}
    >
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: fs.lg, color: colors.text, fontWeight: on ? "600" : "400" }}>{o.label}</Text>
        {o.hint ? <Text style={{ fontSize: fs.xs, color: colors.textFaint, marginTop: 1 }}>{o.hint}</Text> : null}
      </View>
      {on ? <Ionicons name="checkmark" size={16} color={colors.primary} /> : null}
    </Pressable>
  );
}

const Title = ({ children, first }: { children: string; first?: boolean }) => (
  <Text style={{ fontSize: fs.xs, color: colors.textFaint, marginTop: first ? 4 : 10, marginBottom: 2, marginLeft: 10 }}>{children}</Text>
);

/** The dropdown card (rendered over the chat; a tap outside closes it). */
export function ModelMenu({ top, onClose }: { top: number; onClose: () => void }) {
  const { opts, model, effort, webSearch } = useModelChoice();
  // the switch keeps its own state for a smooth flip
  const [web, setWeb] = useState(webSearch);
  return (
    <View style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, zIndex: 20 }}>
      <Pressable accessibilityLabel="关闭" onPress={onClose} style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.12)" }} />
      <View style={{ position: "absolute", top, left: 16, width: 290, maxWidth: "92%", padding: 6, borderRadius: radius.lg, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.borderStrong, shadowColor: "#000", shadowOpacity: 0.18, shadowRadius: 18, shadowOffset: { width: 0, height: 6 }, elevation: 8 }}>
        {!opts ? (
          <Text style={{ fontSize: fs.md, color: colors.textFaint, padding: 12 }}>正在读取选项…</Text>
        ) : (
          <>
            <Title first>模型</Title>
            {opts.models.map((m) => <Option key={m.value} o={m} on={m.value === model?.value} onPress={() => setModel(m.value === opts.defaults.model ? null : m.value)} />)}
            <Title>思考程度</Title>
            {opts.efforts.map((e) => <Option key={e.value || "default"} o={e} on={e.value === effort?.value} onPress={() => setEffort(e.value || null)} />)}
            <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 8, marginHorizontal: 10 }} />
            <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 10, paddingBottom: 6, gap: 10 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: fs.lg, color: colors.text }}>联网搜索</Text>
                <Text style={{ fontSize: fs.xs, color: colors.textFaint, marginTop: 1 }}>{opts.webSearch.hint}</Text>
              </View>
              <Switch value={web} onValueChange={(v) => { setWeb(v); setWebSearch(v); }} />
            </View>
          </>
        )}
      </View>
    </View>
  );
}
