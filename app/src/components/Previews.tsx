// Sample screenshots of a work: a thumbnail strip that opens a full-screen pager. Stills come in both
// orientations (DMM's first sample is the portrait cover, many samples are vertical): thumbnails share one
// height and take their width from the image once it loads; the pager shows each whole (contain).
import { useRef, useState } from "react";
import { FlatList, Modal, Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { tap } from "./ui";
import { img } from "@/lib/api";
import { imageLog } from "@/lib/imageLog";
import { colors, radius } from "@/lib/theme";

export function Previews({ items }: { items: { thumb: string; full: string }[] }) {
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
        {items.map((p, i) => <Thumb key={p.thumb} uri={p.thumb} onPress={() => { tap(); setPage(i); setOpen(i); }} />)}
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
            renderItem={({ item }) => (
              <Pressable onPress={() => setOpen(null)} style={{ width, height, justifyContent: "center" }}>
                <Image source={img(item.full) ?? undefined} style={{ width, height: height * 0.8 }} contentFit="contain" cachePolicy="disk" {...imageLog(img(item.full)?.uri, "still-full")} />
              </Pressable>
            )}
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

