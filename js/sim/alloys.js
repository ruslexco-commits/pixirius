'use strict';

// Сплавы (просьба пользователя).
//
// Расплавы металлов живут той же системой долей, что и жидкости: лава
// (расплавленный камень), расплавленные металл, сталь и медь — доли одной
// "расплавной" среды, соседние расплавы меняются долями (mixParts), и смесь
// нескольких расплавов — "Расплав" (MOLTEN_ALLOY, как "раствор" у
// жидкостей). Остыв, каждая доля застывает в своё твёрдое (SOLIDIFY_TO), и
// клетка из нескольких металлов (камень тоже годится) — "Сплав" (ALLOY).
// Плавится сплав тоже по долям (MELT_TO): что было намешано, то и течёт.
//
// Свойства сплава — средние по его долям, с весом числа долей:
//  - точка плавления (и шанс плавления в кадр), точка застывания расплава;
//  - устойчивость и стойкость (alloyStability / alloyToughness);
//  - скорость растворения кислотой (alloyAcidChance);
//  - скорость прохождения тока — средняя по металлам (alloyChargeStep); от
//    ALLOY_STONE_INSULATES долей камня сплав тока не проводит вовсе;
//  - масса пикселя для пятна контакта (sim/landing.js).
// И правила по отдельным долям:
//  - хоть одна доля стали ("титана" пользователя) — чистая вода сплав не
//    берёт; вода с чёрными солями — берёт, как и саму сталь;
//  - больше пяти долей меди (ALLOY_COPPER_AIR_FROM) и ни одной стали —
//    сплав окисляется от воздуха, как медь;
//  - газ при растворении кислотой — газ случайной доли: бросок от 1 до 10,
//    какая доля выпала, та и выделяет свой газ (dissolveInto).
//
// Ржавчина сплава — тоже по долям, так в одной клетке оказывается понемногу
// разной ржавчины (просьба "аккуратно намешивать разные ржавчины"): каждое
// удачное ржавление превращает ОДНУ долю металла в её собственную ржавчину
// (RUST_TO: железо и сталь — в ржавчину, медь — в патину, камень под
// реагентом — в окисел). Какая доля, решает бросок по тем долям, которые
// этот агент вообще берёт (alloyRustPart). Цвет клетки — среднее цветов
// долей, так что сплав железа с медью в воде зеленеет и рыжеет разом, в
// пропорции того, что в нём успело прокорродировать. Проржавев на
// ALLOY_CRUMBLE_AT долей, сплав рассыпается рыхлой ржавчиной сплава
// (ALLOY_RUST) — той же смесью ржавчин. У чистых металлов ржавчина
// по-прежнему идёт стадиями (sim/oxides.js); доли — только у сплава.
//
// Методы класса Sim, вынесенные в отдельный файл: класс ниже — только
// контейнер, extendSim переносит его методы в Sim.prototype (см. core.js).

// Сколько долей ржавчины (любой) рассыпают сплав.
const ALLOY_CRUMBLE_AT = 7;
// С какого числа долей камня сплав перестаёт проводить ток.
const ALLOY_STONE_INSULATES = 5;
// С какого числа долей меди сплав без стали окисляется от воздуха ("больше
// пяти частей").
const ALLOY_COPPER_AIR_FROM = 6;
// Расплав металла застывает на столько градусов ниже точки плавления
// своего металла (гистерезис, как у расплавленной меди раньше), с шансом в
// кадр — чтобы лужа застывала не разом.
const MOLTEN_SOLIDIFY_BELOW = 20;
const MOLTEN_SOLIDIFY_CHANCE = 0.05;

// Агенты ржавления сплава (alloyRustPart).
const ALLOY_BY_WATER = 0, ALLOY_BY_SALTY_WATER = 1, ALLOY_BY_REAGENT = 2, ALLOY_BY_ACID = 3, ALLOY_BY_AIR = 4;

// ---- таблицы по id доли ----
// Расплавы — одна среда, меняются долями между собой (samePartsFamily).
const IS_MOLTEN = idTable([EL.LAVA, EL.MOLTEN_METAL, EL.MOLTEN_STEEL, EL.MOLTEN_COPPER, EL.MOLTEN_ALLOY]);
// Твёрдые доли, из которых складывается сплав, и среди них — металлические
// (сплав без единого металла — просто камень) и ржавчины.
const ALLOY_PART = idTable([EL.METAL, EL.STEEL, EL.COPPER, EL.STONE, EL.METAL_OXIDE, EL.COPPER_OXIDE, EL.OXIDE]);
const ALLOY_METALLIC = idTable([EL.METAL, EL.STEEL, EL.COPPER, EL.METAL_OXIDE, EL.COPPER_OXIDE]);
const ALLOY_OXIDE_PART = idTable([EL.METAL_OXIDE, EL.COPPER_OXIDE, EL.OXIDE, EL.METAL_OXIDE_LOOSE, EL.COPPER_OXIDE_LOOSE, EL.OXIDE_LOOSE]);
// Твёрдая доля -> её расплав, расплав -> его твёрдое. Ржавчина плавится,
// как свой металл (и ничего не выделяет, как и раньше).
const MELT_TO = new Uint8Array(64);
MELT_TO[EL.STONE] = EL.LAVA;
MELT_TO[EL.OXIDE] = EL.LAVA;
MELT_TO[EL.OXIDE_LOOSE] = EL.LAVA;
MELT_TO[EL.METAL] = EL.MOLTEN_METAL;
MELT_TO[EL.METAL_OXIDE] = EL.MOLTEN_METAL;
MELT_TO[EL.METAL_OXIDE_LOOSE] = EL.MOLTEN_METAL;
MELT_TO[EL.STEEL] = EL.MOLTEN_STEEL;
MELT_TO[EL.COPPER] = EL.MOLTEN_COPPER;
MELT_TO[EL.COPPER_OXIDE] = EL.MOLTEN_COPPER;
MELT_TO[EL.COPPER_OXIDE_LOOSE] = EL.MOLTEN_COPPER;
const SOLIDIFY_TO = new Uint8Array(64);
SOLIDIFY_TO[EL.LAVA] = EL.STONE;
SOLIDIFY_TO[EL.MOLTEN_METAL] = EL.METAL;
SOLIDIFY_TO[EL.MOLTEN_STEEL] = EL.STEEL;
SOLIDIFY_TO[EL.MOLTEN_COPPER] = EL.COPPER;
// Металл -> его ржавчина в сплаве.
const RUST_TO = new Uint8Array(64);
RUST_TO[EL.METAL] = EL.METAL_OXIDE;
RUST_TO[EL.STEEL] = EL.METAL_OXIDE;
RUST_TO[EL.COPPER] = EL.COPPER_OXIDE;
RUST_TO[EL.STONE] = EL.OXIDE;

// Свойства доли для средних. Плавление — по элементу; застывание расплава
// — точка плавления его металла минус MOLTEN_SOLIDIFY_BELOW, у лавы — свой
// порог LAVA_SOLIDIFY_TEMP (sim/reactions.js). Устойчивость ржавчины — как
// у хрупкого окисла (как дерево), остального — по элементу. Кислота: 0 —
// не берёт, 0.015 — медленно (acidSlow), 0.06 — как камень.
const PART_MELT = new Float64Array(64);
const PART_MELT_CHANCE = new Float64Array(64);
const PART_SOLIDIFY = new Float64Array(64);
const PART_STAB = new Float64Array(64);
const PART_TOUGH = new Float64Array(64);
const PART_ACID = new Float64Array(64);
for (let id = 1; id < 64; id++) {
  const el = ELEMENTS[id];
  if (!el) continue;
  if (el.meltPoint !== undefined) { PART_MELT[id] = el.meltPoint; PART_MELT_CHANCE[id] = el.meltChance || 0; }
  PART_STAB[id] = el.maxStability || 0;
  PART_TOUGH[id] = el.toughness || 1;
  PART_ACID[id] = el.acidImmune ? 0 : el.acidSlow ? 0.015 : 0.06;
}
for (const id of [EL.METAL_OXIDE, EL.COPPER_OXIDE, EL.OXIDE]) { PART_STAB[id] = OXIDE_FRAIL_STABILITY; PART_TOUGH[id] = OXIDE_FRAIL_TOUGHNESS; }
PART_SOLIDIFY[EL.LAVA] = LAVA_SOLIDIFY_TEMP;
PART_SOLIDIFY[EL.MOLTEN_METAL] = ELEMENTS[EL.METAL].meltPoint - MOLTEN_SOLIDIFY_BELOW;
PART_SOLIDIFY[EL.MOLTEN_STEEL] = ELEMENTS[EL.STEEL].meltPoint - MOLTEN_SOLIDIFY_BELOW;
PART_SOLIDIFY[EL.MOLTEN_COPPER] = ELEMENTS[EL.COPPER].meltPoint - MOLTEN_SOLIDIFY_BELOW;

class SimAlloys {
  // Среднее table[id] по вещественным долям состава с весом числа долей;
  // доли, у которых в таблице 0, пропускаются, если skipZero. NaN — ни
  // одной подходящей доли.
  alloyAvg(comp, table, skipZero) {
    let sum = 0, n = 0;
    for (let s = 0; s < SOL_SLOTS; s++) {
      const slot = solSlot(comp, s);
      if (!slot) break;
      const id = slotId(slot), c = slotCount(slot);
      const v = table[id];
      if (skipZero && v === 0) continue;
      sum += v * c; n += c;
    }
    return n ? sum / n : NaN;
  }

  // ---- плавление и застывание ----

  // Пора ли плавиться клетке из плавких по долям веществ (металлы, камень,
  // их ржавчины, сплав): температура дошла до средней точки плавления
  // долей и выпал средний шанс. У чистой клетки это ровно её элемент.
  alloyMeltRoll(i) {
    const comp = this.comp(i);
    // Чистая клетка (почти любой камень и металл мира) — одно чтение
    // таблицы вместо среднего: это зовётся на каждую такую клетку в каждом
    // кадре. Бросок тот же и в том же месте.
    if (comp < 1024) {
      const id = comp & 63, point = PART_MELT[id];
      return point > 0 && this.temp[i] >= point && Math.random() < PART_MELT_CHANCE[id];
    }
    const point = this.alloyAvg(comp, PART_MELT, true);
    if (!(this.temp[i] >= point)) return false;
    return Math.random() < this.alloyAvg(comp, PART_MELT_CHANCE, true);
  }

  // Плавит клетку по долям: каждая плавкая доля становится своим расплавом,
  // тип выводит setComposition (один расплав — его элемент, несколько —
  // "Расплав"). Температура и оттенок остаются частицей, стадия окисла
  // (extra) — больше не нужна.
  meltAlloy(i) {
    this.extra[i] = 0;
    this.life[i] = 0;
    this.setComposition(i, this.mapParts(this.comp(i), MELT_TO));
  }

  solidifyMolten(i) {
    this.extra[i] = 0;
    this.life[i] = 0;
    this.setComposition(i, this.mapParts(this.comp(i), SOLIDIFY_TO));
  }

  // Состав, где каждая доля id заменена на map[id] (0 — остаётся собой).
  mapParts(comp, map) {
    let out = 0;
    for (let s = 0; s < SOL_SLOTS; s++) {
      const slot = solSlot(comp, s);
      if (!slot) break;
      const id = slotId(slot), to = map[id] || id;
      out = solWith(out, to, solGet(out, to) + slotCount(slot));
    }
    return out;
  }

  // Порог застывания расплава: средний по его расплавным долям.
  moltenSolidifyTemp(i) {
    return this.alloyAvg(this.comp(i), PART_SOLIDIFY, true);
  }

  // Расплав металла (и смесь расплавов): меняется долями с соседними
  // расплавами — так и получается сплав, — жжёт и испаряет соседей, как
  // лава (hotNeighbours), и, остыв ниже порога, застывает по долям.
  reactMolten(x, y, i) {
    this.mixParts(x, y, i);
    if (IS_MOLTEN[this.type[i]] !== 1 || this.type[i] === EL.LAVA) return;
    if (this.hotNeighbours(x, y, i)) return;
    if (this.temp[i] < this.moltenSolidifyTemp(i) && Math.random() < MOLTEN_SOLIDIFY_CHANCE) this.solidifyMolten(i);
  }

  // ---- сплав ----

  reactAlloy(x, y, i) {
    if (this.alloyMeltRoll(i)) { this.meltAlloy(i); return; }
    // Медный сплав без стали зеленеет от воздуха, как медь.
    const comp = this.comp(i);
    if (solGet(comp, EL.COPPER) >= ALLOY_COPPER_AIR_FROM && solGet(comp, EL.STEEL) === 0
        && Math.random() < COPPER_AIR_CHANCE && this.hasEmptyNeighbour(x, y)) this.alloyRustPart(i, ALLOY_BY_AIR);
  }

  reactAlloyRust(x, y, i) {
    if (this.alloyMeltRoll(i)) this.meltAlloy(i);
  }

  // Берёт ли агент эту долю сплава. steel — есть ли в сплаве сталь.
  alloyPartRusts(id, agent, steel) {
    if (agent === ALLOY_BY_AIR) return id === EL.COPPER;
    if (agent === ALLOY_BY_WATER) return !steel && (id === EL.METAL || id === EL.COPPER);
    if (agent === ALLOY_BY_REAGENT) return id === EL.METAL || id === EL.STEEL || id === EL.COPPER || id === EL.STONE;
    return id === EL.METAL || id === EL.STEEL || id === EL.COPPER;   // солёная вода, кислота
  }

  // Может ли агент ржавить сплав в клетке i хоть одной долей.
  alloyRusts(i, agent) {
    const comp = this.comp(i);
    const steel = solGet(comp, EL.STEEL) > 0;
    for (let s = 0; s < SOL_SLOTS; s++) {
      const slot = solSlot(comp, s);
      if (!slot) break;
      if (this.alloyPartRusts(slotId(slot), agent, steel)) return true;
    }
    return false;
  }

  // Одна доля сплава ржавеет: какая — бросок по долям, которые агент берёт,
  // с весом их числа. false — брать нечего (или шестой вид не поместился).
  alloyRustPart(i, agent) {
    const comp = this.comp(i);
    const steel = solGet(comp, EL.STEEL) > 0;
    let total = 0;
    for (let s = 0; s < SOL_SLOTS; s++) {
      const slot = solSlot(comp, s);
      if (!slot) break;
      if (this.alloyPartRusts(slotId(slot), agent, steel)) total += slotCount(slot);
    }
    if (total === 0) return false;
    let r = (Math.random() * total) | 0;
    for (let s = 0; s < SOL_SLOTS; s++) {
      const slot = solSlot(comp, s);
      if (!slot) break;
      const id = slotId(slot);
      if (!this.alloyPartRusts(id, agent, steel)) continue;
      const c = slotCount(slot);
      if (r < c) {
        const next = solMove(comp, id, RUST_TO[id]);
        if (next === comp) return false;
        this.setComposition(i, next);
        return true;
      }
      r -= c;
    }
    return false;
  }

  // Средние свойства. Устойчивость и стойкость — целые: устойчивость — это
  // номер ведра в computeStability, и обе входят в подпись скелета.
  alloyStability(i) { return Math.max(1, Math.round(this.alloyAvg(this.comp(i), PART_STAB, false))); }
  alloyToughness(i) { return Math.max(1, Math.round(this.alloyAvg(this.comp(i), PART_TOUGH, false))); }
  alloyAcidChance(i) { return this.alloyAvg(this.comp(i), PART_ACID, false); }
  alloyMass(i) { return this.alloyAvg(this.comp(i), PIXEL_MASS, false); }

  // Сколько кадров заряд идёт через клетку сплава: среднее по проводящим
  // долям (медь 1, железо и сталь 2, ржавчина 3), округлённое; от
  // ALLOY_STONE_INSULATES долей камня — не проводит (0).
  alloyChargeStep(i) {
    const comp = this.comp(i);
    if (solGet(comp, EL.STONE) >= ALLOY_STONE_INSULATES) return 0;
    const avg = this.alloyAvg(comp, CHARGE_STEP, true);
    return avg > 0 ? Math.max(1, Math.round(avg)) : 0;
  }

  // Сколько кадров заряд идёт через клетку j (0 — не проводит). Балка
  // проводит по своему материалу; куда с неё можно перейти и откуда на неё
  // — решает chargeLinkOK (sim/charges.js). Балка и вещество в той же
  // клетке — два пути, заряд идёт быстрейшим.
  chargeStepAt(j) {
    const t = this.type[j];
    const s = t === EL.ALLOY ? this.alloyChargeStep(j) : CHARGE_STEP[t];
    const bm = this.beam[j];
    if (bm === 0) return s;
    const b = CHARGE_STEP[bm];
    return s === 0 ? b : b === 0 ? s : Math.min(s, b);
  }

  // Преобладающая доля сплава — материал балки, начатой с него (у балки
  // состава нет, только id материала).
  alloyMainPart(i) {
    const comp = this.comp(i);
    let best = EL.METAL, bestN = 0;
    for (let s = 0; s < SOL_SLOTS; s++) {
      const slot = solSlot(comp, s);
      if (!slot) break;
      const id = slotId(slot), c = slotCount(slot);
      if (IS_STRUCTURAL[id] === 1 && c > bestN) { best = id; bestN = c; }
    }
    return best;
  }
}

extendSim(SimAlloys);
