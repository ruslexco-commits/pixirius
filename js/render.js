'use strict';

function clamp8(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

function hsvToRgb(h, s, v) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q; break;
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

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
    // Окно лупы — квадрат площадью в четверть площади канваса.
    this.zoomBoxSize = Math.sqrt((canvas.width * canvas.height) / 4);
    this.zoomBoxMargin = 10;

    this.debugStability = false;
    this.debugWind = false;
  }

  cellColor(i) {
    const sim = this.sim;
    const id = sim.type[i];
    if (this.debugWind) {
      const x = i % sim.w, y = (i / sim.w) | 0;
      const wc = this.windColor(x, y);
      if (wc) return wc;
    }
    if (id === EL.EMPTY) return [14, 14, 18];
    const el = ELEMENTS[id];
    if (this.debugStability && isStructural(id)) return this.stabilityColor(id, sim.stability[i]);
    const s = sim.shade[i];
    let r = clamp8(el.color[0] + s), g = clamp8(el.color[1] + s), b = clamp8(el.color[2] + s);
    if (id === EL.FIRE) {
      const flick = (sim.life[i] * 37 + i * 13) % 46;
      r = clamp8(r + flick);
      g = clamp8(g + (flick >> 1));
    }
    return [r, g, b];
  }

  // Заземлённость клетки как доля от maxStability её материала: 0 (вот-вот
  // осыплется) - красный, 1 (максимум, у самой опоры) - зелёный, посередине
  // - жёлтый. Доля берётся от maxStability, а не от абсолютного значения,
  // чтобы материалы с разным бюджетом (дерево 5, металл 20) сравнивались
  // по одной и той же шкале "насколько близко к пределу", а не по сырым
  // числам.
  stabilityColor(id, stab) {
    const maxS = ELEMENTS[id].maxStability || 1;
    const ratio = Math.max(0, Math.min(1, stab / maxS));
    let r, g;
    if (ratio < 0.5) { r = 255; g = Math.round(255 * (ratio / 0.5)); }
    else { r = Math.round(255 * (1 - (ratio - 0.5) / 0.5)); g = 255; }
    return [r, g, 40];
  }

  // Направление и сила локального ветра как цвет: угол вектора (vx,vy) -
  // оттенок по цветовому кругу (вправо - красный, вверх - жёлто-зелёный,
  // влево - голубой, вниз - сине-фиолетовый), величина - яркость. Совсем
  // слабый ветер (ниже порога) не подсвечивается вовсе (null) — иначе на
  // полностью тихой сцене без единого дуновения весь экран был бы залит
  // одним тусклым цветом вместо обычного вида.
  windColor(x, y) {
    const sim = this.sim;
    const vx = sim.getWindVX(x, y), vy = sim.getWindVY(x, y);
    const mag = Math.sqrt(vx * vx + vy * vy);
    if (mag < 0.02) return null;
    const hue = (Math.atan2(vy, vx) / (2 * Math.PI) + 1) % 1;
    const val = Math.min(1, 0.35 + mag * 0.3);
    return hsvToRgb(hue, 0.85, val);
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
    this.drawBrushOutlineAt(gx, gy, shape, rx, ry, 0, 0, this.zoom);
  }

  // То же самое, но в произвольной системе координат (смещение ox,oy и свой
  // масштаб scale вместо this.zoom) — используется для отрисовки наведения
  // кисти внутри окна лупы, в её собственном увеличении.
  drawBrushOutlineAt(gx, gy, shape, rx, ry, ox, oy, scale) {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1;
    this.traceShapeOutline(gx, gy, shape, rx, ry, ox, oy, scale);
    ctx.restore();
  }

  // Контур кисти строго повторяет реально закрашиваемые клетки: для квадрата
  // это просто прямоугольник, а для круга — точная лестничная граница по той
  // же формуле включения, что использует stampBrush (а не гладкий эллипс,
  // который на глаз казался мельче настоящей закрашиваемой области).
  traceShapeOutline(gx, gy, shape, rx, ry, ox = 0, oy = 0, scale = this.zoom) {
    const ctx = this.ctx;
    if (shape !== 'circle') {
      const w = (rx * 2 + 1) * scale, h = (ry * 2 + 1) * scale;
      const cx = ox + (gx + 0.5) * scale, cy = oy + (gy + 0.5) * scale;
      ctx.strokeRect(cx - w / 2, cy - h / 2, w, h);
      return;
    }
    const rx2 = Math.max(rx, 0.5), ry2 = Math.max(ry, 0.5);
    const x0 = Math.floor(gx - rx), x1 = Math.ceil(gx + rx);
    const y0 = Math.floor(gy - ry), y1 = Math.ceil(gy + ry);
    const left = [], right = [];
    for (let y = y0; y <= y1; y++) {
      let xl = null, xr = null;
      for (let x = x0; x <= x1; x++) {
        const dx = (x - gx) / rx2, dy = (y - gy) / ry2;
        if (dx * dx + dy * dy <= 1) { if (xl === null) xl = x; xr = x; }
      }
      if (xl !== null) {
        left.push([ox + xl * scale, oy + y * scale], [ox + xl * scale, oy + (y + 1) * scale]);
        right.push([ox + (xr + 1) * scale, oy + y * scale], [ox + (xr + 1) * scale, oy + (y + 1) * scale]);
      }
    }
    if (!left.length) return;
    ctx.beginPath();
    ctx.moveTo(left[0][0], left[0][1]);
    for (const p of left) ctx.lineTo(p[0], p[1]);
    for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i][0], right[i][1]);
    ctx.closePath();
    ctx.stroke();
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

  drawZoomSourceHighlight(gx, gy, capRX, capRY) {
    const ctx = this.ctx, z = this.zoom;
    const x = (gx - capRX) * z, y = (gy - capRY) * z;
    const w = (capRX * 2 + 1) * z, h = (capRY * 2 + 1) * z;
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 200, 40, 0.9)';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  drawZoomLens(gx, gy, capRX, capRY, pinned, brush) {
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
    // Запоминаем итоговый прямоугольник и параметры съёмки — по ним input.js
    // определяет наведение мыши прямо на окно лупы и пересчитывает обратно
    // в мировые координаты, чтобы можно было "листать" показываемую область.
    this.lastZoomBoxRect = box;
    this.lastZoomCapture = { gx, gy, capRX, capRY };

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

    ctx.strokeStyle = pinned ? 'rgba(255, 200, 40, 0.95)' : 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 2;
    ctx.strokeRect(box.x + 1, box.y + 1, box.w - 2, box.h - 2);
    ctx.strokeStyle = 'rgba(255,60,60,0.95)';
    ctx.lineWidth = 1;
    ctx.strokeRect(ox + capRX * scale, oy + capRY * scale, Math.ceil(scale), Math.ceil(scale));

    // Наведение кисти внутри самой лупы — тем же точным контуром, что и на
    // основном канвасе, но в координатах и увеличении окна лупы, и только
    // если рабочая точка вообще попадает в показываемую лупой область.
    if (brush) {
      const lgx = brush.gx - gx + capRX, lgy = brush.gy - gy + capRY;
      if (Math.abs(brush.gx - gx) <= capRX + brush.rx && Math.abs(brush.gy - gy) <= capRY + brush.ry) {
        this.drawBrushOutlineAt(lgx, lgy, brush.shape, brush.rx, brush.ry, ox, oy, scale);
      }
    }
    ctx.restore();
  }

  render(cursor) {
    this.debugStability = !!cursor.debugStability;
    this.debugWind = !!cursor.debugWind;
    this.drawFrame();
    if (cursor.linePreview) {
      const lp = cursor.linePreview;
      this.drawLinePreview(lp.x0, lp.y0, lp.x1, lp.y1);
      this.drawBrushOutline(lp.x1, lp.y1, cursor.brushShape, cursor.brushRX, cursor.brushRY);
    } else if (cursor.showBrush) {
      this.drawBrushOutline(cursor.gx, cursor.gy, cursor.brushShape, cursor.brushRX, cursor.brushRY);
    }
    if (cursor.zoomActive || cursor.zoomPinned) {
      const hovering = cursor.zoomHoverGX !== null && cursor.zoomHoverGX !== undefined;
      // Что именно показывает лупа (центр захвата и подсветка источника на
      // основном канвасе) — это ТОЛЬКО live-слежение за курсором или
      // зафиксированная точка, и НИКОГДА наведение на саму проекцию лупы.
      // Раньше наведение на уже зафиксированную лупу подменяло эту точку на
      // zoomHoverGX/GY, из-за чего показываемая область визуально "ехала"
      // за мышкой прямо внутри собственного окна — притом что "зафиксировано"
      // как раз и должно означать "не двигается". Наведение по-прежнему
      // определяет, КУДА рисовать (см. brush ниже) — просто больше не влияет
      // на то, что лупа показывает.
      const zx = cursor.zoomPinned ? cursor.zoomPinnedGX : cursor.gx;
      const zy = cursor.zoomPinned ? cursor.zoomPinnedGY : cursor.gy;
      this.drawZoomSourceHighlight(zx, zy, cursor.zoomRX, cursor.zoomRY);
      // Рабочая точка кисти для отрисовки внутри лупы: при наведении на саму
      // лупу — та точка, что она сейчас показывает под курсором; иначе, во
      // время протяжки линии — текущий конец линии; иначе — обычная позиция
      // курсора на основном канвасе (для live-лупы она и так совпадает с zx,zy).
      let brush = null;
      if (cursor.showBrush) {
        let bgx, bgy;
        if (hovering) { bgx = cursor.zoomHoverGX; bgy = cursor.zoomHoverGY; }
        else if (cursor.linePreview) { bgx = cursor.linePreview.x1; bgy = cursor.linePreview.y1; }
        else { bgx = cursor.gx; bgy = cursor.gy; }
        brush = { gx: bgx, gy: bgy, shape: cursor.brushShape, rx: cursor.brushRX, ry: cursor.brushRY };
      }
      this.drawZoomLens(zx, zy, cursor.zoomRX, cursor.zoomRY, cursor.zoomPinned, brush);
    } else {
      this.lastZoomBoxRect = null;
    }

    if (this.debugStability || this.debugWind) {
      const hovering = cursor.zoomHoverGX !== null && cursor.zoomHoverGX !== undefined;
      if (hovering) this.drawDebugInfo(cursor.zoomHoverGX, cursor.zoomHoverGY);
      else if (cursor.showBrush) this.drawDebugInfo(cursor.gx, cursor.gy);
    }
  }

  stabilityInfoText(gx, gy) {
    const sim = this.sim;
    const i = sim.idx(gx, gy);
    const id = sim.type[i];
    if (id === EL.EMPTY) return 'Пусто';
    if (!isStructural(id)) return ELEMENTS[id].name;
    const maxS = ELEMENTS[id].maxStability || 0;
    return `${ELEMENTS[id].name}: заземлённость ${sim.stability[i]}/${maxS}`;
  }

  windInfoText(gx, gy) {
    const sim = this.sim;
    const vx = sim.getWindVX(gx, gy), vy = sim.getWindVY(gx, gy);
    const mag = Math.sqrt(vx * vx + vy * vy);
    return `Давление: ${mag.toFixed(2)} (vx ${vx.toFixed(2)}, vy ${vy.toFixed(2)})`;
  }

  // Значения под курсором для включённых режимов отладки (заземлённость,
  // давление воздуха) - в верхнем левом углу канваса, по строке на режим.
  drawDebugInfo(gx, gy) {
    const sim = this.sim;
    if (!sim.inBounds(gx, gy)) return;
    const lines = [];
    if (this.debugStability) lines.push(this.stabilityInfoText(gx, gy));
    if (this.debugWind) lines.push(this.windInfoText(gx, gy));
    if (!lines.length) return;

    const ctx = this.ctx;
    ctx.save();
    ctx.font = '14px monospace';
    const padX = 8, padY = 6, lineH = 18;
    let maxW = 0;
    for (const line of lines) maxW = Math.max(maxW, ctx.measureText(line).width);
    const w = Math.ceil(maxW) + padX * 2;
    const h = lineH * lines.length + padY * 2;
    const x = 8, y = 8;
    ctx.fillStyle = 'rgba(10,10,13,0.85)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.fillStyle = '#e8e8ee';
    ctx.textBaseline = 'middle';
    for (let k = 0; k < lines.length; k++) {
      ctx.fillText(lines[k], x + padX, y + padY + lineH * k + lineH / 2);
    }
    ctx.restore();
  }
}
