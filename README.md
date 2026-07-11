# 🎨 Draw & Guess

Male einen Begriff – **Claude errät ihn**. Solo gegen die Uhr oder im Echtzeit-Duell:
Wer kann der KI schneller zeigen, welcher Begriff gemeint ist?

Läuft auf **https://draw.grogger.de** — nginx liefert dort sowohl das
statische Frontend als auch das Backend (`/api` + `/ws`) aus.

## Wie es funktioniert

- **Frontend** (`web/`): statische Seite ohne Build-Schritt. Zeichencanvas
  (nur Freihand-Strokes – kein Text-Tool, kein Bild-Import), Solo-Modus und
  Echtzeit-Duell. Beim Start wird ein Zugangscode eingegeben (bleibt optional
  im Browser gespeichert).
- **Backend** (`server/`): Node-Service.
  - `POST /api/guess` legt den Canvas-Snapshot als Temp-Datei ab und lässt
    **Claude über das Agent SDK** (Modell: Haiku 4.5, konfigurierbar) die
    Zeichnung betrachten. So wird das **Plan-Kontingent** genutzt
    (`CLAUDE_CODE_OAUTH_TOKEN`), alternativ ein API-Key.
  - Antwort ist strukturiert: Top-3-Guesses mit Konfidenz, ein Kommentar und
    ein **Fraud-Check** (`written_text`): Steht Text/Buchstaben im Bild, zählt
    der Check nicht — im Duell gibt es beim zweiten Versuch Rundenverlust.
  - `WS /ws`: Duell-Relay. Der Server wählt das Rundenwort, wertet Treffer aus
    (Wort-Normalisierung inkl. Umlaute/Plural/Tippfehler-Toleranz) und
    entscheidet Runden (Best of 5). Am Rundenende sieht jeder die Zeichnung
    des Gegners als Stroke-Replay.

## Spielablauf

1. Begriff wird angezeigt, 120 s Timer (Duell: 90 s).
2. Alle 20 s (einstellbar: 10/20/30) geht ein Snapshot an Claude — aber nur,
   wenn sich die Zeichnung geändert hat. Zusätzlich: „Jetzt raten!"-Button.
3. Claudes Vermutungen erscheinen live im Feed; im Duell sieht man auch den
   Top-Guess des Gegners.
4. Treffer: Solo → Punkte = Restzeit (+Bonus für Ersterkennung).
   Duell → Rundensieg, Best of 5.

## Lokal entwickeln

```bash
cd server && npm install
ACCESS_CODE=test CLAUDE_CODE_OAUTH_TOKEN=... node src/index.js
# → http://127.0.0.1:8790 (serviert auch das Frontend)
```
