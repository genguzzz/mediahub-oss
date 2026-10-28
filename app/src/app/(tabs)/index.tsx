import { ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { itemCard } from "@/components/embyCards";
import { LandscapeTile, PosterTile, Row } from "@/components/media";
import { Chip, ChipRow, EmptyState, ErrorBox, IconButton, Loading, PillButton, TAB_BAR_SPACE, TabHeader, Pull } from "@/components/ui";
import { embyApi, type Item } from "@/lib/emby";
import { useQuery } from "@/lib/query";
import { useSettings } from "@/lib/settings";
import { colors } from "@/lib/theme";

const ADULT = new Set(["AV", "里番"]);

export default function LibraryHome() {
  const router = useRouter();
  const showAdult = useSettings((s) => s.showAdult);
  const loggedIn = useSettings((s) => !!s.emby.token);
  const hasToken = useSettings((s) => !!s.token);
  const views = useQuery(hasToken ? "emby:views" : null, () => embyApi.views(), { staleMs: 10 * 60_000 });
  const resume = useQuery(hasToken ? "emby:resume" : null, () => embyApi.resume(20), { staleMs: 30_000 });
  const nextUp = useQuery(hasToken ? "emby:nextup" : null, () => embyApi.nextUp(20), { staleMs: 60_000 });
  const libs = (views.data?.Items ?? []).filter((v) => (showAdult || !ADULT.has(v.Name)) && v.CollectionType !== "playlists");

  const open = (i: Item) => {
    if (i.Type === "Episode" || i.Type === "Movie" || i.Type === "Video") router.push({ pathname: "/emby/[id]", params: { id: i.Id } });
    else router.push({ pathname: "/emby/[id]", params: { id: i.Id } });
  };
  const play = (i: Item) => router.push({ pathname: "/player", params: { id: i.Id, resume: "1" } });

  const refresh = () => {
    void views.refresh();
    void resume.refresh();
    void nextUp.refresh();
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <TabHeader title="媒体库" right={<IconButton name="search" label="搜索媒体库" onPress={() => router.push({ pathname: "/library/[id]", params: { id: "all", name: "全部", search: "1" } })} />} />
      {!hasToken ? (
        <EmptyState icon="link-outline" text="还没有连接服务器。在设置里填写访问令牌后，会自动登录 Emby。" action={<PillButton small label="打开设置" onPress={() => router.push("/settings")} />} />
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: TAB_BAR_SPACE }} refreshControl={<Pull onRefresh={refresh} />}>
          {views.error ? <ErrorBox text={views.error} onRetry={refresh} /> : null}
          {!views.data && views.loading ? <Loading text={loggedIn ? "正在读取媒体库" : "正在登录 Emby"} /> : null}
          {libs.length ? (
            <ChipRow style={{ marginTop: 4 }}>
              {libs.map((v) => <Chip key={v.Id} label={v.Name} onPress={() => router.push({ pathname: "/library/[id]", params: { id: v.Id, name: v.Name } })} />)}
              <Chip label="收藏" icon="heart" onPress={() => router.push({ pathname: "/library/[id]", params: { id: "favorites", name: "收藏" } })} />
            </ChipRow>
          ) : null}
          {resume.data?.Items.length ? (
            <Row title="继续观看">
              {resume.data.Items.filter((i) => showAdult || !isAdultPath(i)).map((i) => <LandscapeTile key={i.Id} c={itemCard(i, play, true)} />)}
            </Row>
          ) : null}
          {nextUp.data?.Items.length ? (
            <Row title="接下来">
              {nextUp.data.Items.map((i) => <LandscapeTile key={i.Id} w={220} c={itemCard(i, open, true)} />)}
            </Row>
          ) : null}
          {libs.map((v) => <LatestRow key={v.Id} lib={v} open={open} onMore={() => router.push({ pathname: "/library/[id]", params: { id: v.Id, name: v.Name } })} />)}
          {views.data && !libs.length ? <Text style={{ color: colors.textSoft, padding: 16 }}>这个账号看不到任何媒体库。</Text> : null}
        </ScrollView>
      )}
    </View>
  );
}

function isAdultPath(i: Item) {
  return /\/(AV|里番)\//.test(i.Path ?? "");
}

function LatestRow({ lib, open, onMore }: { lib: Item; open: (i: Item) => void; onMore: () => void }) {
  const q = useQuery(`emby:latest:${lib.Id}`, () => embyApi.latest(lib.Id, 16), { staleMs: 60_000 });
  if (!q.data?.length) return null;
  return (
    <Row title={`最近添加 · ${lib.Name}`} onMore={onMore}>
      {q.data.map((i) => <PosterTile key={i.Id} c={itemCard(i, open)} />)}
    </Row>
  );
}

