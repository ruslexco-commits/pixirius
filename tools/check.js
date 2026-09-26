'use strict';

// Быстрая самопроверка симуляции без браузера:  node tools/check.js
//
//  1. Таблица элементов согласована (id, обязательные поля, палитра).
//  2. swapFields обменивает все поля PARTICLE_FIELDS с moves: true и не
//     трогает остальные.
//  3. Прогон типовой сцены: без исключений, без NaN, без мусорных типов,
//     состав у клеток системы долей всегда ровно из SOL_PARTS долей.
//  4. Отмена и сохранение восстанавливают мир побайтно.
//  5. Быстрые пути дают тот же результат, что и прямой расчёт: пропуск
//     пересчёта устойчивости при неизменном скелете, windHypot.
//  6. Замер: миллисекунд на step() на поле реального размера (576x324).
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
const SOL_PARTS = env.get('SOL_PARTS');
const SOL_SLOTS = env.get('SOL_SLOTS');
const solSlot = env.get('solSlot');

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
  if (typeof el.density !== 'number') fail(`у EL.${name} нет числовой density: движение сравнивает плотности через таблицу DENSITY`);
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
// Клетка-проба: что сделал бы из состава setComposition.
const probe = new Sim(1, 1);
try {
  for (let s = 0; s < 600; s++) {
    poke(env, sim, s);
    sim.step();
    if (s % 50 !== 49) continue;
    let bad = 0, nan = 0, comp = 0, mismatch = 0, example = '';
    for (let i = 0; i < n; i++) {
      const t = sim.type[i];
      if (t !== EL.EMPTY && !ELEMENTS[t]) bad++;
      if (!Number.isFinite(sim.temp[i])) nan++;
      if (t === EL.EMPTY) continue;
      // Состав есть у каждой непустой клетки: от 1 до 10 долей, ячейки
      // без повторов и только из известных элементов.
      const c = sim.comp(i);
      const m = solMatter(c);
      let ok = c !== 0 && m >= 1 && m <= SOL_PARTS;
      const seen = new Set();
      for (let k = 0; k < SOL_SLOTS && ok; k++) {
        const slot = solSlot(c, k);
        if (!slot) break;
        const id = slot & 63;
        if (!ELEMENTS[id] || seen.has(id) || (slot >>> 6) === 0) ok = false;
        seen.add(id);
      }
      if (!ok) { comp++; continue; }
      // Тип соответствует составу. Исключение — нарисованные "раствор" и
      // "смешанный газ": их свежий состав — чистая вода и пар.
      probe.type[0] = t;
      probe.setComposition(0, c);
      if (probe.type[0] !== t && !((t === EL.SOLUTION || t === EL.VAPOR) && c < 1024)) {
        mismatch++;
        if (!example) example = `${ELEMENTS[t].name} при составе ${[...seen].map((id) => ELEMENTS[id].name + ':' + solGet(c, id)).join(', ')} (ждали ${ELEMENTS[probe.type[0]] ? ELEMENTS[probe.type[0]].name : probe.type[0]})`;
      }
    }
    for (let i = 0; i < sim.windVX.length; i++) if (!Number.isFinite(sim.windVX[i]) || !Number.isFinite(sim.windVY[i])) nan++;
    if (bad) fail(`шаг ${s}: ${bad} клеток с неизвестным типом`);
    if (nan) fail(`шаг ${s}: ${nan} значений NaN/Infinity в temp/ветре`);
    if (comp) fail(`шаг ${s}: ${comp} клеток с неверным составом`);
    if (mismatch) fail(`шаг ${s}: у ${mismatch} клеток тип не соответствует составу, например ${example}`);
    if (bad || nan || comp || mismatch) break;
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

// ---- 5. быстрые пути ----
section('Быстрые пути');
{
  // Пропуск computeStability (structureChanged вернул false) обязан
  // оставлять в массивах ровно то, что дал бы пересчёт с нуля. Каждый
  // такой кадр пересчитываем честно и сравниваем.
  const s2 = buildScene(env);
  const orig = Sim.prototype.structureChanged;
  let skipped = 0, bad = 0;
  Sim.prototype.structureChanged = function () {
    const changed = orig.call(this);
    if (!changed) {
      skipped++;
      const st = this.stability.slice(), sc = this.sideCounter.slice();
      this._stabSigValid = false;
      this.computeStability();
      for (let i = 0; i < st.length; i++) if (st[i] !== this.stability[i] || sc[i] !== this.sideCounter[i]) { bad++; break; }
    }
    return changed;
  };
  try {
    for (let s = 0; s < 400; s++) { poke(env, s2, s); s2.step(); }
    // В сцене скелет обычно меняется "пачкой" — балка вместе с камнем,
    // масло вместе с огнём, — и забытое в подписи поле могло бы остаться
    // незамеченным. Поэтому ещё и одиночные правки: раз в три кадра ровно
    // одна, и каждая заведомо меняет устойчивость:
    //   застывшее масло на полу — связь вниз (держится) или вбок (нет);
    //   окисел металла в нижнем ряду под металлической колонной — хрупкий
    //     или нет (другая maxStability у всей колонны);
    //   балка над полом — есть или нет.
    const fz = new Sim(40, 24);
    for (let x = 0; x < 40; x++) for (let y = 20; y < 24; y++) fz.setCell(x, y, EL.STONE, false);
    const oil = 19 * fz.w + 8;
    fz.setCell(8, 19, EL.OILFILM, false);
    const oxide = 23 * fz.w + 20;
    fz.setCell(20, 23, EL.METAL_OXIDE, false);
    for (let y = 8; y < 23; y++) fz.setCell(20, y, EL.METAL, false);
    // Балка — на конце бокового вылета из камня: там её устойчивость
    // зависит от стойкости материала (над самой опорой — нет: вверх
    // устойчивость передаётся как есть).
    for (let y = 10; y < 20; y++) fz.setCell(30, y, EL.STONE, false);
    for (let x = 31; x <= 33; x++) fz.setCell(x, 10, EL.STONE, false);
    const beamAt = 10 * fz.w + 34;
    for (let s = 0; s < 300; s++) {
      const edit = s % 9;
      // Прямая запись в поля клетки обязана помечать кусок (markDirty) —
      // иначе подпись скелета эту клетку не перепроверит (см. structureChanged).
      if (edit === 0) { fz.extra[oil] = fz.extra[oil] === 2 ? 1 : 2; fz.markDirty(oil); }
      if (edit === 3) { fz.extra[oxide] = fz.extra[oxide] === 6 ? 2 : 6; fz.markDirty(oxide); }
      // Балка: то нет, то каменная, то металлическая — меняется и само
      // наличие, и материал (он тоже в подписи).
      if (edit === 6) { fz.beam[beamAt] = fz.beam[beamAt] === 0 ? EL.STONE : fz.beam[beamAt] === EL.STONE ? EL.METAL : 0; fz.markDirty(beamAt); }
      fz.step();
    }
  } finally {
    Sim.prototype.structureChanged = orig;
  }
  if (bad) fail(`пропуск пересчёта устойчивости разошёлся с пересчётом в ${bad} кадрах из ${skipped}: в подписи structureChanged не хватает поля, которое читает computeStability`);
  if (!skipped) fail('пересчёт устойчивости ни разу не пропущен — проверка ничего не проверила');

  // windHypot повторяет Math.hypot побитно (см. wind.js).
  const windHypot = env.get('windHypot');
  const f32 = new Float32Array(2);
  let diff = 0;
  for (let k = 0; k < 200000; k++) {
    f32[0] = (Math.random() - 0.5) * Math.pow(10, Math.random() * 8 - 6);
    f32[1] = k % 5 === 0 ? 0 : (Math.random() - 0.5) * Math.pow(10, Math.random() * 8 - 6);
    const a = f32[0] - f32[1] * 0.3, b = f32[1];
    if (!Object.is(windHypot(a, b), Math.hypot(a, b))) diff++;
  }
  if (diff) fail(`windHypot разошёлся с Math.hypot на ${diff} входах из 200000`);
}

// ---- 6. замер ----
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
