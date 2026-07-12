// Admin-Dashboard: Kosten pro Tag/Monat als Balkendiagramm (SVG, ohne Libs),
// Monatslimit-Meter, Einstellungen (Limit in €) und Session-Liste.
// Geschützt über ADMIN_CODE (Header X-Admin-Code).

const API_BASE =
  location.hostname === "draw.grogger.de" || location.hostname === "127.0.0.1" || location.hostname === "localhost"
    ? ""
    : "https://draw.grogger.de";

const $ = (id) => document.getElementById(id);

function getCode() { return sessionStorage.getItem("adminCode") || ""; }
function setCode(c) { sessionStorage.setItem("adminCode", c); }

async function api(path, opts = {}) {
  const res = await fetch(API_BASE + path, {
    ...opts,
    headers: { "Content-Type": "application/json", "X-Admin-Code": getCode(), ...(opts.headers || {}) },
  });
  if (res.status === 401) throw new Error("auth");
  if (!res.ok) throw new Error("Fehler " + res.status);
  return res.json();
}

const fmtEur = (v) => v.toLocaleString("de-DE", { style: "currency", currency: "EUR" });
const fmtUsd = (v) => "$" + v.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---------- Balkendiagramm (SVG) ----------
// Spezifikation: Balken ≤ 24px, oben 4px abgerundet, unten flach an der
// Basislinie; Hairline-Gridlines; Werte über Tooltip (Hover) + Achsen-Ticks.
function niceTicks(maxValue, count = 4) {
  if (maxValue <= 0) return [0, 1];
  const rawStep = maxValue / count;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rawStep) || 10 * mag;
  const ticks = [];
  for (let v = 0; v <= maxValue + step * 0.001; v += step) ticks.push(+v.toFixed(6));
  if (ticks[ticks.length - 1] < maxValue) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

function barChart(container, data, { limit = null, tooltipFor } = {}) {
  container.innerHTML = "";
  if (!data.length) {
    container.innerHTML = '<p class="sub">Noch keine Daten.</p>';
    return;
  }
  const W = 900, H = 260;
  const pad = { top: 14, right: 12, bottom: 26, left: 54 };
  const iw = W - pad.left - pad.right;
  const ih = H - pad.top - pad.bottom;
  const maxVal = Math.max(...data.map((d) => d.value), limit || 0, 0.01);
  const ticks = niceTicks(maxVal);
  const top = ticks[ticks.length - 1];
  const y = (v) => pad.top + ih - (v / top) * ih;

  const band = iw / data.length;
  const barW = Math.min(24, Math.max(3, band - 2)); // 2px Lücke zwischen Balken
  const r = Math.min(4, barW / 2);

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

  let g = "";
  // Gridlines + Y-Ticks (saubere runde Werte)
  for (const t of ticks) {
    g += `<line class="gridline" x1="${pad.left}" x2="${W - pad.right}" y1="${y(t)}" y2="${y(t)}"></line>`;
    g += `<text x="${pad.left - 8}" y="${y(t) + 4}" text-anchor="end">${t.toLocaleString("de-DE")}</text>`;
  }

  // Balken: oben abgerundet, an der Basislinie flach
  data.forEach((d, i) => {
    const x = pad.left + i * band + (band - barW) / 2;
    const h = Math.max(0, y(0) - y(d.value));
    const rr = Math.min(r, h);
    const pathD = h <= 0 ? null :
      `M${x},${y(0)} v${-(h - rr)} q0,${-rr} ${rr},${-rr} h${barW - 2 * rr} q${rr},0 ${rr},${rr} v${h - rr} z`;
    if (pathD) g += `<path class="bar" data-i="${i}" d="${pathD}"></path>`;
    // Unsichtbares Hover-Ziel über die ganze Spalte (größer als der Balken)
    g += `<rect data-i="${i}" x="${pad.left + i * band}" y="${pad.top}" width="${band}" height="${ih}" fill="transparent"></rect>`;
  });

  // X-Beschriftung: nur ausgewählte Ticks, damit nichts kollidiert
  const every = Math.ceil(data.length / 8);
  data.forEach((d, i) => {
    const isLast = i === data.length - 1;
    // reguläre Ticks kurz vor dem letzten Label auslassen (Kollision)
    if (isLast ? false : i % every !== 0 || data.length - 1 - i < every / 2) return;
    const x = pad.left + i * band + band / 2;
    g += `<text x="${x}" y="${H - 8}" text-anchor="middle">${d.label}</text>`;
  });

  // Referenzlinie fürs Limit (mit Text-Label, nicht nur Farbe)
  if (limit != null && limit > 0 && limit <= top) {
    g += `<line class="limitline" x1="${pad.left}" x2="${W - pad.right}" y1="${y(limit)}" y2="${y(limit)}"></line>`;
    g += `<text class="limitlabel" x="${W - pad.right}" y="${y(limit) - 5}" text-anchor="end">Limit ${limit.toLocaleString("de-DE")} €</text>`;
  }

  svg.innerHTML = g;
  container.appendChild(svg);

  // Hover-Tooltip
  const tip = $("tooltip");
  svg.addEventListener("mousemove", (e) => {
    const t = e.target.closest("[data-i]");
    if (!t) { tip.style.display = "none"; return; }
    const d = data[+t.dataset.i];
    tip.innerHTML = tooltipFor ? tooltipFor(d) : `<b>${d.label}</b>`;
    tip.style.display = "block";
    tip.style.left = Math.min(e.clientX + 14, window.innerWidth - 180) + "px";
    tip.style.top = (e.clientY + 14) + "px";
  });
  svg.addEventListener("mouseleave", () => { tip.style.display = "none"; });
}

// ---------- Dashboard ----------
function kpiTile(label, value, note = "") {
  return `<div class="card tile"><div class="label">${label}</div><div class="value">${value}</div>${note ? `<div class="note">${note}</div>` : ""}</div>`;
}

async function loadDashboard() {
  const o = await api("/api/admin/overview");

  $("kpis").innerHTML =
    kpiTile("Kosten diesen Monat", fmtEur(o.monthCostEur), fmtUsd(o.monthCostUsd) + " · Kurs " + o.eurPerUsd + " €/$") +
    kpiTile("Monatslimit", fmtEur(o.limitEur), "im Formular unten änderbar") +
    kpiTile("KI-Checks gesamt", o.totals.calls.toLocaleString("de-DE"), "") +
    kpiTile("Kosten gesamt", fmtUsd(o.totals.cost_usd), "seit Beginn der Aufzeichnung");

  // Meter: Monatskosten vs. Limit
  const pct = o.limitEur > 0 ? Math.min(100, (o.monthCostEur / o.limitEur) * 100) : 0;
  const meter = $("meter");
  meter.querySelector("i").style.width = pct.toFixed(1) + "%";
  meter.className = "meter" + (pct >= 100 ? " over" : pct >= 80 ? " warn" : "");
  $("meter-label").textContent =
    `${fmtEur(o.monthCostEur)} von ${fmtEur(o.limitEur)} verbraucht (${pct.toFixed(0)} %)` +
    (pct >= 100 ? " – Limit erreicht, KI-Checks sind pausiert." : "");

  $("input-limit").value = o.limitEur;
  $("input-rate").value = o.eurPerUsd;

  // Tage auffüllen (auch Tage ohne Kosten zeigen)
  const byDay = new Map(o.days.map((d) => [d.day, d]));
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const dt = new Date(Date.now() - i * 86400000);
    const key = dt.toISOString().slice(0, 10);
    const row = byDay.get(key);
    days.push({
      label: dt.getDate() + "." + (dt.getMonth() + 1) + ".",
      day: key,
      value: row ? row.costEur : 0,
      calls: row ? row.calls : 0,
    });
  }
  barChart($("chart-days"), days, {
    tooltipFor: (d) => `<b>${d.day}</b><br>${fmtEur(d.value)} <span>· ${d.calls} Checks</span>`,
  });

  const months = o.months.slice().reverse().map((m) => ({
    label: m.month, value: m.costEur, calls: m.calls,
  }));
  barChart($("chart-months"), months, {
    limit: o.limitEur,
    tooltipFor: (d) => `<b>${d.label}</b><br>${fmtEur(d.value)} <span>· ${d.calls} Checks</span>`,
  });

  const esc = (s) => { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; };

  // Wort-Statistik: Erfolgsquote & Zeit bis zum Treffer pro Begriff
  const words = o.words || [];
  $("words-empty").classList.toggle("hidden", words.length > 0);
  $("words-table").classList.toggle("hidden", words.length === 0);
  $("words-table").querySelector("tbody").innerHTML = words.map((w) => `
    <tr>
      <td>${esc(w.word)}</td>
      <td class="num">${w.rounds}</td>
      <td class="num">${w.hits}</td>
      <td><div class="rate-cell">
        <div class="rate-bar"><i style="width:${Math.round(w.rate * 100)}%"></i></div>
        <span class="rate-val">${Math.round(w.rate * 100)} %</span>
      </div></td>
      <td class="num">${w.avgS != null ? w.avgS + " s" : "–"}</td>
      <td class="num">${w.bestS != null ? w.bestS + " s" : "–"}</td>
    </tr>`).join("");

  // Sessions-Tabelle
  $("sessions-table").querySelector("tbody").innerHTML = o.sessions.map((s) => `
    <tr>
      <td>${new Date(s.createdAt).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })}</td>
      <td><span class="badge">${s.mode === "multi" ? "🎉 Multi" : "🖌️ Solo"}</span></td>
      <td>${esc(s.nickname)}</td>
      <td class="num">${s.calls}</td>
      <td class="num">${fmtUsd(s.costUsd)}</td>
      <td class="num">${s.wins}</td>
    </tr>`).join("");

  $("refresh-note").textContent = "Stand: " + new Date().toLocaleTimeString("de-DE");
}

// ---------- Login & Events ----------
async function tryLogin(code) {
  setCode(code);
  await api("/api/admin/verify", { method: "POST" });
}

function showDash() {
  $("login").classList.add("hidden");
  $("dash").classList.remove("hidden");
}

$("admin-login").onclick = async () => {
  const code = $("admin-code").value.trim();
  if (!code) return;
  try {
    await tryLogin(code);
    showDash();
    await loadDashboard();
  } catch (e) {
    $("login-error").textContent = e.message === "auth" ? "Admin-Code falsch." : "Server nicht erreichbar: " + e.message;
    $("login-error").classList.remove("hidden");
  }
};
$("admin-code").addEventListener("keydown", (e) => { if (e.key === "Enter") $("admin-login").click(); });

$("logout").onclick = () => {
  sessionStorage.removeItem("adminCode");
  location.reload();
};

$("settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/admin/settings", {
      method: "POST",
      body: JSON.stringify({
        monthlyLimitEur: parseFloat($("input-limit").value),
        eurPerUsd: parseFloat($("input-rate").value),
      }),
    });
    $("settings-saved").textContent = "Gespeichert ✓";
    setTimeout(() => { $("settings-saved").textContent = ""; }, 2500);
    await loadDashboard();
  } catch {
    $("settings-saved").textContent = "Fehler beim Speichern";
  }
});

// Auto-Login, wenn der Code noch in der Session liegt
(async () => {
  if (!getCode()) return;
  try {
    await api("/api/admin/verify", { method: "POST" });
    showDash();
    await loadDashboard();
  } catch {
    sessionStorage.removeItem("adminCode");
  }
})();
