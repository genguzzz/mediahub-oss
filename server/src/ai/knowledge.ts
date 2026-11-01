// Platform knowledge for the assistant, disclosed progressively: the system prompt carries only this index
// (one line per topic); read_knowledge loads a topic's document (knowledge/<topic>.md) when a question needs
// it. Documents are generic (how the stack works); live values of this deployment come from platform_status.
import { readFileSync } from "node:fs";
import path from "node:path";

export const TOPICS = {
  platform: "整体架构：App / 后端 / MoviePilot / Prowlarr115 插件 / 115 / OpenList / Emby 怎么配合，媒体库目录规则",
  ingest: "入库流水线：六步、每个状态的含义、失败怎么回滚、主人能在任务详情里做什么",
  subscriptions: "MoviePilot 订阅：怎么自动追更、身份去重、自动订阅助手、缺集",
  emby: "Emby 媒体库与播放：strm 302 播放、刮削与刷新、库里有没有、观看记录的范围",
  selection: "选片策略：画质/体积/字幕/字幕组规则，excluded 和评分从哪来",
  app: "App 里各功能在哪、去哪操作、回答里可用的页面链接",
  troubleshooting: "常见问题怎么判断：卡 0%、no-video、没刮削、缺集、播放失败",
  adult: "AV / 里番 的索引、入库和刮削（只在成人内容开着时）",
} as const;
export type Topic = keyof typeof TOPICS;

const dir = path.join(path.dirname(new URL(import.meta.url).pathname), "knowledge");
const cache = new Map<Topic, string>();

export function readKnowledge(topic: Topic): string {
  let t = cache.get(topic);
  if (t === undefined) {
    t = readFileSync(path.join(dir, `${topic}.md`), "utf8");
    cache.set(topic, t);
  }
  return t;
}

export function knowledgeIndex(adult: boolean): string {
  return (Object.entries(TOPICS) as [Topic, string][]).filter(([k]) => adult || k !== "adult").map(([k, v]) => `- ${k}: ${v}`).join("\n");
}
