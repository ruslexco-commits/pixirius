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

function run(name, sim, pokeFn, frames = FRAMES) {
  console.log(name);
  sites.clear();
  sim.step();   // первый кадр заводит кэш кусков
  const t0 = total(sim);
  let worstAir = Infinity, worstAirAtom = -1, badFrames = 0;
  for (let f = 0; f < frames; f++) {
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
  console.log(`  кадров ${frames}; внешний обмен ${vecText(ext)}; правки ${vecText(sim.chemUser)}`);
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

// Колония живых клеток (EL.CELL, sim/life.js): растёт на воде, дереве и земле,
// делится, голодает и умирает деревом. Вещество сохраняется на каждом кадре
// (run проверяет сумму и утечку строгого), строгое никуда не девается, колония
// действительно растёт (иначе проверка ничего не доказывает) и не съедает всё
// вещество: углерод ограничен воздухом, вода остаётся.
{
  const w = 100, h = 60, sim = new Sim(w, h);
  const box = (x0, y0, x1, y1, id) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) sim.setCell(x, y, id, false); };
  box(0, h - 3, w - 1, h - 1, EL.WALL); box(0, 20, 0, h - 4, EL.WALL); box(w - 1, 20, w - 1, h - 4, EL.WALL);
  box(1, h - 20, 60, h - 4, EL.WATER);
  box(62, h - 14, 80, h - 4, EL.WOOD);
  box(82, h - 10, 98, h - 4, EL.EARTH);
  box(30, h - 8, 34, h - 6, EL.STONE);   // камень клетки не едят
  for (let k = 0; k < 6; k++) sim.setCell(10 + k * 9, h - 5, EL.CELL, false);
  const cnt = (id) => { let n = 0; for (let i = 0; i < sim.type.length; i++) if (sim.type[i] === id) n++; return n; };
  const stone0 = cnt(EL.STONE), water0 = cnt(EL.WATER);
  let peak = 0;
  run('Колония живых клеток', sim, () => { peak = Math.max(peak, cnt(EL.CELL)); }, 3000);
  if (peak < 20) fail(`колония не выросла: пик ${peak} клеток из 6 — проверка ничего не доказывает`);
  if (cnt(EL.STONE) !== stone0) fail(`камень съеден: было ${stone0}, стало ${cnt(EL.STONE)}`);
  if (cnt(EL.WATER) < water0 / 4) fail(`колония съела почти всю воду: было ${water0}, стало ${cnt(EL.WATER)}`);
  console.log(`  клеток: было 6, пик ${peak}, в конце ${cnt(EL.CELL)}; воды ${water0} → ${cnt(EL.WATER)}; дерева ${cnt(EL.WOOD)}`);
}

// Живые едят и отдают (Sim.chemBite / chemRelease / chemExhale): стая безымянных
// едоков, у каждого — store простых веществ. Едят всё вокруг (вода, дерево,
// камень, соль, песок, металл), делятся пополам, умирают и отдают всё телу мира.
// Требования из просьбы: вещество сохраняется (клетки + воздух + store — до
// единицы на каждом кадре), строгое не теряется, и когда все умерли, камень,
// железо, медь и соль на карте — в прежнем количестве. Едоки — не клетки игры:
// это проверка того, что на этом фундаменте можно строить живые клетки.
{
  console.log('Живые едят и отдают');
  const w = 90, h = 60;
  const sim = new Sim(w, h);
  const box = (x0, y0, x1, y1, id) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) sim.setCell(x, y, id, false); };
  box(0, h - 3, w - 1, h - 1, EL.WALL);
  box(2, h - 22, 30, h - 4, EL.WATER);
  box(33, h - 14, 42, h - 4, EL.WOOD);
  box(45, h - 12, 58, h - 4, EL.STONE);
  box(60, h - 8, 66, h - 4, EL.SAND);
  box(68, h - 8, 72, h - 4, EL.SALT);
  box(74, h - 8, 80, h - 4, EL.METAL);
  box(82, h - 8, 86, h - 4, EL.COPPER);
  box(60, h - 14, 66, h - 10, EL.EARTH);
  const SYM = (n) => n;
  const atomsOf = (s) => { const t = new Float64Array(CHEM_N); for (let i = 0; i < s.type.length; i++) if (s.type[i] || s.beam[i]) s.chemCellAdd(i, t, 1); return t; };
  const strictIdx = [...Array(CHEM_N).keys()].filter((a) => CHEM_STRICT[a]);
  const cellsStrict0 = atomsOf(sim);
  const water0 = count0(sim, EL.WATER);
  function count0(s, id) { let n = 0; for (let i = 0; i < s.type.length; i++) if (s.type[i] === id) n++; return n; }

  const agents = [];
  const spawnAgent = (x, y, store) => agents.push({ x, y, store: store || new Float64Array(CHEM_N), age: 0, dying: false });
  for (let k = 0; k < 6; k++) spawnAgent(8 + k * 12, h - 25);
  let peakStore = 0, peakEaten = 0, born = 0, died = 0, releasedParts = 0, exhaled = 0, killAll = false;
  const mass = (st) => { let m = 0; for (let a = 0; a < CHEM_N; a++) m += st[a]; return m; };
  const strictMass = (st) => { let m = 0; for (const a of strictIdx) m += st[a]; return m; };
  const R = 3;

  function giveBack(a) {
    // Отдать store на свободные клетки вокруг, расширяя круг; летучий остаток — в воздух.
    for (let r = 2; r <= 40 && strictMass(a.store) > 0; r += 2) {
      for (let tries = 0; tries < 30 && strictMass(a.store) > 0; tries++) {
        const x = Math.max(0, Math.min(w - 1, a.x + ((Math.random() * (2 * r + 1)) | 0) - r));
        const y = Math.max(0, Math.min(h - 1, a.y + ((Math.random() * (2 * r + 1)) | 0) - r));
        releasedParts += sim.chemRelease(y * w + x, a.store);
      }
    }
    // Остаток летучего (и воды, которой на целую долю не хватило) — на карту, где получится, иначе в воздух.
    for (let tries = 0; tries < 20 && mass(a.store) > 0; tries++) {
      const x = Math.max(0, Math.min(w - 1, a.x + ((Math.random() * 17) | 0) - 8));
      const y = Math.max(0, Math.min(h - 1, a.y + ((Math.random() * 17) | 0) - 8));
      releasedParts += sim.chemRelease(y * w + x, a.store);
    }
    exhaled += sim.chemExhale(a.store);
  }

  function life() {
    for (const a of agents) {
      a.age++;
      if (a.dying) continue;
      // Едят: ближайший случайный съедобный сосед в радиусе R.
      const x = Math.max(0, Math.min(w - 1, a.x + ((Math.random() * (2 * R + 1)) | 0) - R));
      const y = Math.max(0, Math.min(h - 1, a.y + ((Math.random() * (2 * R + 1)) | 0) - R));
      if (sim.chemBite(y * w + x, a.store)) { a.x += Math.sign(x - a.x); a.y += Math.sign(y - a.y); }
      else a.y = Math.min(h - 5, a.y + (Math.random() < 0.5 ? 1 : 0));   // тянет к земле
      // Делятся пополам, когда наелись.
      if (mass(a.store) > 120 && agents.length < 60) {
        const half = new Float64Array(CHEM_N);
        for (let k = 0; k < CHEM_N; k++) { half[k] = Math.floor(a.store[k] / 2); a.store[k] -= half[k]; }
        spawnAgent(a.x, a.y, half); born++;
      }
      if (killAll || (a.age > 500 && Math.random() < 0.01)) a.dying = true;
    }
    for (let k = agents.length - 1; k >= 0; k--) {
      const a = agents[k];
      if (!a.dying) continue;
      giveBack(a);
      if (mass(a.store) === 0) { agents.splice(k, 1); died++; }
    }
    let m = 0; for (const a of agents) m += mass(a.store);
    peakStore = Math.max(peakStore, m);
    peakEaten = Math.max(peakEaten, water0 - count0(sim, EL.WATER));
  }
  const origEnd = Sim.prototype.chemEndStep;
  Sim.prototype.chemEndStep = function () { if (this === sim) life(); return origEnd.call(this); };

  sim.step();
  const t0 = total(sim);
  let bad = 0;
  const totalFrames = Math.max(FRAMES, 1200);
  for (let f = 0; f < totalFrames + 400; f++) {
    if (f === totalFrames) killAll = true;
    sim.step();
    const t = total(sim);
    const diff = new Float64Array(CHEM_N);
    let off = false;
    for (let a = 0; a < CHEM_N; a++) { diff[a] = t[a] - t0[a]; if (diff[a]) off = true; }
    if (off && bad++ < 3) fail(`кадр ${f}: сумма с телами существ разошлась на ${vecText(diff)}`);
  }
  Sim.prototype.chemEndStep = origEnd;
  const stores = new Float64Array(CHEM_N);
  for (const a of agents) for (let k = 0; k < CHEM_N; k++) stores[k] += a.store[k];
  const lifeLedger = new Float64Array(CHEM_N);
  for (let k = 0; k < CHEM_N; k++) lifeLedger[k] = -sim.chemExt[env.get('CHEM_EXT_LIFE') * CHEM_N + k];
  if ([...stores].some((v, k) => v !== lifeLedger[k])) fail(`статья "Живое" (${vecText(lifeLedger)}) не равна телам существ (${vecText(stores)})`);
  if (sim.chemLeak.some((v) => v !== 0)) fail(`строгое через воздух: ${vecText(sim.chemLeak)}`);
  if (Math.min(...sim.chemAir) < 0) fail('воздух ушёл в минус');
  const cellsStrict1 = atomsOf(sim);
  for (const a of strictIdx) if (cellsStrict1[a] !== cellsStrict0[a]) fail(`${sym(a)}: на карте было ${cellsStrict0[a]}, после смерти всех стало ${cellsStrict1[a]}`);
  if (agents.length) fail(`не все отдали вещество: осталось ${agents.length} существ`);
  if (born < 3) fail(`существа не размножались (родилось ${born}): проверка ничего не доказывает`);
  if (peakEaten < 20) fail(`съедено воды всего ${peakEaten} клеток: проверка ничего не доказывает`);
  const waterEnd = count0(sim, EL.WATER);
  console.log(`  родилось ${born}, умерло ${died}; пик вещества в телах ${peakStore | 0} ед., съедено воды до ${peakEaten} клеток из ${water0}; отдано на карту ${releasedParts} долей, выдохнуто ${exhaled | 0}`);
  console.log(`  строгое на карте: было ${vecText(cellsStrict0.map((v, a) => (CHEM_STRICT[a] ? v : 0)))}, стало ${vecText(cellsStrict1.map((v, a) => (CHEM_STRICT[a] ? v : 0)))}; воды клеток: было ${water0}, стало ${waterEnd}`);
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
