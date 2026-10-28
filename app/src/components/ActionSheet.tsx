// Bottom sheet with a short description and a list of actions (destructive ones in red). An action
// with `confirm` asks again before running; the sheet shows a spinner on the running action and
// closes when it finishes.
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Sheet, confirm as ask, styles, tap, toastError } from "./ui";
import { colors, radius } from "@/lib/theme";

export interface SheetAction {
  label: string;
  note?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  destructive?: boolean;
  confirm?: { title: string; message: string; ok: string };
  run: () => Promise<unknown> | void;
}

export function ActionSheet({ visible, onClose, title, message, actions }: { visible: boolean; onClose: () => void; title: string; message?: string; actions: SheetAction[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const exec = async (a: SheetAction) => {
    setBusy(a.label);
    try {
      await a.run();
      onClose();
    } catch (e) {
      toastError(`未能${a.label}`, e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Sheet visible={visible} onClose={onClose} title={title}>
      {message ? <Text style={[styles.faint, { marginBottom: 12, lineHeight: 18 }]} selectable>{message}</Text> : null}
      <View style={{ gap: 8 }}>
        {actions.map((a) => {
          const color = a.destructive ? colors.danger : colors.text;
          return (
            <Pressable
              key={a.label}
              disabled={!!busy}
              onPress={() => {
                tap();
                if (a.confirm) ask(a.confirm.title, a.confirm.message, a.confirm.ok, () => void exec(a), a.destructive);
                else void exec(a);
              }}
              style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: radius.md, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, opacity: pressed || (busy && busy !== a.label) ? 0.6 : 1 })}
            >
              {busy === a.label ? <ActivityIndicator color={color} /> : <Ionicons name={a.icon ?? "ellipse-outline"} size={20} color={color} />}
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 15, fontWeight: "700", color }}>{a.label}</Text>
                {a.note ? <Text style={[styles.faint, { marginTop: 2 }]}>{a.note}</Text> : null}
              </View>
            </Pressable>
          );
        })}
      </View>
    </Sheet>
  );
}
