import { pickWord } from "./words.js?v=3";
import { requestGuess, uploadWinStrokes, reportRoundTimeout } from "./api.js?v=3";

const ROUND_SECONDS = 180;

// Solo-Modus: Begriff malen, KI checkt im Intervall + auf Knopfdruck.
export class SoloGame {
  constructor(ui) {
    this.ui = ui; // gemeinsame UI-Helfer aus main.js
    this.active = false;
  }

  // sessionId/nickname kommen aus /api/session/start (main.js) —
  // damit landen Siege mit Name, Bild, Begriff und Zeit im öffentlichen Feed.
  start(sessionId = null, nickname = "") {
    this.active = true;
    this.sessionId = sessionId;
    this.nickname = nickname;
    this.score = 0;
    this.streak = 0;
    this.usedWords = [];
    this.ui.showScreen("game");
    this.ui.duelScore(false);
    this.ui.roundBox(false);
    this.nextRound();
  }

  nextRound() {
    this.word = pickWord(this.ui.category(), this.usedWords);
    this.usedWords.push(this.word);
    this.checks = 0;
    this.solved = false;
    this.wrongGuesses = []; // schon geratene, aber falsche Begriffe dieser Runde
    this.ui.showScreen("game"); // zurück vom Result-Screen (nach Treffer/Timeout)
    this.ui.setWord(this.word);
    this.ui.clearFeed();
    this.ui.canvas.clear();
    this.ui.canvas.enabled = true;
    this.lastCheckedRevision = this.ui.canvas.revision;
    this.roundStartedAt = Date.now();

    this.ui.startTimer(ROUND_SECONDS, () => this.onTimeout());
    this.ui.startAutoCheck(() => this.check("auto"));
  }

  async check(source) {
    if (!this.active || this.solved) return;
    if (this.ui.canvas.isEmpty()) {
      if (source === "manual") this.ui.toast("Erst malen, dann raten lassen 😉");
      return;
    }
    if (source === "auto" && this.ui.canvas.revision === this.lastCheckedRevision) return; // nichts Neues
    this.lastCheckedRevision = this.ui.canvas.revision;
    this.checks++;

    // Genau dieser Snapshot geht an Claude — als Mini-Vorschau zeigen.
    const image = this.ui.canvas.toDataUrl();
    this.ui.setCheckPreview(image);

    this.ui.feedThinking();
    let result;
    try {
      result = await requestGuess({
        image,
        targetWord: this.word,
        excludeTerms: this.wrongGuesses,
        sessionId: this.sessionId,
        nickname: this.nickname,
        elapsedS: Math.round((Date.now() - this.roundStartedAt) / 1000),
      });
    } catch (err) {
      this.ui.feedRemoveThinking();
      this.ui.handleApiError(err);
      return;
    }
    this.ui.feedRemoveThinking();
    if (!this.active || this.solved) return;

    if (result.disqualified) {
      this.ui.feedCheat();
      return;
    }
    this.ui.feedGuesses(result.guesses, result.comment);

    if (result.hit) {
      // Strokes fürs animierte Feed-Replay nachreichen (nice-to-have).
      if (result.strokeToken) uploadWinStrokes(result.strokeToken, this.ui.canvas.exportStrokes());
      this.onHit();
    } else {
      // Diese Begriffe waren falsch – beim nächsten Check nicht erneut raten.
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

  onHit() {
    this.solved = true;
    const remaining = this.ui.stopTimer();
    this.ui.stopAutoCheck();
    this.ui.canvas.enabled = false;

    let points = remaining;
    if (this.checks === 1) points += 20; // beim allerersten Check erkannt
    this.score += points;
    this.streak++;

    this.ui.feedHit(this.word);
    this.ui.saveHighscore(this.score);

    setTimeout(() => {
      this.ui.showResult({
        title: "🎉 Erraten!",
        text: `Claude hat „${this.word}" erkannt!\n+${points} Punkte · Gesamt: ${this.score} · Serie: ${this.streak}`,
        nextLabel: "Nächster Begriff",
        onNext: () => this.nextRound(),
        onMenu: () => this.quit(),
      });
    }, 1400);
  }

  onTimeout() {
    this.ui.stopAutoCheck();
    this.ui.canvas.enabled = false;
    this.streak = 0;
    reportRoundTimeout(this.sessionId, this.word); // Wort-Statistik: nicht erraten
    this.ui.showResult({
      title: "⏰ Zeit um!",
      text: `Claude hat „${this.word}" leider nicht erkannt.\nGesamt: ${this.score} Punkte`,
      nextLabel: "Nächster Begriff",
      onNext: () => this.nextRound(),
      onMenu: () => this.quit(),
    });
  }

  quit() {
    this.active = false;
    this.ui.stopTimer();
    this.ui.stopAutoCheck();
    this.ui.showScreen("menu");
  }
}
