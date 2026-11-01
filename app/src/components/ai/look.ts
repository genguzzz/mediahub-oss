// The AI components came from another app with different palette names: map them onto this theme
// (live, so a theme switch applies) and add the type scale they use.
import { colors as base, radius } from "@/lib/theme";

const ALIAS = { borderStrong: "border", textDim: "textFaint", raised: "cardMuted", up: "success", down: "danger", warn: "warning", info: "primary" } as const;
type Base = typeof base;
type Colors = Base & Record<keyof typeof ALIAS, string>;

export const colors = new Proxy(base, {
  get: (t, k) => (t as Record<string, string>)[(ALIAS as Record<string, string>)[k as string] ?? (k as string)],
}) as Colors;
export { radius };
export const fs = { xs: 11, sm: 12, md: 13, lg: 14, xl: 16, x2: 20, x3: 28 };
export const tnum = { fontVariant: ["tabular-nums" as const] };
