// Gemeinsame Helfer für Solo- und Multiplayer-Modus.

// Falsch geratene Begriffe merken (einmalig, case-insensitiv) — sie werden
// beim nächsten KI-Check als excludeTerms mitgeschickt.
export function rememberWrong(wrongGuesses, guesses) {
  for (const g of guesses || []) {
    const term = g?.term?.trim();
    if (!term) continue;
    if (!wrongGuesses.some((w) => w.toLowerCase() === term.toLowerCase())) {
      wrongGuesses.push(term);
    }
  }
}
