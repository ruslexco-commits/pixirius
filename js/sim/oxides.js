'use strict';

// Окислы: стадия клетки в своей линейке (данные — data/oxides.js),
// хрупкость и кислотостойкость по стадии, прорастание окисла камня вглубь.
//
// Методы класса Sim, вынесенные в отдельный файл: класс ниже — только
// контейнер, extendSim переносит его методы в Sim.prototype (см. core.js).

// Шанс в кадр, с которым окисел делится стадией с соседом (см.
// reactOxide). Не каждый кадр: иначе слой прорастал бы вглубь камня
// мгновенно, а он должен именно нарастать на глазах.
const OXIDE_SPREAD_CHANCE = 0.05;

// Газ реагента, выходящий из плавящегося окисла камня, всплывает вверх
// сквозь жидкость и газ (в том числе сквозь саму лаву) до первой пустой
// клетки, но не дальше стольких клеток (см. gasOutlet).
const OXIDE_GAS_RISE = 40;

// Ржавчина по стадиям (просьба пользователя):
//   1..3 — соседей не окисляет;
//   4..5 — отдаёт свою стадию соседям, у которых стадия ниже
//          RUST_LIMITED_TARGET, пока сама не опустится ниже 4;
//   6..7 — делится стадией, как окисел камня (S - T >= 2).
const RUST_SPREAD_FROM = 4;
const RUST_LIMITED_UP_TO = 5;
const RUST_LIMITED_TARGET = 2;
// Ржавчина, дошедшая под действием жидкости до стадии RUST_FLAKE_FROM и
// выше, с этим шансом меняется с этой жидкостью местами — отслаивается
// в неё, а жидкость занимает её место и ест металл дальше (см. rustFlake).
const RUST_FLAKE_FROM = 4;
const RUST_FLAKE_CHANCE = 0.3;
// Окисление меди воздухом (copperAir): шанс в кадр и предельная стадия.
const COPPER_AIR_CHANCE = 0.0004;
const COPPER_AIR_MAX_STAGE = 4;

class SimOxides {
  // Линейка окисления, к которой принадлежит клетка (камень или металл,
  // см. OXIDE_LINE в data/oxides.js), либо undefined — клетка не окисляется.
  oxideLine(i) { return OXIDE_LINE[this.type[i]]; }

  // Стадия окисла в своей линейке. Исходный материал (камень, металл) —
  // это стадия 0, "нулевой окисел": именно поэтому правила передачи
  // стадии работают с ним теми же формулами, что и с настоящим окислом.
  // Промежуточные стадии лежат в extra, последняя (всегда сыпучая) задана
  // самим типом. Всё, что вне линеек, даёт -1.
  oxideStage(i) {
    const t = this.type[i];
    const line = OXIDE_LINE[t];
    if (!line) return -1;
    if (t === line.base) return 0;
    // У линейки, сыпучей на всех стадиях (земля), один и тот же элемент
    // отвечает и за промежуточные стадии, и за последнюю, поэтому тип
    // ничего не говорит о стадии — она всегда в extra.
    if (t === line.loose && !line.allLoose) return line.maxStage;
    return this.extra[i] || 1;
  }

  // Ставит клетке стадию в её линейке: последняя — рыхлый (сыпучий)
  // элемент, промежуточные — твёрдый, ноль — снова исходный материал.
  // line можно передать явно, когда клетка ещё не принадлежит линейке
  // (например, кислотный остаток, который становится окислом металла).
  // Тип ставится напрямую, мимо spawn: температура и оттенок принадлежат
  // той же клетке и при окислении меняться не должны.
  //
  // Состав клетки следует за типом: доли прежнего элемента становятся
  // долями нового (retypeComp). Иначе состав говорил бы "металл" у клетки
  // ржавчины, и первый же пересчёт по составу (растворитель, окисление)
  // вернул бы её в металл.
  setOxideStage(i, stage, line) {
    const L = line || OXIDE_LINE[this.type[i]];
    if (!L) return;
    const old = this.type[i];
    if (stage <= 0) { this.type[i] = L.base; this.extra[i] = 0; }
    else if (stage >= L.maxStage) { this.type[i] = L.loose; this.extra[i] = L.maxStage; }
    else { this.type[i] = L.solid; this.extra[i] = stage; }
    if (this.type[i] !== old) this.retypeComp(i, old, this.type[i]);
    this.markDirty(i);
  }

  // Доли вида from в составе клетки становятся долями вида to.
  retypeComp(i, from, to) {
    const comp = this.comp(i);
    const n = solGet(comp, from);
    if (!n) return;
    this.setComp(i, solWith(solWith(comp, from, 0), to, solGet(comp, to) + n));
  }

  // Хрупок ли окисел в этой клетке: начиная со своей frailStage он
  // держится как дерево, а не как исходный камень или металл — окалина и
  // ржавчина рыхлые, навес из них не построить. Проверка идёт по плоской
  // таблице OXIDE_FRAIL_FROM, а не по линейке: её зовёт computeStability
  // для каждой клетки каждого кадра.
  oxideFrail(i) {
    const fr = OXIDE_FRAIL_FROM[this.type[i]];
    if (!fr) return false;
    return fr < 0 || this.extra[i] >= fr;
  }

  // Кислота не берёт окисел начиная с acidProofStage его линейки:
  // плотная окалина защищает то, что под ней. У металла это четвёртая
  // стадия, у земли девятая, у камня такой защиты нет вовсе.
  acidProof(ni) {
    const line = OXIDE_LINE[this.type[ni]];
    if (!line || !line.acidProofStage) return false;
    return this.oxideStage(ni) >= line.acidProofStage;
  }

  // Окисел делится стадией с соседями, и именно это наращивает вокруг
  // озера реагента слой глубиной в три клетки.
  //
  // Правило из постановки: окисел стадии 2 или 3 отдаёт соседу с меньшей
  // стадией одну свою стадию — но только пока после передачи он не
  // окажется НИЖЕ того, кому отдал. Это ровно условие S - T >= 2:
  //   3 и 1  ->  2 и 2   (пример из задания: два окисла второй стадии);
  //   2 и 0  ->  1 и 1   (соседний камень становится окислом);
  //   3 и 0  ->  2 и 1, и на этом всё: из 2 и 1 передавать уже нельзя.
  // Камень считается соседом со стадией 0 (см. oxideStage), поэтому
  // отдельного правила "окислить соседний камень" не нужно.
  //
  // За кадр отдаётся не больше одной стадии, и то по броску
  // OXIDE_SPREAD_CHANCE: слой должен нарастать на глазах, а не возникать
  // мгновенно. Получатель выбирается с наименьшей стадией — так фронт
  // идёт вглубь ровно, а не выедает один случайный ход.
  reactOxide(x, y, i) {
    if (this.meltStoneOxide(x, y, i)) return;
    const line = this.oxideLine(i);
    // Так стадиями делится только камень: его окисел прорастает вглубь
    // слоем. У ржавчины своё правило (reactRust), окисел земли остаётся
    // там, где возник, и вглубь идёт только вслед за жидкостью.
    if (!line || !line.spreads) return;
    const stage = this.oxideStage(i);
    if (stage < 2) return;
    if (Math.random() >= OXIDE_SPREAD_CHANCE) return;
    let best = -1, bestStage = 99;
    for (let k = 0; k < 4; k++) {
      const nx = x + DX4[k], ny = y + DY4[k];
      if (!this.inBounds(nx, ny)) continue;
      const ni = this.idx(nx, ny);
      if (this.oxideLine(ni) !== line) continue;
      const t = this.oxideStage(ni);
      if (t < 0 || stage - t < 2) continue;
      if (t < bestStage) { bestStage = t; best = ni; }
    }
    if (best < 0) return;
    this.setOxideStage(i, stage - 1);
    this.setOxideStage(best, bestStage + 1);
  }

  // Окисел камня плавится, как камень, в расплавленный камень — и отдаёт
  // газом реагент, который на него потратили: стадия N — газ из N долей
  // реагента и 10-N пустоты (стадия 1 — одна доля, стадия 3 — три).
  // Если газу некуда выйти (см. gasOutlet), плавление ждёт: иначе реагент
  // пропал бы бесследно.
  meltStoneOxide(x, y, i) {
    const id = this.type[i];
    if (!this.meltRoll(i, id)) return false;
    const target = this.gasOutlet(x, y);
    if (target < 0) return false;
    const stage = this.oxideStage(i);
    this.spawn(i, ELEMENTS[id].meltsInto, false);
    this.placeGas(target, solPure(EL.REAGENT_GAS, stage), 0, false);
    return true;
  }

  // Куда выйти газу из клетки (x, y): вверх сквозь жидкость и газ до первой
  // пустой клетки (не дальше OXIDE_GAS_RISE) — пузырь поднимается сквозь
  // расплав; если путь вверх упирается в твёрдое или сыпучее — любой
  // пустой сосед. -1 — выйти некуда.
  gasOutlet(x, y) {
    const w = this.w;
    for (let ny = y - 1, k = 0; ny >= 0 && k < OXIDE_GAS_RISE; ny--, k++) {
      const ni = ny * w + x;
      const t = this.type[ni];
      if (t === EL.EMPTY) return ni;
      if (IS_LIQUID[t] !== 1 && IS_GASLIKE[t] !== 1) break;
    }
    return this.freeNeighbour(x, y, true);
  }

  // Ржавчина (окисел металла, обе формы): плавится, как железо, ничего не
  // выделяя, и окисляет соседей по правилу своей стадии (см. константы
  // RUST_* в начале файла). Как и у камня, стадия не рождается из ничего:
  // ржавчина отдаёт соседу одну свою, а получатель выбирается с наименьшей
  // стадией, и всё это по броску OXIDE_SPREAD_CHANCE.
  reactRust(x, y, i) {
    const id = this.type[i];
    // Плавится по долям, в расплав своего металла (sim/alloys.js).
    if (this.meltRoll(i, id)) { this.meltAlloy(i); return; }
    const stage = this.oxideStage(i);
    if (stage < RUST_SPREAD_FROM) return;
    if (Math.random() >= OXIDE_SPREAD_CHANCE) return;
    const limited = stage <= RUST_LIMITED_UP_TO;
    let best = -1, bestStage = 99;
    for (let k = 0; k < 4; k++) {
      const nx = x + DX4[k], ny = y + DY4[k];
      if (!this.inBounds(nx, ny)) continue;
      const ni = this.idx(nx, ny);
      // Металл, сталь, приборы и ржавчина любой стадии: сталь воду не
      // боится, но ржавчину, коснувшуюся её, принимает (просьба
      // пользователя: "точка ржавения" пойдёт от ржавчины). Медь — так же,
      // но своей патиной: семьи не смешиваются (sameRustFamily).
      if (!sameRustFamily(OXIDE_LINE[this.type[ni]], OXIDE_LINE[id])) continue;
      const t = this.oxideStage(ni);
      if (t < 0) continue;
      // 4..5 — только тем, кто ещё не дошёл до второй стадии; 6..7 — как
      // камень: пока после передачи не окажешься ниже получателя.
      if (limited ? t >= RUST_LIMITED_TARGET : stage - t < 2) continue;
      if (t < bestStage) { bestStage = t; best = ni; }
    }
    if (best < 0) return;
    this.setOxideStage(i, stage - 1);
    this.setOxideStage(best, bestStage + 1);
  }

  // Медь окисляется сама, от воздуха: пока рядом есть пустота и стадия
  // ниже COPPER_AIR_MAX_STAGE, раз в среднем в 1/COPPER_AIR_CHANCE кадров
  // стадия растёт на одну (просьба: "окисляется до 4 стадии просто от
  // воздуха, если возле неё есть свободный пиксель").
  copperAir(x, y, i) {
    if (Math.random() >= COPPER_AIR_CHANCE) return;
    const stage = this.oxideStage(i);
    if (stage < 0 || stage >= COPPER_AIR_MAX_STAGE) return;
    if (!this.hasEmptyNeighbour(x, y)) return;
    this.setOxideStage(i, stage + 1, OXIDE_LINE_COPPER);
  }

  // Есть ли среди четырёх соседей пустая клетка.
  hasEmptyNeighbour(x, y) {
    const w = this.w, i = y * w + x, type = this.type;
    return (x > 0 && type[i - 1] === EL.EMPTY) || (x < w - 1 && type[i + 1] === EL.EMPTY)
      || (y > 0 && type[i - w] === EL.EMPTY) || (y < this.h - 1 && type[i + w] === EL.EMPTY);
  }

  reactCopper(x, y, i) {
    this.reactMelt(x, y, i, EL.COPPER);
    if (this.type[i] === EL.COPPER) this.copperAir(x, y, i);
  }

  reactCopperOxide(x, y, i) {
    this.reactRust(x, y, i);
    if (this.type[i] === EL.COPPER_OXIDE) this.copperAir(x, y, i);
  }

  // Балка в клетке i окисляется на стадию дальше по линейке своего
  // материала (жидкость в её клетке — см. reactLiquidOnBeam). Последняя
  // стадия у линеек всегда сыпучая, а сыпучей балки не бывает: дошедшая до
  // неё балка рассыпается и исчезает (клетка занята самой жидкостью).
  oxidiseBeam(i, line, stage) {
    const next = stage + 1;
    if (next >= line.maxStage) { this.removeBeam(i); return; }
    this.beam[i] = line.solid;
    this.beamExtra[i] = next;
    this.markDirty(i);   // материал балки — часть скелета
  }

  // Жидкость в клетке from только что подняла стадию металла в клетке to.
  // Если ржавчина дошла до RUST_FLAKE_FROM и выше, то с шансом
  // RUST_FLAKE_CHANCE она отслаивается: меняется с жидкостью местами. true
  // — жидкость теперь в клетке to, и вызывающий дальше работает с ней там
  // (соседи у неё уже другие, поэтому свой обход он прекращает). Обе
  // клетки помечаются moved: ржавчина, попавшая в клетку, где устойчивость
  // этого кадра считалась для жидкости, не должна сразу же падать как
  // обломок — это решит пересчёт следующего кадра.
  rustFlake(from, to) {
    if (this.oxideStage(to) < RUST_FLAKE_FROM) return false;
    if (Math.random() >= RUST_FLAKE_CHANCE) return false;
    this.swap(from, to);
    this.moved[from] = 1;
    this.moved[to] = 1;
    return true;
  }
}

extendSim(SimOxides);
