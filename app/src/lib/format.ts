// Display helpers: sizes, speeds, relative times.

export function bytes(n: number | null | undefined): string {
  if (!n || n <= 0) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}

export function speed(n: number | null | undefined): string {
  return n && n > 0 ? `${bytes(n)}/s` : "—";
}

// Seconds-or-ISO timestamp → "3 分钟前" relative to `now` (ms).
export function ago(t: number | string | null | undefined, now: number): string {
  if (!t) return "";
  const ms = typeof t === "number" ? (t > 1e12 ? t : t * 1000) : Date.parse(t.includes("T") || t.includes("Z") ? t : t.replace(" ", "T") + "+08:00");
  if (!Number.isFinite(ms)) return "";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`;
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function eta(s: number | null | undefined): string {
  if (!s || s <= 0 || s >= 8640000) return "";
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟`;
  if (s < 86400) return `${(s / 3600).toFixed(1)} 小时`;
  return `${Math.round(s / 86400)} 天`;
}

export function pct(p: number | null | undefined): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return "";
  return `${p >= 99.95 ? 100 : p.toFixed(p < 10 ? 1 : 0)}%`;
}

// [1,2,3,5,6] → "1-3, 5-6"
export function ranges(eps: number[]): string {
  const s = [...new Set(eps)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(i === j ? `${s[i]}` : `${s[i]}-${s[j]}`);
    i = j + 1;
  }
  return out.join(", ");
}

// Duration in seconds → "45 秒" / "3 分 12 秒" / "2 小时 5 分" / "3 天 4 小时".
export function dur(s: number | null | undefined): string {
  if (s === null || s === undefined || !Number.isFinite(s) || s < 0) return "";
  const n = Math.round(s);
  if (n < 60) return `${n} 秒`;
  if (n < 3600) return `${Math.floor(n / 60)} 分${n % 60 ? ` ${n % 60} 秒` : ""}`;
  if (n < 86400) return `${Math.floor(n / 3600)} 小时${Math.floor((n % 3600) / 60) ? ` ${Math.floor((n % 3600) / 60)} 分` : ""}`;
  return `${Math.floor(n / 86400)} 天${Math.floor((n % 86400) / 3600) ? ` ${Math.floor((n % 86400) / 3600)} 小时` : ""}`;
}

// Epoch seconds → "14:02" today, "10-26 14:02" otherwise.
export function clock(t: number | null | undefined, now: number): string {
  if (!t) return "";
  const d = new Date(t * 1000);
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  const today = new Date(now).toDateString() === d.toDateString();
  return today ? hm : `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, "0")} ${hm}`;
}
