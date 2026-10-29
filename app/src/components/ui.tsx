import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { ActivityIndicator, Alert, Animated, Modal, Pressable, RefreshControl, ScrollView, Text, View, type RefreshControlProps, type TextProps, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import * as Clipboard from "expo-clipboard";
import * as WebBrowser from "expo-web-browser";
import { colors, radius, shadow } from "@/lib/theme";
import type { Step } from "@/lib/api";
import { openDrawer } from "./drawerState";

export const tap = () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
type IconName = keyof typeof Ionicons.glyphMap;

// Space the system tab bar covers at the bottom of tab screens.
export const TAB_BAR_SPACE = 110;

export function Screen({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ flex: 1, backgroundColor: colors.bg }, style]}>{children}</View>;
}

// Top bar for pushed screens: back chevron, centered title, optional right actions.
export function TopBar({ title, right }: { title?: string; right?: ReactNode }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingBottom: 10, paddingTop: insets.top + 6, backgroundColor: colors.bg }}>
      <Pressable hitSlop={12} accessibilityLabel="返回" onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))} style={{ width: 72 }}>
        <Ionicons name="chevron-back" size={26} color={colors.text} />
      </Pressable>
      <Text style={{ flex: 1, textAlign: "center", fontSize: 17, fontWeight: "600", color: colors.text }} numberOfLines={1}>{title ?? ""}</Text>
      <View style={{ width: 72, flexDirection: "row", justifyContent: "flex-end", gap: 16 }}>{right}</View>
    </View>
  );
}

// Header for tab screens: drawer button, large title, actions on the right.
export function TabHeader({ title, right, sub }: { title: string; right?: ReactNode; sub?: string }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 18, paddingBottom: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", minHeight: 40, gap: 12 }}>
        <Pressable
          hitSlop={10}
          accessibilityLabel="打开菜单"
          onPress={() => { tap(); openDrawer(); }}
          style={({ pressed }) => ({ width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center", backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, opacity: pressed ? 0.7 : 1 })}
        >
          <View style={{ gap: 4 }}>
            <View style={{ width: 16, height: 2, borderRadius: 1, backgroundColor: colors.text }} />
            <View style={{ width: 11, height: 2, borderRadius: 1, backgroundColor: colors.text }} />
          </View>
        </Pressable>
        <Text style={styles.h1}>{title}</Text>
        <View style={{ flex: 1 }} />
        <View style={{ flexDirection: "row", alignItems: "center", gap: 18 }}>{right}</View>
      </View>
      {sub ? <Text style={[styles.faint, { marginTop: 2 }]}>{sub}</Text> : null}
    </View>
  );
}

export function IconButton({ name, onPress, size = 22, color, label }: { name: IconName; onPress: () => void; size?: number; color?: string; label?: string }) {
  return (
    <Pressable hitSlop={10} accessibilityLabel={label} onPress={() => { tap(); onPress(); }} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
      <Ionicons name={name} size={size} color={color ?? colors.textSoft} />
    </Pressable>
  );
}

export function Card({ children, style, onPress, onLongPress, muted }: { children: ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void; onLongPress?: () => void; muted?: boolean }) {
  const base: ViewStyle = { backgroundColor: muted ? colors.cardMuted : colors.card, borderRadius: radius.md, padding: 14, borderWidth: 1, borderColor: colors.border, ...shadow() };
  if (!onPress && !onLongPress) return <View style={[base, style]}>{children}</View>;
  return (
    <Pressable onPress={onPress ? () => { tap(); onPress(); } : undefined} onLongPress={onLongPress ? () => { tap(); onLongPress(); } : undefined} style={({ pressed }) => [base, style, pressed && { opacity: 0.85 }]}>
      {children}
    </Pressable>
  );
}

export function SectionTitle({ title, right, style }: { title: string; right?: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ flexDirection: "row", alignItems: "center", marginTop: 22, marginBottom: 10 }, style]}>
      <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text }}>{title}</Text>
      <View style={{ flex: 1 }} />
      {right}
    </View>
  );
}

export function PillButton({ label, icon, onPress, variant = "primary", loading, disabled, style, small }: {
  label: string;
  icon?: IconName;
  onPress: () => void;
  variant?: "primary" | "ghost" | "danger" | "soft";
  loading?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  small?: boolean;
}) {
  const bg = { primary: colors.primary, danger: colors.danger, ghost: "transparent", soft: colors.cardMuted }[variant];
  const fg = variant === "primary" || variant === "danger" ? colors.onPrimary : colors.text;
  return (
    <Pressable
      disabled={disabled || loading}
      onPress={() => { tap(); onPress(); }}
      style={({ pressed }) => [
        { height: small ? 38 : 50, borderRadius: radius.pill, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, paddingHorizontal: small ? 14 : 22, backgroundColor: bg, opacity: disabled ? 0.45 : pressed ? 0.85 : 1 },
        (variant === "ghost" || variant === "soft") && { borderWidth: 1, borderColor: colors.border },
        style,
      ]}
    >
      {loading ? <ActivityIndicator color={fg} /> : icon ? <Ionicons name={icon} size={small ? 15 : 18} color={fg} /> : null}
      <Text style={{ fontSize: small ? 14 : 16, fontWeight: "600", color: fg }}>{label}</Text>
    </Pressable>
  );
}

export function Chip({ label, active, onPress, count, icon }: { label: string; active?: boolean; onPress?: () => void; count?: number; icon?: IconName }) {
  return (
    <Pressable
      disabled={!onPress}
      onPress={() => { tap(); onPress?.(); }}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 12, height: 32, borderRadius: 16, backgroundColor: active ? colors.primary : colors.cardMuted, borderWidth: 1, borderColor: active ? colors.primary : colors.border, opacity: pressed ? 0.8 : 1 })}
    >
      {icon ? <Ionicons name={icon} size={13} color={active ? colors.onPrimary : colors.textSoft} /> : null}
      <Text style={{ fontSize: 13, fontWeight: "600", color: active ? colors.onPrimary : colors.text }} numberOfLines={1}>{label}</Text>
      {count !== undefined ? <Text style={{ fontSize: 12, color: active ? colors.onPrimary : colors.textFaint }}>{count}</Text> : null}
    </Pressable>
  );
}

export function ChipRow({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={[{ flexGrow: 0, flexShrink: 0 }, style]} contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}>
      {children}
    </ScrollView>
  );
}

export function Segmented<T extends string>({ value, options, onChange, style }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ flexDirection: "row", backgroundColor: colors.cardMuted, borderRadius: 12, padding: 3, borderWidth: 1, borderColor: colors.border }, style]}>
      {options.map((o) => (
        <Pressable key={o.value} onPress={() => { tap(); onChange(o.value); }} style={{ flex: 1, height: 32, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: value === o.value ? colors.card : "transparent", ...(value === o.value ? shadow() : {}) }}>
          <Text style={{ fontSize: 14, fontWeight: value === o.value ? "700" : "500", color: value === o.value ? colors.text : colors.textSoft }}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function Tag({ text, color = colors.primary, solid }: { text: string; color?: string; solid?: boolean }) {
  return (
    <View style={{ borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2, alignSelf: "flex-start", backgroundColor: solid ? color : color + "22" }}>
      <Text style={{ fontSize: 11, fontWeight: "700", color: solid ? colors.onPrimary : color }}>{text}</Text>
    </View>
  );
}

export function ProgressBar({ value, color, height = 5 }: { value: number | null | undefined; color?: string; height?: number }) {
  const v = Math.max(0, Math.min(100, value ?? 0));
  return (
    <View style={{ height, borderRadius: height, backgroundColor: colors.cardMuted, overflow: "hidden" }}>
      <View style={{ width: `${v}%`, height, borderRadius: height, backgroundColor: color ?? colors.primary }} />
    </View>
  );
}

const STEP_COLOR = { done: () => colors.success, active: () => colors.primary, pending: () => colors.border, error: () => colors.danger, skipped: () => colors.border };

// Five-stage ingest progress: dots joined by lines, labels under each.
export function Steps({ steps, compact }: { steps: Step[]; compact?: boolean }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
      {steps.map((s, i) => (
        <View key={s.key} style={{ flex: 1, alignItems: "center" }}>
          <View style={{ flexDirection: "row", alignItems: "center", width: "100%" }}>
            <View style={{ flex: 1, height: 2, backgroundColor: i === 0 ? "transparent" : STEP_COLOR[steps[i - 1].state === "done" ? "done" : "pending"]() }} />
            <View style={{ width: compact ? 10 : 14, height: compact ? 10 : 14, borderRadius: 7, backgroundColor: STEP_COLOR[s.state](), borderWidth: s.state === "active" ? 3 : 0, borderColor: colors.primarySoft }} />
            <View style={{ flex: 1, height: 2, backgroundColor: i === steps.length - 1 ? "transparent" : STEP_COLOR[s.state === "done" ? "done" : "pending"]() }} />
          </View>
          {compact ? null : (
            <Text style={{ fontSize: 11, marginTop: 4, color: s.state === "error" ? colors.danger : s.state === "active" ? colors.primary : colors.textFaint, fontWeight: s.state === "active" ? "700" : "400" }} numberOfLines={1}>{s.label}</Text>
          )}
        </View>
      ))}
    </View>
  );
}

export function Poster({ source, width, ratio = 1.5, style, icon = "film-outline" }: { source: { uri: string; headers?: Record<string, string> } | undefined; width: number; ratio?: number; style?: StyleProp<ViewStyle>; icon?: IconName }) {
  return (
    <View style={[{ width, height: width * ratio, borderRadius: 10, overflow: "hidden", backgroundColor: colors.cardMuted, alignItems: "center", justifyContent: "center" }, style]}>
      <Ionicons name={icon} size={width * 0.3} color={colors.textFaint} style={{ position: "absolute" }} />
      {source ? <Image source={source} style={{ width: "100%", height: "100%" }} contentFit="cover" transition={150} cachePolicy="disk" recyclingKey={source.uri} /> : null}
    </View>
  );
}

export function EmptyState({ icon = "file-tray-outline", text, action }: { icon?: IconName; text: string; action?: ReactNode }) {
  return (
    <View style={{ alignItems: "center", justifyContent: "center", paddingVertical: 60, paddingHorizontal: 32, gap: 12 }}>
      <Ionicons name={icon} size={40} color={colors.textFaint} />
      <Text style={[styles.body, { textAlign: "center" }]}>{text}</Text>
      {action}
    </View>
  );
}

export function ErrorBox({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <View style={{ margin: 16, padding: 14, borderRadius: radius.md, backgroundColor: colors.danger + "18", borderWidth: 1, borderColor: colors.danger + "44", flexDirection: "row", alignItems: "center", gap: 10 }}>
      <Ionicons name="alert-circle" size={20} color={colors.danger} />
      <Text style={{ flex: 1, color: colors.text, fontSize: 14 }}>{text}</Text>
      {onRetry ? <Pressable hitSlop={8} onPress={() => { tap(); onRetry(); }}><Text style={{ color: colors.primary, fontWeight: "700" }}>重试</Text></Pressable> : null}
    </View>
  );
}

// Footer of an auto-loading list: a spinner while the next page loads, a retry button if it failed.
export function MoreFooter({ show, error, onRetry }: { show: boolean; error?: string; onRetry: () => void }) {
  if (!show) return null;
  if (error) return <PillButton small variant="soft" icon="refresh" label="加载失败，点此重试" onPress={onRetry} style={{ alignSelf: "center", marginTop: 14 }} />;
  return <View style={{ paddingVertical: 20, alignItems: "center" }}><ActivityIndicator color={colors.primary} /></View>;
}

export function Loading({ text }: { text?: string }) {
  return (
    <View style={{ paddingVertical: 40, alignItems: "center", gap: 10 }}>
      <ActivityIndicator color={colors.primary} />
      {text ? <Text style={styles.faint}>{text}</Text> : null}
    </View>
  );
}

// Text that copies itself on long press (iOS shows no selection UI for plain Text otherwise).
export function CopyText({ copy, label, children, ...rest }: TextProps & { copy?: string; label?: string; children?: ReactNode }) {
  const text = copy ?? (typeof children === "string" || typeof children === "number" ? String(children) : "");
  return (
    <Text {...rest} onLongPress={text ? () => { void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); void Clipboard.setStringAsync(text); toast(`已复制${label ?? ""}`, text.length > 80 ? `${text.slice(0, 80)}…` : text); } : undefined}>
      {children}
    </Text>
  );
}

// "Data source" row: opens the work's page at the index/metadata source in an in-app browser (H5); long press copies the URL.
export function SourceLink({ name, url, style }: { name: string; url: string; style?: StyleProp<ViewStyle> }) {
  const host = url.replace(/^https?:\/\//, "").split("/")[0];
  return (
    <Pressable
      onPress={() => { tap(); void WebBrowser.openBrowserAsync(url, { presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET, controlsColor: colors.primary }); }}
      onLongPress={() => { void Clipboard.setStringAsync(url); toast("已复制来源链接", url); }}
      style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 12, paddingHorizontal: 14, borderRadius: radius.md, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, opacity: pressed ? 0.85 : 1 }, style]}
    >
      <Ionicons name="link-outline" size={18} color={colors.primary} />
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 14, fontWeight: "700", color: colors.text }}>数据源 · {name}</Text>
        <Text style={{ fontSize: 12, color: colors.textFaint }} numberOfLines={1}>{host}</Text>
      </View>
      <Ionicons name="open-outline" size={16} color={colors.textFaint} />
    </Pressable>
  );
}

export function Row({ label, value, onPress }: { label: string; value?: string | number | null; onPress?: () => void; selectable?: boolean }) {
  const body = (
    <View style={{ flexDirection: "row", alignItems: "flex-start", paddingVertical: 9, gap: 12 }}>
      <Text style={{ width: 84, fontSize: 13, color: colors.textFaint }}>{label}</Text>
      <CopyText label={label} style={{ flex: 1, fontSize: 14, color: colors.text }}>{value === null || value === undefined || value === "" ? "—" : String(value)}</CopyText>
      {onPress ? <Ionicons name="chevron-forward" size={16} color={colors.textFaint} /> : null}
    </View>
  );
  return onPress ? <Pressable onPress={() => { tap(); onPress(); }}>{body}</Pressable> : body;
}

// ---------- bottom sheet ----------

export function Sheet({ visible, onClose, title, children, scroll, footer }: { visible: boolean; onClose: () => void; title?: string; children?: ReactNode; scroll?: boolean; footer?: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={{ flex: 1, backgroundColor: colors.backdrop }} onPress={onClose} />
      <View style={{ maxHeight: "86%", backgroundColor: colors.sheet, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 18, paddingTop: 10, paddingBottom: insets.bottom + 14, borderTopWidth: 1, borderColor: colors.border }}>
        <View style={{ alignSelf: "center", width: 40, height: 5, borderRadius: 3, backgroundColor: colors.border, marginBottom: 12 }} />
        {title ? <Text style={{ fontSize: 18, fontWeight: "700", color: colors.text, marginBottom: 8 }}>{title}</Text> : null}
        {scroll ? <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">{children}</ScrollView> : children}
        {footer ? <View style={{ paddingTop: 10 }}>{footer}</View> : null}
      </View>
    </Modal>
  );
}

export function confirm(title: string, message: string, ok: string, onOk: () => void, destructive = false) {
  Alert.alert(title, message, [
    { text: "取消", style: "cancel" },
    { text: ok, style: destructive ? "destructive" : "default", onPress: onOk },
  ]);
}

// ---------- toast ----------

type ToastAction = { label: string; onPress: () => void };
type ToastMsg = { id: number; title: string; body?: string; actions: ToastAction[]; error?: boolean };
let toastState: ToastMsg | null = null;
const toastListeners = new Set<() => void>();
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function setToast(msg: ToastMsg | null) {
  toastState = msg;
  toastListeners.forEach((l) => l());
}

export function toast(title: string, body?: string, action?: ToastAction | ToastAction[], error = false) {
  const actions = action ? (Array.isArray(action) ? action : [action]) : [];
  setToast({ id: Date.now(), title, body, actions, error });
  void Haptics.notificationAsync(error ? Haptics.NotificationFeedbackType.Error : Haptics.NotificationFeedbackType.Success);
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => setToast(null), actions.length || error ? 6000 : 3200);
}

export const toastError = (title: string, e: unknown) => toast(title, e instanceof Error ? e.message : String(e), undefined, true);

export function ToastHost() {
  const insets = useSafeAreaInsets();
  const msg = useSyncExternalStore((l) => { toastListeners.add(l); return () => toastListeners.delete(l); }, () => toastState);
  const [anim] = useState(() => new Animated.Value(0));
  useEffect(() => {
    Animated.spring(anim, { toValue: msg ? 1 : 0, useNativeDriver: true, friction: 8 }).start();
  }, [msg, anim]);
  if (!msg) return null;
  return (
    <Animated.View
      pointerEvents="box-none"
      style={{ position: "absolute", left: 14, right: 14, bottom: insets.bottom + 70, zIndex: 300, opacity: anim, transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [40, 0] }) }] }}
    >
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12, backgroundColor: colors.sheet, borderRadius: 16, padding: 14, borderWidth: 1, borderColor: msg.error ? colors.danger + "66" : colors.border, ...shadow() }}>
        <Ionicons name={msg.error ? "alert-circle" : "checkmark-circle"} size={22} color={msg.error ? colors.danger : colors.success} />
        <View style={{ flex: 1 }}>
          <Text style={{ color: colors.text, fontWeight: "700", fontSize: 15 }} numberOfLines={2}>{msg.title}</Text>
          {msg.body ? <Text style={{ color: colors.textSoft, fontSize: 13, lineHeight: 19, marginTop: 2 }} numberOfLines={5}>{msg.body}</Text> : null}
          {msg.actions.length ? (
            <View style={{ flexDirection: "row", gap: 16, marginTop: 8 }}>
              {msg.actions.map((a) => (
                <Pressable key={a.label} hitSlop={8} onPress={() => { tap(); setToast(null); a.onPress(); }}>
                  <Text style={{ color: colors.primary, fontWeight: "700", fontSize: 14 }}>{a.label}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>
        <Pressable hitSlop={10} onPress={() => setToast(null)}>
          <Ionicons name="close" size={18} color={colors.textSoft} />
        </Pressable>
      </View>
    </Animated.View>
  );
}

// Theme-aware text styles (getters, so they always read the active palette).
export const styles = {
  get h1(): TextStyle { return { fontSize: 28, fontWeight: "800", color: colors.text, letterSpacing: 0.2 }; },
  get h2(): TextStyle { return { fontSize: 22, fontWeight: "700", color: colors.text }; },
  get title(): TextStyle { return { fontSize: 15, fontWeight: "600", color: colors.text }; },
  get body(): TextStyle { return { fontSize: 14, lineHeight: 21, color: colors.textSoft }; },
  get faint(): TextStyle { return { fontSize: 12, color: colors.textFaint }; },
};

// Pull-to-refresh that only spins for the user's own pull, not for background polling.
// ScrollView clones its refreshControl with extra props (style, and on Android/web the content
// as children), so everything else is passed through.
export function Pull({ onRefresh, ...rest }: { onRefresh: () => unknown } & Omit<RefreshControlProps, "refreshing" | "onRefresh">) {
  const [on, setOn] = useState(false);
  return (
    <RefreshControl
      {...rest}
      refreshing={on}
      tintColor={colors.primary}
      onRefresh={() => {
        setOn(true);
        void Promise.resolve(onRefresh()).finally(() => setOn(false));
      }}
    />
  );
}
