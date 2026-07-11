import { DrawCanvas, replayStrokes } from "./canvas.js";
import { CATEGORIES } from "./words.js";
import { verifyAccess, getAccessCode, setAccessCode, clearAccessCode } from "./api.js";
import { SoloGame } from "./solo.js";
import { DuelGame } from "./duel.js";

const $ = (id) => document.getElementById(id);

const COLORS = ["#111111", "#e63946", "#2a9d8f", "#1d6fd8", "#e9a820", "#8338ec", "#8d5524"];
const SIZES = [3, 6, 12];
const GUESS_COOLDOWN_MS = 5000;

// ---------- Screens ----------
const screens = ["access", "menu", "lobby", "game", "result"];
function showScreen(name) {
  for (const s of screens) $("screen-" + s).classList.toggle("hidden", s !== name);
}

// ---------- Toast ----------
let toastTimer = null;
function toast(text, kind = "") {
  const el = $("toast");
  el.textContent = text;
  el.className = "toast " + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3500);
}

// ---------- Canvas & Toolbar ----------
const canvas = new DrawCanvas($("draw-canvas"));

const colorRow = $("color-row");
for (const c of COLORS) {
  const b = document.createElement("button");
  b.className = "color-swatch" + (c === canvas.color ? " active" : "");
  b.style.background = c;
  b.onclick = () => {
    canvas.color = c;
    canvas.eraser = false;
    $("tool-eraser").classList.remove("active");
    colorRow.querySelectorAll(".color-swatch").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
  };
  colorRow.appendChild(b);
}

const sizeRow = $("size-row");
for (const s of SIZES) {
  const b = document.createElement("button");
  b.className = "size-dot" + (s === canvas.size ? " active" : "");
  const dot = document.createElement("i");
  dot.style.width = dot.style.height = Math.min(s * 1.6, 20) + "px";
  b.appendChild(dot);
  b.onclick = () => {
    canvas.size = s;
    sizeRow.querySelectorAll(".size-dot").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
  };
  sizeRow.appendChild(b);
}

$("tool-eraser").onclick = () => {
  canvas.eraser = !canvas.eraser;
  $("tool-eraser").classList.toggle("active", canvas.eraser);
};
$("tool-undo").onclick = () => canvas.undo();
$("tool-clear").onclick = () => canvas.clear();

// ---------- Timer ----------
let timerInterval = null;
let timerRemaining = 0;
function startTimer(seconds, onTimeout) {
  stopTimer();
  timerRemaining = seconds;
  renderTimer();
  timerInterval = setInterval(() => {
    timerRemaining--;
    renderTimer();
    if (timerRemaining <= 0) {
      stopTimer();
      onTimeout();
    }
  }, 1000);
}
function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
  return timerRemaining;
}
function renderTimer() {
  $("game-timer").textContent = timerRemaining;
  $("game-timer").parentElement.classList.toggle("low", timerRemaining <= 15);
}

// ---------- Auto-Check-Scheduler ----------
let autoInterval = null;
let nextCheckIn = 0;
function checkIntervalSeconds() {
  return parseInt($("setting-interval").value, 10) || 10;
}
function startAutoCheck(fn) {
  stopAutoCheck();
  nextCheckIn = checkIntervalSeconds();
  renderNextCheck();
  autoInterval = setInterval(() => {
    nextCheckIn--;
    renderNextCheck();
    if (nextCheckIn <= 0) {
      nextCheckIn = checkIntervalSeconds();
      fn();
    }
  }, 1000);
}
function stopAutoCheck() {
  clearInterval(autoInterval);
  autoInterval = null;
  $("next-check-s").textContent = "–";
}
function renderNextCheck() {
  $("next-check-s").textContent = nextCheckIn;
}

// ---------- Guess-Feed ----------
const feed = $("guess-feed");
function clearFeed() { feed.innerHTML = ""; }
function feedAdd(html, cls = "") {
  const div = document.createElement("div");
  div.className = "guess-item " + cls;
  div.innerHTML = html;
  feed.prepend(div);
  while (feed.children.length > 12) feed.lastChild.remove();
  return div;
}
let thinkingEl = null;
function feedThinking() {
  feedRemoveThinking();
  thinkingEl = feedAdd("🤔 Claude schaut sich deine Zeichnung an …");
}
function feedRemoveThinking() {
  thinkingEl?.remove();
  thinkingEl = null;
}
function esc(s) {
  const d = document.createElement("div");
  d.textContent = String(s ?? "");
  return d.innerHTML;
}
function feedGuesses(guesses, comment) {
  if (!guesses?.length) {
    feedAdd("🤷 Ich erkenne noch nichts … mal weiter!");
    return;
  }
  const list = guesses
    .slice(0, 3)
    .map((g) => `${esc(g.term)} <span class="conf">${Math.round(g.confidence)}%</span>`)
    .join(" · ");
  feedAdd(`💭 ${list}` + (comment ? `<br><span class="conf">„${esc(comment)}"</span>` : ""));
}
function feedHit(word) {
  feedAdd(`✅ <b>${esc(word)}</b> – erkannt!`, "hit");
}
function feedCheat() {
  feedAdd("✍️ Hinweis: Es sieht nach geschriebenem Text aus – gezeichnet zählt, geschrieben nicht. Dieser Check zählt nicht.", "cheat");
}
function feedOppGuess(text, conf) {
  feedAdd(`👀 Beim Gegner: ${esc(text)} <span class="conf">${Math.round(conf)}%</span>`, "opp");
}

// ---------- Result-Screen ----------
let resultHandlers = { onNext: null, onMenu: null };
function showResult({ title, text, nextLabel, nextDisabled, onNext, onMenu, showReplaySlot }) {
  $("result-title").textContent = title;
  $("result-text").textContent = text;
  $("result-text").style.whiteSpace = "pre-line";
  $("result-next").textContent = nextLabel || "Weiter";
  $("result-next").disabled = !!nextDisabled;
  $("result-replay-wrap").classList.toggle("hidden", !showReplaySlot);
  resultHandlers = { onNext, onMenu };
  showScreen("result");
}
$("result-next").onclick = () => resultHandlers.onNext?.();
$("result-menu").onclick = () => resultHandlers.onMenu?.();

function showReplay(strokes) {
  $("result-replay-wrap").classList.remove("hidden");
  replayStrokes($("replay-canvas"), strokes);
}

// ---------- Highscore ----------
function saveHighscore(score) {
  const best = parseInt(localStorage.getItem("highscore") || "0", 10);
  if (score > best) localStorage.setItem("highscore", String(score));
  renderHighscore();
}
function renderHighscore() {
  const best = parseInt(localStorage.getItem("highscore") || "0", 10);
  $("menu-highscore").textContent = best > 0 ? `🏅 Solo-Highscore: ${best} Punkte` : "";
}

// ---------- Fehlerbehandlung ----------
function handleApiError(err) {
  if (err.message === "auth") {
    toast("Zugangscode ungültig – bitte neu anmelden", "bad");
    clearAccessCode();
    showScreen("access");
  } else if (err.message === "rate") {
    toast("Zu schnell! Kurz warten …", "bad");
  } else {
    toast(err.message, "bad");
  }
}

// ---------- UI-Objekt für die Spielmodi ----------
const ui = {
  canvas,
  showScreen,
  toast,
  startTimer, stopTimer,
  startAutoCheck, stopAutoCheck,
  clearFeed, feedThinking, feedRemoveThinking, feedGuesses, feedHit, feedCheat, feedOppGuess,
  showResult, showReplay,
  saveHighscore,
  handleApiError,
  setWord: (w) => { $("game-word").textContent = w; },
  category: () => $("setting-category").value,
  duelScore: (show) => $("duel-score").classList.toggle("hidden", !show),
  setScores: (me, opp) => { $("score-me").textContent = me; $("score-opp").textContent = opp; },
  roundBox: (show, round, total) => {
    $("game-round").classList.toggle("hidden", !show);
    if (show) {
      $("game-round").innerHTML = `Runde <span id="round-num">${round}</span>/${total}`;
    }
  },
  lobbyCode: (code) => { ui.lobbyCodeValue = code; $("lobby-code").textContent = code; },
  lobbyCodeValue: "",
  lobbyStatus: (s) => { $("lobby-status").textContent = s; },
};

const solo = new SoloGame(ui);
const duel = new DuelGame(ui);
let currentMode = null;

// ---------- Menü & Navigation ----------
const catSelect = $("setting-category");
for (const c of CATEGORIES) {
  const o = document.createElement("option");
  o.value = c;
  o.textContent = c.charAt(0).toUpperCase() + c.slice(1);
  catSelect.appendChild(o);
}

$("menu-solo").onclick = () => { currentMode = solo; solo.start(); };
$("menu-duel-create").onclick = () => { currentMode = duel; duel.create(); };
$("menu-duel-join").onclick = () => {
  const code = $("join-code").value.trim().toUpperCase();
  if (code.length !== 4) return toast("4-stelligen Code eingeben", "bad");
  currentMode = duel;
  duel.join(code);
};
$("lobby-cancel").onclick = () => duel.quit();
$("game-quit").onclick = () => currentMode?.quit();
$("btn-guess-now").onclick = () => {
  const btn = $("btn-guess-now");
  if (btn.disabled) return;
  btn.disabled = true;
  let left = GUESS_COOLDOWN_MS / 1000;
  $("guess-cooldown").textContent = `(${left})`;
  const iv = setInterval(() => {
    left--;
    $("guess-cooldown").textContent = left > 0 ? `(${left})` : "";
    if (left <= 0) { clearInterval(iv); btn.disabled = false; }
  }, 1000);
  currentMode?.check("manual");
};
$("menu-logout").onclick = () => {
  clearAccessCode();
  showScreen("access");
};

// ---------- Zugang ----------
async function submitAccess() {
  const code = $("access-code").value.trim();
  if (!code) return;
  $("access-submit").disabled = true;
  $("access-error").classList.add("hidden");
  try {
    const ok = await verifyAccess(code);
    if (ok) {
      setAccessCode(code, $("access-remember").checked);
      renderHighscore();
      showScreen("menu");
    } else {
      $("access-error").textContent = "Zugangscode falsch.";
      $("access-error").classList.remove("hidden");
    }
  } catch {
    $("access-error").textContent = "Server nicht erreichbar.";
    $("access-error").classList.remove("hidden");
  } finally {
    $("access-submit").disabled = false;
  }
}
$("access-submit").onclick = submitAccess;
$("access-code").addEventListener("keydown", (e) => { if (e.key === "Enter") submitAccess(); });

// ---------- Start ----------
(async () => {
  const saved = getAccessCode();
  if (saved && (await verifyAccess(saved).catch(() => false))) {
    renderHighscore();
    showScreen("menu");
  } else {
    showScreen("access");
  }
})();
