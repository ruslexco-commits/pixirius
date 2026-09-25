'use strict';

// Сравнение поведения рабочей копии с коммитом git — побайтно, шаг за шагом.
//
//   node tools/compare.js            — рабочая копия против HEAD
//   node tools/compare.js <ref> [N]  — против любого коммита, N шагов (400)
//
// Обе версии получают одно и то же зерно Math.random, одну и ту же сцену и
// одни и те же воздействия (см. harness.js). Если код менялся только по
// форме (рефакторинг, перенос методов, комментарии), миры обязаны совпасть
// на каждом шаге. Первое расхождение печатается с номером шага и списком
// разошедшихся полей — с него и надо начинать поиск.
//
// Для правок, которые НАРОЧНО меняют поведение, расхождение ожидаемо —
// инструмент тогда просто показывает, с какого шага и в каких полях.

const { loadSim, buildScene, poke, fingerprint } = require('./harness');

const ref = process.argv[2] || 'HEAD';
const steps = Number(process.argv[3]) || 400;
const SEED = 12345;

function run(refOrNull) {
  const env = loadSim({ ref: refOrNull, seed: SEED });
  const sim = buildScene(env);
  const prints = [];
  for (let s = 0; s < steps; s++) {
    poke(env, sim, s);
    sim.step();
    // Посередине прогона — отмена и загрузка сохранения: тоже часть
    // поведения, которое должно остаться прежним.
    if (s === Math.floor(steps / 2)) {
      const snap = sim.snapshot();
      sim.step();
      sim.restore(snap);
      sim.deserialize(JSON.parse(JSON.stringify(sim.serialize())));
    }
    prints.push(fingerprint(sim));
  }
  return prints;
}

const a = run(ref);
const b = run(null);
for (let s = 0; s < steps; s++) {
  const fa = a[s], fb = b[s];
  const diff = Object.keys(fa).filter((k) => k in fb && fa[k] !== fb[k]);
  if (diff.length) {
    console.log(`РАСХОЖДЕНИЕ на шаге ${s} (${ref} против рабочей копии): ${diff.join(', ')}`);
    process.exit(1);
  }
}
console.log(`OK: ${steps} шагов, рабочая копия побайтно совпадает с ${ref}`);
