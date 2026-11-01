// Subtitle text for the assistant: parse ASS / SSA / SRT / VTT into timed lines, so it can find a scene by
// what is said ("直升机撒钱") and jump the TV there, or read the dialogue around a moment.
export interface Cue { start: number; end: number; text: string }

const assTime = (t: string) => {
  const [h, m, s] = t.trim().split(":");
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
};
const srtTime = (t: string) => {
  const m = /(?:(\d+):)?(\d+):(\d+)[.,](\d+)/.exec(t.trim());
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(`0.${m[4]}`) : 0;
};

export function parseSubtitles(raw: Buffer): Cue[] {
  // UTF-8 (with or without BOM) or UTF-16 LE, the encodings subtitle files come in
  const text = raw[0] === 0xff && raw[1] === 0xfe ? raw.toString("utf16le") : raw.toString("utf8").replace(/^﻿/, "");
  const out: Cue[] = [];
  if (/^\s*\[Script Info\]/im.test(text) || /^Dialogue:/m.test(text)) {
    // ASS: "Dialogue: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text"; skip songs / signs styles
    const skip = /^(op|ed|lrc|song|title|staff|comment|sign|screen)/i;
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("Dialogue:")) continue;
      const p = line.slice(9).split(",");
      if (p.length < 10 || skip.test(p[3].trim())) continue;
      const t = p.slice(9).join(",").replace(/\{[^}]*\}/g, "").replace(/\\[Nn]/g, " ").replace(/\\h/g, " ").trim();
      if (t) out.push({ start: assTime(p[1]), end: assTime(p[2]), text: t });
    }
  } else {
    // SRT / VTT blocks: "00:01:02,345 --> 00:01:04,000" then text lines
    for (const block of text.split(/\r?\n\s*\r?\n/)) {
      const lines = block.split(/\r?\n/);
      const i = lines.findIndex((l) => l.includes("-->"));
      if (i < 0) continue;
      const [a, b] = lines[i].split("-->");
      const t = lines.slice(i + 1).join(" ").replace(/<[^>]+>/g, "").replace(/\{[^}]*\}/g, "").trim();
      if (t) out.push({ start: srtTime(a), end: srtTime(b), text: t });
    }
  }
  // the same line twice in a row (bilingual tracks, karaoke layers) reads as one
  return out.sort((x, y) => x.start - y.start).filter((c, i, a) => i === 0 || c.text !== a[i - 1].text || c.start - a[i - 1].start > 2);
}

export const clock = (n: number) => {
  const s = Math.max(0, Math.floor(n));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, "");

/** Lines matching any of the words (and the lines around each hit), or a window of lines from a time. */
export function searchCues(cues: Cue[], o: { q?: string; from?: number; limit: number; around: number }) {
  const view = (c: Cue) => ({ at: clock(c.start), sec: Math.floor(c.start), text: c.text.slice(0, 160) });
  if (o.q?.trim()) {
    const words = o.q.split(/[\s,，|、]+/).map(norm).filter(Boolean);
    const hits = cues.map((c, i) => ({ c, i })).filter(({ c }) => words.some((w) => norm(c.text).includes(w))).slice(0, o.limit);
    return {
      total: cues.length,
      hits: hits.length,
      results: hits.map(({ c, i }) => ({ ...view(c), context: cues.slice(Math.max(0, i - o.around), i + o.around + 1).filter((x) => x !== c).map(view) })),
    };
  }
  const start = cues.findIndex((c) => c.start >= (o.from ?? 0));
  return { total: cues.length, lines: (start < 0 ? [] : cues.slice(start, start + o.limit)).map(view) };
}
