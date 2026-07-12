// Ruft Claude auf — so schnell wie möglich:
// 1. Bevorzugt DIREKT über die Messages-API (ein HTTP-Call, kein
//    CLI-Subprozess). Auth: ANTHROPIC_API_KEY oder das Plan-Kontingent-
//    OAuth-Token (Bearer + oauth-Beta-Header, wie Claude Code selbst).
// 2. Fallback: Agent SDK (falls der Direktweg nicht erlaubt ist).
// Das Bild geht als Content-Block direkt in die Nachricht — eine einzige
// Modell-Runde (der alte Temp-Datei+Read-Tool-Weg brauchte Ø ~18 s).

import { query } from "@anthropic-ai/claude-agent-sdk";

const MODEL = process.env.GUESS_MODEL || "claude-haiku-4-5";
const MAX_CONCURRENT = 3;
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN || "";
const DIRECT_URL = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com") + "/v1/messages";

// Funktioniert der Direktweg nicht (z.B. Token nicht API-berechtigt),
// eine Stunde lang nicht erneut probieren — der SDK-Fallback übernimmt.
let directDisabledUntil = 0;

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
WICHTIG: Die gesuchten Begriffe sind einfache Alltagswörter, wie man sie in einem
Familien-Zeichenspiel malt — Tiere, Gegenstände, Natur, Essen, Aktivitäten oder
einfache abstrakte Begriffe (z.B. Urlaub, Musik). Rate NIEMALS Fachbegriffe aus
Biologie, Technik oder Wissenschaft (kein "Euglena", kein "Mitochondrium") —
wenn etwas wie eine Zelle aussieht, ist es eher ein Spiegelei oder ein Auge.
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
// Wichtig: Nur die EXAKTEN Begriffe ausschließen — verwandte oder genauere
// Varianten bleiben erlaubt, sonst drängt die Liste die KI zu immer
// absurderen Begriffen ("Ei" falsch → "Spiegelei" muss erlaubt bleiben).
function excludeHint(excludeTerms) {
  const terms = (Array.isArray(excludeTerms) ? excludeTerms : [])
    .filter((t) => typeof t === "string" && t.trim())
    .map((t) => t.trim().slice(0, 60))
    .slice(0, 30);
  if (!terms.length) return "";
  return ` Diese exakten Begriffe wurden schon geraten und waren FALSCH: ` +
    `${terms.join(", ")}. Nenne genau diese Wörter nicht erneut. Verwandte, genauere ` +
    `oder zusammengesetzte Begriffe sind aber ausdrücklich ERLAUBT und oft richtig ` +
    `(war "Ei" falsch, kann "Spiegelei" die Lösung sein). Bleib bei einfachen ` +
    `Alltagswörtern zu dem, was du im Bild siehst — weiche NICHT auf exotische ` +
    `oder wissenschaftliche Begriffe aus, nur weil die naheliegenden schon dabei waren.`;
}

async function runGuess(imageDataUrl, excludeTerms = []) {
  const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(imageDataUrl || "");
  if (!m) throw new Error("Ungültiges Bildformat");
  const mediaType = m[1] === "png" ? "image/png" : "image/jpeg";
  const imageData = m[2];
  if (imageData.length > 3 * 1024 * 1024) throw new Error("Bild zu groß");

  const startedAt = Date.now();
  const userContent = [
    { type: "image", source: { type: "base64", media_type: mediaType, data: imageData } },
    {
      type: "text",
      text: "Bewerte diese Zeichnung wie im Systemprompt beschrieben. Antworte nur mit dem JSON." + excludeHint(excludeTerms),
    },
  ];

  if ((API_KEY || OAUTH_TOKEN) && Date.now() > directDisabledUntil) {
    try {
      return await runDirect(userContent, startedAt);
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        directDisabledUntil = Date.now() + 60 * 60000;
        console.warn(`Direkt-API nicht erlaubt (${err.status}) — nutze Agent SDK (erneuter Versuch in 1 h).`);
      } else {
        console.warn("Direkt-API fehlgeschlagen:", err.message, "— Fallback aufs Agent SDK.");
      }
    }
  }
  return runViaSdk(userContent, startedAt);
}

// Schnellster Weg: ein einziger HTTP-Call an die Messages-API.
async function runDirect(userContent, startedAt) {
  const headers = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (API_KEY) {
    headers["x-api-key"] = API_KEY;
  } else {
    // Plan-Kontingent-Token (claude setup-token) — derselbe Auth-Weg,
    // den Claude Code selbst benutzt.
    headers["authorization"] = "Bearer " + OAUTH_TOKEN;
    headers["anthropic-beta"] = "oauth-2025-04-20";
  }

  const res = await fetch(DIRECT_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 300, // kompaktes JSON — klein halten macht die Antwort schneller
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const err = new Error(`Messages-API ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const msg = await res.json();
  const text = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  return {
    ...parseGuessJson(text),
    costUsd: estimateCost(msg.usage),
    durationMs: Date.now() - startedAt,
    model: MODEL + " (direkt)",
  };
}

// Fallback: Agent SDK (CLI-Subprozess — langsamer, aber immer erlaubt).
async function runViaSdk(userContent, startedAt) {
  // Streaming-Input-Modus: so lässt sich das Bild als Content-Block
  // mitschicken. Genau eine User-Nachricht, dann ist der Stream zu Ende.
  async function* promptStream() {
    yield {
      type: "user",
      parent_tool_use_id: null,
      message: { role: "user", content: userContent },
    };
  }

  let resultText = "";
  let costUsd = 0;
  const q = query({
    prompt: promptStream(),
    options: {
      model: MODEL,
      maxTurns: 1, // eine Antwort, keine Tool-Runden
      allowedTools: [],
      disallowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Task"],
      systemPrompt: SYSTEM_PROMPT,
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
