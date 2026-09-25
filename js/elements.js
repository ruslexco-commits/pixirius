'use strict';

// Идентификаторы элементов
const EL = {
  EMPTY: 0,
  SAND: 1,
  WATER: 2,
  STONE: 3,
  WOOD: 4,
  OIL: 5,
  LAVA: 6,
  ACID: 7,
  ICE: 8,
  STEAM: 9,
  SMOKE: 10,
  FIRE: 11,
  GUNP: 12,
  METAL: 13,
  GLASS: 14,
  WALL: 15,
  SALT: 16,
  ASH: 17,
  VOID: 18,
  CLONE: 19,
  OILFILM: 20,
  EARTH: 21,
  WET_EARTH: 22,
  BEAM: 23,
  COLONIST: 24,
  SOLUTION: 25,
  REAGENT: 26,
  ACID_RESIDUE: 27,
  ACID_GAS: 28,
};

// "Инструмент" — в отличие от EL.*, не материал и никогда не пишется в
// sim.type; когда он выбран, ЛКМ/ПКМ на канвасе управляют не рисованием,
// а чем-то ещё (см. input.js onMouseDown и Sim.applyPressureBrush).
const TOOL_PRESSURE = 'tool:pressure';
// Тот же принцип, что и у TOOL_PRESSURE, но правит sim.temp вместо
// sim.windVX/VY (см. Sim.applyTempBrush).
const TOOL_TEMP = 'tool:temp';

const CAT = {
  POWDER: 'powder',
  LIQUID: 'liquid',
  GAS: 'gas',
  SOLID: 'solid',
  SPECIAL: 'special',
};

// density: больше -> тяжелее (тонет ниже среди подвижной материи)
const ELEMENTS = {
  [EL.SAND]:  { id: EL.SAND,  name: 'Песок',   cat: CAT.POWDER, color: [225, 201, 130], density: 16, flammable: false },
  [EL.WATER]: { id: EL.WATER, name: 'Вода',    cat: CAT.LIQUID, color: [64, 122, 224],  density: 10, flammable: false, dispersion: 6, boilPoint: 34 },
  [EL.STONE]: { id: EL.STONE, name: 'Камень',  cat: CAT.SOLID,  color: [122, 122, 130], density: 40, flammable: false, maxStability: 5, toughness: 4, meltPoint: 55, meltChance: 0.04, meltsInto: EL.LAVA },
  [EL.WOOD]:  { id: EL.WOOD,  name: 'Дерево',  cat: CAT.SOLID,  color: [126, 84, 44],   density: 40, flammable: true, burnChance: 0.14, burnLife: 55, maxStability: 3, toughness: 2 },
  [EL.OIL]:   { id: EL.OIL,   name: 'Масло',   cat: CAT.LIQUID, color: [107, 88, 38],   density: 6,  flammable: true, burnChance: 0.55, burnLife: 16, dispersion: 4 },
  [EL.LAVA]:  { id: EL.LAVA,  name: 'Лава',    cat: CAT.LIQUID, color: [232, 92, 20],   density: 30, flammable: false, dispersion: 1, heatSource: 600 },
  [EL.ACID]:  { id: EL.ACID,  name: 'Кислота', cat: CAT.LIQUID, color: [130, 224, 60],  density: 11, flammable: false, dispersion: 5 },
  [EL.ICE]:   { id: EL.ICE,   name: 'Лёд',     cat: CAT.SOLID,  color: [186, 232, 240], density: 40, flammable: false, maxStability: 3, toughness: 3 },
  [EL.STEAM]: { id: EL.STEAM, name: 'Пар',     cat: CAT.GAS,    color: [214, 214, 224], density: 2,  flammable: false },
  [EL.SMOKE]: { id: EL.SMOKE, name: 'Дым',     cat: CAT.GAS,    color: [72, 70, 76],    density: 1,  flammable: false },
  [EL.FIRE]:  { id: EL.FIRE,  name: 'Огонь',   cat: CAT.SPECIAL, color: [255, 148, 24], density: 3,  flammable: false, heatSource: 530 },
  [EL.GUNP]:  { id: EL.GUNP,  name: 'Порох',   cat: CAT.POWDER, color: [104, 98, 92],   density: 14, flammable: true, burnChance: 0.95, burnLife: 3 },
  [EL.METAL]: { id: EL.METAL, name: 'Металл',  cat: CAT.SOLID,  color: [182, 184, 194], density: 40, flammable: false, acidSlow: true, maxStability: 10, toughness: 5, meltPoint: 60, meltChance: 0.01, meltsInto: EL.LAVA },
  [EL.GLASS]: { id: EL.GLASS, name: 'Стекло',  cat: CAT.SOLID,  color: [202, 226, 230], density: 40, flammable: false, acidImmune: true, maxStability: 4, toughness: 4, meltPoint: 40, meltChance: 0.03, meltsInto: EL.LAVA },
  [EL.WALL]:  { id: EL.WALL,  name: 'Стена',   cat: CAT.SOLID,  color: [42, 42, 48],    density: 40, flammable: false, acidImmune: true },
  [EL.SALT]:  { id: EL.SALT,  name: 'Соль',    cat: CAT.POWDER, color: [232, 232, 226], density: 15, flammable: false },
  [EL.ASH]:   { id: EL.ASH,   name: 'Зола',    cat: CAT.POWDER, color: [64, 62, 60],    density: 5,  flammable: false },
  [EL.VOID]:  { id: EL.VOID,  name: 'Пустота', cat: CAT.SOLID,  color: [18, 14, 24],    density: 40, flammable: false },
  [EL.CLONE]: { id: EL.CLONE, name: 'Клонер',  cat: CAT.SOLID,  color: [224, 64, 196],  density: 40, flammable: false },
  [EL.OILFILM]: { id: EL.OILFILM, name: 'Застывшее масло', cat: CAT.SOLID, color: [90, 74, 34], density: 40, flammable: true, burnChance: 0.5, burnLife: 12, maxStability: 1, toughness: 1 },
  [EL.EARTH]: { id: EL.EARTH, name: 'Земля', cat: CAT.POWDER, color: [150, 96, 58], density: 15, flammable: false },
  [EL.WET_EARTH]: { id: EL.WET_EARTH, name: 'Мокрая земля', cat: CAT.SOLID, color: [68, 46, 32], density: 40, flammable: false, maxStability: 3, toughness: 2 },
  // Полностью повторяет камень (тот же вес/бюджет устойчивости/плавление) —
  // единственная разница в reactBeam/attemptSwapOrMove (см. sim.js): не
  // держит падающее/сыпучее/текучее, они проходят сквозь неё, и связь с
  // опорой запоминается один раз при спавне, а не пересчитывается заново.
  [EL.BEAM]: { id: EL.BEAM, name: 'Балка', cat: CAT.SOLID, color: [92, 102, 116], density: 40, flammable: false, maxStability: 5, toughness: 4, meltPoint: 55, meltChance: 0.04, meltsInto: EL.LAVA },
  // Физика сыпучего (падает как обычный порошок, см. CAT.POWDER), но со
  // своей собственной реакцией (reactColonist в sim.js) поверх — копает и
  // блуждает вместо простого лежания на месте.
  // density РОВНО как у земли (не выше и не ниже) нарочно: attemptSwapOrMove
  // вытесняет только при СТРОГОМ неравенстве плотности — при точном
  // совпадении ни земля не расталкивает колониста при осыпании рядом с
  // шахтой, ни сам колонист не проваливается сквозь землю обычной
  // гравитацией сыпучего в обход своей же логики копания (reactColonist).
  // Копает он всегда явно (clearCell + extra[i]), а не просто "тонет" в
  // земле как более тяжёлый объект.
  [EL.COLONIST]: { id: EL.COLONIST, name: 'Колонист', cat: CAT.POWDER, color: [255, 255, 255], density: 15, flammable: false },
  // ---- химия кислоты (см. блок "раствор" ниже и Sim.reactAcidic) ----
  // Раствор — любая смесь из семейства "вода/кислота/реагент" (см.
  // isSolutionFamily): состав хранится в Sim.sol (10 долей). Цвет здесь —
  // запасной; настоящий считается из состава в render.js (solutionColor).
  // Плотность как у воды: раствор не должен расслаиваться с водой, из
  // которой он в основном и состоит (кислота чуть тяжелее — 11 — и сама
  // по себе тонет в воде, но, смешавшись, становится частью раствора).
  [EL.SOLUTION]: { id: EL.SOLUTION, name: 'Раствор', cat: CAT.LIQUID, color: [100, 170, 140], density: 10, flammable: false, acidImmune: true, dispersion: 5 },
  // Химический реагент — во что превращается кислота, полностью
  // "израсходовавшая" себя на растворение (см. Sim.dissolveInto), и во что
  // спрессовывается кислотный остаток пятого уровня (см. reactAcidResidue).
  // Пока инертная тяжёлая жидкость — пригодится для будущих реакций.
  [EL.REAGENT]: { id: EL.REAGENT, name: 'Химический реагент', cat: CAT.LIQUID, color: [188, 144, 48], density: 12, flammable: false, acidImmune: true, dispersion: 4 },
  // Кислотный остаток — тёмно-зелёное сыпучее, которое кислота оставляет
  // на месте растворённого вещества. extra = уровень 1..4 (см.
  // reactAcidResidue: два остатка друг на друге сливаются, уровень
  // суммируется, с пятого — реагент); цвет по уровню — в render.js.
  // Плотность НИЖЕ любой жидкости (вода 10, кислота 11, реагент 12):
  // остаток не тонет в кислоте обычной физикой сыпучего — иначе он
  // ложился бы на дно лужи, кислота вытесняла бы его наверх правилом
  // "кислота над остатком — поменяться местами", и клетка дёргалась бы
  // вверх-вниз каждый кадр. Вместо этого он всплывает на поверхность и
  // остаётся там, не образуя защитной плёнки на растворяемом камне.
  [EL.ACID_RESIDUE]: { id: EL.ACID_RESIDUE, name: 'Кислотный остаток', cat: CAT.POWDER, color: [110, 118, 112], density: 8, flammable: false, acidImmune: true },
  // Кислотный газ — выделяется с шансом 20% при каждом акте растворения
  // (см. Sim.dissolveInto). В палитре не показывается (нет в ELEMENT_ORDER).
  [EL.ACID_GAS]: { id: EL.ACID_GAS, name: 'Кислотный газ', cat: CAT.GAS, color: [44, 92, 36], density: 2, flammable: false, acidImmune: true },
};

// Пока что в палитре временно оставлены только эти элементы — по просьбе
// пользователя. Остальные определения (ELEMENTS/EL) и вся связанная с ними
// логика (реакции и т.д.) не удалены, только убраны отсюда — чтобы вернуть
// элемент в палитру, достаточно снова добавить его в этот список.
const ELEMENT_ORDER = [
  EL.WATER, EL.STONE, EL.WOOD, EL.OIL, EL.ACID, EL.REAGENT, EL.METAL, EL.WALL, EL.STEAM, EL.LAVA, EL.EARTH, EL.BEAM, EL.COLONIST,
];

// Элементы вкладки "Технологии" — по CAT они попали бы в другие вкладки
// (балка — обычное CAT.SOLID, как камень; колонист — CAT.POWDER, как
// земля), но их место среди технологий, не среди сырых материалов (см.
// materialCategoryKey в main.js).
const TECH_ELEMENTS = new Set([EL.BEAM, EL.COLONIST]);

function isMovable(cat) {
  return cat === CAT.POWDER || cat === CAT.LIQUID || cat === CAT.GAS;
}

// "Твёрдые тела" в смысле структурной устойчивости: падают без опоры,
// но держатся друг за друга (можно строить навесы), в отличие от
// сыпучих порошков, которые и так уже падают по одной частице.
// OILFILM (застывшее масло) тоже входит — двигается/падает вместе со
// своим объектом, но в computeStability обрабатывается особо (см. sim.js):
// получает устойчивость только от своей ЕДИНСТВЕННОЙ запомненной связи
// и никогда не передаёт её дальше — не может служить мостом между
// двумя разными объектами.
function isStructural(id) {
  return id === EL.STONE || id === EL.WOOD || id === EL.METAL || id === EL.GLASS || id === EL.ICE || id === EL.OILFILM || id === EL.WET_EARTH || id === EL.BEAM;
}

// Всегда неподвижные "якоря" — сами не падают и заземляют всё, что к ним прижато.
function isAnchor(id) {
  return id === EL.WALL || id === EL.VOID || id === EL.CLONE;
}

// Непроницаемые для потоков воздуха (см. Sim.computeAirBlock/updateWind) —
// настоящая преграда, через которую ветер не диффундирует, в отличие от
// прочих твёрдых тел (камень, дерево, стекло, лёд и т.д.), которые для
// потоков воздуха прозрачны. Пустота (VOID) намеренно НЕ входит сюда —
// роль непроницаемой стены отдана именно "Стене", а не "Пустоте".
function isAirtight(id) {
  return id === EL.WALL || id === EL.METAL;
}

// Блокирует передачу ТЕПЛА (см. Sim.computeHeatBlock/updateTemp) — не то
// же самое, что isAirtight: металл перекрывает воздух, но металл — как
// раз то, что должно уметь ГРЕТЬСЯ и плавиться, а не быть неспособным
// принять хоть какое-то тепло только потому, что он же блокирует ветер.
// Реальный металл вообще-то ХОРОШО проводит тепло, несмотря на то, что
// сплошной и не пропускает сквозь себя воздух. Стена — другое дело, она
// именно как капитальная преграда и задумана.
function isHeatInsulator(id) {
  return id === EL.WALL;
}

// ---- раствор: 10 долей состава в одном Uint16 ----
//
// Каждая жидкость семейства "вода/кислота/реагент" — раствор из
// SOL_PARTS = 10 долей (по 10% состава каждая) четырёх видов:
//   SOL_ACID    — кислота: единственная "действующая" доля. Раствор
//                 разъедает соседей с шансом, пропорциональным её числу
//                 (1 доля = в 10 раз слабее чистой кислоты), и каждое
//                 растворение тратит ровно одну такую долю.
//   SOL_WATER   — вода: ничего не делает, просто разбавляет.
//   SOL_STONE   — "растворённое вещество": появляется при растворении
//                 вместо потраченной доли кислоты; при следующем
//                 растворении превращается в реагент (см. Sim.dissolveInto).
//   SOL_REAGENT — химический реагент: инертен; раствор, в котором не
//                 осталось кислоты, целиком становится реагентом.
// Состав упакован в 16 бит по 4 бита на долю (значения 0..10) — один
// typed-массив Sim.sol на всё поле, обменивается вместе с клеткой в
// swapFields, попадает в снимок отмены и в сохранение.
//
// Чистые жидкости (EL.WATER / EL.ACID / EL.REAGENT) остаются отдельными
// элементами и в Sim.sol НЕ смотрят — их состав всегда подразумевается
// (10 долей одного вида, см. Sim.liquidParts); EL.SOLUTION — любая смесь.
// Как только смесь снова становится чистой, клетка возвращается к чистому
// элементу (см. Sim.setLiquidComposition).
const SOL_PARTS = 10;
const SOL_ACID = 0, SOL_WATER = 1, SOL_STONE = 2, SOL_REAGENT = 3;
function solPack(a, w, s, r) { return a | (w << 4) | (s << 8) | (r << 12); }
function solGet(packed, slot) { return (packed >> (slot * 4)) & 15; }
const SOL_PURE_ACID = solPack(SOL_PARTS, 0, 0, 0);
const SOL_PURE_WATER = solPack(0, SOL_PARTS, 0, 0);
const SOL_PURE_REAGENT = solPack(0, 0, 0, SOL_PARTS);

// Семейство жидкостей-растворов — те, что смешиваются друг с другом и
// участвуют в общей "фазе" для вытеснения тонущими телами (см.
// LIQUID_PHASE). Масло и лава сюда НЕ входят: с водой они не смешиваются.
function isSolutionFamily(id) {
  return id === EL.WATER || id === EL.ACID || id === EL.REAGENT || id === EL.SOLUTION;
}

// "Фаза" жидкости для computeLiquidEscape/displaceLiquidThroughBody: всё
// семейство растворов считается ОДНОЙ связной жидкостью (капля раствора
// посреди озера воды — не отдельная запечатанная лужа, а часть озера),
// остальные жидкости — каждая сама по себе. Индекс — id элемента.
const LIQUID_PHASE = new Uint8Array(64);
for (let id = 0; id < 64; id++) LIQUID_PHASE[id] = isSolutionFamily(id) ? EL.WATER : id;
