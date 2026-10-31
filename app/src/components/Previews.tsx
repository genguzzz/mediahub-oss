// Sample screenshots of a work: a thumbnail strip that opens a full-screen pager. Stills come in both
// orientations (DMM's first sample is the portrait cover, many samples are vertical): thumbnails share one
// height and take their width from the image once it loads; the pager shows each whole (contain).
// A storyboard (hanime: one sprite of 160×90 frames across the episode) is shown the same way: a dozen
// evenly spaced frames, each a 16:9 window onto the scaled sprite.
import { useRef, useState } from "react";
import { FlatList, Modal, Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { tap } from "./ui";
import { img } from "@/lib/api";
import { imageLog } from "@/lib/imageLog";
import { colors, radius } from "@/lib/theme";

export interface Storyboard { url: string; cols: number; rows: number; count: number }
type Frame = { sb: Storyboard; i: number };
const FRAMES = 12;

/** Frame `i` of a storyboard sprite, shown at w × w·9/16. */
function SpriteFrame({ f, w }: { f: Frame; w: number }) {
  const h = Math.round((w * 9) / 16);
  const src = img(f.sb.url);
  return (
    <View style={{ width: w, height: h, overflow: "hidden", backgroundColor: colors.cardMuted }}>
      <Image
        source={src}
        style={{ position: "absolute", width: w * f.sb.cols, height: h * f.sb.rows, left: -(f.i % f.sb.cols) * w, top: -Math.floor(f.i / f.sb.cols) * h }}
        contentFit="fill"
        cachePolicy="disk"
        {...imageLog(src?.uri, "storyboard")}
      />
    </View>
  );
}

export function Previews({ items: images = [], storyboard }: { items?: { thumb: string; full: string }[]; storyboard?: Storyboard }) {
  // Frames skip the very start and end (titles, credits).
  const frames: Frame[] = storyboard && !images.length
    ? Array.from({ length: Math.min(FRAMES, storyboard.count) }, (_, k) => ({ sb: storyboard, i: Math.floor(((k + 0.5) / Math.min(FRAMES, storyboard.count)) * storyboard.count * 0.92 + storyboard.count * 0.04) }))
    : [];
  const items = images.length ? images : frames.map((f) => ({ thumb: `${f.sb.url}#${f.i}`, full: `${f.sb.url}#${f.i}` }));
  const frameOf = (i: number) => (frames.length ? frames[i] : null);
  const [open, setOpen] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const list = useRef<FlatList>(null);
  if (!items.length) return null;
  return (
    <View style={{ marginTop: 18 }}>
      <Text style={{ fontSize: 16, fontWeight: "800", color: colors.text, marginBottom: 10 }}>剧照 · {items.length}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {items.map((p, i) => {
          const f = frameOf(i);
          const onPress = () => { tap(); setPage(i); setOpen(i); };
          return f ? (
            <Pressable key={p.thumb} onPress={onPress} style={{ borderRadius: radius.md, overflow: "hidden" }}><SpriteFrame f={f} w={THUMB_H * 16 / 9} /></Pressable>
          ) : <Thumb key={p.thumb} uri={p.thumb} onPress={onPress} />;
        })}
      </ScrollView>
      <Modal visible={open !== null} transparent animationType="fade" onRequestClose={() => setOpen(null)} statusBarTranslucent>
        <View style={{ flex: 1, backgroundColor: "#000" }}>
          <FlatList
            ref={list}
            data={items}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            keyExtractor={(p) => p.full}
            initialScrollIndex={open ?? 0}
            getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
            onMomentumScrollEnd={(e) => setPage(Math.round(e.nativeEvent.contentOffset.x / width))}
            renderItem={({ item, index }) => {
              const f = frameOf(index);
              return (
                <Pressable onPress={() => setOpen(null)} style={{ width, height, justifyContent: "center", alignItems: "center" }}>
                  {f ? <SpriteFrame f={f} w={Math.min(width, ((height * 0.8) * 16) / 9)} /> : (
                    <Image source={img(item.full) ?? undefined} style={{ width, height: height * 0.8 }} contentFit="contain" cachePolicy="disk" {...imageLog(img(item.full)?.uri, "still-full")} />
                  )}
                </Pressable>
              );
            }}
          />
          <View style={{ position: "absolute", top: insets.top + 8, left: 0, right: 0, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16 }}>
            <Text style={{ color: "#fff", fontWeight: "700", backgroundColor: "rgba(0,0,0,0.5)", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, overflow: "hidden" }}>{page + 1} / {items.length}</Text>
            <Pressable hitSlop={12} onPress={() => setOpen(null)} style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(255,255,255,0.18)", alignItems: "center", justifyContent: "center" }}>
              <Ionicons name="close" size={22} color="#fff" />
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const THUMB_H = 100;

function Thumb({ uri, onPress }: { uri: string; onPress: () => void }) {
  const [ratio, setRatio] = useState(1.6);
  const src = img(uri);
  const log = imageLog(src?.uri, "still-thumb");
  return (
    <Pressable onPress={onPress} style={{ width: Math.round(THUMB_H * ratio), height: THUMB_H, borderRadius: radius.md, overflow: "hidden", backgroundColor: colors.cardMuted }}>
      <Image
        source={src}
        style={{ width: "100%", height: "100%" }}
        contentFit="cover"
        cachePolicy="disk"
        transition={150}
        {...log}
        onLoad={(e) => {
          log.onLoad(e);
          const { width: w, height: h } = e.source;
          if (w && h) setRatio(Math.min(2, Math.max(0.6, w / h)));
        }}
      />
    </Pressable>
  );
}

