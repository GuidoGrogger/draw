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

const SYSTEM_PROMPT = `Du bist der Ratemeister in einem Zeichenspiel ("Montagsmaler").
Ein Mensch hat mit der Maus/dem Finger einen Begriff auf eine weiße Leinwand gemalt.
Deine Aufgabe:
1. Schau dir die Zeichnung genau an und rate, welcher Begriff gemeint ist.
2. WICHTIG - Betrugserkennung: Prüfe, ob im Bild Buchstaben, geschriebene Wörter,
   Zahlen oder Text zu sehen sind (der Spieler könnte das Wort einfach hinschreiben,
   statt es zu zeichnen). Auch einzelne Buchstaben als Hinweis zählen als Betrug.
   Normale Zeichnungselemente (z.B. ein Kreuz, geometrische Formen) sind KEIN Text.
3. Antworte AUSSCHLIESSLICH mit einem JSON-Objekt, ohne Markdown, ohne Erklärung davor
   oder danach, in exakt diesem Format:
{"guesses":[{"term":"Begriff1","confidence":85},{"term":"Begriff2","confidence":40},{"term":"Begriff3","confidence":20}],"written_text":false,"comment":"kurzer witziger Kommentar (max 10 Wörter)"}

Regeln für guesses: 1-3 deutsche Begriffe (einzelne Substantive oder Tätigkeiten),
sortiert nach Wahrscheinlichkeit, confidence 0-100.
Wenn du gar nichts erkennst: leere guesses-Liste und ehrlicher Kommentar.`;

let running = 0;

export async function guessDrawing(imageDataUrl) {
  if (running >= MAX_CONCURRENT) {
    const err = new Error("busy");
    err.code = "BUSY";
    throw err;
  }
  running++;
  try {
    return await runGuess(imageDataUrl);
  } finally {
    running--;
  }
}

async function runGuess(imageDataUrl) {
  const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(imageDataUrl || "");
  if (!m) throw new Error("Ungültiges Bildformat");
  const ext = m[1] === "png" ? "png" : "jpg";
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > 2 * 1024 * 1024) throw new Error("Bild zu groß");

  await mkdir(TMP_DIR, { recursive: true });
  const file = path.join(TMP_DIR, `${randomUUID()}.${ext}`);
  await writeFile(file, buf);

  try {
    let resultText = "";
    const q = query({
      prompt: `Lies die Bilddatei ${file} mit dem Read-Tool und bewerte die Zeichnung wie im Systemprompt beschrieben. Antworte nur mit dem JSON.`,
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
        if (msg.subtype === "success") resultText = msg.result;
        else throw new Error("KI-Fehler: " + msg.subtype);
      }
    }
    return parseGuessJson(resultText);
  } finally {
    unlink(file).catch(() => {});
  }
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
    return {
      guesses,
      writtenText: Boolean(data.written_text),
      comment: typeof data.comment === "string" ? data.comment.slice(0, 140) : "",
    };
  } catch {
    return { guesses: [], writtenText: false, comment: "" };
  }
}
