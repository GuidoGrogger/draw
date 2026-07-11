// Draw & Guess Backend
// - POST /api/verify  : Zugangscode prüfen
// - POST /api/guess   : Canvas-Bild an Claude (Agent SDK) → Guesses + Fraud-Check
// - GET  /*           : statisches Frontend (../web) — hinter nginx optional
// - WS   /ws          : Duell-Relay

import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

import { guessDrawing } from "./guesser.js";
import { anyMatch } from "./matching.js";
import { createRoom, joinRoom, handleDuelGuess, handleWsMessage, handleDisconnect } from "./rooms.js";

const PORT = parseInt(process.env.PORT || "8790", 10);
const ACCESS_CODE = process.env.ACCESS_CODE || "";
const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");

if (!ACCESS_CODE) {
  console.error("FEHLER: ACCESS_CODE ist nicht gesetzt (Env). Server startet nicht.");
  process.exit(1);
}
if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
  console.warn("WARNUNG: Weder CLAUDE_CODE_OAUTH_TOKEN noch ANTHROPIC_API_KEY gesetzt — /api/guess wird fehlschlagen.");
}

// ---- Rate-Limiting: pro Client min. Abstand zwischen KI-Checks ----
const lastGuessAt = new Map(); // key -> timestamp
const MIN_GUESS_INTERVAL_MS = 4000;
setInterval(() => {
  const cutoff = Date.now() - 10 * 60000;
  for (const [k, t] of lastGuessAt) if (t < cutoff) lastGuessAt.delete(k);
}, 60000);

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Access-Code");
}

function json(res, status, obj) {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function authorized(req) {
  return (req.headers["x-access-code"] || "") === ACCESS_CODE;
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

    if (req.method === "POST" && req.url === "/api/guess") {
      if (!authorized(req)) return json(res, 401, { error: "unauthorized" });

      const key = req.headers["x-access-code"] + ":" + (req.socket.remoteAddress || "") + ":" + (req.headers["x-forwarded-for"] || "");
      const last = lastGuessAt.get(key) || 0;
      if (Date.now() - last < MIN_GUESS_INTERVAL_MS) return json(res, 429, { error: "rate" });
      lastGuessAt.set(key, Date.now());

      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { error: "bad json" });
      }

      let aiResult;
      try {
        aiResult = await guessDrawing(body.image);
      } catch (err) {
        if (err.code === "BUSY") return json(res, 429, { error: "busy" });
        console.error("guess failed:", err.message);
        return json(res, 502, { error: "KI-Anfrage fehlgeschlagen" });
      }

      // Duell: Server wertet gegen das Rundenwort aus und steuert den Raum
      if (body.roomCode && body.playerId) {
        const result = handleDuelGuess(body.roomCode, body.playerId, aiResult, anyMatch);
        if (result.error) return json(res, 400, { error: result.error });
        return json(res, 200, result);
      }

      // Solo: gegen das mitgeschickte Zielwort prüfen
      const disqualified = aiResult.writtenText;
      const hit = !disqualified && body.targetWord ? anyMatch(aiResult.guesses, body.targetWord) : false;
      return json(res, 200, {
        guesses: disqualified ? [] : aiResult.guesses,
        comment: disqualified ? "" : aiResult.comment,
        hit,
        disqualified,
      });
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

// ---- WebSocket-Duell-Relay ----
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  ws._authed = false;
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString().slice(0, 500000));
    } catch {
      return;
    }
    if (!ws._authed) {
      if (msg.accessCode !== ACCESS_CODE) {
        ws.send(JSON.stringify({ type: "error", message: "Zugangscode ungültig" }));
        return ws.close();
      }
      ws._authed = true;
      if (msg.type === "create") return createRoom(ws);
      if (msg.type === "join") return joinRoom(ws, msg.code);
      ws.send(JSON.stringify({ type: "error", message: "Unbekannte Aktion" }));
      return ws.close();
    }
    handleWsMessage(ws, msg);
  });
  ws.on("close", () => handleDisconnect(ws));
  ws.on("error", () => handleDisconnect(ws));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Draw & Guess Server läuft auf http://127.0.0.1:${PORT}`);
});
