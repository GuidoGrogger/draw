// API-Client. Auf draw.grogger.de ist die API same-origin;
// von einer anderen Herkunft (z.B. lokal) zeigt sie auf den Grogger-Server.

const DEFAULT_BACKEND = "https://draw.grogger.de";

export const API_BASE =
  location.hostname === "draw.grogger.de" ? "" : DEFAULT_BACKEND;

export const WS_URL =
  (API_BASE ? API_BASE.replace(/^http/, "ws") : (location.protocol === "https:" ? "wss://" : "ws://") + location.host) + "/ws";

export function getAccessCode() {
  return sessionStorage.getItem("accessCode") || localStorage.getItem("accessCode") || "";
}

export function setAccessCode(code, remember) {
  sessionStorage.setItem("accessCode", code);
  if (remember) localStorage.setItem("accessCode", code);
  else localStorage.removeItem("accessCode");
}

export function clearAccessCode() {
  sessionStorage.removeItem("accessCode");
  localStorage.removeItem("accessCode");
}

export async function verifyAccess(code) {
  const res = await fetch(API_BASE + "/api/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Access-Code": code },
  });
  return res.ok;
}

// Schickt den Canvas-Snapshot an die KI. Liefert
// { guesses: [{term, confidence}], writtenText, comment, hit, disqualified }
export async function requestGuess({ image, roomCode, playerId, targetWord, excludeTerms }) {
  const res = await fetch(API_BASE + "/api/guess", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Access-Code": getAccessCode(),
    },
    body: JSON.stringify({ image, roomCode, playerId, targetWord, excludeTerms }),
  });
  if (res.status === 401) throw new Error("auth");
  if (res.status === 429) throw new Error("rate");
  if (!res.ok) throw new Error("KI-Anfrage fehlgeschlagen (" + res.status + ")");
  return res.json();
}
