'use strict';

function clampInt(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// Режимы линии: тянется с зажатым Shift (с Ctrl или Alt — с привязкой к
// 45°), кладётся по отпусканию кнопки. ЛКМ рисует, ПКМ стирает (просьба:
// "комбинация Shift плюс Ctrl будет работать и с ПКМ, то есть удалением").
function isLineMode(mode) { return mode === 'line' || mode === 'lineSnap' || mode === 'lineErase' || mode === 'lineSnapErase'; }
function isSnapLine(mode) { return mode === 'lineSnap' || mode === 'lineSnapErase'; }
function isEraseLine(mode) { return mode === 'lineErase' || mode === 'lineSnapErase'; }

function snapAngle(x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 0.5) return [x1, y1];
  const step = Math.PI / 4;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  return [Math.round(x0 + Math.cos(angle) * dist), Math.round(y0 + Math.sin(angle) * dist)];
}

// Сенсорное управление (просьба пользователя: "худо-бедно, но управление с
// сенсорного устройства"):
//   один палец — как зажатая ЛКМ (рисует, тянет, щёлкает инструментом);
//   два пальца сводят/разводят по вертикали — кисть меньше/больше;
//   по горизонтали — лупа: появляется в точке между пальцами (как Z и
//     щелчок) и меняет увеличение (развели — крупнее); пока она открыта
//     пальцами, на поле её яркая метка (LENS_HANDLE_PX): метку тянут одним
//     пальцем — лупа едет, коснулись метки и отпустили — лупа закрылась;
//   два пальца двигаются вместе — ровная линия с привязкой к 45°
//     (как Shift+Ctrl), кладётся, когда пальцы отпустили;
//   двойное касание двумя пальцами — круглая/квадратная кисть (как Tab).
// Первый палец почти всегда касается чуть раньше второго и успевает
// мазнуть — всё, что он сделал, откатывается, как только касается второй
// (просьба: "то, что натворил двойным кликом, должно сразу отменяться").
// Кнопки — обычным касанием: сенсорные события ловит только поле.
// Сдвиг (экранных пикселей), с которого два пальца — жест, а не касание.
const TOUCH_MOVE_PX = 18;
// Два пальца коснулись и отпустили не дольше этого (мс) — касание.
const TOUCH_TAP_MS = 350;
// Между двумя касаниями двумя пальцами не дольше этого (мс) — двойное.
const TOUCH_DOUBLE_MS = 500;
// Метка лупы, открытой пальцами: радиус кружка и радиус, в котором касание
// берёт метку (экранных пикселей — палец толще курсора).
const LENS_HANDLE_PX = 14;
const LENS_HANDLE_HIT_PX = 36;

// Касание как событие мыши (onMouseDown/Move ждут именно его поля).
function touchAsMouse(t) {
  return { button: 0, clientX: t.clientX, clientY: t.clientY, shiftKey: false, ctrlKey: false, altKey: false };
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

    // (gx, gy, clientX, clientY) => void — щелчок лупой по клетке. Задаёт
    // main.js: что показать, решает интерфейс, а не ввод.
    this.onInspect = null;

    // Копирование и вставка (просьба пользователя). Ctrl+C / Ctrl+X —
    // clipMode 'copy' / 'cut': следующая протяжка ЛКМ выделяет
    // прямоугольник (selDrag), по отпусканию он копируется в clipboard (а
    // при вырезании ещё и стирается). Ctrl+V — clipMode 'paste': у курсора
    // полупрозрачная проекция копии, ЛКМ вставляет. ПКМ или Esc — отмена.
    this.clipMode = null;
    this.clipboard = null;
    this.selDrag = null;

    // false — рисование и клавиши создания выключены: идёт игра за
    // протагониста (js/play.js), меню создания в ней недоступно.
    this.enabled = true;

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
  // (см. data/elements.js), поэтому такие колонисты не могут протолкнуться мимо
  // соседей обычной физикой и весь ком намертво стопорится — это и читалось
  // пользователю как "прыгает на месте", "таинственно теряет пиксели" и
  // "не идёт к открытому камню". Поэтому при рисовании именно колониста
  // радиус кисти принудительно 0 — один клик/клетка мазка — один колонист,
  // независимо от текущего размера кисти для остальных материалов.
  brushRadiusFor(writeElementId) {
    // Человек и колонист — не заливочный материал, а отдельные существа:
    // кисть для них всегда в одну клетку, каким бы ни был её размер.
    // Протагонист — так же, одна клетка в центре кисти (просьба: "спавнится
    // всегда в центре спавн-поля").
    return (writeElementId === EL.COLONIST || writeElementId === EL.HUMAN || writeElementId === EL.PROTAGONIST) ? [0, 0] : [this.brushRX, this.brushRY];
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
    // Сенсорные — только на поле и не пассивные: preventDefault не даёт
    // браузеру прокручивать и масштабировать страницу пальцами и слать
    // вдогонку поддельные события мыши.
    this.touch = null;
    this.lastTwoTap = 0;
    // Лупа открыта жестом (а не клавишей Z) — у неё метка на поле.
    this.lensByTouch = false;
    c.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });
    c.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
    c.addEventListener('touchend', (e) => this.onTouchEnd(e, false), { passive: false });
    c.addEventListener('touchcancel', (e) => this.onTouchEnd(e, true), { passive: false });
  }

  // ---- сенсорный ввод (см. TOUCH_* в начале файла) ----

  // Касание из списка по номеру пальца.
  touchById(list, id) {
    for (let k = 0; k < list.length; k++) if (list[k].identifier === id) return list[k];
    return null;
  }

  onTouchStart(e) {
    if (!this.enabled) return;
    e.preventDefault();
    const ts = e.touches;
    this.inCanvas = true;
    if (!this.touch && ts.length === 1 && this.hitLensHandle(ts[0])) {
      // Палец на метке лупы — тянет лупу, а не рисует.
      const [gx, gy] = this.toGrid(ts[0].clientX, ts[0].clientY);
      this.touch = { mode: 'lens', id: ts[0].identifier, x0: ts[0].clientX, y0: ts[0].clientY, moved: false,
        gx0: gx, gy0: gy, px0: this.zoomPinnedGX, py0: this.zoomPinnedGY };
      return;
    }
    if (!this.touch && ts.length === 1) {
      // Один палец — ЛКМ. Глубина истории — чтобы было куда откатить, если
      // окажется, что это начало жеста двумя пальцами.
      this.touch = { mode: 'one', id: ts[0].identifier, undoDepth: this.undoStack.length };
      this.onMouseDown(touchAsMouse(ts[0]));
      return;
    }
    if (ts.length < 2 || (this.touch && this.touch.mode !== 'one')) return;
    if (this.touch) this.revertTouch(this.touch.undoDepth);
    const a = ts[0], b = ts[1];
    const mx = (a.clientX + b.clientX) / 2, my = (a.clientY + b.clientY) / 2;
    this.touch = {
      mode: 'two', a: a.identifier, b: b.identifier, kind: null, at: performance.now(),
      d0: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), mx0: mx, my0: my,
      sx0: Math.abs(a.clientX - b.clientX), sy0: Math.abs(a.clientY - b.clientY),
      rx0: this.brushRX, ry0: this.brushRY, zx0: this.zoomRX, zy0: this.zoomRY,
    };
    [this.gx, this.gy] = this.toGrid(mx, my);
  }

  // Откатить то, что успел сделать первый палец до второго: мазок, линию,
  // вставку (всё, что положило шаг в историю после undoDepth).
  // Касание попало в метку лупы, открытой пальцами (см. LENS_HANDLE_*).
  hitLensHandle(t) {
    if (!this.lensByTouch || !this.zoomPinned) return false;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0) return false;
    const css = rect.width / this.canvas.width, z = this.renderer.zoom;
    const cx = rect.left + (this.zoomPinnedGX + 0.5) * z * css, cy = rect.top + (this.zoomPinnedGY + 0.5) * z * css;
    return Math.hypot(t.clientX - cx, t.clientY - cy) <= LENS_HANDLE_HIT_PX;
  }

  revertTouch(undoDepth) {
    this.drag = null;
    this.selDrag = null;
    if (this.undoStack.length > undoDepth) {
      const snap = this.undoStack[undoDepth];
      this.undoStack.length = undoDepth;
      this.sim.restore(snap);
    }
  }

  onTouchMove(e) {
    if (!this.enabled || !this.touch) return;
    e.preventDefault();
    const t = this.touch;
    if (t.mode === 'one') {
      const p = this.touchById(e.touches, t.id);
      if (p) this.onMouseMove(touchAsMouse(p));
      return;
    }
    if (t.mode === 'lens') {
      const p = this.touchById(e.touches, t.id);
      if (!p) return;
      if (Math.hypot(p.clientX - t.x0, p.clientY - t.y0) > TOUCH_MOVE_PX) t.moved = true;
      if (!t.moved) return;
      const [gx, gy] = this.toGrid(p.clientX, p.clientY);
      this.zoomPinnedGX = clampInt(t.px0 + gx - t.gx0, 0, this.sim.w - 1);
      this.zoomPinnedGY = clampInt(t.py0 + gy - t.gy0, 0, this.sim.h - 1);
      return;
    }
    if (t.mode !== 'two') return;
    const a = this.touchById(e.touches, t.a), b = this.touchById(e.touches, t.b);
    if (!a || !b) return;
    const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const mx = (a.clientX + b.clientX) / 2, my = (a.clientY + b.clientY) / 2;
    const [gx, gy] = this.toGrid(mx, my);
    this.gx = gx; this.gy = gy;
    if (!t.kind) {
      const pinch = Math.abs(d - t.d0), pan = Math.hypot(mx - t.mx0, my - t.my0);
      if (pinch > TOUCH_MOVE_PX && pinch >= pan) {
        // Пальцы разошлись больше по горизонтали — лупа, по вертикали — кисть.
        const sx = Math.abs(a.clientX - b.clientX), sy = Math.abs(a.clientY - b.clientY);
        if (Math.abs(sx - t.sx0) > Math.abs(sy - t.sy0)) {
          t.kind = 'lens';
          if (!this.zoomPinned) {
            [this.zoomPinnedGX, this.zoomPinnedGY] = this.toGrid(t.mx0, t.my0);
            this.zoomPinned = true;
          }
          this.lensByTouch = true;
        } else t.kind = 'pinch';
      }
      else if (pan > TOUCH_MOVE_PX) {
        t.kind = 'line';
        // Линия — только материалом: у инструментов (лупа, давление,
        // температура...) линии нет.
        const elementId = this.getSelectedElement();
        if (typeof elementId !== 'number') { t.kind = 'none'; return; }
        const [sx, sy] = this.toGrid(t.mx0, t.my0);
        this.pushUndo();
        if (elementId === EL.BEAM) this.sim.pickBeamMaterial(sx, sy);
        this.drag = { mode: 'lineSnap', startX: sx, startY: sy, lastX: gx, lastY: gy, elementId };
      }
    }
    if (t.kind === 'pinch') {
      // От размера кисти в начале жеста — во столько раз, во сколько
      // изменилось расстояние между пальцами (+1: кисть 0 тоже растёт).
      const k = d / Math.max(1, t.d0);
      this.brushRX = clampInt(Math.round((t.rx0 + 1) * k) - 1, this.minR, this.maxR);
      this.brushRY = clampInt(Math.round((t.ry0 + 1) * k) - 1, this.minR, this.maxR);
    } else if (t.kind === 'lens') {
      // Увеличение — обратно расстоянию между пальцами по горизонтали:
      // развели — лупа берёт область меньше, то есть показывает крупнее.
      const k = Math.max(1, Math.abs(a.clientX - b.clientX)) / Math.max(1, t.sx0);
      this.zoomRX = clampInt(Math.round((t.zx0 + 1) / k) - 1, 1, this.maxZoomR);
      this.zoomRY = clampInt(Math.round((t.zy0 + 1) / k) - 1, 1, this.maxZoomR);
    } else if (t.kind === 'line' && this.drag) {
      this.drag.lastX = gx; this.drag.lastY = gy;
    }
  }

  onTouchEnd(e, cancel) {
    if (!this.touch) return;
    e.preventDefault();
    const t = this.touch;
    if (t.mode === 'one') {
      if (!this.touchById(e.touches, t.id)) {
        this.onMouseUp();
        this.touch = null;
        this.inCanvas = false;
      }
      return;
    }
    if (t.mode === 'lens') {
      if (this.touchById(e.touches, t.id)) return;
      // Коснулись метки и отпустили, не двигая, — лупа закрывается.
      if (!t.moved && !cancel) { this.zoomPinned = false; this.lensByTouch = false; }
      this.touch = e.touches.length ? { mode: 'done' } : null;
      if (!e.touches.length) this.inCanvas = false;
      return;
    }
    if (t.mode === 'two') {
      // Жест кончается, как только поднят любой из двух пальцев; оставшийся
      // палец уже ничего не рисует (mode 'done' — до последнего пальца).
      if (cancel) { this.drag = null; }
      else if (t.kind === 'line') this.onMouseUp();
      else if (!t.kind && performance.now() - t.at <= TOUCH_TAP_MS) {
        const now = performance.now();
        if (now - this.lastTwoTap <= TOUCH_DOUBLE_MS) {
          this.brushShape = this.brushShape === 'circle' ? 'square' : 'circle';
          this.lastTwoTap = 0;
        } else this.lastTwoTap = now;
      }
      this.drag = null;
      this.touch = { mode: 'done' };
    }
    if (e.touches.length === 0) { this.touch = null; this.inCanvas = false; }
  }

  onKeyDown(e) {
    if (!this.enabled) return;
    if (e.ctrlKey && (e.code === 'KeyC' || e.code === 'KeyX')) {
      if (!e.repeat) { this.clipMode = e.code === 'KeyC' ? 'copy' : 'cut'; this.selDrag = null; this.drag = null; }
      e.preventDefault();
      return;
    }
    if (e.ctrlKey && e.code === 'KeyV') {
      if (!e.repeat && this.clipboard) { this.clipMode = 'paste'; this.selDrag = null; this.drag = null; }
      e.preventDefault();
      return;
    }
    if (e.code === 'Escape' && this.clipMode) { this.clipMode = null; this.selDrag = null; return; }
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
    if (!this.enabled) return;
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
    if (!this.enabled) return;
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
      this.lensByTouch = false;   // лупа клавишей — без метки для пальцев
      if (this.zoomPinned) {
        this.zoomPinned = false;
      } else {
        this.zoomPinned = true;
        this.zoomPinnedGX = egx;
        this.zoomPinnedGY = egy;
      }
      return;
    }

    // Выделение для копирования и вставка — поверх любого инструмента.
    if (this.clipMode) {
      if (e.button === 2) { this.clipMode = null; this.selDrag = null; return; }
      if (this.clipMode === 'paste') {
        const clip = this.clipboard;
        this.pushUndo();
        this.sim.pasteRegion(clip, egx - (clip.w >> 1), egy - (clip.h >> 1));
        this.clipMode = null;
      } else {
        this.selDrag = { x0: egx, y0: egy, x1: egx, y1: egy };
      }
      return;
    }

    const elementId = this.getSelectedElement();

    // Инструмент "давление" — особый случай: не рисует материал, а
    // напрямую правит поток воздуха под кистью (ЛКМ усиливает, ПКМ
    // гасит); модификаторы (shift/ctrl/alt) тут не участвуют. Отдельным
    // шагом истории это не становится (иначе каждое движение кисти
    // давления забивало бы историю), но сам ветер в снимки отмены входит
    // (см. Sim.snapshot) — отмена следующего действия откатит и его.
    if (elementId === TOOL_PRESSURE) {
      const mode = e.button === 0 ? 'pressureInc' : 'pressureDec';
      this.drag = { mode, startX: egx, startY: egy, lastX: egx, lastY: egy, elementId };
      this.sim.applyPressureBrush(egx, egy, this.brushRX, this.brushRY, mode === 'pressureInc' ? 1 : -1);
      return;
    }

    // Точки спавна игроков и респавна (мультиплеер, sim/spawns.js): ЛКМ —
    // поставить, ПКМ — убрать рядом. Шагом истории не становятся.
    if (typeof elementId === 'string' && elementId.startsWith(TOOL_SPAWN_PREFIX)) {
      if (e.button === 2) this.sim.removeMarksNear(egx, egy, 1, 1);
      else this.sim.setSpawnMark(egx, egy, Number(elementId.slice(TOOL_SPAWN_PREFIX.length)));
      return;
    }
    if (elementId === TOOL_RESPAWN) {
      if (e.button === 2) this.sim.removeMarksNear(egx, egy, 1, 1);
      else this.sim.addRespawnMark(egx, egy);
      return;
    }

    // Электрический разряд: заряд по проводнику под курсором (или ближайшему
    // в пределах кисти), без шага истории — заряды в отмену не входят.
    if (elementId === TOOL_ZAP) {
      this.sim.zapAt(egx, egy, this.brushRX, this.brushRY);
      return;
    }

    // Лупа ничего не меняет в мире: ни рисования, ни шага истории — только
    // сообщает, по какой клетке щёлкнули (показывает карточку main.js).
    if (elementId === TOOL_INSPECT) {
      if (this.onInspect) this.onInspect(egx, egy, e.clientX, e.clientY);
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
    // Shift — линия; Shift+Ctrl и Shift+Alt — линия с привязкой к 45°.
    // ЛКМ ею рисует, ПКМ — стирает.
    if (shift && (ctrl || alt)) mode = e.button === 0 ? 'lineSnap' : 'lineSnapErase';
    else if (ctrl && !shift) mode = (e.button === 0) ? 'fill' : 'fillErase';
    else if (shift) mode = e.button === 0 ? 'line' : 'lineErase';
    else mode = (e.button === 0) ? 'paint' : 'erase';

    this.drag = { mode, startX: egx, startY: egy, lastX: egx, lastY: egy, elementId };
    this.pushUndo();
    // Балка берёт материал у клетки, с которой её начали вести (зажал на
    // металле и повёл — металлическая балка), см. Sim.pickBeamMaterial.
    if (elementId === EL.BEAM) this.sim.pickBeamMaterial(egx, egy);

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
    // Скрытое поле (лобби показывает своё, экран игры — своё) — нулевого
    // размера: деление на его ширину давало бесконечные координаты, а
    // "мышь над полем" оставалась включённой, если поле скрылось прямо под
    // мышью (ухода мыши браузер тогда не присылает). Стоило полю снова
    // показаться (хост щёлкнул превью карты) — контур кисти обводился от
    // минус бесконечности, цикл не кончался, и страница висла намертво
    // (жалоба пользователя, трижды; поймано через diag.log).
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) { this.inCanvas = false; return; }
    const [gx, gy] = this.toGrid(e.clientX, e.clientY);
    this.updateLensHover(e.clientX, e.clientY);
    const hovering = this.zoomHoverGX !== null && this.zoomHoverGX !== undefined;
    const egx = hovering ? this.zoomHoverGX : gx;
    const egy = hovering ? this.zoomHoverGY : gy;
    if (this.selDrag) { this.selDrag.x1 = egx; this.selDrag.y1 = egy; }
    if (this.drag) {
      const d = this.drag;
      if (d.mode === 'paint' || d.mode === 'erase') {
        const writeEl = this.paintElementFor(d.mode, d.elementId);
        const [brx, bry] = this.brushRadiusFor(writeEl);
        this.sim.stampLine(d.lastX, d.lastY, egx, egy, this.brushShape, brx, bry, writeEl, this.onlyEmptyFor(d.mode, d.elementId));
        d.lastX = egx; d.lastY = egy;
      } else if (isLineMode(d.mode)) {
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
    if (this.selDrag) { this.finishSelection(); return; }
    if (!this.drag) return;
    const d = this.drag;
    if (isLineMode(d.mode)) {
      let ex = d.lastX, ey = d.lastY;
      if (isSnapLine(d.mode)) [ex, ey] = snapAngle(d.startX, d.startY, ex, ey);
      const erase = isEraseLine(d.mode);
      const writeEl = erase ? EL.EMPTY : d.elementId;
      const [brx, bry] = this.brushRadiusFor(writeEl);
      this.sim.stampLine(d.startX, d.startY, ex, ey, this.brushShape, brx, bry, writeEl, erase ? false : this.onlyEmptyFor('paint', d.elementId));
    }
    this.drag = null;
  }

  // Выделение отпущено: прямоугольник (обрезанный по полю) копируется —
  // вместе с картинкой для проекции вставки, снятой с живого поля, пока
  // вырезание его ещё не стёрло.
  selectionRect() {
    const d = this.selDrag, sim = this.sim;
    const x0 = clampInt(Math.min(d.x0, d.x1), 0, sim.w - 1), x1 = clampInt(Math.max(d.x0, d.x1), 0, sim.w - 1);
    const y0 = clampInt(Math.min(d.y0, d.y1), 0, sim.h - 1), y1 = clampInt(Math.max(d.y0, d.y1), 0, sim.h - 1);
    return { x0, y0, x1, y1 };
  }

  finishSelection() {
    const r = this.selectionRect();
    const clip = this.sim.copyRegion(r.x0, r.y0, r.x1, r.y1);
    clip.image = this.renderer.regionImage(r.x0, r.y0, r.x1, r.y1);
    this.clipboard = clip;
    if (this.clipMode === 'cut') {
      this.pushUndo();
      this.sim.clearRegion(r.x0, r.y0, r.x1, r.y1);
    }
    this.clipMode = null;
    this.selDrag = null;
  }

  // Вызывается каждый кадр из игрового цикла: если кисть зажата и стоит на
  // месте, она всё равно должна продолжать действовать (например, стирать
  // всё, что упало под неё под гравитацией), а не только при движении мыши.
  tickHold() {
    if (!this.enabled) return;
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
    const inLine = this.drag && isLineMode(this.drag.mode);
    let linePreview = null;
    if (inLine) {
      const d = this.drag;
      let ex = d.lastX, ey = d.lastY;
      if (isSnapLine(d.mode)) [ex, ey] = snapAngle(d.startX, d.startY, ex, ey);
      linePreview = { x0: d.startX, y0: d.startY, x1: ex, y1: ey, erase: isEraseLine(d.mode) };
    }
    // У лупы контур в одну клетку: она смотрит ровно одну клетку, а не
    // площадь кисти.
    const inspect = this.getSelectedElement() === TOOL_INSPECT;
    const clipArmed = this.clipMode === 'copy' || this.clipMode === 'cut';
    // Клетка под курсором ещё не известна (мышь не двигалась над полем) —
    // ни кисти, ни рамок: рисовать их негде (см. onMouseMove).
    const at = Number.isFinite(this.gx) && Number.isFinite(this.gy);
    return {
      gx: this.gx, gy: this.gy,
      showBrush: at && this.inCanvas && !this.clipMode,
      // Выделение (рамка протяжки или взведённый режим — клетка под
      // курсором) и проекция вставки.
      clipSelect: this.selDrag ? this.selectionRect() : (clipArmed && at && this.inCanvas ? { x0: this.gx, y0: this.gy, x1: this.gx, y1: this.gy } : null),
      clipCut: this.clipMode === 'cut',
      clipPaste: this.clipMode === 'paste' && at && this.inCanvas ? { clip: this.clipboard, gx: this.gx, gy: this.gy } : null,
      brushShape: this.brushShape, brushRX: inspect ? 0 : this.brushRX, brushRY: inspect ? 0 : this.brushRY,
      linePreview,
      zoomActive: this.zoomKeyDown && at && this.inCanvas,
      zoomRX: this.zoomRX, zoomRY: this.zoomRY,
      zoomPinned: this.zoomPinned,
      // Метка лупы на поле — когда её открыли пальцами (см. LENS_HANDLE_PX).
      lensHandle: this.lensByTouch && this.zoomPinned,
      zoomPinnedGX: this.zoomPinnedGX, zoomPinnedGY: this.zoomPinnedGY,
      zoomHoverGX: this.zoomHoverGX, zoomHoverGY: this.zoomHoverGY,
      debugStability: this.debugStability,
      debugWind: this.debugWind,
      debugTherm: this.debugTherm,
    };
  }
}
