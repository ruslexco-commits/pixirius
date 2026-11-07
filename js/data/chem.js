'use strict';

// Химия: из каких ПРОСТЫХ веществ сложено каждое вещество игры. Только
// данные и чистые функции — учёт вещества на карте и обмен с воздухом
// живут в sim/chem.js.
//
// Просьба пользователя: "нужно, чтобы каждое вещество состояло из веществ
// попроще, и они взаимодействовали... чтобы что бы ни происходило на карте,
// оставалось одинаковое количество химических веществ" — будущие живые
// клетки будут есть всё вокруг, и без сохранения вещества они за какое-то
// время съели бы всю воду и исчезли сами.
//
// Устройство (упрощённая настоящая химия):
//  - простых веществ немного (CHEM_ATOMS: водород, кислород, углерод, азот,
//    сера, кремний, железо, медь, натрий, хлор);
//  - вещество игры (элемент EL) — это "соединение": у каждой его ДОЛИ
//    (см. состав клетки, data/composition.js) есть формула — сколько каких
//    простых веществ в ней (CHEM_FORMULA). Вода — H2O на долю, камень —
//    SiO2, металл — Fe. Свойства вещества при этом берутся по-прежнему из
//    таблицы элементов: формула не пересчитывает физику каждый кадр, она
//    говорит, ИЗ ЧЕГО вещество и во что оно может разобраться (просьба:
//    "чтоб не симулировать свойства каждого атома, а просто выстроить их и
//    собрать информацию о свойствах и соединении");
//  - клетка — это её доли, значит, и её простые вещества: сумма формул долей
//    плюс то, что лежит в побочных полях (влага земли, грязь на пикселе,
//    балка, кислород окисла по стадии — см. Sim.chemCellAdd);
//  - всё, что на карте исчезает или появляется "из ничего" (огонь догорел,
//    дым рассеялся, металл заржавел, взяв кислород), уходит в ВОЗДУХ или
//    берётся из него: невидимый запас простых веществ на всё поле
//    (Sim.chemAir). Вещество на карте + в воздухе — величина постоянная.
//
// Строгие простые вещества (CHEM_STRICT: кремний, железо, медь, натрий,
// хлор) в воздух не уходят: камень не испаряется, железо не улетучивается.
// Реакции обязаны сохранять их в клетках сами (кислота превращает камень в
// кислотный остаток на месте, ржавое железо остаётся ржавчиной, взрыв
// раскидывает обломки, а не стирает их). Летучие (водород, кислород, углерод,
// азот, сера) — обмениваются с воздухом свободно: так горение берёт
// кислород, а дым возвращает углерод. tools/chem-check.js проверяет и то и
// другое: сумма сходится до единицы, строгие в воздух не утекают.

// Простые вещества. mass — относительная масса (для справки лупы: масса доли
// — сумма масс), volatile — может ли уходить в воздух.
const CHEM = { H: 0, O: 1, C: 2, N: 3, S: 4, SI: 5, FE: 6, CU: 7, NA: 8, CL: 9 };
const CHEM_N = 10;
const CHEM_ATOMS = [
  { sym: 'H', name: 'Водород', mass: 1, volatile: true, color: [230, 236, 255] },
  { sym: 'O', name: 'Кислород', mass: 16, volatile: true, color: [150, 210, 255] },
  { sym: 'C', name: 'Углерод', mass: 12, volatile: true, color: [150, 150, 140] },
  { sym: 'N', name: 'Азот', mass: 14, volatile: true, color: [170, 160, 230] },
  { sym: 'S', name: 'Сера', mass: 32, volatile: true, color: [236, 220, 60] },
  { sym: 'Si', name: 'Кремний', mass: 28, volatile: false, color: [200, 186, 150] },
  { sym: 'Fe', name: 'Железо', mass: 56, volatile: false, color: [170, 120, 100] },
  { sym: 'Cu', name: 'Медь', mass: 64, volatile: false, color: [200, 120, 60] },
  { sym: 'Na', name: 'Натрий', mass: 23, volatile: false, color: [230, 230, 200] },
  { sym: 'Cl', name: 'Хлор', mass: 35, volatile: false, color: [190, 240, 120] },
];
const CHEM_STRICT = new Uint8Array(CHEM_N);
for (let a = 0; a < CHEM_N; a++) CHEM_STRICT[a] = CHEM_ATOMS[a].volatile ? 0 : 1;

// Формула "H2SO4" -> вектор простых веществ. Символы — из CHEM_ATOMS
// (двухбуквенные — заглавная и строчная, как в химии).
function chemParse(str) {
  const v = new Int16Array(CHEM_N);
  const re = /([A-Z][a-z]?)(\d*)/g;
  let m, used = 0;
  while ((m = re.exec(str)) !== null) {
    if (!m[1]) break;
    const a = CHEM_ATOMS.findIndex((t) => t.sym === m[1]);
    if (a < 0) throw new Error('chem: неизвестное простое вещество ' + m[1] + ' в ' + str);
    v[a] += m[2] ? parseInt(m[2], 10) : 1;
    used += m[0].length;
  }
  if (used !== str.length) throw new Error('chem: не разобрать формулу ' + str);
  return v;
}

// Формула на ОДНУ долю (у полной клетки их SOL_PARTS = 10). Агрегатное
// состояние формулу не меняет: вода, пар и лёд — одно и то же H2O, поэтому
// кипение и замерзание вещество сохраняют сами собой (проверяется ниже).
// Смеси (раствор, смешанный газ, сплав) и шароид долями не бывают — у них
// формулы нет, их клетки состоят из долей других веществ.
const CHEM_FORMULA_SRC = {
  [EL.WATER]: 'H2O', [EL.STEAM]: 'H2O', [EL.ICE]: 'H2O',
  // Кремнезём: песок, камень, стекло и лава — одно вещество в разном виде
  // (как кварцевый песок и кварцевое стекло). Стена — тоже камень, её просто
  // ничто не берёт.
  [EL.SAND]: 'SiO2', [EL.STONE]: 'SiO2', [EL.GLASS]: 'SiO2', [EL.LAVA]: 'SiO2', [EL.BEAM]: 'SiO2', [EL.WALL]: 'SiO2',
  // Лампочка — стеклянная колба (плавится, как стекло).
  [EL.LAMP]: 'SiO2',
  // Органика: дерево — углевод, масло — углеводород.
  [EL.WOOD]: 'CH2O', [EL.OIL]: 'CH2', [EL.OIL_GAS]: 'CH2', [EL.OILFILM]: 'CH2', [EL.INSULATOR]: 'CH2',
  // Огонь — горящий газ (угарный), дым — углекислый газ с сажей, зола —
  // уголь. Огонь от масла берёт кислород из воздуха, догорая — отдаёт всё в
  // воздух.
  [EL.FIRE]: 'CO', [EL.SMOKE]: 'CO2', [EL.ASH]: 'C',
  // Порох: уголь, сера и селитра (без калия — его в игре нет).
  [EL.GUNP]: 'CSNO3',
  // Кислота серная, реагент — серный ангидрид: окислитель, с водой гасится
  // с жаром. Оба летучие (через воздух ходят сера и кислород).
  [EL.ACID]: 'H2SO4', [EL.ACID_GAS]: 'H2SO4', [EL.ACID_ICE]: 'H2SO4',
  [EL.REAGENT]: 'SO3', [EL.REAGENT_GAS]: 'SO3', [EL.REAGENT_ICE]: 'SO3',
  // Кислотный остаток — растворённый кислотой камень: тот же кремнезём,
  // только рыхлый. Серы в нём нет: иначе каждая разъеденная клетка камня
  // забирала бы из воздуха десять серы, и воздух быстро бы её лишился.
  [EL.ACID_RESIDUE]: 'SiO2',
  // Окислы: основа плюс кислород. Кислород растёт и со стадией (CHEM_STAGE_O).
  [EL.OXIDE]: 'SiO3', [EL.OXIDE_LOOSE]: 'SiO3',
  [EL.METAL]: 'Fe', [EL.MOLTEN_METAL]: 'Fe', [EL.STEEL]: 'FeC', [EL.MOLTEN_STEEL]: 'FeC',
  [EL.METAL_OXIDE]: 'FeO', [EL.METAL_OXIDE_LOOSE]: 'FeO',
  [EL.COPPER]: 'Cu', [EL.MOLTEN_COPPER]: 'Cu', [EL.COPPER_OXIDE]: 'CuO', [EL.COPPER_OXIDE_LOOSE]: 'CuO',
  // Приборы — металл своей основы (DEVICE_BASE): прибор под растворителем
  // становится простым металлом и ничего не теряет.
  [EL.CAMERA]: 'Fe', [EL.MONITOR]: 'Fe', [EL.SOLAR]: 'Fe', [EL.GENERATOR]: 'Fe', [EL.AMPLIFIER]: 'Cu',
  // Соль поваренная (белая) и "чёрные соли" — селитра: взрывается сухой,
  // растворяется в воде, получается из воды, ржавящей железо.
  [EL.SALT]: 'NaCl', [EL.BLACK_SALT]: 'N2H4O3',
  // Земля — перегной, грязь — ил: органика без кремния (растворяется в воде,
  // кислота её съедает целиком, как и раньше).
  [EL.EARTH]: 'CH2ON', [EL.WET_EARTH]: 'CH2ON', [EL.EARTH_OXIDE]: 'CH2O2N', [EL.MUD]: 'CH4O2',
  // Растворитель — спирт.
  [EL.DISSOLVER]: 'C2H6O', [EL.DISSOLVER_GAS]: 'C2H6O', [EL.DISSOLVER_ICE]: 'C2H6O',
  // Живое и кровь.
  [EL.HUMAN]: 'C2H5ON', [EL.PROTAGONIST]: 'C2H5ON', [EL.COLONIST]: 'C2H5ON', [EL.BLOOD]: 'CH4O2N',
};
const CHEM_FORMULA = new Int16Array(EL_LIMIT * CHEM_N);
for (const key of Object.keys(CHEM_FORMULA_SRC)) {
  const id = +key, v = chemParse(CHEM_FORMULA_SRC[key]);
  for (let a = 0; a < CHEM_N; a++) CHEM_FORMULA[id * CHEM_N + a] = v[a];
}
// Есть ли в доле что-то строгое (не уходящее в воздух).
const CHEM_HAS_STRICT = new Uint8Array(EL_LIMIT);
for (let id = 0; id < EL_LIMIT; id++) {
  for (let a = 0; a < CHEM_N; a++) if (CHEM_STRICT[a] && CHEM_FORMULA[id * CHEM_N + a]) CHEM_HAS_STRICT[id] = 1;
}

// Кислород окисла по стадии: у клетки окисла со стадией s (extra) — ещё
// s * CHEM_STAGE_O[тип] кислорода сверх формулы долей. Так стадия — это и
// есть "сколько кислорода набрало вещество", а переползание окисла от
// клетки к клетке (стадия здесь -1, там +1) кислород сохраняет само.
const CHEM_STAGE_O = new Uint8Array(EL_LIMIT);
for (const id of [EL.OXIDE, EL.OXIDE_LOOSE, EL.METAL_OXIDE, EL.METAL_OXIDE_LOOSE, EL.COPPER_OXIDE, EL.COPPER_OXIDE_LOOSE, EL.EARTH_OXIDE]) CHEM_STAGE_O[id] = 1;

// Во что превращается кислотой доля вещества (Sim.dissolveInto): кремнезём и
// всё каменное — в кислотный остаток на месте, железо и медь — в рыхлую
// ржавчину (она осыпается из клетки — в металле остаётся дыра, как раньше).
// 0 — доля съедается целиком (летучее уходит в воздух). Строгая доля без
// своей строки кислоте не поддаётся.
const CHEM_CORRODE_TO = new Uint8Array(EL_LIMIT);
for (const id of [EL.STONE, EL.SAND, EL.LAVA, EL.BEAM, EL.OXIDE, EL.OXIDE_LOOSE]) CHEM_CORRODE_TO[id] = EL.ACID_RESIDUE;
for (const id of [EL.METAL, EL.STEEL, EL.METAL_OXIDE, EL.METAL_OXIDE_LOOSE, EL.CAMERA, EL.MONITOR, EL.SOLAR, EL.GENERATOR, EL.MOLTEN_METAL, EL.MOLTEN_STEEL]) CHEM_CORRODE_TO[id] = EL.METAL_OXIDE_LOOSE;
for (const id of [EL.COPPER, EL.COPPER_OXIDE, EL.COPPER_OXIDE_LOOSE, EL.AMPLIFIER, EL.MOLTEN_COPPER]) CHEM_CORRODE_TO[id] = EL.COPPER_OXIDE_LOOSE;

// Во что дробится доля взрывом (Sim.blastBreak): камень — в песок, металл —
// в рыхлую ржавчину (окалину). 0 — доля дробится без замены (летучее — в
// воздух; строгое без строки взрыв не берёт).
const CHEM_RUBBLE_TO = new Uint8Array(EL_LIMIT);
for (const id of [EL.STONE, EL.GLASS, EL.BEAM, EL.LAMP]) CHEM_RUBBLE_TO[id] = EL.SAND;
CHEM_RUBBLE_TO[EL.OXIDE] = EL.OXIDE_LOOSE;
for (const id of [EL.METAL, EL.STEEL, EL.METAL_OXIDE, EL.CAMERA, EL.MONITOR, EL.SOLAR, EL.GENERATOR]) CHEM_RUBBLE_TO[id] = EL.METAL_OXIDE_LOOSE;
for (const id of [EL.COPPER, EL.COPPER_OXIDE, EL.AMPLIFIER]) CHEM_RUBBLE_TO[id] = EL.COPPER_OXIDE_LOOSE;
// Сыпучее и рыхлое и так уже обломки — остаются собой; расплавы
// выплёскиваются из воронки как есть.
for (const id of [EL.SAND, EL.OXIDE_LOOSE, EL.METAL_OXIDE_LOOSE, EL.COPPER_OXIDE_LOOSE, EL.SALT, EL.ACID_RESIDUE,
  EL.LAVA, EL.MOLTEN_METAL, EL.MOLTEN_STEEL, EL.MOLTEN_COPPER]) CHEM_RUBBLE_TO[id] = id;

// Воздух в начале (новое поле, старое сохранение без воздуха): столько
// каждого простого вещества на клетку поля. Азота и кислорода много —
// горение и ржавчина на обычной карте их не исчерпают, но в запертой
// коробке огонь сожжёт свой кислород... только если коробка — всё поле:
// воздух общий на карту, перемешанный мгновенно (так проще и не зависит от
// потоков). Влаги, углекислоты и сернистого газа — на развод: из воздуха
// берутся газы, выделяющиеся "из ничего" (газ при растворении, дым над
// огнём), и пока их нет, такие газы не выделяются (Sim.chemAirHas).
// Строгих в воздухе нет.
const CHEM_AIR_PER_CELL = [0.5, 2, 0.2, 8, 0.2, 0, 0, 0, 0, 0];
// Запас, ниже которого воздух вещество не отдаёт, — доля от начального
// воздуха поля: решение "хватит ли" принимается по воздуху на начало кадра,
// а за кадр его могут взять сотни клеток сразу (кислота на большой плите
// выделяет газ у каждой разъеденной клетки) — запас не даёт уйти в минус.
// Долей, а не числом: на маленьком поле (проверки) воздуха мало, и
// запас в полторы тысячи серы не давал бы газам выделяться вовсе.
const CHEM_AIR_RESERVE = 0.1;
const CHEM_AIR_RESERVE_MIN = 20;

// Разбор состава клетки на простые вещества: out[a] += n * формула (sign —
// +1 или -1). Пустота веществом не является.
function chemAddComp(comp, out, sign) {
  for (let s = 0; s < SOL_SLOTS; s++) {
    const slot = solSlot(comp, s);
    if (!slot) break;
    const id = slotId(slot), n = slotCount(slot) * sign, f = id * CHEM_N;
    for (let a = 0; a < CHEM_N; a++) out[a] += n * CHEM_FORMULA[f + a];
  }
}

// Формула доли текстом: "H₂O". Пустая формула — "—".
const CHEM_SUB = '₀₁₂₃₄₅₆₇₈₉';
function chemFormulaText(id) {
  let s = '';
  for (const a of [CHEM.C, CHEM.H, CHEM.N, CHEM.NA, CHEM.SI, CHEM.FE, CHEM.CU, CHEM.S, CHEM.CL, CHEM.O]) {
    const n = CHEM_FORMULA[id * CHEM_N + a];
    if (!n) continue;
    s += CHEM_ATOMS[a].sym + (n > 1 ? String(n).replace(/\d/g, (d) => CHEM_SUB[+d]) : '');
  }
  return s || '—';
}

// Масса доли (сумма масс простых веществ) — справка лупы.
function chemPartMass(id) {
  let m = 0;
  for (let a = 0; a < CHEM_N; a++) m += CHEM_FORMULA[id * CHEM_N + a] * CHEM_ATOMS[a].mass;
  return m;
}

// ---- сборка соединений из простых веществ ----
//
// Обратная сторона разбора: есть горсть простых веществ — какие вещества игры
// из неё складываются. Нужна, чтобы вещества можно было изымать из клеток и
// добавлять, получая новые соединения (Sim.chemTake / Sim.chemRebuild — для
// будущих живых клеток: съела дерево, забрала углерод, остальное сложилось в
// воду). Порядок — от сложного к простому: сперва забирается то, что
// связывает больше редких простых веществ, остаток — в воду и газы. Агрегат
// выбирается по температуре (CHEM_PHASE_FOR), чтобы собранная при 300
// градусах вода сразу была паром.
const CHEM_BUILD_ORDER = [
  EL.SALT, EL.ACID_RESIDUE, EL.STONE, EL.STEEL, EL.METAL_OXIDE, EL.METAL, EL.COPPER_OXIDE, EL.COPPER,
  EL.ACID, EL.REAGENT, EL.GUNP, EL.BLACK_SALT, EL.BLOOD, EL.WOOD, EL.OIL, EL.WATER, EL.SMOKE, EL.ASH,
];

// Порядок сборки для того, что живое отдаёт обратно в мир (Sim.chemRelease):
// безопасные вещества — соль, камень, металлы, вода, зола. Кислота, реагент,
// порох и кровь из выделений собираться не должны, хоть из тех же атомов они
// и сложились бы.
const CHEM_RELEASE_ORDER = [EL.SALT, EL.STONE, EL.METAL, EL.COPPER, EL.WATER, EL.ASH];

// Собрать из простых веществ atoms (изменяется: в нём остаётся то, что не
// сложилось) не больше maxParts долей. Возвращает состав (comp). Доля
// берётся, только если на неё хватает всего. order — какие соединения и в
// каком порядке собирать (по умолчанию CHEM_BUILD_ORDER).
function chemBuild(atoms, maxParts, temp, order) {
  let comp = 0, parts = 0, kinds = 0;
  for (const base of (order || CHEM_BUILD_ORDER)) {
    if (parts >= maxParts) break;
    const f = base * CHEM_N;
    let n = maxParts - parts;
    for (let a = 0; a < CHEM_N; a++) {
      const need = CHEM_FORMULA[f + a];
      if (need > 0) n = Math.min(n, Math.floor(atoms[a] / need));
    }
    if (n <= 0) continue;
    if (kinds >= SOL_SLOTS) break;
    const id = chemPhaseFor(base, temp);
    for (let a = 0; a < CHEM_N; a++) atoms[a] -= n * CHEM_FORMULA[f + a];
    comp = solWith(comp, id, n);
    parts += n;
    kinds++;
  }
  return comp;
}

// Агрегат вещества base при температуре temp: вода -> пар/лёд, камень ->
// лава и так далее (по PHASE_LINKS и точкам плавления).
function chemPhaseFor(base, temp) {
  if (temp === undefined) return base;
  if (BOIL_TO[base] && temp >= BOIL_POINT[base]) return BOIL_TO[base];
  if (FREEZE_TO[base] && temp <= FREEZE_POINT[base]) return FREEZE_TO[base];
  const el = ELEMENTS[base];
  if (el && el.meltPoint !== undefined && temp >= el.meltPoint && el.meltsInto) return el.meltsInto;
  return base;
}

// Самопроверка таблиц при загрузке: всё, что превращается доля в долю
// (кипение, плавление, ржавчина, приборы), не должно терять строгое
// вещество — иначе учёт поймал бы утечку в первый же кадр.
(function chemSelfCheck() {
  const same = (a, b, strictOnly) => {
    for (let k = 0; k < CHEM_N; k++) {
      if (strictOnly && !CHEM_STRICT[k]) continue;
      if (CHEM_FORMULA[a * CHEM_N + k] !== CHEM_FORMULA[b * CHEM_N + k]) return false;
    }
    return true;
  };
  for (const [liquid, gas, solid] of PHASE_LINKS) {
    if (!same(liquid, gas, false) || (solid && !same(liquid, solid, false))) throw new Error('chem: фазы ' + liquid + ' различаются формулой');
  }
  // Id от 64 долями не бывают (шароид, бур — их клетки стальные).
  for (let id = 1; id < 64; id++) {
    const el = ELEMENTS[id];
    if (el && el.meltsInto && !same(id, el.meltsInto, true)) throw new Error('chem: плавление ' + id + ' теряет строгое');
    if (DEVICE_BASE[id] && !same(id, DEVICE_BASE[id], false)) throw new Error('chem: прибор ' + id + ' не равен основе');
    for (const map of [CHEM_CORRODE_TO, CHEM_RUBBLE_TO]) {
      if (map[id] && !same(id, map[id], true)) throw new Error('chem: превращение ' + id + ' -> ' + map[id] + ' теряет строгое');
    }
  }
})();
