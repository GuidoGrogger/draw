// API-Client. Auf draw.grogger.de ist die API same-origin;
// von einer anderen Herkunft (z.B. lokal) zeigt sie auf den Grogger-Server.
// Die App ist offen (Verteilung nur per Link) — der Kostenschutz liegt
// serverseitig im Monatslimit und Rate-Limiting.

const DEFAULT_BACKEND = "https://draw.grogger.de";

export const API_BASE =
  location.hostname === "draw.grogger.de" || location.hostname === "127.0.0.1" || location.hostname === "localhost"
    ? ""
    : DEFAULT_BACKEND;

export const WS_URL =
  (API_BASE ? API_BASE.replace(/^http/, "ws") : (location.protocol === "https:" ? "wss://" : "ws://") + location.host) + "/ws";

export function getNickname() {
  return localStorage.getItem("nickname") || "";
}

export function setNickname(name) {
  if (name) localStorage.setItem("nickname", name);
  else localStorage.removeItem("nickname");
}

// Legt eine Spielsession an (Nickname wird serverseitig gespeichert;
// leer → anonymer Name). Liefert { sessionId, nickname }.
export async function startSession(nickname) {
  const res = await fetch(API_BASE + "/api/session/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nickname }),
  });
  if (!res.ok) throw new Error("session start failed");
  return res.json();
}

// Schickt den Canvas-Snapshot an die KI. Liefert
// { guesses: [{term, confidence}], comment, hit, disqualified, strokeToken? }
export async function requestGuess({ image, roomCode, playerId, targetWord, excludeTerms, sessionId, nickname, elapsedS }) {
  const res = await fetch(API_BASE + "/api/guess", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image, roomCode, playerId, targetWord, excludeTerms, sessionId, nickname, elapsedS }),
  });
  if (res.status === 429) throw new Error("rate");
  if (res.status === 503) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.message || "Das Monatslimit ist erreicht.");
    err.limit = true;
    throw err;
  }
  if (!res.ok) throw new Error("KI-Anfrage fehlgeschlagen (" + res.status + ")");
  return res.json();
}

// Strokes der Siegerzeichnung nachreichen → animiertes Replay im Feed.
export async function uploadWinStrokes(token, strokes) {
  try {
    await fetch(API_BASE + "/api/win/strokes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, strokes }),
    });
  } catch {
    // Feed-Animation ist nice-to-have — Fehler still ignorieren.
  }
}

// Öffentlicher Feed gewonnener Runden für die Startseite.
export async function fetchFeed() {
  const res = await fetch(API_BASE + "/api/feed");
  if (!res.ok) return [];
  const data = await res.json();
  return data.wins || [];
}
