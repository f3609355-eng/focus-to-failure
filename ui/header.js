export function prettyPhase(p) {
  const s = String(p || "").toUpperCase();
  if (!s) return "--";
  if (s === "LINEAR") return "Building";
  if (s.startsWith("WAVE")) return "Wave";
  return s.charAt(0) + s.slice(1).toLowerCase();
}

export function friendlyBlockType(bt) {
  if (!bt) return "";
  if (bt === "CONSOLIDATE") return "Consolidation";
  if (bt === "PUSH" || bt === "PUSH_A" || bt === "PUSH_B") return "Push";
  if (bt === "RAISE_FLOOR") return "Floor raise";
  return bt;
}
