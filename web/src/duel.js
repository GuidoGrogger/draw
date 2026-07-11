import { requestGuess, getAccessCode, WS_URL } from "./api.js";
import { replayStrokes } from "./canvas.js";

// Echtzeit-Duell über den WebSocket-Relay auf dem Grogger-Server.
// Beide Spieler bekommen denselben Begriff; wessen Zeichnung die KI
// zuerst erkennt, gewinnt die Runde. Best of 5.
export class DuelGame {
  constructor(ui) {
    this.ui = ui;
    this.ws = null;
    this.active = false;
  }

  create() {
    this._connect({ type: "create" });
  }

  join(code) {
    this._connect({ type: "join", code });
  }

  _connect(firstMsg) {
    this.ui.showScreen("lobby");
    this.ui.lobbyStatus(firstMsg.type === "create" ? "Erstelle Raum …" : "Trete bei …");

    this.ws = new WebSocket(WS_URL);
    this.ws.onopen = () => {
      this.ws.send(JSON.stringify({ ...firstMsg, accessCode: getAccessCode() }));
    };
    this.ws.onmessage = (ev) => this._onMessage(JSON.parse(ev.data));
    this.ws.onclose = () => {
      if (this.active) {
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
        this.ui.lobbyCode(msg.code);
        this.ui.lobbyStatus("Warte auf Gegner … Code teilen!");
        break;

      case "joined":
        this.playerId = msg.playerId;
        this.ui.lobbyCode(msg.code);
        this.ui.lobbyStatus("Verbunden! Spiel startet …");
        break;

      case "opp_joined":
        this.ui.lobbyStatus("Gegner ist da! Spiel startet …");
        break;

      case "round_start":
        this._roundStart(msg);
        break;

      case "opp_guess":
        this.ui.feedOppGuess(msg.text, msg.conf);
        break;

      case "cheat_flag":
        if (msg.who === this.playerId) {
          this.ui.feedCheat();
        } else {
          this.ui.toast("✍️ Beim Gegner sah es nach Text aus – der Check zählt nicht.", "bad");
        }
        break;

      case "round_end":
        this._roundEnd(msg);
        break;

      case "opp_strokes":
        this.pendingReplay = msg.strokes;
        this.ui.showReplay(msg.strokes);
        break;

      case "match_end":
        this._matchEnd(msg);
        break;

      case "opp_left":
        this.ui.toast("Gegner hat das Spiel verlassen", "bad");
        this.quit();
        break;

      case "error":
        this.ui.toast(msg.message, "bad");
        this.quit();
        break;
    }
  }

  _roundStart(msg) {
    this.active = true;
    this.solvedRound = false;
    this.pendingReplay = null;
    this.ui.showScreen("game");
    this.ui.duelScore(true);
    this.ui.roundBox(true, msg.round, msg.totalRounds);
    this.ui.setWord(msg.word);
    this.ui.clearFeed();
    this.ui.canvas.clear();
    this.ui.canvas.enabled = true;
    this.lastCheckedRevision = this.ui.canvas.revision;

    this.ui.startTimer(msg.duration, () => {}); // Rundenende kommt vom Server
    this.ui.startAutoCheck(() => this.check("auto"));
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
    // Bei Treffer schickt der Server round_end an beide.
  }

  _roundEnd(msg) {
    this.solvedRound = true;
    this.ui.stopTimer();
    this.ui.stopAutoCheck();
    this.ui.canvas.enabled = false;
    this.ui.setScores(msg.scores[this.playerId] ?? 0, this._oppScore(msg.scores));

    // Eigene Strokes für das Replay beim Gegner hochladen
    this._send({ type: "strokes", strokes: this.ui.canvas.exportStrokes() });

    const iWon = msg.winner === this.playerId;
    const title = msg.winner == null ? "⏰ Unentschieden" : iWon ? "🏆 Runde gewonnen!" : "😅 Runde verloren";
    const text =
      (msg.winner == null
        ? `Claude hat „${msg.word}" bei niemandem erkannt.`
        : iWon
          ? `Claude hat deine Zeichnung von „${msg.word}" zuerst erkannt!`
          : `Claude hat die Zeichnung deines Gegners zuerst erkannt („${msg.word}").`) +
      (msg.cheated ? "\n✍️ Runde entschieden – im Bild stand Text." : "") +
      `\nStand: ${msg.scores[this.playerId] ?? 0} : ${this._oppScore(msg.scores)}`;

    this.ui.showResult({
      title,
      text,
      nextLabel: "Nächste Runde startet gleich …",
      nextDisabled: true,
      showReplaySlot: true,
      onMenu: () => this.quit(),
    });
    if (this.pendingReplay) this.ui.showReplay(this.pendingReplay);
  }

  _oppScore(scores) {
    return Object.entries(scores).find(([id]) => id !== this.playerId)?.[1] ?? 0;
  }

  _matchEnd(msg) {
    this.active = false;
    const iWon = msg.winner === this.playerId;
    this.ui.showResult({
      title: msg.winner == null ? "🤝 Unentschieden!" : iWon ? "👑 Du hast das Duell gewonnen!" : "💀 Duell verloren",
      text: `Endstand: ${msg.scores[this.playerId] ?? 0} : ${this._oppScore(msg.scores)}`,
      nextLabel: "Zum Menü",
      onNext: () => this.quit(),
      onMenu: () => this.quit(),
    });
  }

  quit() {
    this.active = false;
    this.ui.stopTimer();
    this.ui.stopAutoCheck();
    try { this._send({ type: "leave" }); this.ws?.close(); } catch {}
    this.ws = null;
    this.ui.showScreen("menu");
  }
}

export { replayStrokes };
