'use strict';

// Headless-стенд симуляции: загружает файлы симуляции (всё, что в
// index.html подключается ДО render.js) в изолированный vm-контекст Node,
// без браузера и DOM. Math.random в контексте подменяется детерминированным
// генератором — два прогона с одним зерном дают побайтно один и тот же мир,
// на этом держится tools/compare.js.
//
// Можно загрузить и рабочую копию, и любой коммит git (ref) — файлы тогда
// читаются через `git show`, рабочая копия не трогается.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function readRepoFile(rel, ref) {
  if (!ref) return fs.readFileSync(path.join(ROOT, rel), 'utf8');
  return execFileSync('git', ['show', `${ref}:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
}

// Список скриптов берётся из самого index.html (массив files загрузчика),
// чтобы порядок подключения жил в одном месте.
function scriptList(ref) {
  const html = readRepoFile('index.html', ref);
  const m = html.match(/var files = \[([^\]]*)\]/);
  if (!m) throw new Error('index.html: не найден массив files загрузчика');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

function simScripts(ref) {
  const files = scriptList(ref);
  const cut = files.indexOf('js/render.js');
  return cut < 0 ? files : files.slice(0, cut);
}

// mulberry32 — маленький быстрый детерминированный генератор.
function makeRandom(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Имена верхнего уровня файла (const/let/class/function) — чтобы вернуть их
// наружу из общей обёртки.
function topLevelNames(src) {
  return [...src.matchAll(/^(?:const|let|var|class|function)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
}

// Скрипты склеиваются в тело ОДНОЙ функции, а не выполняются в vm-контексте:
// в vm каждое обращение к глобальной функции (isStructural, solGet и т.д.)
// идёт через перехватчик глобального объекта и не кэшируется движком —
// симуляция работала в десятки раз медленнее, чем в браузере. Внутри
// функции те же имена — обычные локальные переменные.
//
// Math внутри обёртки — свой объект с детерминированным random поверх
// настоящего Math; глобальный Math процесса не трогается.
//
// Возвращает { get(name) } — доступ к любому имени верхнего уровня
// загруженных скриптов (Sim, EL, ELEMENTS, ...).
function loadSim({ ref = null, seed = 1 } = {}) {
  const parts = [];
  const names = new Set();
  for (const file of simScripts(ref)) {
    const src = readRepoFile(file, ref);
    parts.push(`// ==== ${file} ====\n${src}`);
    for (const n of topLevelNames(src)) names.add(n);
  }
  const body = "'use strict';\n"
    + 'const Math = Object.create(globalThis.Math); Math.random = __random;\n'
    + parts.join('\n')
    + `\nreturn { ${[...names].join(', ')} };`;
  const api = new Function('__random', body)(makeRandom(seed));
  return {
    get(name) {
      if (!(name in api)) throw new Error(`в загруженных скриптах нет имени ${name}`);
      return api[name];
    },
    has(name) { return name in api; },
  };
}

// Типовая сцена, задевающая почти все механики: опоры и навесы, лужи всех
// жидкостей системы долей, лава у камня и металла, горючее, земля с водой,
// люди, балки, лёд, газы, плюс кисти давления и температуры.
// Строится только через публичные методы рисования — они одинаковы во
// всех версиях, поэтому сцену можно воспроизвести и на старом коммите.
function buildScene(env, w = 240, h = 160) {
  const Sim = env.get('Sim');
  const sim = new Sim(w, h);
  const EL = env.get('EL');
  const box = (x0, y0, x1, y1, id) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) sim.setCell(x, y, id, false);
  };
  box(0, h - 6, w - 1, h - 1, EL.STONE);          // пол
  box(10, h - 40, 14, h - 7, EL.STONE);           // колонна
  box(15, h - 40, 45, h - 37, EL.STONE);          // навес на колонне
  box(50, h - 30, 90, h - 7, EL.WALL);            // бассейн
  box(52, h - 30, 88, h - 8, EL.EMPTY);
  box(52, h - 20, 88, h - 8, EL.WATER);
  box(60, h - 28, 70, h - 21, EL.ACID);
  box(75, h - 28, 85, h - 21, EL.REAGENT);
  box(100, h - 25, 130, h - 7, EL.METAL);
  box(100, h - 30, 130, h - 26, EL.WATER);
  box(135, h - 20, 150, h - 7, EL.STONE);
  box(137, h - 26, 148, h - 21, EL.LAVA);
  box(155, h - 30, 165, h - 7, EL.WOOD);
  box(166, h - 12, 172, h - 7, EL.OIL);
  box(175, h - 35, 215, h - 7, EL.EARTH);
  box(180, h - 45, 200, h - 36, EL.WATER);
  box(20, h - 60, 40, h - 55, EL.ICE);
  box(30, h - 90, 60, h - 85, EL.STEAM);
  box(120, h - 80, 140, h - 75, EL.ACID_GAS);
  box(220, h - 30, 230, h - 7, EL.GLASS);
  box(92, h - 50, 98, h - 45, EL.SAND);
  box(160, h - 60, 162, h - 50, EL.GUNP);
  box(200, h - 90, 220, h - 88, EL.ACID);
  for (let x = 16; x <= 44; x += 2) sim.setCell(x, h - 36, EL.BEAM, false);
  for (let x = 20; x <= 40; x++) sim.setCell(x, h - 50, EL.BEAM, false);  // балка без опоры — станет камнем
  for (let x = 176; x <= 214; x += 6) sim.setCell(x, h - 36 - 10, EL.HUMAN, false);
  for (let x = 17; x <= 43; x += 7) sim.setCell(x, h - 41, EL.HUMAN, false);
  sim.setCell(190, h - 60, EL.COLONIST, false);
  box(100, h - 70, 104, h - 67, EL.ACID_ICE);     // замёрзшие кислота и реагент в воздухе — падают
  box(108, h - 70, 112, h - 67, EL.REAGENT_ICE);
  sim.setCell(136, h - 22, EL.OXIDE, false);       // окисел и кислотный остаток у лавы — плавятся
  sim.setCell(136, h - 23, EL.OXIDE, false);
  sim.setCell(149, h - 22, EL.ACID_RESIDUE, false);
  box(20, h - 42, 24, h - 42, EL.METAL_OXIDE);    // ржавчина на навесе под водой из тающего льда
  // Сталь под водой и металлическая балка — только там, где они есть:
  // сцена должна воспроизводиться и на старых коммитах (compare.js).
  if (EL.STEEL) { box(232, h - 12, 238, h - 7, EL.STEEL); box(232, h - 16, 238, h - 13, EL.WATER); }
  // Сухие чёрные соли у пороха: порох вспыхнет от огня и подорвёт их.
  if (EL.BLACK_SALT) box(156, h - 52, 158, h - 50, EL.BLACK_SALT);
  // Растворитель на каменном полу у колонны: меняется долями с камнем.
  if (EL.DISSOLVER) box(3, h - 12, 8, h - 7, EL.DISSOLVER);
  if (sim.pickBeamMaterial) {
    sim.pickBeamMaterial(100, h - 20);             // от металла
    for (let x = 131; x <= 150; x++) sim.setCell(x, h - 26, EL.BEAM, false);
    sim.pickBeamMaterial(-1, -1);                  // дальше — снова каменные
  }
  sim.applyTempBrush(142, h - 15, 8, 8, 1);
  return sim;
}

// Воздействия по ходу прогона (кисти, огонь), чтобы задеть ветер, нагрев и
// горение, а не только спокойное оседание сцены.
function poke(env, sim, step) {
  const EL = env.get('EL');
  if (step === 20) sim.stampBrush(160, sim.h - 20, 'circle', 3, 3, EL.FIRE, false);
  if (step >= 30 && step < 60) sim.applyPressureBrush(70, sim.h - 15, 6, 6, 1);
  if (step >= 60 && step < 90) sim.applyTempBrush(110, sim.h - 20, 6, 6, 1);
  if (step >= 90 && step < 110) sim.applyTempBrush(30, sim.h - 57, 5, 5, -1);
  if (step === 120) sim.stampLine(100, 20, 140, 40, 'square', 1, 1, EL.WATER, true);
  if (step === 140) sim.floodFill(60, sim.h - 12, EL.OIL, false);
}

// Поля, из которых складывается отпечаток мира. Отсутствующие в старой
// версии поля пропускаются.
const HASHED_FIELDS = ['type', 'life', 'extra', 'shade', 'temp', 'moisture', 'sol', 'beam',
  'stability', 'windVX', 'windVY', 'colonistHomeX', 'colonistHomeY'];

function fnv(arr) {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let hsh = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) { hsh ^= bytes[i]; hsh = Math.imul(hsh, 0x01000193); }
  return (hsh >>> 0).toString(16).padStart(8, '0');
}

function fingerprint(sim) {
  const out = {};
  for (const f of HASHED_FIELDS) if (sim[f]) out[f] = fnv(sim[f]);
  return out;
}

module.exports = { ROOT, loadSim, buildScene, poke, fingerprint, simScripts, scriptList, readRepoFile };
