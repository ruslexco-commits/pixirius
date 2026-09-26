'use strict';

// Таблица элементов: идентификаторы, свойства, порядок в палитре и
// предикаты-категории (isStructural, isAnchor, ...). Только данные и
// чистые функции от id — никакого состояния мира.
//
// Состав жидкостей и газов (доли, точки кипения) — в data/composition.js,
// линейки окисления — в data/oxides.js.

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
  HUMAN: 37,
  STEEL: 38,
  BLACK_SALT: 39,
  REAGENT_GAS: 40,
  OIL_GAS: 41,
  DISSOLVER: 42,
  DISSOLVER_GAS: 43,
  DISSOLVER_ICE: 44,
};

// "Инструмент" — в отличие от EL.*, не материал и никогда не пишется в
// sim.type; когда он выбран, ЛКМ/ПКМ на канвасе управляют не рисованием,
// а чем-то ещё (см. input.js onMouseDown и Sim.applyPressureBrush).
const TOOL_PRESSURE = 'tool:pressure';
// Тот же принцип, что и у TOOL_PRESSURE, но правит sim.temp вместо
// sim.windVX/VY (см. Sim.applyTempBrush).
const TOOL_TEMP = 'tool:temp';
// Лупа: мир не трогает вовсе, щелчок по клетке показывает, что в ней —
// у раствора и газа по долям (см. buildCellInspectHTML в main.js).
const TOOL_INSPECT = 'tool:inspect';

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
  // единственная разница в поведении балки (см. sim/stability.js): не
  // держит падающее/сыпучее/текучее, они проходят сквозь неё, и связь с
  // опорой запоминается один раз при спавне, а не пересчитывается заново.
  [EL.BEAM]: { id: EL.BEAM, name: 'Балка', cat: CAT.SOLID, color: [92, 102, 116], density: 40, flammable: false, maxStability: 5, toughness: 4, meltPoint: 165, meltChance: 0.04, meltsInto: EL.LAVA },
  // Физика сыпучего (падает как обычный порошок, см. CAT.POWDER), но со
  // своей собственной реакцией (reactColonist в sim/colonist.js) поверх — копает и
  // блуждает вместо простого лежания на месте.
  // density РОВНО как у земли (не выше и не ниже) нарочно: attemptSwapOrMove
  // вытесняет только при СТРОГОМ неравенстве плотности — при точном
  // совпадении ни земля не расталкивает колониста при осыпании рядом с
  // шахтой, ни сам колонист не проваливается сквозь землю обычной
  // гравитацией сыпучего в обход своей же логики копания (reactColonist).
  // Копает он всегда явно (clearCell + extra[i]), а не просто "тонет" в
  // земле как более тяжёлый объект.
  [EL.COLONIST]: { id: EL.COLONIST, name: 'Колонист', cat: CAT.POWDER, color: [255, 255, 255], density: 15, flammable: false },
  // ---- химия кислоты (см. блок "раствор" ниже и Sim.reactSolutionLike, sim/chemistry.js) ----
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
  // Окисел МЕТАЛЛА (ржавчина) — своя, отдельная от каменной линейка: семь
  // стадий вместо трёх, цвет уходит в коричневый. Соседей окисляет по
  // своим правилам, зависящим от стадии, и отслаивается в окисляющую
  // жидкость (см. Sim.reactRust и rustFlake).
  // Кислота берёт его только до третьей стадии включительно; с четвёртой
  // окисленный металл ей уже не по зубам (см. Sim.acidProof).
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
  // Человек — единственный житель мира: ходит сам, боится опасного и
  // запоминает, куда ходить не стоит (см. Sim.reactHuman). Физика как у
  // сыпучего (падает), всё остальное — своя реакция.
  // life[i] — личный номер (по нему в Sim._humans лежит его память:
  // запреты, направление, счётчик мокрой головы), extra[i] — 1, если
  // мёртв. Плотность как у земли, чтобы не тонуть в ней и не расталкивать.
  // acidImmune не про стойкость, а про то, ЧТО с ним происходит: кислота
  // не должна растворять человека в никуда — он от неё умирает и остаётся
  // лежать (см. Sim.reactHuman). Без этого людей рядом с лужей просто
  // не досчитывались, вместо того чтобы видеть потемневшие тела.
  [EL.HUMAN]: { id: EL.HUMAN, name: 'Человек', cat: CAT.POWDER, color: [236, 226, 210], density: 15, flammable: false, acidImmune: true },
  [EL.REAGENT_ICE]: { id: EL.REAGENT_ICE, name: 'Замёрзший реагент', cat: CAT.SOLID, color: [150, 122, 60], density: 40, flammable: false, acidImmune: true, maxStability: 3, toughness: 3, baseTemp: -70 },
  // Сталь — металл, которому вода нипочём: ржавеет она только от кислоты,
  // реагента и соседней ржавчины (у её линейки окисления waterRusts=false,
  // см. data/oxides.js). Покрытие из стали держит сколько угодно воды, пока
  // его не коснётся кислота или ржавчина — дальше ржавчина расползается от
  // этой точки (см. Sim.reactRust). Ржавеет в ту же ржавчину, что и
  // металл. Цвет чуть темнее металла, стойкость выше, плавится на 50
  // градусов позже (точка плавления задаётся ниже, от металла).
  [EL.STEEL]: { id: EL.STEEL, name: 'Сталь', cat: CAT.SOLID, color: [150, 154, 166], density: 40, flammable: false, acidSlow: true, maxStability: 14, toughness: 7 },
  // Чёрные соли — то, во что вода, ржавя металл, превращает свою долю
  // (см. Sim.rustNeighbours): стоячая вода над ржавеющим железом понемногу
  // чернеет. Соль живёт в той же системе долей, что и жидкости (вид
  // P_SALT, data/composition.js): растворяется в них, перемешиваясь долями.
  // Этот элемент — сыпучая фаза: клетка, где солей больше пяти долей из
  // десяти (SALT_POWDER_FROM), сыпучая и тонет; меньше — остаётся жидким
  // раствором (см. Sim.setComposition). Цвет считается из состава. Не
  // испаряется и не плавится. Кислота соль не разъедает — растворяет в
  // себе, как любая жидкость (acidImmune).
  [EL.BLACK_SALT]: { id: EL.BLACK_SALT, name: 'Чёрные соли', cat: CAT.POWDER, color: [46, 44, 50], density: 18, flammable: false, acidImmune: true },
  // Газовые фазы реагента и масла. Раньше газ этих веществ показывался
  // общим "смешанным газом" (VAPOR) с долями жидкого вещества внутри;
  // теперь доля — это элемент в своей фазе (см. data/composition.js), и
  // у каждого вещества свой газ, как пар у воды. В палитре — только во
  // "Всех". Газ масла выпадает не по температуре, а по сроку (life).
  [EL.REAGENT_GAS]: { id: EL.REAGENT_GAS, name: 'Газ реагента', cat: CAT.GAS, color: [212, 176, 92], density: 2, flammable: false, acidImmune: true },
  [EL.OIL_GAS]: { id: EL.OIL_GAS, name: 'Газ масла', cat: CAT.GAS, color: [150, 128, 70], density: 2, flammable: false, acidImmune: true },
  // Растворитель — синяя жидкость, которая меняется долями с чем угодно
  // (кроме стен, огня и живых); доля, ушедшая в твёрдое тело, с шансом
  // DISSOLVER_TO_REAGENT становится реагентом (см. Sim.dissolverMix).
  // Кипит при 50, замерзает при -20 (PHASE_LINKS в data/composition.js).
  // Его пар ведёт себя так же, а замёрзший растворитель безопасен — сам ни
  // с чем не смешивается, только тает.
  [EL.DISSOLVER]: { id: EL.DISSOLVER, name: 'Растворитель', cat: CAT.LIQUID, color: [58, 76, 214], density: 10, flammable: false, acidImmune: true, dispersion: 5 },
  [EL.DISSOLVER_GAS]: { id: EL.DISSOLVER_GAS, name: 'Пар растворителя', cat: CAT.GAS, color: [124, 138, 236], density: 2, flammable: false, acidImmune: true },
  [EL.DISSOLVER_ICE]: { id: EL.DISSOLVER_ICE, name: 'Замёрзший растворитель', cat: CAT.SOLID, color: [150, 162, 238], density: 40, flammable: false, acidImmune: true, maxStability: 3, toughness: 3, baseTemp: -30 },
};

// Плавление того, что сделано из камня или металла, — ровно по их
// правилам (точка, шанс в кадр, во что), копией, а не отдельными числами:
// поменяется плавление камня — поменяется и у них.
//  - Кислотный остаток — растворённый камень: плавится в расплавленный
//    камень (лаву), как камень.
//  - Окисел камня плавится так же, но вдобавок отдаёт газом реагент,
//    потраченный на окисление (см. Sim.meltStoneOxide).
//  - Ржавчина плавится как обычное железо и ничего не выделяет.
for (const id of [EL.ACID_RESIDUE, EL.OXIDE, EL.OXIDE_LOOSE]) {
  ELEMENTS[id].meltPoint = ELEMENTS[EL.STONE].meltPoint;
  ELEMENTS[id].meltChance = ELEMENTS[EL.STONE].meltChance;
  ELEMENTS[id].meltsInto = ELEMENTS[EL.STONE].meltsInto;
}
for (const id of [EL.METAL_OXIDE, EL.METAL_OXIDE_LOOSE]) {
  ELEMENTS[id].meltPoint = ELEMENTS[EL.METAL].meltPoint;
  ELEMENTS[id].meltChance = ELEMENTS[EL.METAL].meltChance;
  ELEMENTS[id].meltsInto = ELEMENTS[EL.METAL].meltsInto;
}
// Сталь плавится как металл, только на 50 градусов позже.
ELEMENTS[EL.STEEL].meltPoint = ELEMENTS[EL.METAL].meltPoint + 50;
ELEMENTS[EL.STEEL].meltChance = ELEMENTS[EL.METAL].meltChance;
ELEMENTS[EL.STEEL].meltsInto = ELEMENTS[EL.METAL].meltsInto;
// Свойства балки берутся от её материала (см. Sim.pickBeamMaterial), а эти
// — только для справки в палитре: по умолчанию балка каменная, поэтому
// здесь копия камня (устойчивость, стойкость — на сколько клеток её можно
// вывести в сторону от опоры, — плавление).
for (const key of ['density', 'maxStability', 'toughness', 'meltPoint', 'meltChance', 'meltsInto']) {
  ELEMENTS[EL.BEAM][key] = ELEMENTS[EL.STONE][key];
}

// Пока что в палитре временно оставлены только эти элементы — по просьбе
// пользователя. Остальные определения (ELEMENTS/EL) и вся связанная с ними
// логика (реакции и т.д.) не удалены, только убраны отсюда — чтобы вернуть
// элемент в палитру, достаточно снова добавить его в этот список.
const ELEMENT_ORDER = [
  EL.WATER, EL.STONE, EL.WOOD, EL.OIL, EL.ACID, EL.REAGENT, EL.DISSOLVER, EL.METAL, EL.STEEL, EL.WALL, EL.STEAM, EL.LAVA, EL.EARTH, EL.BEAM, EL.HUMAN,
  // Окислы и остальные газы — их место во вкладке "Все" (по своей
  // категории они разошлись бы по "Телам", "Сыпучему" и бывшей вкладке
  // газов, а увидеть их полезно все сразу).
  EL.OXIDE, EL.OXIDE_LOOSE, EL.METAL_OXIDE, EL.METAL_OXIDE_LOOSE, EL.EARTH_OXIDE, EL.ACID_GAS, EL.REAGENT_GAS, EL.OIL_GAS, EL.VAPOR, EL.SMOKE, EL.ACID_RESIDUE, EL.BLACK_SALT,
  EL.ICE, EL.ACID_ICE, EL.REAGENT_ICE, EL.DISSOLVER_GAS, EL.DISSOLVER_ICE,
];

// Элементы вкладки "Технологии" — по CAT они попали бы в другие вкладки
// (балка — обычное CAT.SOLID, как камень; колонист — CAT.POWDER, как
// земля), но их место среди технологий, не среди сырых материалов (см.
// materialCategoryKey в main.js).
const TECH_ELEMENTS = new Set([EL.BEAM, EL.HUMAN]);

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

// Предикаты ниже зовутся на каждую клетку по нескольку раз за кадр
// (computeAirBlock, computeDebrisWindChance, tryWindPush,
// windDir...), поэтому каждый из них — одно чтение плоской таблицы по id, а
// не цепочка сравнений с полями EL. Снаружи это те же функции isX(id):
// меняется только их устройство, состав каждого множества задан списком.
function idTable(ids) {
  const t = new Uint8Array(64);
  for (const id of ids) t[id] = 1;
  return t;
}

// "Твёрдые тела" в смысле структурной устойчивости: падают без опоры,
// но держатся друг за друга (можно строить навесы), в отличие от
// сыпучих порошков, которые и так уже падают по одной частице.
// OILFILM (застывшее масло) тоже входит — двигается/падает вместе со
// своим объектом, но в computeStability обрабатывается особо (см. sim/stability.js):
// получает устойчивость только от своей ЕДИНСТВЕННОЙ запомненной связи
// и никогда не передаёт её дальше — не может служить мостом между
// двумя разными объектами.
// Замёрзшие кислота и реагент — такие же твёрдые тела, как лёд (раньше их
// тут не было, и без опоры они висели в воздухе).
const IS_STRUCTURAL = idTable([EL.STONE, EL.WOOD, EL.METAL, EL.GLASS, EL.ICE, EL.ACID_ICE, EL.REAGENT_ICE, EL.DISSOLVER_ICE, EL.OILFILM, EL.WET_EARTH, EL.BEAM, EL.OXIDE, EL.METAL_OXIDE, EL.STEEL]);
function isStructural(id) { return IS_STRUCTURAL[id] === 1; }

// Окисел любой стадии и любого металла-основы (число стадии — в
// Sim.oxideStage, основа — в OXIDE_BASE ниже).
const IS_OXIDE = idTable([EL.OXIDE, EL.OXIDE_LOOSE, EL.METAL_OXIDE, EL.METAL_OXIDE_LOOSE, EL.EARTH_OXIDE]);
function isOxide(id) { return IS_OXIDE[id] === 1; }

// Твёрдая фаза жидкости (лёд и его сородичи) — её тает обратно tickPhase.
const IS_FROZEN_LIQUID = idTable([EL.ICE, EL.ACID_ICE, EL.REAGENT_ICE, EL.DISSOLVER_ICE]);
function isFrozenLiquid(id) { return IS_FROZEN_LIQUID[id] === 1; }
const IS_METAL_OXIDE = idTable([EL.METAL_OXIDE, EL.METAL_OXIDE_LOOSE]);
function isMetalOxide(id) { return IS_METAL_OXIDE[id] === 1; }

// Всегда неподвижные "якоря" — сами не падают и заземляют всё, что к ним прижато.
const IS_ANCHOR = idTable([EL.WALL, EL.VOID, EL.CLONE]);
function isAnchor(id) { return IS_ANCHOR[id] === 1; }

// Непроницаемые для потоков воздуха (см. Sim.computeAirBlock/updateWind) —
// настоящая преграда, через которую ветер не диффундирует, в отличие от
// прочих твёрдых тел (камень, дерево, стекло, лёд и т.д.), которые для
// потоков воздуха прозрачны. Пустота (VOID) намеренно НЕ входит сюда —
// роль непроницаемой стены отдана именно "Стене", а не "Пустоте".
const IS_AIRTIGHT = idTable([EL.WALL, EL.METAL, EL.STEEL]);
function isAirtight(id) { return IS_AIRTIGHT[id] === 1; }

// Блокирует передачу ТЕПЛА (см. HEAT_WEIGHT и Sim.updateTemp в sim/heat.js) — не то
// же самое, что isAirtight: металл перекрывает воздух, но металл — как
// раз то, что должно уметь ГРЕТЬСЯ и плавиться, а не быть неспособным
// принять хоть какое-то тепло только потому, что он же блокирует ветер.
// Реальный металл вообще-то ХОРОШО проводит тепло, несмотря на то, что
// сплошной и не пропускает сквозь себя воздух. Стена — другое дело, она
// именно как капитальная преграда и задумана.
const IS_HEAT_INSULATOR = idTable([EL.WALL]);
function isHeatInsulator(id) { return IS_HEAT_INSULATOR[id] === 1; }

// Быстрая таблица "клетка ведёт себя как газ" для горячего пути
// updateTemp: газ — это разреженное вещество, перемешанное с воздухом, и
// остывает он как воздух, а не как плотное тело (см. DECAY_AIR там).
// Индекс — id элемента, поэтому проверка стоит одно чтение массива.
const IS_GASLIKE = new Uint8Array(64);
for (let id = 0; id < 64; id++) IS_GASLIKE[id] = (ELEMENTS[id] && ELEMENTS[id].cat === CAT.GAS) ? 1 : 0;
// То же для жидкости — для прохода по всем клеткам в computeLiquidEscape.
const IS_LIQUID = new Uint8Array(64);
for (let id = 0; id < 64; id++) IS_LIQUID[id] = (ELEMENTS[id] && ELEMENTS[id].cat === CAT.LIQUID) ? 1 : 0;
// Для проб соседа при движении (attemptSwapOrMove, attemptBuoyantRise —
// по нескольку на каждую частицу в каждом кадре): можно ли вообще сдвинуть
// клетку этого типа (isMovable по категории, 0 и для несуществующего id)
// и её плотность — без чтения объекта ELEMENTS[id].
const IS_MOVABLE_ID = new Uint8Array(64);
const DENSITY = new Float64Array(64);
for (let id = 0; id < 64; id++) {
  const el = ELEMENTS[id];
  IS_MOVABLE_ID[id] = (el && isMovable(el.cat)) ? 1 : 0;
  DENSITY[id] = el ? el.density : 0;
}
