import { pickWord } from "./words.js";
import { requestGuess } from "./api.js";

const ROUND_SECONDS = 120;

// Solo-Modus: Begriff malen, KI checkt im Intervall + auf Knopfdruck.
export class SoloGame {
  constructor(ui) {
    this.ui = ui; // gemeinsame UI-Helfer aus main.js
    this.active = false;
  }

  start() {
    this.active = true;
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
    this.ui.setWord(this.word);
    this.ui.clearFeed();
    this.ui.canvas.clear();
    this.ui.canvas.enabled = true;
    this.lastCheckedRevision = this.ui.canvas.revision;

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

    this.ui.feedThinking();
    let result;
    try {
      result = await requestGuess({
        image: this.ui.canvas.toDataUrl(),
        targetWord: this.word,
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

    if (result.hit) this.onHit();
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
