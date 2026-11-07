'use strict';

// Сегменты шароида на тросе (инструмент «Сегмент на тросе» во вкладке
// «Технологии»; просьба пользователя: «присоединять тросом к шароиду новые
// сегменты, которые будут следовать за ним»). Бур — не отдельный инструмент, а
// пиксель (EL.DRILL): пиксели бура рядом с щелчком уходят в сегмент и делают его
// сегментом с буром (kind 1); тот же пиксель в схваченном объекте дробит стену
// (sim/objects.js).
//
// Сегмент — не клетка, а сущность поверх поля (sim.segs), как ноги шароида и
// тросы: коробка 5x5 (SEG_HALF) с центром в (x, y); у бура от коробки торчит
// жало длиной SEG_BIT клеток по одному из 8 направлений (bdx, bdy). Рисует его
// Renderer.drawSegments. Сегменты шароида — цепочка: первый висит на тросе от
// низа тела, каждый следующий — на тросе от предыдущего (seg.prev). Трос между
// ними — обычный трос sim/rope.js (материал — сталь), поэтому его видно, он
// режется жаром/кислотой и рвётся от перегруза, а сегмент ниже порванного
// становится свободным: падает сам, пока не подцепят новый.
//
// Физика одного сегмента (updateSegments, после шароидов, главным потоком):
// тяжесть, ветер (покачивание и подпрыгивание на ветру — как у тел на тросе),
// опора на твёрдое, вода тормозит. Трос — ограничение длины SEG_LINK_LEN от
// центра сегмента до его якоря: натянулся — сегмент подтягивается за якорем
// (уходящий шароид тащит цепочку за собой), провис — просто висит и качается.
// Тело шароида и все твёрдые клетки для сегмента стена (sharPassable).
//
// Бур. Пока игрок шароида целится в клетку (input.aim) и зажимает ЛКМ
// (input.mine, js/play.js), ближайший к ней бур цепочки разворачивает жало на
// эту клетку и идёт к ней так, чтобы жало касалось её (центр — на расстоянии
// SEG_HALF + SEG_BIT от клетки), но не дальше, чем позволяет трос. Что стоит
// у кончика жала и ломается (mineable), бур дробит так же, как протагонист
// киркой — по стойкости (mineHitsNeeded), удар раз в SEG_HIT_FRAMES кадров, —
// и подаётся вперёд, пока не коснётся цели. Коробка 5x5 в твёрдое не входит,
// в камень идёт одно жало: ход получается узким и не глубже SEG_BIT клеток от
// края коробки. Стену (якорь) не берёт.
//
// Входит в отмену, файл сохранения и мир мультиплеера (простые объекты на
// Sim); добавляет и убирает сегмент действие игрока (addSegment,
// removeSegmentNear — MP_OPS в net.js). Шаг зависит только от мира и кадра
// (ветер берётся из снимка кадра, подпрыгивание — по номеру кадра), без
// Math.random — иначе вкладки мультиплеера разойдутся.
//
// Методы класса Sim, вынесенные в отдельный файл: класс ниже — только
// контейнер, extendSim переносит его методы в Sim.prototype (см. core.js).

// Коробка сегмента: от центра на SEG_HALF клеток в каждую сторону (5x5).
const SEG_HALF = 2;
// Жало бура, клеток от края коробки.
const SEG_BIT = 4;
// Длина троса сегмента — от якоря до центра сегмента.
const SEG_LINK_LEN = 12;
// Сегментов в одной цепочке не больше.
const SEG_MAX = 8;
// Пиксели бура собираются в сегмент с этого расстояния от клетки щелчка.
const SEG_DRILL_GATHER = 3;
// Щелчок инструментом берёт шароида, чей центр не дальше этого от клетки.
const SEG_ATTACH_REACH = 12;
// Разгон падения за кадр, предел скорости, затухание в воздухе / на опоре / в
// жидкости (множитель скорости за кадр).
const SEG_GRAVITY = 0.09;
const SEG_V_MAX = 1.2;
const SEG_DAMP_AIR = 0.996;
const SEG_DAMP_GROUND = 0.82;
const SEG_DAMP_LIQUID = 0.9;
const SEG_SINK_MAX = 0.3;
// Доля скорости удара о землю, с которой сегмент отскакивает (подпрыгивает).
const SEG_BOUNCE = 0.3;
// Ветер: мёртвая зона (рябь от падающего песка сегмент не качает), предел,
// разгон от единицы ветра за кадр; подпрыгивание — доля того же разгона вверх.
const SEG_WIND_DEAD = 0.15;
const SEG_WIND_MAX = 3;
const SEG_WIND_K = 0.025;
const SEG_WIND_HOP = 0.6;
// Натянутый трос тянет сегмент к якорю: доля превышения длины за кадр.
const SEG_PULL = 0.25;
// Бур идёт к цели не быстрее клеток за кадр; удар по пикселю раз в столько кадров.
const SEG_DRILL_SPEED = 0.5;
const SEG_HIT_FRAMES = 5;
// Масса сегмента в клетках — вес на тросе (ropeCapacity, sim/rope.js): трос
// рвётся, если подвешено больше, чем он держит по стойкости материала.
const SEG_MASS = 25;
const SEG_DRILL_MASS = 30;

class SimSegment {
  initSegments() {
    this.segs = [];
    this._segSeq = 0;
  }

  segById(id) {
    for (const g of this.segs) if (g.id === id) return g;
    return null;
  }

  // Свободна ли коробка (и жало бура, если kind === 1) с центром в (x, y) и
  // направлением жала (bdx, bdy): все клетки внутри поля и проходимы.
  segFree(x, y, bdx, bdy, kind) {
    const w = this.w, h = this.h, type = this.type;
    if (x - SEG_HALF < 0 || x + SEG_HALF >= w || y - SEG_HALF < 0 || y + SEG_HALF >= h) return false;
    for (let dy = -SEG_HALF; dy <= SEG_HALF; dy++) {
      const row = (y + dy) * w + x;
      for (let dx = -SEG_HALF; dx <= SEG_HALF; dx++) if (!this.sharPassable(type[row + dx])) return false;
    }
    if (kind === 1) {
      for (let k = 1; k <= SEG_BIT; k++) {
        const bx = x + bdx * (SEG_HALF + k), by = y + bdy * (SEG_HALF + k);
        if (bx < 0 || bx >= w || by < 0 || by >= h || !this.sharPassable(type[by * w + bx])) return false;
      }
    }
    return true;
  }

  // Первая непроходимая клетка на луче жала от края коробки: [k = 1..SEG_BIT + 1].
  // Возвращает индекс клетки или -1.
  segBitHit(g, bdx, bdy) {
    const w = this.w, h = this.h;
    for (let k = 1; k <= SEG_BIT + 1; k++) {
      const bx = g.x + bdx * (SEG_HALF + k), by = g.y + bdy * (SEG_HALF + k);
      if (bx < 0 || bx >= w || by < 0 || by >= h) return -1;
      const j = by * w + bx;
      if (!this.sharPassable(this.type[j])) return j;
    }
    return -1;
  }

  // Ищет свободное место для коробки вокруг (cx, cy) кольцами до радиуса 16
  // (жало бура у пола требует места повыше), не поверх других сегментов.
  segFindSpot(cx, cy, kind) {
    for (let r = 0; r <= 16; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (this.segFree(cx + dx, cy + dy, 0, 1, kind) && !this.segs.some((g) => Math.abs(g.x - cx - dx) < 2 * SEG_HALF + 1 && Math.abs(g.y - cy - dy) < 2 * SEG_HALF + 1)) return [cx + dx, cy + dy];
        }
      }
    }
    return null;
  }

  // Пиксели бура (EL.DRILL) вокруг клетки (x, y) в радиусе SEG_DRILL_GATHER: их
  // индексы. Бур — не отдельный инструмент, а материал (просьба пользователя):
  // сегмент с буром собирается из таких пикселей.
  segDrillPixels(x, y) {
    const out = [];
    for (let yy = Math.max(0, y - SEG_DRILL_GATHER); yy <= Math.min(this.h - 1, y + SEG_DRILL_GATHER); yy++) {
      for (let xx = Math.max(0, x - SEG_DRILL_GATHER); xx <= Math.min(this.w - 1, x + SEG_DRILL_GATHER); xx++) {
        if (this.type[yy * this.w + xx] === EL.DRILL) out.push(yy * this.w + xx);
      }
    }
    return out;
  }

  // Прицепить новый сегмент (kind: 0 — простой, 1 — с буром) к шароиду,
  // ближайшему к клетке (x, y): в конец его цепочки. kind не задан — с буром,
  // если рядом с клеткой есть пиксели бура (они уходят в сегмент).
  addSegment(x, y, kind) {
    let gather = null;
    if (kind === undefined) {
      gather = this.segDrillPixels(x, y);
      kind = gather.length > 0 ? 1 : 0;
    }
    let best = null, bd = Infinity;
    for (const s of this.sharoids) {
      const dx = x - (s.x + (SHAR_W >> 1)), dy = y - (s.y + (SHAR_H >> 1)), d = Math.sqrt(dx * dx + dy * dy);
      if (d < bd) { bd = d; best = s; }
    }
    if (!best || bd > SEG_ATTACH_REACH) return false;
    const chain = this.segs.filter((g) => g.owner === best.id);
    if (chain.length >= SEG_MAX) return false;
    const last = chain.length ? chain[chain.length - 1] : null;
    const ax = last ? last.x : best.x + (SHAR_W >> 1), ay = last ? last.y : best.y + SHAR_H - 1;
    kind = kind === 1 ? 1 : 0;
    const spot = this.segFindSpot(ax, ay + (SEG_LINK_LEN * 0.8 | 0), kind);
    if (!spot) return false;
    const id = ++this._segSeq;
    const rope = { id: ++this._ropeSeq, a: last ? { k: 'seg', id: last.id } : { k: 'shar', id: best.id, dx: SHAR_W >> 1, dy: SHAR_H - 1 }, b: { k: 'seg', id }, len: SEG_LINK_LEN, mat: EL.STEEL };
    this.ropes.push(rope);
    if (gather) for (const j of gather) { this.clearCell(j); }
    this.segs.push({
      id, owner: best.id, kind, prev: last ? last.id : 0, rope: rope.id, x: spot[0], y: spot[1], fx: 0, fy: 0, vx: 0, vy: 0,
      bdx: 0, bdy: 1, gnd: false, mineCell: -1, mineHits: 0, mineT: 0, mineShade0: 0,
    });
    return true;
  }

  // Убрать сегмент, ближайший к (x, y) (в пределах SEG_HALF + SEG_BIT клеток от
  // центра). Следующий за ним в цепочке цепляется к его якорю.
  removeSegmentNear(x, y) {
    let best = null, bd = SEG_HALF + SEG_BIT + 1;
    for (const g of this.segs) {
      const d = Math.max(Math.abs(g.x - x), Math.abs(g.y - y));
      if (d < bd) { bd = d; best = g; }
    }
    if (!best) return false;
    const mine = this.ropes.find((r) => r.id === best.rope);
    const child = this.segs.find((g) => g.prev === best.id);
    this.segs = this.segs.filter((g) => g !== best);
    this.ropes = this.ropes.filter((r) => r.id !== best.rope);
    if (child) {
      child.prev = best.prev;
      const cr = this.ropes.find((r) => r.id === child.rope);
      if (cr && mine) cr.a = JSON.parse(JSON.stringify(mine.a));
      else if (cr) this.ropes = this.ropes.filter((r) => r !== cr);
    }
    return true;
  }

  // Подтолкнуть сегмент по оси ветром (мёртвая зона и предел — см. SEG_WIND_*).
  segWind(v) {
    if (v > SEG_WIND_DEAD) return Math.min(SEG_WIND_MAX, v - SEG_WIND_DEAD);
    if (v < -SEG_WIND_DEAD) return Math.max(-SEG_WIND_MAX, v + SEG_WIND_DEAD);
    return 0;
  }

  // Удар бура g по клетке j (см. шапку): первый — через SEG_HIT_FRAMES кадров
  // после наведения, сменилась цель — счёт заново; клетка темнеет к
  // последнему удару, как у протагониста.
  segMine(g, j) {
    if (j !== g.mineCell) { g.mineCell = j; g.mineHits = 0; g.mineT = 0; g.mineShade0 = this.shade[j]; }
    if (++g.mineT < SEG_HIT_FRAMES) return;
    g.mineT = 0;
    const need = this.mineHitsNeeded(j);
    // Раздробленное буром уходит в механизм (статья учёта вещества, sim/chem.js).
    if (++g.mineHits >= need) { this.chemExternal(CHEM_EXT_MINE, j, -1); this.clearCell(j); g.mineCell = -1; g.mineHits = 0; return; }
    const col = ELEMENTS[this.type[j]].color, lum = (col[0] + col[1] + col[2]) / 3, k = need > 1 ? g.mineHits / (need - 1) : 1;
    this.shade[j] = Math.max(-128, Math.round((g.mineShade0 || 0) - MINE_DARK_MAX * lum * k));
    this.markDirty(j);
  }

  // Куда целится игрок шароида s: [x, y] при зажатой ЛКМ, иначе null.
  segAimOf(s) {
    if (s.ctrl < 0) return null;
    const inp = this.playerSlot(s.ctrl).input;
    return inp.mine && inp.aim ? [inp.ax | 0, inp.ay | 0] : null;
  }

  // Один кадр сегментов (см. шапку).
  updateSegments() {
    if (this.segs.length === 0) return;
    const w = this.w, type = this.type;
    // Какой бур каждой цепочки ведёт к цели: ближайший к ней.
    const busy = new Map();
    for (const s of this.sharoids) {
      const aim = this.segAimOf(s);
      if (!aim) continue;
      let pick = null, pd = Infinity;
      for (const g of this.segs) {
        if (g.owner !== s.id || g.kind !== 1) continue;
        const d = Math.max(Math.abs(g.x - aim[0]), Math.abs(g.y - aim[1]));
        if (d < pd) { pd = d; pick = g; }
      }
      if (pick) busy.set(pick.id, aim);
    }
    // Вес на тросах: каждый трос держит свой сегмент и всё, что ниже по цепочке.
    const load = new Map();
    for (let k = this.segs.length - 1; k >= 0; k--) {
      const g = this.segs[k], own = (load.get(g.id) || 0) + (g.kind === 1 ? SEG_DRILL_MASS : SEG_MASS);
      load.set(g.id, own);
      if (g.prev) load.set(g.prev, (load.get(g.prev) || 0) + own);
      const rope = this.ropes.find((r) => r.id === g.rope);
      if (rope && own > this.ropeCapacity(rope)) rope.dead = true;
    }
    if (this.ropes.some((r) => r.dead)) this.ropes = this.ropes.filter((r) => !r.dead);

    for (const g of this.segs) {
      const rope = this.ropes.find((r) => r.id === g.rope);
      const anchor = rope ? this.ropeEndPos(rope.a) : null;
      // Проржавевший трос — жёсткий прут: сегмент держится на том же расстоянии и
      // в том же направлении от якоря, не качается и не целится.
      if (rope && anchor && this.ropeStiff(rope)) {
        if (!rope.fix) rope.fix = [g.x - anchor[0], g.y - anchor[1]];
        const tx = anchor[0] + rope.fix[0], ty = anchor[1] + rope.fix[1];
        for (let n = 0; n < 2 && (g.x !== tx || g.y !== ty); n++) {
          const sx = Math.sign(tx - g.x), sy = Math.sign(ty - g.y);
          if (this.segFree(g.x + sx, g.y + sy, g.bdx, g.bdy, g.kind)) { g.x += sx; g.y += sy; }
          else if (sx && this.segFree(g.x + sx, g.y, g.bdx, g.bdy, g.kind)) g.x += sx;
          else if (sy && this.segFree(g.x, g.y + sy, g.bdx, g.bdy, g.kind)) g.y += sy;
          else break;
        }
        g.vx = 0; g.vy = 0; g.fx = 0; g.fy = 0; g.mineCell = -1;
        continue;
      }
      const aim = busy.get(g.id) || null;
      const cell = g.y * w + g.x, inLiquid = IS_LIQUID[type[cell]] === 1;
      let vx = g.vx, vy = g.vy;
      if (aim) {
        // Бур: жало на цель, центр — так, чтобы жало её касалось, но в пределах троса.
        const dx = aim[0] - g.x, dy = aim[1] - g.y, ax = Math.abs(dx), ay = Math.abs(dy);
        // 8 направлений: почти по оси — вдоль неё, иначе по диагонали.
        const bdx = ay > 2.4 * ax ? 0 : Math.sign(dx), bdy = ax > 2.4 * ay ? 0 : Math.sign(dy) || (bdx ? 0 : 1);
        if (bdx !== g.bdx || bdy !== g.bdy) {
          if (this.segFree(g.x, g.y, bdx, bdy, 1)) { g.bdx = bdx; g.bdy = bdy; }
          else { const j = this.segBitHit(g, bdx, bdy); if (j >= 0 && this.mineable(type[j])) this.segMine(g, j); }
        }
        let tx = aim[0] - g.bdx * (SEG_HALF + SEG_BIT), ty = aim[1] - g.bdy * (SEG_HALF + SEG_BIT);
        if (anchor) {
          const ex = tx - anchor[0], ey = ty - anchor[1], ed = Math.sqrt(ex * ex + ey * ey);
          if (ed > rope.len) { tx = anchor[0] + ex * rope.len / ed; ty = anchor[1] + ey * rope.len / ed; }
        }
        const mx = tx - g.x, my = ty - g.y, md = Math.sqrt(mx * mx + my * my);
        if (md > 0.5) { vx = mx / md * Math.min(SEG_DRILL_SPEED, md); vy = my / md * Math.min(SEG_DRILL_SPEED, md); } else { vx = 0; vy = 0; }
        const j = this.segBitHit(g, g.bdx, g.bdy);
        if (j >= 0 && this.mineable(type[j])) this.segMine(g, j); else g.mineCell = -1;
      } else {
        g.mineCell = -1;
        // Жало без дела возвращается вниз.
        if ((g.bdx !== 0 || g.bdy !== 1) && this.segFree(g.x, g.y, 0, 1, g.kind)) { g.bdx = 0; g.bdy = 1; }
        vy += inLiquid ? SEG_GRAVITY * 0.3 : SEG_GRAVITY;
        // Ветер: качает и подбрасывает (по номеру кадра, без случайных чисел).
        const wx = this.segWind(this.getWindVX(g.x, g.y)), wy = this.segWind(this.getWindVY(g.x, g.y));
        if (wx !== 0 || wy !== 0) {
          vx += wx * SEG_WIND_K; vy += wy * SEG_WIND_K;
          vy -= Math.abs(wx) * SEG_WIND_K * SEG_WIND_HOP * (0.5 + 0.5 * Math.sin(this.frame * 0.35 + g.id));
        }
        if (anchor) {
          // Натянутый трос: наружная скорость гасится, сегмент тянется к якорю.
          const ex = anchor[0] - g.x, ey = anchor[1] - g.y, ed = Math.sqrt(ex * ex + ey * ey);
          if (ed > rope.len && ed > 0) {
            const nx = ex / ed, ny = ey / ed, vn = vx * nx + vy * ny;
            if (vn < 0) { vx -= vn * nx; vy -= vn * ny; }
            const pull = (ed - rope.len) * SEG_PULL;
            vx += nx * pull; vy += ny * pull;
          }
        }
        const damp = inLiquid ? SEG_DAMP_LIQUID : g.gnd ? SEG_DAMP_GROUND : SEG_DAMP_AIR;
        vx *= damp; vy *= inLiquid ? SEG_DAMP_LIQUID : SEG_DAMP_AIR;
        if (inLiquid) vy = Math.min(vy, SEG_SINK_MAX);
      }
      vx = Math.max(-SEG_V_MAX, Math.min(SEG_V_MAX, vx));
      vy = Math.max(-SEG_V_MAX, Math.min(SEG_V_MAX, vy));
      g.fx += vx; g.fy += vy;
      g.gnd = false;
      for (let n = 0; n < 3 && Math.abs(g.fx) >= 1; n++) {
        const sx = g.fx > 0 ? 1 : -1;
        if (this.segFree(g.x + sx, g.y, g.bdx, g.bdy, g.kind)) { g.x += sx; g.fx -= sx; } else { vx = 0; g.fx = 0; }
      }
      for (let n = 0; n < 3 && Math.abs(g.fy) >= 1; n++) {
        const sy = g.fy > 0 ? 1 : -1;
        if (this.segFree(g.x, g.y + sy, g.bdx, g.bdy, g.kind)) { g.y += sy; g.fy -= sy; }
        else {
          if (sy > 0) { g.gnd = true; vy = vy > 0.5 ? -vy * SEG_BOUNCE : 0; } else vy = 0;
          g.fy = 0;
        }
      }
      g.vx = vx; g.vy = vy;
    }
  }

  // Снимок сегментов для отмены и файла (простые объекты, глубокая копия).
  segsDump() { return JSON.parse(JSON.stringify(this.segs)); }

  segsLoad(list) {
    this.segs = Array.isArray(list) ? JSON.parse(JSON.stringify(list)) : [];
    for (const g of this.segs) if (g.id > this._segSeq) this._segSeq = g.id;
  }
}

extendSim(SimSegment);
