// Long-press on any poster: a bottom-up card with the film's details and quick actions (cast, open,
// mark watched, favourite, copy, source page). One instance lives in the root layout.
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Share, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import * as WebBrowser from "expo-web-browser";
import { CastPanel } from "./CastPanel";
import { FeedbackForm } from "./FeedbackForm";
import { Img, MiniTag, type CardData } from "./media";
import { Sheet, styles, tap, toast, toastError } from "./ui";
import { embyApi, playbackPlan, type PlaybackPlan } from "@/lib/emby";
import { openPeek, usePeek } from "@/lib/peek";
import { colors, radius } from "@/lib/theme";
import { nativeCaps } from "../../modules/mediahub-player";

interface Tile { label: string; icon: keyof typeof Ionicons.glyphMap; run: () => Promise<unknown> | void; destructive?: boolean; keep?: boolean }

export function PosterSheetHost() {
  const c = usePeek();
  const [shown, setShown] = useState<CardData | null>(null);
  const [mode, setMode] = useState<"menu" | "cast" | "feedback">("menu");
  const [plan, setPlan] = useState<PlaybackPlan | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [scan, setScan] = useState(false);
  const [user, setUser] = useState<{ played?: boolean; fav?: boolean } | null>(null);

  useEffect(() => {
    if (c) {
      setShown(c);
      setMode("menu");
      setPlan(null);
      setUser(null);
      void nativeCaps().then((x) => setScan(!!x?.ssdp));
      if (c.embyId) void embyApi.item(c.embyId).then((i) => setUser({ played: i.UserData?.Played, fav: i.UserData?.IsFavorite })).catch(() => {});
    }
  }, [c]);

  const close = () => openPeek(null);
  const card = shown;
  if (!card) return null;

  const id = card.embyId;
  const tiles: Tile[] = [{ label: "详情", icon: "information-circle-outline", run: () => { close(); card.onPress(); } }];
  if (id) {
    tiles.push({
      label: "投屏", icon: "tv-outline", keep: true,
      run: async () => {
        setPlan(await playbackPlan(id, 0));
        setMode("cast");
      },
    });
    tiles.push({
      label: user?.played ? "标为未看" : "标为已看", icon: user?.played ? "eye-off-outline" : "checkmark-circle-outline",
      run: async () => { await embyApi.setPlayed(id, !user?.played); toast(user?.played ? "已标为未看" : "已标为已看"); },
    });
    tiles.push({
      label: user?.fav ? "取消收藏" : "收藏", icon: user?.fav ? "heart-dislike-outline" : "heart-outline",
      run: async () => { await embyApi.setFavorite(id, !user?.fav); toast(user?.fav ? "已取消收藏" : "已收藏"); },
    });
  }
  for (const a of card.actions ?? []) tiles.push({ label: a.label, icon: a.icon ?? "ellipse-outline", run: a.run, destructive: a.destructive });
  tiles.push({ label: "反馈问题", icon: "flag-outline", keep: true, run: () => setMode("feedback") });
  tiles.push({ label: "复制标题", icon: "copy-outline", run: async () => { await Clipboard.setStringAsync(card.title); toast("已复制标题"); } });
  tiles.push({ label: "分享", icon: "share-outline", run: () => { void Share.share({ message: card.link ? `${card.title}\n${card.link.url}` : card.title }); } });
  if (card.link) {
    const { url } = card.link;
    tiles.push({ label: card.link.name, icon: "globe-outline", run: async () => { close(); await WebBrowser.openBrowserAsync(url, { presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET, controlsColor: colors.primary }); } });
  }

  const exec = async (t: Tile) => {
    tap();
    setBusy(t.label);
    try {
      await t.run();
      if (!t.keep) close();
    } catch (e) {
      toastError(`未能${t.label}`, e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet visible={!!c} onClose={close} scroll>
      <View style={{ flexDirection: "row", gap: 14 }}>
        <Img source={card.poster} style={{ width: 96, height: 96 / (card.aspect ?? 2 / 3), borderRadius: radius.md }} />
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 18, fontWeight: "800", color: colors.text, lineHeight: 23 }} numberOfLines={3}>{card.title}</Text>
          {card.subtitle ? <Text style={[styles.faint, { marginTop: 4 }]} numberOfLines={2}>{card.subtitle}</Text> : null}
          <View style={{ flexDirection: "row", gap: 6, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
            {card.rating ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
                <Ionicons name="star" size={12} color="#F5C451" />
                <Text style={{ fontSize: 13, fontWeight: "800", color: colors.text }}>{card.rating.toFixed(1)}</Text>
              </View>
            ) : null}
            {card.badge ? <MiniTag text={card.badge.text} color={card.badge.color} /> : null}
            {(card.tags ?? []).slice(0, 3).map((t) => <MiniTag key={t} text={t} />)}
          </View>
        </View>
      </View>
      {card.overview ? <Text style={{ fontSize: 13, lineHeight: 19, color: colors.textSoft, marginTop: 14 }} numberOfLines={mode === "menu" ? 6 : 2}>{card.overview}</Text> : null}

      {mode === "feedback" ? (
        <View style={{ marginTop: 14 }}>
          <FeedbackForm item={{ embyId: card.embyId, title: card.title, subtitle: card.subtitle, key: card.key }} onDone={close} onCancel={() => setMode("menu")} />
        </View>
      ) : mode === "cast" ? (
        <View style={{ marginTop: 14 }}>
          <Pressable onPress={() => setMode("menu")} style={{ flexDirection: "row", alignItems: "center", gap: 4, marginBottom: 8 }}>
            <Ionicons name="chevron-back" size={16} color={colors.primary} />
            <Text style={{ color: colors.primary, fontWeight: "700" }}>返回</Text>
          </Pressable>
          <CastPanel uri={plan?.uri ?? null} title={card.title} position={0} canScan={scan} onStart={() => {}} onStop={() => {}} />
        </View>
      ) : (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 16 }}>
          {tiles.map((t) => {
            const color = t.destructive ? colors.danger : colors.text;
            return (
              <Pressable
                key={t.label}
                disabled={!!busy}
                onPress={() => void exec(t)}
                style={({ pressed }) => ({ width: "30.5%", paddingVertical: 14, borderRadius: radius.md, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, alignItems: "center", gap: 6, opacity: pressed || (busy && busy !== t.label) ? 0.6 : 1 })}
              >
                {busy === t.label ? <ActivityIndicator color={color} /> : <Ionicons name={t.icon} size={22} color={color} />}
                <Text style={{ fontSize: 12, fontWeight: "700", color }} numberOfLines={1}>{t.label}</Text>
              </Pressable>
            );
          })}
        </View>
      )}
    </Sheet>
  );
}
