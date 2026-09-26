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
const OXIDE_LINE_STEEL = Object.assign({}, OXIDE_LINE_METAL, { base: EL.STEEL, waterRusts: false });
// Ржавеющая (металлическая) линейка — металл или сталь. Сравнивается по
// элементу ржавчины, а не по самой линейке: у стали и металла линейки
// разные объекты, а ржавчина одна.
function isRustLine(line) { return !!line && line.solid === EL.METAL_OXIDE; }
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
// data/composition.js, потому что чёрные соли красятся в цвет ржавчины —
// а он задан выше.
//
// Обычные доли: среднее цветов вещественных долей (пустота не красит —
// она делает клетку бледнее, это в Renderer.cellColor). Чёрные соли —
// не долей в среднем, а поверх: с 1 до SALT_RUST_AT долей клетка тянется
// к цвету ржавчины и на SALT_RUST_AT от неё не отличима, дальше до 10
// долей — чернеет. Шейдер повторяет эту функцию (render-gl.js,
// partsColor): правя здесь, правь и там.
const SALT_RUST_AT = 5;
const SALT_RUST_COLOR = OXIDE_METAL_COLOR[5];
const SALT_BLACK_COLOR = [24, 22, 26];
function solColor(comp) {
  const matter = solMatter(comp);
  if (matter <= 0) return [14, 14, 18];
  const s = solGet(comp, P_SALT);
  const other = matter - s;
  let r, g, b;
  if (other > 0) {
    r = 0; g = 0; b = 0;
    for (let k = 0; k < SOL_SLOTS; k++) {
      const slot = solSlot(comp, k);
      if (!slot) break;
      const id = slotId(slot);
      if (id === P_SALT) continue;
      const n = slotCount(slot);
      const col = PART_COLOR[id];
      r += col[0] * n; g += col[1] * n; b += col[2] * n;
    }
    r /= other; g /= other; b /= other;
  } else {
    r = SALT_RUST_COLOR[0]; g = SALT_RUST_COLOR[1]; b = SALT_RUST_COLOR[2];
  }
  if (s === 0) return [r, g, b];
  if (s <= SALT_RUST_AT) {
    const t = s / SALT_RUST_AT;
    return [r + (SALT_RUST_COLOR[0] - r) * t, g + (SALT_RUST_COLOR[1] - g) * t, b + (SALT_RUST_COLOR[2] - b) * t];
  }
  const t = (s - SALT_RUST_AT) / (SOL_PARTS - SALT_RUST_AT);
  return [
    SALT_RUST_COLOR[0] + (SALT_BLACK_COLOR[0] - SALT_RUST_COLOR[0]) * t,
    SALT_RUST_COLOR[1] + (SALT_BLACK_COLOR[1] - SALT_RUST_COLOR[1]) * t,
    SALT_RUST_COLOR[2] + (SALT_BLACK_COLOR[2] - SALT_RUST_COLOR[2]) * t,
  ];
}

const OXIDE_FRAIL_FROM = new Int8Array(64);
OXIDE_FRAIL_FROM[EL.OXIDE] = OXIDE_LINE_STONE.frailStage;
OXIDE_FRAIL_FROM[EL.OXIDE_LOOSE] = -1;
OXIDE_FRAIL_FROM[EL.METAL_OXIDE] = OXIDE_LINE_METAL.frailStage;
OXIDE_FRAIL_FROM[EL.METAL_OXIDE_LOOSE] = -1;
