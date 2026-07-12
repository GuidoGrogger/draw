// Multiplayer-Räume: Lobby mit Einladungslink, Host startet das Spiel,
// alle malen denselben Begriff, Live-Strokes an alle Mitspieler.
// Der Server ist die Autorität: er kennt das Rundenwort, wertet Treffer
// aus und entscheidet Runden-/Matchsieg. Wins landen in der Datenbank
// (Social-Feed auf der Startseite).

import { randomUUID } from "node:crypto";
import { pickWord } from "../../web/src/words.js";
import { createSession, recordWin, recordRound, normalizeNickname } from "./db.js";

const TOTAL_ROUNDS = 10;
const ROUND_SECONDS = 90;
const NEXT_ROUND_DELAY_MS = 9000;
const MAX_PLAYERS = 8;
const MIN_PLAYERS = 2;
// Beim App-Wechsel auf dem Handy kappt der Browser die Verbindung — der
// Spieler behält seinen Platz und kann innerhalb der Frist zurückkommen
// (großzügig: auch wer länger in einer anderen App hängt, kommt zurück).
const RESUME_GRACE_MS = 15 * 60000;
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

function playerList(room) {
  return [...room.players.entries()].map(([id, p]) => ({
    id,
    nickname: p.nickname,
    isHost: id === room.hostId,
    score: p.score,
    connected: p.connected !== false,
  }));
}

function lobbyUpdate(room) {
  broadcast(room, {
    type: "lobby_update",
    players: playerList(room),
    canStart: room.players.size >= MIN_PLAYERS,
    minPlayers: MIN_PLAYERS,
  });
}

export function getRoom(code) {
  return rooms.get(String(code || "").toUpperCase()) || null;
}

// Für /api/guess: darf dieser Spieler über den Raum authentifiziert werden?
export function roomHasPlayer(code, playerId) {
  const room = getRoom(code);
  return Boolean(room && room.players.has(playerId));
}

export function roomSessionId(code) {
  return getRoom(code)?.sessionId || null;
}

// Host erstellt den Raum.
export function createRoom(ws, rawNickname) {
  const code = makeCode();
  const playerId = randomUUID();
  const nickname = normalizeNickname(rawNickname);
  const session = createSession("multi", nickname);
  const room = {
    code,
    hostId: playerId,
    sessionId: session.id,
    players: new Map([[playerId, { ws, nickname, score: 0, cheats: 0 }]]),
    state: "lobby", // lobby | playing | between | done
    round: 0,
    word: null,
    usedWords: [],
    roundStartAt: 0,
    timer: null,
    lobbyAge: 0,
  };
  rooms.set(code, room);
  ws._room = room;
  ws._playerId = playerId;
  send(ws, { type: "created", code, playerId, nickname, totalRounds: TOTAL_ROUNDS });
  lobbyUpdate(room);
  return room;
}

// Beitritt per Einladungslink oder Code — Eingeladene müssen nur klicken.
export function joinRoom(ws, code, rawNickname) {
  const room = getRoom(code);
  if (!room) return send(ws, { type: "error", message: "Raum nicht gefunden – Link abgelaufen?" });
  if (room.state !== "lobby") return send(ws, { type: "error", message: "Das Spiel läuft schon." });
  if (room.players.size >= MAX_PLAYERS) return send(ws, { type: "error", message: "Raum ist voll." });

  const playerId = randomUUID();
  const nickname = normalizeNickname(rawNickname);
  room.players.set(playerId, { ws, nickname, score: 0, cheats: 0 });
  ws._room = room;
  ws._playerId = playerId;
  send(ws, { type: "joined", code: room.code, playerId, nickname, totalRounds: TOTAL_ROUNDS });
  lobbyUpdate(room);
}

// Wiedereinstieg nach Verbindungsabbruch (Handy: App-Wechsel/Bildschirm aus).
// Bindet den neuen Socket an den bestehenden Spieler-Platz und schickt
// einen Zustands-Snapshot, damit der Client nahtlos weitermachen kann.
export function resumeRoom(ws, code, playerId) {
  const room = getRoom(code);
  const player = room?.players.get(playerId);
  if (!room || !player) {
    send(ws, { type: "error", message: "Das Spiel ist leider schon vorbei." });
    return false;
  }
  if (player.ws && player.ws !== ws) {
    // alte (tote) Verbindung ersetzen
    player.ws._room = null;
    try { player.ws.terminate(); } catch {}
  }
  clearTimeout(player.removeTimer);
  player.removeTimer = null;
  player.connected = true;
  player.ws = ws;
  ws._room = room;
  ws._playerId = playerId;
  send(ws, {
    type: "resumed",
    code: room.code,
    playerId,
    nickname: player.nickname,
    isHost: playerId === room.hostId,
    state: room.state, // lobby | playing | between | done
    round: room.round,
    totalRounds: TOTAL_ROUNDS,
    word: room.state === "playing" ? room.word : null,
    remaining: room.state === "playing"
      ? Math.max(1, Math.round(ROUND_SECONDS - (Date.now() - room.roundStartAt) / 1000))
      : null,
    players: playerList(room),
    canStart: room.players.size >= MIN_PLAYERS,
  });
  if (room.state === "lobby") lobbyUpdate(room);
  return true;
}

// Nur der Host darf starten – er entscheidet, wann es losgeht.
function startMatch(ws) {
  const room = ws._room;
  if (!room || room.state !== "lobby") return;
  if (ws._playerId !== room.hostId) {
    return send(ws, { type: "error_soft", message: "Nur wer die Session gestartet hat, kann das Spiel starten." });
  }
  if (room.players.size < MIN_PLAYERS) {
    return send(ws, { type: "error_soft", message: "Mindestens zwei Spieler nötig." });
  }
  startRound(room);
}

function startRound(room) {
  if (room.players.size < MIN_PLAYERS || room.state === "done") return;
  room.round++;
  room.word = pickWord("alle", room.usedWords);
  room.usedWords.push(room.word);
  room.state = "playing";
  room.roundStartAt = Date.now();
  for (const p of room.players.values()) p.cheats = 0;
  broadcast(room, {
    type: "round_start",
    round: room.round,
    totalRounds: TOTAL_ROUNDS,
    word: room.word,
    duration: ROUND_SECONDS,
    players: playerList(room),
  });
  clearTimeout(room.timer);
  room.timer = setTimeout(() => endRound(room, null), (ROUND_SECONDS + 4) * 1000);
}

function endRound(room, winnerId, { cheated = false, winnerImage = null } = {}) {
  if (room.state !== "playing") return;
  room.state = "between";
  clearTimeout(room.timer);
  const winner = winnerId ? room.players.get(winnerId) : null;
  if (winner) winner.score++;

  // Wort-Statistik: jede Runde zählt (erraten oder nicht)
  recordRound({
    sessionId: room.sessionId,
    mode: "multi",
    word: room.word,
    success: Boolean(winner),
    durationS: winner ? (Date.now() - room.roundStartAt) / 1000 : null,
  });

  broadcast(room, {
    type: "round_end",
    winner: winnerId,
    winnerNickname: winner?.nickname || null,
    winnerImage,
    word: room.word,
    scores: scores(room),
    players: playerList(room),
    cheated,
  });

  if (room.round >= TOTAL_ROUNDS) {
    room.state = "done";
    room.timer = setTimeout(() => finishMatch(room), 5000);
  } else {
    room.timer = setTimeout(() => startRound(room), NEXT_ROUND_DELAY_MS);
  }
}

function finishMatch(room) {
  const ranking = playerList(room).sort((a, b) => b.score - a.score);
  const winner = ranking.length && (ranking.length < 2 || ranking[0].score > ranking[1].score)
    ? ranking[0].id
    : null;
  broadcast(room, { type: "match_end", winner, scores: scores(room), ranking });
  destroyRoom(room);
}

// Wird vom /api/guess-Handler aufgerufen, nachdem die KI geantwortet hat.
// Gibt zurück, was der anfragende Spieler als HTTP-Antwort bekommt.
export function handleDuelGuess(roomCode, playerId, aiResult, matchFn, image = null) {
  const room = getRoom(roomCode);
  if (!room || !room.players.has(playerId)) {
    return { error: "Raum oder Spieler unbekannt" };
  }
  if (room.state !== "playing") {
    return { guesses: aiResult.guesses, comment: aiResult.comment, hit: false, disqualified: false };
  }

  const player = room.players.get(playerId);

  if (aiResult.writtenText) {
    player.cheats++;
    broadcast(room, { type: "cheat_flag", who: playerId, nickname: player.nickname });
    if (player.cheats >= 2) {
      // Runde geht an den punktbesten anderen Spieler (bei Gleichstand: keiner)
      const others = [...room.players.entries()].filter(([id]) => id !== playerId);
      others.sort((a, b) => b[1].score - a[1].score);
      const beneficiary = others.length === 1 || (others.length > 1 && others[0][1].score > others[1][1].score)
        ? others[0][0]
        : null;
      endRound(room, beneficiary, { cheated: true });
    }
    return { guesses: [], comment: "", hit: false, disqualified: true };
  }

  // Top-Guess allen anderen zeigen (Spannung!)
  const top = aiResult.guesses[0];
  if (top) {
    for (const [id, p] of room.players) {
      if (id !== playerId) {
        send(p.ws, { type: "opp_guess", playerId, nickname: player.nickname, text: top.term, conf: top.confidence });
      }
    }
  }

  const hit = matchFn(aiResult.guesses, room.word);
  let winId = null;
  if (hit) {
    const durationS = (Date.now() - room.roundStartAt) / 1000;
    winId = recordWin({
      sessionId: room.sessionId,
      nickname: player.nickname,
      mode: "multi",
      word: room.word,
      image,
      durationS,
    });
    endRound(room, playerId, { winnerImage: image });
  }
  return { guesses: aiResult.guesses, comment: aiResult.comment, hit, disqualified: false, winId };
}

export function handleWsMessage(ws, msg) {
  const room = ws._room;
  switch (msg.type) {
    case "start":
      startMatch(ws);
      break;
    case "strokes": {
      // Live-Zeichnung an alle Mitspieler weiterreichen. Größe begrenzen.
      if (!room || room.state !== "playing") return;
      const raw = JSON.stringify(msg.strokes || []);
      if (raw.length > 300000) return;
      const nickname = room.players.get(ws._playerId)?.nickname;
      for (const [id, p] of room.players) {
        if (id !== ws._playerId) {
          send(p.ws, { type: "opp_strokes", playerId: ws._playerId, nickname, strokes: msg.strokes });
        }
      }
      break;
    }
    case "leave":
      // Explizites Verlassen (Button) → sofort entfernen, keine Frist
      if (room) {
        ws._room = null;
        removePlayer(room, ws._playerId);
      }
      break;
    case "ping":
      // App-Level-Ping des Clients (Verbindungs-Check nach App-Wechsel)
      send(ws, { type: "pong" });
      break;
  }
}

// Verbindungsabbruch: Platz RESUME_GRACE_MS lang freihalten — auf dem Handy
// trennt der Browser beim App-Wechsel, der Spieler kommt meist gleich zurück.
export function handleDisconnect(ws) {
  const room = ws._room;
  if (!room) return;
  ws._room = null;
  const player = room.players.get(ws._playerId);
  if (!player || player.ws !== ws) return; // schon per Resume ersetzt oder entfernt

  player.connected = false;
  player.ws = null;
  clearTimeout(player.removeTimer);
  const playerId = ws._playerId;
  player.removeTimer = setTimeout(() => removePlayer(room, playerId), RESUME_GRACE_MS);
  if (room.state === "lobby") lobbyUpdate(room); // „kurz weg"-Anzeige
}

// Endgültig entfernen (Frist abgelaufen oder explizit verlassen).
function removePlayer(room, playerId) {
  const leaving = room.players.get(playerId);
  if (!leaving) return;
  clearTimeout(leaving.removeTimer);
  if (leaving.ws) leaving.ws._room = null;
  room.players.delete(playerId);

  if (room.state === "lobby") {
    if (playerId === room.hostId || room.players.size === 0) {
      broadcast(room, { type: "error", message: "Die Lobby wurde geschlossen." });
      destroyRoom(room);
    } else {
      broadcast(room, { type: "player_left", playerId, nickname: leaving.nickname });
      lobbyUpdate(room);
    }
    return;
  }

  if (room.state === "done") return;

  broadcast(room, { type: "player_left", playerId, nickname: leaving.nickname });
  if (room.players.size < MIN_PLAYERS) {
    // Zu wenige Spieler übrig → Match vorzeitig beenden
    room.state = "done";
    clearTimeout(room.timer);
    finishMatch(room);
  }
}

function destroyRoom(room) {
  clearTimeout(room.timer);
  rooms.delete(room.code);
  for (const p of room.players.values()) {
    clearTimeout(p.removeTimer);
    if (p.ws) p.ws._room = null;
  }
}

// Aufräum-Sicherung: verwaiste Lobbys nach 20 min schließen
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.state === "lobby") {
      room.lobbyAge = (room.lobbyAge || 0) + 1;
      if (room.lobbyAge > 20) {
        broadcast(room, { type: "error", message: "Lobby abgelaufen" });
        destroyRoom(room);
      }
    }
  }
}, 60000);
