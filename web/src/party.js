import { requestGuess, uploadWinStrokes, WS_URL } from "./api.js";

// Multiplayer über den WebSocket-Relay: Host erstellt eine Session und teilt
// den Einladungslink; Mitspieler treten per Klick bei (Nickname optional).
// Alle malen denselben Begriff; wessen Zeichnung die KI zuerst erkennt,
// gewinnt die Runde. Der Host entscheidet, wann das Spiel startet.
export class PartyGame {
  constructor(ui) {
    this.ui = ui;
    this.ws = null;
    this.active = false;
    this.isHost = false;
    this.strokeSender = null;
  }

  create(nickname) {
    this.isHost = true;
    this._connect({ type: "create", nickname });
  }

  join(code, nickname) {
    this.isHost = false;
    this._connect({ type: "join", code: String(code || "").toUpperCase(), nickname });
  }

  startMatch() {
    this._send({ type: "start" });
  }

  _connect(firstMsg) {
    this.ui.showScreen("lobby");
    this.ui.lobbyStatus(firstMsg.type === "create" ? "Erstelle Raum …" : "Trete bei …");
    this.ui.lobbyPlayers([], false, false);

    this.ws = new WebSocket(WS_URL);
    this.ws.onopen = () => {
      this.ws.send(JSON.stringify(firstMsg));
    };
    this.ws.onmessage = (ev) => this._onMessage(JSON.parse(ev.data));
    this.ws.onclose = () => {
      if (this.active || this.inLobby) {
        this.ui.toast("Verbindung getrennt", "bad");
        this.quit();
      }
    };
    this.ws.onerror = () => {
      this.ui.toast("Verbindung fehlgeschlagen", "bad");
      this.quit();
    };
  }

  _send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  _onMessage(msg) {
    switch (msg.type) {
      case "created":
        this.playerId = msg.playerId;
        this.inLobby = true;
        this.ui.lobbyCode(msg.code, true);
        this.ui.lobbyStatus("Lade Freunde ein – Link teilen! Du startest das Spiel.");
        break;

      case "joined":
        this.playerId = msg.playerId;
        this.inLobby = true;
        this.ui.lobbyCode(msg.code, false);
        this.ui.lobbyStatus("Du bist drin! Warte, bis der Host startet …");
        break;

      case "lobby_update":
        this.players = msg.players;
        this.ui.lobbyPlayers(msg.players, msg.canStart, this.isHost, this.playerId);
        break;

      case "round_start":
        this._roundStart(msg);
        break;

      case "opp_guess":
        this.ui.feedOppGuess(msg.text, msg.conf, msg.nickname);
        break;

      case "opp_strokes":
        this.ui.drawOpponent(msg.playerId, msg.nickname, msg.strokes);
        break;

      case "cheat_flag":
        if (msg.who === this.playerId) {
          this.ui.feedCheat();
        } else {
          this.ui.toast(`✍️ Bei ${msg.nickname || "einem Mitspieler"} sah es nach Text aus – der Check zählt nicht.`, "bad");
        }
        break;

      case "round_end":
        this._roundEnd(msg);
        break;

      case "player_left":
        this.ui.toast(`${msg.nickname || "Ein Mitspieler"} hat das Spiel verlassen`, "bad");
        this.ui.removeOpponent(msg.playerId);
        break;

      case "match_end":
        this._matchEnd(msg);
        break;

      case "error_soft":
        this.ui.toast(msg.message, "bad");
        break;

      case "error":
        this.ui.toast(msg.message, "bad");
        this.quit();
        break;
    }
  }

  _roundStart(msg) {
    this.active = true;
    this.inLobby = false;
    this.solvedRound = false;
    this.roomWord = msg.word;
    this.wrongGuesses = []; // schon geratene, aber falsche Begriffe dieser Runde
    this.ui.showScreen("game");
    this.ui.duelScore(false);
    this.ui.roundBox(true, msg.round, msg.totalRounds);
    this.ui.setWord(msg.word);
    this.ui.clearFeed();
    this.ui.canvas.clear();
    this.ui.canvas.enabled = true;
    this.lastCheckedRevision = this.ui.canvas.revision;

    // Mini-Canvases für alle Mitspieler unter dem eigenen Zeichenfeld
    this.ui.setupOpponents((msg.players || []).filter((p) => p.id !== this.playerId));

    this.ui.startTimer(msg.duration, () => {}); // Rundenende kommt vom Server
    this.ui.startAutoCheck(() => this.check("auto"));
    this._startStrokeSender();
  }

  // Eigene Strokes regelmäßig an die Mitspieler schicken (Live-Ansicht).
  _startStrokeSender() {
    this._stopStrokeSender();
    this.lastSentRevision = this.ui.canvas.revision;
    this.strokeSender = setInterval(() => {
      if (!this.active) return;
      if (this.ui.canvas.revision === this.lastSentRevision) return;
      this.lastSentRevision = this.ui.canvas.revision;
      this._send({ type: "strokes", strokes: this.ui.canvas.exportStrokes() });
    }, 1500);
  }

  _stopStrokeSender() {
    clearInterval(this.strokeSender);
    this.strokeSender = null;
  }

  async check(source) {
    if (!this.active || this.solvedRound) return;
    if (this.ui.canvas.isEmpty()) {
      if (source === "manual") this.ui.toast("Erst malen, dann raten lassen 😉");
      return;
    }
    if (source === "auto" && this.ui.canvas.revision === this.lastCheckedRevision) return;
    this.lastCheckedRevision = this.ui.canvas.revision;

    this.ui.feedThinking();
    let result;
    try {
      result = await requestGuess({
        image: this.ui.canvas.toDataUrl(),
        roomCode: this.ui.lobbyCodeValue,
        playerId: this.playerId,
        excludeTerms: this.wrongGuesses,
      });
    } catch (err) {
      this.ui.feedRemoveThinking();
      this.ui.handleApiError(err);
      return;
    }
    this.ui.feedRemoveThinking();
    if (!this.active) return;

    if (result.disqualified) return; // cheat_flag kommt via WS
    this.ui.feedGuesses(result.guesses, result.comment);
    if (result.hit) {
      // Sieg! Strokes für das animierte Feed-Replay nachreichen.
      if (result.strokeToken) uploadWinStrokes(result.strokeToken, this.ui.canvas.exportStrokes());
    } else {
      this.rememberWrong(result.guesses);
    }
  }

  rememberWrong(guesses) {
    for (const g of guesses || []) {
      const term = g?.term?.trim();
      if (!term) continue;
      const known = this.wrongGuesses.some((w) => w.toLowerCase() === term.toLowerCase());
      if (!known) this.wrongGuesses.push(term);
    }
  }

  _roundEnd(msg) {
    this.solvedRound = true;
    this.ui.stopTimer();
    this.ui.stopAutoCheck();
    this._stopStrokeSender();
    this.ui.canvas.enabled = false;

    const iWon = msg.winner === this.playerId;
    const standings = (msg.players || [])
      .slice()
      .sort((a, b) => b.score - a.score)
      .map((p) => `${p.nickname}${p.id === this.playerId ? " (du)" : ""}: ${p.score}`)
      .join(" · ");

    const title = msg.winner == null ? "⏰ Niemand hat's geschafft" : iWon ? "🏆 Runde gewonnen!" : `😅 ${msg.winnerNickname} war schneller`;
    const text =
      (msg.winner == null
        ? `Claude hat „${msg.word}" bei niemandem erkannt.`
        : iWon
          ? `Claude hat deine Zeichnung von „${msg.word}" zuerst erkannt!`
          : `Claude hat „${msg.word}" zuerst bei ${msg.winnerNickname} erkannt.`) +
      (msg.cheated ? "\n✍️ Runde entschieden – im Bild stand Text." : "") +
      `\nStand: ${standings}`;

    this.ui.showResult({
      title,
      text,
      nextLabel: "Nächste Runde startet gleich …",
      nextDisabled: true,
      onMenu: () => this.quit(),
    });
    // Siegerzeichnung zeigen (kommt direkt vom Server mit)
    if (msg.winnerImage && !iWon) this.ui.showResultImage(msg.winnerImage, msg.winnerNickname);
  }

  _matchEnd(msg) {
    this.active = false;
    const iWon = msg.winner === this.playerId;
    const ranking = (msg.ranking || [])
      .map((p, i) => `${i + 1}. ${p.nickname}${p.id === this.playerId ? " (du)" : ""} – ${p.score}`)
      .join("\n");
    this.ui.showResult({
      title: msg.winner == null ? "🤝 Unentschieden!" : iWon ? "👑 Du hast gewonnen!" : "💀 Verloren …",
      text: `Endstand:\n${ranking}`,
      nextLabel: "Zum Menü",
      onNext: () => this.quit(),
      onMenu: () => this.quit(),
    });
  }

  quit() {
    this.active = false;
    this.inLobby = false;
    this.ui.stopTimer();
    this.ui.stopAutoCheck();
    this._stopStrokeSender();
    this.ui.clearOpponents();
    try { this._send({ type: "leave" }); this.ws?.close(); } catch {}
    this.ws = null;
    this.ui.showScreen("menu");
  }
}
