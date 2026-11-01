// Blocks in the assistant's Markdown: a fenced block whose info string is a block type and whose body is
// JSON renders as a component; everything else stays Markdown. While streaming, an unclosed block is
// `open` (skeleton); a closed block with bad JSON falls back to its raw text. Schemas: server/src/ai/prompt.ts.
export const BLOCK_TYPES = ["media", "video"] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

export type Segment =
  | { k: "md"; text: string; key: string }
  | { k: "block"; type: BlockType; data: any; open: boolean; raw: string; error: boolean; key: string };

const FENCE = /^```([a-z]+)\s*$/;

export function segments(src: string, live: boolean): Segment[] {
  const out: Segment[] = [];
  const lines = src.split("\n");
  let md: string[] = [];
  const flush = () => {
    if (md.join("").trim()) out.push({ k: "md", text: md.join("\n"), key: `m${out.length}` });
    md = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE.exec(lines[i].trim());
    if (!m || !(BLOCK_TYPES as readonly string[]).includes(m[1])) {
      md.push(lines[i]);
      continue;
    }
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== "```") j++;
    const closed = j < lines.length;
    const raw = lines.slice(i + 1, j).join("\n");
    flush();
    let data: any = null;
    let error = false;
    if (closed || !live) {
      data = parseBlock(raw);
      error = data === null;
    }
    out.push({ k: "block", type: m[1] as BlockType, data, open: !closed && live, raw, error, key: `b${out.length}` });
    i = closed ? j : lines.length;
  }
  flush();
  return out;
}

// The model sometimes leaves stray text around a block's JSON (a tool-call tag like </parameter>, a word
// before it): parse it as written, else the outermost JSON array / object inside it.
function parseBlock(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    const t = raw.replace(/<\/?(parameter|invoke|antml:[\w-]+)[^>]*>/g, "");
    for (const [open, close] of [["[", "]"], ["{", "}"]]) {
      const a = t.indexOf(open);
      const b = t.lastIndexOf(close);
      if (a < 0 || b <= a) continue;
      try {
        return JSON.parse(t.slice(a, b + 1));
      } catch {
        // try the other shape
      }
    }
    return null;
  }
}
