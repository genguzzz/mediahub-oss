import { useState } from "react";
import { Text, View } from "react-native";
import { Tag, styles } from "@/components/ui";
import type { Source } from "@/lib/api";
import { colors } from "@/lib/theme";

// Built-in sources pre-selected for 按来源搜索 when the user hasn't picked their own in Settings → 索引源.
export const BUILTIN_SOURCES = ["nyaa", "animetosho", "mikan", "prowlarr"];

const TAG_COLOR: Record<string, string> = { 动漫: colors.primary, 中文: colors.success, 成人: colors.danger, 综合: colors.warning };

// What a source is about, from its metadata: content tags, language, public/private, description.
export function SourceMeta({ s, lines = 2 }: { s: Partial<Pick<Source, "tags" | "langName" | "privacyName" | "desc" | "note" | "downTill">>; lines?: number }) {
  const [now] = useState(() => Date.now());
  const tags = (s.tags ?? []).filter((t) => t !== "中文" && t !== "外文");
  const down = s.downTill && new Date(s.downTill).getTime() > now ? new Date(s.downTill) : null;
  return (
    <View style={{ marginTop: 4, gap: 4 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5 }}>
        {s.langName ? <Tag text={s.langName} color={s.langName === "中文" ? colors.success : colors.textSoft} /> : null}
        {tags.map((t) => <Tag key={t} text={t} color={TAG_COLOR[t] ?? colors.textSoft} />)}
        {s.privacyName && s.privacyName !== "公开" ? <Tag text={s.privacyName} color={colors.warning} /> : null}
        {down ? <Tag text={`连续失败，暂停到 ${down.getHours()}:${String(down.getMinutes()).padStart(2, "0")}`} color={colors.danger} /> : null}
      </View>
      {s.desc || s.note ? <Text style={styles.faint} numberOfLines={lines}>{s.desc || s.note}</Text> : null}
    </View>
  );
}
