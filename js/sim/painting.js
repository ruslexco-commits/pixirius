'use strict';

// Рисование игроком: клетка, кисть, линия, заливка.
//
// Методы класса Sim, вынесенные в отдельный файл: класс ниже — только
// контейнер, extendSim переносит его методы в Sim.prototype (см. core.js).

class SimPainting {
  setCell(x, y, elementId, onlyEmpty) {
    if (!this.inBounds(x, y)) return;
    const i = this.idx(x, y);
    // Балка живёт во втором слое и кладётся независимо от того, что в
    // клетке: она ничему не мешает и ничего не вытесняет.
    if (elementId === EL.BEAM) {
      if (onlyEmpty && this.beam[i]) return;
      this.placeBeam(i);
      return;
    }
    if (onlyEmpty && (this.type[i] !== EL.EMPTY || this.beam[i])) return;
    if (elementId === EL.EMPTY) { this.clearCell(i); this.beam[i] = 0; }
    else this.spawn(i, elementId);
  }

  // onlyEmpty: не трогать уже занятые клетки (обычная кисть не должна
  // заменять то, что уже стоит на поле — только заливка делает замену осознанно).
  stampBrush(cx, cy, shape, rx, ry, elementId, onlyEmpty) {
    const x0 = Math.max(0, Math.floor(cx - rx)), x1 = Math.min(this.w - 1, Math.ceil(cx + rx));
    const y0 = Math.max(0, Math.floor(cy - ry)), y1 = Math.min(this.h - 1, Math.ceil(cy + ry));
    const rx2 = Math.max(rx, 0.5), ry2 = Math.max(ry, 0.5);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (shape === 'circle') {
          const dx = (x - cx) / rx2, dy = (y - cy) / ry2;
          if (dx * dx + dy * dy > 1) continue;
        }
        this.setCell(x, y, elementId, onlyEmpty);
      }
    }
  }

  stampLine(x0, y0, x1, y1, shape, rx, ry, elementId, onlyEmpty) {
    let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    let x = x0, y = y0;
    let guard = 0;
    const guardMax = (this.w + this.h) * 4 + 16;
    while (guard++ < guardMax) {
      this.stampBrush(x, y, shape, rx, ry, elementId, onlyEmpty);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
    }
  }

  floodFill(x0, y0, elementId, erase) {
    if (!this.inBounds(x0, y0)) return;
    const startI = this.idx(x0, y0);
    const target = this.type[startI];
    const replacement = erase ? EL.EMPTY : elementId;
    if (target === replacement) return;
    const w = this.w, h = this.h;
    const stack = [startI];
    const visited = new Uint8Array(w * h);
    visited[startI] = 1;
    while (stack.length) {
      const i = stack.pop();
      if (this.type[i] !== target) continue;
      if (replacement === EL.EMPTY) this.clearCell(i); else this.spawn(i, replacement);
      const x = i % w, y = (i / w) | 0;
      if (x > 0) { const ni = i - 1; if (!visited[ni]) { visited[ni] = 1; if (this.type[ni] === target) stack.push(ni); } }
      if (x < w - 1) { const ni = i + 1; if (!visited[ni]) { visited[ni] = 1; if (this.type[ni] === target) stack.push(ni); } }
      if (y > 0) { const ni = i - w; if (!visited[ni]) { visited[ni] = 1; if (this.type[ni] === target) stack.push(ni); } }
      if (y < h - 1) { const ni = i + w; if (!visited[ni]) { visited[ni] = 1; if (this.type[ni] === target) stack.push(ni); } }
    }
  }
}

extendSim(SimPainting);
