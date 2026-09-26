'use strict';

// Состав клетки: из каких веществ она сложена. Здесь только формат, таблицы
// фаз и функции упаковки. Поведение (смешивание, стягивание, фазовые
// переходы, выделение газа) — в sim/composition.js, химия кислоты и
// реагента — в sim/chemistry.js, растворитель — там же.
//
// ---- состав: 10 долей, у каждой клетки мира ----
//
// Просьба пользователя: "в принципе каждый пиксель карты имеет свой
// состав". Клетка — это всегда SOL_PARTS = 10 долей, и доля — это
// ЭЛЕМЕНТ (id из EL): доля воды, доля камня, доля пара. Недостающие до
// десяти доли — ПУСТОТА: клетка неполная, бледнее (прозрачнее) полной.
// Пустота не хранится, она вычисляется: SOL_PARTS минус сумма долей.
//
// Раньше состав был только у жидкостей и газов, а видов было семь
// (вода, кислота, реагент, масло, растворённое вещество, соль) по 4 бита.
// Теперь вид — любой элемент, но в одной клетке не больше SOL_SLOTS
// разных веществ: попытка добавить шестое не удаётся (solWith/solMove
// возвращают состав без изменений).
//
// Фаза у доли — фаза её элемента (CAT): вода — жидкость, пар — газ, лёд
// и камень — твёрдое (сыпучее тоже считается твёрдым). Кипение, замерзание
// и прочее — это превращение долей одного вида в другой (вода -> пар),
// а какой будет вся клетка, решает setComposition по правилам пользователя:
//  - одни газы — газ;
//  - есть газ и что-то ещё — газ выходит в свободную соседнюю клетку
//    отдельным пикселем (Sim.splitGas), пока его некуда деть — сидит внутри;
//  - жидкое и твёрдое — по тому, чего больше; поровну — твёрдое.
//
// Упаковка. Ячейка вещества — 10 бит: id (6 бит) | число долей (4 бита) << 6.
// До SOL_SLOTS = 5 ячеек подряд, без дыр: пустая ячейка — конец списка.
// Хранится в двух Uint32 на клетку: Sim.sol — ячейки 0..2, Sim.sol2 —
// ячейки 3..4 (так оба поля обмениваются в swapFields и заливаются
// текстурами на видеокарту без переупаковки). В коде состав ходит одним
// числом comp = sol + sol2 * SOL_HI (целое < 2^50, double хранит его
// точно) — см. Sim.comp / Sim.setComp.
const SOL_PARTS = 10;
const SOL_SLOTS = 5;
const SOL_HI = 1073741824;   // 2^30: три ячейки по 10 бит

// Имена видов — это id элементов. Остались ради читаемости химии, где
// "доля кислоты" пишется как P_ACID. P_VOID — пустота: solGet(comp,
// P_VOID) даёт число пустых долей, solWith(comp, P_VOID, ...) ничего не
// делает (пустота — то, что осталось от десяти).
const P_VOID = 0;
const P_WATER = EL.WATER;
const P_ACID = EL.ACID;
const P_REAGENT = EL.REAGENT;
const P_OIL = EL.OIL;
// "Растворённое вещество" кислоты — это просто камень в жидкости.
const P_STONE = EL.STONE;
const P_SALT = EL.BLACK_SALT;
const P_DISSOLVER = EL.DISSOLVER;
const P_DISSOLVER_GAS = EL.DISSOLVER_GAS;

// Быстрый путь во всех функциях ниже: состав до трёх веществ (почти любая
// клетка мира — чистое вещество) целиком лежит в нижних 30 битах, и его
// разбирают одними сдвигами, без делений над double. Замер: без этого
// мир из воды шёл на 16% медленнее прежнего формата.

// Ячейка s состава (0 — ячейки нет).
function solSlot(comp, s) {
  if (comp < SOL_HI) return s < 3 ? (comp >>> (10 * s)) & 1023 : 0;
  if (s < 3) return ((comp % SOL_HI) >>> (10 * s)) & 1023;
  return (((comp - comp % SOL_HI) / SOL_HI) >>> (10 * (s - 3))) & 1023;
}
function slotId(slot) { return slot & 63; }
function slotCount(slot) { return slot >>> 6; }

// Сумма вещественных (не пустых) долей.
function solMatter(comp) {
  if (comp < SOL_HI) return ((comp >>> 6) & 15) + ((comp >>> 16) & 15) + ((comp >>> 26) & 15);
  const lo = comp % SOL_HI, hi = (comp - lo) / SOL_HI;
  return ((lo >>> 6) & 15) + ((lo >>> 16) & 15) + ((lo >>> 26) & 15) + ((hi >>> 6) & 15) + ((hi >>> 16) & 15);
}

// Сколько разных веществ в клетке.
function solKinds(comp) {
  let k = 0;
  for (let s = 0; s < SOL_SLOTS; s++) { if (!solSlot(comp, s)) break; k++; }
  return k;
}

function solGet(comp, id) {
  if (id === P_VOID) return SOL_PARTS - solMatter(comp);
  if (comp < SOL_HI) {
    if ((comp & 63) === id) return (comp >>> 6) & 15;
    if (((comp >>> 10) & 63) === id) return (comp >>> 16) & 15;
    if (((comp >>> 20) & 63) === id) return (comp >>> 26) & 15;
    return 0;
  }
  const lo = comp % SOL_HI, hi = (comp - lo) / SOL_HI;
  for (let s = 0; s < SOL_SLOTS; s++) {
    const slot = s < 3 ? (lo >>> (10 * s)) & 1023 : (hi >>> (10 * (s - 3))) & 1023;
    if (slot === 0) return 0;
    if ((slot & 63) === id) return slot >>> 6;
  }
  return 0;
}

// Состав с n долями вещества id (0 — убрать его). Если вещества ещё нет,
// а все SOL_SLOTS ячеек заняты, — состав возвращается без изменений.
function solWith(comp, id, n) {
  if (id === P_VOID) return comp;
  if (n < 0) n = 0; else if (n > SOL_PARTS) n = SOL_PARTS;
  const lo = comp % SOL_HI, hi = (comp - lo) / SOL_HI;
  let out = 0, mul = 1, used = 0, placed = n === 0;
  for (let s = 0; s < SOL_SLOTS; s++) {
    const slot = s < 3 ? (lo >>> (10 * s)) & 1023 : (hi >>> (10 * (s - 3))) & 1023;
    if (slot === 0) break;
    let v = slot;
    if ((slot & 63) === id) {
      if (placed) continue;
      v = id | (n << 6);
      placed = true;
    }
    out += v * mul; mul *= 1024; used++;
  }
  if (!placed) {
    if (used >= SOL_SLOTS) return comp;
    out += (id | (n << 6)) * mul;
  }
  return out;
}

// Переложить одну долю из вида from в вид to (любой из них может быть
// пустотой). Не удалось (некуда положить новый вид) — состав прежний.
function solMove(comp, from, to) {
  if (from === to) return comp;
  const c1 = from === P_VOID ? comp : solWith(comp, from, solGet(comp, from) - 1);
  if (to === P_VOID) return c1;
  const want = solGet(c1, to) + 1;
  const c2 = solWith(c1, to, want);
  return solGet(c2, to) === want ? c2 : comp;
}

// Состав из одного вещества: n долей (по умолчанию все 10), остальное пустота.
function solPure(id, n) {
  const k = n === undefined ? SOL_PARTS : n;
  return k > 0 ? id | (k << 6) : 0;
}

// ---- фазы ----

// Фаза доли по её элементу: 1 — газ, 2 — жидкость, 3 — твёрдое (и
// сыпучее), 0 — в составы не входит (огонь).
const STATE_GAS = 1, STATE_LIQUID = 2, STATE_SOLID = 3;
const PART_STATE = new Uint8Array(64);
for (let id = 1; id < 64; id++) {
  const el = ELEMENTS[id];
  if (!el) continue;
  PART_STATE[id] = el.cat === CAT.GAS ? STATE_GAS : el.cat === CAT.LIQUID ? STATE_LIQUID
    : (el.cat === CAT.SOLID || el.cat === CAT.POWDER) ? STATE_SOLID : 0;
}

// Вещества, которые переходят из фазы в фазу: жидкость, её газ, её
// твёрдая форма, точка кипения, точка замерзания. Кипит вода при 100,
// кислота при 60, реагент при 250; замерзают при 0, -30 и -60 — поэтому
// при охлаждении раствора первой выпадает вода, а при нагреве первой
// уходит кислота. Масло по температуре не кипит (Infinity): его газ
// выделяется только при растворении и выпадает по сроку (см. tickPhase).
const PHASE_LINKS = [
  [EL.WATER, EL.STEAM, EL.ICE, 100, 0],
  [EL.ACID, EL.ACID_GAS, EL.ACID_ICE, 60, -30],
  [EL.REAGENT, EL.REAGENT_GAS, EL.REAGENT_ICE, 250, -60],
  [EL.OIL, EL.OIL_GAS, EL.EMPTY, Infinity, -Infinity],
  // Растворитель (просьба пользователя): кипит при 50, замерзает при -20.
  [EL.DISSOLVER, EL.DISSOLVER_GAS, EL.DISSOLVER_ICE, 50, -20],
];
const BOIL_TO = new Uint8Array(64);        // жидкость -> её газ
const CONDENSE_TO = new Uint8Array(64);    // газ -> его жидкость
const FREEZE_TO = new Uint8Array(64);      // жидкость -> её твёрдое
const THAW_TO = new Uint8Array(64);        // твёрдое -> его жидкость
const BOIL_POINT = new Float64Array(64).fill(Infinity);     // по id жидкости
const FREEZE_POINT = new Float64Array(64).fill(-Infinity);  // по id жидкости
for (const [liquid, gas, solid, boil, freeze] of PHASE_LINKS) {
  BOIL_TO[liquid] = gas; CONDENSE_TO[gas] = liquid;
  if (solid) { FREEZE_TO[liquid] = solid; THAW_TO[solid] = liquid; }
  BOIL_POINT[liquid] = boil; FREEZE_POINT[liquid] = freeze;
}
// Цвет доли — цвет её элемента, название — его имя (0 — пустота).
const PART_COLOR = [];
const PART_NAME = ['Пустота'];
for (let id = 1; id < 64; id++) {
  if (!ELEMENTS[id]) continue;
  PART_COLOR[id] = ELEMENTS[id].color;
  PART_NAME[id] = ELEMENTS[id].name;
}
PART_COLOR[P_VOID] = [14, 14, 18];

// Свежая частица (Sim.spawn) — всегда полные 10 долей своего вещества.
// Смеси (SOLUTION, VAPOR) сами по себе веществом не являются: свежий
// "раствор" — это вода, свежий "смешанный газ" — пар.
function pureCompFor(id) {
  if (id === EL.EMPTY) return 0;
  if (id === EL.SOLUTION) return solPure(EL.WATER);
  if (id === EL.VAPOR) return solPure(EL.STEAM);
  return solPure(id);
}

// ---- семейства: кто с кем смешивается сам собой ----

// Семейство жидкостей-растворов — те, что смешиваются друг с другом и
// участвуют в общей "фазе" для вытеснения тонущими телами (см.
// LIQUID_PHASE). Масло сюда НЕ входит: с водой оно не смешивается, у него
// своя физика (горение, застывание в плёнку). Лава — тем более отдельно.
// Таблицы по id — по той же причине, что и у предикатов в data/elements.js
// (idTable там): зовутся на горячем пути.
const IS_SOLUTION_FAMILY = idTable([EL.WATER, EL.ACID, EL.REAGENT, EL.SOLUTION, EL.DISSOLVER]);
function isSolutionFamily(id) { return IS_SOLUTION_FAMILY[id] === 1; }

// "Растворительная область" — всё, что обменивается долями с растворами:
// сами растворы и сыпучие чёрные соли (они растворяются в жидкости и
// выпадают из неё). Отдельно от isSolutionFamily нарочно: соль не
// жидкость и в LIQUID_PHASE (связность лужи для вытеснения тонущими
// телами) не входит.
const IS_SOLUTION_MEDIUM = idTable([EL.WATER, EL.ACID, EL.REAGENT, EL.SOLUTION, EL.DISSOLVER, EL.BLACK_SALT]);
function isSolutionMedium(id) { return IS_SOLUTION_MEDIUM[id] === 1; }

// Газовое семейство: всё, что умеет перемешиваться, стягиваться и
// конденсироваться покомпонентно. Дым сюда не входит — он просто эффект
// горения со своим сроком жизни.
const IS_VAPOR_FAMILY = idTable([EL.STEAM, EL.ACID_GAS, EL.VAPOR, EL.REAGENT_GAS, EL.OIL_GAS, EL.DISSOLVER_GAS]);
function isVaporFamily(id) { return IS_VAPOR_FAMILY[id] === 1; }

// Клетка, у которой состав ЖИВЁТ сам: перемешивается, стягивает пустоту,
// кипит и конденсируется покомпонентно (tickComposition). Состав есть у
// всех клеток, но у камня, песка и прочего твёрдого он меняется только
// извне (растворитель, окисление) и сам ничего не делает.
const HAS_COMPOSITION = idTable([EL.WATER, EL.ACID, EL.REAGENT, EL.SOLUTION, EL.STEAM, EL.ACID_GAS, EL.VAPOR,
  EL.OIL, EL.BLACK_SALT, EL.DISSOLVER, EL.REAGENT_GAS, EL.OIL_GAS, EL.DISSOLVER_GAS]);
function hasComposition(id) { return HAS_COMPOSITION[id] === 1; }

// С чем меняется долями растворитель: любое вещество с фазой, кроме
// якорей (стена, пустота, клонер — их не растворить, и растворённая стена
// выпала бы новой стеной где попало) и живых (человек, колонист).
const DISSOLVER_MIXABLE = new Uint8Array(64);
for (let id = 1; id < 64; id++) {
  DISSOLVER_MIXABLE[id] = (PART_STATE[id] !== 0 && !isAnchor(id) && id !== EL.HUMAN && id !== EL.COLONIST) ? 1 : 0;
}

// "Фаза" жидкости для computeLiquidEscape/displaceLiquidThroughBody: всё
// семейство растворов считается ОДНОЙ связной жидкостью (капля раствора
// посреди озера воды — не отдельная запечатанная лужа, а часть озера),
// остальные жидкости — каждая сама по себе. Индекс — id элемента.
const LIQUID_PHASE = new Uint8Array(64);
for (let id = 0; id < 64; id++) LIQUID_PHASE[id] = isSolutionFamily(id) ? EL.WATER : id;
