// Serverseitige Validierung von Stroke-Daten aus dem Client (Feed-Replay
// und Live-Ansicht der Mitspieler). Ohne Prüfung könnten manipulierte
// Strokes das Rendering aller anderen Clients crashen oder als Müll in der
// Datenbank landen. Liefert eine bereinigte Kopie oder null bei Unbrauchbarem.

const MAX_STROKES = 600;
const MAX_POINTS_PER_STROKE = 2000;
const MAX_STROKE_SIZE = 60; // größter Radierer im Client: 12 * 4 = 48
const COLOR_RE = /^#[0-9a-f]{3,8}$/i;

export function sanitizeStrokes(strokes) {
  if (!Array.isArray(strokes) || strokes.length > MAX_STROKES) return null;
  const out = [];
  for (const s of strokes) {
    if (!s || typeof s !== "object" || !Array.isArray(s.points)) return null;
    if (!s.points.length || s.points.length > MAX_POINTS_PER_STROKE) return null;
    const points = [];
    for (const p of s.points) {
      if (!Array.isArray(p)) return null;
      const x = Number(p[0]);
      const y = Number(p[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      points.push([Math.round(x), Math.round(y)]);
    }
    const size = Number(s.size);
    out.push({
      color: typeof s.color === "string" && COLOR_RE.test(s.color) ? s.color : "#111111",
      size: Number.isFinite(size) ? Math.min(Math.max(size, 1), MAX_STROKE_SIZE) : 5,
      points,
    });
  }
  return out;
}
