'use strict';

// Система долей: состав клетки жидкости или газа — 10 долей в одном Uint32.
// Здесь только формат, таблицы видов и функции упаковки. Поведение
// (смешивание, стягивание, фазы) — в sim/composition.js, химия кислоты и
// реагента — в sim/chemistry.js.

// ---- состав: 10 долей вещества (и пустоты) в одном Uint32 ----
//
// Одна и та же система описывает И жидкости, И газы: клетка это всегда
// SOL_PARTS = 10 долей, каждая доля — один из видов ниже. Отличается
// только фаза (жидкая или газовая), и переход между ними идёт
// ПОКОМПОНЕНТНО: у каждого вещества своя точка кипения, поэтому из
// раствора уходит паром ровно то, что при этой температуре кипит, а
// остальное остаётся лежать.
//
//   P_VOID    — ПУСТОТА. Не вещество, а недостающий объём: клетка с
//               пустотой "неполная". Пустота ведёт себя не как другие
//               доли (см. правила стягивания ниже) и в полную клетку
//               перейти не может вовсе.
//   P_WATER   — вода, кипит при 100.
//   P_ACID    — кислота, кипит при 60; единственная действующая доля,
//               разъедает соседей (только в жидкой фазе).
//   P_REAGENT — химический реагент, кипит при 250.
//   P_OIL     — масло. Единственное, что НЕ переходит по температуре:
//               газообразное масло выпадает по таймеру (см. Sim.reactVapor).
//   P_STONE   — растворённое вещество. Не испаряется никогда.
//
// Состав упакован по 4 бита на вид (значения 0..10) в Uint32 — один
// массив Sim.sol на всё поле; обменивается вместе с клеткой в swapFields,
// попадает в снимок отмены и в сохранение.
const SOL_PARTS = 10;
const P_VOID = 0, P_WATER = 1, P_ACID = 2, P_REAGENT = 3, P_OIL = 4, P_STONE = 5;
const P_COUNT = 6;

// Точка кипения каждого вида. Выше неё вид существует только газом, ниже
// — только жидкостью. Infinity = "по температуре не переходит вовсе"
// (пустота и растворённое вещество — никогда; масло — по таймеру).
const PART_BOIL = [Infinity, 100, 60, 250, Infinity, Infinity];
// Точка ЗАМЕРЗАНИЯ каждого вида: ниже неё вид существует только твёрдым.
// -Infinity = не замерзает вовсе (пустота, масло, растворённое вещество).
// Вода застывает при нуле, кислота при -30, реагент при -60 — поэтому при
// охлаждении раствора первой выпадает вода, и только потом остальное.
const PART_FREEZE = [-Infinity, 0, -30, -60, -Infinity, -Infinity];
// Самая высокая точка замерзания среди всех видов: жидкость теплее неё
// заведомо ничем не застынет, и это отсеивается одним сравнением в
// tickPhase, не разбирая состав (та же уловка, что и с PART_BOIL_MIN).
const PART_FREEZE_MAX = 0;
// Самая низкая и самая высокая температура перехода среди ВСЕХ видов.
// Нужны для дешёвого отсева в Sim.tickPhase: жидкость холоднее
// PART_BOIL_MIN не может кипеть ничем, газ горячее PART_BOIL_MAX не может
// сконденсировать ничего — такие клетки отбрасываются одним сравнением,
// не разбирая состав.
const PART_BOIL_MIN = 60;
const PART_BOIL_MAX = 250;

// Цвет каждого вида — из таблицы элементов, чтобы смесь красилась ровно
// теми же цветами, что и чистые вещества (см. render.js).
const PART_COLOR = [
  [14, 14, 18],
  ELEMENTS[EL.WATER].color,
  ELEMENTS[EL.ACID].color,
  ELEMENTS[EL.REAGENT].color,
  ELEMENTS[EL.OIL].color,
  ELEMENTS[EL.STONE].color,
];

function solGet(packed, slot) { return (packed >>> (slot * 4)) & 15; }
function solWith(packed, slot, value) {
  return (packed & ~(15 << (slot * 4))) | (value << (slot * 4));
}
function solAdd(packed, slot, delta) { return solGet(packed, slot) + delta; }
// Переложить одну долю из вида from в вид to.
function solMove(packed, from, to) {
  return solWith(solWith(packed, from, solGet(packed, from) - 1), to, solGet(packed, to) + 1);
}
// Состав из одного вещества: n долей вида slot, остальное пустота.
function solPure(slot, n) {
  const k = n === undefined ? SOL_PARTS : n;
  return solWith(k === SOL_PARTS ? 0 : solWith(0, P_VOID, SOL_PARTS - k), slot, k);
}
// Сумма вещественных (не пустых) долей.
function solMatter(packed) {
  return SOL_PARTS - solGet(packed, P_VOID);
}

const SOL_PURE_WATER = solPure(P_WATER);
const SOL_PURE_ACID = solPure(P_ACID);
const SOL_PURE_REAGENT = solPure(P_REAGENT);
const SOL_PURE_OIL = solPure(P_OIL);

// Жидкий элемент, отвечающий виду вещества (во что конденсируется газ и
// чем показывается чистый состав), и газовый элемент для него же. Для
// видов без своего чистого газа (реагент, масло, растворённое вещество)
// газ показывается общим EL.VAPOR.
const PART_LIQUID = [EL.EMPTY, EL.WATER, EL.ACID, EL.REAGENT, EL.OIL, EL.EMPTY];
const PART_GAS = [EL.EMPTY, EL.STEAM, EL.ACID_GAS, EL.VAPOR, EL.VAPOR, EL.VAPOR];
// Твёрдая фаза вида (во что он застывает и из чего тает обратно).
const PART_SOLID = [EL.EMPTY, EL.ICE, EL.ACID_ICE, EL.REAGENT_ICE, EL.EMPTY, EL.EMPTY];
// Обратное соответствие: какой вид оттаивает из этого твёрдого элемента.
const SOLID_PART = [];
SOLID_PART[EL.ICE] = P_WATER;
SOLID_PART[EL.ACID_ICE] = P_ACID;
SOLID_PART[EL.REAGENT_ICE] = P_REAGENT;

// Состав, который получает СВЕЖАЯ частица этого элемента (Sim.spawn):
// всегда полные 10 долей своего вещества, без пустоты. Смеси
// (EL.SOLUTION / EL.VAPOR) здесь отсутствуют намеренно — они рождаются
// только из уже известного состава, через Sim.setComposition.
const PURE_COMP_BY_ELEMENT = [];
PURE_COMP_BY_ELEMENT[EL.WATER] = SOL_PURE_WATER;
PURE_COMP_BY_ELEMENT[EL.ACID] = SOL_PURE_ACID;
PURE_COMP_BY_ELEMENT[EL.REAGENT] = SOL_PURE_REAGENT;
PURE_COMP_BY_ELEMENT[EL.OIL] = SOL_PURE_OIL;
PURE_COMP_BY_ELEMENT[EL.STEAM] = SOL_PURE_WATER;
PURE_COMP_BY_ELEMENT[EL.ACID_GAS] = SOL_PURE_ACID;

// Семейство жидкостей-растворов — те, что смешиваются друг с другом и
// участвуют в общей "фазе" для вытеснения тонущими телами (см.
// LIQUID_PHASE). Масло сюда НЕ входит: с водой оно не смешивается, у него
// своя физика (горение, застывание в плёнку), и в системе долей оно живёт
// только как ГАЗОВЫЙ компонент — сконденсировавшись, сразу становится
// обычным маслом. Лава — тем более отдельно.
function isSolutionFamily(id) {
  return id === EL.WATER || id === EL.ACID || id === EL.REAGENT || id === EL.SOLUTION;
}

// Газовое семейство той же системы долей: всё, что умеет перемешиваться,
// стягиваться и конденсироваться покомпонентно. Дым сюда не входит — он
// просто эффект горения со своим сроком жизни.
function isVaporFamily(id) {
  return id === EL.STEAM || id === EL.ACID_GAS || id === EL.VAPOR;
}

// Клетка вообще участвует в системе долей (любая фаза).
function hasComposition(id) {
  return isSolutionFamily(id) || isVaporFamily(id) || id === EL.OIL;
}

// "Фаза" жидкости для computeLiquidEscape/displaceLiquidThroughBody: всё
// семейство растворов считается ОДНОЙ связной жидкостью (капля раствора
// посреди озера воды — не отдельная запечатанная лужа, а часть озера),
// остальные жидкости — каждая сама по себе. Индекс — id элемента.
const LIQUID_PHASE = new Uint8Array(64);
for (let id = 0; id < 64; id++) LIQUID_PHASE[id] = isSolutionFamily(id) ? EL.WATER : id;
