'use strict';

// Проверка сохранения вещества (data/chem.js, sim/chem.js).
//
//   node tools/chem-check.js [кадров]
//
// 1. Сумма: на каждом кадре клетки + воздух - внешний обмен (клонер,
//    пустота, добыча) - правки игрока равны тому, что было в начале, по
//    каждому простому веществу до единицы. Падает — значит, учёт что-то
//    пропустил (запись в клетку мимо markDirty, побочное поле, которого нет
//    в chemCellAdd).
// 2. Строгие простые вещества (кремний, железо, медь, натрий, хлор) не
//    ходят через воздух: chemLeak на всех кадрах — нули. Падает — какая-то
//    реакция стёрла или создала камень, металл, соль. Тогда печатаются
//    места: каждый вызов spawn/clearCell/setComp/... внутри одного
//    updateCell (или одной фазы кадра) меряется по строгому, и если за
//    единицу работы сумма не сошлась, виноватые вызовы попадают в таблицу
//    "метод: строка" — так видно, какая именно реакция теряет вещество.
// 3. Воздух не уходит в минус (решения "хватит ли воздуха" — chemAirHas).
// 4. Сборка соединений (chemBuild, chemTake) сходится с разбором.
//
// Сцены: типовая (tools/harness.js) и химическая — кислота на камне,
// металле, песке и балке, соль в воде, реагент с водой, взрыв чёрных солей
// у камня и металла, клонер и пустота, ржавление.

const { loadSim, buildScene, poke, simScripts, readRepoFile } = require('./harness');

const FRAMES = parseInt(process.argv[2], 10) || 400;
const env = loadSim({ seed: 7 });
const EL = env.get('EL');
const CHEM_N = env.get('CHEM_N');
const CHEM_ATOMS = env.get('CHEM_ATOMS');
const CHEM_STRICT = env.get('CHEM_STRICT');
const CHEM_EXT_N = env.get('CHEM_EXT_N');
const Sim = env.get('Sim');

let failed = false;
function fail(msg) { console.log('  ОШИБКА: ' + msg); failed = true; }
const sym = (a) => CHEM_ATOMS[a].sym;
const vecText = (v) => [...v].map((n, a) => (n ? `${sym(a)}${n > 0 ? '+' : ''}${n}` : '')).filter(Boolean).join(' ') || '0';

// ---- строки склеенного текста -> файл:строка (как склеивает harness.loadSim) ----
const lineMap = [];
{
  let line = 3;   // "function anonymous(__random\n) {\n" + две строки шапки тела
  line += 2;
  for (const file of simScripts(null)) {
    const n = readRepoFile(file, null).split('\n').length;
    lineMap.push([line + 1, file]);   // строка "// ==== file ===="
    line += n + 1;
  }
}
function where(stackLine) {
  const m = /<anonymous>:(\d+):\d+/.exec(stackLine);
  const fn = (/at (?:Sim\.)?([\w$]+)/.exec(stackLine) || [])[1] || '?';
  if (!m) return fn;
  const L = +m[1];
  let file = '?', start = 0;
  for (const [s, f] of lineMap) { if (s <= L) { file = f; start = s; } else break; }
  return `${fn} (${file}:${L - start})`;
}

// ---- прицельный учёт строгого по вызовам ----
const PRIMS = ['spawn', 'clearCell', 'setComp', 'removeBeam', 'setOxideStage', 'placeBeam', 'dropBeam'];
const UNITS = ['updateCell', 'updateBodies', 'updateSharoids', 'updateSegments', 'updateRopes', 'updateGrips', 'updateBeams',
  'updateLanding', 'rideBeams', 'updateRopeLive', 'updateCharges', 'updateRespawnMarks', 'updateObjects', 'processDeferred', 'computeStability'];
const sites = new Map();   // место -> {n, v: Float64Array}
let depth = 0, unitDepth = 0, inStep = false;
let unitCalls = [];   // [место, Δ]
const tmpA = new Float64Array(CHEM_N), tmpB = new Float64Array(CHEM_N);
function strictOf(sim, i, out) {
  out.fill(0);
  sim.chemCellAdd(i, out, 1);
  for (let a = 0; a < CHEM_N; a++) if (!CHEM_STRICT[a]) out[a] = 0;
}
function flushUnit() {
  if (!unitCalls.length) return;
  const sum = new Float64Array(CHEM_N);
  for (const [, d] of unitCalls) for (let a = 0; a < CHEM_N; a++) sum[a] += d[a];
  if (sum.some((x) => x !== 0)) {
    for (const [site, d] of unitCalls) {
      if (!d.some((x) => x !== 0)) continue;
      const s = sites.get(site) || { n: 0, v: new Float64Array(CHEM_N) };
      s.n++;
      for (let a = 0; a < CHEM_N; a++) s.v[a] += d[a];
      sites.set(site, s);
    }
  }
  unitCalls = [];
}
const proto = Sim.prototype;
for (const name of PRIMS) {
  const orig = proto[name];
  proto[name] = function (i, ...rest) {
    if (!inStep || depth > 0) return orig.call(this, i, ...rest);
    depth++;
    strictOf(this, i, tmpA);
    const before = tmpA.slice();
    let r;
    try { r = orig.call(this, i, ...rest); } finally { depth--; }
    strictOf(this, i, tmpB);
    const d = new Float64Array(CHEM_N);
    let any = false;
    for (let a = 0; a < CHEM_N; a++) { d[a] = tmpB[a] - before[a]; if (d[a]) any = true; }
    if (any) {
      const st = new Error().stack.split('\n').slice(2);
      const frame = st.find((l) => !/Sim\.(spawn|clearCell|setComp|setComposition|removeBeam|setOxideStage|retypeComp|placeGas|placeBeam|dropBeam) /.test(l) && !/proto\./.test(l)) || st[0];
      unitCalls.push([name + ' <- ' + where(frame), d]);
      if (unitDepth === 0) flushUnit();
    }
    return r;
  };
}
// Внешний обмен (клонер, пустота, добыча) — не утечка: его доля вычитается.
{
  const orig = proto.chemExternal;
  proto.chemExternal = function (cat, i, sign) {
    if (inStep && depth === 0) {
      strictOf(this, i, tmpA);
      const d = new Float64Array(CHEM_N);
      for (let a = 0; a < CHEM_N; a++) d[a] = -tmpA[a] * sign;
      if (d.some((x) => x !== 0)) unitCalls.push(['внешний обмен', d]);
    }
    return orig.call(this, cat, i, sign);
  };
}
for (const name of UNITS) {
  const orig = proto[name];
  if (!orig) continue;
  proto[name] = function (...args) {
    if (!inStep) return orig.apply(this, args);
    unitDepth++;
    try { return orig.apply(this, args); } finally { unitDepth--; if (unitDepth === 0) flushUnit(); }
  };
}
const origStep = proto.step;
proto.step = function () { inStep = true; try { origStep.call(this); } finally { inStep = false; flushUnit(); } };

// ---- прогон ----
function total(sim) {
  const t = sim.chemCellsTotal();
  for (let a = 0; a < CHEM_N; a++) {
    t[a] += sim.chemAir[a] - sim.chemUser[a];
    for (let c = 0; c < CHEM_EXT_N; c++) t[a] -= sim.chemExt[c * CHEM_N + a];
  }
  return t;
}

function run(name, sim, pokeFn) {
  console.log(name);
  sites.clear();
  sim.step();   // первый кадр заводит кэш кусков
  const t0 = total(sim);
  let worstAir = Infinity, worstAirAtom = -1, badFrames = 0;
  for (let f = 0; f < FRAMES; f++) {
    if (pokeFn) pokeFn(sim, f);
    sim.step();
    const t = total(sim);
    const diff = new Float64Array(CHEM_N);
    let off = false;
    for (let a = 0; a < CHEM_N; a++) { diff[a] = t[a] - t0[a]; if (diff[a]) off = true; }
    if (off && badFrames++ < 3) fail(`кадр ${f}: сумма разошлась на ${vecText(diff)}`);
    for (let a = 0; a < CHEM_N; a++) if (sim.chemAir[a] < worstAir) { worstAir = sim.chemAir[a]; worstAirAtom = a; }
  }
  if (sim.chemLeak.some((x) => x !== 0)) fail(`строгое через воздух: ${vecText(sim.chemLeak)}`);
  if (worstAir < 0) fail(`воздух ушёл в минус: ${sym(worstAirAtom)} ${worstAir}`);
  const ext = new Float64Array(CHEM_N), air0 = new Float64Array(CHEM_N);
  for (let c = 0; c < CHEM_EXT_N; c++) for (let a = 0; a < CHEM_N; a++) ext[a] += sim.chemExt[c * CHEM_N + a];
  console.log(`  кадров ${FRAMES}; внешний обмен ${vecText(ext)}; правки ${vecText(sim.chemUser)}`);
  console.log(`  воздух: ${[...sim.chemAir].map((n, a) => sym(a) + ' ' + n).join(', ')}`);
  if (sites.size) {
    console.log('  места, где за единицу работы не сошлось строгое (вызов <- кто звал: сумма, раз):');
    const list = [...sites].sort((x, y) => y[1].n - x[1].n).slice(0, 25);
    for (const [site, s] of list) console.log(`    ${site}: ${vecText(s.v)} (${s.n})`);
  }
}

// Типовая сцена.
{
  const sim = buildScene(env);
  run('Типовая сцена', sim, (s, f) => poke(env, s, f));
}

// Химическая сцена.
function chemScene() {
  const w = 200, h = 120;
  const sim = new Sim(w, h);
  const box = (x0, y0, x1, y1, id) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) sim.setCell(x, y, id, false); };
  box(0, h - 4, w - 1, h - 1, EL.WALL);
  // Кислота на камне, металле, песке, дереве, меди.
  box(2, h - 20, 40, h - 5, EL.STONE);
  box(6, h - 26, 36, h - 21, EL.ACID);
  box(44, h - 20, 70, h - 5, EL.METAL);
  box(46, h - 26, 68, h - 21, EL.ACID);
  box(74, h - 12, 90, h - 5, EL.SAND);
  box(76, h - 16, 88, h - 13, EL.ACID);
  box(94, h - 12, 104, h - 5, EL.COPPER);
  box(95, h - 16, 103, h - 13, EL.ACID);
  // Соль в воде, реагент с водой, растворитель на камне.
  box(108, h - 20, 140, h - 5, EL.WATER);
  box(110, h - 30, 118, h - 21, EL.SALT);
  box(124, h - 30, 132, h - 21, EL.REAGENT);
  box(144, h - 10, 150, h - 5, EL.STONE);
  box(144, h - 14, 150, h - 11, EL.DISSOLVER);
  // Сухие чёрные соли у камня и металла — подрыв огнём.
  box(156, h - 24, 196, h - 5, EL.STONE);
  box(170, h - 30, 182, h - 25, EL.METAL);
  box(172, h - 34, 180, h - 31, EL.BLACK_SALT);
  // Балка над кислотой, ржавление под водой, клонер с водой, пустота у песка.
  sim.pickBeamMaterial(2, h - 10);
  for (let x = 8; x <= 34; x++) sim.setCell(x, h - 28, EL.BEAM, false);
  box(20, h - 60, 30, h - 56, EL.METAL);
  box(20, h - 64, 30, h - 61, EL.WATER);
  box(19, h - 64, 19, h - 56, EL.WALL);
  box(31, h - 64, 31, h - 56, EL.WALL);
  sim.setCell(60, 10, EL.CLONE, false);
  sim.setCell(60, 11, EL.WATER, false);
  box(120, h - 60, 130, h - 55, EL.SAND);
  box(124, h - 54, 126, h - 54, EL.VOID);
  // Окисел у лавы, кислотный остаток, лава с водой.
  box(60, h - 50, 70, h - 46, EL.LAVA);
  box(58, h - 50, 59, h - 46, EL.OXIDE);
  return sim;
}
{
  const sim = chemScene();
  run('Химическая сцена', sim, (s, f) => {
    if (f === 30) s.stampBrush(176, s.h - 36, 'circle', 2, 2, EL.FIRE, false);
    if (f === 60) s.stampBrush(64, s.h - 52, 'circle', 2, 2, EL.WATER, false);
  });
}

// Сборка соединений: разобрать клетку, забрать углерод, собрать обратно.
{
  console.log('Сборка соединений');
  const sim = new Sim(16, 16);
  sim.setCell(4, 4, EL.WOOD, false);
  const i = sim.idx(4, 4);
  const before = sim.chemCellAtoms(i);
  const got = sim.chemTake(i, env.get('CHEM').C, 4);
  const after = sim.chemCellAtoms(i);
  if (got !== 4) fail(`chemTake забрал ${got} углерода вместо 4`);
  const C = env.get('CHEM').C, H = env.get('CHEM').H;
  if (after[C] > before[C] - 4) fail(`после chemTake углерода ${after[C]}, ожидалось не больше ${before[C] - 4}`);
  if (after[H] > before[H]) fail('chemTake добавил водорода');
  console.log(`  дерево ${vecText(before)} -> забрано C ${got} -> клетка ${vecText(after)} (${sim.type[i] === EL.EMPTY ? 'пусто' : env.get('ELEMENTS')[sim.type[i]].name})`);
  // Строгое не выбрасывается: из металла железо целиком не забрать, если
  // остатку некуда сложиться, — но забрать всё можно.
  sim.setCell(6, 6, EL.METAL, false);
  const j = sim.idx(6, 6);
  const fe = sim.chemTake(j, env.get('CHEM').FE, 3);
  const left = sim.chemCellAtoms(j)[env.get('CHEM').FE];
  if (fe + left !== 10) fail(`железо не сошлось: забрано ${fe}, осталось ${left}`);
}

console.log(failed ? '\nЕСТЬ ОШИБКИ' : '\nOK: вещество сохраняется');
process.exit(failed ? 1 : 0);
