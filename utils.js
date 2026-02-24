export function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

export function fmtHHMMSS(sec) {
  if (sec == null) return "--";
  sec = Math.max(0, Math.floor(sec));
  const s = sec % 60;
  const m0 = Math.floor(sec / 60);
  const m = m0 % 60;
  const h = Math.floor(m0 / 60);
  if (h > 0)
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function fmtMin(sec) {
  if (sec == null) return "--";
  return `${Math.round(sec / 60)}m`;
}

export function nowTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function bucketForDate(d) {
  const h = d.getHours();
  if (h >= 5 && h <= 11) return "Morning";
  if (h >= 12 && h <= 16) return "Afternoon";
  if (h >= 17 && h <= 21) return "Evening";
  return "Night";
}

export function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Generate a UUID v4. */
export function uuid() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {}
  const s = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  s[6] = (s[6] & 0x0f) | 0x40;
  s[8] = (s[8] & 0x3f) | 0x80;
  const hex = s.map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Escape HTML entities. */
export function escHTML(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
