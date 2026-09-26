'use strict';

// Прицельные проверки отдельных механик:  node tools/mechanics.js
//
// В отличие от compare.js (побайтно то же, что было) и check.js (ничего
// не сломано вообще), здесь проверяется, что механика делает то, что
// задумано: маленькая сцена под одно правило и утверждение о результате.
// Каждое правило записано просьбой пользователя — при намеренной смене
// поведения правится и проверка.
//
// Код выхода 1 — если хоть одна проверка не прошла.

const H = require('./harness');
const env = H.loadSim({ seed: 11 });
const g = (n) => env.get(n);
const Sim = g('Sim'), EL = g('EL'), solGet = g('solGet');
// Виды долей — это id элементов (см. data/composition.js); P_VOID —
// пустота. Стенд видит только первое имя в строке объявления, поэтому
// берём их из EL.
const P_VOID = 0;
const P_WATER_ = EL.WATER, P_SALT_ = EL.BLACK_SALT;
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) fails++; };
const box = (sim, x0, y0, x1, y1, id) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) sim.setCell(x, y, id, false); };
const count = (sim, id) => { let n = 0; for (let i = 0; i < sim.type.length; i++) if (sim.type[i] === id) n++; return n; };
const lowest = (sim, id) => { let m = -1; for (let i = 0; i < sim.type.length; i++) if (sim.type[i] === id) m = Math.max(m, (i / sim.w) | 0); return m; };

console.log('1. Замёрзшие кислота и реагент падают');
for (const id of [EL.ACID_ICE, EL.REAGENT_ICE]) {
  const s = new Sim(40, 40);
  box(s, 0, 36, 39, 39, EL.STONE);
  box(s, 10, 5, 14, 8, id);
  const n0 = count(s, id);
  for (let k = 0; k < 80; k++) s.step();
  ok(lowest(s, id) === 35, `${id === EL.ACID_ICE ? 'кислота' : 'реагент'}: нижний ряд ${lowest(s, id)} (пол на 36), клеток ${count(s, id)} из ${n0}`);
}

console.log('2. Отмена откатывает ветер');
{
  const s = new Sim(60, 40);
  const snap = s.snapshot();
  s.applyPressureBrush(30, 20, 8, 8, 1);
  for (let k = 0; k < 5; k++) s.step();
  let before = 0; for (let k = 0; k < s.windVX.length; k++) before += Math.abs(s.windVX[k]) + Math.abs(s.windVY[k]);
  s.restore(snap);
  let after = 0; for (let k = 0; k < s.windVX.length; k++) after += Math.abs(s.windVX[k]) + Math.abs(s.windVY[k]) + Math.abs(s.windVXFrame[k]);
  ok(before > 0 && after === 0, `ветер до отмены ${before.toFixed(2)}, после ${after}`);
}

console.log('3. Кислотный остаток плавится в лаву');
{
  const s = new Sim(20, 20);
  box(s, 0, 16, 19, 19, EL.STONE);
  box(s, 5, 14, 9, 15, EL.ACID_RESIDUE);
  for (let i = 0; i < s.type.length; i++) if (s.type[i] === EL.ACID_RESIDUE) s.temp[i] = 400;
  for (let k = 0; k < 200; k++) { for (let i = 0; i < s.type.length; i++) if (s.type[i] === EL.ACID_RESIDUE) s.temp[i] = 400; s.step(); }
  ok(count(s, EL.ACID_RESIDUE) === 0 && count(s, EL.LAVA) > 0, `остатка ${count(s, EL.ACID_RESIDUE)}, лавы ${count(s, EL.LAVA)}`);
}

console.log('4. Окисел камня плавится с газом реагента по стадии');
for (const stage of [1, 2, 3]) {
  const s = new Sim(20, 30);
  box(s, 0, 26, 19, 29, EL.STONE);
  const i = 25 * 20 + 10;
  s.setCell(10, 25, EL.STONE, false);
  s.setOxideStage(i, stage);
  let gas = null;
  const orig = Sim.prototype.placeGas;
  Sim.prototype.placeGas = function (t, comp, life, hot) { gas = comp; return orig.call(this, t, comp, life, hot); };
  for (let k = 0; k < 400 && s.type[i] !== EL.LAVA; k++) { s.temp[i] = 400; s.step(); }
  Sim.prototype.placeGas = orig;
  ok(s.type[i] === EL.LAVA && gas !== null && solGet(gas, EL.REAGENT_GAS) === stage && solGet(gas, P_VOID) === 10 - stage,
    `стадия ${stage}: клетка ${s.type[i] === EL.LAVA ? 'лава' : s.type[i]}, газ: газ реагента ${gas && solGet(gas, EL.REAGENT_GAS)}, пустота ${gas && solGet(gas, P_VOID)}`);
}

console.log('5. Ржавчина плавится как железо, без газа');
for (const stage of [3, 7]) {
  const s = new Sim(20, 30);
  box(s, 0, 26, 19, 29, EL.STONE);
  const i = 25 * 20 + 10;
  s.setCell(10, 25, EL.METAL, false);
  s.setOxideStage(i, stage);
  let gas = 0;
  const orig = Sim.prototype.placeGas;
  Sim.prototype.placeGas = function (...a) { gas++; return orig.apply(this, a); };
  let steps = 0;
  for (; steps < 2000 && s.type[i] !== EL.LAVA; steps++) { s.temp[i] = 400; s.step(); }
  Sim.prototype.placeGas = orig;
  ok(s.type[i] === EL.LAVA && gas === 0, `стадия ${stage}: ${s.type[i] === EL.LAVA ? 'лава' : 'тип ' + s.type[i]} через ${steps} кадров, газов ${gas}`);
}

console.log('6. Ржавчина окисляет соседей по стадиям');
{
  // Металлическая плита на полу, ржавчина нужной стадии в середине.
  const run = (stage) => {
    const s = new Sim(30, 20);
    box(s, 0, 16, 29, 19, EL.STONE);
    box(s, 5, 10, 24, 15, EL.METAL);
    const c = 12 * 30 + 15;
    s.setOxideStage(c, stage);
    for (let k = 0; k < 3000; k++) s.step();
    const st = [];
    for (let y = 10; y <= 15; y++) for (let x = 5; x <= 24; x++) st.push(s.oxideStage(y * 30 + x));
    return { s, c, st, self: s.oxideStage(c), rusted: st.filter((v) => v > 0).length, max: Math.max(...st) };
  };
  for (const stage of [1, 2, 3]) {
    const r = run(stage);
    ok(r.rusted === 1 && r.self === stage, `стадия ${stage}: не расползается (ржавых клеток ${r.rusted}, сама ${r.self})`);
  }
  for (const stage of [4, 5]) {
    const r = run(stage);
    const neighbours = [r.c - 1, r.c + 1, r.c - 30, r.c + 30].map((j) => r.s.oxideStage(j));
    ok(r.self === 3 && neighbours.every((v) => v <= 2), `стадия ${stage}: сама стала ${r.self}, соседи ${neighbours.join(',')} (не выше 2), всего ржавых ${r.rusted}`);
  }
  for (const stage of [6, 7]) {
    const r = run(stage);
    ok(r.rusted > 1 && r.max <= stage, `стадия ${stage}: расползлась как окисел камня, ржавых ${r.rusted}, стадии ${[...new Set(r.st.filter((v) => v > 0))].sort().join(',')}`);
  }
}

console.log('7. Ржавчина отслаивается в окисляющую жидкость');
{
  const s = new Sim(40, 30);
  box(s, 0, 26, 39, 29, EL.STONE);
  box(s, 0, 16, 1, 25, EL.WALL); box(s, 38, 16, 39, 25, EL.WALL);
  box(s, 2, 20, 37, 25, EL.METAL);
  box(s, 2, 12, 37, 19, EL.REAGENT);
  let flakes = 0;
  const orig = Sim.prototype.rustFlake;
  Sim.prototype.rustFlake = function (a, b) { const r = orig.call(this, a, b); if (r) flakes++; return r; };
  for (let k = 0; k < 3000; k++) s.step();
  Sim.prototype.rustFlake = orig;
  // Отслоившаяся ржавчина оказывается там, где была жидкость (выше металла), либо тонет в ней.
  let inLiquid = 0;
  for (let y = 0; y < 20; y++) for (let x = 2; x < 38; x++) { const t = s.type[y * 40 + x]; if (t === EL.METAL_OXIDE || t === EL.METAL_OXIDE_LOOSE) inLiquid++; }
  ok(flakes > 0, `отслоений ${flakes}, ржавчины выше исходной поверхности металла ${inLiquid}`);
}

console.log('8. Балка: весь пролёт без опоры рушится разом; вылет ограничен стойкостью');
{
  const s = new Sim(80, 40);
  box(s, 0, 36, 79, 39, EL.STONE);
  box(s, 5, 20, 7, 35, EL.STONE);           // левая колонна
  box(s, 50, 20, 52, 35, EL.STONE);         // правая колонна
  for (let x = 8; x <= 49; x++) s.setCell(x, 20, EL.BEAM, false);
  for (let k = 0; k < 5; k++) s.step();
  const beams = () => { let n = 0; for (let i = 0; i < s.beam.length; i++) if (s.beam[i]) n++; return n; };
  const b0 = beams();
  // Обе колонны убраны — пролёт висит в воздухе.
  box(s, 5, 20, 7, 35, EL.EMPTY);
  box(s, 50, 20, 52, 35, EL.EMPTY);
  s.step();
  const b1 = beams();
  let stones = 0; for (let x = 8; x <= 49; x++) { const t = s.type[21 * 80 + x]; const t0 = s.type[20 * 80 + x]; if (t === EL.STONE || t0 === EL.STONE) stones++; }
  // Мост длиннее двух вылетов (2 x 19) держится только у колонн: середина
  // сразу осыпается — так что балок меньше 42.
  ok(b0 > 0 && b0 < 42 && b1 === 0, `балок было ${b0}, через один кадр без опоры ${b1}; камней на месте пролёта ${stones}`);
  for (let k = 0; k < 60; k++) s.step();
  ok(lowest(s, EL.STONE) === 39 && count(s, EL.STONE) >= 80 * 4 + 40, `камень от балки упал на пол (камней всего ${count(s, EL.STONE)})`);

  // Консоль от одной колонны: держится не дальше, чем позволяет стойкость.
  const c = new Sim(80, 40);
  box(c, 0, 36, 79, 39, EL.STONE);
  box(c, 5, 20, 7, 35, EL.STONE);
  for (let x = 8; x <= 60; x++) c.setCell(x, 20, EL.BEAM, false);
  // Для сравнения — такая же консоль из камня.
  box(c, 5, 5, 7, 35, EL.STONE);
  for (let x = 8; x <= 60; x++) c.setCell(x, 5, EL.STONE, false);
  c.step();
  let beamReach = 0; for (let x = 8; x <= 60; x++) if (c.beam[20 * 80 + x]) beamReach = x - 7;
  c.stability.fill(0); c._stabSigValid = false; c.computeStability();
  let stoneReach = 0; for (let x = 8; x <= 60; x++) if (c.stability[5 * 80 + x] > 0) stoneReach = x - 7;
  ok(beamReach > 0 && beamReach < 53 && beamReach === stoneReach, `вылет балки ${beamReach} клеток, вылет камня ${stoneReach}`);
}

const rusty = (s) => count(s, EL.METAL_OXIDE) + count(s, EL.METAL_OXIDE_LOOSE);

console.log('9. Сталь: вода не берёт, ржавчина и кислота — берут; плавится на 50° позже металла');
{
  // Лужа воды на стальной и на металлической плите.
  for (const base of [EL.STEEL, EL.METAL]) {
    const s = new Sim(40, 30);
    box(s, 0, 26, 39, 29, EL.STONE);
    box(s, 0, 14, 1, 25, EL.WALL); box(s, 38, 14, 39, 25, EL.WALL);
    box(s, 2, 22, 37, 25, base);
    box(s, 2, 16, 37, 21, EL.WATER);
    for (let k = 0; k < 3000; k++) s.step();
    const name = base === EL.STEEL ? 'сталь' : 'металл';
    ok(base === EL.STEEL ? rusty(s) === 0 : rusty(s) > 0, `${name} под водой 3000 кадров: ржавых клеток ${rusty(s)}`);
  }
  // Ржавчина 6-й стадии, коснувшаяся стальной плиты, заражает её.
  {
    const s = new Sim(30, 20);
    box(s, 0, 16, 29, 19, EL.STONE);
    box(s, 5, 10, 24, 15, EL.STEEL);
    s.setCell(15, 12, EL.METAL, false);
    s.setOxideStage(12 * 30 + 15, 6);
    for (let k = 0; k < 3000; k++) s.step();
    ok(count(s, EL.STEEL) < 20 * 6 - 1 && rusty(s) > 1, `ржавчина в стали: ржавых ${rusty(s)}, стали осталось ${count(s, EL.STEEL)} из ${20 * 6 - 1}`);
  }
  // Кислота окисляет сталь.
  {
    const s = new Sim(40, 30);
    box(s, 0, 26, 39, 29, EL.STONE);
    box(s, 0, 14, 1, 25, EL.WALL); box(s, 38, 14, 39, 25, EL.WALL);
    box(s, 2, 22, 37, 25, EL.STEEL);
    box(s, 2, 18, 37, 21, EL.ACID);
    for (let k = 0; k < 600; k++) s.step();
    ok(rusty(s) > 0, `кислота на стали: ржавых ${rusty(s)}`);
  }
  // Точка плавления.
  const E = g('ELEMENTS');
  ok(E[EL.STEEL].meltPoint === E[EL.METAL].meltPoint + 50 && E[EL.STEEL].toughness > E[EL.METAL].toughness,
    `плавление стали ${E[EL.STEEL].meltPoint}° (металл ${E[EL.METAL].meltPoint}°), стойкость ${E[EL.STEEL].toughness} (металл ${E[EL.METAL].toughness})`);
}

console.log('10. Балка из материала');
{
  // Материал — от клетки, с которой начали вести.
  // Колонна металла стоит прямо на низу поля: устойчивость передаётся
  // вверх от опоры, и на каменном полу колонна держала бы как камень.
  const s = new Sim(80, 40);
  box(s, 0, 36, 79, 39, EL.STONE);
  box(s, 5, 20, 7, 39, EL.METAL);
  s.pickBeamMaterial(6, 25);
  for (let x = 8; x <= 70; x++) s.setCell(x, 20, EL.BEAM, false);
  s.step();
  let reach = 0; for (let x = 8; x <= 70; x++) if (s.beam[20 * 80 + x]) reach = x - 7;
  const E = g('ELEMENTS');
  const expected = E[EL.METAL].maxStability * E[EL.METAL].toughness - 1;
  ok(s.beam[20 * 80 + 8] === EL.METAL && reach === expected, `проведена от металла: материал ${E[s.beam[20 * 80 + 8]].name}, вылет ${reach} (у металла ${expected})`);
  // Без опоры рушится своим материалом.
  box(s, 5, 20, 7, 39, EL.EMPTY);
  const metal0 = count(s, EL.METAL);
  s.step();
  ok(count(s, EL.METAL) === metal0 + reach, `без опоры металлическая балка стала металлом: +${count(s, EL.METAL) - metal0} клеток`);

  // В твёрдое не ставится, в жидкость — ставится.
  const p = new Sim(20, 20);
  p.setCell(5, 5, EL.STONE, false);
  p.setCell(6, 5, EL.SAND, false);
  p.setCell(7, 5, EL.WATER, false);
  for (const x of [5, 6, 7]) p.setCell(x, 5, EL.BEAM, false);
  ok(!p.beam[5 * 20 + 5] && !p.beam[5 * 20 + 6] && p.beam[5 * 20 + 7] === EL.STONE, 'в камень и песок балка не ставится, в воду — ставится (каменная по умолчанию)');
}

console.log('11. Жидкость в клетке балки действует на её материал');
{
  // Каменный мост на двух колоннах, сверху кислота/реагент, металлический — под водой.
  const run = (mat, liquid, frames) => {
    const s = new Sim(40, 40);
    box(s, 0, 36, 39, 39, EL.STONE);
    box(s, 0, 10, 1, 35, EL.WALL); box(s, 38, 10, 39, 35, EL.WALL);
    box(s, 2, 30, 37, 35, mat);
    s.pickBeamMaterial(3, 32);
    for (let y = 20; y <= 29; y++) for (let x = 2; x <= 37; x++) s.setCell(x, y, EL.BEAM, false);
    box(s, 2, 20, 37, 29, liquid);
    const beams = () => { let n = 0; for (let i = 0; i < s.beam.length; i++) if (s.beam[i]) n++; return n; };
    const oxidised = () => { let n = 0; for (let i = 0; i < s.beam.length; i++) if (s.beam[i] && IS_OXIDE_T(s.beam[i])) n++; return n; };
    const b0 = beams();
    for (let k = 0; k < frames; k++) s.step();
    return { b0, b1: beams(), ox: oxidised() };
  };
  const IS_OXIDE_T = (id) => id === EL.OXIDE || id === EL.METAL_OXIDE;
  const acid = run(EL.STONE, EL.ACID, 400);
  ok(acid.b1 < acid.b0, `кислота на каменной балке: балок было ${acid.b0}, стало ${acid.b1}`);
  // Окисленная до последней стадии балка рассыпается, поэтому к концу
  // прогона окисленных может и не остаться — считаем сами акты окисления.
  let oxEvents = 0;
  const origOx = Sim.prototype.oxidiseBeam;
  Sim.prototype.oxidiseBeam = function (...a) { oxEvents++; return origOx.apply(this, a); };
  const reagent = run(EL.STONE, EL.REAGENT, 1500);
  Sim.prototype.oxidiseBeam = origOx;
  ok(oxEvents > 0, `реагент на каменной балке: окислений ${oxEvents}, балок было ${reagent.b0}, осталось ${reagent.b1}`);
  const water = run(EL.METAL, EL.WATER, 4000);
  ok(water.ox > 0, `вода на металлической балке: окисленных балок ${water.ox}`);
  const steel = run(EL.STEEL, EL.WATER, 4000);
  ok(steel.ox === 0 && steel.b1 === steel.b0, `вода на стальной балке: окисленных ${steel.ox}, балок ${steel.b1} из ${steel.b0}`);
}

console.log('12. Старое сохранение: маски балок становятся каменными балками');
{
  const s = new Sim(10, 10);
  s.beam[55] = 5;   // так выглядела маска опор в версии 1
  const save = s.serialize();
  save.v = 1;
  const t = new Sim(10, 10);
  t.deserialize(JSON.parse(JSON.stringify(save)));
  ok(t.beam[55] === EL.STONE, `маска 5 из версии 1 → материал ${t.beam[55]} (камень ${EL.STONE})`);
}

console.log('13. Чёрные соли');
{
  const parts = (s, k) => { let n = 0; for (let i = 0; i < s.type.length; i++) if (s.type[i] && g('hasComposition')(s.type[i])) n += solGet(s.comp(i), k); return n; };
  // Вода над металлом: ржавея, отдаёт долю воды в соли, объём лужи не убывает.
  {
    const s = new Sim(40, 30);
    box(s, 0, 26, 39, 29, EL.STONE);
    box(s, 0, 14, 1, 25, EL.WALL); box(s, 38, 14, 39, 25, EL.WALL);
    box(s, 2, 22, 37, 25, EL.METAL);
    box(s, 2, 16, 37, 21, EL.WATER);
    const w0 = parts(s, P_WATER_);
    for (let k = 0; k < 3000; k++) s.step();
    const w1 = parts(s, P_WATER_), salt = parts(s, P_SALT_);
    ok(salt > 0 && w0 - w1 === salt, `вода над металлом: солей ${salt} долей, воды убыло ${w0 - w1} — ровно столько же (объём цел), ржавых клеток ${rusty(s)}`);
  }
  // Граница: твёрдых долей не меньше, чем жидких, — сыпучее; иначе раствор.
  {
    const s = new Sim(10, 10);
    const solWith = g('solWith');
    const mk = (salt, water) => solWith(solWith(0, P_SALT_, salt), P_WATER_, water);
    s.setComposition(11, mk(5, 5));
    s.setComposition(12, mk(4, 6));
    s.setComposition(13, mk(3, 0));  // 3 соли и 7 пустоты — чистая соль
    ok(s.type[11] === EL.BLACK_SALT && s.type[12] === EL.SOLUTION && s.type[13] === EL.BLACK_SALT,
      `5 соли + 5 воды → ${g('ELEMENTS')[s.type[11]].name} (поровну — твёрдое), 4 + 6 → ${g('ELEMENTS')[s.type[12]].name}, 3 соли + пустота → ${g('ELEMENTS')[s.type[13]].name}`);
  }
  // Пересыщенный раствор расслаивается: сыпучий осадок внизу, жидкость сверху.
  {
    const s = new Sim(24, 30);
    box(s, 0, 26, 23, 29, EL.STONE);
    box(s, 0, 6, 1, 25, EL.WALL); box(s, 22, 6, 23, 25, EL.WALL);
    box(s, 2, 16, 21, 25, EL.BLACK_SALT);   // 200 клеток соли
    box(s, 2, 8, 21, 15, EL.WATER);         // 160 клеток воды сверху
    for (let k = 0; k < 800; k++) s.step();
    let saltLow = 0, saltHigh = 0, liquidLow = 0, liquidHigh = 0;
    for (let y = 6; y <= 25; y++) for (let x = 2; x <= 21; x++) {
      const t = s.type[y * 24 + x];
      const low = y >= 18;
      if (t === EL.BLACK_SALT) { if (low) saltLow++; else saltHigh++; }
      else if (t === EL.SOLUTION || t === EL.WATER) { if (low) liquidLow++; else liquidHigh++; }
    }
    ok(saltLow > saltHigh && liquidHigh > liquidLow, `осадок внизу: соли низ/верх ${saltLow}/${saltHigh}, жидкости низ/верх ${liquidLow}/${liquidHigh}`);
    ok(parts(s, P_SALT_) === 2000, `соль не пропадает: ${parts(s, P_SALT_)} долей из 2000`);
  }
  // Кипячение: вода уходит паром, соль остаётся.
  {
    const s = new Sim(20, 20);
    box(s, 0, 16, 19, 19, EL.STONE);
    const solWith = g('solWith');
    s.setCell(10, 15, EL.WATER, false);
    s.setComposition(15 * 20 + 10, solWith(solWith(0, P_SALT_, 3), P_WATER_, 7), false);
    // 180°: вода кипит (100°), а высохшая соль ещё не рвётся (SALT_IGNITE_TEMP).
    for (let k = 0; k < 300; k++) { s.temp[15 * 20 + 10] = 180; s.step(); }
    const i = 15 * 20 + 10;
    ok(s.type[i] === EL.BLACK_SALT && solGet(s.comp(i), P_SALT_) === 3 && solGet(s.comp(i), P_WATER_) === 0,
      `раствор (3 соли, 7 воды) при 180°: осталось ${g('ELEMENTS')[s.type[i]] ? g('ELEMENTS')[s.type[i]].name : s.type[i]}, соли ${solGet(s.comp(i), P_SALT_)}, воды ${solGet(s.comp(i), P_WATER_)}`);
  }
  // Цвет: к 5 долям соли — ровно цвет ржавчины, к 10 — чёрный.
  {
    const solColor = g('solColor'), solWith = g('solWith');
    const rust = g('SALT_RUST_COLOR'), black = g('SALT_BLACK_COLOR');
    const c5 = solColor(solWith(solWith(0, P_SALT_, 5), P_WATER_, 5));
    const c10 = solColor(solWith(0, P_SALT_, 10));
    const c2 = solColor(solWith(solWith(0, P_SALT_, 2), P_WATER_, 8));
    const same = (a, b) => a.every((v, k) => Math.abs(v - b[k]) < 1e-9);
    ok(same(c5, rust) && same(c10, black) && !same(c2, rust),
      `5 соли + 5 воды → ${c5.map(Math.round)} (ржавчина ${rust}), 10 соли → ${c10.map(Math.round)}, 2 соли → ${c2.map(Math.round)}`);
  }
  // Солёная вода ржавит сталь, чистая — нет.
  {
    const run = (salty) => {
      const s = new Sim(40, 30);
      box(s, 0, 26, 39, 29, EL.STONE);
      box(s, 0, 14, 1, 25, EL.WALL); box(s, 38, 14, 39, 25, EL.WALL);
      box(s, 2, 22, 37, 25, EL.STEEL);
      box(s, 2, 16, 37, 21, EL.WATER);
      if (salty) {
        const solWith = g('solWith');
        for (let y = 16; y <= 21; y++) for (let x = 2; x <= 37; x++) s.setComposition(y * 40 + x, solWith(solWith(0, P_SALT_, 2), P_WATER_, 8), false);
      }
      for (let k = 0; k < 3000; k++) s.step();
      return rusty(s);
    };
    const plain = run(false), salty = run(true);
    ok(plain === 0 && salty > 0, `сталь под чистой водой: ржавых ${plain}, под водой с солями: ${salty}`);
  }
}

console.log('14. Взрыв сухих чёрных солей');
{
  // Каменный массив, в нём ниша с сухой солью; поджигаем огнём сверху.
  const make = (wet) => {
    const s = new Sim(80, 60);
    box(s, 0, 20, 79, 59, EL.STONE);
    box(s, 36, 30, 43, 37, EL.BLACK_SALT);
    box(s, 36, 26, 43, 29, EL.EMPTY);           // шахта к нише
    if (wet) {
      const solWith = g('solWith');
      for (let y = 30; y <= 37; y++) for (let x = 36; x <= 43; x++) s.setComposition(y * 80 + x, solWith(solWith(0, P_SALT_, 7), P_WATER_, 3), false);
    }
    return s;
  };
  const stone = (s) => count(s, EL.STONE);
  const dry = make(false);
  const stone0 = stone(dry), salt0 = count(dry, EL.BLACK_SALT);
  let cracks = 0;
  const orig = Sim.prototype.crackFrom;
  Sim.prototype.crackFrom = function (...a) { cracks++; return orig.apply(this, a); };
  dry.stampBrush(40, 28, 'circle', 1, 1, EL.FIRE, false);
  for (let k = 0; k < 5; k++) dry.step();
  Sim.prototype.crackFrom = orig;
  ok(count(dry, EL.BLACK_SALT) === 0 && stone(dry) < stone0 - 60 && cracks >= 3,
    `сухая: соли ${salt0} → ${count(dry, EL.BLACK_SALT)}, камня разрушено ${stone0 - stone(dry)}, трещин ${cracks}`);
  // Трещины уходят за воронку: пустые клетки дальше радиуса взрыва.
  let beyond = 0;
  const R = Math.min(g('BLAST_MAX_R'), g('BLAST_BASE_R') + Math.sqrt(salt0 * 10) * g('BLAST_R_PER_SQRT'));
  for (let y = 20; y < 60; y++) for (let x = 0; x < 80; x++) {
    if (Math.hypot(x - 39.5, y - 33.5) > R + 1 && dry.type[y * 80 + x] === EL.EMPTY && !(x >= 36 && x <= 43 && y < 30)) beyond++;
  }
  ok(beyond > 0, `трещины за воронкой (радиус ${R.toFixed(1)}): пустых клеток в камне дальше неё ${beyond}`);

  const wet = make(true);
  const wet0 = count(wet, EL.BLACK_SALT);
  wet.stampBrush(40, 28, 'circle', 1, 1, EL.FIRE, false);
  for (let k = 0; k < 5; k++) wet.step();
  ok(count(wet, EL.BLACK_SALT) > wet0 * 0.8 && stone(wet) === stone0, `мокрая (7 соли, 3 воды): соли ${wet0} → ${count(wet, EL.BLACK_SALT)}, камень цел: ${stone(wet) === stone0}`);
}

console.log('15. Состав у каждой клетки: правила фаз');
{
  const solWith = g('solWith'), solPure = g('solPure'), ELEMENTS = g('ELEMENTS');
  const mix = (...pairs) => { let c = 0; for (let k = 0; k < pairs.length; k += 2) c = solWith(c, pairs[k], pairs[k + 1]); return c; };
  const kindOf = (c, cur = EL.EMPTY) => { const s = new Sim(1, 1); s.type[0] = cur; s.setComposition(0, c); return s.type[0]; };
  const name = (id) => (ELEMENTS[id] ? ELEMENTS[id].name : id);
  const cases = [
    [mix(EL.STEAM, 6, EL.ACID_GAS, 2), EL.VAPOR, 'пар 6 + кислотный газ 2 → смешанный газ'],
    [mix(EL.WATER, 5, EL.STONE, 5), EL.STONE, 'вода 5 + камень 5 → камень (поровну — твёрдое)'],
    [mix(EL.WATER, 6, EL.STONE, 4), EL.SOLUTION, 'вода 6 + камень 4 → раствор'],
    [mix(EL.LAVA, 7, EL.STONE, 3), EL.LAVA, 'лава 7 + камень 3 → лава'],
    [mix(EL.WATER, 3, EL.STEAM, 7), EL.WATER, 'вода 3 + пар 7 → вода (газ не в счёт, он выйдет)'],
    [mix(EL.SAND, 4, EL.STONE, 3, EL.WATER, 3), EL.SAND, 'песок 4 + камень 3 + вода 3 → песок (твёрдого больше, песка больше всех)'],
    [solPure(EL.DISSOLVER, 10), EL.DISSOLVER, 'чистый растворитель → растворитель'],
  ];
  for (const [c, want, label] of cases) ok(kindOf(c) === want, `${label}: получилось ${name(kindOf(c))}`);

  // Газ в одной клетке с жидкостью выходит рядом отдельным пикселем.
  const s = new Sim(5, 5);
  s.setCell(2, 4, EL.STONE, false);
  s.spawn(3 * 5 + 2, EL.WATER);
  s.setComposition(3 * 5 + 2, mix(EL.WATER, 7, EL.STEAM, 3));
  s.temp[3 * 5 + 2] = 20;
  s.splitGas(2, 3, 3 * 5 + 2);
  const gasCell = [...Array(25).keys()].find((i) => s.type[i] === EL.STEAM);
  ok(s.type[17] === EL.WATER && solGet(s.comp(17), EL.WATER) === 7 && gasCell !== undefined && solGet(s.comp(gasCell), EL.STEAM) === 3,
    `вода 7 + пар 3: осталось ${name(s.type[17])} ${solGet(s.comp(17), EL.WATER)}, пар отдельно: ${gasCell !== undefined ? solGet(s.comp(gasCell), EL.STEAM) + ' долей' : 'нет'}`);
}

console.log('16. Растворитель');
{
  const ELEMENTS = g('ELEMENTS'), solMatter = g('solMatter');
  // Шанс стать реагентом: растворитель в центре, камень со всех сторон,
  // по одному обмену за раз (каждый раз заново).
  let toReagent = 0, toDissolver = 0;
  for (let t = 0; t < 4000; t++) {
    const s = new Sim(3, 3);
    for (let k = 0; k < 9; k++) s.setCell(k % 3, (k / 3) | 0, EL.STONE, false);
    s.spawn(4, EL.DISSOLVER);
    s.dissolverMix(1, 1, 4);
    for (const n of [1, 3, 5, 7]) {
      if (solGet(s.comp(n), EL.REAGENT)) toReagent++;
      if (solGet(s.comp(n), EL.DISSOLVER)) toDissolver++;
    }
  }
  const share = toReagent / (toReagent + toDissolver);
  ok(share > 0.17 && share < 0.23, `доля растворителя, пришедшая реагентом: ${(share * 100).toFixed(1)}% (${toReagent} из ${toReagent + toDissolver} переносов)`);

  // Растворитель на камне: меняются долями, вещество не пропадает.
  const s = new Sim(30, 30);
  const box2 = (x0, y0, x1, y1, id) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) s.setCell(x, y, id, false); };
  box2(0, 20, 29, 29, EL.STONE);
  box2(0, 10, 1, 19, EL.WALL); box2(28, 10, 29, 19, EL.WALL);
  box2(2, 14, 27, 19, EL.DISSOLVER);
  const total = () => { let m = 0; for (let i = 0; i < s.type.length; i++) if (s.type[i]) m += solMatter(s.comp(i)); return m; };
  let quench = 0;
  const origQ = Sim.prototype.quenchReagentWater;
  Sim.prototype.quenchReagentWater = function (i) { const before = solMatter(this.comp(i)); origQ.call(this, i); if (solMatter(this.comp(i)) < before) quench += before - solMatter(this.comp(i)); };
  const m0 = total();
  for (let k = 0; k < 600; k++) s.step();
  Sim.prototype.quenchReagentWater = origQ;
  let stoneWithForeign = 0, liquidWithStone = 0, reagent = 0;
  for (let i = 0; i < s.type.length; i++) {
    const c = s.comp(i);
    if (s.type[i] === EL.STONE && c >= 1024) stoneWithForeign++;
    if (IS_LIQUID_T(s.type[i]) && solGet(c, EL.STONE)) liquidWithStone++;
    reagent += solGet(c, EL.REAGENT);
  }
  function IS_LIQUID_T(t) { return ELEMENTS[t] && ELEMENTS[t].cat === 'liquid'; }
  ok(stoneWithForeign > 0 && liquidWithStone > 0 && reagent > 0,
    `камня с примесью ${stoneWithForeign}, жидкости с камнем ${liquidWithStone}, долей реагента ${reagent}`);
  // Реагент тратит доли, окисляя камень (OXIDISE_COST) — это честная убыль;
  // кроме неё вещество сохраняется.
  const m1 = total();
  ok(m1 <= m0 && m1 >= m0 - 400, `долей вещества было ${m0}, стало ${m1} (убыль — на окисление реагентом)`);
}

console.log('16б. Растворитель: реагент только от твёрдого; фазы; безопасный лёд');
{
  const ELEMENTS = g('ELEMENTS');
  // С жидкостью (водой) — ни одной доли реагента за много обменов.
  let reagentFromLiquid = 0, transfers = 0;
  for (let t = 0; t < 2000; t++) {
    const s = new Sim(3, 3);
    for (let k = 0; k < 9; k++) s.setCell(k % 3, (k / 3) | 0, EL.WATER, false);
    s.spawn(4, EL.DISSOLVER);
    s.dissolverMix(1, 1, 4);
    for (const n of [1, 3, 5, 7]) {
      reagentFromLiquid += solGet(s.comp(n), EL.REAGENT);
      transfers += solGet(s.comp(n), EL.DISSOLVER);
    }
  }
  ok(reagentFromLiquid === 0 && transfers > 0, `обмен с водой: долей реагента ${reagentFromLiquid} на ${transfers} перенесённых долей растворителя`);

  // Кипит при 50, замерзает при -20.
  // Сам переход, без движения (вскипев, пар в том же шаге улетел бы).
  const phase = (T) => {
    const s = new Sim(5, 5);
    s.spawn(12, EL.DISSOLVER);
    for (let k = 0; k < 1000 && s.type[12] === EL.DISSOLVER; k++) { s.temp[12] = T; s.tickPhase(2, 2, 12); }
    return s.type[12];
  };
  const hot = phase(55), cold = phase(-25), warm = phase(40);
  ok(hot === EL.DISSOLVER_GAS && cold === EL.DISSOLVER_ICE && warm === EL.DISSOLVER,
    `при 55° → ${ELEMENTS[hot].name}, при -25° → ${ELEMENTS[cold].name}, при 40° → ${ELEMENTS[warm].name}`);

  // Пар растворителя меняется долями с камнем (и превращается в газ реагента).
  {
    const s = new Sim(3, 3);
    for (let k = 0; k < 9; k++) s.setCell(k % 3, (k / 3) | 0, EL.STONE, false);
    s.spawn(4, EL.DISSOLVER_GAS);
    s.temp[4] = 150;
    let mixedInto = 0, reagentGas = 0;
    for (let t = 0; t < 600; t++) {
      s.spawn(4, EL.DISSOLVER_GAS); s.temp[4] = 150;
      for (const n of [1, 3, 5, 7]) s.spawn(n, EL.STONE);
      s.reactVapor(1, 1, 4);
      for (const n of [1, 3, 5, 7]) { if (solGet(s.comp(n), EL.DISSOLVER_GAS)) mixedInto++; if (solGet(s.comp(n), EL.REAGENT_GAS)) reagentGas++; }
    }
    ok(mixedInto > 0 && reagentGas > 0, `пар растворителя у камня: переносов пара ${mixedInto}, стало газом реагента ${reagentGas}`);
  }

  // Замёрзший растворитель безопасен: камень вокруг за 600 кадров не тронут.
  {
    const s = new Sim(9, 9);
    for (let k = 0; k < 81; k++) s.setCell(k % 9, (k / 9) | 0, EL.STONE, false);
    s.spawn(40, EL.DISSOLVER_ICE);
    for (let k = 0; k < 81; k++) s.temp[k] = -60;
    for (let t = 0; t < 600; t++) { for (let k = 0; k < 81; k++) s.temp[k] = -60; s.step(); }
    let foreign = 0;
    for (let k = 0; k < 81; k++) if (k !== 40 && s.comp(k) >= 1024) foreign++;
    ok(s.type[40] === EL.DISSOLVER_ICE && foreign === 0, `лёд растворителя среди камня: остался ${ELEMENTS[s.type[40]].name}, клеток камня с примесью ${foreign}`);
  }
}

console.log('17. Свойства по доле: слабая кислота ест медленнее');
{
  const solWith = g('solWith');
  const run = (acid) => {
    const s = new Sim(40, 30);
    const box2 = (x0, y0, x1, y1, id) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) s.setCell(x, y, id, false); };
    box2(0, 18, 39, 29, EL.STONE);
    box2(0, 8, 1, 17, EL.WALL); box2(38, 8, 39, 17, EL.WALL);
    box2(2, 12, 37, 17, EL.WATER);
    for (let y = 12; y <= 17; y++) for (let x = 2; x <= 37; x++) s.setComposition(y * 40 + x, solWith(solWith(0, EL.ACID, acid), EL.WATER, 10 - acid));
    const stone0 = count(s, EL.STONE);
    for (let k = 0; k < 150; k++) s.step();
    return stone0 - count(s, EL.STONE);
  };
  const strong = run(10), weak = run(1);
  ok(strong > weak * 3, `чистая кислота съела ${strong} клеток камня, кислота 1 из 10 — ${weak}`);
}

console.log('18. Старое сохранение: состав прежнего формата');
{
  const s = new Sim(6, 6);
  s.setCell(1, 1, EL.WATER, false);
  s.setCell(2, 1, EL.STEAM, false);
  s.setCell(3, 1, EL.STONE, false);
  const save = s.serialize();
  delete save.solLo; delete save.solHi;
  // Прежний sol32: 4 бита на вид, виды 1 вода .. 6 соль; у воды — 7 воды и 3 кислоты, у пара — 10 воды.
  const old = new Uint32Array(36);
  old[7] = (7 << 4) | (3 << 8);
  old[8] = (10 << 4);
  save.sol32 = Buffer.from(old.buffer).toString('base64');
  save.v = 2;
  const t = new Sim(6, 6);
  t.deserialize(JSON.parse(JSON.stringify(save)));
  const ELEMENTS = g('ELEMENTS');
  ok(t.type[7] === EL.SOLUTION && solGet(t.comp(7), EL.WATER) === 7 && solGet(t.comp(7), EL.ACID) === 3
    && t.type[8] === EL.STEAM && solGet(t.comp(8), EL.STEAM) === 10 && solGet(t.comp(9), EL.STONE) === 10,
    `вода+кислота → ${ELEMENTS[t.type[7]].name} (${solGet(t.comp(7), EL.WATER)}/${solGet(t.comp(7), EL.ACID)}), пар → ${ELEMENTS[t.type[8]].name} (${solGet(t.comp(8), EL.STEAM)}), камень → ${solGet(t.comp(9), EL.STONE)} долей камня`);
}

console.log(fails ? `\nПРОВАЛОВ: ${fails}` : '\nВСЁ OK');
process.exit(fails ? 1 : 0);
