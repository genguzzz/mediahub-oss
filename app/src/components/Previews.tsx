// Sample screenshots of a work: a thumbnail strip that opens a full-screen pager.
import { useRef, useState } from "react";
import { FlatList, Modal, Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Img } from "./media";
import { tap } from "./ui";
import { img } from "@/lib/api";
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
        {items.map((p, i) => (
          <Pressable key={p.thumb} onPress={() => { tap(); setPage(i); setOpen(i); }}>
            <Img source={img(p.thumb)} icon="image-outline" style={{ width: 150, height: 94, borderRadius: radius.md }} />
          </Pressable>
        ))}
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
                <Image source={img(item.full) ?? undefined} style={{ width, height: height * 0.8 }} contentFit="contain" cachePolicy="disk" />
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
