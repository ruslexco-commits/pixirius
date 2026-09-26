'use strict';

// Взрыв сухих чёрных солей и трещины, которые он оставляет в твёрдом.
//
// Просьба пользователя: чёрные соли в сухом виде (когда в них не
// растворено ничего, кроме самих солей) взрывоопасны, и на поверхности
// вокруг взрыва остаются трещины. Мокрая соль (с водой, кислотой,
// реагентом внутри) не взрывается — она живёт обычной жизнью раствора.
//
// Методы класса Sim, вынесенные в отдельный файл: класс ниже — только
// контейнер, extendSim переносит его методы в Sim.prototype (см. core.js).

// Сухая соль детонирует от касания огня или лавы — как порох — или от
// нагрева до этой температуры (соседний взрыв греет её и подрывает).
const SALT_IGNITE_TEMP = 250;
// Сколько клеток сухой соли подрывается одной волной (связная масса
// целиком, как у пороха); больше — остаток рванёт следующими кадрами от
// огня и жара первого взрыва.
const BLAST_MAX_CELLS = 4000;
// Радиус взрыва растёт как корень из мощности (числа долей соли): вдвое
// больше соли — радиус в ~1.4 раза больше, а не вдвое.
const BLAST_BASE_R = 3;
const BLAST_R_PER_SQRT = 0.55;
const BLAST_MAX_R = 40;
// Жар (градусов в эпицентре, к краю — меньше), шанс огня в пустой клетке
// и сила ударной волны в сетке ветра (для сравнения: WIND_PUSH_MIN = 0.45,
// выше него поток уже толкает вещество). Жар нарочно ниже точки плавления
// камня (165): при 400 стенки воронки плавились, и на её дне оставалось
// озеро лавы — взрыв выглядел извержением.
const BLAST_HEAT = 150;
const BLAST_FIRE_CHANCE = 0.35;
const BLAST_FIRE_LIFE = 8;
const BLAST_WIND = 3;
// Разрушает ли взрыв клетку: сила в точке (1 в эпицентре, 0 на краю)
// должна превысить стойкость материала к взрыву (blastResist) плюс
// случайную добавку — край воронки выходит рваным, а не циркульным.
const BLAST_RESIST_SPREAD = 0.35;
// Трещины: сколько (от CRACK_MIN до CRACK_MIN + CRACK_EXTRA), как сильно
// виляют (радиан за клетку), как часто ветвятся и насколько длинные
// относительно радиуса взрыва.
const CRACK_MIN = 3;
const CRACK_EXTRA = 4;
const CRACK_JITTER = 0.45;
const CRACK_BRANCH = 0.1;
const CRACK_LEN_MIN = 0.5, CRACK_LEN_MAX = 1.1;

class SimExplosion {
  // Сухая соль: в составе нет ничего, кроме солей (и пустоты).
  isDrySalt(i) {
    const comp = this.comp(i);
    return solGet(comp, P_SALT) === solMatter(comp);
  }

  // Реакция клетки чёрных солей: сухая — проверить, не пора ли рвануть;
  // иначе (и пока не рванула) — обычная жизнь долей, как у раствора.
  reactBlackSalt(x, y, i) {
    if (this.isDrySalt(i) && (this.temp[i] >= SALT_IGNITE_TEMP || this.touchesFlame(x, y))) {
      this.detonateSalt(x, y);
      return;
    }
    this.reactSolutionLike(x, y, i);
  }

  touchesFlame(x, y) {
    for (let k = 0; k < 4; k++) {
      const nx = x + DX4[k], ny = y + DY4[k];
      if (!this.inBounds(nx, ny)) continue;
      const nt = this.type[this.idx(nx, ny)];
      if (nt === EL.FIRE || nt === EL.LAVA) return true;
    }
    return false;
  }

  // Подрыв: вся связная масса сухой соли разом (как у пороха, см.
  // detonateGunpowder — иначе часть массы разлеталась бы, не успев
  // сдетонировать). Мощность — число долей соли, центр — центр массы.
  detonateSalt(x0, y0) {
    // Воронка и заливка массы не помещаются в полосу параллельного обхода —
    // главный поток взорвёт после (sim/threads.js).
    if (this._inBand) { this.defer(DEFER_SALT, this.idx(x0, y0)); return; }
    const w = this.w, h = this.h;
    const start = this.idx(x0, y0);
    const visited = new Uint8Array(w * h);
    const stack = [start];
    visited[start] = 1;
    const cells = [];
    let power = 0, sx = 0, sy = 0;
    while (stack.length && cells.length < BLAST_MAX_CELLS) {
      const i = stack.pop();
      const x = i % w, y = (i / w) | 0;
      cells.push(i);
      power += solGet(this.comp(i), P_SALT);
      sx += x; sy += y;
      for (let k = 0; k < 4; k++) {
        const nx = x + DX4[k], ny = y + DY4[k];
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const ni = ny * w + nx;
        if (visited[ni]) continue;
        visited[ni] = 1;
        if (this.type[ni] === EL.BLACK_SALT && this.isDrySalt(ni)) stack.push(ni);
      }
    }
    for (const i of cells) this.clearCell(i);
    this.blast(sx / cells.length, sy / cells.length, power);
  }

  // Насколько материал держит взрыв (0..1, Infinity — не разрушается
  // вовсе). Твёрдое — по своей устойчивости: дерево и камень рвёт легко,
  // металл заметно хуже, сталь — лишь у самого эпицентра. Стена и прочие
  // якоря — не разрушаются. Сыпучее, жидкость, газ — почти не держат.
  blastResist(id) {
    if (IS_ANCHOR[id] === 1) return Infinity;
    if (IS_STRUCTURAL[id] === 1) return Math.min(0.85, 0.08 + STAB_MAX[id] * 0.05);
    return 0.05;
  }

  // Сам взрыв в точке (cx, cy) мощностью power: воронка (разрушение по
  // силе и стойкости материала, и балок во втором слое тоже), жар, огонь
  // в опустевших клетках, ударная волна в сетке ветра и трещины в
  // твёрдом вокруг воронки.
  blast(cx, cy, power) {
    const R = Math.min(BLAST_MAX_R, BLAST_BASE_R + Math.sqrt(power) * BLAST_R_PER_SQRT);
    const x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(this.w - 1, Math.ceil(cx + R));
    const y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(this.h - 1, Math.ceil(cy + R));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d > R) continue;
        const dmg = 1 - d / R;
        const i = this.idx(x, y);
        this.temp[i] += BLAST_HEAT * dmg;
        const t = this.type[i];
        if (t !== EL.EMPTY && dmg > this.blastResist(t) + Math.random() * BLAST_RESIST_SPREAD) this.clearCell(i);
        if (this.beam[i] && dmg > this.blastResist(this.beam[i]) + Math.random() * BLAST_RESIST_SPREAD) this.removeBeam(i);
        if (this.type[i] === EL.EMPTY && Math.random() < BLAST_FIRE_CHANCE * dmg) {
          // seedHeat=false: у огня своя температура источника (1590), и
          // десятки таких клеток в воронке плавили её стенки. Огонь взрыва
          // берёт жар самого взрыва — горючее он всё равно поджигает
          // касанием (reactFlammable смотрит на тип соседа, а не на жар).
          this.spawn(i, EL.FIRE, false);
          this.life[i] = BLAST_FIRE_LIFE + (Math.random() * 10 | 0);
          this.moved[i] = 1;
        }
      }
    }
    // Ударная волна: ветер от центра, сильнее ближе к нему.
    const ac = this.airCell;
    const ax0 = Math.floor(x0 / ac), ax1 = Math.min(this.airW - 1, Math.floor(x1 / ac));
    const ay0 = Math.floor(y0 / ac), ay1 = Math.min(this.airH - 1, Math.floor(y1 / ac));
    for (let ay = ay0; ay <= ay1; ay++) {
      for (let ax = ax0; ax <= ax1; ax++) {
        const dx = (ax + 0.5) * ac - cx, dy = (ay + 0.5) * ac - cy;
        const d = Math.hypot(dx, dy);
        if (d > R || d < 1e-3) continue;
        const f = BLAST_WIND * (1 - d / R) / d;
        const ai = ay * this.airW + ax;
        this.windVX[ai] += dx * f;
        this.windVY[ai] += dy * f;
      }
    }
    this.blastCracks(cx, cy, R);
  }

  // Трещины: по нескольким лучам от центра ищем, где взрыв упёрся в
  // твёрдое (край воронки), и оттуда ведём вглубь материала ломаную,
  // виляющую и ветвящуюся линию. Трещина — это опустевшие клетки: она
  // видна тёмной щелью и по-настоящему ослабляет тело — отколотый ею кусок
  // лишается опоры и падает (устойчивость пересчитается в следующем кадре).
  blastCracks(cx, cy, R) {
    const n = CRACK_MIN + (Math.random() * (CRACK_EXTRA + 1) | 0);
    for (let k = 0; k < n; k++) {
      const a = (k + Math.random() * 0.8) / n * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      for (let r = R * 0.5; r <= R * 1.6; r += 0.5) {
        const x = Math.round(cx + ca * r), y = Math.round(cy + sa * r);
        if (!this.inBounds(x, y)) break;
        const t = this.type[this.idx(x, y)];
        if (IS_ANCHOR[t] === 1) break;
        if (IS_STRUCTURAL[t] === 1) {
          const len = R * (CRACK_LEN_MIN + Math.random() * (CRACK_LEN_MAX - CRACK_LEN_MIN));
          this.crackFrom(x, y, a, Math.max(4, len), 0);
          break;
        }
      }
    }
  }

  // Одна трещина из (x, y) в направлении angle длиной len клеток. Идёт
  // только по твёрдому: вышла из материала больше чем на две клетки —
  // кончилась. Якоря (стену) не берёт. Изредка ветвится (глубина не
  // больше двух), ответвление вдвое короче остатка.
  crackFrom(x, y, angle, len, depth) {
    let fx = x, fy = y, a = angle, gaps = 0;
    for (let s = 0; s < len; s++) {
      const ix = Math.round(fx), iy = Math.round(fy);
      if (!this.inBounds(ix, iy)) break;
      const i = this.idx(ix, iy);
      const t = this.type[i];
      if (IS_ANCHOR[t] === 1) break;
      if (IS_STRUCTURAL[t] === 1) { this.clearCell(i); gaps = 0; }
      else if (++gaps > 2) break;
      a += (Math.random() - 0.5) * CRACK_JITTER * 2;
      fx += Math.cos(a); fy += Math.sin(a);
      if (depth < 2 && Math.random() < CRACK_BRANCH) {
        const side = Math.random() < 0.5 ? -1 : 1;
        this.crackFrom(fx, fy, a + side * (0.5 + Math.random() * 0.5), (len - s) * 0.5, depth + 1);
      }
    }
  }
}

extendSim(SimExplosion);
