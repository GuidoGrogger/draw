import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

const TOKEN = "test-monitoring-token";
const ADMIN = "test-admin-code";
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/index.js");
let child, base, dir;

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "mon-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [SRC], {
    env: {
      ...process.env,
      PORT: String(port),
      BIND_ADDR: "127.0.0.1",
      DB_PATH: path.join(dir, "t.sqlite"),
      MONITORING_TOKEN: TOKEN,
      ADMIN_CODE: ADMIN,
      FAKE_GUESSER: "1",
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try { await fetch(base + "/api/feed"); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error("server did not start");
});

after(() => {
  child?.kill();
  rmSync(dir, { recursive: true, force: true });
});

const get = (q, auth) =>
  fetch(`${base}/api/monitoring/summary${q}`, { headers: auth ? { Authorization: auth } : {} });

test("401 ohne und mit falschem Header, auch mit ADMIN_CODE", async () => {
  assert.equal((await get("")).status, 401);
  assert.equal((await get("", "Bearer wrong")).status, 401);
  assert.equal((await get("", `Bearer ${ADMIN}`)).status, 401);
});

test("MONITORING_TOKEN öffnet nicht das Admin-Backend", async () => {
  const r = await fetch(`${base}/api/admin/overview`, { headers: { "X-Admin-Code": TOKEN, Authorization: `Bearer ${TOKEN}` } });
  assert.equal(r.status, 401);
});

test("200: Form, Schlüssel, nur Zahlen", async () => {
  const r = await get(`?since=${new Date(Date.now() - 30 * 86400000).toISOString()}`, `Bearer ${TOKEN}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const b = await r.json();
  assert.deepEqual(Object.keys(b), ["app", "since", "until", "counters"]);
  assert.equal(b.app, "draw");
  assert.deepEqual(Object.keys(b.counters).sort(),
    ["api_calls", "api_cost_usd", "month_cost_eur", "rounds", "rounds_solved", "sessions", "wins"]);
  for (const [name, c] of Object.entries(b.counters)) {
    const keys = name === "month_cost_eur" ? ["total"] : ["total", "new"];
    assert.deepEqual(Object.keys(c), keys);
    for (const v of Object.values(c)) assert.equal(typeof v, "number");
  }
});

test("Default-since (24h) funktioniert", async () => {
  assert.equal((await get("", `Bearer ${TOKEN}`)).status, 200);
});

test("400 bei ungültigem since", async () => {
  const a = `Bearer ${TOKEN}`;
  assert.equal((await get("?since=gestern", a)).status, 400);
  assert.equal((await get("?since=2999-01-01T00:00:00Z", a)).status, 400);
  assert.equal((await get("?since=2000-01-01T00:00:00Z", a)).status, 400);
});
