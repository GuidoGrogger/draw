// Ruft Claude über das Agent SDK auf (nutzt das Plan-Kontingent via
// CLAUDE_CODE_OAUTH_TOKEN oder alternativ ANTHROPIC_API_KEY).
// Das Bild wird als Temp-Datei abgelegt und vom Agenten mit dem
// Read-Tool betrachtet.

import { query } from "@anthropic-ai/claude-agent-sdk";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";

const MODEL = process.env.GUESS_MODEL || "claude-haiku-4-5";
const TMP_DIR = path.join(os.tmpdir(), "draw-guess");
const MAX_CONCURRENT = 3;

// Fallback-Kostenschätzung, falls das SDK kein total_cost_usd liefert
// (Haiku 4.5: $1 Input / $5 Output pro Million Tokens).
const FALLBACK_PRICE_IN = 1 / 1e6;
const FALLBACK_PRICE_OUT = 5 / 1e6;

// Dev-/Testmodus ohne echte KI: FAKE_GUESSER=1 (Server-Env).
const FAKE = process.env.FAKE_GUESSER === "1";
const FAKE_WORDS = ["Katze", "Haus", "Sonne", "Rakete", "Pilz", "Anker"];

const SYSTEM_PROMPT = `Du bist der Ratemeister in einem Zeichenspiel ("Montagsmaler").
Ein Mensch hat mit der Maus/dem Finger einen Begriff auf eine weiße Leinwand gemalt.
Deine Aufgabe:
1. Schau dir die Zeichnung genau an und rate, welcher Begriff gemeint ist.
2. Betrugserkennung (sei ZURÜCKHALTEND, im Zweifel KEIN Betrug): Melde nur dann Betrug,
   wenn eindeutig lesbare Buchstaben, Wörter oder Zahlen im Bild stehen, die den Begriff
   verraten. Handgemalte Zeichnungen sind ungenau - krumme, zackige oder ausgefranste
   Linien, Schraffuren, Pfeile, Kreuze, geometrische Formen oder einzelne mehrdeutige
   Kritzel sind KEIN Text. Nur wenn du ein Wort tatsächlich LESEN kannst, ist es Betrug.
   Gib deine Sicherheit als written_text_confidence (0-100) an: 0 = sicher kein Text,
   100 = eindeutig lesbares Wort. Setze written_text nur auf true, wenn du dir sehr
   sicher bist (Sicherheit >= 80).
3. Antworte AUSSCHLIESSLICH mit einem JSON-Objekt, ohne Markdown, ohne Erklärung davor
   oder danach, in exakt diesem Format:
{"guesses":[{"term":"Begriff1","confidence":85},{"term":"Begriff2","confidence":40},{"term":"Begriff3","confidence":20}],"written_text":false,"written_text_confidence":0,"comment":"kurzer witziger Kommentar (max 10 Wörter)"}

Regeln für guesses: 1-3 deutsche Begriffe (einzelne Substantive oder Tätigkeiten),
sortiert nach Wahrscheinlichkeit, confidence 0-100.
Wenn du gar nichts erkennst: leere guesses-Liste und ehrlicher Kommentar.`;

// Nur wenn die KI sich sehr sicher ist, dass echter Text im Bild steht,
// zählt es als Betrug. So werden zackige Zeichenlinien nicht fälschlich geflaggt.
const CHEAT_CONFIDENCE_THRESHOLD = 80;

let running = 0;

// Liefert { guesses, writtenText, comment, costUsd, durationMs, model }.
// hintWord wird nur im FAKE-Modus benutzt, um Treffer testbar zu machen.
export async function guessDrawing(imageDataUrl, excludeTerms = [], hintWord = null) {
  if (FAKE) return fakeGuess(hintWord);
  if (running >= MAX_CONCURRENT) {
    const err = new Error("busy");
    err.code = "BUSY";
    throw err;
  }
  running++;
  try {
    return await runGuess(imageDataUrl, excludeTerms);
  } finally {
    running--;
  }
}

async function fakeGuess(hintWord) {
  await new Promise((r) => setTimeout(r, 150));
  const hit = process.env.FAKE_ALWAYS_HIT === "1" && hintWord;
  const term = hit ? hintWord : FAKE_WORDS[Math.floor(Math.random() * FAKE_WORDS.length)];
  return {
    guesses: [{ term, confidence: 77 }],
    writtenText: false,
    comment: "Fake-Modus – keine echte KI",
    costUsd: 0.0042,
    durationMs: 150,
    model: "fake",
  };
}

// Bereits geratene, aber falsche Begriffe für den Prompt aufbereiten.
function excludeHint(excludeTerms) {
  const terms = (Array.isArray(excludeTerms) ? excludeTerms : [])
    .filter((t) => typeof t === "string" && t.trim())
    .map((t) => t.trim().slice(0, 60))
    .slice(0, 30);
  if (!terms.length) return "";
  return ` Diese Begriffe wurden in vorherigen Checks schon geraten und waren FALSCH: ` +
    `${terms.join(", ")}. Nenne sie NICHT erneut – schlage nur andere, neue Begriffe vor.`;
}

async function runGuess(imageDataUrl, excludeTerms = []) {
  const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(imageDataUrl || "");
  if (!m) throw new Error("Ungültiges Bildformat");
  const ext = m[1] === "png" ? "png" : "jpg";
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > 2 * 1024 * 1024) throw new Error("Bild zu groß");

  await mkdir(TMP_DIR, { recursive: true });
  const file = path.join(TMP_DIR, `${randomUUID()}.${ext}`);
  await writeFile(file, buf);

  const startedAt = Date.now();
  try {
    let resultText = "";
    let costUsd = 0;
    const q = query({
      prompt: `Lies die Bilddatei ${file} mit dem Read-Tool und bewerte die Zeichnung wie im Systemprompt beschrieben. Antworte nur mit dem JSON.` + excludeHint(excludeTerms),
      options: {
        model: MODEL,
        maxTurns: 4,
        allowedTools: ["Read"],
        disallowedTools: ["Bash", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Task"],
        systemPrompt: SYSTEM_PROMPT,
        cwd: TMP_DIR,
        env: { ...process.env },
      },
    });

    for await (const msg of q) {
      if (msg.type === "result") {
        // Kosten dieses Checks: das SDK meldet total_cost_usd; falls das
        // fehlt, aus den Token-Zahlen schätzen (Haiku-4.5-Preise).
        costUsd = Number(msg.total_cost_usd) || estimateCost(msg.usage);
        if (msg.subtype === "success") resultText = msg.result;
        else throw new Error("KI-Fehler: " + msg.subtype);
      }
    }
    return {
      ...parseGuessJson(resultText),
      costUsd,
      durationMs: Date.now() - startedAt,
      model: MODEL,
    };
  } finally {
    unlink(file).catch(() => {});
  }
}

function estimateCost(usage) {
  if (!usage) return 0;
  const inTok = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  const outTok = usage.output_tokens || 0;
  return inTok * FALLBACK_PRICE_IN + outTok * FALLBACK_PRICE_OUT;
}

export function parseGuessJson(text) {
  const jsonMatch = /\{[\s\S]*\}/.exec(text || "");
  if (!jsonMatch) return { guesses: [], writtenText: false, comment: "" };
  try {
    const data = JSON.parse(jsonMatch[0]);
    const guesses = (Array.isArray(data.guesses) ? data.guesses : [])
      .filter((g) => g && typeof g.term === "string")
      .slice(0, 3)
      .map((g) => ({
        term: g.term.slice(0, 60),
        confidence: Math.max(0, Math.min(100, Number(g.confidence) || 0)),
      }));
    // Betrug nur, wenn die KI Text meldet UND sich dabei sehr sicher ist.
    // Fehlt die Confidence (ältere Antworten), reicht das reine Flag.
    const hasConfidence = data.written_text_confidence != null;
    const textConfidence = Math.max(0, Math.min(100, Number(data.written_text_confidence) || 0));
    const writtenText = Boolean(data.written_text) &&
      (!hasConfidence || textConfidence >= CHEAT_CONFIDENCE_THRESHOLD);
    return {
      guesses,
      writtenText,
      comment: typeof data.comment === "string" ? data.comment.slice(0, 140) : "",
    };
  } catch {
    return { guesses: [], writtenText: false, comment: "" };
  }
}
