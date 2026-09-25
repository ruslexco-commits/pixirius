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
  VAPOR: 29,
  OXIDE: 30,
  OXIDE_LOOSE: 31,
  METAL_OXIDE: 32,
  METAL_OXIDE_LOOSE: 33,
  EARTH_OXIDE: 34,
  ACID_ICE: 35,
  REAGENT_ICE: 36,
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
  [EL.WATER]: { id: EL.WATER, name: 'Вода',    cat: CAT.LIQUID, color: [64, 122, 224],  density: 10, flammable: false, dispersion: 6, boilPoint: 100 },
  [EL.STONE]: { id: EL.STONE, name: 'Камень',  cat: CAT.SOLID,  color: [122, 122, 130], density: 40, flammable: false, maxStability: 5, toughness: 4, meltPoint: 165, meltChance: 0.04, meltsInto: EL.LAVA },
  [EL.WOOD]:  { id: EL.WOOD,  name: 'Дерево',  cat: CAT.SOLID,  color: [126, 84, 44],   density: 40, flammable: true, burnChance: 0.14, burnLife: 55, maxStability: 3, toughness: 2 },
  [EL.OIL]:   { id: EL.OIL,   name: 'Масло',   cat: CAT.LIQUID, color: [107, 88, 38],   density: 6,  flammable: true, burnChance: 0.55, burnLife: 16, dispersion: 4 },
  [EL.LAVA]:  { id: EL.LAVA,  name: 'Лава',    cat: CAT.LIQUID, color: [232, 92, 20],   density: 30, flammable: false, dispersion: 1, heatSource: 1800 },
  [EL.ACID]:  { id: EL.ACID,  name: 'Кислота', cat: CAT.LIQUID, color: [130, 224, 60],  density: 11, flammable: false, dispersion: 5, boilPoint: 60 },
  [EL.ICE]:   { id: EL.ICE,   name: 'Лёд',     cat: CAT.SOLID,  color: [186, 232, 240], density: 40, flammable: false, maxStability: 3, toughness: 3, baseTemp: -20 },
  [EL.STEAM]: { id: EL.STEAM, name: 'Пар',     cat: CAT.GAS,    color: [214, 214, 224], density: 2,  flammable: false },
  [EL.SMOKE]: { id: EL.SMOKE, name: 'Дым',     cat: CAT.GAS,    color: [72, 70, 76],    density: 1,  flammable: false },
  [EL.FIRE]:  { id: EL.FIRE,  name: 'Огонь',   cat: CAT.SPECIAL, color: [255, 148, 24], density: 3,  flammable: false, heatSource: 1590 },
  [EL.GUNP]:  { id: EL.GUNP,  name: 'Порох',   cat: CAT.POWDER, color: [104, 98, 92],   density: 14, flammable: true, burnChance: 0.95, burnLife: 3 },
  [EL.METAL]: { id: EL.METAL, name: 'Металл',  cat: CAT.SOLID,  color: [182, 184, 194], density: 40, flammable: false, acidSlow: true, maxStability: 10, toughness: 5, meltPoint: 180, meltChance: 0.01, meltsInto: EL.LAVA },
  [EL.GLASS]: { id: EL.GLASS, name: 'Стекло',  cat: CAT.SOLID,  color: [202, 226, 230], density: 40, flammable: false, acidImmune: true, maxStability: 4, toughness: 4, meltPoint: 120, meltChance: 0.03, meltsInto: EL.LAVA },
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
  [EL.BEAM]: { id: EL.BEAM, name: 'Балка', cat: CAT.SOLID, color: [92, 102, 116], density: 40, flammable: false, maxStability: 5, toughness: 4, meltPoint: 165, meltChance: 0.04, meltsInto: EL.LAVA },
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
  [EL.REAGENT]: { id: EL.REAGENT, name: 'Химический реагент', cat: CAT.LIQUID, color: [188, 144, 48], density: 12, flammable: false, acidImmune: true, dispersion: 4, boilPoint: 250 },
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
  // Смешанный газ — газовая фаза той же системы долей, что и раствор (см.
  // блок "состав" ниже). Чистый водяной и чистый кислотный газ показываются
  // своими привычными элементами (Пар / Кислотный газ), всё остальное —
  // смеси, газообразный реагент и газообразное масло — этим. Цвет считается
  // из состава (render.js, vaporColor). В палитре не показывается.
  [EL.VAPOR]: { id: EL.VAPOR, name: 'Смешанный газ', cat: CAT.GAS, color: [150, 150, 160], density: 2, flammable: false, acidImmune: true },
  // Окисел — во что химический реагент превращает камень (см.
  // Sim.oxidiseNeighbours). Стадия 1..3 лежит в extra, и чем она выше, тем
  // желтее клетка (цвет считается в render.js, oxideColor).
  //
  // Стадии 1 и 2 — обычное твёрдое тело, держится как камень. Стадия 3
  // сыпучая, и это ОТДЕЛЬНЫЙ элемент, а не флаг: категория (CAT) и
  // структурность читаются по типу в десятке мест (computeStability,
  // updateCell, вытеснение жидкостей), и один элемент с "иногда сыпучим"
  // поведением пришлось бы отдельно оговаривать в каждом из них.
  // Стадия при этом остаётся единым понятием — см. Sim.oxideStage.
  //
  // Кислота окисел не берёт (acidImmune): по заданию он ею не растворяется.
  [EL.OXIDE]: { id: EL.OXIDE, name: 'Окисел', cat: CAT.SOLID, color: [104, 98, 74], density: 40, flammable: false, acidImmune: true, maxStability: 4, toughness: 3 },
  [EL.OXIDE_LOOSE]: { id: EL.OXIDE_LOOSE, name: 'Рыхлый окисел', cat: CAT.POWDER, color: [148, 132, 40], density: 16, flammable: false, acidImmune: true },
  // Окисел МЕТАЛЛА — своя, отдельная от каменной линейка: семь стадий
  // вместо трёх, цвет уходит в коричневый, и стадиями с соседями он НЕ
  // делится (см. Sim.reactOxide — ржавчина расползается по поверхности
  // сама, а не проедает металл вглубь, как окисел камень).
  // Кислота берёт его только до третьей стадии включительно; с четвёртой
  // окисленный металл ей уже не по зубам (см. Sim.acidImmuneAt).
  [EL.METAL_OXIDE]: { id: EL.METAL_OXIDE, name: 'Окисел металла', cat: CAT.SOLID, color: [146, 130, 114], density: 40, flammable: false, acidSlow: true, maxStability: 8, toughness: 4 },
  [EL.METAL_OXIDE_LOOSE]: { id: EL.METAL_OXIDE_LOOSE, name: 'Рыхлый окисел металла', cat: CAT.POWDER, color: [78, 50, 28], density: 16, flammable: false, acidImmune: true },
  // Окисел ЗЕМЛИ — третья линейка: десять стадий, тёмно-коричневый, и в
  // отличие от камня с металлом сыпучий НА ВСЕХ стадиях, а не только на
  // последней (земля и так сыпучая, окисляясь плотнее она не становится).
  // Поэтому у линейки один и тот же элемент и на "твёрдые" стадии, и на
  // последнюю — см. OXIDE_LINE_EARTH ниже. Кислоте перестаёт поддаваться
  // с девятой стадии.
  [EL.EARTH_OXIDE]: { id: EL.EARTH_OXIDE, name: 'Земляной окисел', cat: CAT.POWDER, color: [82, 56, 34], density: 15, flammable: false },
  // Замёрзшие кислота и реагент — твёрдая фаза этих жидкостей, такая же,
  // как лёд для воды. Держатся и тают по своим точкам замерзания (-30 и
  // -60, см. PART_FREEZE), возвращаясь ровно в своё вещество, а не в
  // воду — поэтому это отдельные элементы, а не общий лёд.
  [EL.ACID_ICE]: { id: EL.ACID_ICE, name: 'Замёрзшая кислота', cat: CAT.SOLID, color: [96, 178, 74], density: 40, flammable: false, acidImmune: true, maxStability: 3, toughness: 3, baseTemp: -40 },
  [EL.REAGENT_ICE]: { id: EL.REAGENT_ICE, name: 'Замёрзший реагент', cat: CAT.SOLID, color: [150, 122, 60], density: 40, flammable: false, acidImmune: true, maxStability: 3, toughness: 3, baseTemp: -70 },
};

// Пока что в палитре временно оставлены только эти элементы — по просьбе
// пользователя. Остальные определения (ELEMENTS/EL) и вся связанная с ними
// логика (реакции и т.д.) не удалены, только убраны отсюда — чтобы вернуть
// элемент в палитру, достаточно снова добавить его в этот список.
const ELEMENT_ORDER = [
  EL.WATER, EL.STONE, EL.WOOD, EL.OIL, EL.ACID, EL.REAGENT, EL.METAL, EL.WALL, EL.STEAM, EL.LAVA, EL.EARTH, EL.BEAM, EL.COLONIST,
  // Окислы и остальные газы — их место во вкладке "Все" (по своей
  // категории они разошлись бы по "Телам", "Сыпучему" и бывшей вкладке
  // газов, а увидеть их полезно все сразу).
  EL.OXIDE, EL.OXIDE_LOOSE, EL.METAL_OXIDE, EL.METAL_OXIDE_LOOSE, EL.EARTH_OXIDE, EL.ACID_GAS, EL.VAPOR, EL.SMOKE, EL.ACID_RESIDUE,
  EL.ICE, EL.ACID_ICE, EL.REAGENT_ICE,
];

// Элементы вкладки "Технологии" — по CAT они попали бы в другие вкладки
// (балка — обычное CAT.SOLID, как камень; колонист — CAT.POWDER, как
// земля), но их место среди технологий, не среди сырых материалов (см.
// materialCategoryKey в main.js).
const TECH_ELEMENTS = new Set([EL.BEAM, EL.COLONIST]);

// Собственная температура свежей частицы, если у элемента не задана своя
// (baseTemp). Спавн ПРИБАВЛЯЕТ её к температуре места, а не заменяет ею:
// вещество приносит с собой своё тепло или холод, а не мгновенно
// принимает температуру фона. Комнатные 20 градусов — для всего обычного;
// у льда и замёрзших жидкостей стоят свои минусовые значения, у лавы и
// огня работает прежний heatSource.
const DEFAULT_BASE_TEMP = 20;

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
  return id === EL.STONE || id === EL.WOOD || id === EL.METAL || id === EL.GLASS || id === EL.ICE || id === EL.OILFILM || id === EL.WET_EARTH || id === EL.BEAM || id === EL.OXIDE || id === EL.METAL_OXIDE;
}

// Окисел любой стадии и любого металла-основы (число стадии — в
// Sim.oxideStage, основа — в OXIDE_BASE ниже).
function isOxide(id) {
  return id === EL.OXIDE || id === EL.OXIDE_LOOSE || id === EL.METAL_OXIDE || id === EL.METAL_OXIDE_LOOSE || id === EL.EARTH_OXIDE;
}

// Твёрдая фаза жидкости (лёд и его сородичи) — её тает обратно tickPhase.
function isFrozenLiquid(id) {
  return id === EL.ICE || id === EL.ACID_ICE || id === EL.REAGENT_ICE;
}
function isMetalOxide(id) {
  return id === EL.METAL_OXIDE || id === EL.METAL_OXIDE_LOOSE;
}

// Линейка окисления: из какого материала, сколько стадий, какие элементы
// отвечают за твёрдые стадии и за последнюю (сыпучую), и цвета стадий.
// Камень окисляется в три стадии, металл — в семь; общее у них только то,
// что последняя стадия всегда сыпучая.
//
// Цвета заметно темнее прежних (просьба "сделай окислы более тёмными") и
// в render.js дополнительно расходятся по яркости и насыщенности от
// клетки к клетке, как у обычных материалов.
const OXIDE_STONE_COLOR = [
  [122, 122, 130],
  [84, 79, 58],
  [100, 90, 40],
  [118, 104, 30],
];
const OXIDE_METAL_COLOR = [
  [182, 184, 194],
  [160, 150, 142],
  [146, 130, 114],
  [132, 110, 88],
  [118, 92, 66],
  [104, 76, 50],
  [90, 62, 38],
  [78, 50, 28],
];

// Описание линейки по id элемента-основы или любого её окисла.
// maxStage — последняя стадия (она же сыпучая), solid/loose — элементы,
// base — исходный материал, colors — цвета по стадиям.
// Цвета земляного окисла: от цвета земли в густой тёмно-коричневый.
const OXIDE_EARTH_COLOR = [
  [150, 96, 58],
  [140, 90, 54],
  [130, 84, 50],
  [121, 79, 47],
  [112, 74, 44],
  [103, 69, 41],
  [95, 64, 39],
  [88, 60, 37],
  [82, 56, 34],
  [74, 50, 31],
  [64, 43, 26],
];

// spreads — делится ли окисел стадиями с соседями (камень делится и
// прорастает вглубь слоем, металл и земля — нет).
// acidProofStage — с какой стадии кислота его уже не берёт (0 = берёт
// всегда, пока не кончится линейка).
// allLoose — сыпучий на всех стадиях, а не только на последней.
const OXIDE_LINE_STONE = { base: EL.STONE, maxStage: 3, solid: EL.OXIDE, loose: EL.OXIDE_LOOSE, colors: OXIDE_STONE_COLOR, spreads: true, acidProofStage: 0, allLoose: false, frailStage: 2 };
const OXIDE_LINE_METAL = { base: EL.METAL, maxStage: 7, solid: EL.METAL_OXIDE, loose: EL.METAL_OXIDE_LOOSE, colors: OXIDE_METAL_COLOR, spreads: false, acidProofStage: 4, allLoose: false, frailStage: 5 };
const OXIDE_LINE_EARTH = { base: EL.EARTH, maxStage: 10, solid: EL.EARTH_OXIDE, loose: EL.EARTH_OXIDE, colors: OXIDE_EARTH_COLOR, spreads: false, acidProofStage: 9, allLoose: true, frailStage: 0 };
const OXIDE_LINE = [];
OXIDE_LINE[EL.STONE] = OXIDE_LINE_STONE;
OXIDE_LINE[EL.OXIDE] = OXIDE_LINE_STONE;
OXIDE_LINE[EL.OXIDE_LOOSE] = OXIDE_LINE_STONE;
OXIDE_LINE[EL.METAL] = OXIDE_LINE_METAL;
OXIDE_LINE[EL.METAL_OXIDE] = OXIDE_LINE_METAL;
OXIDE_LINE[EL.METAL_OXIDE_LOOSE] = OXIDE_LINE_METAL;
OXIDE_LINE[EL.EARTH] = OXIDE_LINE_EARTH;
OXIDE_LINE[EL.EARTH_OXIDE] = OXIDE_LINE_EARTH;

// Стойкость дерева — её получают окислы, начиная со своей frailStage:
// окалина и ржавчина держат навес заметно хуже исходного камня или
// металла (просьба "параметры стойкости как у дерева").
const OXIDE_FRAIL_STABILITY = 3;
const OXIDE_FRAIL_TOUGHNESS = 2;

// С какой стадии окисел становится хрупким, разложено в таблицу по id —
// computeStability читает её для КАЖДОЙ клетки поля каждый кадр, и там
// недопустимо разбирать линейку и считать стадию через вызовы (замер:
// это одно стоило 12 мс на кадр). 0 — не окисел, -1 — хрупкий всегда
// (последняя, сыпучая стадия), больше нуля — сравнить со стадией в extra.
const OXIDE_FRAIL_FROM = new Int8Array(64);
OXIDE_FRAIL_FROM[EL.OXIDE] = OXIDE_LINE_STONE.frailStage;
OXIDE_FRAIL_FROM[EL.OXIDE_LOOSE] = -1;
OXIDE_FRAIL_FROM[EL.METAL_OXIDE] = OXIDE_LINE_METAL.frailStage;
OXIDE_FRAIL_FROM[EL.METAL_OXIDE_LOOSE] = -1;

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
// Быстрая таблица "клетка ведёт себя как газ" для горячего пути
// updateTemp: газ — это разреженное вещество, перемешанное с воздухом, и
// остывает он как воздух, а не как плотное тело (см. DECAY_AIR там).
// Индекс — id элемента, поэтому проверка стоит одно чтение массива.
const IS_GASLIKE = new Uint8Array(64);
for (let id = 0; id < 64; id++) IS_GASLIKE[id] = (ELEMENTS[id] && ELEMENTS[id].cat === CAT.GAS) ? 1 : 0;

const LIQUID_PHASE = new Uint8Array(64);
for (let id = 0; id < 64; id++) LIQUID_PHASE[id] = isSolutionFamily(id) ? EL.WATER : id;
