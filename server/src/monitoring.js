// Read-only Monitoring-Endpunkt: GET /api/monitoring/summary?since=<ISO-8601>
// Auth: Bearer-Token aus MONITORING_TOKEN (leer → Route existiert nicht).
// Liefert ausschließlich Zahlen.
import { createHash, timingSafeEqual } from "node:crypto";
import { monitoringSummary } from "./db.js";

const MAX_FAILURES = 10;
const LOCK_MS = 15 * 60000;
const MAX_AGE_MS = 400 * 86400000;
const failures = new Map(); // ip -> { count, until }

setInterval(() => {
  const now = Date.now();
  for (const [ip, f] of failures) if (f.until < now) failures.delete(ip);
}, 60000).unref();

function sha(s) {
  return createHash("sha256").update(String(s)).digest();
}

function send(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

// Gibt true zurück, wenn die Anfrage behandelt wurde.
export function handleMonitoring(req, res, ip) {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname !== "/api/monitoring/summary") return false;
  const token = process.env.MONITORING_TOKEN || "";
  if (!token) { send(res, 404, { error: "not found" }); return true; }
  if (req.method !== "GET") { send(res, 405, { error: "method not allowed" }); return true; }

  const fail = failures.get(ip);
  if (fail && fail.count >= MAX_FAILURES && Date.now() < fail.until) {
    send(res, 429, { error: "too many failures" });
    return true;
  }
  const m = /^Bearer (.+)$/.exec(String(req.headers.authorization || ""));
  if (!m || !timingSafeEqual(sha(m[1]), sha(token))) {
    failures.set(ip, { count: (fail?.count || 0) + 1, until: Date.now() + LOCK_MS });
    send(res, 401, { error: "unauthorized" });
    return true;
  }
  failures.delete(ip);

  const now = Date.now();
  let sinceMs = now - 86400000;
  const raw = url.searchParams.get("since");
  if (raw !== null) {
    sinceMs = Date.parse(raw);
    if (!Number.isFinite(sinceMs) || sinceMs > now || sinceMs < now - MAX_AGE_MS) {
      send(res, 400, { error: "invalid since" });
      return true;
    }
  }
  const sinceSql = new Date(sinceMs).toISOString().slice(0, 19).replace("T", " ");
  send(res, 200, {
    app: "draw",
    since: new Date(sinceMs).toISOString(),
    until: new Date(now).toISOString(),
    counters: monitoringSummary(sinceSql),
  });
  return true;
}
