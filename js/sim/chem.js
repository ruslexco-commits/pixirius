'use strict';

// Учёт простых веществ на карте (формулы веществ — data/chem.js).
//
// Просьба пользователя: что бы ни происходило на карте, количество каждого
// простого вещества должно оставаться одним и тем же — будущие живые клетки
// не должны "съесть всю воду и исчезнуть сами". Вещество на карте — это
// клетки (их доли по формулам, плюс побочные поля), а всё, что из клеток
// уходит "в никуда" (догоревший огонь, рассеявшийся дым, израсходованная
// кислота) или приходит "ниоткуда" (кислород в ржавчину), — это обмен с
// ВОЗДУХОМ: невидимым общим запасом простых веществ на поле (chemAir).
//
// Как считается, не трогая ни одной реакции. Поле разбито на куски сна
// (sim/sleep.js), и любая запись в клетку уже обязана звать markDirty —
// значит, куски, где хоть что-то поменялось, известны (markDirty ставит и
// свою пометку учёта, _chemDirty: пометки сна updateSleep снимает посреди
// кадра, а учёту нужно "с прошлого пересчёта"). У каждого куска
// запомнено, сколько в нём долей каждого вещества (_chemHist: гистограмма
// по id плюс прямые простые вещества побочных полей). В конце кадра
// (chemEndStep) изменившиеся куски пересчитываются, разница переводится в
// простые вещества — и ровно её воздух отдаёт или забирает. Так сумма
// "клетки + воздух" сохраняется до единицы при любой механике, в том числе
// ещё не написанной, и без единой лишней операции в обходе клеток.
//
// Не всё, что меняет клетки, — химия:
//  - кисть, вставка, отмена, загрузка, действия игроков мультиплеера идут
//    МЕЖДУ кадрами. Их разницу ловит пересчёт в начале кадра (chemBeginStep)
//    и пишет в chemUser — воздух они не трогают;
//  - клонер и пустота — нарочно источник и сток вещества (так они задуманы),
//    добыча протагонистом и буром, обломки ног шароида и клетки, ушедшие в
//    сегмент, — вещество уходит "в руки" и в механизмы, которые клетками не
//    считаются. Такие места явно зовут chemExternal: разница записывается в
//    chemExt по своей статье и тоже идёт мимо воздуха. Зовут его только на
//    главном потоке (клонер и пустоту обход в полосе откладывает, см.
//    updateCell): chemExt — обычный массив главного Sim.
//
// Строгие простые вещества (кремний, железо, медь, натрий, хлор) через
// воздух ходить не должны: камень не испаряется. Если реакция всё же
// стёрла или создала строгое, сумма всё равно сходится (оно уходит в воздух),
// а ошибка копится в chemLeak — её ловит tools/chem-check.js.
//
// Решение "хватит ли в воздухе" (chemAirHas) принимается по воздуху на
// начало кадра: за кадр воздух не меняется, поэтому ответ одинаков у всех
// потоков и у всех вкладок мультиплеера (chemAir — общий массив потоков,
// THREAD_SHARED_FIELDS).
//
// Методы класса Sim, вынесенные в отдельный файл: класс ниже — только
// контейнер, extendSim переносит его методы в Sim.prototype (см. core.js).

// Гистограмма куска: доли по id элемента, за ними — прямые простые вещества
// (кислород стадии окисла).
const CHEM_HIST = EL_LIMIT + CHEM_N;
// Статьи внешнего обмена (chemExt).
// "Живое" — вещество, которое сейчас сидит внутри живых существ (chemBite /
// chemRelease): с карты съедено, но не пропало — вернётся, когда существо
// отдаст его миру.
const CHEM_EXT_CLONE = 0;
const CHEM_EXT_VOID = 1;
const CHEM_EXT_MINE = 2;
const CHEM_EXT_MECH = 3;
const CHEM_EXT_LIFE = 4;
const CHEM_EXT_N = 5;
const CHEM_EXT_NAMES = ['Клонер', 'Пустота', 'Добыча игроков', 'Механизмы', 'Живое'];
// У живых поле dirt — урон, а не грязь на пикселе (sim/human.js).
const CHEM_LIVING = idTable([EL.HUMAN, EL.PROTAGONIST, EL.COLONIST]);
// Влага земли (moisture): единица — одна впитанная клетка воды.
const CHEM_MOIST = idTable([EL.EARTH, EL.WET_EARTH]);
// Стадия окисла по типу клетки: рыхлый (не "весь рыхлый") — всегда
// последняя стадия линейки, остальные — extra (см. Sim.oxideStage).
const CHEM_STAGE_FIXED = new Uint8Array(EL_LIMIT);
for (let id = 0; id < EL_LIMIT; id++) {
  const line = OXIDE_LINE[id];
  if (line && id === line.loose && !line.allLoose && id !== line.base) CHEM_STAGE_FIXED[id] = line.maxStage;
}

// Составы веществ, которые появляются из воздуха (chemAirHas у мест, где
// они рождаются из ничего).
const SMOKE_COMP = pureCompFor(EL.SMOKE);
const FIRE_COMP = pureCompFor(EL.FIRE);
const BLOOD_COMP = pureCompFor(EL.BLOOD);

class SimChem {
  initChem() {
    // Воздух — мир (сохраняется в файл, в снимок отмены и в мир
    // мультиплеера). Массив не заменять, только set/fill: потоки видят его
    // через общую память.
    this.chemAir = new Float64Array(CHEM_N);
    this.chemAirReset();
    // Внешний обмен по статьям (CHEM_EXT_*), накопленный: + пришло на карту.
    this.chemExt = new Float64Array(CHEM_EXT_N * CHEM_N);
    // Правки игрока между кадрами (кисть, отмена, загрузка) — справочно.
    this.chemUser = new Float64Array(CHEM_N);
    // Строгое, ушедшее в воздух или взятое из него: ошибка реакции. Норма — нули.
    this.chemLeak = new Float64Array(CHEM_N);
    this._chemExtFrame = new Float64Array(CHEM_N);
    this._chemHist = null;   // заводится и заполняется в первом кадре
    this._chemTmp = new Float64Array(CHEM_HIST);
    this._chemDelta = new Float64Array(CHEM_HIST);
    this._chemVec = new Float64Array(CHEM_N);
    this.chemOn = true;
  }

  // Воздух нового поля (CHEM_AIR_PER_CELL на клетку).
  chemAirReset() {
    const cells = this.w * this.h;
    for (let a = 0; a < CHEM_N; a++) this.chemAir[a] = Math.round(CHEM_AIR_PER_CELL[a] * cells);
  }

  // Запас воздуха по простому веществу (см. CHEM_AIR_RESERVE): от размера
  // поля, не от того, сколько воздуха сейчас.
  chemReserve(a) {
    return Math.max(CHEM_AIR_RESERVE_MIN, CHEM_AIR_RESERVE * CHEM_AIR_PER_CELL[a] * this.w * this.h);
  }

  // Мир заменён целиком (отмена, загрузка, мир мультиплеера): кэш кусков
  // устарел, в следующем кадре он пересчитается заново, без обмена с
  // воздухом.
  chemInvalidate() { this._chemHist = null; }

  // Поле очищено: и воздух — как у нового поля.
  chemClear() {
    this.chemAirReset();
    this.chemExt.fill(0);
    this.chemUser.fill(0);
    this.chemLeak.fill(0);
    this._chemHist = null;
  }

  // Начало кадра: правки между кадрами — в chemUser.
  chemBeginStep() {
    this._chemInStep = true;
    if (!this.chemOn) return;
    if (!this._chemHist) { this.chemResync(); return; }
    const d = this.chemScan(false);
    for (let a = 0; a < CHEM_N; a++) this.chemUser[a] += d[a];
  }

  // Конец кадра: всё, что изменилось в клетках и не объяснено внешним
  // обменом, — обмен с воздухом.
  chemEndStep() {
    this._chemInStep = false;
    if (!this.chemOn || !this._chemHist) return;
    const d = this.chemScan(false), ext = this._chemExtFrame;
    for (let a = 0; a < CHEM_N; a++) {
      const v = d[a] - ext[a];
      ext[a] = 0;
      if (v === 0) continue;
      this.chemAir[a] -= v;
      if (CHEM_STRICT[a]) this.chemLeak[a] += v;
    }
  }

  // Пересчитать кэш всех кусков заново (без обмена с воздухом).
  chemResync() {
    const count = this._chunkW * this._chunkH;
    if (!this._chemHist || this._chemHist.length !== count * CHEM_HIST) this._chemHist = new Float64Array(count * CHEM_HIST);
    this.chemScan(true);
    this._chemExtFrame.fill(0);
  }

  // Пересчитать изменившиеся куски (all — все), обновить кэш и снять
  // пометки. Возвращает разницу в простых веществах (_chemVec).
  chemScan(all) {
    const hist = this._chemHist, tmp = this._chemTmp, delta = this._chemDelta;
    const dirty = this._chemDirty;
    const count = this._chunkW * this._chunkH;
    delta.fill(0);
    let any = false;
    for (let c = 0; c < count; c++) {
      if (!all && dirty[c] === 0) continue;
      dirty[c] = 0;
      this.chemChunkHist(c, tmp);
      const base = c * CHEM_HIST;
      for (let k = 0; k < CHEM_HIST; k++) {
        const v = tmp[k], dv = v - hist[base + k];
        if (dv !== 0) { delta[k] += dv; hist[base + k] = v; any = true; }
      }
    }
    const out = this._chemVec;
    out.fill(0);
    if (!any) return out;
    for (let id = 0; id < EL_LIMIT; id++) {
      const n = delta[id];
      if (n === 0) continue;
      const f = id * CHEM_N;
      for (let a = 0; a < CHEM_N; a++) out[a] += n * CHEM_FORMULA[f + a];
    }
    for (let a = 0; a < CHEM_N; a++) out[a] += delta[EL_LIMIT + a];
    return out;
  }

  // Гистограмма куска c в tmp: доли по id и прямые простые вещества.
  chemChunkHist(c, tmp) {
    tmp.fill(0);
    const w = this.w, cw = this._chunkW;
    const x0 = (c % cw) * SLEEP_CHUNK, y0 = ((c / cw) | 0) * SLEEP_CHUNK;
    const x1 = Math.min(w, x0 + SLEEP_CHUNK), y1 = Math.min(this.h, y0 + SLEEP_CHUNK);
    const type = this.type, sol = this.sol, sol2 = this.sol2, beam = this.beam;
    const extra = this.extra, moisture = this.moisture, dirt = this.dirt;
    const O = EL_LIMIT + CHEM.O;
    for (let y = y0; y < y1; y++) {
      for (let i = y * w + x0, e = y * w + x1; i < e; i++) {
        const t = type[i];
        if (t !== 0) {
          const lo = sol[i];
          let s = lo & 1023;
          if (s) { tmp[s & 63] += s >>> 6; s = (lo >>> 10) & 1023;
            if (s) { tmp[s & 63] += s >>> 6; s = (lo >>> 20) & 1023;
              if (s) { tmp[s & 63] += s >>> 6; const hi = sol2[i];
                if (hi) { s = hi & 1023; if (s) { tmp[s & 63] += s >>> 6; s = (hi >>> 10) & 1023; if (s) tmp[s & 63] += s >>> 6; } } } } }
          if (CHEM_STAGE_O[t] !== 0) tmp[O] += CHEM_STAGE_O[t] * (CHEM_STAGE_FIXED[t] || extra[i] || 1);
          if (CHEM_MOIST[t] === 1) tmp[EL.WATER] += moisture[i] * SOL_PARTS;
          if (CHEM_LIVING[t] !== 1) { const d = dirt[i]; if (d !== 0) tmp[EL.MUD] += (d / MUD_DIRT_PER_PART) | 0; }
        }
        const b = beam[i];
        if (b !== 0) {
          tmp[b] += SOL_PARTS;
          if (CHEM_STAGE_O[b] !== 0) tmp[O] += CHEM_STAGE_O[b] * (this.beamExtra[i] || 1);
        }
      }
    }
  }

  // Простые вещества клетки i: out += sign * (всё, что в ней лежит), по тем
  // же правилам, что и chemChunkHist. noBeam — без балки второго слоя
  // (clearCell и spawn её не трогают).
  chemCellAdd(i, out, sign, noBeam) {
    const t = this.type[i];
    if (t !== 0) {
      chemAddComp(this.comp(i), out, sign);
      if (CHEM_STAGE_O[t] !== 0) out[CHEM.O] += sign * CHEM_STAGE_O[t] * (CHEM_STAGE_FIXED[t] || this.extra[i] || 1);
      if (CHEM_MOIST[t] === 1) for (let a = 0; a < CHEM_N; a++) out[a] += sign * this.moisture[i] * SOL_PARTS * CHEM_FORMULA[EL.WATER * CHEM_N + a];
      if (CHEM_LIVING[t] !== 1 && this.dirt[i]) {
        const n = (this.dirt[i] / MUD_DIRT_PER_PART) | 0;
        for (let a = 0; a < CHEM_N; a++) out[a] += sign * n * CHEM_FORMULA[EL.MUD * CHEM_N + a];
      }
    }
    const b = noBeam ? 0 : this.beam[i];
    if (b !== 0) {
      for (let a = 0; a < CHEM_N; a++) out[a] += sign * SOL_PARTS * CHEM_FORMULA[b * CHEM_N + a];
      if (CHEM_STAGE_O[b] !== 0) out[CHEM.O] += sign * CHEM_STAGE_O[b] * (this.beamExtra[i] || 1);
    }
  }

  // Внешний обмен (см. шапку): клетка i вот-вот исчезнет (sign = -1, звать
  // ДО clearCell) или только что появилась (sign = +1, ПОСЛЕ spawn) не по
  // химии, а по статье cat (CHEM_EXT_*). Только главный поток.
  chemExternal(cat, i, sign) {
    // Вне кадра (действие игрока: шароид поставили, сегмент прицепили) это
    // и так правка — её поймает chemBeginStep.
    if (!this._chemInStep) return;
    const v = this._chemExtFrame, n0 = cat * CHEM_N;
    const before = this._chemTmp2 || (this._chemTmp2 = new Float64Array(CHEM_N));
    before.fill(0);
    this.chemCellAdd(i, before, sign, true);
    for (let a = 0; a < CHEM_N; a++) { v[a] += before[a]; this.chemExt[n0 + a] += before[a]; }
  }

  // То же для вещества, которое не клетка: n долей вещества id (балка,
  // нога шароида).
  chemExternalParts(cat, id, n) {
    if (!this._chemInStep) return;
    const v = this._chemExtFrame, n0 = cat * CHEM_N, f = id * CHEM_N;
    for (let a = 0; a < CHEM_N; a++) { const d = n * CHEM_FORMULA[f + a]; v[a] += d; this.chemExt[n0 + a] += d; }
  }

  // Хватит ли воздуха, чтобы из него появилось вещество состава comp (газ
  // при растворении, дым над огнём, кровь из раны). По воздуху на начало
  // кадра и с запасом chemReserve — см. шапку.
  chemAirHas(comp) {
    const need = this._chemNeed || (this._chemNeed = new Float64Array(CHEM_N));
    need.fill(0);
    chemAddComp(comp, need, 1);
    const air = this.chemAir;
    for (let a = 0; a < CHEM_N; a++) if (need[a] > 0 && air[a] - need[a] < this.chemReserve(a)) return false;
    return true;
  }

  // Итог: сколько каждого простого вещества в клетках (полный проход — для
  // справки и проверок, не для кадра).
  chemCellsTotal(out) {
    out = out || new Float64Array(CHEM_N);
    out.fill(0);
    const n = this.w * this.h;
    for (let i = 0; i < n; i++) if (this.type[i] !== 0 || this.beam[i] !== 0) this.chemCellAdd(i, out, 1);
    return out;
  }

  // Вещество в клетках по кэшу кусков (на конец прошлого кадра): сотня
  // тысяч сложений вместо полного прохода по полю — для панели "Разное",
  // которая освежается дважды в секунду. null — кэша ещё нет.
  chemCellsCached(out) {
    const hist = this._chemHist;
    if (!hist) return null;
    out = out || new Float64Array(CHEM_N);
    out.fill(0);
    const sum = this._chemDelta;
    sum.fill(0);
    for (let base = 0; base < hist.length; base += CHEM_HIST) for (let k = 0; k < CHEM_HIST; k++) sum[k] += hist[base + k];
    for (let id = 0; id < EL_LIMIT; id++) {
      const n = sum[id];
      if (n === 0) continue;
      for (let a = 0; a < CHEM_N; a++) out[a] += n * CHEM_FORMULA[id * CHEM_N + a];
    }
    for (let a = 0; a < CHEM_N; a++) out[a] += sum[EL_LIMIT + a];
    return out;
  }

  // Сводка: клетки, воздух, внешний обмен, правки игрока, утечки строгого.
  // Инвариант: клетки + воздух - внешний обмен - правки = постоянная.
  chemReport() {
    const cells = this.chemCellsTotal();
    const ext = new Float64Array(CHEM_N);
    for (let c = 0; c < CHEM_EXT_N; c++) for (let a = 0; a < CHEM_N; a++) ext[a] += this.chemExt[c * CHEM_N + a];
    const rows = {};
    for (let a = 0; a < CHEM_N; a++) {
      rows[CHEM_ATOMS[a].sym] = { cells: cells[a], air: this.chemAir[a], external: ext[a], user: this.chemUser[a], leak: this.chemLeak[a] };
    }
    return rows;
  }

  // ---- превращения, сохраняющие вещество ----

  // spawn, но доли прежнего вещества клетки становятся долями нового, а не
  // заменяются полной клеткой: неполная (растворителем, кислотой) или
  // смешанная лава застывает в столько же камня, сколько её было, а не в
  // полные десять долей (иначе кремний брался бы из ничего). Чистая полная
  // клетка — ровно spawn.
  spawnKeep(i, id, seedHeat = true) {
    const old = this.comp(i), from = this.type[i];
    const pure = old === pureCompFor(from);
    this.spawn(i, id, seedHeat);
    if (pure) return;
    const n = solGet(old, from);
    if (!n) { this.setComposition(i, old); return; }
    this.setComposition(i, solWith(solWith(old, from, 0), id, solGet(old, id) + n));
  }

  // Состав клетки после взрыва: доли — в обломки по CHEM_RUBBLE_TO (камень
  // в песок, металл в окалину), летучие без строки — сгорают, строгие без
  // строки остаются. Возвращает состав (0 — от клетки ничего не осталось) и
  // кладёт главный вид в _chemMain. -1 — клетку взрыв не берёт (строгое без
  // обломков и без летучих долей).
  chemRubble(c) {
    let out = 0, changed = false, main = 0, mainN = 0;
    for (let s = 0; s < SOL_SLOTS; s++) {
      const slot = solSlot(c, s);
      if (!slot) break;
      const id = slotId(slot), n = slotCount(slot);
      const to = CHEM_RUBBLE_TO[id] || (CHEM_HAS_STRICT[id] ? id : 0);
      if (to !== id) changed = true;
      if (!to) continue;
      const m = solGet(out, to) + n;
      out = solWith(out, to, m);
      if (m > mainN) { mainN = m; main = to; }
    }
    this._chemMain = main;
    if (!changed && solMatter(out) > 0 && !CHEM_RUBBLE_TO[main]) return -1;
    return out;
  }

  // ---- живое ест и отдаёт: вещество через тело, а не мимо учёта ----
  //
  // Просьба пользователя: живые клетки едят всё вокруг, но вещество при этом
  // сохраняется — они не должны съесть всю воду и исчезнуть. Тело живого — это
  // store: вектор простых веществ (Float64Array(CHEM_N)), который существо носит
  // с собой. Съеденное переходит с карты в store (chemBite), отданное — из
  // store обратно на карту (chemRelease) или в воздух (chemExhale); учёт ведёт
  // статья "Живое" (CHEM_EXT_LIFE), так что "клетки + воздух + store всех
  // существ" не меняется ни от одного укуса. Умерло существо — отдайте весь
  // store (chemRelease на свободных клетках вокруг, остаток — chemExhale).
  //
  // Звать надо изнутри кадра и только главным потоком (как chemExternal), то
  // есть из механики, которая считается в step на главном потоке, — иначе
  // правка клеток сойдёт за правку игрока и в учёт "Живого" не попадёт.

  // Можно ли съесть клетку i целиком: не пустота и не якорь (стена, клонер,
  // пустота), не живое (человек, протагонист), не клетка шароида и бура и не
  // с балкой (у балки нет состава, её не разобрать).
  chemEdible(i) {
    const t = this.type[i];
    return t !== EL.EMPTY && IS_ANCHOR[t] !== 1 && CHEM_LIVING[t] !== 1 && t !== EL.SHAROID && t !== EL.DRILL && this.beam[i] === 0;
  }

  // Съесть клетку i: всё, что в ней лежит (доли, влага земли, грязь, кислород
  // окисла), переходит в store, клетка пустеет. false — не съедобна.
  chemBite(i, store) {
    if (!this._chemInStep || !this.chemEdible(i)) return false;
    const v = this._chemBiteVec || (this._chemBiteVec = new Float64Array(CHEM_N));
    v.fill(0);
    this.chemCellAdd(i, v, 1, true);
    this.chemExternal(CHEM_EXT_LIFE, i, -1);
    for (let a = 0; a < CHEM_N; a++) store[a] += v[a];
    this.moisture[i] = 0;
    this.clearCell(i);
    return true;
  }

  // Отдать store в пустую клетку i: из простых веществ собираются соединения
  // (CHEM_RELEASE_ORDER: соль, камень, металлы, вода, зола), агрегат — по
  // температуре клетки. Летучего, которого store не хватает (кислород на
  // кремнезём), клетка берёт из воздуха, если его там хватает (chemReserve);
  // строгое — только из store. Возвращает, сколько долей отдано (0 — клетка
  // занята или из store ничего не сложилось).
  chemRelease(i, store) {
    if (!this._chemInStep || this.type[i] !== EL.EMPTY || this.beam[i] !== 0) return 0;
    const avail = this._chemAvail || (this._chemAvail = new Float64Array(CHEM_N));
    const before = this._chemAvail0 || (this._chemAvail0 = new Float64Array(CHEM_N));
    for (let a = 0; a < CHEM_N; a++) {
      avail[a] = store[a] + (CHEM_STRICT[a] ? 0 : Math.max(0, this.chemAir[a] - this.chemReserve(a)));
      before[a] = avail[a];
    }
    const comp = chemBuild(avail, SOL_PARTS, this.temp[i], CHEM_RELEASE_ORDER);
    if (!comp) return 0;
    // Что израсходовано: сперва из store, остаток — из воздуха (его вычтет
    // chemEndStep как разницу клеток, не объяснённую внешним обменом).
    const v = this._chemExtFrame, n0 = CHEM_EXT_LIFE * CHEM_N;
    for (let a = 0; a < CHEM_N; a++) {
      const used = before[a] - avail[a], fromStore = Math.min(store[a], used);
      store[a] -= fromStore;
      v[a] += fromStore; this.chemExt[n0 + a] += fromStore;
    }
    this.setComposition(i, comp);
    this.moved[i] = 1;
    return solMatter(comp);
  }

  // Выдохнуть из store всё летучее в воздух (углекислота, азот...): строгое
  // остаётся в store, пока ему нет места на карте. Возвращает, сколько выдохнуто.
  chemExhale(store) {
    if (!this._chemInStep) return 0;
    const n0 = CHEM_EXT_LIFE * CHEM_N;
    let total = 0;
    for (let a = 0; a < CHEM_N; a++) {
      if (CHEM_STRICT[a] || store[a] <= 0) continue;
      this.chemAir[a] += store[a];
      this.chemExt[n0 + a] += store[a];
      total += store[a];
      store[a] = 0;
    }
    return total;
  }

  // ---- изъять и добавить: основа для живых клеток ----
  //
  // Живое будет есть вещество вокруг и собирать из него себя (просьба
  // пользователя). Обмен с воздухом при этом считать не нужно: то, что ушло
  // из клеток и никуда не легло, учёт сам отдаст воздуху, а то, что появилось,
  // — возьмёт из него (заранее спросите chemAirHas). Строгое же обязано
  // остаться в клетках: его эти функции никогда не выбрасывают.

  // Простые вещества клетки i (новый вектор или out).
  chemCellAtoms(i, out) {
    out = out || new Float64Array(CHEM_N);
    out.fill(0);
    this.chemCellAdd(i, out, 1);
    return out;
  }

  // Пересобрать клетку i (без балки) из простых веществ atoms (chemBuild: соединения по
  // CHEM_BUILD_ORDER, агрегат по температуре клетки). Что не сложилось,
  // остаётся в atoms. Если в остатке есть строгое — клетка не трогается,
  // возвращается false (строгое выбросить некуда).
  chemRebuild(i, atoms) {
    const rest = atoms.slice();
    const comp = chemBuild(rest, SOL_PARTS, this.temp[i]);
    for (let a = 0; a < CHEM_N; a++) if (CHEM_STRICT[a] && rest[a] > 0) return false;
    atoms.set(rest);
    // Побочные поля, несущие вещество (влага, грязь, стадия окисла), уже
    // учтены в atoms — у новой клетки их нет.
    this.moisture[i] = 0;
    this.dirt[i] = 0;
    this.extra[i] = 0;
    this.markDirty(i);
    if (solMatter(comp) === 0) { this.clearCell(i); return true; }
    this.setComposition(i, comp);
    return true;
  }

  // Забрать из клетки i до n простого вещества atom; остальное в клетке
  // пересобирается в соединения. Возвращает, сколько забрано (0 — не
  // вышло: например, остаток строгого не складывается ни во что).
  chemTake(i, atom, n) {
    // Балку и живых не разбираем: у балки нет состава, у живых dirt — урон.
    if (this.beam[i] || CHEM_LIVING[this.type[i]] === 1) return 0;
    const atoms = this.chemCellAtoms(i);
    const take = Math.min(n, atoms[atom]);
    if (take <= 0) return 0;
    atoms[atom] -= take;
    return this.chemRebuild(i, atoms) ? take : 0;
  }
}

extendSim(SimChem);
