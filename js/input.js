'use strict';

function clampInt(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function snapAngle(x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 0.5) return [x1, y1];
  const step = Math.PI / 4;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  return [Math.round(x0 + Math.cos(angle) * dist), Math.round(y0 + Math.sin(angle) * dist)];
}

class InputController {
  constructor(sim, renderer, canvas, getSelectedElement) {
    this.sim = sim;
    this.renderer = renderer;
    this.canvas = canvas;
    this.getSelectedElement = getSelectedElement;

    this.brushShape = 'circle';
    this.brushRX = 5;
    this.brushRY = 5;
    this.minR = 0;
    this.maxR = 60;

    this.zoomKeyDown = false;
    this.zoomRX = 8;
    this.zoomRY = 8;
    this.maxZoomR = 100;
    this.zoomPinned = false;
    this.zoomPinnedGX = 0;
    this.zoomPinnedGY = 0;

    this.undoStack = [];
    this.maxUndoSteps = 20;

    this.gx = 0;
    this.gy = 0;
    this.inCanvas = false;
    this.drag = null;

    this._bind();
  }

  pushUndo() {
    this.undoStack.push(this.sim.snapshot());
    if (this.undoStack.length > this.maxUndoSteps) this.undoStack.shift();
  }

  undo() {
    const snap = this.undoStack.pop();
    if (snap) this.sim.restore(snap);
  }

  // Элемент, который реально запишется на клетку (стирание всегда пишет "пусто").
  paintElementFor(mode, elementId) {
    return mode === 'erase' ? EL.EMPTY : elementId;
  }

  // Обычная кисть не должна затирать уже занятые клетки — только когда мы
  // реально что-то ставим (не стираем и не выбран ластик).
  onlyEmptyFor(mode, elementId) {
    return mode === 'paint' && elementId !== EL.EMPTY;
  }

  toGrid(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    const cx = (clientX - rect.left) * scaleX;
    const cy = (clientY - rect.top) * scaleY;
    return [Math.floor(cx / this.renderer.zoom), Math.floor(cy / this.renderer.zoom)];
  }

  _bind() {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    c.addEventListener('mousedown', (e) => this.onMouseDown(e));
    window.addEventListener('mousemove', (e) => this.onMouseMove(e));
    window.addEventListener('mouseup', (e) => this.onMouseUp(e));
    c.addEventListener('mouseenter', () => { this.inCanvas = true; });
    c.addEventListener('mouseleave', () => { this.inCanvas = false; });
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.onKeyUp(e));
    window.addEventListener('blur', () => { this.zoomKeyDown = false; this.drag = null; });
  }

  onKeyDown(e) {
    if (e.code === 'Tab') {
      if (!e.repeat) this.brushShape = this.brushShape === 'circle' ? 'square' : 'circle';
      e.preventDefault();
    } else if (e.code === 'KeyZ') {
      if (e.ctrlKey) {
        if (!e.repeat) this.undo();
        e.preventDefault();
      } else {
        this.zoomKeyDown = true;
      }
    }
  }

  onKeyUp(e) {
    if (e.code === 'KeyZ') this.zoomKeyDown = false;
  }

  onWheel(e) {
    if (!this.inCanvas) return;
    e.preventDefault();
    const dir = e.deltaY > 0 ? -1 : 1;
    if (this.zoomKeyDown) {
      if (e.ctrlKey) this.zoomRX = clampInt(this.zoomRX + dir, 1, this.maxZoomR);
      else if (e.shiftKey) this.zoomRY = clampInt(this.zoomRY + dir, 1, this.maxZoomR);
      else {
        this.zoomRX = clampInt(this.zoomRX + dir, 1, this.maxZoomR);
        this.zoomRY = clampInt(this.zoomRY + dir, 1, this.maxZoomR);
      }
    } else {
      if (e.ctrlKey) this.brushRX = clampInt(this.brushRX + dir, this.minR, this.maxR);
      else if (e.shiftKey) this.brushRY = clampInt(this.brushRY + dir, this.minR, this.maxR);
      else {
        this.brushRX = clampInt(this.brushRX + dir, this.minR, this.maxR);
        this.brushRY = clampInt(this.brushRY + dir, this.minR, this.maxR);
      }
    }
  }

  onMouseDown(e) {
    if (e.button !== 0 && e.button !== 2) return;
    const [gx, gy] = this.toGrid(e.clientX, e.clientY);
    this.gx = gx; this.gy = gy;
    const shift = e.shiftKey, ctrl = e.ctrlKey, alt = e.altKey;

    // ЛКМ с зажатой Z — не рисование, а фиксация/снятие окна лупы на месте
    if (this.zoomKeyDown && e.button === 0 && !shift && !ctrl) {
      if (this.zoomPinned) {
        this.zoomPinned = false;
      } else {
        this.zoomPinned = true;
        this.zoomPinnedGX = gx;
        this.zoomPinnedGY = gy;
      }
      return;
    }

    const elementId = this.getSelectedElement();
    let mode;
    // Shift+Ctrl+ЛКМ и Shift+Alt+ЛКМ — оба дают линию с привязкой к 45°
    if (shift && (ctrl || alt) && e.button === 0) mode = 'lineSnap';
    else if (ctrl && !shift) mode = (e.button === 0) ? 'fill' : 'fillErase';
    else if (shift && e.button === 0) mode = 'line';
    else mode = (e.button === 0) ? 'paint' : 'erase';

    this.drag = { mode, startX: gx, startY: gy, lastX: gx, lastY: gy, elementId };
    this.pushUndo();

    if (mode === 'paint' || mode === 'erase') {
      this.sim.stampBrush(gx, gy, this.brushShape, this.brushRX, this.brushRY, this.paintElementFor(mode, elementId), this.onlyEmptyFor(mode, elementId));
    } else if (mode === 'fill') {
      this.sim.floodFill(gx, gy, elementId, false);
    } else if (mode === 'fillErase') {
      this.sim.floodFill(gx, gy, elementId, true);
    }
  }

  onMouseMove(e) {
    const [gx, gy] = this.toGrid(e.clientX, e.clientY);
    if (this.drag) {
      const d = this.drag;
      if (d.mode === 'paint' || d.mode === 'erase') {
        this.sim.stampLine(d.lastX, d.lastY, gx, gy, this.brushShape, this.brushRX, this.brushRY, this.paintElementFor(d.mode, d.elementId), this.onlyEmptyFor(d.mode, d.elementId));
        d.lastX = gx; d.lastY = gy;
      } else if (d.mode === 'line' || d.mode === 'lineSnap') {
        d.lastX = gx; d.lastY = gy;
      }
    }
    this.gx = gx; this.gy = gy;
  }

  onMouseUp() {
    if (!this.drag) return;
    const d = this.drag;
    if (d.mode === 'line' || d.mode === 'lineSnap') {
      let ex = d.lastX, ey = d.lastY;
      if (d.mode === 'lineSnap') [ex, ey] = snapAngle(d.startX, d.startY, ex, ey);
      this.sim.stampLine(d.startX, d.startY, ex, ey, this.brushShape, this.brushRX, this.brushRY, d.elementId, this.onlyEmptyFor('paint', d.elementId));
    }
    this.drag = null;
  }

  // Вызывается каждый кадр из игрового цикла: если кисть зажата и стоит на
  // месте, она всё равно должна продолжать действовать (например, стирать
  // всё, что упало под неё под гравитацией), а не только при движении мыши.
  tickHold() {
    if (!this.drag) return;
    const d = this.drag;
    if (d.mode === 'paint' || d.mode === 'erase') {
      this.sim.stampBrush(d.lastX, d.lastY, this.brushShape, this.brushRX, this.brushRY, this.paintElementFor(d.mode, d.elementId), this.onlyEmptyFor(d.mode, d.elementId));
    }
  }

  getCursorState() {
    const inLine = this.drag && (this.drag.mode === 'line' || this.drag.mode === 'lineSnap');
    let linePreview = null;
    if (inLine) {
      const d = this.drag;
      let ex = d.lastX, ey = d.lastY;
      if (d.mode === 'lineSnap') [ex, ey] = snapAngle(d.startX, d.startY, ex, ey);
      linePreview = { x0: d.startX, y0: d.startY, x1: ex, y1: ey };
    }
    return {
      gx: this.gx, gy: this.gy,
      showBrush: this.inCanvas,
      brushShape: this.brushShape, brushRX: this.brushRX, brushRY: this.brushRY,
      linePreview,
      zoomActive: this.zoomKeyDown && this.inCanvas,
      zoomRX: this.zoomRX, zoomRY: this.zoomRY,
      zoomPinned: this.zoomPinned,
      zoomPinnedGX: this.zoomPinnedGX, zoomPinnedGY: this.zoomPinnedGY,
    };
  }
}
