'use strict';

// Линейки окисления (камень, металл, земля): стадии, элементы стадий,
// цвета и пороги хрупкости/кислотостойкости. Поведение — в sim/oxides.js.

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

// Медь зеленеет: от цвета меди к сине-зелёной патине (просьба
// "приобретает сине-зелёный окрас").
const OXIDE_COPPER_COLOR = [
  [184, 115, 51],
  [158, 118, 68],
  [132, 124, 86],
  [108, 132, 104],
  [90, 142, 120],
  [78, 150, 132],
  [70, 154, 140],
  [64, 150, 140],
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
// waterRusts — ржавит ли основу линейки вода (см. Sim.rustNeighbours).
// Сталь — своя линейка лишь ради основы (стадия 0 у неё — сталь, а не
// металл) и того, что вода её не берёт; ржавчина у неё та же, что у
// металла, те же элементы стадий и цвета. "Ржавая линейка" — любая с
// ржавчиной на стадиях, см. isRustLine.
OXIDE_LINE_METAL.waterRusts = true;
// rust — "ржавеющая" линейка: кислота её с равным шансом разъедает или
// окисляет, вода с чёрными солями ржавит, ржавчина делится стадиями с
// соседями той же линейки (reactRust). Металл, сталь, приборы и медь.
OXIDE_LINE_METAL.rust = true;
const OXIDE_LINE_STEEL = Object.assign({}, OXIDE_LINE_METAL, { base: EL.STEEL, waterRusts: false });
// Камера, монитор и панель ржавеют ровно как металл и той же ржавчиной:
// заржавев, прибор становится обычной ржавчиной (своих окислов у них нет).
const OXIDE_LINE_CAMERA = Object.assign({}, OXIDE_LINE_METAL, { base: EL.CAMERA });
const OXIDE_LINE_MONITOR = Object.assign({}, OXIDE_LINE_METAL, { base: EL.MONITOR });
const OXIDE_LINE_SOLAR = Object.assign({}, OXIDE_LINE_METAL, { base: EL.SOLAR });
const OXIDE_LINE_GENERATOR = Object.assign({}, OXIDE_LINE_METAL, { base: EL.GENERATOR });
// Медь — как металл, но своими окислами (патина) и хрупкая, как дерево.
const OXIDE_LINE_COPPER = Object.assign({}, OXIDE_LINE_METAL, { base: EL.COPPER, solid: EL.COPPER_OXIDE, loose: EL.COPPER_OXIDE_LOOSE, colors: OXIDE_COPPER_COLOR });
// Усилитель ржавеет как медь, в ту же патину, и, заржавев, усилителем
// быть перестаёт.
const OXIDE_LINE_AMPLIFIER = Object.assign({}, OXIDE_LINE_COPPER, { base: EL.AMPLIFIER });
// Изолятор кислоте поддаётся как земля — её линейкой.
const OXIDE_LINE_INSULATOR = Object.assign({}, OXIDE_LINE_EARTH, { base: EL.INSULATOR });
// Ржавеющая линейка (см. rust выше).
function isRustLine(line) { return !!line && line.rust === true; }
// Одна ли "семья" ржавчины у двух линеек: общий элемент твёрдой стадии
// (у металла, стали и приборов — одна ржавчина, у меди — патина).
function sameRustFamily(a, b) { return !!a && !!b && a.solid === b.solid; }
const OXIDE_LINE = [];
OXIDE_LINE[EL.STEEL] = OXIDE_LINE_STEEL;
OXIDE_LINE[EL.STONE] = OXIDE_LINE_STONE;
OXIDE_LINE[EL.OXIDE] = OXIDE_LINE_STONE;
OXIDE_LINE[EL.OXIDE_LOOSE] = OXIDE_LINE_STONE;
OXIDE_LINE[EL.METAL] = OXIDE_LINE_METAL;
OXIDE_LINE[EL.METAL_OXIDE] = OXIDE_LINE_METAL;
OXIDE_LINE[EL.METAL_OXIDE_LOOSE] = OXIDE_LINE_METAL;
OXIDE_LINE[EL.EARTH] = OXIDE_LINE_EARTH;
OXIDE_LINE[EL.EARTH_OXIDE] = OXIDE_LINE_EARTH;
OXIDE_LINE[EL.CAMERA] = OXIDE_LINE_CAMERA;
OXIDE_LINE[EL.MONITOR] = OXIDE_LINE_MONITOR;
OXIDE_LINE[EL.SOLAR] = OXIDE_LINE_SOLAR;
OXIDE_LINE[EL.GENERATOR] = OXIDE_LINE_GENERATOR;
OXIDE_LINE[EL.AMPLIFIER] = OXIDE_LINE_AMPLIFIER;
OXIDE_LINE[EL.COPPER] = OXIDE_LINE_COPPER;
OXIDE_LINE[EL.COPPER_OXIDE] = OXIDE_LINE_COPPER;
OXIDE_LINE[EL.COPPER_OXIDE_LOOSE] = OXIDE_LINE_COPPER;
OXIDE_LINE[EL.INSULATOR] = OXIDE_LINE_INSULATOR;

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
// Цвет клетки по составу (просьба пользователя: "цвет пикселя — это
// усреднённый цвет всех входящих в него"). Живёт здесь, а не в
// data/composition.js, по истории: раньше чёрные соли красились в цвет
// ржавчины, заданный выше.
//
// Обычные доли: среднее цветов вещественных долей (пустота не красит —
// она делает клетку бледнее, это в Renderer.cellColor). Чёрные соли —
// не долей в среднем, а поверх: с 1 до SALT_GREY_AT долей оттенок воды
// (или чего угодно ещё) уходит в серый и на SALT_GREY_AT исчезает совсем,
// дальше до 10 долей клетка понемногу чернеет. Раньше соли тянули к цвету
// ржавчины — пользователь передумал: вода с солями должна чернеть, а не
// ржаветь на вид. Шейдер повторяет эту функцию (render-gl.js,
// partsColor): правя здесь, правь и там.
const SALT_GREY_AT = 3;
const SALT_GREY_COLOR = [92, 92, 96];
const SALT_BLACK_COLOR = [30, 30, 34];
// Грязь (просьба пользователя: мокрая грязь выглядела голубой, будто
// застывшая вода): доли грязи уводят цвет к цвету грязи — к MUD_FULL_AT
// долям полностью, — а дальше он темнеет к MUD_DARK_COLOR (у чистой грязи).
// Как у солей, только к своему цвету. Шейдер (render-gl.js) — так же.
const MUD_FULL_AT = 5;
const MUD_DARK_COLOR = [64, 44, 28];

function solColor(comp) {
  const matter = solMatter(comp);
  if (matter <= 0) return [14, 14, 18];
  const s = solGet(comp, P_SALT), m = solGet(comp, EL.MUD);
  const other = matter - s - m;
  let r, g, b;
  if (other > 0) {
    r = 0; g = 0; b = 0;
    for (let k = 0; k < SOL_SLOTS; k++) {
      const slot = solSlot(comp, k);
      if (!slot) break;
      const id = slotId(slot);
      if (id === P_SALT || id === EL.MUD) continue;
      const n = slotCount(slot);
      const col = PART_COLOR[id];
      r += col[0] * n; g += col[1] * n; b += col[2] * n;
    }
    r /= other; g /= other; b /= other;
  } else {
    const c0 = m > 0 ? PART_COLOR[EL.MUD] : SALT_GREY_COLOR;
    r = c0[0]; g = c0[1]; b = c0[2];
  }
  if (m > 0) {
    const mc = PART_COLOR[EL.MUD];
    if (m <= MUD_FULL_AT) {
      const t = m / MUD_FULL_AT;
      r += (mc[0] - r) * t; g += (mc[1] - g) * t; b += (mc[2] - b) * t;
    } else {
      const t = (m - MUD_FULL_AT) / (SOL_PARTS - MUD_FULL_AT);
      r = mc[0] + (MUD_DARK_COLOR[0] - mc[0]) * t; g = mc[1] + (MUD_DARK_COLOR[1] - mc[1]) * t; b = mc[2] + (MUD_DARK_COLOR[2] - mc[2]) * t;
    }
  }
  if (s === 0) return [r, g, b];
  if (s <= SALT_GREY_AT) {
    const t = s / SALT_GREY_AT;
    return [r + (SALT_GREY_COLOR[0] - r) * t, g + (SALT_GREY_COLOR[1] - g) * t, b + (SALT_GREY_COLOR[2] - b) * t];
  }
  const t = (s - SALT_GREY_AT) / (SOL_PARTS - SALT_GREY_AT);
  return [
    SALT_GREY_COLOR[0] + (SALT_BLACK_COLOR[0] - SALT_GREY_COLOR[0]) * t,
    SALT_GREY_COLOR[1] + (SALT_BLACK_COLOR[1] - SALT_GREY_COLOR[1]) * t,
    SALT_GREY_COLOR[2] + (SALT_BLACK_COLOR[2] - SALT_GREY_COLOR[2]) * t,
  ];
}

const OXIDE_FRAIL_FROM = new Int8Array(64);
OXIDE_FRAIL_FROM[EL.OXIDE] = OXIDE_LINE_STONE.frailStage;
OXIDE_FRAIL_FROM[EL.OXIDE_LOOSE] = -1;
OXIDE_FRAIL_FROM[EL.METAL_OXIDE] = OXIDE_LINE_METAL.frailStage;
OXIDE_FRAIL_FROM[EL.METAL_OXIDE_LOOSE] = -1;
OXIDE_FRAIL_FROM[EL.COPPER_OXIDE] = OXIDE_LINE_COPPER.frailStage;
OXIDE_FRAIL_FROM[EL.COPPER_OXIDE_LOOSE] = -1;
