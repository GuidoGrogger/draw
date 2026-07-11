// Freihand-Zeichencanvas mit Stroke-Aufzeichnung (für Replay & Änderungs-Erkennung).
// Bewusst kein Bild-Import und kein Text-Tool — nur Pointer-Strokes.

export class DrawCanvas {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.strokes = [];        // [{color, size, points: [[x,y],...]}]
    this.current = null;
    this.color = "#111111";
    this.size = 5;
    this.eraser = false;
    this.revision = 0;        // zählt hoch bei jeder Änderung
    this.enabled = true;

    this.clear();

    canvas.addEventListener("pointerdown", (e) => this._down(e));
    canvas.addEventListener("pointermove", (e) => this._move(e));
    window.addEventListener("pointerup", () => this._up());
    // Vom System abgebrochene Geste (z.B. Handy-Wischgeste): Strich sauber beenden.
    window.addEventListener("pointercancel", () => this._up());
    // Kein pointerleave -> _up: setPointerCapture(e.pointerId) hält den Zeiger, wir
    // bekommen pointerup/-move zuverlässig aufs window. Auf Touch feuert Safari sonst
    // direkt nach setPointerCapture ein pointerleave und der Strich wäre nur ein Punkt.
  }

  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return [
      Math.round(((e.clientX - r.left) / r.width) * this.canvas.width),
      Math.round(((e.clientY - r.top) / r.height) * this.canvas.height),
    ];
  }

  _down(e) {
    if (!this.enabled) return;
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    this.current = {
      color: this.eraser ? "#ffffff" : this.color,
      size: this.eraser ? this.size * 4 : this.size,
      points: [this._pos(e)],
    };
  }

  _move(e) {
    if (!this.current) return;
    e.preventDefault();
    const p = this._pos(e);
    const last = this.current.points[this.current.points.length - 1];
    if (Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]) < 2) return;
    this.current.points.push(p);
    this._drawSegment(this.current, this.current.points.length - 2);
  }

  _up() {
    if (!this.current) return;
    if (this.current.points.length === 1) {
      // Punkt: als Mini-Strich zeichnen
      this.current.points.push([this.current.points[0][0] + 1, this.current.points[0][1] + 1]);
      this._drawSegment(this.current, 0);
    }
    this.strokes.push(this.current);
    this.current = null;
    this.revision++;
  }

  _drawSegment(stroke, fromIdx) {
    const ctx = this.ctx;
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.size;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    const pts = stroke.points;
    ctx.moveTo(pts[Math.max(0, fromIdx)][0], pts[Math.max(0, fromIdx)][1]);
    for (let i = Math.max(0, fromIdx) + 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
  }

  redraw() {
    const ctx = this.ctx;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    for (const s of this.strokes) this._drawSegment(s, 0);
  }

  undo() {
    if (!this.strokes.length) return;
    this.strokes.pop();
    this.redraw();
    this.revision++;
  }

  clear() {
    this.strokes = [];
    this.current = null;
    this.ctx.fillStyle = "#ffffff";
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.revision++;
  }

  isEmpty() {
    return this.strokes.length === 0;
  }

  // Verkleinertes JPEG hält die Token-Kosten pro KI-Check klein.
  toDataUrl(maxW = 512) {
    const scale = Math.min(1, maxW / this.canvas.width);
    const off = document.createElement("canvas");
    off.width = Math.round(this.canvas.width * scale);
    off.height = Math.round(this.canvas.height * scale);
    const octx = off.getContext("2d");
    octx.fillStyle = "#ffffff";
    octx.fillRect(0, 0, off.width, off.height);
    octx.drawImage(this.canvas, 0, 0, off.width, off.height);
    return off.toDataURL("image/jpeg", 0.8);
  }

  exportStrokes() {
    return this.strokes;
  }
}

// Spielt aufgezeichnete Strokes animiert auf einem (kleineren) Canvas ab.
export function replayStrokes(canvas, strokes, srcW = 800, srcH = 600) {
  const ctx = canvas.getContext("2d");
  const sx = canvas.width / srcW;
  const sy = canvas.height / srcH;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  let si = 0, pi = 1;
  const step = () => {
    let budget = 6; // Punkte pro Frame
    while (budget-- > 0 && si < strokes.length) {
      const s = strokes[si];
      if (pi >= s.points.length) { si++; pi = 1; continue; }
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.size * sx;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(s.points[pi - 1][0] * sx, s.points[pi - 1][1] * sy);
      ctx.lineTo(s.points[pi][0] * sx, s.points[pi][1] * sy);
      ctx.stroke();
      pi++;
    }
    if (si < strokes.length) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
