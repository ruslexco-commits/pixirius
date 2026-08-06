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
    this.zoomHoverGX = null;
    this.zoomHoverGY = null;

    this.undoStack = [];
    this.redoStack = [];
    this.maxUndoSteps = 20;

    this.gx = 0;
    this.gy = 0;
    this.inCanvas = false;
    this.drag = null;

    this.debugStability = false;
    this.debugWind = false;
    this.debugTherm = false;

    this._bind();
  }

  pushUndo() {
    this.undoStack.push(this.sim.snapshot());
    if (this.undoStack.length > this.maxUndoSteps) this.undoStack.shift();
    // Новое действие делает старую "будущую" историю redo недостижимой —
    // как и везде (Word, VS Code и т.д.): если после отмены нарисовать
    // что-то новое, повторить отменённое действие уже нельзя, это была бы
    // альтернативная ветка, которую мы не храним.
    this.redoStack.length = 0;
  }

  undo() {
    const snap = this.undoStack.pop();
    if (!snap) return;
    this.redoStack.push(this.sim.snapshot());
    this.sim.restore(snap);
  }

  redo() {
    const snap = this.redoStack.pop();
    if (!snap) return;
    this.undoStack.push(this.sim.snapshot());
    this.sim.restore(snap);
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

  // Колонист — не заливочный материал, а отдельный агент ("когда он
  // спавнится" — в единственном числе). Текущей кистью (по умолчанию радиус
  // 5, то есть круг ~81 клетки) один клик ставил бы сразу толпу колонистов
  // друг на друге; плотность колониста намеренно равна плотности земли
  // (см. elements.js), поэтому такие колонисты не могут протолкнуться мимо
  // соседей обычной физикой и весь ком намертво стопорится — это и читалось
  // пользователю как "прыгает на месте", "таинственно теряет пиксели" и
  // "не идёт к открытому камню". Поэтому при рисовании именно колониста
  // радиус кисти принудительно 0 — один клик/клетка мазка — один колонист,
  // независимо от текущего размера кисти для остальных материалов.
  brushRadiusFor(writeElementId) {
    return writeElementId === EL.COLONIST ? [0, 0] : [this.brushRX, this.brushRY];
  }

  toGrid(clientX, clientY) {
    const [cx, cy] = this.toCanvasPixels(clientX, clientY);
    return [Math.floor(cx / this.renderer.zoom), Math.floor(cy / this.renderer.zoom)];
  }

  // Экранные -> "внутренние" пиксели канваса (без деления на zoom) — та же
  // система координат, в которой рисуется окно лупы.
  toCanvasPixels(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    return [(clientX - rect.left) * scaleX, (clientY - rect.top) * scaleY];
  }

  // Если курсор сейчас над самим окном лупы — пересчитываем его позицию
  // ВНУТРИ этого окна обратно в мировые координаты, чтобы можно было
  // "листать" показываемую область, наводясь прямо на проекцию лупы.
  // Работает только для ЗАФИКСИРОВАННОЙ лупы: смещение dx,dy обязательно
  // считается от стабильного якоря zoomPinnedGX/GY, а НЕ от того, что лупа
  // показывала в предыдущем кадре (renderer.lastZoomCapture) — та точка сама
  // перезаписывается результатом предыдущего наведения, и складывать
  // смещение поверх неё каждый кадр давало разгоняющуюся обратную связь:
  // при неподвижной мыши над лупой её проекция улетала на dx,dy КАЖДЫЙ
  // кадр, а не считалась заново от одной и той же базовой точки.
  updateLensHover(clientX, clientY) {
    if (!this.zoomPinned) { this.zoomHoverGX = null; this.zoomHoverGY = null; return; }
    const box = this.renderer.lastZoomBoxRect;
    const cap = this.renderer.lastZoomCapture;
    if (!box || !cap) { this.zoomHoverGX = null; this.zoomHoverGY = null; return; }
    const [px, py] = this.toCanvasPixels(clientX, clientY);
    if (px < box.x || px > box.x + box.w || py < box.y || py > box.y + box.h) {
      this.zoomHoverGX = null; this.zoomHoverGY = null; return;
    }
    const capW = cap.capRX * 2 + 1, capH = cap.capRY * 2 + 1;
    const scale = Math.min(box.w / capW, box.h / capH);
    const drawW = capW * scale, drawH = capH * scale;
    const ox = box.x + (box.w - drawW) / 2, oy = box.y + (box.h - drawH) / 2;
    const dx = Math.floor((px - ox) / scale) - cap.capRX;
    const dy = Math.floor((py - oy) / scale) - cap.capRY;
    this.zoomHoverGX = this.zoomPinnedGX + dx;
    this.zoomHoverGY = this.zoomPinnedGY + dy;
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
    } else if (e.code === 'Digit1') {
      if (!e.repeat) this.debugStability = !this.debugStability;
    } else if (e.code === 'Digit2') {
      if (!e.repeat) this.debugWind = !this.debugWind;
    } else if (e.code === 'Digit3') {
      if (!e.repeat) this.debugTherm = !this.debugTherm;
    } else if (e.code === 'KeyZ') {
      if (e.ctrlKey) {
        if (!e.repeat) this.undo();
        e.preventDefault();
      } else {
        // Само нажатие Z снимает фиксацию, если лупа уже зафиксирована —
        // не нужно снова кликать. Держать Z дальше — обычный live-режим,
        // клик по полю зафиксирует её заново на новом месте.
        if (!e.repeat && this.zoomPinned) this.zoomPinned = false;
        this.zoomKeyDown = true;
      }
    } else if (e.code === 'KeyY' && e.ctrlKey) {
      if (!e.repeat) this.redo();
      e.preventDefault();
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
    // gx,gy — реальная клетка под курсором (для отображения/слежения лупы);
    // egx,egy — "рабочая" клетка действия: та же самая, кроме случая, когда
    // курсор наведён на проекцию лупы — тогда действие идёт в ту точку мира,
    // которую лупа в этом месте показывает.
    const [gx, gy] = this.toGrid(e.clientX, e.clientY);
    this.updateLensHover(e.clientX, e.clientY);
    const hovering = this.zoomHoverGX !== null && this.zoomHoverGX !== undefined;
    const egx = hovering ? this.zoomHoverGX : gx;
    const egy = hovering ? this.zoomHoverGY : gy;
    this.gx = gx; this.gy = gy;
    const shift = e.shiftKey, ctrl = e.ctrlKey, alt = e.altKey;

    // ЛКМ с зажатой Z — не рисование, а фиксация/снятие окна лупы на месте
    if (this.zoomKeyDown && e.button === 0 && !shift && !ctrl) {
      if (this.zoomPinned) {
        this.zoomPinned = false;
      } else {
        this.zoomPinned = true;
        this.zoomPinnedGX = egx;
        this.zoomPinnedGY = egy;
      }
      return;
    }

    const elementId = this.getSelectedElement();

    // Инструмент "давление" — особый случай: не рисует материал, а
    // напрямую правит поток воздуха под кистью (ЛКМ усиливает, ПКМ
    // гасит); модификаторы (shift/ctrl/alt) тут не участвуют, и в
    // историю отмены это не попадает — сетка ветра не часть отменяемого
    // состояния (пересчитывается заново каждый кадр).
    if (elementId === TOOL_PRESSURE) {
      const mode = e.button === 0 ? 'pressureInc' : 'pressureDec';
      this.drag = { mode, startX: egx, startY: egy, lastX: egx, lastY: egy, elementId };
      this.sim.applyPressureBrush(egx, egy, this.brushRX, this.brushRY, mode === 'pressureInc' ? 1 : -1);
      return;
    }

    // Инструмент "температура" — тот же принцип, что и у давления (ЛКМ
    // добавляет/греет, ПКМ убавляет/студит), но правит sim.temp.
    if (elementId === TOOL_TEMP) {
      const mode = e.button === 0 ? 'tempInc' : 'tempDec';
      this.drag = { mode, startX: egx, startY: egy, lastX: egx, lastY: egy, elementId };
      this.sim.applyTempBrush(egx, egy, this.brushRX, this.brushRY, mode === 'tempInc' ? 1 : -1);
      return;
    }

    let mode;
    // Shift+Ctrl+ЛКМ и Shift+Alt+ЛКМ — оба дают линию с привязкой к 45°
    if (shift && (ctrl || alt) && e.button === 0) mode = 'lineSnap';
    else if (ctrl && !shift) mode = (e.button === 0) ? 'fill' : 'fillErase';
    else if (shift && e.button === 0) mode = 'line';
    else mode = (e.button === 0) ? 'paint' : 'erase';

    this.drag = { mode, startX: egx, startY: egy, lastX: egx, lastY: egy, elementId };
    this.pushUndo();

    if (mode === 'paint' || mode === 'erase') {
      const writeEl = this.paintElementFor(mode, elementId);
      const [brx, bry] = this.brushRadiusFor(writeEl);
      this.sim.stampBrush(egx, egy, this.brushShape, brx, bry, writeEl, this.onlyEmptyFor(mode, elementId));
    } else if (mode === 'fill') {
      this.sim.floodFill(egx, egy, elementId, false);
    } else if (mode === 'fillErase') {
      this.sim.floodFill(egx, egy, elementId, true);
    }
  }

  onMouseMove(e) {
    const [gx, gy] = this.toGrid(e.clientX, e.clientY);
    this.updateLensHover(e.clientX, e.clientY);
    const hovering = this.zoomHoverGX !== null && this.zoomHoverGX !== undefined;
    const egx = hovering ? this.zoomHoverGX : gx;
    const egy = hovering ? this.zoomHoverGY : gy;
    if (this.drag) {
      const d = this.drag;
      if (d.mode === 'paint' || d.mode === 'erase') {
        const writeEl = this.paintElementFor(d.mode, d.elementId);
        const [brx, bry] = this.brushRadiusFor(writeEl);
        this.sim.stampLine(d.lastX, d.lastY, egx, egy, this.brushShape, brx, bry, writeEl, this.onlyEmptyFor(d.mode, d.elementId));
        d.lastX = egx; d.lastY = egy;
      } else if (d.mode === 'line' || d.mode === 'lineSnap') {
        d.lastX = egx; d.lastY = egy;
      } else if (d.mode === 'pressureInc' || d.mode === 'pressureDec') {
        this.sim.applyPressureBrush(egx, egy, this.brushRX, this.brushRY, d.mode === 'pressureInc' ? 1 : -1);
        d.lastX = egx; d.lastY = egy;
      } else if (d.mode === 'tempInc' || d.mode === 'tempDec') {
        this.sim.applyTempBrush(egx, egy, this.brushRX, this.brushRY, d.mode === 'tempInc' ? 1 : -1);
        d.lastX = egx; d.lastY = egy;
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
      const [brx, bry] = this.brushRadiusFor(d.elementId);
      this.sim.stampLine(d.startX, d.startY, ex, ey, this.brushShape, brx, bry, d.elementId, this.onlyEmptyFor('paint', d.elementId));
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
      const writeEl = this.paintElementFor(d.mode, d.elementId);
      // Колонист — не льющийся материал (см. brushRadiusFor выше): одно
      // нажатие должно поставить РОВНО одного, а не штамповать нового
      // на КАЖДЫЙ кадр, пока кнопка мыши просто зажата (курсор при этом
      // может вообще не двигаться — tickHold всё равно вызывается каждый
      // кадр игрового цикла). Без этой отсечки: первый колонист трогается
      // с места клика почти сразу (падает/копает/блуждает), клетка под
      // курсором освобождается — и tickHold в тот же миг сажает туда
      // СЛЕДУЮЩЕГО, и так далее, пока палец не отпустят. На глаз это и
      // читалось как "прыгает на месте" — на самом деле на одном пятне
      // сменяли друг друга всё новые колонисты, а не один и тот же дёргался.
      if (writeEl === EL.COLONIST) return;
      const [brx, bry] = this.brushRadiusFor(writeEl);
      this.sim.stampBrush(d.lastX, d.lastY, this.brushShape, brx, bry, writeEl, this.onlyEmptyFor(d.mode, d.elementId));
    } else if (d.mode === 'pressureInc' || d.mode === 'pressureDec') {
      this.sim.applyPressureBrush(d.lastX, d.lastY, this.brushRX, this.brushRY, d.mode === 'pressureInc' ? 1 : -1);
    } else if (d.mode === 'tempInc' || d.mode === 'tempDec') {
      this.sim.applyTempBrush(d.lastX, d.lastY, this.brushRX, this.brushRY, d.mode === 'tempInc' ? 1 : -1);
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
      zoomHoverGX: this.zoomHoverGX, zoomHoverGY: this.zoomHoverGY,
      debugStability: this.debugStability,
      debugWind: this.debugWind,
      debugTherm: this.debugTherm,
    };
  }
}
