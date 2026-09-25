'use strict';

// Быстрая самопроверка симуляции без браузера:  node tools/check.js
//
//  1. Таблица элементов согласована (id, обязательные поля, палитра).
//  2. swapFields обменивает все поля PARTICLE_FIELDS с moves: true и не
//     трогает остальные.
//  3. Прогон типовой сцены: без исключений, без NaN, без мусорных типов,
//     состав у клеток системы долей всегда ровно из SOL_PARTS долей.
//  4. Отмена и сохранение восстанавливают мир побайтно.
//  5. Замер: миллисекунд на step() на поле реального размера (576x324).
//
// Код выхода 1 — если хоть одна проверка не прошла.

const { loadSim, buildScene, poke } = require('./harness');

const env = loadSim({ seed: 7 });
const Sim = env.get('Sim');
const EL = env.get('EL');
const ELEMENTS = env.get('ELEMENTS');
const ELEMENT_ORDER = env.get('ELEMENT_ORDER');
const PARTICLE_FIELDS = env.get('PARTICLE_FIELDS');
const hasComposition = env.get('hasComposition');
const solMatter = env.get('solMatter');
const solGet = env.get('solGet');
const P_COUNT = env.get('P_COUNT');
const SOL_PARTS = env.get('SOL_PARTS');

let failed = 0;
const fail = (msg) => { failed++; console.log('  ОШИБКА: ' + msg); };
const section = (name) => console.log(name);

// ---- 1. таблица элементов ----
section('Таблица элементов');
for (const [name, id] of Object.entries(EL)) {
  if (id === EL.EMPTY) continue;
  const el = ELEMENTS[id];
  if (!el) { fail(`EL.${name} (${id}) нет в ELEMENTS`); continue; }
  if (el.id !== id) fail(`ELEMENTS[${id}].id = ${el.id}`);
  if (!el.name || !el.cat || !Array.isArray(el.color)) fail(`у EL.${name} нет name/cat/color`);
  if (el.meltChance && (el.meltPoint === undefined || el.meltsInto === undefined)) fail(`EL.${name}: meltChance без meltPoint/meltsInto`);
  if (id >= 64) fail(`EL.${name} = ${id}: таблицы по id (IS_GASLIKE, LIQUID_PHASE, OXIDE_FRAIL_FROM) рассчитаны на id < 64`);
}
for (const id of ELEMENT_ORDER) if (!ELEMENTS[id]) fail(`в ELEMENT_ORDER неизвестный id ${id}`);

// ---- 2. swapFields против PARTICLE_FIELDS ----
section('Поля клетки');
{
  const sim = new Sim(4, 4);
  for (const f of PARTICLE_FIELDS) {
    const arr = sim[f.name];
    if (!arr || arr.length !== 16) { fail(`PARTICLE_FIELDS: у Sim нет поля ${f.name} размером w*h`); continue; }
    arr[0] = 3; arr[5] = 5;
    sim.swapFields(0, 5);
    const swapped = arr[0] === 5 && arr[5] === 3;
    if (f.moves && !swapped) fail(`swapFields не обменивает ${f.name} (moves: true)`);
    if (!f.moves && swapped) fail(`swapFields обменивает ${f.name}, хотя у него moves: false`);
    arr.fill(f.empty);
  }
}

// ---- 3. прогон сцены ----
section('Прогон сцены');
const sim = buildScene(env);
const n = sim.w * sim.h;
try {
  for (let s = 0; s < 600; s++) {
    poke(env, sim, s);
    sim.step();
    if (s % 50 !== 49) continue;
    let bad = 0, nan = 0, comp = 0;
    for (let i = 0; i < n; i++) {
      const t = sim.type[i];
      if (t !== EL.EMPTY && !ELEMENTS[t]) bad++;
      if (!Number.isFinite(sim.temp[i])) nan++;
      if (hasComposition(t)) {
        let sum = 0;
        for (let k = 0; k < P_COUNT; k++) sum += solGet(sim.sol[i], k);
        if (sum !== SOL_PARTS || solMatter(sim.sol[i]) === 0) comp++;
      }
    }
    for (let i = 0; i < sim.windVX.length; i++) if (!Number.isFinite(sim.windVX[i]) || !Number.isFinite(sim.windVY[i])) nan++;
    if (bad) fail(`шаг ${s}: ${bad} клеток с неизвестным типом`);
    if (nan) fail(`шаг ${s}: ${nan} значений NaN/Infinity в temp/ветре`);
    if (comp) fail(`шаг ${s}: ${comp} клеток системы долей с неверным составом`);
    if (bad || nan || comp) break;
  }
} catch (e) {
  fail('исключение при прогоне: ' + (e && e.stack || e));
}

// ---- 4. отмена и сохранение ----
section('Отмена и сохранение');
{
  const before = JSON.stringify(sim.serialize());
  const snap = sim.snapshot();
  for (let s = 0; s < 20; s++) sim.step();
  sim.restore(snap);
  if (JSON.stringify(sim.serialize()) !== before) fail('restore(snapshot()) не вернул мир побайтно');
  const copy = new Sim(sim.w, sim.h);
  if (!copy.deserialize(JSON.parse(before))) fail('deserialize отверг собственное сохранение');
  else if (JSON.stringify(copy.serialize()) !== before) fail('сохранение -> загрузка -> сохранение дало другой файл');
  const broken = JSON.parse(before); delete broken.life;
  if (copy.deserialize(broken)) fail('deserialize принял файл без обязательного поля');
}

// ---- 5. замер ----
section('Производительность');
{
  const big = buildScene(env, 576, 324);
  for (let s = 0; s < 30; s++) big.step();
  const N = 150;
  const t0 = process.hrtime.bigint();
  for (let s = 0; s < N; s++) { poke(env, big, s); big.step(); }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  console.log(`  ${ms.toFixed(2)} мс на step() при 576x324 (бюджет кадра 60 fps — 16.7 мс)`);
}

console.log(failed ? `\nПРОВАЛ: ${failed}` : '\nOK: все проверки пройдены');
process.exit(failed ? 1 : 0);
