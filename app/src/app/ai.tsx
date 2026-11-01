// 影库助手 (server/src/ai): streamed answers with step lists (each stage folds to "思考 N 次 · M 步"),
// poster-card blocks and Markdown; model switch; history and preferences; the page it was opened from as
// context; tap-to-talk in the composer and hold-to-talk on the orb. State and the connection: lib/ai.ts.
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Animated, Easing, Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, useWindowDimensions, View, type ScrollViewInstance, type TextInputInstance } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { useFocusEffect, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ai, clearContext, newChat, retry, send, setOpen, stop, textOf, useAi, type Msg } from "@/lib/ai";
import { copy, haptic } from "@/lib/device";
import { useHoldToTalk, useTapToTalk } from "@/lib/voice";
import { colors, fs } from "@/components/ai/look";
import { Screen, tap, toast, toastError } from "@/components/ui";
import { AiBlock } from "@/components/ai/AiBlock";
import { AiSteps, type StepItem } from "@/components/ai/AiSteps";
import { Markdown } from "@/components/ai/Markdown";
import { Orb } from "@/components/ai/Orb";
import { HistoryPane, NotesPane } from "@/components/ai/AiPanes";
import { ModelChip, ModelMenu } from "@/components/ai/ModelMenu";
import { VoiceWave } from "@/components/ai/VoiceWave";
import { segments } from "@/components/ai/blocks";

// consecutive thinking and tool calls form one stage
type Group = { k: "text"; v: string } | { k: "tools"; items: StepItem[] };
function groups(m: Msg): Group[] {
  const out: Group[] = [];
  for (const p of m.parts) {
    if (p.t === "text") {
      if (p.v.trim()) out.push({ k: "text", v: p.v });
    } else {
      const g = out[out.length - 1];
      if (g?.k === "tools") g.items.push(p);
      else out.push({ k: "tools", items: [p] });
    }
  }
  return out;
}

function phaseOf(m: Msg, now: number): "thinking" | "typing" | "tool" | "reasoning" | null {
  if (!m.live) return null;
  const p = m.parts[m.parts.length - 1];
  if (p?.t === "tool" && p.ok == null) return "tool";
  if (p?.t === "think" && p.live) return "reasoning"; // the stage card streams it
  if (p?.t === "text" && now - ai.lastDelta < 1500) return "typing";
  return "thinking";
}

const flash = (m: string) => toast(m, undefined, undefined, true);

export default function AiScreen() {
  const { width } = useWindowDimensions();
  const s = useAi();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [input, setInput] = useState("");
  // history / memory slide over the chat inside this sheet (a modal pushed from the sheet took no touches)
  const [pane, setPane] = useState<"history" | "notes" | null>(null);
  const [menu, setMenu] = useState(false);
  const [headH, setHeadH] = useState(60);
  const [slide] = useState(() => new Animated.Value(0));
  const showPane = (p: "history" | "notes" | null) => {
    if (p) {
      setPane(p);
      slide.setValue(0);
      Animated.spring(slide, { toValue: 1, useNativeDriver: true, damping: 22, stiffness: 240 }).start();
    } else {
      Animated.timing(slide, { toValue: 0, duration: 200, easing: Easing.in(Easing.cubic), useNativeDriver: true }).start(() => setPane(null));
    }
  };
  const [kb, setKb] = useState(false);
  const scroller = useRef<ScrollViewInstance>(null);
  const inputRef = useRef<TextInputInstance>(null);
  const stick = useRef(true);

  useFocusEffect(
    useCallback(() => {
      setOpen(true);
      stick.current = true;
      setTimeout(() => scroller.current?.scrollToEnd({ animated: false }), 50);
      return () => setOpen(false);
    }, []),
  );

  useEffect(() => {
    const a = Keyboard.addListener("keyboardWillShow", () => setKb(true));
    const b = Keyboard.addListener("keyboardWillHide", () => setKb(false));
    return () => { a.remove(); b.remove(); };
  }, []);

  // "still working" cues re-evaluate a few times a second while a turn runs
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!s.running) return;
    const t = setInterval(() => setNow(Date.now()), 400);
    return () => clearInterval(t);
  }, [s.running]);

  useEffect(() => { stick.current = true; }, [s.chatId]);

  const submit = (text = input, voice = false) => {
    if (!text.trim() || ai.running) return;
    tap();
    stick.current = true;
    void send(text, false, voice);
    setInput("");
  };
  const talk = useTapToTalk({ onText: (t) => submit(t, true), onError: flash });
  const hold = useHoldToTalk({ onTap: () => inputRef.current?.focus(), onText: (t) => submit(t, true), onError: flash });

  const fresh = () => {
    tap();
    talk.cancel();
    newChat();
  };

  const suggestions = s.screen
    ? ["这部讲了什么？不剧透地介绍一下", "推荐几部类似的", "帮我找资源入库"]
    : ["根据我的观看记录推荐几部", "最近有什么好看的新剧？", "那部讲时间循环的韩剧叫什么？"];
  const lastMsg = s.msgs[s.msgs.length - 1];
  const bottomPad = kb || Platform.OS === "web" ? 8 : insets.bottom + 8; // a sheet: no tab bar under it

  // Dragging the header down closes the sheet. The native sheet only dismisses when the chat is
  // scrolled to its top, and a chat sits at its bottom, so swiping down there just scrolled it.
  const close = () => { if (router.canGoBack()) router.back(); else router.replace("/"); };
  const pull = Gesture.Pan()
    .activeOffsetY(10)
    .failOffsetX([-24, 24])
    .runOnJS(true)
    .onEnd((e) => { if (e.translationY > 50 || e.velocityY > 600) { tap(); close(); } });

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
    <Screen>
      {/* header: close the sheet, title, model switch, memory, history, new chat */}
      <GestureDetector gesture={pull}>
      <View onLayout={(e) => setHeadH(e.nativeEvent.layout.height)} style={{ paddingTop: Platform.OS === "web" ? insets.top + 6 : 18, paddingLeft: 16, paddingRight: 8, paddingBottom: 8, flexDirection: "row", alignItems: "center", gap: 8, borderBottomWidth: 1, borderColor: colors.border, backgroundColor: colors.bg, zIndex: 2 }}>
        <Pressable hitSlop={10} accessibilityLabel="收起" onPress={() => { tap(); close(); }} style={({ pressed }) => ({ width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: colors.card, borderWidth: 1, borderColor: colors.borderStrong, opacity: pressed ? 0.7 : 1 })}>
          <Ionicons name="chevron-down" size={18} color={colors.text} />
        </Pressable>
        {/* title with the model chip under it: tap opens model / thinking / web search */}
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
            <Orb size={14} ring={7} period={4000} glow={0.6} />
            <Text numberOfLines={1} style={{ flex: 1, fontSize: fs.xl, fontWeight: "600", color: colors.text }}>{s.title || "影库助手"}</Text>
          </View>
          <View style={{ marginLeft: 21 }}>
            <ModelChip onPress={() => { Keyboard.dismiss(); setMenu(true); }} />
          </View>
        </View>
        <HeadButton icon="bulb-outline" label="偏好与记忆" onPress={() => showPane("notes")} />
        <HeadButton icon="time-outline" label="历史对话" onPress={() => showPane("history")} />
        <HeadButton icon="create-outline" label="新对话" onPress={fresh} />
      </View>
      </GestureDetector>

      <KeyboardAvoidingView style={{ flex: 1, overflow: "hidden" }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView
          ref={scroller}
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 6, paddingBottom: 16 }}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          scrollEventThrottle={100}
          onScroll={(e) => {
            const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
            stick.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 80;
          }}
          onContentSizeChange={() => { if (stick.current) scroller.current?.scrollToEnd({ animated: false }); }}
        >
          {!s.msgs.length ? (
            <View style={{ alignItems: "center", gap: 10, paddingTop: 26, paddingHorizontal: 4, paddingBottom: 8 }}>
              <View {...hold.handlers}>
                <Orb size={64} period={hold.phase === "rec" ? 1400 : 5000} scale={hold.phase === "rec" ? 1.15 + hold.level * 0.2 : hold.phase === "arming" ? 0.92 : 1} danger={hold.cancelZone} glow={hold.phase === "rec" ? 0.6 + hold.level * 0.4 : 0.3}>
                  {hold.phase === "busy" ? <Spinner /> : <Ionicons name={hold.phase === "rec" ? "mic" : "sparkles"} size={26} color="#f4ffe0" />}
                </Orb>
              </View>
              {hold.phase === "rec" || hold.phase === "busy" ? (
                <View style={{ alignItems: "center", gap: 6, paddingVertical: 4 }}>
                  {hold.phase === "rec" ? <VoiceWave level={hold.level} height={34} danger={hold.cancelZone} /> : null}
                  <Text style={{ fontSize: fs.sm, color: hold.cancelZone ? "#ff8aa5" : colors.textSoft }}>{hold.phase === "busy" ? "识别中…" : hold.cancelZone ? "松开取消" : "松开发送 · 上滑取消"}</Text>
                </View>
              ) : (
                <Text style={{ marginTop: 4, fontSize: fs.x2, fontWeight: "700", color: colors.text }}>想看点什么？</Text>
              )}
              <Text style={{ fontSize: fs.sm, lineHeight: 20, color: colors.textFaint, textAlign: "center", maxWidth: 340 }}>我能按你的口味推荐、模糊描述找片、讲剧情、查媒体库和入库进度，也能帮你搜资源入库、订阅追更。按住光球说话也行。</Text>
              <View style={{ width: "100%", maxWidth: 380, gap: 8, marginTop: 4 }}>
                {suggestions.map((q) => (
                  <Pressable key={q} onPress={() => submit(q)} style={({ pressed }) => ({ paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: pressed ? colors.cardMuted : colors.card })}>
                    <Text style={{ fontSize: fs.md, color: colors.textSoft }}>{q}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          ) : null}

          {s.msgs.map((m, mi) => (m.role === "user" ? <UserBubble key={m.id ?? "m" + mi} text={textOf(m)} /> : <Answer key={m.id ?? "m" + mi} m={m} now={now} />))}

          {s.running && lastMsg?.role === "user" ? <Thinking label="思考中" /> : null}
          {s.reconnecting ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginVertical: 10, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, backgroundColor: colors.raised }}>
              <Spinner />
              <Text style={{ flex: 1, fontSize: fs.sm, color: colors.textSoft }}>连接断了，回答仍在服务器上继续，正在重新连接…</Text>
            </View>
          ) : !s.running && lastMsg && (s.interrupted || lastMsg.error) ? (
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, marginVertical: 10, paddingVertical: 8, paddingRight: 8, paddingLeft: 12, borderRadius: 10, borderWidth: 1, borderColor: "rgba(247,166,0,0.35)", backgroundColor: "rgba(247,166,0,0.06)" }}>
              <Text style={{ flex: 1, fontSize: fs.sm, color: colors.textSoft }}>{s.interrupted ? "这次回答被中断了（服务重启或网络问题）" : "回答没有完成"}</Text>
              <Pressable onPress={() => { tap(); void retry(); }} style={({ pressed }) => ({ paddingHorizontal: 14, paddingVertical: 6, borderRadius: 8, backgroundColor: colors.primary, opacity: pressed ? 0.8 : 1 })}>
                <Text style={{ color: colors.onPrimary, fontWeight: "600", fontSize: fs.md }}>重试</Text>
              </Pressable>
            </View>
          ) : null}
        </ScrollView>

        {/* composer */}
        <View style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: bottomPad, borderTopWidth: 1, borderColor: colors.border, backgroundColor: colors.bg }}>
          {s.screen ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8, marginLeft: 2 }}>
              <Pressable hitSlop={6} accessibilityLabel="移除页面上下文" onPress={() => { tap(); clearContext(); }} style={{ flexShrink: 1, flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 9, paddingVertical: 4, borderRadius: 14, borderWidth: 1, borderColor: colors.borderStrong }}>
                <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: fs.xs, color: colors.textSoft }}>上下文 {s.screen}</Text>
                <Ionicons name="close" size={12} color={colors.textFaint} />
              </Pressable>
            </View>
          ) : null}
          <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 6, paddingVertical: 5, paddingRight: 5, paddingLeft: 12, borderRadius: 22, backgroundColor: colors.raised, borderWidth: 1, borderColor: colors.borderStrong }}>
            <TextInput
              ref={inputRef}
              value={input}
              onChangeText={setInput}
              multiline
              numberOfLines={1}
              placeholder={talk.phase === "rec" ? "正在听…点 ↑ 发送" : talk.phase === "busy" ? "识别中…" : "问点什么…"}
              placeholderTextColor={colors.textDim}
              style={{ flex: 1, minHeight: 36, maxHeight: 140, paddingTop: 8, paddingBottom: 8, color: colors.text, fontSize: 16, lineHeight: 21 }}
            />
            {talk.phase === "rec" ? <RoundButton icon="close" label="取消录音" onPress={() => { tap(); talk.cancel(); }} /> : null}
            {talk.phase === "rec" ? (
              <Pressable accessibilityLabel="结束并发送" onPress={() => void talk.toggle()}>
                <Orb size={40} ring={20} period={1400} glow={0.5}>
                  <Ionicons name="arrow-up" size={18} color="#000" />
                </Orb>
              </Pressable>
            ) : (
              <RoundButton icon={talk.phase === "busy" ? null : "mic-outline"} label="语音输入" onPress={() => void talk.toggle()} />
            )}
            {s.running ? (
              <RoundButton icon="square" size={13} label="停止" bg={colors.text} color="#000" onPress={() => { tap(); void stop().catch((e) => toastError("未能停止", e)); }} />
            ) : (
              <RoundButton icon="arrow-up" label="发送" bg={input.trim() ? colors.primary : colors.cardMuted} color={input.trim() ? colors.onPrimary : colors.textDim} disabled={!input.trim()} onPress={() => submit()} />
            )}
          </View>
          {talk.phase === "rec" ? (
            <View style={{ alignItems: "center", marginTop: 6 }}>
              <VoiceWave level={talk.level} height={26} bars={33} barWidth={3} />
            </View>
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </Screen>
      {menu ? <ModelMenu top={headH + 4} onClose={() => setMenu(false)} /> : null}
      {pane ? (
        <Animated.View style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, zIndex: 10, backgroundColor: colors.bg,
          transform: [{ translateX: slide.interpolate({ inputRange: [0, 1], outputRange: [width, 0] }) }] }}>
          {pane === "history" ? <HistoryPane onClose={() => showPane(null)} /> : <NotesPane onClose={() => showPane(null)} />}
        </Animated.View>
      ) : null}
    </GestureHandlerRootView>
  );
}

function HeadButton({ icon, label, onPress }: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void }) {
  return (
    <Pressable hitSlop={4} accessibilityLabel={label} onPress={() => { tap(); onPress(); }} style={({ pressed }) => ({ width: 32, height: 34, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? colors.cardMuted : undefined })}>
      <Ionicons name={icon} size={19} color={colors.textSoft} />
    </Pressable>
  );
}

function RoundButton({ icon, label, onPress, bg = colors.cardMuted, color = colors.textSoft, size = 18, disabled }: { icon: keyof typeof Ionicons.glyphMap | null; label: string; onPress: () => void; bg?: string; color?: string; size?: number; disabled?: boolean }) {
  return (
    <Pressable accessibilityLabel={label} disabled={disabled} onPress={onPress} style={({ pressed }) => ({ width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: bg, opacity: pressed ? 0.75 : 1 })}>
      {icon ? <Ionicons name={icon} size={size} color={color} /> : <Spinner />}
    </Pressable>
  );
}

function Spinner() {
  const [a] = useState(() => new Animated.Value(0));
  useEffect(() => {
    const l = Animated.loop(Animated.timing(a, { toValue: 1, duration: 800, easing: Easing.linear, useNativeDriver: true }));
    l.start();
    return () => l.stop();
  }, [a]);
  return <Animated.View style={{ width: 13, height: 13, borderRadius: 7, borderWidth: 2, borderColor: colors.borderStrong, borderTopColor: colors.primary, transform: [{ rotate: a.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] }) }] }} />;
}

const UserBubble = memo(function UserBubble({ text }: { text: string }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "flex-end", marginTop: 14, marginBottom: 6 }}>
      <Pressable
        onLongPress={() => { void haptic("medium"); void copy(text).then((ok) => ok && toast("已复制")); }}
        style={{ maxWidth: "84%", paddingHorizontal: 13, paddingVertical: 9, borderTopLeftRadius: 16, borderTopRightRadius: 16, borderBottomLeftRadius: 16, borderBottomRightRadius: 4, backgroundColor: colors.primarySoft, borderWidth: 1, borderColor: colors.border }}
      >
        <Text selectable style={{ fontSize: fs.lg, lineHeight: 21, color: colors.text }}>{text}</Text>
      </Pressable>
    </View>
  );
});

function Answer({ m, now }: { m: Msg; now: number }) {
  const gs = groups(m);
  const phase = phaseOf(m, now);
  const live = !!m.live;
  const text = textOf(m);
  return (
    <View style={{ marginTop: 8, marginBottom: 4 }}>
      {gs.map((g, gi) =>
        g.k === "tools" ? (
          <AiSteps key={gi} items={g.items} live={live} tail={gi === gs.length - 1} />
        ) : (
          <View key={gi}>
            {(() => {
              const segs = segments(g.v, live);
              return segs.map((sg, si) =>
                sg.k === "md" ? (
                  <Markdown key={sg.key} text={sg.text} caret={gi === gs.length - 1 && si === segs.length - 1 && phase === "typing"} />
                ) : (
                  <AiBlock key={sg.key} seg={sg} />
                ),
              );
            })()}
          </View>
        ),
      )}
      {phase === "thinking" ? <Thinking label={m.parts.length ? "整理思路" : "思考中"} /> : null}
      {m.error ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginVertical: 6 }}>
          <Ionicons name="alert-circle-outline" size={14} color={colors.warn} />
          <Text style={{ flex: 1, color: colors.warn, fontSize: fs.sm }}>{m.error}</Text>
        </View>
      ) : null}
      {!live && text ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 }}>
          <Pressable hitSlop={8} accessibilityLabel="复制" onPress={() => { tap(); void copy(text).then((ok) => toast(ok ? "已复制" : "复制失败")); }} style={({ pressed }) => ({ width: 26, height: 26, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? colors.cardMuted : undefined })}>
            <Ionicons name="copy-outline" size={13} color={colors.textSoft} />
          </Pressable>
          {m.latencyMs ? <Text style={{ fontSize: fs.xs, color: colors.textFaint }}>{(m.latencyMs / 1000).toFixed(0)}s</Text> : null}
          {m.costUsd ? <Text style={{ fontSize: fs.xs, color: colors.textFaint }}>· ${m.costUsd.toFixed(3)}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

function Thinking({ label }: { label: string }) {
  const [a] = useState(() => new Animated.Value(0));
  useEffect(() => {
    const l = Animated.loop(Animated.timing(a, { toValue: 1, duration: 1200, easing: Easing.linear, useNativeDriver: true }));
    l.start();
    return () => l.stop();
  }, [a]);
  const dot = (i: number, c: string) => {
    const s = i * 0.125;
    const v = a.interpolate({ inputRange: [0, s, s + 0.33, s + 0.66, 1], outputRange: [0.5, 0.5, 1, 0.5, 0.5], extrapolate: "clamp" });
    return <Animated.View key={i} style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: c, opacity: v, transform: [{ scale: v }] }} />;
  };
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 5, paddingVertical: 10, paddingHorizontal: 2 }}>
      {dot(0, colors.primary)}
      {dot(1, "#2fe0ff")}
      {dot(2, "#9b7df0")}
      <Animated.Text style={{ marginLeft: 6, fontSize: fs.sm, color: colors.textSoft, opacity: a.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.5, 1, 0.5] }) }}>{label}</Animated.Text>
    </View>
  );
}
