// Draw & Guess Backend
// - POST /api/verify        : Zugangscode prüfen
// - POST /api/session/start : Spielsession anlegen (Nickname → DB)
// - POST /api/guess         : Canvas-Bild an Claude → Guesses + Fraud-Check (+ Kosten in DB)
// - POST /api/win/strokes   : Strokes einer Siegerzeichnung nachreichen (animierter Feed)
// - GET  /api/feed          : öffentliche Liste gewonnener Runden (Startseite)
// - GET  /api/admin/*       : geschütztes Admin-Backend (Kosten, Limit)
// - GET  /*                 : statisches Frontend (../web)
// - WS   /ws                : Multiplayer-Relay (Lobby, Live-Strokes)

import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

import { guessDrawing } from "./guesser.js";
import { anyMatch } from "./matching.js";
import {
  createRoom, joinRoom, handleDuelGuess, handleWsMessage, handleDisconnect,
  roomHasPlayer, roomSessionId, getRoom,
} from "./rooms.js";
import {
  createSession, sessionExists, recordApiCall, recordWin, attachWinStrokes,
  getFeed, limitReached, getMonthlyLimitEur, getEurPerUsd, monthCostEur,
  setSetting, adminOverview, DB_PATH,
} from "./db.js";

const PORT = parseInt(process.env.PORT || "8790", 10);
const ACCESS_CODE = process.env.ACCESS_CODE || "";
const ADMIN_CODE = process.env.ADMIN_CODE || "";
const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");

if (!ACCESS_CODE) {
  console.error("FEHLER: ACCESS_CODE ist nicht gesetzt (Env). Server startet nicht.");
  process.exit(1);
}
if (!ADMIN_CODE) {
  console.warn("WARNUNG: ADMIN_CODE ist nicht gesetzt — das Admin-Backend ist deaktiviert.");
}
if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY && process.env.FAKE_GUESSER !== "1") {
  console.warn("WARNUNG: Weder CLAUDE_CODE_OAUTH_TOKEN noch ANTHROPIC_API_KEY gesetzt — /api/guess wird fehlschlagen.");
}

// ---- Rate-Limiting: pro Client min. Abstand zwischen KI-Checks ----
const lastGuessAt = new Map(); // key -> timestamp
const MIN_GUESS_INTERVAL_MS = 4000;
setInterval(() => {
  const cutoff = Date.now() - 10 * 60000;
  for (const [k, t] of lastGuessAt) if (t < cutoff) lastGuessAt.delete(k);
}, 60000);

// ---- Stroke-Tokens: nur der Gewinner darf seine Strokes nachreichen ----
const strokeTokens = new Map(); // token -> { winId, expires }
function issueStrokeToken(winId) {
  const token = randomUUID();
  strokeTokens.set(token, { winId, expires: Date.now() + 5 * 60000 });
  return token;
}
setInterval(() => {
  const now = Date.now();
  for (const [t, v] of strokeTokens) if (v.expires < now) strokeTokens.delete(t);
}, 60000);

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Access-Code, X-Admin-Code");
}

function json(res, status, obj) {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function authorized(req) {
  return (req.headers["x-access-code"] || "") === ACCESS_CODE;
}

function adminAuthorized(req) {
  return Boolean(ADMIN_CODE) && (req.headers["x-admin-code"] || "") === ADMIN_CODE;
}

async function readBody(req, limit = 2.5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("too_large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson(req) {
  try {
    return JSON.parse(await readBody(req));
  } catch {
    return null;
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

async function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/") p = "/index.html";
  if (p === "/admin") p = "/admin.html";
  const file = path.resolve(WEB_DIR, "." + p);
  if (!file.startsWith(WEB_DIR)) return json(res, 403, { error: "forbidden" });
  try {
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    json(res, 404, { error: "not found" });
  }
}

async function handleGuess(req, res) {
  const body = await readJson(req);
  if (!body) return json(res, 400, { error: "bad json" });

  // Auth: Zugangscode ODER gültige Mitgliedschaft in einem Multiplayer-Raum
  // (Eingeladene haben keinen Zugangscode — sie sind über den Raum legitimiert).
  const viaRoom = body.roomCode && body.playerId && roomHasPlayer(body.roomCode, body.playerId);
  if (!authorized(req) && !viaRoom) return json(res, 401, { error: "unauthorized" });

  const key = viaRoom
    ? "p:" + body.playerId
    : "c:" + (req.socket.remoteAddress || "") + ":" + (req.headers["x-forwarded-for"] || "");
  const last = lastGuessAt.get(key) || 0;
  if (Date.now() - last < MIN_GUESS_INTERVAL_MS) return json(res, 429, { error: "rate" });
  lastGuessAt.set(key, Date.now());

  // Monatslimit (Admin-Backend, Standard 20 €): erreicht → keine KI-Checks mehr.
  if (limitReached()) {
    return json(res, 503, {
      error: "limit",
      message: `Das Monatslimit von ${getMonthlyLimitEur().toFixed(2)} € ist erreicht. Nächsten Monat geht's weiter!`,
    });
  }

  // Nur im FAKE_GUESSER-Testmodus relevant (macht Treffer testbar).
  const hintWord = body.targetWord || getRoom(body.roomCode)?.word || null;

  let aiResult;
  try {
    aiResult = await guessDrawing(body.image, body.excludeTerms, hintWord);
  } catch (err) {
    if (err.code === "BUSY") return json(res, 429, { error: "busy" });
    console.error("guess failed:", err.message);
    return json(res, 502, { error: "KI-Anfrage fehlgeschlagen" });
  }

  // Kosten dieses Checks in der DB festhalten (pro Session auswertbar).
  const sessionId = viaRoom
    ? roomSessionId(body.roomCode)
    : (sessionExists(body.sessionId) ? body.sessionId : null);
  recordApiCall({
    sessionId,
    model: aiResult.model,
    costUsd: aiResult.costUsd,
    durationMs: aiResult.durationMs,
  });

  // Multiplayer: Server wertet gegen das Rundenwort aus und steuert den Raum
  if (viaRoom) {
    const result = handleDuelGuess(body.roomCode, body.playerId, aiResult, anyMatch, body.image);
    if (result.error) return json(res, 400, { error: result.error });
    if (result.winId) result.strokeToken = issueStrokeToken(result.winId);
    delete result.winId;
    return json(res, 200, result);
  }

  // Solo: gegen das mitgeschickte Zielwort prüfen
  const disqualified = aiResult.writtenText;
  const hit = !disqualified && body.targetWord ? anyMatch(aiResult.guesses, body.targetWord) : false;
  const response = {
    guesses: disqualified ? [] : aiResult.guesses,
    comment: disqualified ? "" : aiResult.comment,
    hit,
    disqualified,
  };

  // Treffer im Feed festhalten (Bild, Begriff, Zeit, Nickname der Session)
  if (hit && sessionId) {
    const winId = recordWin({
      sessionId,
      nickname: body.nickname,
      mode: "solo",
      word: body.targetWord,
      image: body.image,
      durationS: Number(body.elapsedS),
    });
    response.strokeToken = issueStrokeToken(winId);
  }
  return json(res, 200, response);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      cors(res);
      res.writeHead(204);
      return res.end();
    }

    if (req.method === "POST" && req.url === "/api/verify") {
      return json(res, authorized(req) ? 200 : 401, { ok: authorized(req) });
    }

    if (req.method === "POST" && req.url === "/api/session/start") {
      if (!authorized(req)) return json(res, 401, { error: "unauthorized" });
      const body = (await readJson(req)) || {};
      const session = createSession("solo", body.nickname);
      return json(res, 200, { sessionId: session.id, nickname: session.nickname });
    }

    if (req.method === "POST" && req.url === "/api/guess") {
      return handleGuess(req, res);
    }

    if (req.method === "POST" && req.url === "/api/win/strokes") {
      const body = await readJson(req);
      if (!body || !body.token || !Array.isArray(body.strokes)) return json(res, 400, { error: "bad request" });
      const entry = strokeTokens.get(body.token);
      if (!entry || entry.expires < Date.now()) return json(res, 403, { error: "invalid token" });
      strokeTokens.delete(body.token);
      const ok = attachWinStrokes(entry.winId, body.strokes);
      return json(res, ok ? 200 : 400, { ok });
    }

    if (req.method === "GET" && req.url.startsWith("/api/feed")) {
      return json(res, 200, { wins: getFeed(12) });
    }

    // ---- Admin-Backend (geschützt über ADMIN_CODE) ----
    if (req.url.startsWith("/api/admin/")) {
      if (!ADMIN_CODE) return json(res, 503, { error: "Admin-Backend nicht konfiguriert (ADMIN_CODE fehlt)" });
      if (!adminAuthorized(req)) return json(res, 401, { error: "unauthorized" });

      if (req.method === "POST" && req.url === "/api/admin/verify") {
        return json(res, 200, { ok: true });
      }
      if (req.method === "GET" && req.url === "/api/admin/overview") {
        return json(res, 200, adminOverview());
      }
      if (req.method === "POST" && req.url === "/api/admin/settings") {
        const body = (await readJson(req)) || {};
        const limit = parseFloat(body.monthlyLimitEur);
        if (Number.isFinite(limit) && limit >= 0 && limit <= 10000) {
          setSetting("monthly_limit_eur", limit);
        }
        const rate = parseFloat(body.eurPerUsd);
        if (Number.isFinite(rate) && rate > 0 && rate <= 10) {
          setSetting("eur_per_usd", rate);
        }
        return json(res, 200, {
          ok: true,
          limitEur: getMonthlyLimitEur(),
          eurPerUsd: getEurPerUsd(),
          monthCostEur: monthCostEur(),
        });
      }
      return json(res, 404, { error: "not found" });
    }

    if (req.method === "GET" && req.url === "/api/health") {
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET") return serveStatic(req, res);
    json(res, 405, { error: "method not allowed" });
  } catch (err) {
    console.error("request error:", err);
    json(res, 500, { error: "internal" });
  }
});

// ---- WebSocket-Multiplayer-Relay ----
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  ws._joined = false;
  ws._joinAttempts = 0;
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString().slice(0, 500000));
    } catch {
      return;
    }
    if (!ws._joined) {
      // Erstellen erfordert den Zugangscode; Beitreten nur den Raumcode
      // (Einladungslink → einfach klicken und mitmachen).
      if (msg.type === "create") {
        if (msg.accessCode !== ACCESS_CODE) {
          send(ws, { type: "error", message: "Zugangscode ungültig" });
          return ws.close();
        }
        ws._joined = true;
        return createRoom(ws, msg.nickname);
      }
      if (msg.type === "join") {
        ws._joinAttempts++;
        if (ws._joinAttempts > 5) return ws.close();
        const before = ws._room;
        joinRoom(ws, msg.code, msg.nickname);
        if (ws._room && ws._room !== before) ws._joined = true;
        return;
      }
      send(ws, { type: "error", message: "Unbekannte Aktion" });
      return ws.close();
    }
    handleWsMessage(ws, msg);
  });
  ws.on("close", () => handleDisconnect(ws));
  ws.on("error", () => handleDisconnect(ws));
});

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Draw & Guess Server läuft auf http://127.0.0.1:${PORT}`);
  console.log(`Datenbank: ${DB_PATH}`);
});
