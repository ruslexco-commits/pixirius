'use strict';

// Проверка параллельного обхода (js/sim/threads.js) без браузера:
//
//   node tools/threads-check.js [потоков]
//
// Тот же код и та же общая память, что в браузере, только потоки —
// worker_threads. Для каждой сцены один и тот же мир считается одним
// потоком и несколькими:
//  - время шага;
//  - многопоточный мир цел: у каждой клетки состав согласован с типом,
//    нет неизвестных типов и NaN;
//  - вещество не уплывает: число клеток каждого вида после прогона
//    близко к однопоточному. Случайности у потоков свои, поэтому точного
//    совпадения нет и быть не может; мерой служит разброс между двумя
//    однопоточными прогонами с разным зерном (огонь, например, от зерна
//    гуляет вдвое). Так поймался шов полос, стоявший на одних строках:
//    мокрой земли выходило в полтора раза больше любого зерна.
// Отдельно — сцена с людьми, порохом и сухими солями: отложенные действия
// (люди, подрывы) досчитывает главный поток.
//
// Код выхода 1 — если хоть одна проверка не прошла.

const path = require('path');
const os = require('os');
const { Worker } = require('worker_threads');
const H = require('./harness');

// По умолчанию — как в браузере (main.js, startSimThreads): ядер пополам минус один.
const THREADS = Number(process.argv[2]) || Math.max(1, Math.min(7, Math.floor(os.cpus().length / 2) - 1));
let failed = 0;
const fail = (msg) => { failed++; console.log('  ОШИБКА: ' + msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeScene(env, kind) {
  const Sim = env.get('Sim'), EL = env.get('EL');
  if (kind === 'стенд') return H.buildScene(env, 576, 324);
  const sim = new Sim(576, 324);
  const box = (x0, y0, x1, y1, id) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) sim.setCell(x, y, id, false); };
  if (kind === 'плотная') {
    const ids = [EL.SAND, EL.WATER, EL.STONE, EL.EARTH, EL.OIL, EL.WOOD];
    for (let y = 120; y < 324; y++) for (let x = 0; x < 576; x++) sim.setCell(x, y, ids[((x >> 5) + (y >> 4)) % ids.length], false);
    sim.stampBrush(300, 200, 'circle', 6, 6, EL.FIRE, false);
  } else if (kind === 'ливень') {
    // Всё движется: песок и вода падают с неба в чашу.
    box(0, 300, 575, 323, EL.STONE);
    for (let y = 20; y < 200; y += 2) for (let x = 0; x < 576; x += 2) sim.setCell(x, y, (x + y) % 4 === 0 ? EL.SAND : EL.WATER, false);
  } else if (kind === 'люди и взрывы') {
    box(0, 300, 575, 323, EL.STONE);
    for (let x = 30; x < 560; x += 25) sim.setCell(x, 299, EL.HUMAN, false);
    sim.setCell(250, 299, EL.PROTAGONIST, false);   // его ход — тоже на главном потоке
    sim.playerInput.right = true;
    box(100, 280, 110, 299, EL.GUNP);
    box(300, 285, 306, 299, EL.BLACK_SALT);
    box(400, 270, 480, 299, EL.WATER);
    sim.stampBrush(105, 278, 'circle', 1, 1, EL.FIRE, false);
    sim.stampBrush(303, 283, 'circle', 1, 1, EL.FIRE, false);
  }
  return sim;
}

function counts(env, sim) {
  const EL = env.get('EL');
  const out = {};
  for (const [name, id] of Object.entries(EL)) {
    if (!id) continue;
    let n = 0;
    for (let i = 0; i < sim.type.length; i++) if (sim.type[i] === id) n++;
    if (n) out[name] = n;
  }
  return out;
}

function integrity(env, sim) {
  const Sim = env.get('Sim'), EL = env.get('EL'), ELEMENTS = env.get('ELEMENTS');
  const solMatter = env.get('solMatter');
  const probe = new Sim(1, 1);
  let bad = 0, nan = 0, mismatch = 0;
  for (let i = 0; i < sim.type.length; i++) {
    const t = sim.type[i];
    if (!Number.isFinite(sim.temp[i])) nan++;
    if (t === EL.EMPTY) continue;
    if (!ELEMENTS[t]) { bad++; continue; }
    const c = sim.comp(i);
    const m = solMatter(c);
    if (!c || m < 1 || m > 10) { bad++; continue; }
    probe.type[0] = t;
    probe.setComposition(0, c);
    if (probe.type[0] !== t && !((t === EL.SOLUTION || t === EL.VAPOR) && c < 1024)) mismatch++;
  }
  return { bad, nan, mismatch };
}

async function runScene(kind, steps) {
  const envS = H.loadSim({ seed: 3 }), envT = H.loadSim({ seed: 3 }), envR = H.loadSim({ seed: 4 });
  const single = makeScene(envS, kind), multi = makeScene(envT, kind), ref = makeScene(envR, kind);
  const workers = [];
  multi.startThreads(THREADS, (k, init) => {
    const wk = new Worker(path.join(__dirname, 'threads-worker.js'), { workerData: { init, seed: 100 + k } });
    wk.on('error', (e) => fail(`поток ${k}: ${e && e.stack || e}`));
    workers.push(wk);
    return wk;
  });
  for (let t = 0; t < 200 && !multi.threadsReady(); t++) await sleep(25);
  if (!multi.threadsReady()) { fail(`${kind}: потоки не запустились`); return; }
  // Прогрев, потом замер.
  for (let k = 0; k < 30 + steps; k++) ref.step();
  for (let k = 0; k < 30; k++) { single.step(); multi.step(); }
  // Общая фаза (ветер, тепло, выходы луж — globalPassesParallel) обязана
  // совпасть с однопоточными проходами побитно: тот же мир, один проход
  // там и там.
  {
    const Sim = envT.get('Sim');
    const solo = new Sim(multi.w, multi.h);
    solo.type.set(multi.type); solo.temp.set(multi.temp);
    solo.windVX.set(multi.windVX); solo.windVY.set(multi.windVY);
    solo._liquidEscape.set(multi._liquidEscape);
    const hot = multi.temp.reduce((n, v) => n + (v !== 0), 0);
    const windy = multi.windVX.reduce((n, v) => n + (v !== 0), 0);
    solo.updateWind(); solo.updateTemp(); solo.computeLiquidEscape();
    multi.globalPassesParallel();
    const differ = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) d++; return d; };
    const dT = differ(solo.temp, multi.temp);
    const dW = differ(solo.windVX, multi.windVX) + differ(solo.windVY, multi.windVY);
    const dE = differ(solo._liquidEscape, multi._liquidEscape);
    if (dT || dW || dE) fail(`${kind}: общая фаза по потокам разошлась с однопоточной: тепло ${dT}, ветер ${dW}, выходы луж ${dE}`);
    else console.log(`  ветер, тепло и выходы луж по потокам побитно как в одном потоке (${hot} тёплых клеток, ${windy} клеток ветра)`);
  }
  let t0 = process.hrtime.bigint();
  for (let k = 0; k < steps; k++) single.step();
  const ms1 = Number(process.hrtime.bigint() - t0) / 1e6 / steps;
  t0 = process.hrtime.bigint();
  for (let k = 0; k < steps; k++) multi.step();
  const msN = Number(process.hrtime.bigint() - t0) / 1e6 / steps;
  const cS = counts(envS, single), cT = counts(envT, multi), cR = counts(envR, ref);
  const ig = integrity(envT, multi);
  multi.stopThreads();
  await Promise.all(workers.map((w) => new Promise((r) => w.once('exit', r))));

  console.log(`${kind.padEnd(14)} один поток ${ms1.toFixed(1).padStart(5)} мс, ${THREADS + 1} потоков ${msN.toFixed(1).padStart(5)} мс  (в ${(ms1 / msN).toFixed(2)} раза быстрее)`);
  if (ig.bad) fail(`${kind}: ${ig.bad} клеток с неверным типом или составом`);
  if (ig.nan) fail(`${kind}: ${ig.nan} NaN в температуре`);
  if (ig.mismatch) fail(`${kind}: у ${ig.mismatch} клеток тип не соответствует составу`);
  // Вещество: у массовых видов (от 2% поля) расхождение с однопоточным не
  // больше 100 клеток, 10% или тройного разброса между зёрнами — что из
  // этого больше. Мелкие виды (огонь, пар, мокрая земля) только печатаются:
  // они хаотичны и чувствительны к ЛЮБОМУ порядку обхода. Пример —
  // мокрая земля в плотной сцене: вся земля создана одним кадром, счётчики
  // влажности у неё срабатывают разом на 60-м кадре, и итог этого одного
  // кадра зависит от порядка клеток. С потоками порядок — бросок монеты
  // (сдвиг сетки и порядок фаз), и мокрой земли выходит то ~650, то ~1050;
  // до 60-го кадра её нет вовсе. Без потоков случайное направление строк
  // даёт такой же разброс, так что это не гонка.
  const drift = [];
  const bulk = 0.02 * multi.w * multi.h;
  for (const name of new Set([...Object.keys(cS), ...Object.keys(cT)])) {
    const a = cS[name] || 0, b = cT[name] || 0, r = cR[name] || 0;
    if (Math.max(a, b) < 500) continue;
    drift.push(`${name} ${a}/${r}/${b}`);
    if (Math.max(a, b) < bulk) continue;
    if (Math.abs(a - b) > Math.max(100, 0.1 * Math.max(a, b), 3 * Math.abs(a - r))) fail(`${kind}: ${name} один поток ${a} (другое зерно ${r}), потоки ${b}`);
  }
  console.log(`  вещество (один / другое зерно / потоки): ${drift.join(', ')}`);
}

async function main() {
  console.log(`Потоков: главный + ${THREADS} рабочих (ядер: ${os.cpus().length})`);
  for (const kind of ['стенд', 'плотная', 'ливень', 'люди и взрывы']) await runScene(kind, 60);
  console.log(failed ? `\nПРОВАЛ: ${failed}` : '\nOK: параллельный обход цел');
  process.exit(failed ? 1 : 0);
}

main();
