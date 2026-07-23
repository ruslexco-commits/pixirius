'use strict';

function clamp8(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

class Renderer {
  constructor(sim, canvas, zoom) {
    this.sim = sim;
    this.zoom = zoom;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = false;

    this.off = document.createElement('canvas');
    this.off.width = sim.w;
    this.off.height = sim.h;
    this.offCtx = this.off.getContext('2d');
    this.imageData = this.offCtx.createImageData(sim.w, sim.h);

    this.zoomBoxCorner = 'br';
    this.zoomBoxSize = 220;
    this.zoomBoxMargin = 10;
  }

  cellColor(i) {
    const sim = this.sim;
    const id = sim.type[i];
    if (id === EL.EMPTY) return [14, 14, 18];
    const el = ELEMENTS[id];
    const s = sim.shade[i];
    let r = clamp8(el.color[0] + s), g = clamp8(el.color[1] + s), b = clamp8(el.color[2] + s);
    if (id === EL.FIRE) {
      const flick = (sim.life[i] * 37 + i * 13) % 46;
      r = clamp8(r + flick);
      g = clamp8(g + (flick >> 1));
    }
    return [r, g, b];
  }

  buildImage() {
    const sim = this.sim;
    const data = this.imageData.data;
    const n = sim.w * sim.h;
    for (let i = 0; i < n; i++) {
      const [r, g, b] = this.cellColor(i);
      const o = i * 4;
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
    }
  }

  drawFrame() {
    this.buildImage();
    this.offCtx.putImageData(this.imageData, 0, 0);
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.off, 0, 0, this.sim.w, this.sim.h, 0, 0, this.canvas.width, this.canvas.height);
  }

  drawBrushOutline(gx, gy, shape, rx, ry) {
    const ctx = this.ctx, z = this.zoom;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1;
    const cx = (gx + 0.5) * z, cy = (gy + 0.5) * z;
    if (shape === 'circle') {
      ctx.beginPath();
      ctx.ellipse(cx, cy, (rx + 0.5) * z, (ry + 0.5) * z, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      const w = (rx * 2 + 1) * z, h = (ry * 2 + 1) * z;
      ctx.strokeRect(cx - w / 2, cy - h / 2, w, h);
    }
    ctx.restore();
  }

  drawLinePreview(gx0, gy0, gx1, gy1) {
    const ctx = this.ctx, z = this.zoom;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo((gx0 + 0.5) * z, (gy0 + 0.5) * z);
    ctx.lineTo((gx1 + 0.5) * z, (gy1 + 0.5) * z);
    ctx.stroke();
    ctx.restore();
  }

  computeZoomBoxRect() {
    const cw = this.canvas.width, ch = this.canvas.height;
    const m = this.zoomBoxMargin, s = this.zoomBoxSize;
    switch (this.zoomBoxCorner) {
      case 'br': return { x: cw - s - m, y: ch - s - m, w: s, h: s };
      case 'bl': return { x: m, y: ch - s - m, w: s, h: s };
      case 'tr': return { x: cw - s - m, y: m, w: s, h: s };
      default: return { x: m, y: m, w: s, h: s };
    }
  }

  static rectsOverlap(a, b) {
    return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
  }

  drawZoomLens(gx, gy, capRX, capRY) {
    const z = this.zoom;
    const srcRect = {
      x: (gx - capRX) * z, y: (gy - capRY) * z,
      w: (capRX * 2 + 1) * z, h: (capRY * 2 + 1) * z,
    };
    let box = this.computeZoomBoxRect();
    if (Renderer.rectsOverlap(srcRect, box)) {
      const cx = (gx + 0.5) * z, cy = (gy + 0.5) * z;
      const corners = ['tl', 'tr', 'bl', 'br'];
      let best = this.zoomBoxCorner, bestD = -1;
      for (const c of corners) {
        this.zoomBoxCorner = c;
        const r = this.computeZoomBoxRect();
        const rcx = r.x + r.w / 2, rcy = r.y + r.h / 2;
        const d = (rcx - cx) * (rcx - cx) + (rcy - cy) * (rcy - cy);
        if (d > bestD) { bestD = d; best = c; }
      }
      this.zoomBoxCorner = best;
      box = this.computeZoomBoxRect();
    }

    const ctx = this.ctx;
    const capW = capRX * 2 + 1, capH = capRY * 2 + 1;
    const scale = Math.min(box.w / capW, box.h / capH);
    const drawW = capW * scale, drawH = capH * scale;
    const ox = box.x + (box.w - drawW) / 2, oy = box.y + (box.h - drawH) / 2;
    const sim = this.sim;

    ctx.save();
    ctx.fillStyle = '#0a0a0d';
    ctx.fillRect(box.x, box.y, box.w, box.h);

    for (let dy = -capRY; dy <= capRY; dy++) {
      for (let dx = -capRX; dx <= capRX; dx++) {
        const sx = gx + dx, sy = gy + dy;
        let r, g, b;
        if (sim.inBounds(sx, sy)) {
          [r, g, b] = this.cellColor(sim.idx(sx, sy));
        } else { r = 0; g = 0; b = 0; }
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(ox + (dx + capRX) * scale, oy + (dy + capRY) * scale, Math.ceil(scale), Math.ceil(scale));
      }
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 2;
    ctx.strokeRect(box.x + 1, box.y + 1, box.w - 2, box.h - 2);
    ctx.strokeStyle = 'rgba(255,60,60,0.95)';
    ctx.lineWidth = 1;
    ctx.strokeRect(ox + capRX * scale, oy + capRY * scale, Math.ceil(scale), Math.ceil(scale));
    ctx.restore();
  }

  render(cursor) {
    this.drawFrame();
    if (cursor.linePreview) {
      const lp = cursor.linePreview;
      this.drawLinePreview(lp.x0, lp.y0, lp.x1, lp.y1);
      this.drawBrushOutline(lp.x1, lp.y1, cursor.brushShape, cursor.brushRX, cursor.brushRY);
    } else if (cursor.showBrush) {
      this.drawBrushOutline(cursor.gx, cursor.gy, cursor.brushShape, cursor.brushRX, cursor.brushRY);
    }
    if (cursor.zoomActive) {
      this.drawZoomLens(cursor.gx, cursor.gy, cursor.zoomRX, cursor.zoomRY);
    }
  }
}
