# Draw & Guess — Container-Image (Backend + statisches web/).
#
# Das Image beschreibt nur, WIE dieser Code baut und läuft. Wo er läuft
# (Server, Domain, Ports, nginx) steht bewusst nicht hier — dieses Repo ist
# öffentlich, die Betriebs-Konfiguration liegt woanders.
#
# web/ muss mit ins Image: der Server importiert die Wortliste aus
# web/src/words.js. Ausgeliefert wird das Frontend in Produktion zwar von
# nginx direkt aus dem Quellbaum, aber der Node-Server kann es auch selbst
# (GET /*) — damit läuft das Image auch standalone:
#
#   docker build -t draw-guess .
#   docker run --rm -p 8790:8790 -e FAKE_GUESSER=1 draw-guess
FROM node:22-slim

RUN groupadd -g 10001 draw && useradd -u 10001 -g draw -M -s /usr/sbin/nologin draw \
 && mkdir -p /data && chown draw:draw /data

WORKDIR /app/server

# Erst die Modul-Dateien: so bleibt der Dependency-Layer (inkl. des nativen
# better-sqlite3-Builds) über Code-Änderungen hinweg im Cache.
COPY server/package.json server/package-lock.json ./
# --ignore-scripts: better-sqlite3 ab v12 bringt die nativen Binaries fertig
# in prebuilds/ mit; ohne den Schalter ruft npm trotzdem node-gyp auf, und das
# Slim-Image hat kein Python. Ob das Binary lädt, prüft das Test-Gate unten.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

COPY server/src ./src
COPY web /app/web

# Test-Gate am Artefakt (es gibt keine Testsuite): kein Image mit
# Syntaxfehlern. Scheitert der Check, scheitert der Build — und der laufende
# Container bleibt unangetastet.
RUN for f in src/*.js; do node --check "$f"; done \
 && node -e "new (require('better-sqlite3'))(':memory:').prepare('select 1').get()"

USER draw:draw

# HOME=/tmp: der Agent-SDK-Fallback in guesser.js will ein beschreibbares
# Home; das Dateisystem darf ansonsten read-only eingehängt werden.
ENV PORT=8790 \
    BIND_ADDR=0.0.0.0 \
    DB_PATH=/data/draw-guess.sqlite \
    HOME=/tmp

EXPOSE 8790
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8790)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
