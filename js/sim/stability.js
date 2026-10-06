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

// Сколько отдельных групп балок за кадр могут ехать вместе с падающими
// телами (см. rideBeams). Сверх этого группа просто висит, пока тело не
// уйдёт, — на практике падающих тел с балками единицы.
const BEAM_RIDE_MAX_GROUPS = 1024;

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
        // У балки нет состава, только материал: со сплава берётся его
        // преобладающая доля.
        mat = t === EL.ALLOY ? this.alloyMainPart(i) : t;
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
    // Продавленные (sim/landing.js) опору дальше передают — тело на них и
    // остальной пол держатся как обычно, — но сами стоят с устойчивостью 0
    // и осыпаются, если есть куда.
    if (this._crushLive) this.zeroCrushedStability();
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
          if (sig[i] !== s) {
            if (!changed && !this.stabChangeHarmless(i, sig[i], s)) changed = true;
            sig[i] = s;
          }
        }
      }
    }
    return changed;
  }

  // Смена подписи клетки i (old -> now), которая заведомо не меняет
  // результат computeStability: пересчёт дал бы те же stability и
  // sideCounter. Так летящее тело (просьба пользователя: "при падении
  // подлагивает") не пересчитывает устойчивость всего поля каждый кадр:
  // пока оно в воздухе, все его клетки — обломки с устойчивостью 0, и ни
  // одна не касается ничего держащегося. Условия:
  //  - на месте клетки устойчивость была 0 — ушедшее ничего не держало
  //    (устойчивость течёт только от клеток с устойчивостью больше нуля);
  //  - ни до, ни после это не якорь, не балка (её путь рвётся, когда в её
  //    клетку входит твёрдое), не продавленная клетка (она передаёт опору,
  //    сама стоя с нулём) и не застывшее масло (своя связь);
  //  - новое твёрдое — не в нижнем ряду и не рядом с якорем (там его
  //    засевают) и не касается клетки с устойчивостью больше нуля или
  //    продавленной: тогда оно и после пересчёта осталось бы с нулём.
  // Позиционный массив stability после такого кадра по-прежнему верен:
  // на месте ушедшего обломка был 0, и на месте пришедшего — 0. Проверка —
  // "Быстрые пути" в tools/check.js: каждый пропуск там пересчитывается
  // честно и сравнивается.
  stabChangeHarmless(i, old, now) {
    const stab = this.stability;
    if (stab[i] !== 0) return false;
    if ((old | now) & 0xC000) return false;   // балка (0x8000) или продавленная (0x4000)
    if (old !== 0) {
      const ot = (old & 0x7f) - 1;
      if (IS_ANCHOR[ot] === 1 || ot === EL.OILFILM) return false;
    }
    if (now !== 0) {
      const type = this.type, t = type[i];
      if (IS_ANCHOR[t] === 1 || t === EL.OILFILM) return false;
      const w = this.w, h = this.h, x = i % w, y = (i / w) | 0;
      if (y === h - 1) return false;
      const crushed = this.crushed;
      if (x > 0 && (stab[i - 1] !== 0 || IS_ANCHOR[type[i - 1]] === 1 || crushed[i - 1] !== 0)) return false;
      if (x < w - 1 && (stab[i + 1] !== 0 || IS_ANCHOR[type[i + 1]] === 1 || crushed[i + 1] !== 0)) return false;
      if (y > 0 && (stab[i - w] !== 0 || IS_ANCHOR[type[i - w]] === 1 || crushed[i - w] !== 0)) return false;
      if (stab[i + w] !== 0 || IS_ANCHOR[type[i + w]] === 1 || crushed[i + w] !== 0) return false;
    }
    return true;
  }

  // Подпись одной клетки для structureChanged.
  stabSignature(i) {
    const t = this.type[i];
    if (IS_STRUCTURAL[t] === 1 || IS_ANCHOR[t] === 1) {
      let s = t + 1;
      if (this.crushed[i]) s |= 0x4000;   // продавленная держится иначе (см. zeroCrushedStability)
      if (t === EL.OILFILM) s |= this.extra[i] << 7;
      // Устойчивость и стойкость сплава — по его долям: ржавление доли
      // может их поменять, не меняя типа клетки (4 и 3 бита хватает:
      // устойчивость до 14, стойкость до 7).
      else if (t === EL.ALLOY) s |= (this.alloyStability(i) & 15) << 7 | (this.alloyToughness(i) & 7) << 11;
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
    const beam = this.beam;
    this._beamGen = (this._beamGen || 0) + 1;
    // Едущие с падающим телом группы этого кадра (см. beamGroupLoose, rideBeams).
    if (!this._rideGroups) this._rideGroups = new Int32Array(BEAM_RIDE_MAX_GROUPS * 4);
    this._rideN = 0; this._rideCellN = 0; this._rideDebN = 0;
    // Балок на поле обычно единицы, а проход по 187 тыс. байт по одному
    // стоил полмиллисекунды каждый кадр. Слой читается словами по 4
    // клетки: нулевое слово — четыре клетки без балок разом. Порядок
    // клеток тот же (по возрастанию), так что и итог тот же. Вид
    // заводится заново, если массив заменили (общая память потоков).
    if (!this._beamWords || this._beamWords.buffer !== beam.buffer) this._beamWords = new Uint32Array(beam.buffer, 0, n >> 2);
    const words = this._beamWords, nw = n >> 2;
    for (let k = 0; k < nw; k++) {
      if (words[k] === 0) continue;
      for (let i = k << 2, e = i + 4; i < e; i++) if (beam[i]) this.updateBeamCell(i);
    }
    for (let i = nw << 2; i < n; i++) if (beam[i]) this.updateBeamCell(i);
  }

  // Одна клетка с балкой (см. updateBeams).
  updateBeamCell(i) {
    const beam = this.beam, type = this.type, stab = this.stability;
    const t = type[i];
    const ownStability = IS_STRUCTURAL[t] !== 1 && IS_ANCHOR[t] !== 1;
    // Балка осыпается, только когда её связная группа (соседние по
    // стороне балки) не касается ни одного пикселя вещества (просьба
    // пользователя). Раньше — как только устойчивость падала до нуля: тело,
    // к которому она прикреплена, чуть сдвигалось, и балка тут же
    // становилась камнем, непроходимым для всего. Держит балка, как и
    // прежде, по устойчивости (computeStability); висеть, пока касается
    // чего-то, может и без неё.
    if (ownStability && stab[i] === 0 && this.beamGroupLoose(i)) return;
    // У материала без точки плавления (дерево, лёд) meltRoll просто
    // ложна — и случайное число не тратится.
    const mat = beam[i];
    if (t === EL.EMPTY && this.meltRoll(i, mat)) {
      this.removeBeam(i);
      this.spawn(i, ELEMENTS[mat].meltsInto, false);
    }
  }

  // Группа балок клетки i ни к чему не прикасается — тогда она вся
  // осыпается (true). Касанием считается любой сосед (и содержимое самих
  // клеток группы), кроме пустоты и газа, а ещё нижний край поля. Группа
  // обходится один раз за кадр: остальные её клетки видят пометку
  // _beamSeen и ответ _beamLoose.
  //
  // Группа без опоры, которая касается падающего тела (обломков со
  // стойкостью 0) и ничего держащегося, записывается в "едущие"
  // (_ride*): после обхода клеток rideBeams опустит её вместе с телом.
  // Иначе тело проваливалось сквозь свои балки (движение о них не знает),
  // они оставались висеть и, когда тело уходило, осыпались отдельно
  // камнем (жалоба "балки вылетают из структуры во время её падения").
  beamGroupLoose(i) {
    const n = this.w * this.h, w = this.w, h = this.h;
    if (!this._beamSeen || this._beamSeen.length !== n) { this._beamSeen = new Int32Array(n); this._beamStack = new Int32Array(n); this._beamList = new Int32Array(n); }
    const seen = this._beamSeen, gen = this._beamGen;
    if (seen[i] === gen) return false;   // группа уже решена и оставлена
    const beam = this.beam, type = this.type, stab = this.stability, stack = this._beamStack, list = this._beamList;
    if (!this._rideDebris || this._rideDebris.length !== n) { this._rideDebris = new Int32Array(n); this._rideCells = new Int32Array(n); }
    const debris = this._rideDebris, deb0 = this._rideDebN;
    let sp = 0, cnt = 0, touches = false, held = false, debN = deb0;
    stack[sp++] = i; seen[i] = gen;
    while (sp > 0) {
      const c = stack[--sp];
      list[cnt++] = c;
      const x = c % w, y = (c / w) | 0;
      if (y === h - 1) { touches = true; held = true; }
      const ct = type[c];
      if (ct !== EL.EMPTY && IS_GASLIKE[ct] !== 1) touches = true;
      // Своя стойкость больше нуля (часть группы держится) или в клетке
      // лежит держащееся твёрдое — группа стоит, никуда не едет.
      if (IS_ANCHOR[ct] === 1 || stab[c] > 0) held = true;
      for (let k = 0; k < 4; k++) {
        const nx = x + DX4[k], ny = y + DY4[k];
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const j = ny * w + nx;
        if (beam[j]) { if (seen[j] !== gen) { seen[j] = gen; stack[sp++] = j; } continue; }
        const nt = type[j];
        if (nt !== EL.EMPTY && IS_GASLIKE[nt] !== 1) touches = true;
        if (IS_ANCHOR[nt] === 1 || (IS_STRUCTURAL[nt] === 1 && stab[j] > 0)) held = true;
        else if (IS_STRUCTURAL[nt] === 1) debris[debN++] = j;
      }
    }
    if (touches && !held && debN > deb0 && this._rideN < BEAM_RIDE_MAX_GROUPS) {
      const g = this._rideN++ * 4, groups = this._rideGroups, cells = this._rideCells;
      groups[g] = this._rideCellN; groups[g + 1] = cnt;
      groups[g + 2] = deb0; groups[g + 3] = debN - deb0;
      cells.set(list.subarray(0, cnt), this._rideCellN);
      this._rideCellN += cnt;
      this._rideDebN = debN;
    }
    if (touches) return false;
    // Осыпавшаяся балка становится своим материалом — но только если
    // клетка свободна. Занятую (газом) не трогаем: балка исчезает, ничего
    // никуда не вытесняя.
    for (let k = 0; k < cnt; k++) {
      const c = list[k];
      if (type[c] === EL.EMPTY) this.dropBeam(c); else this.removeBeam(c);
    }
    return true;
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

  // После обхода клеток: группы, записанные в beamGroupLoose как едущие
  // с падающим телом, опускаются на клетку, если тело рядом с ними в этом
  // кадре действительно упало (не меньше половины соседних обломков
  // оказались клеткой ниже: moved и fall). Решать после обхода, а не до
  // него, — чтобы балка не обгоняла тело, которое застряло или легло.
  // Опускается группа целиком, только если под ней нет ничего, куда балку
  // не ставят (твёрдое держащееся, сыпучее, люди): в падающее тело —
  // можно, оно и так проходит сквозь балки.
  rideBeams() {
    const nGroups = this._rideN;
    if (!nGroups) return;
    const w = this.w, n = w * this.h;
    const beam = this.beam, beamExtra = this.beamExtra, type = this.type, moved = this.moved, fall = this.fall;
    const groups = this._rideGroups, cells = this._rideCells, debris = this._rideDebris;
    if (!this._rideMark || this._rideMark.length !== n) { this._rideMark = new Int32Array(n); this._rideStamp = 0; }
    const mark = this._rideMark;
    for (let g = 0; g < nGroups; g++) {
      const c0 = groups[g * 4], cn = groups[g * 4 + 1], d0 = groups[g * 4 + 2], dn = groups[g * 4 + 3];
      let fell = 0;
      for (let k = d0; k < d0 + dn; k++) {
        const j = debris[k] + w;
        if (j < n && moved[j] && fall[j] && IS_STRUCTURAL[type[j]] === 1) fell++;
      }
      if (fell * 2 < dn) continue;
      const stamp = ++this._rideStamp;
      for (let k = c0; k < c0 + cn; k++) mark[cells[k]] = stamp;
      let blocked = false;
      for (let k = c0; k < c0 + cn; k++) {
        const c = cells[k];
        // Группу могла сдвинуть на себя соседняя едущая — тогда клетки уже нет.
        if (!beam[c]) { blocked = true; break; }
        const j = c + w;
        if (j >= n) { blocked = true; break; }
        if (mark[j] === stamp) continue;
        if (beam[j]) { blocked = true; break; }
        const t = type[j];
        if (t === EL.EMPTY || IS_GASLIKE[t] === 1 || IS_LIQUID[t] === 1) continue;
        if (IS_STRUCTURAL[t] === 1 && fall[j] && moved[j]) continue;
        blocked = true; break;
      }
      if (blocked) continue;
      // Снизу вверх: клетка под балкой группы освобождается раньше, чем в
      // неё переедет верхняя.
      const list = cells.subarray(c0, c0 + cn).sort();
      for (let k = cn - 1; k >= 0; k--) {
        const c = list[k], j = c + w;
        beam[j] = beam[c]; beamExtra[j] = beamExtra[c];
        beam[c] = 0; beamExtra[c] = 0;
        this.markDirty(c); this.markDirty(j);
      }
    }
    this._rideN = 0;
  }

  // maxStability/toughness клетки с поправкой на стадию окисления (у балки
  // — по стадии её материала, см. stabFrail).
  cellStability(i, id) {
    if (id === EL.ALLOY) return this.alloyStability(i);   // средняя по долям (sim/alloys.js)
    if (this.stabFrail(i)) return OXIDE_FRAIL_STABILITY;
    return STAB_MAX[id];
  }

  cellToughness(i, id) {
    if (id === EL.ALLOY) return this.alloyToughness(i);
    if (this.stabFrail(i)) return OXIDE_FRAIL_TOUGHNESS;
    return STAB_TOUGHNESS[id];
  }
}

extendSim(SimStability);
