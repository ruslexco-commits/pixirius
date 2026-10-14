'use strict';

// Мир по сиду (js/sim/lockstep.js, мультиплеер js/net.js):
//   node tools/lockstep-check.js [кадров]
//
// Две копии мира с одним сидом и одними действиями обязаны идти побайтно
// одинаково — на этом стоит мультиплеер: вкладки считают мир сами, хост
// шлёт им только действия. Проверяется и копия, снятая посреди прогона
// (lockstepDump/lockstepLoad — так мир получает вошедшая вкладка): если в
// снимок не попало что-то, от чего зависит ход (сон кусков, кэш
// устойчивости, память людей, заряды), копия разойдётся, и здесь видно, в
// каком кадре и в каком поле.
//
// Ещё — потоки (sim/threads.js, updateBands): тот же мир с рабочими
// потоками (worker_threads, как tools/threads-check.js) и без них обязан
// идти побайтно одинаково — у вкладок мультиплеера потоков может быть
// разное число, а мир у всех один.
//
// Код выхода 1 — если копии разошлись.

const path = require('path');
const os = require('os');
const { Worker } = require('worker_threads');
const H = require('./harness');
const env = H.loadSim({ seed: 5 });
const Sim = env.get('Sim'), PARTICLE_FIELDS = env.get('PARTICLE_FIELDS');
const frames = Number(process.argv[2]) || 400;

// Шаг "как в мультиплеере": действия (кисти сцены) и шаг — со случайными
// числами мира.
const tick = (s, k) => s.withRng(() => { H.poke(env, s, k); s.step(); });

const a = H.buildScene(env);
a.lockstep = true;
a.rngSeed(12345);
// Копия с самого начала: тот же сид, без снимка.
const b = new Sim(a.w, a.h);
b.lockstepLoad(structuredClone(a.lockstepDump()));
b.lockstep = true;

let fails = 0;
const diff = (x, y) => {
  for (const f of PARTICLE_FIELDS) {
    const p = x[f.name], q = y[f.name];
    for (let i = 0; i < p.length; i++) if (p[i] !== q[i] && !(p[i] !== p[i] && q[i] !== q[i])) return `${f.name}[${i}] (x=${i % x.w}, y=${(i / x.w) | 0}): ${p[i]} против ${q[i]}`;
  }
  if (x._rngState !== y._rngState) return `генератор: ${x._rngState} против ${y._rngState}`;
  return null;
};

const half = frames >> 1;
let c = null, t0 = Date.now();
for (let k = 0; k < frames; k++) {
  tick(a, k); tick(b, k);
  if (c) tick(c, k);
  if (k === half) {
    // Снимок посреди прогона — через structuredClone, как через BroadcastChannel.
    c = new Sim(a.w, a.h);
    c.lockstepLoad(structuredClone(a.lockstepDump()));
    c.lockstep = true;
    const d0 = diff(a, c);
    if (d0) { console.log(`  FAIL снимок на кадре ${a.frame} не совпал сразу: ${d0}`); fails++; c = null; }
  }
  const db = diff(a, b);
  if (db) { console.log(`  FAIL копия с начала разошлась на кадре ${a.frame}: ${db}`); fails++; break; }
  if (c) {
    const dc = diff(a, c);
    if (dc) { console.log(`  FAIL копия со снимка (кадр ${half + 1}) разошлась на кадре ${a.frame}: ${dc}`); fails++; break; }
  }
}
if (!fails) {
  const hashOk = a.lockstepHash() === b.lockstepHash() && (!c || a.lockstepHash() === c.lockstepHash());
  if (!hashOk) { console.log('  FAIL отпечатки разные при одинаковых полях'); fails++; }
  // Отпечаток замечает расхождение.
  for (let k = 0; k < 4; k++) b.temp[1234 + k] += 1;   // отпечаток берёт каждое четвёртое слово
  if (a.lockstepHash() === b.lockstepHash()) { console.log('  FAIL отпечаток не заметил другую температуру'); fails++; }
}
if (!fails) console.log(`  копия с начала и со снимка на кадре ${half + 1} — побайтно одинаковы, ${frames} кадров (${Date.now() - t0} мс)`);

// Потоки против одного главного (см. шапку).
const THREADS = Math.max(1, Math.min(3, Math.floor(os.cpus().length / 2) - 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function peopleScene(env) {
  const S = env.get('Sim'), E = env.get('EL');
  const sim = new S(576, 324);
  const box = (x0, y0, x1, y1, id) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) sim.setCell(x, y, id, false); };
  box(0, 300, 575, 323, E.STONE);
  for (let x = 30; x < 560; x += 25) sim.setCell(x, 299, E.HUMAN, false);
  sim.placePlayer(1, sim.idx(250, 299)); sim.placePlayer(2, sim.idx(250, 298));
  sim.playerSlot(1).input.right = true;
  box(100, 280, 110, 299, E.GUNP);
  box(300, 285, 306, 299, E.BLACK_SALT);
  box(400, 270, 480, 299, E.WATER);
  for (let y = 20; y < 120; y += 3) for (let x = 0; x < 576; x += 3) sim.setCell(x, y, (x + y) % 2 ? E.SAND : E.WATER, false);
  sim.stampBrush(105, 278, 'circle', 1, 1, E.FIRE, false);
  sim.stampBrush(303, 283, 'circle', 1, 1, E.FIRE, false);
  return sim;
}
async function threadsVsOne(name, make, steps) {
  const envA = H.loadSim({ seed: 7 }), envB = H.loadSim({ seed: 7 });
  const one = make(envA), multi = make(envB);
  const workers = [];
  multi.startThreads(THREADS, (k, init) => {
    const wk = new Worker(path.join(__dirname, 'threads-worker.js'), { workerData: { init, seed: 900 + k } });
    wk.on('error', (e) => { console.log(`  FAIL поток ${k}: ${e && e.stack || e}`); fails++; });
    workers.push(wk);
    return wk;
  });
  for (let t = 0; t < 200 && !multi.threadsReady(); t++) await sleep(25);
  if (!multi.threadsReady()) { console.log(`  FAIL ${name}: потоки не запустились`); fails++; return; }
  for (const s of [one, multi]) { s.lockstep = true; s.rngSeed(4242); }
  let bad = null, ms1 = 0, msN = 0;
  for (let k = 0; k < steps && !bad; k++) {
    let t = process.hrtime.bigint();
    one.withRng(() => one.step());
    ms1 += Number(process.hrtime.bigint() - t) / 1e6;
    t = process.hrtime.bigint();
    multi.withRng(() => multi.step());
    msN += Number(process.hrtime.bigint() - t) / 1e6;
    const d = diff(one, multi);
    if (d) bad = `кадр ${one.frame}: ${d}`;
  }
  multi.stopThreads();
  await Promise.all(workers.map((w) => new Promise((r) => w.once('exit', r))));
  if (bad) { console.log(`  FAIL ${name}: ${THREADS + 1} потоков разошлись с одним — ${bad}`); fails++; return; }
  console.log(`  ${name}: ${THREADS + 1} потоков и один — побайтно одинаково, ${steps} кадров; ${(ms1 / steps).toFixed(1)} мс против ${(msN / steps).toFixed(1)} мс на шаг`);
}

(async () => {
  await threadsVsOne('стенд 576x324', (env) => H.buildScene(env, 576, 324), 150);
  await threadsVsOne('люди, игроки, взрывы, ливень', peopleScene, 150);
  console.log(fails ? '\nРАСХОЖДЕНИЕ' : '\nOK: мир по сиду одинаков у копий и при любом числе потоков');
  process.exit(fails ? 1 : 0);
})();
