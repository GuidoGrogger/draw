# 🎨 Draw & Guess

Male einen Begriff – **Claude errät ihn**. Solo gegen die Uhr oder im
Multiplayer mit Freunden: Wer kann der KI schneller zeigen, welcher Begriff
gemeint ist?

Läuft auf **https://draw.grogger.de** — nginx liefert dort sowohl das
statische Frontend als auch das Backend (`/api` + `/ws`) aus.

## Wie es funktioniert

- **Frontend** (`web/`): statische Seite ohne Build-Schritt. Zeichencanvas
  (nur Freihand-Strokes – kein Text-Tool, kein Bild-Import), Solo-Modus und
  Multiplayer. Beim Start wird ein Zugangscode eingegeben (bleibt optional
  im Browser gespeichert). Der Begriff steht **unter** der Zeichenfläche
  (auf dem Handy verdeckte ihn sonst ein Overlay).
- **Nickname & Feed**: Vor dem Spielen kann ein Nickname eingegeben werden
  (leer → anonymer Name wie „Flinker Fuchs 42"). Die Startseite zeigt einen
  **Social-Feed** der zuletzt gewonnenen Runden: Zeichnung (animiertes
  Stroke-Replay), Begriff, Spieler und benötigte Zeit. Im UI steht ein
  Hinweis, dass Name und Siege öffentlich angezeigt werden können.
- **Backend** (`server/`): Node-Service mit **SQLite** (`better-sqlite3`,
  `DB_PATH`, Standard `server/data/draw-guess.sqlite`).
  - `POST /api/guess` legt den Canvas-Snapshot als Temp-Datei ab und lässt
    **Claude über das Agent SDK** (Modell: Haiku 4.5, konfigurierbar) die
    Zeichnung betrachten. So wird das **Plan-Kontingent** genutzt
    (`CLAUDE_CODE_OAUTH_TOKEN`), alternativ ein API-Key.
    Die **Kosten jedes Checks** (`total_cost_usd`) werden pro Session in der
    DB festgehalten.
  - **Monatslimit**: Standard **20 €/Monat** (im Admin-Backend änderbar).
    Ist es erreicht, pausieren die KI-Checks bis zum Monatswechsel (HTTP 503).
  - Antwort ist strukturiert: Top-3-Guesses mit Konfidenz, ein Kommentar und
    ein **Fraud-Check** (`written_text`): Steht Text/Buchstaben im Bild, zählt
    der Check nicht — im Multiplayer gibt es beim zweiten Versuch Rundenverlust.
  - `GET /api/feed`: öffentliche Liste gewonnener Runden für die Startseite.
  - `WS /ws`: Multiplayer-Relay (siehe unten).
- **Admin-Backend** (`/admin`, geschützt über `ADMIN_CODE`): Kosten pro
  Tag/Monat als Diagramm, Monats-Meter gegen das Limit, Limit & €/$-Kurs
  einstellbar, Liste der letzten Sessions mit Kosten.

## Multiplayer

1. Im Menü **„Multiplayer starten"** → Lobby mit Raumcode.
2. **📤 Einladungslink teilen** (auf dem Handy über den „Teilen mit …"-Dialog,
   sonst Zwischenablage). Eingeladene klicken nur auf den Link, geben optional
   einen Nickname ein und sind drin — **ohne Zugangscode**. Es können mehrere
   Personen eingeladen werden (bis 8).
3. **Der Host entscheidet, wann es losgeht** (Start-Button ab 2 Spielern).
4. Alle malen **denselben Begriff**; die Zeichnungen der Mitspieler erscheinen
   live in kleinen Canvases unter dem eigenen Zeichenfeld. Wessen Zeichnung
   Claude zuerst erkennt, gewinnt die Runde (3 Runden pro Match).

## Spielablauf

1. Begriff wird angezeigt, 180 s Timer (Multiplayer: 90 s).
2. Alle 10 s (einstellbar: 10/20/30) geht ein Snapshot an Claude — aber nur,
   wenn sich die Zeichnung geändert hat. Zusätzlich: „Jetzt raten!"-Button.
3. Claudes Vermutungen erscheinen live im Feed; im Multiplayer sieht man auch
   die Top-Guesses der anderen. Bereits geratene, falsche Begriffe merkt sich
   das Spiel und schließt sie beim nächsten Check aus.
4. Treffer: Solo → Punkte = Restzeit (+Bonus für Ersterkennung); der Sieg
   landet mit Bild, Begriff und Zeit im Startseiten-Feed.
   Multiplayer → Rundensieg, Ranking nach 3 Runden.

## Lokal entwickeln

```bash
cd server && npm install
ACCESS_CODE=test ADMIN_CODE=admin CLAUDE_CODE_OAUTH_TOKEN=... node src/index.js
# → http://127.0.0.1:8790 (serviert auch das Frontend, /admin = Dashboard)

# Ohne echte KI testen (Fake-Guesser, kostenlos):
ACCESS_CODE=test ADMIN_CODE=admin FAKE_GUESSER=1 FAKE_ALWAYS_HIT=1 node src/index.js
```

Env-Variablen: `ACCESS_CODE` (Pflicht), `ADMIN_CODE` (Admin-Backend),
`CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`, `GUESS_MODEL`, `PORT`,
`DB_PATH`, `FAKE_GUESSER` / `FAKE_ALWAYS_HIT` (nur Dev).
