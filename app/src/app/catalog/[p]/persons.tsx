// Actress index of one provider, sortable where the provider can; scrolling loads more pages.
// Tap opens her works.
import { useState } from "react";
import { ScrollView, TextInput, useWindowDimensions, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { PersonTile } from "@/components/CatalogHome";
import { Chip, ChipRow, EmptyState, ErrorBox, Loading, MoreFooter, Pull, Screen, TopBar } from "@/components/ui";
import { catalogApi } from "@/lib/catalog";
import { useAutoMore, usePaged, useQuery } from "@/lib/query";
import { colors, radius } from "@/lib/theme";

export default function Persons() {
  const { p } = useLocalSearchParams<{ p: string }>();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const providers = useQuery("catalog:providers", catalogApi.providers, { staleMs: 60 * 60_000 });
  const info = providers.data?.providers.find((x) => x.id === p);
  const [sort, setSort] = useState<string | undefined>(undefined);
  const cur = sort ?? info?.personIndexSorts[0]?.id ?? "";
  const [text, setText] = useState("");
  const q = usePaged(`catalog:${p}:persons:${cur}`, async (page) => (await catalogApi.persons(p, cur, page)).items, { id: (x) => x.id, maxPages: 60, staleMs: 30 * 60_000 });
  const scroll = useAutoMore(q.autoMore);
  const cols = width > 500 ? 5 : 4;
  const size = Math.floor((width - 32 - (cols - 1) * 8) / cols) - 8;
  const needle = text.trim();
  const shown = q.items.filter((x) => !needle || x.name.includes(needle) || x.aliases?.includes(needle));

  return (
    <Screen>
      <TopBar title={`女优 · ${info?.name ?? ""}`} />
      {info && info.personIndexSorts.length > 1 ? (
        <ChipRow style={{ marginBottom: 10 }}>
          {info.personIndexSorts.map((s) => <Chip key={s.id} label={s.label} active={cur === s.id} onPress={() => setSort(s.id)} />)}
        </ChipRow>
      ) : null}
      <View style={{ marginHorizontal: 16, marginBottom: 12, flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, height: 40 }}>
        <Ionicons name="search" size={16} color={colors.textFaint} />
        <TextInput value={text} onChangeText={setText} placeholder="在已载入的名单里筛选" placeholderTextColor={colors.textFaint} autoCorrect={false} clearButtonMode="while-editing" style={{ flex: 1, fontSize: 15, color: colors.text }} />
      </View>
      <ScrollView contentContainerStyle={{ paddingBottom: 60 }} refreshControl={<Pull onRefresh={q.refresh} />} {...scroll}>
        {q.error ? <ErrorBox text={q.error} onRetry={q.refresh} /> : null}
        {!q.hasData && q.loading ? <Loading /> : null}
        {q.hasData && !shown.length ? <EmptyState icon="person-outline" text="没有符合的名字" /> : null}
        <View style={{ paddingHorizontal: 16, flexDirection: "row", flexWrap: "wrap", gap: 8, rowGap: 16 }}>
          {shown.map((x) => (
            <PersonTile key={x.id} p={x} size={size} onPress={() => router.push({ pathname: "/catalog/[p]", params: { p, title: x.name, person: x.id } })} />
          ))}
        </View>
        <MoreFooter show={q.hasMore && !needle} error={q.moreError} onRetry={() => void q.more()} />
      </ScrollView>
    </Screen>
  );
}
