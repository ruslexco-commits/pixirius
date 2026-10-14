'use strict';

// Рисование игроком: клетка, кисть, линия, заливка.
//
// Методы класса Sim, вынесенные в отдельный файл: класс ниже — только
// контейнер, extendSim переносит его методы в Sim.prototype (см. core.js).

class SimPainting {
  // Живого протагониста кисть не трогает: ни ластик, ни замена, ни заливка
  // (просьба пользователя: "пусть нельзя будет стереть игрока" — в
  // мультиплеере кистью стирали чужих игроков). Мёртвое тело стирается.
  livePlayerAt(i) { return this.type[i] === EL.PROTAGONIST && this.extra[i] !== 1; }

  setCell(x, y, elementId, onlyEmpty) {
    if (!this.inBounds(x, y)) return;
    const i = this.idx(x, y);
    if (this.livePlayerAt(i)) return;
    // Балка живёт во втором слое: ничего не вытесняет и кладётся сквозь
    // пустоту, жидкость и газ (но не в твёрдое и сыпучее, см. placeBeam).
    // Материал — тот, с которого начали вести (beamPaintMaterial).
    if (elementId === EL.BEAM) {
      if (onlyEmpty && this.beam[i]) return;
      this.placeBeam(i, this.beamPaintMaterial, this.beamPaintExtra);
      return;
    }
    if (onlyEmpty && (this.type[i] !== EL.EMPTY || this.beam[i])) return;
    // Протагонист на поле один: новый заменяет прежнего (sim/protagonist.js).
    // В мультиплеере (protagonistAsSpawn — номер хоста, net.js) кисть
    // протагониста ставит точку спавна хоста (просьба пользователя).
    if (elementId === EL.PROTAGONIST) {
      if (this.protagonistAsSpawn) this.setSpawnMark(x, y, this.protagonistAsSpawn);
      else this.placeProtagonist(i);
      return;
    }
    // Ластик стирает и то, что "на заднем плане": балку и точки спавна и
    // респавна (точку респавна раньше было не убрать ничем, кроме ПКМ
    // её же инструментом).
    if (elementId === EL.EMPTY) { this.clearCell(i); this.removeBeam(i); this.removeMarksAt(x, y); }
    else { this.spawn(i, elementId); this.paintStage(i, elementId); }
  }

  // Кисть с выбранной стадией окисла (paintOxideStage): свежая клетка
  // переводится в неё тем же setOxideStage, что и при окислении, — тип,
  // состав и цвет стадии сходятся сами.
  paintStage(i, elementId) {
    if (this.paintOxideStage && OXIDE_LINE[elementId]) this.setOxideStage(i, this.paintOxideStage);
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
    if (this.livePlayerAt(startI)) return;
    const target = this.type[startI];
    const replacement = erase ? EL.EMPTY : elementId;
    // Тот же элемент, но другая стадия окисла, — заливка имеет смысл.
    if (target === replacement && !this.paintOxideStage) return;
    // Заливать протагонистом нечего: он один — ставится в точку щелчка.
    if (replacement === EL.PROTAGONIST) { this.setCell(x0, y0, EL.PROTAGONIST, false); return; }
    const w = this.w, h = this.h;
    const stack = [startI];
    const visited = new Uint8Array(w * h);
    visited[startI] = 1;
    while (stack.length) {
      const i = stack.pop();
      if (this.type[i] !== target) continue;
      // Балка — не вещество: её кладут во второй слой, а не в type (раньше
      // заливка балкой записывала BEAM прямо в type).
      if (replacement === EL.BEAM) this.placeBeam(i, this.beamPaintMaterial, this.beamPaintExtra);
      else if (replacement === EL.EMPTY) this.clearCell(i); else { this.spawn(i, replacement); this.paintStage(i, replacement); }
      const x = i % w, y = (i / w) | 0;
      if (x > 0) { const ni = i - 1; if (!visited[ni]) { visited[ni] = 1; if (this.type[ni] === target) stack.push(ni); } }
      if (x < w - 1) { const ni = i + 1; if (!visited[ni]) { visited[ni] = 1; if (this.type[ni] === target) stack.push(ni); } }
      if (y > 0) { const ni = i - w; if (!visited[ni]) { visited[ni] = 1; if (this.type[ni] === target) stack.push(ni); } }
      if (y < h - 1) { const ni = i + w; if (!visited[ni]) { visited[ni] = 1; if (this.type[ni] === target) stack.push(ni); } }
    }
  }

  // ---- копирование и вставка (просьба пользователя: Ctrl+C, Ctrl+X, Ctrl+V) ----

  // Копия прямоугольника x0..x1, y0..y1 (включительно): все поля
  // клетки-частицы (PARTICLE_FIELDS) — вид, состав, температура, оттенок,
  // балка и прочее, — чтобы вставленное было той же самой частицей.
  copyRegion(x0, y0, x1, y1) {
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const fields = {};
    for (const f of PARTICLE_FIELDS) {
      const src = this[f.name];
      const out = new src.constructor(w * h);
      for (let y = 0; y < h; y++) {
        const from = (y0 + y) * this.w + x0;
        out.set(src.subarray(from, from + w), y * w);
      }
      fields[f.name] = out;
    }
    return { w, h, fields };
  }

  // Вставка копии левым верхним углом в (x0, y0). Пустые клетки копии
  // прозрачны: вставленный предмет не стирает то, что вокруг него на
  // новом месте (клетка, где была только балка, кладёт только балку).
  // Протагонист не копируется (он на поле один) и не затирается; человек
  // вставляется новым человеком — со своей памятью, а не с чужим номером
  // (life у человека — ключ его памяти, см. spawn). Продавливание и
  // пометка падения не переносятся: это состояние, а не вещество.
  pasteRegion(clip, x0, y0) {
    const F = clip.fields;
    for (let cy = 0; cy < clip.h; cy++) {
      for (let cx = 0; cx < clip.w; cx++) {
        const x = x0 + cx, y = y0 + cy;
        if (!this.inBounds(x, y)) continue;
        const k = cy * clip.w + cx, t = F.type[k];
        if (t === EL.EMPTY && !F.beam[k]) continue;
        if (t === EL.PROTAGONIST) continue;
        const i = this.idx(x, y);
        if (this.type[i] === EL.PROTAGONIST) continue;
        if (t === EL.EMPTY) {
          this.beam[i] = F.beam[k];
          this.beamExtra[i] = F.beamExtra[k];
          this.markDirty(i);
          continue;
        }
        if (t === EL.HUMAN || t === EL.COLONIST) {
          this.spawn(i, t);
          this.extra[i] = F.extra[k];
          this.temp[i] = F.temp[k];
          continue;
        }
        for (const f of PARTICLE_FIELDS) this[f.name][i] = F[f.name][k];
        this.fall[i] = 0;
        this.crushed[i] = 0;
        this.markDirty(i);
      }
    }
  }

  // Убрать метки спавна и респавна в клетке (x, y), если они есть.
  removeMarksAt(x, y) {
    if (!this.spawnMarks.length && !this.respawnMarks.length) return;
    if (this.spawnMarkAt(x, y) || this.respawnMarkAt(x, y)) this.removeMarksNear(x, y, 0, 0);
  }

  // Вырезание: область пустеет целиком, вместе с балками и метками
  // (протагонист остаётся — его не копируют).
  clearRegion(x0, y0, x1, y1) {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = this.idx(x, y);
        if (this.type[i] === EL.PROTAGONIST) continue;
        this.clearCell(i);
        this.removeBeam(i);
        this.removeMarksAt(x, y);
      }
    }
  }
}

extendSim(SimPainting);
