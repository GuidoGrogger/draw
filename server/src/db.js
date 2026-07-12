// SQLite-Datenbank für Draw & Guess:
// - sessions:  jede gestartete Spielsession (Solo & Multiplayer)
// - api_calls: jeder KI-Check mit Kosten (USD) → Kostenkontrolle & Admin-Diagramm
// - wins:      gewonnene Runden (Bild, Begriff, Zeit) → Social-Feed auf der Startseite
// - settings:  Monatslimit (EUR) u.a., änderbar über das Admin-Backend

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_DB_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../data/draw-guess.sqlite"
);
const DB_PATH = process.env.DB_PATH || DEFAULT_DB_PATH;

mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  mode       TEXT NOT NULL,               -- 'solo' | 'multi'
  nickname   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS api_calls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT,
  model       TEXT,
  cost_usd    REAL NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS wins (
  id         TEXT PRIMARY KEY,
  session_id TEXT,
  nickname   TEXT NOT NULL,
  mode       TEXT NOT NULL,
  word       TEXT NOT NULL,
  image      TEXT,                        -- Daten-URL (JPEG) der Siegerzeichnung
  strokes    TEXT,                        -- JSON-Strokes für animiertes Replay (optional)
  duration_s INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_calls_created ON api_calls(created_at);
CREATE INDEX IF NOT EXISTS idx_api_calls_session ON api_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_wins_created ON wins(created_at);
`);

// ---- Settings (mit Defaults) ----
const SETTING_DEFAULTS = {
  monthly_limit_eur: "20", // Startwert laut Vorgabe: 20 € pro Monat
  eur_per_usd: "0.90",     // fester Umrechnungskurs für die Limit-Prüfung
};

const getSettingStmt = db.prepare("SELECT v FROM settings WHERE k = ?");
const setSettingStmt = db.prepare(
  "INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v"
);

export function getSetting(key) {
  const row = getSettingStmt.get(key);
  return row ? row.v : SETTING_DEFAULTS[key];
}

export function setSetting(key, value) {
  setSettingStmt.run(key, String(value));
}

export function getMonthlyLimitEur() {
  const v = parseFloat(getSetting("monthly_limit_eur"));
  return Number.isFinite(v) && v >= 0 ? v : 20;
}

export function getEurPerUsd() {
  const v = parseFloat(getSetting("eur_per_usd"));
  return Number.isFinite(v) && v > 0 ? v : 0.9;
}

// ---- Nicknames ----
const ANON_ADJECTIVES = [
  "Flink", "Mutig", "Schlau", "Frech", "Leise", "Wild", "Bunt", "Tapfer",
  "Neugierig", "Verträumt", "Heimlich", "Sportlich",
];
const ANON_ANIMALS = [
  "Fuchs", "Igel", "Eule", "Dachs", "Otter", "Luchs", "Biber", "Falke",
  "Marder", "Wiesel", "Kauz", "Hummel",
];

export function anonymousNickname() {
  const a = ANON_ADJECTIVES[Math.floor(Math.random() * ANON_ADJECTIVES.length)];
  const t = ANON_ANIMALS[Math.floor(Math.random() * ANON_ANIMALS.length)];
  return `${a}er ${t} ${Math.floor(Math.random() * 90) + 10}`;
}

// Nickname säubern; leer → anonymer Name (Nutzer wurden im UI darauf hingewiesen,
// dass Name & Sessions öffentlich angezeigt werden können).
export function normalizeNickname(raw) {
  const cleaned = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f<>]/g, "")
    .trim()
    .slice(0, 24);
  return cleaned || anonymousNickname();
}

// ---- Sessions ----
const insertSessionStmt = db.prepare(
  "INSERT INTO sessions (id, mode, nickname) VALUES (?, ?, ?)"
);
const sessionExistsStmt = db.prepare("SELECT 1 FROM sessions WHERE id = ?");

export function createSession(mode, rawNickname) {
  const id = randomUUID();
  const nickname = normalizeNickname(rawNickname);
  insertSessionStmt.run(id, mode, nickname);
  return { id, nickname };
}

export function sessionExists(id) {
  return Boolean(id && sessionExistsStmt.get(id));
}

// ---- Kosten pro KI-Check ----
const insertCallStmt = db.prepare(
  "INSERT INTO api_calls (session_id, model, cost_usd, duration_ms) VALUES (?, ?, ?, ?)"
);
const monthCostStmt = db.prepare(
  `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM api_calls
   WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')`
);

// Monats-Summe im Speicher halten, damit nicht jeder Guess eine Aggregation macht.
let monthCache = { month: null, totalUsd: 0 };

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

export function recordApiCall({ sessionId = null, model = null, costUsd = 0, durationMs = null }) {
  const cost = Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0;
  insertCallStmt.run(sessionId, model, cost, durationMs);
  if (monthCache.month === currentMonth()) monthCache.totalUsd += cost;
  else monthCache = { month: null, totalUsd: 0 };
}

export function monthCostUsd() {
  if (monthCache.month !== currentMonth()) {
    monthCache = { month: currentMonth(), totalUsd: monthCostStmt.get().total };
  }
  return monthCache.totalUsd;
}

export function monthCostEur() {
  return monthCostUsd() * getEurPerUsd();
}

// true, wenn das konfigurierte Monatslimit erreicht ist → keine KI-Checks mehr.
export function limitReached() {
  return monthCostEur() >= getMonthlyLimitEur();
}

// ---- Wins (Social-Feed) ----
const insertWinStmt = db.prepare(
  `INSERT INTO wins (id, session_id, nickname, mode, word, image, duration_s)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);
const attachStrokesStmt = db.prepare("UPDATE wins SET strokes = ? WHERE id = ?");
const feedStmt = db.prepare(
  `SELECT id, nickname, mode, word, image, strokes, duration_s, created_at
   FROM wins ORDER BY created_at DESC, rowid DESC LIMIT ?`
);

export function recordWin({ sessionId = null, nickname, mode, word, image = null, durationS = null }) {
  const id = randomUUID();
  insertWinStmt.run(
    id,
    sessionId,
    normalizeNickname(nickname),
    mode,
    String(word).slice(0, 60),
    typeof image === "string" && image.startsWith("data:image/") ? image.slice(0, 200000) : null,
    Number.isFinite(durationS) ? Math.max(0, Math.round(durationS)) : null
  );
  return id;
}

export function attachWinStrokes(winId, strokes) {
  const json = JSON.stringify(strokes);
  if (json.length > 300000) return false;
  return attachStrokesStmt.run(json, winId).changes > 0;
}

export function getFeed(limit = 12) {
  return feedStmt.all(Math.min(Math.max(1, limit), 30)).map((w) => ({
    id: w.id,
    nickname: w.nickname,
    mode: w.mode,
    word: w.word,
    image: w.image,
    strokes: w.strokes ? safeParse(w.strokes) : null,
    durationS: w.duration_s,
    createdAt: w.created_at + "Z", // SQLite speichert UTC ohne Zeitzonen-Suffix
  }));
}

function safeParse(json) {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// ---- Admin-Auswertungen ----
const dailyCostStmt = db.prepare(
  `SELECT date(created_at) AS day, SUM(cost_usd) AS cost_usd, COUNT(*) AS calls
   FROM api_calls WHERE created_at >= date('now', '-29 days')
   GROUP BY day ORDER BY day`
);
const monthlyCostStmt = db.prepare(
  `SELECT strftime('%Y-%m', created_at) AS month, SUM(cost_usd) AS cost_usd, COUNT(*) AS calls
   FROM api_calls GROUP BY month ORDER BY month DESC LIMIT 12`
);
const recentSessionsStmt = db.prepare(
  `SELECT s.id, s.mode, s.nickname, s.created_at,
          COALESCE(c.cost_usd, 0) AS cost_usd, COALESCE(c.calls, 0) AS calls,
          COALESCE(w.wins, 0) AS wins
   FROM sessions s
   LEFT JOIN (SELECT session_id, SUM(cost_usd) AS cost_usd, COUNT(*) AS calls
              FROM api_calls GROUP BY session_id) c ON c.session_id = s.id
   LEFT JOIN (SELECT session_id, COUNT(*) AS wins FROM wins GROUP BY session_id) w
              ON w.session_id = s.id
   ORDER BY s.created_at DESC LIMIT 25`
);
const totalsStmt = db.prepare(
  "SELECT COALESCE(SUM(cost_usd), 0) AS cost_usd, COUNT(*) AS calls FROM api_calls"
);

export function adminOverview() {
  const eurPerUsd = getEurPerUsd();
  return {
    limitEur: getMonthlyLimitEur(),
    eurPerUsd,
    monthCostUsd: monthCostUsd(),
    monthCostEur: monthCostEur(),
    days: dailyCostStmt.all().map((d) => ({
      day: d.day,
      costUsd: d.cost_usd,
      costEur: d.cost_usd * eurPerUsd,
      calls: d.calls,
    })),
    months: monthlyCostStmt.all().map((m) => ({
      month: m.month,
      costUsd: m.cost_usd,
      costEur: m.cost_usd * eurPerUsd,
      calls: m.calls,
    })),
    sessions: recentSessionsStmt.all().map((s) => ({
      id: s.id,
      mode: s.mode,
      nickname: s.nickname,
      createdAt: s.created_at + "Z",
      costUsd: s.cost_usd,
      calls: s.calls,
      wins: s.wins,
    })),
    totals: totalsStmt.get(),
  };
}

export { DB_PATH };
