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
};

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
  [EL.WATER]: { id: EL.WATER, name: 'Вода',    cat: CAT.LIQUID, color: [64, 122, 224],  density: 10, flammable: false, dispersion: 6 },
  [EL.STONE]: { id: EL.STONE, name: 'Камень',  cat: CAT.SOLID,  color: [122, 122, 130], density: 40, flammable: false },
  [EL.WOOD]:  { id: EL.WOOD,  name: 'Дерево',  cat: CAT.SOLID,  color: [126, 84, 44],   density: 40, flammable: true, burnChance: 0.14, burnLife: 55 },
  [EL.OIL]:   { id: EL.OIL,   name: 'Масло',   cat: CAT.LIQUID, color: [107, 88, 38],   density: 6,  flammable: true, burnChance: 0.55, burnLife: 16, dispersion: 4 },
  [EL.LAVA]:  { id: EL.LAVA,  name: 'Лава',    cat: CAT.LIQUID, color: [232, 92, 20],   density: 30, flammable: false, dispersion: 1 },
  [EL.ACID]:  { id: EL.ACID,  name: 'Кислота', cat: CAT.LIQUID, color: [130, 224, 60],  density: 11, flammable: false, dispersion: 5 },
  [EL.ICE]:   { id: EL.ICE,   name: 'Лёд',     cat: CAT.SOLID,  color: [186, 232, 240], density: 40, flammable: false },
  [EL.STEAM]: { id: EL.STEAM, name: 'Пар',     cat: CAT.GAS,    color: [214, 214, 224], density: 2,  flammable: false },
  [EL.SMOKE]: { id: EL.SMOKE, name: 'Дым',     cat: CAT.GAS,    color: [72, 70, 76],    density: 1,  flammable: false },
  [EL.FIRE]:  { id: EL.FIRE,  name: 'Огонь',   cat: CAT.SPECIAL, color: [255, 148, 24], density: 3,  flammable: false },
  [EL.GUNP]:  { id: EL.GUNP,  name: 'Порох',   cat: CAT.POWDER, color: [104, 98, 92],   density: 14, flammable: true, burnChance: 0.95, burnLife: 3 },
  [EL.METAL]: { id: EL.METAL, name: 'Металл',  cat: CAT.SOLID,  color: [182, 184, 194], density: 40, flammable: false, acidSlow: true },
  [EL.GLASS]: { id: EL.GLASS, name: 'Стекло',  cat: CAT.SOLID,  color: [202, 226, 230], density: 40, flammable: false, acidImmune: true },
  [EL.WALL]:  { id: EL.WALL,  name: 'Стена',   cat: CAT.SOLID,  color: [42, 42, 48],    density: 40, flammable: false, acidImmune: true },
  [EL.SALT]:  { id: EL.SALT,  name: 'Соль',    cat: CAT.POWDER, color: [232, 232, 226], density: 15, flammable: false },
  [EL.ASH]:   { id: EL.ASH,   name: 'Зола',    cat: CAT.POWDER, color: [64, 62, 60],    density: 5,  flammable: false },
  [EL.VOID]:  { id: EL.VOID,  name: 'Пустота', cat: CAT.SOLID,  color: [18, 14, 24],    density: 40, flammable: false },
  [EL.CLONE]: { id: EL.CLONE, name: 'Клонер',  cat: CAT.SOLID,  color: [224, 64, 196],  density: 40, flammable: false },
};

const ELEMENT_ORDER = [
  EL.SAND, EL.WATER, EL.STONE, EL.WOOD, EL.OIL,
  EL.LAVA, EL.ACID, EL.ICE, EL.STEAM, EL.SMOKE,
  EL.FIRE, EL.GUNP, EL.METAL, EL.GLASS, EL.WALL,
  EL.SALT, EL.ASH, EL.VOID, EL.CLONE,
];

function isMovable(cat) {
  return cat === CAT.POWDER || cat === CAT.LIQUID || cat === CAT.GAS;
}
