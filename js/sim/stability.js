'use strict';

// Структурная устойчивость твёрдых тел (кто на чём держится и что осыпается)
// и второй слой — балки (this.beam), которые держат только твёрдое.
//
// Методы класса Sim, вынесенные в отдельный файл: класс ниже — только
// контейнер, extendSim переносит его методы в Sim.prototype (см. core.js).

// Масштаб бокового счётчика в computeStability(): позволяет угловым клеткам
// стоить вдвое дешевле обычного шага, оставаясь при этом целыми числами.
const STEP_UNIT = 2;

// Шаги распространения устойчивости — строго в этом порядке: вверх, вниз,
// вправо, влево. Порядок важен: на одном уровне побеждает первое
// предложение, а hasOtherStableNeighbor читает stability посреди
// распространения. Раньше это был массив пар [[0,-1], ...], перебираемый
// через for..of с деструктуризацией, — итератор на каждую клетку массива
// камня; теперь два плоских массива.
const STAB_STEP_DX = [0, 0, 1, -1];
const STAB_STEP_DY = [-1, 1, 0, 0];
// Какое направление связи должно быть у застывшего масла (extra), чтобы
// принять устойчивость с шагом s: противоположное шагу.
const STAB_STEP_OIL_LINK = STAB_STEP_DX.map((dx, s) => oilOppositeDir(oilDirCode(dx, STAB_STEP_DY[s])));

// maxStability / toughness по id — таблицы вместо ELEMENTS[id].x || дефолт
// на каждом шаге распространения.
const STAB_MAX = new Float64Array(64);
const STAB_TOUGHNESS = new Float64Array(64);
for (let id = 0; id < 64; id++) {
  STAB_MAX[id] = (ELEMENTS[id] && ELEMENTS[id].maxStability) || 0;
  STAB_TOUGHNESS[id] = (ELEMENTS[id] && ELEMENTS[id].toughness) || 1;
}

class SimStability {
  // Поставить балку из материала mat (стадия окисла extra) во второй слой.
  // Провести её можно только сквозь пустоту, жидкость или газ: в уже
  // стоящее твёрдое или сыпучее — нельзя (просьба пользователя).
  //
  // Раньше балка без единой опоры рядом сразу становилась камнем. Теперь
  // это не нужно: держится ли балка, решает устойчивость (updateBeams), и
  // висящая в воздухе балка осыпается своим материалом в следующем же
  // кадре.
  placeBeam(i, mat, extra) {
    const t = this.type[i];
    if (t !== EL.EMPTY && IS_LIQUID[t] !== 1 && IS_GASLIKE[t] !== 1 && t !== EL.FIRE) return;
    this.beam[i] = mat;
    this.beamExtra[i] = extra;
    this.markDirty(i);
  }

  // Материал для следующей балки — по клетке (x, y), с которой её начали
  // вести: зажал кнопку на металле и повёл вверх — балка металлическая.
  // Годится любое твёрдое, кроме застывшего масла (у него особая связь,
  // см. computeStability); начали с клетки, где уже стоит балка, — её
  // материал; иначе (пустота, жидкость, сыпучее) — камень, как раньше.
  // Окисел передаёт и свою стадию.
  pickBeamMaterial(x, y) {
    let mat = EL.STONE, extra = 0;
    if (this.inBounds(x, y)) {
      const i = this.idx(x, y);
      const t = this.type[i];
      if (IS_STRUCTURAL[t] === 1 && t !== EL.OILFILM) {
        mat = t;
        extra = IS_OXIDE[t] === 1 ? this.oxideStage(i) : 0;
      } else if (this.beam[i]) {
        mat = this.beam[i];
        extra = this.beamExtra[i];
      }
    }
    this.beamPaintMaterial = mat;
    this.beamPaintExtra = extra;
  }

  removeBeam(i) {
    this.beam[i] = 0;
    this.beamExtra[i] = 0;
    this.markDirty(i);
  }

  // Стадия окисла материала балки — как oxideStage у клетки: основа
  // линейки — 0, окисел — стадия из beamExtra, вне линеек — -1.
  beamStage(i) {
    const mat = this.beam[i];
    const line = OXIDE_LINE[mat];
    if (!line) return -1;
    if (mat === line.base) return 0;
    return this.beamExtra[i] || 1;
  }

  // Хрупка ли балка — как oxideFrail, но по её материалу и стадии.
  beamFrail(i) {
    const fr = OXIDE_FRAIL_FROM[this.beam[i]];
    if (!fr) return false;
    return fr < 0 || this.beamExtra[i] >= fr;
  }

  // Хрупкость того, что несёт клетку: вещества, если оно твёрдое, иначе
  // балки под ним.
  stabFrail(i) {
    const t = this.type[i];
    if (IS_STRUCTURAL[t] === 1 || IS_ANCHOR[t] === 1) return this.oxideFrail(i);
    return this.beam[i] ? this.beamFrail(i) : false;
  }

  // "Структурный" элемент клетки с учётом второго слоя: сначала вещество,
  // и только если оно несущим быть не может — материал балки под ним. Всё,
  // что считает устойчивость, смотрит сюда, а не в type напрямую.
  stabId(i) {
    const t = this.type[i];
    if (isStructural(t) || isAnchor(t)) return t;
    return this.beam[i] ? this.beam[i] : t;
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
    // Скелет мира с прошлого пересчёта не изменился — в stability и
    // sideCounter уже лежит ровно тот результат, который дал бы пересчёт
    // (кроме этого метода их никто не пишет: при движении частиц они не
    // переезжают, отмена и сохранение их не трогают). Полный пересчёт на
    // массиве камня стоит ~7 мс, а песок, вода и газ скелет не меняют.
    if (!this.structureChanged()) return;
    // Спящие куски с обломками проснутся (см. sim/sleep.js).
    this._stabRecomputed = true;
    const w = this.w, h = this.h, n = w * h;
    const stab = this.stability;
    const sideC = this.sideCounter;
    stab.fill(0);
    sideC.fill(0);

    const maxLevel = 64;
    // Ведро уровня — JS-массив, длина которого ведётся отдельно (bucketLen).
    // Раньше вёдра очищались через length = 0, а V8 при этом отдаёт память
    // массива: массив камня в 100 тыс. клеток каждый кадр заново растил
    // ведро по одному push и нагружал сборщик мусора. Теперь ёмкость
    // переживает кадр, а порядок обработки (очередь в порядке добавления)
    // тот же.
    const buckets = this._stabBuckets || (this._stabBuckets = Array.from({ length: maxLevel + 1 }, () => []));
    const bucketLen = this._stabBucketLen || (this._stabBucketLen = new Int32Array(maxLevel + 1));
    bucketLen.fill(0);

    const seed = (i, id) => {
      const s = Math.min(this.cellStability(i, id), maxLevel);
      if (s > stab[i]) { stab[i] = s; sideC[i] = 0; buckets[s][bucketLen[s]++] = i; }
    };
    for (let x = 0; x < w; x++) {
      const i = this.idx(x, h - 1);
      const id = this.stabId(i);
      if (isStructural(id)) seed(i, id);
    }
    const type = this.type, beam = this.beam, extra = this.extra;
    for (let i = 0; i < n; i++) {
      if (IS_ANCHOR[type[i]] !== 1) continue;
      const x = i % w, y = (i / w) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = x + DX4[k], ny = y + DY4[k];
        if (!this.inBounds(nx, ny)) continue;
        const ni = this.idx(nx, ny);
        const nid = this.stabId(ni);
        if (isStructural(nid)) seed(ni, nid);
      }
    }

    for (let level = maxLevel; level >= 1; level--) {
      const bucket = buckets[level];
      for (let bi = 0; bi < bucketLen[level]; bi++) {
        const i = bucket[bi];
        if (stab[i] !== level) continue; // устарело — клетку с тех пор улучшили
        const y = (i / w) | 0, x = i - y * w;
        // Застывшее масло — тупик: получает устойчивость от своей единственной
        // связи (проверка ниже, при рассмотрении его как соседа), но само
        // никому её не передаёт — иначе стало бы мостом между двумя объектами.
        if (type[i] === EL.OILFILM) continue;
        for (let s = 0; s < 4; s++) {
          const dx = STAB_STEP_DX[s], dy = STAB_STEP_DY[s];
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const ni = ny * w + nx;
          // = stabId(ni), без вызова на каждого соседа.
          const nt = type[ni];
          const nid = (IS_STRUCTURAL[nt] === 1 || IS_ANCHOR[nt] === 1) ? nt : (beam[ni] ? beam[ni] : nt);
          if (IS_STRUCTURAL[nid] !== 1) continue;
          if (nid === EL.OILFILM && extra[ni] !== STAB_STEP_OIL_LINK[s]) continue;
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
            if (newStab >= 1) { const b = Math.min(newStab, maxLevel); buckets[b][bucketLen[b]++] = ni; }
          }
        }
      }
    }
  }

  // Изменился ли с прошлого вызова "скелет" — всё, что читает
  // computeStability, и только это. Подпись клетки (_stabSig):
  //   твёрдое или якорь — его тип, плюс у застывшего масла направление
  //     связи (extra), а у окисла — хрупок ли он (oxideFrail);
  //   прочее с балкой — "балка", её материал и хрупкость (beamFrail);
  //   прочее без балки — 0: какой там именно песок или вода, устойчивости
  //     всё равно.
  // Подпись пишется заново на каждом вызове, так что после пересчёта она
  // уже соответствует его входу. Добавляя в computeStability чтение нового
  // поля клетки, добавь его и в подпись — иначе пересчёт будет пропущен
  // там, где не должен.
  //
  // Подпись пересчитывается только в кусках поля, где что-то менялось
  // (chunkChanged, см. sim/sleep.js): любая запись типа, состава, балки или
  // стадии окисла помечает свой кусок, а в нетронутых кусках скелет
  // измениться не мог. Полный проход — только в первый раз. Поэтому менять
  // поля клетки в обход spawn/setComposition/setOxideStage/placeBeam можно,
  // только пометив кусок (markDirty).
  structureChanged() {
    const n = this.w * this.h;
    const sig = this._stabSig || (this._stabSig = new Uint16Array(n));
    let changed = false;
    if (!this._stabSigValid) {
      for (let i = 0; i < n; i++) sig[i] = this.stabSignature(i);
      this._stabSigValid = true;
      return true;
    }
    const count = this._chunkW * this._chunkH, w = this.w;
    for (let c = 0; c < count; c++) {
      if (!this.chunkChanged(c)) continue;
      const [x0, y0, x1, y1] = this.chunkBounds(c);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * w + x;
          const s = this.stabSignature(i);
          if (sig[i] !== s) { sig[i] = s; changed = true; }
        }
      }
    }
    return changed;
  }

  // Подпись одной клетки для structureChanged.
  stabSignature(i) {
    const t = this.type[i];
    if (IS_STRUCTURAL[t] === 1 || IS_ANCHOR[t] === 1) {
      let s = t + 1;
      if (t === EL.OILFILM) s |= this.extra[i] << 7;
      else if (OXIDE_FRAIL_FROM[t] !== 0 && this.oxideFrail(i)) s |= 1 << 7;
      return s;
    }
    if (this.beam[i]) {
      let s = 0x8000 | (this.beam[i] << 1);
      if (this.beamFrail(i)) s |= 1;
      return s;
    }
    return 0;
  }

  // Есть ли у клетки (x,y) ещё один уже устойчивый (stability>0) сосед того
  // же материала, помимо того, откуда пришло текущее распространение
  // (fromDx,fromDy — направление ИЗ источника В эту клетку)? Если да — это
  // геометрический угол/стык (подпёрта сразу с двух сторон), а не середина
  // прямого участка.
  hasOtherStableNeighbor(x, y, fromDx, fromDy, matchType) {
    const w = this.w, h = this.h, type = this.type, stab = this.stability;
    for (let k = 0; k < 4; k++) {
      const ddx = DX4[k], ddy = DY4[k];
      if (ddx === -fromDx && ddy === -fromDy) continue; // это как раз тот сосед, откуда мы пришли
      const nx = x + ddx, ny = y + ddy;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const ni = ny * w + nx;
      if (type[ni] === matchType && stab[ni] > 0) return true;
    }
    return false;
  }

  // Раз в кадр по всему второму слою, сразу после computeStability: балка,
  // которую ничто не держит (устойчивость 0 — нет пути к опоре или вылет
  // в сторону длиннее, чем позволяет стойкость её материала), осыпается
  // своим материалом (каменная — камнем, металлическая — металлом), и
  // дальше он падает как любой обломок. Балка, нагретая до точки
  // плавления своего материала, плавится так же, как он.
  //
  // Раньше балка рушилась, только когда пропадал именно тот сосед, к
  // которому она примкнула при установке (маска в beam). Из-за этого
  // лишённый опоры пролёт осыпался слоями: крайняя балка становилась
  // камнем, камень падал, и лишь тогда ломалась следующая — по клетке за
  // кадр. Устойчивость же считается сразу по всему миру, поэтому весь
  // неподдержанный пролёт осыпается в одном кадре (просьба "моментально
  // вся становится каменной, а не послойно").
  //
  // Решает только устойчивость самой балки: если в её клетке лежит
  // твёрдое, устойчивость клетки — его, а не балки (см. stabId), и её
  // здесь не трогаем.
  //
  // Отдельный проход нужен потому, что в общем обходе клеток балки нет:
  // там перебирается this.type, а балки в нём не бывает. Проход дешёвый —
  // одно сравнение с нулём на клетку, ветка выполняется только там, где
  // балка действительно стоит.
  updateBeams() {
    const n = this.w * this.h;
    const beam = this.beam, type = this.type, stab = this.stability;
    for (let i = 0; i < n; i++) {
      if (!beam[i]) continue;
      const t = type[i];
      const ownStability = IS_STRUCTURAL[t] !== 1 && IS_ANCHOR[t] !== 1;
      if (ownStability && stab[i] === 0) {
        // Осыпавшаяся балка становится своим материалом — но только если
        // клетка свободна. Занятую (водой, газом) не трогаем: балка
        // исчезает, ничего никуда не вытесняя.
        if (t === EL.EMPTY) this.dropBeam(i); else this.removeBeam(i);
        continue;
      }
      // У материала без точки плавления (дерево, лёд) meltRoll просто
      // ложна — и случайное число не тратится.
      const mat = beam[i];
      if (t === EL.EMPTY && this.meltRoll(i, mat)) {
        this.removeBeam(i);
        this.spawn(i, ELEMENTS[mat].meltsInto, false);
      }
    }
  }

  // Балка в пустой клетке осыпается своим материалом (окисел — со своей
  // стадией). Устойчивость этой клетки в текущем кадре 0, поэтому он
  // сразу же падает как обломок.
  dropBeam(i) {
    const mat = this.beam[i], stage = this.beamStage(i);
    this.removeBeam(i);
    this.spawn(i, mat);
    if (IS_OXIDE[mat] === 1) this.setOxideStage(i, stage);
  }

  // maxStability/toughness клетки с поправкой на стадию окисления (у балки
  // — по стадии её материала, см. stabFrail).
  cellStability(i, id) {
    if (this.stabFrail(i)) return OXIDE_FRAIL_STABILITY;
    return STAB_MAX[id];
  }

  cellToughness(i, id) {
    if (this.stabFrail(i)) return OXIDE_FRAIL_TOUGHNESS;
    return STAB_TOUGHNESS[id];
  }
}

extendSim(SimStability);
