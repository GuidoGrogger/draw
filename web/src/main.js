import { DrawCanvas, replayStrokes } from "./canvas.js";
import { CATEGORIES } from "./words.js";
import { getNickname, setNickname, startSession, fetchFeed } from "./api.js";
import { SoloGame } from "./solo.js";
import { PartyGame } from "./party.js";

const $ = (id) => document.getElementById(id);

const COLORS = ["#111111", "#e63946", "#2a9d8f", "#1d6fd8", "#e9a820", "#8338ec", "#8d5524"];
const SIZES = [3, 6, 12];
const GUESS_COOLDOWN_MS = 5000;

// ---------- Screens ----------
const screens = ["menu", "invite", "lobby", "game", "result"];
function showScreen(name) {
  for (const s of screens) $("screen-" + s).classList.toggle("hidden", s !== name);
  // Feed auf der Startseite (Menü) unter die Karte hängen
  if (name === "menu") {
    const slot = $("screen-menu").querySelector(".feed-slot");
    if (slot && feedEl.parentElement !== slot) slot.appendChild(feedEl);
    refreshFeed();
  }
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

// ---------- Social-Feed (Startseite) ----------
const feedEl = $("feed");
let feedLoadedAt = 0;

function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return "gerade eben";
  if (s < 3600) return `vor ${Math.round(s / 60)} Min.`;
  if (s < 86400) return `vor ${Math.round(s / 3600)} Std.`;
  return `vor ${Math.round(s / 86400)} Tag${Math.round(s / 86400) === 1 ? "" : "en"}`;
}

async function refreshFeed(force = false) {
  if (!force && Date.now() - feedLoadedAt < 30000) return; // nicht öfter als alle 30 s
  feedLoadedAt = Date.now();
  let wins = [];
  try {
    wins = await fetchFeed();
  } catch {
    return;
  }
  const list = $("feed-list");
  list.innerHTML = "";
  feedEl.classList.toggle("hidden", wins.length === 0);
  wins.forEach((w, i) => {
    const card = document.createElement("div");
    card.className = "feed-card";
    card.style.animationDelay = `${Math.min(i * 90, 700)}ms`;

    const pic = document.createElement("div");
    pic.className = "feed-pic";
    if (w.strokes?.length) {
      const c = document.createElement("canvas");
      c.width = 220; c.height = 165;
      pic.appendChild(c);
      // Zeichnung animiert „nachmalen" – gestaffelt, und auf Klick nochmal
      setTimeout(() => replayStrokes(c, w.strokes), 350 + i * 250);
      card.addEventListener("click", () => replayStrokes(c, w.strokes));
      card.title = "Klicken: Zeichnung nochmal abspielen";
    } else if (w.image) {
      const img = document.createElement("img");
      img.src = w.image;
      img.alt = w.word;
      img.onerror = () => img.remove();
      pic.appendChild(img);
    }
    card.appendChild(pic);

    const meta = document.createElement("div");
    meta.className = "feed-meta";
    const esc = (s) => { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; };
    meta.innerHTML =
      `<div class="feed-word">„${esc(w.word)}"</div>` +
      `<div class="feed-player"><span class="feed-avatar">${w.mode === "multi" ? "🎉" : "🖌️"}</span> ${esc(w.nickname)}</div>` +
      `<div class="feed-time">⏱️ ${w.durationS != null ? `in ${w.durationS} s` : ""} · ${timeAgo(w.createdAt)}</div>`;
    card.appendChild(meta);
    list.appendChild(card);
  });
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

// ---------- Auto-Check-Scheduler (fest alle 10 s) ----------
const CHECK_INTERVAL_S = 10;
let autoInterval = null;
let nextCheckIn = 0;
function startAutoCheck(fn) {
  stopAutoCheck();
  nextCheckIn = CHECK_INTERVAL_S;
  renderNextCheck();
  autoInterval = setInterval(() => {
    nextCheckIn--;
    renderNextCheck();
    if (nextCheckIn <= 0) {
      nextCheckIn = CHECK_INTERVAL_S;
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
function feedOppGuess(text, conf, nickname) {
  feedAdd(`👀 Bei ${esc(nickname || "Gegner")}: ${esc(text)} <span class="conf">${Math.round(conf)}%</span>`, "opp");
}

// ---------- Mitspieler-Mini-Canvases (Multiplayer) ----------
const oppStrip = $("opp-strip");
const oppCanvases = new Map(); // playerId -> canvas

function setupOpponents(players) {
  clearOpponents();
  oppStrip.classList.toggle("hidden", players.length === 0);
  for (const p of players) {
    const box = document.createElement("div");
    box.className = "opp-box";
    box.dataset.playerId = p.id;
    const c = document.createElement("canvas");
    c.width = 200; c.height = 150;
    const label = document.createElement("div");
    label.className = "opp-label";
    label.textContent = p.nickname;
    box.appendChild(c);
    box.appendChild(label);
    oppStrip.appendChild(box);
    oppCanvases.set(p.id, c);
  }
}

function drawOpponent(playerId, nickname, strokes) {
  let c = oppCanvases.get(playerId);
  if (!c) return;
  // Statisch neu zeichnen (Live-Ansicht, keine Animation nötig)
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, c.width, c.height);
  const sx = c.width / 800, sy = c.height / 600;
  for (const s of strokes || []) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = Math.max(1, s.size * sx);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    const pts = s.points || [];
    if (!pts.length) continue;
    ctx.moveTo(pts[0][0] * sx, pts[0][1] * sy);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * sx, pts[i][1] * sy);
    ctx.stroke();
  }
}

function removeOpponent(playerId) {
  oppCanvases.delete(playerId);
  oppStrip.querySelector(`[data-player-id="${playerId}"]`)?.remove();
  if (!oppCanvases.size) oppStrip.classList.add("hidden");
}

function clearOpponents() {
  oppCanvases.clear();
  oppStrip.innerHTML = "";
  oppStrip.classList.add("hidden");
}

// ---------- Lobby ----------
function inviteLink(code) {
  return location.origin + location.pathname + "?join=" + encodeURIComponent(code);
}

function lobbyPlayers(players, canStart, isHost, myId) {
  const box = $("lobby-players");
  box.innerHTML = "";
  for (const p of players) {
    const row = document.createElement("div");
    row.className = "lobby-player";
    row.innerHTML = `<span>${p.isHost ? "👑" : "🎨"}</span> ${esc(p.nickname)}${p.id === myId ? " <span class='conf'>(du)</span>" : ""}`;
    box.appendChild(row);
  }
  const startBtn = $("lobby-start");
  startBtn.classList.toggle("hidden", !isHost);
  startBtn.disabled = !canStart;
  startBtn.textContent = canStart ? "▶️ Spiel starten" : "▶️ Warte auf Mitspieler …";
}

$("lobby-share").onclick = async () => {
  const code = ui.lobbyCodeValue;
  if (!code) return;
  const url = inviteLink(code);
  const text = "Spiel mit mir Draw & Guess! Male einen Begriff – Claude errät ihn. Klick einfach auf den Link:";
  // Auf dem Handy den „Teilen mit …"-Dialog öffnen, sonst Link kopieren
  if (navigator.share) {
    try {
      await navigator.share({ title: "Draw & Guess", text, url });
      return;
    } catch { /* abgebrochen → Fallback unten */ }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast("Einladungslink kopiert! 📋", "good");
  } catch {
    prompt("Link kopieren:", url);
  }
};

// ---------- Result-Screen ----------
let resultHandlers = { onNext: null, onMenu: null };
function showResult({ title, text, nextLabel, nextDisabled, onNext, onMenu, showReplaySlot }) {
  $("result-title").textContent = title;
  $("result-text").textContent = text;
  $("result-text").style.whiteSpace = "pre-line";
  $("result-next").textContent = nextLabel || "Weiter";
  $("result-next").disabled = !!nextDisabled;
  $("result-replay-wrap").classList.toggle("hidden", !showReplaySlot);
  $("result-image-wrap").classList.add("hidden");
  resultHandlers = { onNext, onMenu };
  showScreen("result");
}
$("result-next").onclick = () => resultHandlers.onNext?.();
$("result-menu").onclick = () => resultHandlers.onMenu?.();

function showReplay(strokes) {
  $("result-replay-wrap").classList.remove("hidden");
  replayStrokes($("replay-canvas"), strokes);
}

function showResultImage(dataUrl, nickname) {
  $("result-image-wrap").classList.remove("hidden");
  $("result-image-caption").textContent = nickname ? `Siegerzeichnung von ${nickname}:` : "Siegerzeichnung:";
  $("result-image").src = dataUrl;
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
  if (err.message === "rate") {
    toast("Zu schnell! Kurz warten …", "bad");
  } else if (err.limit) {
    toast("💶 " + err.message, "bad");
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
  showResult, showReplay, showResultImage,
  saveHighscore,
  handleApiError,
  setupOpponents, drawOpponent, removeOpponent, clearOpponents,
  lobbyPlayers,
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
  lobbyCode: (code, isHost) => {
    ui.lobbyCodeValue = code;
    $("lobby-code").textContent = code;
    $("lobby-share").classList.toggle("hidden", !isHost && !navigator.share);
  },
  lobbyCodeValue: "",
  lobbyStatus: (s) => { $("lobby-status").textContent = s; },
};

const solo = new SoloGame(ui);
const party = new PartyGame(ui);
let currentMode = null;

// ---------- Nickname ----------
$("nickname").value = getNickname();
$("nickname").addEventListener("change", () => {
  setNickname($("nickname").value.trim());
});
function currentNickname() {
  const v = $("nickname").value.trim();
  setNickname(v);
  return v;
}

// ---------- Menü & Navigation ----------
const catSelect = $("setting-category");
for (const c of CATEGORIES) {
  const o = document.createElement("option");
  o.value = c;
  o.textContent = c.charAt(0).toUpperCase() + c.slice(1);
  catSelect.appendChild(o);
}

$("menu-solo").onclick = async () => {
  currentMode = solo;
  let session = null;
  try {
    session = await startSession(currentNickname());
  } catch {
    // Ohne Session spielen ist ok — dann ohne Feed-Eintrag.
  }
  solo.start(session?.sessionId, session?.nickname || currentNickname());
};
$("menu-party-create").onclick = () => { currentMode = party; party.create(currentNickname()); };
$("menu-party-join").onclick = () => {
  const code = $("join-code").value.trim().toUpperCase();
  if (code.length !== 4) return toast("4-stelligen Code eingeben", "bad");
  currentMode = party;
  party.join(code, currentNickname());
};
$("lobby-start").onclick = () => party.startMatch();
$("lobby-cancel").onclick = () => party.quit();
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

// ---------- Einladung per Link ----------
function pendingInviteCode() {
  const code = new URLSearchParams(location.search).get("join");
  return code && code.trim().length === 4 ? code.trim().toUpperCase() : null;
}

function setupInvite(code) {
  $("invite-code").textContent = code;
  $("invite-nickname").value = getNickname();
  showScreen("invite");
  $("invite-join").onclick = () => {
    const nick = $("invite-nickname").value.trim();
    setNickname(nick);
    $("nickname").value = nick;
    history.replaceState(null, "", location.pathname); // ?join= aus der URL entfernen
    currentMode = party;
    party.join(code, nick);
  };
  $("invite-decline").onclick = () => {
    history.replaceState(null, "", location.pathname);
    showScreen("menu");
  };
}

// ---------- Start ----------
{
  renderHighscore();
  const invite = pendingInviteCode();
  if (invite) setupInvite(invite);
  else showScreen("menu");
}
