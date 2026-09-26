'use strict';

// Сон покоящихся кусков поля. Поле разбито на куски SLEEP_CHUNK x
// SLEEP_CHUNK клеток; кусок, где несколько кадров подряд ничего не
// менялось и где ничего не может начаться само, засыпает, и обход клеток
// (Sim.updateRows) его пропускает. Лежащий песок, стоящая вода,
// нетронутый камень перестают тратить время кадра.
//
// Правила игры от этого не меняются: спящая клетка — это клетка, которая
// в этом кадре всё равно ничего бы не сделала. Меняется только порядок
// случайных чисел (их тратят лишь бодрствующие клетки), поэтому
// tools/compare.js со старыми коммитами больше не совпадает побайтно.
//
// Главная опасность — усыпить то, что должно происходить. Поэтому кусок
// засыпает, только если ни одна его клетка не "беспокойна" (restlessCell:
// огонь, кислота, газы, люди, ржавление под водой, смешивание разных
// составов, обломки, температура у точки перехода...), и спящий кусок
// будят, не дожидаясь изменений его клеток:
//  - запись в его клетки (движение, spawn, смена состава) — _chunkDirty;
//  - нагрев или охлаждение за безопасные для его веществ пределы
//    (SAFE_LO/SAFE_HI: вода — от 0 до 100, камень — до плавления...);
//  - ветер сильнее WIND_PUSH_MIN (он толкает вещество);
//  - обломки (устойчивость 0) после пересчёта устойчивости;
//  - смена флага "у лужи есть выход" (тонущее тело может провалиться).
// И наконец, клетки рядом с бодрствующим куском считаются всегда
// (_chunkActive — бодрствующие куски и их соседи): огонь поджигает дерево
// через границу куска, лава плавит соседний песок.
//
// Методы класса Sim, вынесенные в отдельный файл: класс ниже — только
// контейнер, extendSim переносит его методы в Sim.prototype (см. core.js).

// Сторона куска в клетках. Мельче — точнее засыпают участки, но больше
// учёта; 16 при поле 576x324 даёт 36x21 кусков.
const SLEEP_CHUNK = 16;
// Сколько кадров подряд кусок должен простоять без изменений, прежде чем
// его проверят на сон (и через сколько проверят снова, если в нём нашлось
// беспокойное).
const SLEEP_AFTER = 8;

// Всегда беспокойные элементы: у них что-то происходит каждый кадр или по
// случайному броску, даже если соседи не менялись (огонь и дым догорают,
// кислота разъедает, газы дрейфуют и конденсируются, люди ходят...).
const RESTLESS_TYPE = idTable([
  EL.FIRE, EL.SMOKE, EL.LAVA, EL.ACID, EL.REAGENT, EL.SOLUTION, EL.DISSOLVER, EL.DISSOLVER_GAS,
  EL.STEAM, EL.ACID_GAS, EL.VAPOR, EL.REAGENT_GAS, EL.OIL_GAS,
  EL.HUMAN, EL.COLONIST, EL.CLONE, EL.VOID, EL.WET_EARTH,
]);

// Безопасный диапазон температур по типу клетки: SAFE_LO < T < SAFE_HI —
// ничего не расплавится, не закипит, не замёрзнет, не растает и не
// взорвётся. Вне его клетка беспокойна (и спящий кусок просыпается).
const SAFE_LO = new Float64Array(64).fill(-Infinity);
const SAFE_HI = new Float64Array(64).fill(Infinity);
for (const [liquid, , solid, boil, freeze] of PHASE_LINKS) {
  SAFE_LO[liquid] = freeze;                    // замерзает при T <= freeze
  SAFE_HI[liquid] = boil;                      // кипит при T >= boil
  if (solid) SAFE_HI[solid] = freeze + 1e-9;   // тает при T > freeze
}
for (let id = 1; id < 64; id++) {
  const el = ELEMENTS[id];
  if (el && el.meltPoint !== undefined) SAFE_HI[id] = Math.min(SAFE_HI[id], el.meltPoint);
}
SAFE_HI[EL.BLACK_SALT] = Math.min(SAFE_HI[EL.BLACK_SALT], SALT_IGNITE_TEMP);   // сухая соль рвётся

class SimSleep {
  initSleep() {
    // Клетка ветра должна целиком лежать в одном куске (computeAirBlock
    // пересчитывает клетки ветра по кускам).
    if (SLEEP_CHUNK % this.airCell !== 0) throw new Error('SLEEP_CHUNK должен делиться на airCell');
    const cw = Math.ceil(this.w / SLEEP_CHUNK), ch = Math.ceil(this.h / SLEEP_CHUNK);
    this._chunkW = cw;
    this._chunkH = ch;
    const count = cw * ch;
    // Кусок каждой клетки — таблицей, чтобы пометка в горячем пути (swap)
    // была одним чтением.
    this._chunkOf = new Uint16Array(this.w * this.h);
    for (let y = 0; y < this.h; y++) {
      const row = ((y / SLEEP_CHUNK) | 0) * cw;
      for (let x = 0; x < this.w; x++) this._chunkOf[y * this.w + x] = row + ((x / SLEEP_CHUNK) | 0);
    }
    this._chunkDirty = new Uint8Array(count).fill(1);   // что-то менялось в этом кадре
    // Пометки, снятые прошлым updateSleep. Общие проходы в начале кадра
    // (подпись скелета, непроницаемость воздуха) идут ДО updateSleep и
    // смотрят на dirty || prevDirty: иначе изменения, сделанные в прошлом
    // кадре уже после них (обрушение балок, смена выхода лужи), никто бы
    // не увидел — updateSleep их к тому времени сбросил бы.
    this._chunkPrevDirty = new Uint8Array(count).fill(1);
    this._chunkQuiet = new Uint16Array(count);          // кадров подряд без изменений
    this._chunkAsleep = new Uint8Array(count);
    this._chunkActive = new Uint8Array(count).fill(1);  // считать в этом кадре
    this._stabRecomputed = true;
    // Выключатель — для сравнения и на случай, если сон что-то проспит.
    this.sleepEnabled = true;
  }

  // Запись — только если флаг ещё не стоит. Флаги соседних кусков лежат в
  // одной строке кэша, и при параллельном обходе (sim/threads.js) потоки
  // соседних полос, записывая 1 поверх 1 на каждой клетке, гоняли эту
  // строку между ядрами: полоса в 4 потока считалась в полтора раза
  // дольше, чем в одном. Чтение строку ни у кого не отнимает.
  markDirty(i) {
    const c = this._chunkOf[i];
    if (this._chunkDirty[c] === 0) this._chunkDirty[c] = 1;
  }

  // Менялось ли что-то в куске с прошлого прохода (см. _chunkPrevDirty).
  chunkChanged(c) { return this._chunkDirty[c] === 1 || this._chunkPrevDirty[c] === 1; }

  // Разбудить всё поле: после отмены, загрузки, очистки — там меняются
  // сразу все клетки в обход обычных записей.
  wakeAll() {
    this._chunkDirty.fill(1);
    this._chunkPrevDirty.fill(1);
    this._chunkAsleep.fill(0);
    this._chunkActive.fill(1);
  }

  // Раз в кадр, после всех общих проходов (устойчивость, ветер, тепло,
  // выходы луж) и до обхода клеток: кто спит, кто просыпается, кого
  // считать.
  updateSleep() {
    const count = this._chunkW * this._chunkH;
    const dirty = this._chunkDirty, quiet = this._chunkQuiet, asleep = this._chunkAsleep;
    const prev = this._chunkPrevDirty;
    for (let c = 0; c < count; c++) {
      prev[c] = dirty[c];
      if (dirty[c]) { dirty[c] = 0; quiet[c] = 0; asleep[c] = 0; }
      else if (quiet[c] < 65535) quiet[c]++;
    }
    const active = this._chunkActive;
    if (!this.sleepEnabled) { asleep.fill(0); active.fill(1); return; }
    const stabRe = this._stabRecomputed;
    this._stabRecomputed = false;
    for (let c = 0; c < count; c++) {
      if (asleep[c]) {
        if (this.chunkMustWake(c, stabRe)) { asleep[c] = 0; quiet[c] = 0; }
      } else if (quiet[c] >= SLEEP_AFTER) {
        if (this.chunkRestless(c)) quiet[c] = 0;   // проверим снова через SLEEP_AFTER кадров
        else asleep[c] = 1;
      }
    }
    // Считать бодрствующие куски и их соседей (взаимодействие через
    // границу куска: огонь рядом с деревом, лава рядом с песком).
    const cw = this._chunkW, ch = this._chunkH;
    for (let cy = 0; cy < ch; cy++) {
      for (let cx = 0; cx < cw; cx++) {
        let on = 0;
        for (let dy = -1; dy <= 1 && !on; dy++) {
          const yy = cy + dy;
          if (yy < 0 || yy >= ch) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = cx + dx;
            if (xx < 0 || xx >= cw) continue;
            if (!asleep[yy * cw + xx]) { on = 1; break; }
          }
        }
        active[cy * cw + cx] = on;
      }
    }
  }

  // Границы куска c в клетках.
  chunkBounds(c) {
    const cx = c % this._chunkW, cy = (c / this._chunkW) | 0;
    const x0 = cx * SLEEP_CHUNK, y0 = cy * SLEEP_CHUNK;
    return [x0, y0, Math.min(this.w, x0 + SLEEP_CHUNK), Math.min(this.h, y0 + SLEEP_CHUNK)];
  }

  // Спящий кусок просыпается без записи в его клетки: тепло вышло за
  // безопасные пределы, поднялся сильный ветер, после пересчёта
  // устойчивости в нём оказались обломки.
  chunkMustWake(c, stabRecomputed) {
    const [x0, y0, x1, y1] = this.chunkBounds(c);
    const w = this.w, type = this.type, temp = this.temp, stab = this.stability;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * w + x;
        const t = type[i];
        if (t === EL.EMPTY) continue;
        const T = temp[i];
        if (!(T > SAFE_LO[t] && T < SAFE_HI[t])) return true;
        if (stabRecomputed && IS_STRUCTURAL[t] === 1 && stab[i] === 0) return true;
      }
    }
    return this.chunkWindy(x0, y0, x1, y1);
  }

  // Ветер в куске, способный толкнуть вещество (tryWindPush).
  chunkWindy(x0, y0, x1, y1) {
    const ac = this.airCell, aw = this.airW;
    const ax0 = (x0 / ac) | 0, ax1 = Math.min(this.airW - 1, ((x1 - 1) / ac) | 0);
    const ay0 = (y0 / ac) | 0, ay1 = Math.min(this.airH - 1, ((y1 - 1) / ac) | 0);
    for (let ay = ay0; ay <= ay1; ay++) {
      for (let ax = ax0; ax <= ax1; ax++) {
        const ai = ay * aw + ax;
        if (Math.abs(this.windVXFrame[ai]) + Math.abs(this.windVYFrame[ai]) > WIND_PUSH_MIN) return true;
      }
    }
    return false;
  }

  // Есть ли в куске хоть одна беспокойная клетка (или сильный ветер).
  chunkRestless(c) {
    const [x0, y0, x1, y1] = this.chunkBounds(c);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (this.restlessCell(x, y, y * this.w + x)) return true;
      }
    }
    return this.chunkWindy(x0, y0, x1, y1);
  }

  // Может ли в клетке что-то произойти само, при неизменных соседях.
  // Движение сюда не входит: клетка, которая могла сдвинуться, сдвинулась
  // бы — и кусок не был бы спокойным (а падение, растекание и всплытие при
  // занятых соседях не срабатывают ни при каком броске). Входит всё, что
  // идёт по броску или по времени. Условие нарочно осторожное: лишний раз
  // не уснуть дешевле, чем проспать ржавчину.
  restlessCell(x, y, i) {
    const t = this.type[i];
    if (t === EL.EMPTY) return false;
    if (RESTLESS_TYPE[t] === 1) return true;
    const T = this.temp[i];
    if (!(T > SAFE_LO[t] && T < SAFE_HI[t])) return true;
    if (IS_STRUCTURAL[t] === 1 && this.stability[i] === 0) return true;
    if (hasComposition(t)) {
      // Смесь или неполная клетка — перемешивание и стягивание идут по
      // броску всегда; чистая полная клетка — пока соседи той же среды с
      // тем же составом.
      const comp = this.comp(i);
      if (comp >= 1024 || solMatter(comp) < SOL_PARTS) return true;
      if (this.neighbourMixes(x, y, t, comp)) return true;
    }
    if (t === EL.WATER || t === EL.SALT || t === EL.ICE || t === EL.EARTH) {
      if (t === EL.EARTH && this.moisture[i] > 0) return true;
      if (this.neighbourReacts(x, y, t)) return true;
      // Вода в клетке с металлической балкой ржавит её.
      if (t === EL.WATER && this.beam[i] && OXIDE_LINE[this.beam[i]] && OXIDE_LINE[this.beam[i]].waterRusts) return true;
    }
    // Окисел камня делится стадией с соседом, если разница стадий >= 2;
    // ржавчина с 4-й стадии окисляет соседей (sim/oxides.js).
    if (t === EL.OXIDE || t === EL.OXIDE_LOOSE) {
      const s = this.oxideStage(i);
      if (s >= 2 && this.neighbourOxideBelow(x, y, i, s - 2)) return true;
    }
    if ((t === EL.METAL_OXIDE || t === EL.METAL_OXIDE_LOOSE) && this.oxideStage(i) >= RUST_SPREAD_FROM) return true;
    return false;
  }

  // Сосед той же среды с другим составом — перемешивание идёт.
  neighbourMixes(x, y, t, comp) {
    for (let k = 0; k < 4; k++) {
      const nx = x + DX4[k], ny = y + DY4[k];
      if (!this.inBounds(nx, ny)) continue;
      const ni = this.idx(nx, ny);
      if (this.samePartsFamily(t, this.type[ni]) && this.comp(ni) !== comp) return true;
    }
    return false;
  }

  // Соседи, с которыми у воды, соли, льда и земли идёт реакция по броску:
  // вода ржавит металл (и его ржавчину), соль растворяется в воде, лёд
  // замораживает воду, земля впитывает воду.
  neighbourReacts(x, y, t) {
    for (let k = 0; k < 4; k++) {
      const nx = x + DX4[k], ny = y + DY4[k];
      if (!this.inBounds(nx, ny)) continue;
      const nt = this.type[this.idx(nx, ny)];
      if (t === EL.WATER) {
        const line = OXIDE_LINE[nt];
        if (line && line.waterRusts) return true;
      } else if (nt === EL.WATER) return true;
    }
    return false;
  }

  neighbourOxideBelow(x, y, i, maxStage) {
    const line = OXIDE_LINE[this.type[i]];
    for (let k = 0; k < 4; k++) {
      const nx = x + DX4[k], ny = y + DY4[k];
      if (!this.inBounds(nx, ny)) continue;
      const ni = this.idx(nx, ny);
      if (OXIDE_LINE[this.type[ni]] !== line) continue;
      const s = this.oxideStage(ni);
      if (s >= 0 && s <= maxStage) return true;
    }
    return false;
  }

  // Доля бодрствующих кусков (для замеров и отладки).
  sleepStats() {
    const count = this._chunkW * this._chunkH;
    let asleep = 0, active = 0;
    for (let c = 0; c < count; c++) { if (this._chunkAsleep[c]) asleep++; if (this._chunkActive[c]) active++; }
    return { count, asleep, active };
  }
}

extendSim(SimSleep);
