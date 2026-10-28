// Per-play startup timeline for tracking playback speed (115 strm via ge2o, web HLS). One
// `play_timeline` event per play, all times in ms since the player screen opened:
//   item / info / subs / plan          app side: Emby Items, PlaybackInfo, dir-subtitle list, plan ready
//   n_sourceOpened … n_presenting      native checkpoints (onStartup)
//   connect / openInput / findStreamInfo / demuxTotal / streams / probeMiB   from "[Demuxer] open timings"
//   firstData / sourceOpen             first source bytes, "[SourceOpen] elapsed_ms"
//   frame                              first "playing" phase
// plus context: kind, type, resume, container, codec, route, cdn host, prewarm bytes, network.
// Seeks report `play_seek` (ms from seek to playing) and stalls `play_stall` (offset into the play).
import { logger } from "./log";
import { track } from "./track";

const log = logger("playstats");

type Props = Record<string, string | number | boolean>;

export class PlayTimeline {
  private t0 = Date.now();
  private marks: Props = {};
  private ctx: Props = {};
  private done = false;
  private seekAt = 0;
  private stalls = 0;

  constructor(ctx: Props) {
    this.ctx = ctx;
  }

  get sent() {
    return this.done;
  }

  mark(name: string, at = Date.now()) {
    if (this.done || name in this.marks) return;
    this.marks[name] = at - this.t0;
  }

  set(values: Props) {
    Object.assign(this.ctx, values);
  }

  native(step: string, ms: number) {
    // ms is since the native load began; store against the screen clock as well.
    this.mark(`n_${step}`);
    if (!this.done) this.ctx[`nl_${step}`] = ms;
  }

  // Engine diagnostics forwarded by the module (URLs already cut to their host).
  engine(line: string) {
    log.info("engine", { line });
    const ms = (re: RegExp) => {
      const m = re.exec(line);
      return m ? Number(m[1]) : undefined;
    };
    if (line.includes("open timings")) {
      const v: Props = {};
      for (const [k, re] of [["connect", /connect (\d+)ms/], ["openInput", /open_input (\d+)ms/], ["findStreamInfo", /find_stream_info (\d+)ms/], ["demuxTotal", /total (\d+)ms/], ["streams", /(\d+) stream/], ["probeMiB", /probesize (\d+) MiB/]] as const) {
        const n = ms(re);
        if (n !== undefined && !(k in this.ctx)) v[k] = n;
      }
      this.set(v);
    } else if (/first data after/.test(line)) {
      const n = ms(/first data after (\d+)ms/);
      if (n !== undefined && !("firstData" in this.ctx)) this.ctx.firstData = n;
    } else if (line.includes("[SourceOpen]")) {
      const n = ms(/elapsed_ms=(\d+)/);
      if (n !== undefined && !("sourceOpen" in this.ctx)) this.ctx.sourceOpen = n;
    } else if (line.includes("Cached resolved URL")) {
      this.ctx.cdn = /host=(\S+)/.exec(line)?.[1] ?? "?";
    } else if (line.includes("[SourcePrewarm]")) {
      this.ctx.prewarmNote = line.replace(/^.*\[SourcePrewarm\]\s*/, "").slice(0, 80);
    } else if (/stall/.test(line) && this.done) {
      this.stalls += 1;
      track("play_stall", { at: Date.now() - this.t0, n: this.stalls, ...this.base() });
    }
  }

  private base(): Props {
    const { kind, type, container, codec, route } = this.ctx;
    return Object.fromEntries(Object.entries({ kind, type, container, codec, route }).filter(([, v]) => v !== undefined)) as Props;
  }

  // First frame: send the timeline once.
  playing() {
    if (this.seekAt) {
      track("play_seek", { ms: Date.now() - this.seekAt, ...this.base() });
      this.seekAt = 0;
    }
    if (this.done) return;
    this.mark("frame");
    this.done = true;
    const ev = { ...this.ctx, ...this.marks };
    log.info("timeline", ev);
    track("play_timeline", ev);
  }

  seeking() {
    if (this.done) this.seekAt = Date.now();
  }

  failed(message: string) {
    if (this.done) return;
    this.done = true;
    track("play_timeline", { ...this.ctx, ...this.marks, failed: true, err: message.slice(0, 120), at: Date.now() - this.t0 });
  }
}
