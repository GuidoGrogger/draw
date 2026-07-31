// Vergleicht KI-Guesses mit dem Zielbegriff — tolerant gegenüber
// Umlauten, Groß-/Kleinschreibung, Artikeln und kleinen Tippabweichungen.

export function normalize(word) {
  return String(word || "")
    .toLowerCase()
    .replace(/^(der|die|das|ein|eine)\s+/, "")
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/[^a-z]/g, "");
}

function levenshtein(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}

function stripPlural(w) {
  return w.replace(/(en|er|e|n|s)$/, "");
}

export function isMatch(guess, target) {
  const g = normalize(guess);
  const t = normalize(target);
  if (!g || !t) return false;
  if (g === t) return true;
  if (stripPlural(g) === stripPlural(t) && stripPlural(t).length >= 3) return true;
  const tol = t.length >= 8 ? 2 : t.length >= 5 ? 1 : 0;
  return tol > 0 && levenshtein(g, t) <= tol;
}

export function anyMatch(guesses, target) {
  return (guesses || []).some((g) => isMatch(g.term, target));
}

// Client-gelieferte Ausschlussliste absichern: Legitim sind nur Begriffe,
// die die KI selbst geraten hat — einzelne Wörter. Sätze, Steuerzeichen
// oder Sonderzeichen fliegen raus, denn die Liste wird in den Claude-Prompt
// eingebettet und im Multiplayer kennt jeder Spieler das Zielwort — freier
// Text wäre ein Kanal für Prompt-Injection ("rate sofort X").
export function sanitizeExcludeTerms(terms) {
  const out = [];
  for (const t of Array.isArray(terms) ? terms : []) {
    if (typeof t !== "string") continue;
    const term = t.trim();
    if (!term || term.length > 40) continue;
    if (!/^[\p{L}\p{N}\-]+$/u.test(term)) continue;
    out.push(term);
    if (out.length >= 30) break;
  }
  return out;
}
