'use strict';

// Структурная устойчивость твёрдых тел (кто на чём держится и что осыпается)
// и второй слой — балки (this.beam), которые держат только твёрдое.
//
// Методы класса Sim, вынесенные в отдельный файл: класс ниже — только
// контейнер, extendSim переносит его методы в Sim.prototype (см. core.js).

// Масштаб бокового счётчика в computeStability(): позволяет угловым клеткам
// стоить вдвое дешевле обычного шага, оставаясь при этом целыми числами.
const STEP_UNIT = 2;

class SimStability {
  // Поставить балку во второй слой. Связь с опорой запоминается РОВНО в
  // момент установки и больше не пересчитывается (см. updateBeams) —
  // битовая маска направлений по индексам DX4. Если опоры рядом не было
  // вовсе, балке не за что держаться: в этом случае на клетку кладётся
  // обычный камень, как и раньше.
  placeBeam(i) {
    const w = this.w, x = i % w, y = (i / w) | 0;
    let mask = 0;
    for (let k = 0; k < 4; k++) {
      const nx = x + DX4[k], ny = y + DY4[k];
      if (!this.inBounds(nx, ny)) continue;
      if (this.beam[this.idx(nx, ny)]) { mask |= (1 << k); continue; }
      const nt = this.type[this.idx(nx, ny)];
      if (isStructural(nt) || isAnchor(nt)) mask |= (1 << k);
    }
    if (!mask) { this.spawn(i, EL.STONE); return; }
    this.beam[i] = mask;
  }

  // "Структурный" элемент клетки с учётом второго слоя: сначала вещество,
  // и только если оно несущим быть не может — балка под ним. Всё, что
  // считает устойчивость, смотрит сюда, а не в type напрямую.
  stabId(i) {
    const t = this.type[i];
    if (isStructural(t) || isAnchor(t)) return t;
    return this.beam[i] ? EL.BEAM : t;
  }

  // У каждого структурного материала своя maxStability (значение, которое
  // получает клетка, касающаяся низа поля или якоря — стена/пустота/клонер)
  // и toughness = X (через сколько клеток БОКОВОГО пути стабильность падает
  // на 1). По вертикали (вверх ИЛИ вниз) стабильность передаётся соседу
  // целиком, бесплатно, без всякого счётчика — столб, просто стоящий друг
  // на друге (или свисающий по прямой вниз от опоры), в реальности держится
  // собственным весом и сцеплением, и его высота сама по себе никак его не
  // ослабляет. Бюджет (toughness) расходуется только на боковой, консольный
  // вылет — именно там материалу физически не на что опереться напрямую.
  // Боковой счётчик при движении по вертикали не сбрасывается и не растёт —
  // просто переносится как есть, так что боковой вылет, начатый с любой
  // высоты столба, получает полный горизонтальный бюджет с нуля.
  // X берётся из материала ПРИНИМАЮЩЕЙ клетки (не источника).
  // Угловые/стыковые клетки (подпёртые сразу с двух сторон, не только
  // оттуда, откуда идёт распространение) держатся крепче прямого участка —
  // боковой шаг туда стоит вдвое дешевле (см. hasOtherStableNeighbor и
  // STEP_UNIT).
  computeStability() {
    const w = this.w, h = this.h, n = w * h;
    const stab = this.stability;
    const sideC = this.sideCounter;
    stab.fill(0);
    sideC.fill(0);

    const maxLevel = 64;
    const buckets = this._stabBuckets || (this._stabBuckets = Array.from({ length: maxLevel + 1 }, () => []));
    for (let lvl = 0; lvl <= maxLevel; lvl++) buckets[lvl].length = 0;

    const seed = (i, id) => {
      const s = Math.min(this.cellStability(i, id), maxLevel);
      if (s > stab[i]) { stab[i] = s; sideC[i] = 0; buckets[s].push(i); }
    };
    for (let x = 0; x < w; x++) {
      const i = this.idx(x, h - 1);
      const id = this.stabId(i);
      if (isStructural(id)) seed(i, id);
    }
    for (let i = 0; i < n; i++) {
      if (!isAnchor(this.type[i])) continue;
      const x = i % w, y = (i / w) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = x + DX4[k], ny = y + DY4[k];
        if (!this.inBounds(nx, ny)) continue;
        const ni = this.idx(nx, ny);
        const nid = this.stabId(ni);
        if (isStructural(nid)) seed(ni, nid);
      }
    }

    const steps = [[0, -1], [0, 1], [1, 0], [-1, 0]];
    for (let level = maxLevel; level >= 1; level--) {
      const bucket = buckets[level];
      for (let bi = 0; bi < bucket.length; bi++) {
        const i = bucket[bi];
        if (stab[i] !== level) continue; // устарело — клетку с тех пор улучшили
        const x = i % w, y = (i / w) | 0;
        // Застывшее масло — тупик: получает устойчивость от своей единственной
        // связи (проверка ниже, при рассмотрении его как соседа), но само
        // никому её не передаёт — иначе стало бы мостом между двумя объектами.
        if (this.type[i] === EL.OILFILM) continue;
        for (const [dx, dy] of steps) {
          const nx = x + dx, ny = y + dy;
          if (!this.inBounds(nx, ny)) continue;
          const ni = this.idx(nx, ny);
          const nid = this.stabId(ni);
          if (!isStructural(nid)) continue;
          if (nid === EL.OILFILM && this.extra[ni] !== oilOppositeDir(oilDirCode(dx, dy))) continue;
          let newStab, newSideC;
          if (dx === 0) {
            newStab = stab[i];
            newSideC = sideC[i];
          } else {
            const X = this.cellToughness(ni, nid);
            // Угол/стык (клетка того же материала, подпёртая ещё и с ДРУГОЙ
            // стороны, не только оттуда, откуда пришло это распространение)
            // держится крепче прямого участка — вдвое дешевле по счётчику.
            // Реализовано через масштаб x2: обычный шаг стоит 2 "юнита",
            // угловой — 1, а порог смещён на X*2, так что на прямом участке
            // счёт идёт ровно так же, как и раньше (X шагов на -1), а
            // угловые шаги считаются за половину.
            const corner = this.hasOtherStableNeighbor(nx, ny, dx, dy, nid);
            newSideC = sideC[i] + (corner ? 1 : STEP_UNIT);
            const threshold = X * STEP_UNIT;
            if (newSideC >= threshold) { newStab = stab[i] - 1; newSideC = 0; } else newStab = stab[i];
          }
          if (newStab > stab[ni]) {
            stab[ni] = newStab; sideC[ni] = newSideC;
            if (newStab >= 1) buckets[Math.min(newStab, maxLevel)].push(ni);
          }
        }
      }
    }
  }

  // Есть ли у клетки (x,y) ещё один уже устойчивый (stability>0) сосед того
  // же материала, помимо того, откуда пришло текущее распространение
  // (fromDx,fromDy — направление ИЗ источника В эту клетку)? Если да — это
  // геометрический угол/стык (подпёрта сразу с двух сторон), а не середина
  // прямого участка.
  hasOtherStableNeighbor(x, y, fromDx, fromDy, matchType) {
    for (let k = 0; k < 4; k++) {
      const ddx = DX4[k], ddy = DY4[k];
      if (ddx === -fromDx && ddy === -fromDy) continue; // это как раз тот сосед, откуда мы пришли
      const nx = x + ddx, ny = y + ddy;
      if (!this.inBounds(nx, ny)) continue;
      const ni = this.idx(nx, ny);
      if (this.type[ni] === matchType && this.stability[ni] > 0) return true;
    }
    return false;
  }

  // Раз в кадр по всему второму слою: балка, потерявшая ту самую опору, с
  // которой была связана при установке, осыпается обычным камнем — и
  // дальше падает как любой обломок. Балка, нагретая до точки плавления,
  // плавится так же, как плавился бы камень на её месте.
  //
  // Отдельный проход нужен потому, что в общем обходе клеток балки больше
  // нет: там перебирается this.type, а балки в нём не бывает. Проход
  // дешёвый — одно сравнение с нулём на клетку, ветка выполняется только
  // там, где балка действительно стоит.
  updateBeams() {
    const w = this.w, h = this.h, n = w * h;
    const beam = this.beam;
    for (let i = 0; i < n; i++) {
      const mask = beam[i];
      if (!mask) continue;
      const x = i % w, y = (i / w) | 0;
      let broken = false;
      for (let k = 0; k < 4; k++) {
        if (!(mask & (1 << k))) continue;
        const nx = x + DX4[k], ny = y + DY4[k];
        if (!this.inBounds(nx, ny)) { broken = true; break; }
        const ni = this.idx(nx, ny);
        if (beam[ni]) continue;
        const nt = this.type[ni];
        if (!isStructural(nt) && !isAnchor(nt)) { broken = true; break; }
      }
      if (broken) {
        beam[i] = 0;
        // Осыпавшаяся балка становится камнем — но только если клетка
        // свободна. Занятую (водой, газом) не трогаем: балка исчезает,
        // ничего никуда не вытесняя.
        if (this.type[i] === EL.EMPTY) this.spawn(i, EL.STONE);
        continue;
      }
      if (this.type[i] === EL.EMPTY && this.temp[i] >= ELEMENTS[EL.BEAM].meltPoint
          && Math.random() < ELEMENTS[EL.BEAM].meltChance) {
        beam[i] = 0;
        this.spawn(i, EL.LAVA, false);
      }
    }
  }

  // maxStability/toughness клетки с поправкой на стадию окисления.
  cellStability(i, id) {
    if (this.oxideFrail(i)) return OXIDE_FRAIL_STABILITY;
    return ELEMENTS[id].maxStability || 0;
  }

  cellToughness(i, id) {
    if (this.oxideFrail(i)) return OXIDE_FRAIL_TOUGHNESS;
    return ELEMENTS[id].toughness || 1;
  }
}

extendSim(SimStability);
