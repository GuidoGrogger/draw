// Duell-Räume: Wortauswahl, Rundenverwaltung und WebSocket-Relay.
// Der Server ist die Autorität: er kennt das Rundenwort, wertet Treffer
// aus und entscheidet Runden-/Matchsieg.

import { randomUUID } from "node:crypto";
import { pickWord } from "../../web/src/words.js";

const TOTAL_ROUNDS = 5;
const WIN_SCORE = 3;
const ROUND_SECONDS = 90;
const NEXT_ROUND_DELAY_MS = 9000;
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const rooms = new Map();

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg) {
  for (const p of room.players.values()) send(p.ws, msg);
}

function scores(room) {
  const s = {};
  for (const [id, p] of room.players) s[id] = p.score;
  return s;
}

export function createRoom(ws) {
  const code = makeCode();
  const playerId = randomUUID();
  const room = {
    code,
    players: new Map([[playerId, { ws, score: 0, cheats: 0 }]]),
    state: "lobby", // lobby | playing | between | done
    round: 0,
    word: null,
    usedWords: [],
    timer: null,
  };
  rooms.set(code, room);
  ws._room = room;
  ws._playerId = playerId;
  send(ws, { type: "created", code, playerId });
  return room;
}

export function joinRoom(ws, code) {
  const room = rooms.get(String(code || "").toUpperCase());
  if (!room) return send(ws, { type: "error", message: "Raum nicht gefunden" });
  if (room.players.size >= 2) return send(ws, { type: "error", message: "Raum ist voll" });

  const playerId = randomUUID();
  room.players.set(playerId, { ws, score: 0, cheats: 0 });
  ws._room = room;
  ws._playerId = playerId;
  send(ws, { type: "joined", code: room.code, playerId });
  for (const [id, p] of room.players) {
    if (id !== playerId) send(p.ws, { type: "opp_joined" });
  }
  setTimeout(() => startRound(room), 2500);
}

function startRound(room) {
  if (room.players.size < 2 || room.state === "done") return;
  room.round++;
  room.word = pickWord("alle", room.usedWords);
  room.usedWords.push(room.word);
  room.state = "playing";
  for (const p of room.players.values()) p.cheats = 0;
  broadcast(room, {
    type: "round_start",
    round: room.round,
    totalRounds: TOTAL_ROUNDS,
    word: room.word,
    duration: ROUND_SECONDS,
  });
  clearTimeout(room.timer);
  room.timer = setTimeout(() => endRound(room, null), (ROUND_SECONDS + 4) * 1000);
}

function endRound(room, winnerId, cheated = false) {
  if (room.state !== "playing") return;
  room.state = "between";
  clearTimeout(room.timer);
  if (winnerId) room.players.get(winnerId).score++;

  broadcast(room, {
    type: "round_end",
    winner: winnerId,
    word: room.word,
    scores: scores(room),
    cheated,
  });

  const maxScore = Math.max(...[...room.players.values()].map((p) => p.score));
  if (room.round >= TOTAL_ROUNDS || maxScore >= WIN_SCORE) {
    room.state = "done";
    const entries = [...room.players.entries()];
    let winner = null;
    if (entries.length === 2 && entries[0][1].score !== entries[1][1].score) {
      winner = entries[0][1].score > entries[1][1].score ? entries[0][0] : entries[1][0];
    }
    room.timer = setTimeout(() => {
      broadcast(room, { type: "match_end", winner, scores: scores(room) });
      destroyRoom(room);
    }, 5000);
  } else {
    room.timer = setTimeout(() => startRound(room), NEXT_ROUND_DELAY_MS);
  }
}

// Wird vom /api/guess-Handler aufgerufen, nachdem die KI geantwortet hat.
// Gibt zurück, was der anfragende Spieler als Antwort bekommt.
export function handleDuelGuess(roomCode, playerId, aiResult, matchFn) {
  const room = rooms.get(String(roomCode || "").toUpperCase());
  if (!room || !room.players.has(playerId)) {
    return { error: "Raum oder Spieler unbekannt" };
  }
  if (room.state !== "playing") {
    return { guesses: aiResult.guesses, comment: aiResult.comment, hit: false, disqualified: false };
  }

  const player = room.players.get(playerId);

  if (aiResult.writtenText) {
    player.cheats++;
    broadcast(room, { type: "cheat_flag", who: playerId });
    if (player.cheats >= 2) {
      const opponent = [...room.players.keys()].find((id) => id !== playerId);
      endRound(room, opponent, true);
    }
    return { guesses: [], comment: "", hit: false, disqualified: true };
  }

  // Top-Guess dem Gegner zeigen (Spannung!)
  const top = aiResult.guesses[0];
  if (top) {
    for (const [id, p] of room.players) {
      if (id !== playerId) send(p.ws, { type: "opp_guess", text: top.term, conf: top.confidence });
    }
  }

  const hit = matchFn(aiResult.guesses, room.word);
  if (hit) endRound(room, playerId);
  return { guesses: aiResult.guesses, comment: aiResult.comment, hit, disqualified: false };
}

export function handleWsMessage(ws, msg) {
  const room = ws._room;
  switch (msg.type) {
    case "strokes": {
      if (!room) return;
      // Strokes an den Gegner weiterreichen (Replay). Größe begrenzen.
      const raw = JSON.stringify(msg.strokes || []);
      if (raw.length > 400000) return;
      for (const [id, p] of room.players) {
        if (id !== ws._playerId) send(p.ws, { type: "opp_strokes", strokes: msg.strokes });
      }
      break;
    }
    case "leave":
      handleDisconnect(ws);
      break;
  }
}

export function handleDisconnect(ws) {
  const room = ws._room;
  if (!room) return;
  ws._room = null;
  room.players.delete(ws._playerId);
  if (room.state !== "done") {
    for (const p of room.players.values()) send(p.ws, { type: "opp_left" });
  }
  destroyRoom(room);
}

function destroyRoom(room) {
  clearTimeout(room.timer);
  rooms.delete(room.code);
  for (const p of room.players.values()) {
    if (p.ws) p.ws._room = null;
  }
}

// Aufräum-Sicherung: verwaiste Lobbys nach 15 min schließen
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.state === "lobby") {
      room.lobbyAge = (room.lobbyAge || 0) + 1;
      if (room.lobbyAge > 15) {
        broadcast(room, { type: "error", message: "Lobby abgelaufen" });
        destroyRoom(room);
      }
    }
  }
}, 60000);
