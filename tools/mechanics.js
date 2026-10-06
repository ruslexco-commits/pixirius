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
const IS_LIQ = (sim, i) => g('IS_LIQUID')[sim.type[i]] === 1;
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
  box(s, 0, 26, 19, 29, EL.WALL);   // стена: камень пола принял бы стадию окисла и сам расплавился бы
  const i = 25 * 20 + 10;
  s.setCell(10, 25, EL.STONE, false);
  s.setOxideStage(i, stage);
  // Первый газ — от самой клетки (дальше окисел, успевший прорасти в пол,
  // плавится со своим). Клетка могла стать лавой и в том же кадре утечь.
  let gas = null, melted = false;
  const orig = Sim.prototype.placeGas;
  Sim.prototype.placeGas = function (t, comp, life, hot) { if (gas === null) gas = comp; return orig.call(this, t, comp, life, hot); };
  for (let k = 0; k < 400 && gas === null; k++) { s.temp[i] = 400; s.step(); }
  Sim.prototype.placeGas = orig;
  melted = s.type[i] !== EL.OXIDE && s.type[i] !== EL.OXIDE_LOOSE;
  ok(melted && gas !== null && solGet(gas, EL.REAGENT_GAS) === stage && solGet(gas, P_VOID) === 10 - stage,
    `стадия ${stage}: расплавилась — ${melted ? 'да' : 'нет'}, газ: газ реагента ${gas && solGet(gas, EL.REAGENT_GAS)}, пустота ${gas && solGet(gas, P_VOID)}`);
}

console.log('5. Ржавчина плавится как железо (в расплавленный металл), без газа');
for (const stage of [3, 7]) {
  const s = new Sim(20, 30);
  box(s, 0, 26, 19, 29, EL.WALL);   // стена: камень пола принял бы стадию окисла и сам расплавился бы
  const i = 25 * 20 + 10;
  s.setCell(10, 25, EL.METAL, false);
  s.setOxideStage(i, stage);
  let gas = 0;
  const orig = Sim.prototype.placeGas;
  Sim.prototype.placeGas = function (...a) { gas++; return orig.apply(this, a); };
  let steps = 0, molten = false;
  for (; steps < 2000 && !molten; steps++) { s.temp[i] = 400; s.step(); molten = count(s, EL.MOLTEN_METAL) > 0; }
  Sim.prototype.placeGas = orig;
  ok(molten && count(s, EL.LAVA) === 0 && gas === 0, `стадия ${stage}: расплавленный металл через ${steps} кадров, лавы ${count(s, EL.LAVA)}, газов ${gas}`);
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

console.log('8. Балка: держится, пока касается вещества; пролёт ни к чему не прикасающийся рушится разом; держит в пределах стойкости');
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
  // Мост длиннее двух вылетов (2 x 19): середина без устойчивости, но
  // балка остаётся балкой, пока её группа касается колонн (просьба
  // пользователя: осыпается, только когда ни к чему не прикасается).
  ok(b0 === 42 && b1 === 0, `балок было ${b0} (весь мост), через один кадр без колонн ${b1}; камней на месте пролёта ${stones}`);
  for (let k = 0; k < 60; k++) s.step();
  ok(lowest(s, EL.STONE) === 39 && count(s, EL.STONE) >= 80 * 4 + 40, `камень от балки упал на пол (камней всего ${count(s, EL.STONE)})`);

  // Консоль от одной колонны остаётся балкой целиком, но держит (её
  // устойчивость больше нуля) не дальше, чем позволяет стойкость, — как
  // консоль из камня; камень, положенный на её дальний конец, проваливается.
  const c = new Sim(80, 40);
  box(c, 0, 36, 79, 39, EL.STONE);
  box(c, 5, 20, 7, 35, EL.STONE);
  for (let x = 8; x <= 60; x++) c.setCell(x, 20, EL.BEAM, false);
  // Для сравнения — такая же консоль из камня.
  box(c, 5, 5, 7, 35, EL.STONE);
  for (let x = 8; x <= 60; x++) c.setCell(x, 5, EL.STONE, false);
  c.step();
  let beamLen = 0; for (let x = 8; x <= 60; x++) if (c.beam[20 * 80 + x]) beamLen = x - 7;
  c.stability.fill(0); c._stabSigValid = false; c.computeStability();
  let beamReach = 0; for (let x = 8; x <= 60; x++) if (c.stability[20 * 80 + x] > 0) beamReach = x - 7;
  let stoneReach = 0; for (let x = 8; x <= 60; x++) if (c.stability[5 * 80 + x] > 0) stoneReach = x - 7;
  ok(beamLen === 53 && beamReach > 0 && beamReach < 53 && beamReach === stoneReach, `балка вся на месте (${beamLen} клеток), держит на ${beamReach}, консоль камня — на ${stoneReach}`);
  c.setCell(10, 19, EL.STONE, false); c.setCell(55, 19, EL.STONE, false);
  for (let k = 0; k < 40; k++) c.step();
  ok(c.type[19 * 80 + 10] === EL.STONE && c.type[19 * 80 + 55] !== EL.STONE, `камень на балке у колонны лежит — ${c.type[19 * 80 + 10] === EL.STONE ? 'да' : 'нет'}, на дальнем конце провалился — ${c.type[19 * 80 + 55] !== EL.STONE ? 'да' : 'нет'}`);
}

{
  // Тело с балкой упало — балка едет вместе с ним и остаётся балкой
  // (раньше тут же становилась камнем, непроходимым для всего; потом —
  // оставалась висеть, а тело проваливалось сквозь неё).
  for (const drop of [3, 25]) {
    const f = new Sim(40, 40);
    const floor = 11 + drop;
    box(f, 0, floor, 39, 39, EL.WALL);
    box(f, 10, 5, 15, 10, EL.STONE);
    f.pickBeamMaterial(12, 8);
    for (let x = 16; x <= 25; x++) f.setCell(x, 10, EL.BEAM, false);
    f.pickBeamMaterial(-1, -1);
    for (let k = 0; k < 30 + drop * 2; k++) f.step();
    const row = lowest(f, EL.STONE);
    let beams = 0, total = 0;
    for (let x = 16; x <= 25; x++) if (f.beam[row * 40 + x]) beams++;
    for (let i = 0; i < f.beam.length; i++) if (f.beam[i]) total++;
    ok(row === floor - 1 && beams === 10 && total === 10 && count(f, EL.STONE) === 36,
      `тело упало на ${row - 10} клеток, балка с ним на одном уровне: ${beams} из 10 (всего балок ${total}, камней ${count(f, EL.STONE)} из 36)`);
  }
  // Нарисованный масляный газ остаётся газом, а не выпадает маслом сразу.
  const og = new Sim(20, 20);
  box(og, 5, 5, 9, 9, EL.OIL_GAS);
  for (let k = 0; k < 120; k++) og.step();
  ok(count(og, EL.OIL) === 0 && count(og, EL.OIL_GAS) + count(og, EL.VAPOR) > 0, `масляный газ через 120 кадров: газа ${count(og, EL.OIL_GAS)}, масла ${count(og, EL.OIL)}`);
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
  s.stability.fill(0); s._stabSigValid = false; s.computeStability();
  let reach = 0; for (let x = 8; x <= 70; x++) if (s.beam[20 * 80 + x] && s.stability[20 * 80 + x] > 0) reach = x - 7;
  const E = g('ELEMENTS');
  const expected = E[EL.METAL].maxStability * E[EL.METAL].toughness - 1;
  ok(s.beam[20 * 80 + 8] === EL.METAL && reach === expected, `проведена от металла: материал ${E[s.beam[20 * 80 + 8]].name}, держит на ${reach} (у металла ${expected})`);
  // Колонну убрали — балке не за что держаться: вся рушится своим материалом.
  let beamCells = 0; for (let x = 8; x <= 70; x++) if (s.beam[20 * 80 + x]) beamCells++;
  box(s, 5, 20, 7, 39, EL.EMPTY);
  const metal0 = count(s, EL.METAL);
  s.step();
  ok(count(s, EL.METAL) === metal0 + beamCells, `без опоры металлическая балка стала металлом: +${count(s, EL.METAL) - metal0} клеток`);

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
  // Цвет (просьба: вода с солями чернеет, а не ржавеет на вид): к 3 долям
  // соли оттенок воды исчезает — ровно серый, дальше каждая доля темнее, к
  // 10 — чёрный.
  {
    const solColor = g('solColor'), solWith = g('solWith');
    const grey = g('SALT_GREY_COLOR'), black = g('SALT_BLACK_COLOR');
    const mix = (salt) => solColor(salt >= 10 ? solWith(0, P_SALT_, 10) : solWith(solWith(0, P_SALT_, salt), P_WATER_, 10 - salt));
    const c = [1, 2, 3, 4, 6, 8, 10].map(mix);
    const same = (x, y) => x.every((v, k) => Math.abs(v - y[k]) < 1e-9);
    const lum = (x) => x[0] + x[1] + x[2];
    const hue = (x) => Math.max(...x) - Math.min(...x);
    let darker = true;
    for (let k = 3; k < c.length; k++) if (!(lum(c[k]) < lum(c[k - 1]))) darker = false;
    ok(same(c[2], grey) && same(c[6], black) && hue(c[0]) > hue(c[1]) && hue(c[1]) > hue(c[2]) && darker,
      `1 соль — ${c[0].map(Math.round)}, 3 — ${c[2].map(Math.round)} (серый ${grey}), 6 — ${c[4].map(Math.round)}, 10 — ${c[6].map(Math.round)}`);
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

console.log('19. Спавн не копит тепло: прибавляет только до своей температуры');
{
  const s = new Sim(10, 10);
  const i = s.idx(5, 5);
  s.setCell(5, 5, EL.STONE, false);
  const t1 = s.temp[i];
  s.setCell(5, 5, EL.EMPTY, false); s.setCell(5, 5, EL.STONE, false);
  s.setCell(5, 5, EL.EMPTY, false); s.setCell(5, 5, EL.STONE, false);
  const t3 = s.temp[i];
  // Вода, перерисованная десять раз на одном месте, не закипает.
  const j = s.idx(2, 2);
  for (let k = 0; k < 10; k++) { s.setCell(2, 2, EL.EMPTY, false); s.setCell(2, 2, EL.WATER, false); }
  const tw = s.temp[j];
  // Горячее место остаётся горячим, морозное для льда — морозным.
  const hot = s.idx(7, 7); s.temp[hot] = 300; s.setCell(7, 7, EL.STONE, false);
  const ice = s.idx(8, 8); s.setCell(8, 8, EL.ICE, false);
  const tIce1 = s.temp[ice];
  s.setCell(8, 8, EL.EMPTY, false); s.setCell(8, 8, EL.ICE, false);
  s.setCell(8, 8, EL.EMPTY, false); s.setCell(8, 8, EL.ICE, false);
  const tIce3 = s.temp[ice];
  const cold = s.idx(1, 8); s.temp[cold] = -60; s.setCell(1, 8, EL.ICE, false);
  ok(t1 === 20 && t3 === 20 && tw === 20, `камень ${t1} → после двух перерисовок ${t3}; вода после десяти ${tw}`);
  ok(s.temp[hot] === 300 && tIce1 === -20 && tIce3 === -20 && s.temp[cold] === -60,
    `камень в 300° — ${s.temp[hot]}; лёд ${tIce1}, после перерисовок ${tIce3}; лёд на морозе -60 — ${s.temp[cold]}`);
}

console.log('20. Протагонист: один на поле, падает, ходит, прыгает, гибнет как человек');
{
  const P = EL.PROTAGONIST;
  const s = new Sim(40, 30);
  box(s, 0, 25, 39, 29, EL.STONE);
  s.setCell(10, 5, P, false);
  s.setCell(20, 5, P, false);
  ok(count(s, P) === 1 && s.type[s.idx(20, 5)] === P, `после двух постановок на поле ${count(s, P)}, стоит там, где поставили вторым`);
  for (let k = 0; k < 40; k++) s.step();
  let p = s.findProtagonist();
  ok(p === s.idx(20, 24), `упал на пол: (${p % s.w}, ${(p / s.w) | 0}), ждали (20, 24)`);
  s.playerInput.right = true;
  for (let k = 0; k < 10; k++) s.step();
  s.playerInput.right = false;
  p = s.findProtagonist();
  ok(p % s.w === 25, `10 кадров вправо (шаг раз в 2 кадра): x = ${p % s.w}, ждали 25`);
  // Ступенька в одну клетку — перешагивает, стена в две — нет.
  s.setCell(27, 24, EL.STONE, false);
  s.setCell(33, 24, EL.STONE, false); s.setCell(33, 23, EL.STONE, false);
  s.playerInput.right = true;
  for (let k = 0; k < 30; k++) s.step();
  s.playerInput.right = false;
  p = s.findProtagonist();
  ok(p % s.w === 32, `перешагнул ступеньку и упёрся в стену: x = ${p % s.w}, ждали 32`);
  // Прыжок: плавно на 2 клетки вверх (не за один кадр), зависание,
  // падение обратно.
  for (let k = 0; k < 5; k++) s.step();
  const y0 = (s.findProtagonist() / s.w) | 0;
  s.playerInput.jump = true;
  const path = [];
  for (let k = 0; k < 30; k++) { s.step(); path.push((s.findProtagonist() / s.w) | 0); }
  const top = Math.min(...path), atTop = path.filter((v) => v === top).length;
  ok(top === y0 - 2 && path[0] === y0 - 1 && atTop >= 4 && path[path.length - 1] === y0,
    `прыжок: стоял на ${y0}, путь по кадрам ${path.slice(0, 16).join(' ')}… — вершина ${top} (${atTop} кадров), приземлился на ${path[path.length - 1]}`);

  // Лестница из уступов в пиксель — проходится шагом, без прыжков, и с
  // края уступа он не скатывается.
  const st = new Sim(40, 30);
  box(st, 0, 25, 39, 29, EL.STONE);
  for (let k = 0; k < 6; k++) box(st, 10 + 3 * k, 24 - k, 39, 24 - k, EL.STONE);
  st.setCell(5, 24, P, false);
  st.playerInput.right = true;
  for (let k = 0; k < 60; k++) st.step();
  st.playerInput.right = false;
  let sp = st.findProtagonist();
  ok(((sp / st.w) | 0) === 18, `лестница в 6 уступов: поднялся на y = ${(sp / st.w) | 0} (верх лестницы — 18), x = ${sp % st.w}`);
  // Стоит на самом краю уступа — и остаётся.
  const edge = new Sim(20, 20);
  box(edge, 0, 15, 19, 19, EL.STONE);
  edge.setCell(8, 14, EL.STONE, false);
  edge.setCell(8, 13, P, false);
  for (let k = 0; k < 40; k++) edge.step();
  ok(edge.findProtagonist() === edge.idx(8, 13), 'на кочке в пиксель стоит, не скатывается');

  // Стена в 2 пикселя: встать вплотную, прыгнуть и шагнуть — оказаться на ней.
  const wall = new Sim(30, 20);
  box(wall, 0, 15, 29, 19, EL.STONE);
  box(wall, 12, 13, 29, 14, EL.STONE);   // стена высотой 2, верх на y = 12 свободен
  wall.setCell(11, 14, P, false);
  for (let k = 0; k < 5; k++) wall.step();
  wall.playerInput.right = true;
  wall.playerInput.jump = true;
  for (let k = 0; k < 30; k++) wall.step();
  wall.playerInput.right = false;
  const wp = wall.findProtagonist();
  ok(((wp / wall.w) | 0) === 12 && wp % wall.w > 12, `стена в 2 пикселя: после прыжка со шагом стоит на (${wp % wall.w}, ${(wp / wall.w) | 0}), верх стены — y = 12`);
  // А на стену в 3 пикселя прыжка не хватает.
  const high = new Sim(30, 20);
  box(high, 0, 15, 29, 19, EL.STONE);
  box(high, 12, 12, 29, 14, EL.STONE);
  high.setCell(11, 14, P, false);
  for (let k = 0; k < 5; k++) high.step();
  high.playerInput.right = true;
  high.playerInput.jump = true;
  for (let k = 0; k < 30; k++) high.step();
  const hp = high.findProtagonist();
  ok(hp === high.idx(11, 14), `стена в 3 пикселя: остался внизу (${hp % high.w}, ${(hp / high.w) | 0})`);
  // Смертельное касание — лава рядом.
  const d = new Sim(20, 20);
  box(d, 0, 15, 19, 19, EL.STONE);
  d.setCell(5, 14, P, false);
  box(d, 6, 13, 12, 14, EL.LAVA);
  for (let k = 0; k < 10; k++) d.step();
  const dp = d.findProtagonist();
  ok(dp >= 0 && d.extra[dp] === 1, 'касание лавы — погиб');
  // Захлёбывается под водой за то же время, что и человек.
  const wtr = new Sim(20, 20);
  box(wtr, 0, 15, 19, 19, EL.STONE);
  box(wtr, 0, 5, 19, 14, EL.WATER);
  wtr.setCell(5, 14, P, false);
  let died = -1;
  for (let k = 0; k < 400 && died < 0; k++) { wtr.step(); const q = wtr.findProtagonist(); if (q >= 0 && wtr.extra[q]) died = k + 1; }
  ok(died >= 170 && died <= 200, `под водой погиб на ${died}-м кадре (человек — через ${g('HUMAN_DROWN_FRAMES')})`);
  // Зажатый пробел ("вверх") в воде: всплывает до уровня воды и держится,
  // пока хватает выносливости; кончилась — тонет.
  const sw = new Sim(20, 30);
  box(sw, 0, 25, 19, 29, EL.STONE);
  box(sw, 0, 10, 19, 24, EL.WATER);
  sw.setCell(8, 24, P, false);
  sw.playerInput.up = true;
  let surfaced = -1, levelAt250 = false, stamAt250 = 0;
  for (let k = 0; k < 520; k++) {
    sw.step();
    const q = sw.findProtagonist();
    if (surfaced < 0 && q >= 0 && sw.type[q - sw.w] === EL.EMPTY) surfaced = k + 1;
    if (k === 249) { levelAt250 = q >= 0 && sw.type[q - sw.w] === EL.EMPTY && IS_LIQ(sw, q - 1) && IS_LIQ(sw, q + 1); stamAt250 = sw.playerState.stamina; }
  }
  const sq = sw.findProtagonist();
  ok(surfaced > 0 && surfaced < 100 && levelAt250,
    `плавание: всплыл за ${surfaced} кадров, на 250-м кадре на уровне воды (по бокам вода, сверху воздух), сил осталось ${stamAt250}`);
  ok(sw.playerState.exhausted && sq >= 0 && sw.type[sq - sw.w] !== EL.EMPTY,
    `выносливость кончилась (${sw.playerState.stamina}) — ушёл под воду (y = ${(sq / sw.w) | 0})`);

  // По воде не ходит: над водой с зажатым "вверх" он не держится —
  // сбоку пустота, уходит на уровень воды.
  const ww = new Sim(30, 20);
  box(ww, 0, 15, 29, 19, EL.STONE);
  box(ww, 0, 10, 29, 14, EL.WATER);
  ww.setCell(15, 9, P, false);
  ww.playerInput.up = true;
  ww.playerInput.right = true;
  for (let k = 0; k < 40; k++) ww.step();
  const wq = ww.findProtagonist();
  ok(((wq / ww.w) | 0) >= 10, `по воде не ходит: шёл вправо над водой — оказался на y = ${(wq / ww.w) | 0} (поверхность воды — 10)`);

  // Завален со всех сторон, считая углы, — задыхается, как под водой.
  const bur = new Sim(20, 20);
  box(bur, 0, 15, 19, 19, EL.STONE);
  box(bur, 7, 13, 9, 14, EL.STONE);
  bur.setCell(8, 14, P, false);
  let buried = -1;
  for (let k = 0; k < 300 && buried < 0; k++) { bur.step(); const q = bur.findProtagonist(); if (q >= 0 && bur.extra[q]) buried = k + 1; }
  ok(buried >= 170 && buried <= 200, `завален камнем — задохнулся на ${buried}-м кадре`);
  // Мёртвый не слушается.
  const q = wtr.findProtagonist();
  wtr.playerInput.left = true;
  for (let k = 0; k < 10; k++) wtr.step();
  ok(wtr.findProtagonist() === q, 'мёртвый не двигается по команде');
}

console.log('21. Люди плавают; падающее твёрдое давит');
{
  // Бассейн с берегом на уровне воды справа: человек со дна всплывает и
  // выбирается на берег.
  const s = new Sim(30, 20);
  box(s, 0, 15, 29, 19, EL.STONE);
  box(s, 0, 10, 14, 14, EL.WATER);
  box(s, 15, 11, 29, 14, EL.STONE);
  s.setCell(5, 14, EL.HUMAN, false);
  let out = -1;
  for (let k = 0; k < 900 && out < 0; k++) {
    s.step();
    for (let i = 0; i < s.type.length; i++) if (s.type[i] === EL.HUMAN && (i % s.w) >= 15 && !s.extra[i]) out = k + 1;
  }
  ok(out > 0, `человек со дна выплыл на берег за ${out} кадров`);

  // Незакреплённая каменная плита падает на человека: он раздавлен, вокруг
  // кровь.
  const c = new Sim(30, 30);
  box(c, 0, 25, 29, 29, EL.STONE);
  // Погибший человек: он не уходит из-под плиты, как ушёл бы живой.
  c.setCell(12, 24, EL.HUMAN, false);
  c.extra[c.idx(12, 24)] = 1;
  box(c, 10, 8, 14, 9, EL.STONE);
  let crushed = -1;
  for (let k = 0; k < 80 && crushed < 0; k++) { c.step(); if (count(c, EL.HUMAN) === 0) crushed = k + 1; }
  let stained = 0;
  for (let i = 0; i < c.stain.length; i++) if (c.stain[i] > 0) stained++;
  ok(crushed > 0 && stained > 0, `плита раздавила человека на ${crushed}-м кадре, в крови ${stained} клеток`);
}

console.log('22. Техника: медь, изолятор, приборы, панели');
{
  // Медь на воздухе окисляется сама — до 4-й стадии, не дальше.
  const cu = new Sim(12, 12);
  box(cu, 0, 8, 11, 11, EL.STONE);
  cu.setCell(5, 7, EL.COPPER, false);
  for (let k = 0; k < 40000; k++) cu.step();
  const cs = cu.oxideStage(cu.idx(5, 7));
  ok(cu.type[cu.idx(5, 7)] === EL.COPPER_OXIDE && cs === 4, `медь на воздухе за 40000 кадров: ${g('ELEMENTS')[cu.type[cu.idx(5, 7)]].name}, стадия ${cs} (предел 4)`);
  // Плавится в расплавленную медь (на 10° раньше металла), остывая — застывает.
  // На стене: каменный пол при этой температуре плавится сам, и его лава
  // смешалась бы с медью в сплав (sim/alloys.js).
  const m = new Sim(12, 12);
  box(m, 0, 8, 11, 11, EL.WALL);
  m.setCell(5, 7, EL.COPPER, false);
  const mi = m.idx(5, 7);
  let melted = false;
  for (let k = 0; k < 600 && !melted; k++) { m.temp.fill(g('ELEMENTS')[EL.COPPER].meltPoint + 5); m.step(); if (count(m, EL.MOLTEN_COPPER)) melted = true; }
  for (let i = 0; i < m.temp.length; i++) m.temp[i] = 20;
  for (let k = 0; k < 200; k++) m.step();
  ok(melted && count(m, EL.MOLTEN_COPPER) === 0 && count(m, EL.COPPER) === 1,
    `медь при ${g('ELEMENTS')[EL.COPPER].meltPoint + 5}° расплавилась (металл — ${g('ELEMENTS')[EL.METAL].meltPoint}°), остыв — снова медь`);

  // Камера плавится в металл; растворитель превращает её в металл.
  const cam = new Sim(12, 12);
  box(cam, 0, 8, 11, 11, EL.STONE);
  cam.setCell(5, 7, EL.CAMERA, false);
  let toMetal = false;
  for (let k = 0; k < 600 && !toMetal; k++) { cam.temp.fill(185); cam.step(); if (cam.type[cam.idx(5, 7)] === EL.METAL || count(cam, EL.LAVA)) toMetal = true; }
  const dis = new Sim(12, 12);
  box(dis, 0, 8, 11, 11, EL.STONE);
  dis.setCell(5, 7, EL.MONITOR, false);
  // Растворитель с трёх сторон: одна капля могла за 200 кадров уйти в
  // каменный пол, так и не задев монитор, — проверка зависела от удачи.
  dis.setCell(4, 7, EL.DISSOLVER, false); dis.setCell(6, 7, EL.DISSOLVER, false); dis.setCell(5, 6, EL.DISSOLVER, false);
  for (let k = 0; k < 300; k++) dis.step();
  ok(toMetal && count(dis, EL.MONITOR) === 0, `камера в жару стала металлом; монитор под растворителем — ${count(dis, EL.MONITOR) ? 'остался' : 'стал металлом'}`);

  // Изолятор горит.
  const ins = new Sim(12, 12);
  box(ins, 0, 8, 11, 11, EL.STONE);
  box(ins, 3, 5, 8, 7, EL.INSULATOR);
  // Огонь поддерживается первые 60 кадров: одна искра иногда гасла или
  // улетала вверх раньше, чем успевала поджечь (шанс 0.14 в кадр), и
  // проверка зависела от удачи бросков.
  for (let k = 0; k < 300; k++) { if (k < 60 && ins.type[ins.idx(2, 7)] !== EL.FIRE) ins.setCell(2, 7, EL.FIRE, false); ins.step(); }
  ok(count(ins, EL.INSULATOR) < 18, `изолятор горит: из 18 клеток осталось ${count(ins, EL.INSULATOR)}`);

  // Панели — шахматкой.
  const sp = new Sim(10, 10);
  box(sp, 2, 2, 5, 3, EL.SOLAR);
  ok(sp.shade[sp.idx(2, 2)] !== sp.shade[sp.idx(3, 2)] && sp.shade[sp.idx(2, 2)] === sp.shade[sp.idx(3, 3)], 'солнечные панели легли шахматкой');
}

console.log('23. Заряды: панель → медь → камера → медь → монитор');
{
  // Панели наверху под открытым небом, медный провод вниз к камере, от
  // неё к монитору. Заряд должен дойти: жёлтый, в камере — зелёный, в
  // мониторе — карта.
  // Всё стоит на полу (y = 32): провод столбом на камере, панели на нём.
  const s = new Sim(60, 40);
  box(s, 0, 32, 59, 39, EL.STONE);
  box(s, 10, 5, 17, 5, EL.SOLAR);             // 8 панелей: шанс 45%, срок 400
  box(s, 10, 6, 10, 30, EL.COPPER);           // провод вниз
  s.setCell(10, 31, EL.CAMERA, false);        // камера на полу
  box(s, 11, 31, 30, 31, EL.COPPER);          // провод по полу
  box(s, 31, 29, 32, 31, EL.MONITOR);         // монитор 2x3 на полу
  box(s, 40, 20, 50, 31, EL.STONE);           // есть что снимать
  // Карта монитора живёт MONITOR_FADE_FRAMES кадров после приёма — берётся
  // наибольшая за прогон.
  let yellow = 0, green = 0, most = 0;
  const key = s.monitorKey(s.idx(31, 29));
  for (let k = 0; k < 2400; k++) {
    s.step();
    for (const c of s.charges) { if (c.data) green += c.front.length; else yellow += c.front.length; }
    const m = s.monitorMaps.get(key);
    if (m && m.size > most) most = m.size;
  }
  ok(yellow > 0 && green > 0 && most > 100, `жёлтых шагов ${yellow}, зелёных ${green}; в карте монитора было до ${most} клеток`);

  // Изолятор в разрыве провода — заряд не проходит; пропуск в клетку
  // пустоты — перескакивает.
  const run = (gapId) => {
    const t = new Sim(40, 20);
    box(t, 0, 12, 39, 19, EL.STONE);          // пол
    box(t, 5, 2, 12, 2, EL.SOLAR);
    box(t, 5, 3, 5, 10, EL.COPPER);
    box(t, 5, 11, 30, 11, EL.COPPER);
    t.setCell(15, 11, gapId, false);           // разрыв
    let reached = 0;
    for (let k = 0; k < 1500; k++) { t.step(); for (const c of t.charges) for (const f of c.front) if (f.i % t.w > 15 && ((f.i / t.w) | 0) === 11) reached++; }
    return reached;
  };
  const viaInsulator = run(EL.INSULATOR), viaGap = run(EL.EMPTY);
  ok(viaInsulator === 0 && viaGap > 0, `за изолятор заряд не прошёл (${viaInsulator}), через пропуск в клетку — прошёл (${viaGap})`);

  // Камера отражает сигнал: монитор на проводе между панелью и камерой в
  // тупике получает снимок от отражённой волны (исходная проходит его ещё
  // жёлтой). Прозрачность фронта — по остатку срока.
  {
    const r = new Sim(40, 30);
    box(r, 0, 22, 39, 29, EL.STONE);
    box(r, 5, 2, 12, 2, EL.SOLAR);
    box(r, 5, 3, 5, 20, EL.COPPER);
    box(r, 6, 21, 7, 21, EL.MONITOR);
    box(r, 8, 21, 25, 21, EL.COPPER);
    r.setCell(26, 21, EL.CAMERA, false);        // тупик
    box(r, 30, 12, 35, 21, EL.STONE);           // есть что снимать
    let reflected = 0;
    for (let k = 0; k < 2400; k++) { r.step(); for (const c of r.charges) if (c.parent) reflected++; }
    const map = r.monitorMaps.get(r.monitorKey(r.idx(6, 21)));
    ok(reflected > 0 && map && map.size > 100, `отражённых шагов ${reflected}; монитор до камеры получил ${map ? map.size : 0} клеток`);
  }

  // Генератор-крышка на баке с маслом выпускает заряд раз в полсекунды и дым
  // над собой: за 600 кадров — 20 зарядов со сроком GENERATOR_LIFE. Бак с
  // водой вместо масла — генератор молчит.
  const genRun = (fuel) => {
    const gs = new Sim(40, 20);
    box(gs, 0, 15, 39, 19, EL.WALL);
    box(gs, 4, 11, 4, 14, EL.WALL); box(gs, 9, 11, 9, 14, EL.WALL);   // стенки бака
    box(gs, 5, 12, 8, 14, fuel);
    box(gs, 5, 11, 8, 11, EL.GENERATOR);                               // крышка
    box(gs, 6, 10, 30, 10, EL.COPPER);                                 // провод; над (5,11) свободно — туда дым
    const first = new Map();
    let smoke = 0;
    for (let k = 0; k < 600; k++) {
      gs.step();
      for (const c of gs.charges) if (!first.has(c.id)) first.set(c.id, c.life);
      smoke = Math.max(smoke, count(gs, EL.SMOKE));
    }
    return { n: first.size, lives: [...new Set(first.values())], smoke };
  };
  const onOil = genRun(EL.OIL), onWater = genRun(EL.WATER);
  ok(onOil.n === 20 && onOil.lives.length === 1 && onOil.lives[0] === g('GENERATOR_LIFE') && onOil.smoke > 0 && onWater.n === 0,
    `генератор на масле за 600 кадров выпустил ${onOil.n} зарядов (сроки ${onOil.lives.join(', ')}), дыма до ${onOil.smoke} клеток; на воде — ${onWater.n} зарядов`);

  // Усилитель: заряд со сроком 60 по длинному медному проводу проходит 60
  // клеток; через усилитель — на 50 дальше. Пятно усилителя 3x3 прибавляет
  // один раз, как одна клетка (а не 9 x 50); лишние клетки пятна волна
  // проходит за свой срок, поэтому уходит чуть ближе.
  {
    // Провод металлический: в меди срок тратится вдесятеро медленнее.
    const reach = (amp, wire = EL.METAL) => {
      const a = new Sim(260, 12);
      box(a, 0, 8, 259, 11, EL.STONE);
      box(a, 1, 7, 258, 7, wire);
      if (amp === 1) a.setCell(20, 7, EL.AMPLIFIER, false);
      if (amp === 9) box(a, 20, 5, 22, 7, EL.AMPLIFIER);
      a.addCharge(a.idx(1, 7), 0, 60);
      let far = 0;
      for (let k = 0; k < 600; k++) { a.step(); for (const c of a.charges) for (const f of c.front) far = Math.max(far, f.i % a.w); }
      return far;
    };
    const plain = reach(0), one = reach(1), blob = reach(9);
    ok(one - plain >= 45 && one - plain <= 52 && blob > plain + 30 && blob <= one + 1,
      `без усилителя заряд дошёл до x=${plain}, через усилитель — до x=${one}, через пятно 3x3 — до x=${blob}`);
    // Медь: тот же заряд со сроком 60 проходит вдесятеро дальше металла.
    const copper = reach(0, EL.COPPER);
    ok(plain >= 55 && plain <= 62 && copper >= 250, `заряд со сроком 60: по металлу до x=${plain}, по меди — до x=${copper} (провод до 258)`);
  }

  // Вода превращает зелёный заряд в жёлтый.
  // Вода — в каменном жёлобе, чтобы не растекалась из-под заряда.
  const wtr = new Sim(20, 10);
  box(wtr, 0, 6, 19, 9, EL.STONE);
  wtr.setCell(5, 5, EL.METAL, false);
  wtr.setCell(13, 5, EL.STONE, false);
  box(wtr, 6, 5, 12, 5, EL.WATER);
  wtr.addCharge(wtr.idx(5, 5), 1, 100, { cells: new Int32Array(0), looks: new Int32Array(0) });
  let inWater = null;
  for (let k = 0; k < 20 && !inWater; k++) {
    wtr.step();
    const c = wtr.charges[0];
    if (c) for (const f of c.front) if (wtr.type[f.i] === EL.WATER) inWater = { data: c.data };
  }
  ok(inWater && inWater.data === null, `зелёный заряд, войдя в воду, стал ${inWater ? (inWater.data ? 'зелёным' : 'жёлтым') : '— не дошёл'}`);

  // Волна: заряд в центре квадрата металла 3x3 за один шаг разливается во
  // все восемь соседей, и счётчик растёт на 8 (просьба пользователя).
  const wv = new Sim(10, 10);
  box(wv, 0, 8, 9, 9, EL.STONE);
  box(wv, 3, 5, 5, 7, EL.METAL);
  wv.addCharge(wv.idx(4, 6), 0, 100);
  const c0 = wv.charges[0];
  let fronts = [];
  for (let k = 0; k < 3; k++) { wv.step(); fronts.push(c0.front.length + ':' + c0.count); }
  ok(fronts.includes('8:9'), `волна в квадрате 3x3: фронт и счётчик по кадрам ${fronts.join(' ')} (ждали 8 клеток фронта, счётчик 1 + 8)`);

  // Металлическая балка между двумя кусками металла проводит (касанием
  // своего вещества), каменная — нет.
  const beamWire = (fromMetal) => {
    const s = new Sim(30, 10);
    box(s, 0, 0, 0, 9, EL.WALL); box(s, 23, 0, 23, 9, EL.WALL);
    s.setCell(1, 5, EL.METAL, false); s.setCell(22, 5, EL.METAL, false);
    s.pickBeamMaterial(fromMetal ? 1 : -1, fromMetal ? 5 : -1);
    for (let x = 2; x <= 21; x++) s.setCell(x, 5, EL.BEAM, false);
    s.pickBeamMaterial(-1, -1);
    s.addCharge(s.idx(1, 5), 0, 200);
    let reached = false;
    for (let k = 0; k < 120 && !reached; k++) { s.step(); for (const c of s.charges) for (const f of c.front) if (f.i === s.idx(22, 5)) reached = true; }
    return { reached, mat: s.beam[s.idx(10, 5)] };
  };
  const bm = beamWire(true), bs = beamWire(false);
  ok(bm.mat === EL.METAL && bm.reached && bs.mat === EL.STONE && !bs.reached,
    `металлическая балка через 20 клеток пустоты довела заряд — ${bm.reached ? 'да' : 'нет'}, каменная — ${bs.reached ? 'да' : 'нет'}`);
}

console.log('24. Пятно контакта: масса тела / площадь касания против стойкости');
{
  // Сколько пикселей продавлено за прогон: продавленное через CRUSH_FRAMES
  // кадров снова обычное, так что считаем сами продавливания.
  let crushes = 0;
  const proto = Sim.prototype, crushOrig = proto.crushPixel;
  proto.crushPixel = function (i) { crushes++; crushOrig.call(this, i); };
  const liveCrushed = (sim) => { let n = 0; for (let i = 0; i < sim.crushed.length; i++) if (sim.crushed[i]) n++; return n; };
  // Куб железа 10x10 (100 x 0.2 = 20) падает на толстый пол, withTip — с
  // выступом в пиксель снизу по центру.
  const drop = (floorId, withTip) => {
    crushes = 0;
    const s = new Sim(40, 80);
    box(s, 0, 60, 39, 79, floorId);
    box(s, 15, 10, 24, 19, EL.METAL);
    if (withTip) s.setCell(19, 20, EL.METAL, false);
    for (let k = 0; k < 200; k++) s.step();
    s.crushes = crushes;
    return s;
  };
  const flat = drop(EL.METAL, false).crushes, tip = drop(EL.METAL, true).crushes;
  ok(flat === 0 && tip === 3, `железный куб на железо: ровным дном продавлено ${flat} (давление 20 / 10 = 2 < 10), выступом — ${tip} (20.2 / 1 > 10, пятно 20.2 / 10 → 3)`);
  const tipStone = drop(EL.STONE, true).crushes;
  ok(tipStone === 5, `тот же куб выступом на камень (стойкость 5): продавлено ${tipStone} (20.2 / 5 → 5)`);
  const wall = drop(EL.WALL, true).crushes;
  ok(wall === 0, `на стену: продавлено ${wall} — якорь не продавливается`);
  // Толстый пол не меняется; осыпается только то, что у самого пятна
  // контакта, а не дальний угол тела; потом всё снова обычное.
  const w = drop(EL.WOOD, true);
  let far = 0;
  for (let i = 0; i < w.type.length; i++) {
    const x = i % 40, y = (i / 40) | 0;
    const inCube = x >= 15 && x <= 24 && y >= 49 && y <= 58;
    const isMetal = w.type[i] === EL.METAL;
    if (inCube !== isMetal && !(x === 19 && y === 59) && (Math.abs(x - 19) > 2 || Math.abs(y - 59) > 2)) far++;
  }
  ok(w.crushes === 7 && far === 0 && liveCrushed(w) === 0 && count(w, EL.WOOD) === 800 && w.stability[60 * 40 + 19] > 0,
    `куб с выступом на толстом дереве: продавлено ${w.crushes} (20.2 / 3 → 7), осыпалось вдали от удара ${far}, пол цел (дерева ${count(w, EL.WOOD)} из 800), продавленных к концу ${liveCrushed(w)}`);
  // Тяжёлый ровный куб: пятно продавлено, но деваться ему некуда — куб
  // стоит целым, углы не осыпаются (раньше тело без опоры рассыпалось
  // песком от верхних углов).
  crushes = 0;
  const big = new Sim(80, 100);
  box(big, 0, 60, 79, 99, EL.WOOD);
  box(big, 25, 5, 54, 34, EL.METAL);
  for (let k = 0; k < 300; k++) big.step();
  let whole = 0;
  for (let y = 30; y <= 59; y++) for (let x = 25; x <= 54; x++) if (big.type[y * 80 + x] === EL.METAL) whole++;
  ok(crushes === 60 && whole === 900 && liveCrushed(big) === 0, `ровный куб 30x30 на дереве (180 / 30 = 6 > 3): продавлено ${crushes}, куб на месте целым — ${whole} из 900`);
  // Тонкий пол над пустотой проламывается: продавленное падает, тело за ним.
  const t = new Sim(80, 100);
  box(t, 0, 50, 3, 99, EL.WALL); box(t, 76, 50, 79, 99, EL.WALL); box(t, 0, 95, 79, 99, EL.WALL);
  box(t, 4, 60, 75, 60, EL.STONE);
  box(t, 35, 10, 44, 19, EL.METAL); t.setCell(39, 20, EL.METAL, false);
  for (let k = 0; k < 400; k++) t.step();
  ok(t.type[60 * 80 + 39] !== EL.STONE && lowest(t, EL.METAL) > 80, `тонкий каменный пол над пустотой проломился под выступом, куб упал вниз, на ${lowest(t, EL.METAL)}`);
  // Вещество сохраняется: набор пикселей (вид, состав с примесями,
  // оттенок) до и после — один и тот же (просьба пользователя).
  crushes = 0;
  const c = new Sim(120, 90);
  box(c, 0, 60, 119, 89, EL.WOOD);
  const solWith = g('solWith'), solPure = g('solPure');
  for (let y = 60; y < 90; y++) for (let x = 0; x < 120; x++) {
    const i = y * 120 + x, k = (x * 7 + y * 3) % 5;
    if (k === 0) c.setComp(i, solWith(solPure(EL.WOOD, 7), EL.METAL, 3));
    else if (k === 1) c.setComp(i, solWith(solPure(EL.WOOD, 8), EL.COPPER, 2));
  }
  box(c, 45, 10, 74, 39, EL.METAL);
  c.setCell(60, 40, EL.METAL, false);
  const census = (sim) => { const m = new Map(); for (let i = 0; i < sim.type.length; i++) if (sim.type[i]) { const key = sim.type[i] + ':' + sim.comp(i) + ':' + sim.shade[i]; m.set(key, (m.get(key) || 0) + 1); } return m; };
  const before = census(c);
  for (let k = 0; k < 400; k++) c.step();
  const after = census(c);
  let diff = 0;
  for (const key of new Set([...before.keys(), ...after.keys()])) diff += Math.abs((before.get(key) || 0) - (after.get(key) || 0));
  ok(diff === 0 && crushes > 0, `вещество сохраняется: продавлено ${crushes}, пикселей с другим видом, составом или оттенком ${diff}`);
  // Отмена возвращает продавленное, и оно снова отсчитывает и оживает.
  const u = new Sim(40, 80);
  box(u, 0, 60, 39, 79, EL.WOOD);
  box(u, 15, 10, 24, 19, EL.METAL); u.setCell(19, 20, EL.METAL, false);
  let snap = null;
  for (let k = 0; k < 120 && !snap; k++) { u.step(); if (liveCrushed(u)) snap = u.snapshot(); }
  for (let k = 0; k < 60; k++) u.step();
  u.restore(snap);
  const restored = liveCrushed(u);
  for (let k = 0; k < 60; k++) u.step();
  ok(restored > 0 && liveCrushed(u) === 0, `отмена: вернулось продавленных ${restored}, через 60 кадров осталось ${liveCrushed(u)}`);
  proto.crushPixel = crushOrig;
}

const elName = (id) => (g('ELEMENTS')[id] || { name: String(id) }).name;
console.log('25. Сплавы: расплавы смешиваются, свойства по долям, ржавчина по долям');
{
  const solWith = g('solWith'), solPure = g('solPure');
  const mix = (...pairs) => { let c = 0; for (let k = 0; k < pairs.length; k += 2) c = solWith(c, pairs[k], pairs[k + 1]); return c; };
  // Клетка сплава с заданным составом.
  const alloyAt = (s, x, y, comp) => { s.setCell(x, y, EL.METAL, false); s.setComposition(s.idx(x, y), comp); return s.idx(x, y); };
  const partsOf = (s, i) => { const c = s.comp(i), out = {}; for (const id of [EL.METAL, EL.STEEL, EL.COPPER, EL.STONE, EL.METAL_OXIDE, EL.COPPER_OXIDE, EL.OXIDE]) { const n = solGet(c, id); if (n) out[id] = n; } return out; };

  // Расплавы металла и меди в горячей ванне смешиваются в "Расплав", а
  // остыв — в сплав, в котором есть и то и другое.
  {
    const s = new Sim(30, 30);
    box(s, 0, 25, 29, 29, EL.WALL); box(s, 0, 10, 0, 24, EL.WALL); box(s, 29, 10, 29, 24, EL.WALL);
    box(s, 1, 20, 14, 24, EL.MOLTEN_METAL); box(s, 15, 20, 28, 24, EL.MOLTEN_COPPER);
    const hot = () => { for (let i = 0; i < s.type.length; i++) if (IS_LIQ(s, i)) s.temp[i] = 400; };
    for (let k = 0; k < 400; k++) { hot(); s.step(); }
    const molten = count(s, EL.MOLTEN_ALLOY);
    for (let i = 0; i < s.type.length; i++) if (IS_LIQ(s, i)) s.temp[i] = 20;
    for (let k = 0; k < 200; k++) s.step();
    let alloys = 0, both = 0;
    for (let i = 0; i < s.type.length; i++) if (s.type[i] === EL.ALLOY) { alloys++; const p = partsOf(s, i); if (p[EL.METAL] && p[EL.COPPER]) both++; }
    ok(molten > 20 && alloys > 20 && both === alloys && count(s, EL.MOLTEN_METAL) + count(s, EL.MOLTEN_COPPER) + count(s, EL.MOLTEN_ALLOY) === 0,
      `расплавы металла и меди смешались (${molten} клеток расплава), остыв — сплав: ${alloys} клеток, у всех и металл, и медь`);
  }
  // Чистый металл плавится в расплавленный металл и застывает металлом, а не
  // камнем (раньше железо плавилось в лаву).
  {
    const s = new Sim(10, 10);
    box(s, 0, 9, 9, 9, EL.WALL);
    box(s, 3, 6, 6, 8, EL.METAL);
    // Плавление — бросок 1% в кадр на клетку: 600 кадров на 12 клеток
    // иногда не хватало последней (зависит от последовательности случайных чисел).
    for (let k = 0; k < 2000 && count(s, EL.METAL) > 0; k++) { for (let i = 0; i < s.type.length; i++) if (s.type[i] === EL.METAL) s.temp[i] = 200; s.step(); }
    const molten = count(s, EL.MOLTEN_METAL);
    for (let i = 0; i < s.type.length; i++) s.temp[i] = 20;
    for (let k = 0; k < 200; k++) s.step();
    ok(molten === 12 && count(s, EL.METAL) === 12 && count(s, EL.STONE) === 0, `металл расплавился (${molten} из 12) и застыл металлом (${count(s, EL.METAL)}), камня ${count(s, EL.STONE)}`);
  }
  // Средние свойства.
  {
    const s = new Sim(20, 20);
    const a = alloyAt(s, 2, 2, mix(EL.METAL, 5, EL.STEEL, 5));
    const b = alloyAt(s, 4, 2, mix(EL.COPPER, 5, EL.METAL, 5));
    const c = alloyAt(s, 6, 2, mix(EL.STONE, 5, EL.METAL, 5));
    const d = alloyAt(s, 8, 2, mix(EL.STONE, 4, EL.COPPER, 6));
    ok(s.type[a] === EL.ALLOY && s.cellStability(a, EL.ALLOY) === 12 && s.cellToughness(a, EL.ALLOY) === 6,
      `металл 5 + сталь 5: устойчивость ${s.cellStability(a, EL.ALLOY)} (10 и 14 → 12), стойкость ${s.cellToughness(a, EL.ALLOY)} (5 и 7 → 6)`);
    ok(s.chargeStepAt(b) === 2 && s.chargeStepAt(c) === 0 && s.chargeStepAt(d) === 1,
      `ток: медь 5 + металл 5 — ${s.chargeStepAt(b)} кадр. на клетку (1 и 2), камень 5 + металл 5 — ${s.chargeStepAt(c)} (не проводит), камень 4 + медь 6 — ${s.chargeStepAt(d)}`);
    ok(Math.abs(s.alloyAcidChance(c) - 0.0375) < 1e-9, `кислота: камень 5 + металл 5 — шанс ${s.alloyAcidChance(c)} (0.06 и 0.015 → 0.0375)`);
    // Плавление — средняя точка: металл 180 и сталь 230 → 205.
    const m = new Sim(10, 10);
    const ai = alloyAt(m, 5, 5, mix(EL.METAL, 5, EL.STEEL, 5));
    box(m, 0, 6, 9, 9, EL.WALL);
    let melted200 = false;
    for (let k = 0; k < 800; k++) { m.temp[ai] = 200; m.step(); if (m.type[ai] !== EL.ALLOY) { melted200 = true; break; } }
    for (let k = 0; k < 800 && m.type[ai] === EL.ALLOY; k++) { m.temp[ai] = 210; m.step(); }
    let mi = -1;
    for (let i = 0; i < m.type.length; i++) if (m.type[i] === EL.MOLTEN_ALLOY) mi = i;
    ok(!melted200 && mi >= 0 && solGet(m.comp(mi), EL.MOLTEN_METAL) === 5 && solGet(m.comp(mi), EL.MOLTEN_STEEL) === 5,
      `металл 5 + сталь 5 при 200° стоит, при 210° плавится (средняя 205) в расплав: ${mi >= 0 ? 'расплавленный металл ' + solGet(m.comp(mi), EL.MOLTEN_METAL) + ' + сталь ' + solGet(m.comp(mi), EL.MOLTEN_STEEL) : 'нет'}`);
  }
  // Ржавчина по долям: сплав железа с медью в воде рыжеет и зеленеет разом;
  // доля стали защищает от чистой воды, но не от солёной.
  {
    const rustIn = (comp, liquid, frames) => {
      const s = new Sim(20, 20);
      box(s, 0, 15, 19, 19, EL.WALL);
      const cells = [];
      for (let x = 5; x <= 14; x++) cells.push(alloyAt(s, x, 14, comp));
      box(s, 1, 10, 18, 13, EL.WATER);
      if (liquid !== EL.WATER) for (let i = 0; i < s.type.length; i++) if (s.type[i] === EL.WATER) s.setComp(i, liquid);
      let rust = 0, patina = 0, t = 0;
      for (let k = 0; k < frames; k++) s.step();
      for (let i = 0; i < s.type.length; i++) { const c = s.comp(i); if (s.type[i] === EL.ALLOY || s.type[i] === EL.ALLOY_RUST) { rust += solGet(c, EL.METAL_OXIDE); patina += solGet(c, EL.COPPER_OXIDE); } }
      return { rust, patina };
    };
    const plain = rustIn(mix(EL.METAL, 5, EL.COPPER, 5), EL.WATER, 3000);
    ok(plain.rust > 0 && plain.patina > 0, `железо 5 + медь 5 в воде: долей ржавчины ${plain.rust} и патины ${plain.patina} — обе разом`);
    const steel = rustIn(mix(EL.METAL, 9, EL.STEEL, 1), EL.WATER, 3000);
    ok(steel.rust === 0, `железо 9 + сталь 1 в чистой воде: ржавчины ${steel.rust} — доля стали защищает`);
    const salty = rustIn(mix(EL.METAL, 9, EL.STEEL, 1), mix(EL.WATER, 7, EL.BLACK_SALT, 3), 3000);
    ok(salty.rust > 0, `то же в воде с чёрными солями: ржавчины ${salty.rust}`);
  }
  // Воздух: больше пяти долей меди и ни одной стали — зеленеет сам.
  {
    const air = (comp) => {
      const s = new Sim(40, 10);
      box(s, 0, 8, 39, 9, EL.WALL);
      for (let x = 0; x < 40; x++) alloyAt(s, x, 7, comp);
      for (let k = 0; k < 3000; k++) s.step();
      let p = 0;
      for (let i = 0; i < s.type.length; i++) p += solGet(s.comp(i), EL.COPPER_OXIDE);
      return p;
    };
    const six = air(mix(EL.COPPER, 6, EL.METAL, 4)), five = air(mix(EL.COPPER, 5, EL.METAL, 5)), withSteel = air(mix(EL.COPPER, 6, EL.METAL, 3, EL.STEEL, 1));
    ok(six > 0 && five === 0 && withSteel === 0, `воздух: медь 6 — патины ${six}, медь 5 — ${five}, медь 6 со сталью — ${withSteel}`);
  }
  // Проржавев на ALLOY_CRUMBLE_AT долей, сплав рассыпается рыхлой ржавчиной.
  {
    const s = new Sim(10, 10);
    const i = alloyAt(s, 5, 5, mix(EL.METAL_OXIDE, 4, EL.COPPER_OXIDE, 2, EL.METAL, 4));
    const before = s.type[i];
    s.setComposition(i, mix(EL.METAL_OXIDE, 5, EL.COPPER_OXIDE, 2, EL.METAL, 3));
    ok(before === EL.ALLOY && s.type[i] === EL.ALLOY_RUST, `6 долей ржавчины — ${elName(before)}, 7 — ${elName(s.type[i])}`);
  }
  // Газ при растворении — газ случайной доли, по числу долей.
  {
    const s = new Sim(10, 10);
    const seen = {};
    const orig = Sim.prototype.ventGas;
    Sim.prototype.ventGas = function (x, y, src) { seen[src] = (seen[src] || 0) + 1; };
    for (let k = 0; k < 4000; k++) {
      const i = alloyAt(s, 5, 5, mix(EL.METAL, 3, EL.STONE, 7));
      s.dissolveInto(5, 4, i, solPure(EL.ACID), EL.ALLOY);
    }
    Sim.prototype.ventGas = orig;
    const m = seen[EL.METAL] || 0, st = seen[EL.STONE] || 0, share = m / (m + st);
    ok(m > 0 && st > 0 && Math.abs(share - 0.3) < 0.05, `газ при растворении металла 3 + камня 7: от металла ${m}, от камня ${st} (доля металла ${share.toFixed(2)}, ждали 0.3)`);
  }
}

console.log('26. Монитор: вспышка при приёме, карта со временем стирается');
{
  const s = new Sim(40, 20);
  box(s, 0, 15, 39, 19, EL.STONE);
  box(s, 10, 13, 11, 14, EL.MONITOR);
  const snap = { cells: Int32Array.from([5, 6, 7]), looks: Int32Array.from([0x112233, 0x445566, g('LOOK_AIR')]), id: 1 };
  s.monitorReceive(s.idx(10, 13), snap);
  const key = s.monitorKey(s.idx(10, 13));
  const map = s.monitorMaps.get(key), flash = s.monitorFlash.get(key);
  const v = map && map.get(6);
  ok(map && map.size === 3 && g('monitorLook')(v) === 0x445566 && g('monitorAt')(v) === s.frame && flash && flash.cells.length === 4,
    `после приёма: в карте ${map ? map.size : 0} клеток, вид клетки сохранён, вспышка на ${flash ? flash.cells.length : 0} клетках монитора`);
  const FADE = g('MONITOR_FADE_FRAMES');
  for (let k = 0; k < FADE - 60; k++) s.step();
  const mid = s.monitorMaps.has(key) ? s.monitorMaps.get(key).size : 0;
  for (let k = 0; k < 130; k++) s.step();
  ok(mid === 3 && !s.monitorMaps.has(key) && !s.monitorFlash.has(key),
    `за ${FADE - 60} кадров карта цела (${mid}), через ${FADE + 70} — стёрта (${s.monitorMaps.has(key) ? 'нет' : 'да'}), вспышка снята`);
}

console.log('27. Стекло: стойкость камня, плавится вдвое раньше, кислота и реагент не берут, прозрачно для взгляда');
{
  const E = g('ELEMENTS');
  ok(E[EL.GLASS].maxStability === E[EL.STONE].maxStability && E[EL.GLASS].toughness === E[EL.STONE].toughness
    && E[EL.GLASS].meltPoint === E[EL.STONE].meltPoint / 2,
    `стойкость ${E[EL.GLASS].maxStability}/${E[EL.GLASS].toughness} (камень ${E[EL.STONE].maxStability}/${E[EL.STONE].toughness}), плавление ${E[EL.GLASS].meltPoint}° (камень ${E[EL.STONE].meltPoint}°)`);
  // Лужа кислоты и лужа реагента на стеклянном дне в стеклянной чаше.
  for (const liq of [EL.ACID, EL.REAGENT]) {
    const s = new Sim(30, 20);
    box(s, 2, 10, 27, 14, EL.GLASS);
    box(s, 2, 4, 3, 9, EL.GLASS); box(s, 26, 4, 27, 9, EL.GLASS);
    box(s, 4, 6, 25, 9, liq);
    const n0 = count(s, EL.GLASS);
    for (let k = 0; k < 600; k++) s.step();
    ok(count(s, EL.GLASS) === n0, `${liq === EL.ACID ? 'кислота' : 'реагент'} за 600 кадров: стекла ${count(s, EL.GLASS)} из ${n0}`);
  }
  // Камера за стеклянной стеной видит камень за ней; за каменной — нет.
  const seen = (wall) => {
    const s = new Sim(40, 20);
    box(s, 0, 15, 39, 19, EL.STONE);
    s.setCell(5, 14, EL.CAMERA, false);
    box(s, 10, 5, 10, 14, wall);
    box(s, 20, 12, 22, 14, EL.METAL);
    const snap = s.cameraScan(s.idx(5, 14));
    return Array.from(snap.cells).includes(s.idx(20, 14));
  };
  ok(seen(EL.GLASS) && !seen(EL.STONE), `камера видит металл сквозь стекло — ${seen(EL.GLASS) ? 'да' : 'нет'}, сквозь камень — ${seen(EL.STONE) ? 'да' : 'нет'}`);
  // Стекло при 90° (выше своей точки, ниже камня) плавится, камень — нет.
  const melt = (id) => {
    const s = new Sim(10, 10);
    box(s, 0, 8, 9, 9, EL.WALL);
    s.setCell(5, 7, id, false);
    for (let k = 0; k < 200; k++) { s.temp[s.idx(5, 7)] = 90; s.step(); if (s.type[s.idx(5, 7)] !== id) return true; }
    return false;
  };
  ok(melt(EL.GLASS) && !melt(EL.STONE), `при 90°: стекло расплавилось — ${melt(EL.GLASS) ? 'да' : 'нет'}, камень — ${melt(EL.STONE) ? 'да' : 'нет'}`);
}

console.log('28. Заряд делится, когда светящиеся части разошлись; в толстом проводнике — нет');
{
  // Заряд посреди медного провода: волна пошла в обе стороны — два заряда
  // с остатком срока пополам. Справа камера: правый стал зелёным, левый нет.
  const s = new Sim(80, 12);
  box(s, 0, 8, 79, 11, EL.STONE);
  box(s, 5, 7, 60, 7, EL.COPPER);
  s.setCell(61, 7, EL.CAMERA, false);
  s.addCharge(s.idx(45, 7), 0, 101);
  // Куски связаны через свежий хвост (CHARGE_TAIL_FRAMES кадров) — делятся чуть позже.
  for (let k = 0; k < 10; k++) s.step();
  const two = s.charges.length, lives = s.charges.map((c) => c.life - c.count);
  // Как только правый дошёл до камеры и позеленел — левый ещё жёлтый.
  let green = 0, yellow = 0;
  for (let k = 0; k < 60 && !green; k++) {
    s.step();
    green = s.charges.filter((c) => c.data).length;
    yellow = s.charges.filter((c) => !c.data && !c.parent).length;
  }
  ok(two === 2 && Math.abs(lives[0] - lives[1]) <= 1 && green >= 1 && yellow >= 1,
    `зарядов после развилки ${two}, остаток срока ${lives.map((v) => v.toFixed(1)).join(' и ')}; у камеры зелёных ${green}, жёлтых ${yellow}`);
  // Толстая медная полоса 5 клеток: фронт — одна полоса, заряд один.
  const t = new Sim(80, 12);
  box(t, 0, 8, 79, 11, EL.STONE);
  box(t, 5, 3, 70, 7, EL.COPPER);
  t.addCharge(t.idx(5, 5), 0, 250);
  let most = 0;
  for (let k = 0; k < 40; k++) { t.step(); most = Math.max(most, t.charges.length); }
  ok(most === 1, `в полосе толщиной 5 зарядов одновременно не больше ${most}`);
  // Генератор 2x4 и провод: заряд выходит в провод целым, без кусков,
  // отщеплённых прыжками внутри генератора (срок GENERATOR_LIFE — дойти на
  // 150+). Под генератором — масло в кармане стены.
  const gn = new Sim(260, 12);
  box(gn, 0, 8, 259, 11, EL.WALL);
  box(gn, 2, 8, 3, 8, EL.OIL);
  box(gn, 2, 4, 3, 7, EL.GENERATOR);
  box(gn, 4, 7, 258, 7, EL.COPPER);
  let far = 0;
  for (let k = 0; k < 400; k++) { gn.step(); for (const c of gn.charges) for (const f of c.front) far = Math.max(far, f.i % gn.w); }
  ok(far >= 150, `заряд генератора 2x4 дошёл по проводу до x=${far}`);
}

console.log('28б. Заряды сливаются, складывая срок; зелёный с жёлтым дают жёлтый; балка — односторонний проводник своего вещества');
{
  // Навстречу по одному проводу: жёлтый слева, зелёный справа.
  const s = new Sim(80, 12);
  box(s, 0, 8, 79, 11, EL.WALL);
  box(s, 5, 7, 65, 7, EL.COPPER);
  s.addCharge(s.idx(5, 7), 0, 100);
  s.addCharge(s.idx(65, 7), 1, 100, { cells: new Int32Array(0), looks: new Int32Array(0), id: 7 });
  let met = null;
  for (let k = 0; k < 60 && !met; k++) {
    const before = s.charges.map((c) => c.life - c.count).reduce((a, b) => a + b, 0);
    s.step();
    if (s.charges.length === 1) met = { rest: s.charges[0].life - s.charges[0].count, before, green: !!s.charges[0].data };
  }
  ok(met && !met.green && Math.abs(met.rest - (met.before - 2)) <= 2,
    met ? `встретились: один заряд, остаток ${met.rest.toFixed(0)} (у двух до шага было ${met.before.toFixed(0)}), ${met.green ? 'зелёный' : 'жёлтый'}` : 'не встретились');
  // Медный провод проложен сквозь металлическую балку (3 ряда): сигнал идёт
  // по меди насквозь, а на клетки балки над и под проводом не попадает.
  const t = new Sim(40, 12);
  box(t, 0, 0, 0, 11, EL.WALL); box(t, 33, 0, 33, 11, EL.WALL);
  t.setCell(1, 5, EL.METAL, false);
  t.pickBeamMaterial(1, 5);
  // Провод целиком внутри балки: снаружи он касался бы её краёв, а другой
  // проводник, касающийся балки, её питает.
  for (let y = 4; y <= 6; y++) for (let x = 2; x <= 32; x++) t.setCell(x, y, EL.BEAM, false);
  t.pickBeamMaterial(-1, -1);
  // Металл, от которого вели балку, убирается: иначе медь отдала бы ему
  // сигнал, а он — металлической балке (своё вещество её питает).
  t.clearCell(t.idx(1, 5));
  box(t, 2, 5, 32, 5, EL.COPPER);
  t.addCharge(t.idx(2, 5), 0, 200);
  let through = false, onBeam = 0;
  for (let k = 0; k < 80; k++) {
    t.step();
    for (const c of t.charges) for (const f of c.front) {
      if (f.i === t.idx(32, 5)) through = true;
      const y = (f.i / t.w) | 0;
      if (y !== 5) onBeam++;
    }
  }
  ok(t.beam[t.idx(10, 4)] === EL.METAL && through && onBeam === 0, `по меди сквозь балку дошёл — ${through ? 'да' : 'нет'}, на клетках балки вне провода фронта ${onBeam}`);
  // Диод (пример пользователя): металл 11111, металлическая балка 22,
  // воздух 0, металл 11111 — вправо идёт, влево нет (через пропуск на
  // балку не перепрыгнуть). Провод толщиной 1 и 3 пикселя. Медь балку не
  // питает. Через пропуск балка отдаёт и монитору, а меди — нет.
  const diode = (fromLeft, leftId, rightId, thick = 1) => {
    const d = new Sim(30, 10);
    box(d, 0, 8, 29, 9, EL.WALL);
    const y0 = 8 - thick;
    d.setCell(1, 7, EL.METAL, false);
    d.pickBeamMaterial(1, 7);
    box(d, 7, y0, 8, 7, EL.BEAM);
    d.pickBeamMaterial(-1, -1);
    box(d, 1, y0, 6, 7, leftId);
    box(d, 10, y0, 14, 7, rightId);
    d.addCharge(d.idx(fromLeft ? 2 : 14, 7), 0, 100);
    const target = d.idx(fromLeft ? 14 : 2, 7);
    for (let k = 0; k < 100; k++) { d.step(); for (const c of d.charges) for (const f of c.front) if (f.i === target) return true; }
    return false;
  };
  const right = diode(true, EL.METAL, EL.METAL), left = diode(false, EL.METAL, EL.METAL);
  const right3 = diode(true, EL.METAL, EL.METAL, 3), left3 = diode(false, EL.METAL, EL.METAL, 3);
  const fromCopper = diode(true, EL.COPPER, EL.METAL), toMon = diode(true, EL.METAL, EL.MONITOR), toCopper = diode(true, EL.METAL, EL.COPPER);
  ok(right && !left && right3 && !left3 && !fromCopper && toMon && !toCopper,
    `металл 11111 22 0 11111: вправо — ${right ? 'да' : 'нет'}, влево — ${left ? 'да' : 'нет'}; толщиной 3: вправо — ${right3 ? 'да' : 'нет'}, влево — ${left3 ? 'да' : 'нет'}; с меди на балку — ${fromCopper ? 'да' : 'нет'}; балка → пропуск → монитор — ${toMon ? 'да' : 'нет'}, → медь — ${toCopper ? 'да' : 'нет'}`);
}

console.log('29. Лампочка: жёлтый зажигает на 7 секунд, зелёный — нет');
{
  const run = (green) => {
    const s = new Sim(40, 10);
    box(s, 0, 7, 39, 9, EL.STONE);
    box(s, 5, 6, 20, 6, EL.COPPER);
    s.setCell(21, 6, EL.LAMP, false);
    s.addCharge(s.idx(5, 6), green ? 1 : 0, 100, green ? { cells: new Int32Array(0), looks: new Int32Array(0), id: 1 } : null);
    let lit = -1;
    for (let k = 0; k < 60 && lit < 0; k++) { s.step(); if (s.life[s.idx(21, 6)] > 0) lit = s.life[s.idx(21, 6)]; }
    const at = s.frame;
    for (let k = 0; k < g('LAMP_CYCLE') + 5; k++) s.step();
    return { lit, after: s.life[s.idx(21, 6)], frames: s.frame - at };
  };
  const y = run(false), gr = run(true);
  ok(y.lit >= g('LAMP_CYCLE') - 2 && y.after === 0 && gr.lit < 0, `жёлтый: зажёг на ${y.lit} кадров, через ${y.frames} — ${y.after ? 'горит' : 'погасла'}; зелёный зажёг — ${gr.lit >= 0 ? 'да' : 'нет'}`);
}

console.log('30. Протагонист: причина смерти; темнота и видимость — в сохранении');
{
  const cause = (setup) => {
    const s = new Sim(20, 20);
    box(s, 0, 15, 19, 19, EL.STONE);
    setup(s);
    for (let k = 0; k < 400 && !s.playerState.death; k++) s.step();
    return s.playerState.death;
  };
  const lava = cause((s) => { s.placeProtagonist(s.idx(8, 14)); s.setCell(7, 14, EL.LAVA, false); s.setCell(9, 14, EL.LAVA, false); });
  const water = cause((s) => { box(s, 2, 5, 3, 14, EL.WALL); box(s, 14, 5, 15, 14, EL.WALL); box(s, 4, 6, 13, 14, EL.WATER); s.placeProtagonist(s.idx(8, 14)); });
  ok(lava === 'Сгорел в лаве' && water === 'Утонул', `у лавы — «${lava}», под водой — «${water}»`);
  const s = new Sim(20, 20);
  s.darkness = 3; s.playerVision = 2;
  const t = new Sim(20, 20);
  t.deserialize(JSON.parse(JSON.stringify(s.serialize())));
  const u = new Sim(20, 20);
  const old = s.serialize(); delete old.darkness; delete old.vision;
  u.darkness = 2; u.deserialize(old);
  ok(t.darkness === 3 && t.playerVision === 2 && u.darkness === 1 && u.playerVision === 3,
    `из файла: темнота ${t.darkness}, видимость ${t.playerVision}; старый файл — ${u.darkness} и ${u.playerVision}`);
}

console.log('31. Изолятор растворяется в воде в чёрные соли; электрический разряд');
{
  // Изолятор на дне ванны с водой; ванна из стены.
  const s = new Sim(30, 20);
  box(s, 0, 16, 29, 19, EL.WALL); box(s, 0, 5, 1, 15, EL.WALL); box(s, 28, 5, 29, 15, EL.WALL);
  box(s, 5, 15, 24, 15, EL.INSULATOR);
  box(s, 2, 8, 27, 14, EL.WATER);
  const ins0 = count(s, EL.INSULATOR);
  let salts = 0;
  for (let k = 0; k < 1500; k++) {
    s.step();
    for (let i = 0; i < s.type.length; i++) if (solGet(s.comp(i), EL.BLACK_SALT) > 0) { salts = 1; break; }
  }
  ok(count(s, EL.INSULATOR) < ins0 && salts, `изолятора было ${ins0}, осталось ${count(s, EL.INSULATOR)}; чёрные соли появились — ${salts ? 'да' : 'нет'}`);
  // Разряд: по металлу пускается, в камень — нет; рядом с проводником в
  // пределах кисти — в него.
  const z = new Sim(30, 10);
  box(z, 0, 8, 29, 9, EL.WALL);
  box(z, 5, 7, 20, 7, EL.METAL);
  box(z, 22, 7, 25, 7, EL.STONE);
  const onMetal = z.zapAt(10, 7), onStone = z.zapAt(23, 7), near = z.zapAt(12, 5, 2, 2);
  ok(onMetal && !onStone && near && z.charges.length === 2, `разряд в металл — ${onMetal ? 'да' : 'нет'}, в камень — ${onStone ? 'да' : 'нет'}, рядом с металлом в пределах кисти — ${near ? 'да' : 'нет'}`);
}

console.log('32. Человек: спуск не выше 3 пикселей, прыжок на 2, карта опасных мест');
{
  const humanAt = (s) => { for (let i = 0; i < s.type.length; i++) if (s.type[i] === EL.HUMAN) return i; return -1; };
  // Полка на высоте drop над полом, человек на полке — сойдёт ли вниз.
  const descends = (drop) => {
    const s = new Sim(60, 30);
    box(s, 0, 25, 59, 29, EL.WALL);
    box(s, 0, 25 - drop, 30, 24, EL.WALL);        // полка слева
    box(s, 0, 0, 0, 24, EL.WALL); box(s, 59, 0, 59, 24, EL.WALL);
    s.setCell(20, 24 - drop, EL.HUMAN, false);
    let down = false;
    for (let k = 0; k < 3000 && !down; k++) { s.step(); const p = humanAt(s); if (p >= 0 && ((p / s.w) | 0) === 24) down = true; }
    return down;
  };
  const d3 = descends(3), d5 = descends(5);
  ok(d3 && !d5, `с полки высотой 3 спустился — ${d3 ? 'да' : 'нет'}, высотой 5 — ${d5 ? 'да' : 'нет'}`);
  // Стенка высотой wall поперёк коридора — перелезет ли.
  const crosses = (wall) => {
    const s = new Sim(60, 30);
    box(s, 0, 25, 59, 29, EL.WALL);
    box(s, 0, 0, 0, 24, EL.WALL); box(s, 59, 0, 59, 24, EL.WALL);
    box(s, 30, 25 - wall, 31, 24, EL.WALL);
    s.setCell(10, 24, EL.HUMAN, false);
    let over = false;
    for (let k = 0; k < 4000 && !over; k++) { s.step(); const p = humanAt(s); if (p >= 0 && p % s.w > 31) over = true; }
    return over;
  };
  const w2 = crosses(2), w3 = crosses(3);
  ok(w2 && !w3, `стенку в 2 пикселя перелез — ${w2 ? 'да' : 'нет'}, в 3 — ${w3 ? 'да' : 'нет'}`);
  // Кислота в стеклянной чаше справа: сквозь стекло её видно, вытечь она не
  // может. Увидел — участок в карте; кислоту убрали, а к чаше он всё равно
  // не подходит (без карты дошёл бы до её стенки на x=45).
  const s = new Sim(80, 20);
  box(s, 0, 15, 79, 19, EL.WALL);
  box(s, 0, 0, 0, 14, EL.WALL); box(s, 79, 0, 79, 14, EL.WALL);
  box(s, 46, 11, 52, 14, EL.GLASS); box(s, 47, 11, 51, 13, EL.EMPTY);
  box(s, 47, 12, 51, 13, EL.ACID);
  s.setCell(20, 14, EL.HUMAN, false);
  let banned = 0;
  for (let k = 0; k < 6000 && !banned; k++) {
    s.step();
    const p = humanAt(s), mind = p >= 0 ? s._humans.get(s.life[p]) : null;
    if (mind) banned = mind.bans.size;
  }
  box(s, 47, 12, 51, 13, EL.EMPTY);   // кислоту убрали
  let maxX = 0;
  for (let k = 0; k < 4000; k++) { s.step(); const p = humanAt(s); if (p >= 0) maxX = Math.max(maxX, p % s.w); }
  ok(banned > 0 && maxX < 44, `в карте опасных участков ${banned}; после того как кислоту убрали, правее x=${maxX} не заходил (стенка чаши на x=46)`);
}

console.log('33. Человек: ядовитый газ — только под крышей; обвал — опасное место; люди прозрачны для взгляда');
{
  const humanAt = (s) => { for (let i = 0; i < s.type.length; i++) if (s.type[i] === EL.HUMAN) return i; return -1; };
  // Слева навес из стены (x 2..20), справа открыто. Над открытой частью —
  // туча кислотного газа. Человек на открытом месте уходит под навес, а
  // когда тучу убрали, под открытое небо в тех столбцах больше не выходит.
  const s = new Sim(80, 30);
  box(s, 0, 25, 79, 29, EL.WALL);
  box(s, 0, 0, 0, 24, EL.WALL); box(s, 79, 0, 79, 24, EL.WALL);
  box(s, 2, 15, 20, 15, EL.WALL);                 // навес
  box(s, 30, 2, 50, 3, EL.ACID_GAS);              // туча
  s.setCell(40, 24, EL.HUMAN, false);
  // Туча держится 400 кадров (кислотный дождь из неё стирается, чтобы не
  // убил), потом её убирают.
  let gasCols = 0, under = false;
  for (let k = 0; k < 400; k++) {
    s.step();
    for (let i = 0; i < s.type.length; i++) if (s.type[i] === EL.ACID || s.type[i] === EL.SOLUTION) s.clearCell(i);
    const p = humanAt(s), mind = p >= 0 ? s._humans.get(s.life[p]) : null;
    if (mind) gasCols = mind.gas.size;
    if (p >= 0 && p % s.w <= 20) under = true;
  }
  for (let i = 0; i < s.type.length; i++) if (s.type[i] !== EL.WALL && s.type[i] !== EL.HUMAN && s.type[i] !== EL.EMPTY) s.clearCell(i);
  // Тучи больше нет; следим, выходит ли он под открытое небо там, где она была.
  let outInGas = 0;
  for (let k = 0; k < 3000; k++) {
    s.step();
    const p = humanAt(s);
    if (p >= 0) { const x = p % s.w; if (x >= 30 && x <= 50) outInGas++; }
  }
  ok(gasCols > 0 && under && outInGas === 0, `столбцов газа в памяти ${gasCols}; ушёл под навес — ${under ? 'да' : 'нет'}; потом под открытым небом там, где была туча, кадров ${outInGas}`);

  // Обвал: каменная полка без опоры падает у него на глазах — участок в карте.
  const c = new Sim(60, 30);
  box(c, 0, 25, 59, 29, EL.WALL);
  box(c, 30, 10, 40, 12, EL.STONE);              // висит без опоры и падает
  c.setCell(26, 24, EL.HUMAN, false);
  let bans = 0;
  for (let k = 0; k < 60; k++) { c.step(); const p = humanAt(c), m = p >= 0 ? c._humans.get(c.life[p]) : null; if (m) bans = Math.max(bans, m.bans.size); }
  ok(bans > 0, `увидел обвал: опасных участков в памяти ${bans}`);

  // Провал: человек на каменной полке, у полки убирают опору — она падает
  // вместе с ним. Место, где он стоял, — опасный участок.
  const f = new Sim(60, 30);
  box(f, 0, 25, 59, 29, EL.WALL);
  box(f, 19, 5, 19, 15, EL.WALL);                 // опора полки
  box(f, 20, 15, 34, 15, EL.STONE);               // полка
  f.setCell(28, 14, EL.HUMAN, false);
  f.extra[f.idx(28, 14)] = 0;
  for (let k = 0; k < 30; k++) f.step();
  const before = (() => { const p = humanAt(f), m = p >= 0 ? f._humans.get(f.life[p]) : null; return m ? m.bans.size : -1; })();
  box(f, 19, 5, 19, 15, EL.EMPTY);                // опору убрали
  let fellBans = 0;
  for (let k = 0; k < 40; k++) { f.step(); const p = humanAt(f), m = p >= 0 ? f._humans.get(f.life[p]) : null; if (m) fellBans = Math.max(fellBans, m.bans.size); }
  ok(before === 0 && fellBans > 0, `до провала опасных участков ${before}, после — ${fellBans}`);

  // Прозрачность: камера видит камень за человеком.
  const v = new Sim(40, 20);
  box(v, 0, 15, 39, 19, EL.WALL);
  v.setCell(5, 14, EL.CAMERA, false);
  v.setCell(10, 14, EL.HUMAN, false); v.extra[v.idx(10, 14)] = 1;   // мёртвый — не уйдёт
  v.setCell(20, 14, EL.STONE, false);
  const seenStone = Array.from(v.cameraScan(v.idx(5, 14)).cells).includes(v.idx(20, 14));
  ok(seenStone, `камера видит камень за человеком — ${seenStone ? 'да' : 'нет'}`);
}

console.log('34. Мультиплеер: несколько протагонистов, безопасный спавн, точки респавна');
{
  const s = new Sim(80, 30);
  box(s, 0, 25, 79, 29, EL.WALL);
  box(s, 40, 22, 45, 24, EL.LAVA);
  // Протагонисты игроков 1 и 2 и одиночной игры (0) — каждый свой.
  s.placePlayer(1, s.idx(10, 24)); s.placePlayer(2, s.idx(20, 24)); s.placeProtagonist(s.idx(30, 24));
  const p1 = s.findProtagonist(1), p2 = s.findProtagonist(2), p0 = s.findProtagonist(0);
  ok(p1 === s.idx(10, 24) && p2 === s.idx(20, 24) && p0 === s.idx(30, 24) && s.life[p2] === 2,
    `на поле трое: игрок 1 на x=${p1 % s.w}, игрок 2 на x=${p2 % s.w}, одиночный на x=${p0 % s.w}`);
  // Управление у каждого своё: игрок 2 идёт вправо, игрок 1 стоит.
  s.playerSlot(2).input.right = true;
  for (let k = 0; k < 20; k++) s.step();
  ok(s.findProtagonist(2) % s.w > 20 && s.findProtagonist(1) % s.w === 10, `игрок 2 ушёл на x=${s.findProtagonist(2) % s.w}, игрок 1 остался на x=${s.findProtagonist(1) % s.w}`);
  s.playerSlot(2).input.right = false;
  // Безопасное место: не у лавы, на опоре.
  let bad = 0;
  for (let k = 0; k < 200; k++) {
    const i = s.findSafeSpawn(), x = i % s.w, y = (i / s.w) | 0;
    if (i < 0 || y !== 24 || (x >= 39 && x <= 46)) bad++;
  }
  ok(bad === 0, `200 случайных безопасных мест — неподходящих ${bad}`);
  // Точки респавна: одна только для игрока 2 и смерти в огне, другая для всех.
  s.addRespawnMark(60, 24); s.setRespawnMarkProps(60, 24, { players: [2], kinds: ['fire'] });
  s.addRespawnMark(70, 24);
  const forFire = new Set(), forOther = new Set();
  for (let k = 0; k < 40; k++) { forFire.add(s.respawnSpot(2, 'fire') % s.w); forOther.add(s.respawnSpot(1, 'fire') % s.w); }
  ok(forFire.has(60) && forFire.has(70) && !forOther.has(60), `игрок 2 после огня — на x=${[...forFire].join(',')}; игрок 1 — на x=${[...forOther].join(',')}`);
  // Метки — в файле сохранения.
  s.setSpawnMark(5, 24, 1);
  const t = new Sim(80, 30);
  t.deserialize(JSON.parse(JSON.stringify(s.serialize())));
  ok(t.spawnMarks.length === 1 && t.respawnMarks.length === 2 && t.respawnMarks[0].players[0] === 2,
    `из файла: точек спавна ${t.spawnMarks.length}, респавна ${t.respawnMarks.length}`);
}

console.log('35. Твёрдое скатывается со склона; кисть не стирает живого игрока');
{
  // Склон 45° (камень, вниз вправо) переходит в ровное дно на 55. Блок
  // железа 6x6 падает на склон углом — центр масс за краем опоры, и он
  // съезжает целиком до ровного места (просьба пользователя). Раньше
  // застывал на склоне, нависнув углом.
  const s = new Sim(80, 70);
  for (let x = 0; x < 80; x++) box(s, x, Math.min(20 + x, 55), x, 69, EL.STONE);
  box(s, 8, 0, 13, 5, EL.METAL);
  for (let k = 0; k < 300; k++) s.step();
  let n = 0, x0 = 99, x1 = -1, y0 = 99, y1 = -1;
  for (let i = 0; i < s.type.length; i++) {
    if (s.type[i] !== EL.METAL) continue;
    const x = i % 80, y = (i / 80) | 0;
    n++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  ok(n === 36 && x1 - x0 === 5 && y1 - y0 === 5 && y1 === 54 && x0 >= 35, `блок 6x6 цел (${n} клеток, ${x1 - x0 + 1}x${y1 - y0 + 1}), внизу на ${y1} (дно 55), слева x=${x0} (склон кончается на 35)`);
  // Ровно стоящий на полу блок не едет.
  const f = new Sim(40, 40);
  box(f, 0, 30, 39, 39, EL.STONE);
  box(f, 15, 10, 20, 15, EL.METAL);
  for (let k = 0; k < 100; k++) f.step();
  let fx = -1; for (let i = 0; i < f.type.length; i++) if (f.type[i] === EL.METAL) { fx = i % 40; break; }
  ok(fx === 15 && lowest(f, EL.METAL) === 29, `блок на ровном полу встал на ${lowest(f, EL.METAL)}, x=${fx} — не съехал`);
  // Живого протагониста кисть не трогает: ни ластик, ни замена, ни
  // заливка; мёртвое тело стирается.
  const p = new Sim(30, 20);
  box(p, 0, 15, 29, 19, EL.STONE);
  p.placePlayer(2, p.idx(10, 14));
  p.stampBrush(10, 14, 'circle', 3, 3, EL.EMPTY, false);
  p.stampBrush(10, 14, 'circle', 3, 3, EL.SAND, false);
  p.floodFill(10, 14, EL.WATER, false);
  const alive = p.type[p.idx(10, 14)] === EL.PROTAGONIST;
  p.extra[p.idx(10, 14)] = 1;
  p.setCell(10, 14, EL.EMPTY, false);
  ok(alive && p.type[p.idx(10, 14)] === EL.EMPTY, `живой игрок пережил ластик, замену и заливку — ${alive ? 'да' : 'нет'}; мёртвое тело стёрто — ${p.type[p.idx(10, 14)] === EL.EMPTY ? 'да' : 'нет'}`);
  // Ластик и вырезание стирают точки спавна и респавна (раньше точку
  // респавна было не убрать ничем, кроме ПКМ её же инструментом).
  p.addRespawnMark(20, 14); p.setSpawnMark(5, 14, 1); p.addRespawnMark(25, 10);
  p.stampBrush(20, 14, 'circle', 1, 1, EL.EMPTY, false);
  p.clearRegion(3, 12, 7, 14);
  ok(p.respawnMarks.length === 1 && p.spawnMarks.length === 0 && p.respawnMarks[0].x === 25, `после ластика и вырезания: точек респавна ${p.respawnMarks.length} (осталась нетронутая), спавна ${p.spawnMarks.length}`);
}

console.log('36. Протагонист ломает пиксели: удары по стойкости, сыпучее — 2, темнеет; стена не ломается');
{
  // Протагонист на полу, справа вплотную — пиксель; ЛКМ зажата, курсор
  // далеко справа: линия упирается в этот пиксель.
  const mine = (id) => {
    const s = new Sim(30, 12);
    box(s, 0, 10, 29, 11, EL.WALL);
    s.placeProtagonist(s.idx(10, 9));
    s.setCell(11, 9, id, false);
    s.setCell(11, 8, EL.WALL, false);   // чтобы сыпучее не осыпалось и не мешало
    const j = s.idx(11, 9), shade0 = s.shade[j];
    const inp = s.playerInput;
    inp.mine = true; inp.ax = 25; inp.ay = 9;
    let frames = 0, shadeAfterHit = null;
    for (; frames < 400 && s.type[j] === id; frames++) {
      s.step();
      if (shadeAfterHit === null && s.playerState.mineHits === 1) shadeAfterHit = s.shade[j];
    }
    return { broken: s.type[j] !== id, frames, darker: shadeAfterHit !== null && shadeAfterHit < shade0 };
  };
  const stone = mine(EL.STONE), sand = mine(EL.SAND), wall = mine(EL.WALL);
  // Камень: стойкость 5 — пять ударов, удар раз в 10 кадров (первый сразу).
  ok(stone.broken && stone.frames >= 40 && stone.frames <= 45 && stone.darker, `камень сломан за ${stone.frames} кадров (5 ударов по 10), после удара темнее — ${stone.darker ? 'да' : 'нет'}`);
  ok(sand.broken && sand.frames <= 15, `песок сломан за ${sand.frames} кадров (2 удара)`);
  ok(!wall.broken, 'стена не ломается');
  // Не вплотную — не ломается.
  const f = new Sim(30, 12);
  box(f, 0, 10, 29, 11, EL.WALL);
  f.placeProtagonist(f.idx(10, 9));
  f.setCell(13, 9, EL.STONE, false);
  f.playerInput.mine = true; f.playerInput.ax = 25; f.playerInput.ay = 9;
  for (let k = 0; k < 100; k++) f.step();
  ok(f.type[f.idx(13, 9)] === EL.STONE, 'камень через две клетки (в трёх от протагониста) не ломается');
  // Дотягивается на 2 клетки (MINE_REACH); на пути другой пиксель — ломает
  // сперва его (просьба пользователя).
  const r2 = new Sim(30, 12);
  box(r2, 0, 10, 29, 11, EL.WALL);
  r2.placeProtagonist(r2.idx(10, 9));
  r2.setCell(12, 9, EL.STONE, false);
  r2.playerInput.mine = true; r2.playerInput.ax = 25; r2.playerInput.ay = 9;
  for (let k = 0; k < 80; k++) r2.step();
  const far = r2.type[r2.idx(12, 9)] !== EL.STONE;
  const r3 = new Sim(30, 12);
  box(r3, 0, 10, 29, 11, EL.WALL);
  r3.placeProtagonist(r3.idx(10, 9));
  r3.setCell(11, 9, EL.SAND, false); r3.setCell(11, 8, EL.WALL, false); r3.setCell(12, 9, EL.STONE, false);
  r3.playerInput.mine = true; r3.playerInput.ax = 25; r3.playerInput.ay = 9;
  for (let k = 0; k < 15; k++) r3.step();
  const nearFirst = r3.type[r3.idx(11, 9)] !== EL.SAND && r3.type[r3.idx(12, 9)] === EL.STONE;
  ok(far && nearFirst, `камень в двух клетках сломан — ${far}; песок на пути сломан первым, камень за ним цел — ${nearFirst}`);
  // В мультиплеере кисть протагониста ставит точку спавна хоста.
  const m = new Sim(20, 10);
  m.protagonistAsSpawn = 1;
  m.setCell(5, 5, EL.PROTAGONIST, false);
  ok(m.findProtagonist(0) < 0 && m.spawnMarks.length === 1 && m.spawnMarks[0].n === 1 && m.spawnMarks[0].x === 5, `кисть протагониста в мультиплеере — точка спавна хоста (точек ${m.spawnMarks.length})`);
}

console.log('37. Игрок на игроке: едет с нижним, обгоняет на клетку, вдвоём — уступ в 4');
{
  const pos = (s, n) => { const i = s.findProtagonist(n); return i < 0 ? [-1, -1] : [i % s.w, (i / s.w) | 0]; };
  const pair = (ledge) => {
    const s = new Sim(40, 20);
    box(s, 0, 18, 39, 19, EL.WALL);
    if (ledge) box(s, 14, 14, 39, 17, EL.WALL);   // уступ высотой 4
    s.placePlayer(1, s.idx(ledge ? 12 : 10, 17)); s.placePlayer(2, s.idx(ledge ? 12 : 10, 16));
    for (let k = 0; k < 5; k++) s.step();
    return s;
  };
  // Нижний идёт — верхний едет на нём.
  const a = pair(false);
  a.playerSlot(1).input.right = true;
  for (let k = 0; k < 20; k++) a.step();
  ok(pos(a, 1)[0] === 20 && pos(a, 2)[0] === 20 && pos(a, 2)[1] === 16, `нижний дошёл до x=${pos(a, 1)[0]}, верхний на нём: x=${pos(a, 2)[0]}, y=${pos(a, 2)[1]}`);
  // Оба идут — верхний на клетку впереди.
  const b = pair(false);
  b.playerSlot(1).input.right = true; b.playerSlot(2).input.right = true;
  for (let k = 0; k < 12; k++) b.step();
  ok(pos(b, 2)[0] === pos(b, 1)[0] + 1, `оба идут: нижний x=${pos(b, 1)[0]}, верхний x=${pos(b, 2)[0]} — на клетку впереди`);
  // Нижний прыгает, верхний прыгает с него — уступ в 4 клетки взят.
  const c = pair(true);
  c.playerSlot(1).input.jump = true;
  for (let k = 0; k < 40; k++) {
    if (k === 3) c.playerSlot(2).input.jump = true;
    c.playerSlot(2).input.right = k > 5;
    c.step();
  }
  ok(pos(c, 2)[1] === 13 && pos(c, 2)[0] > 14, `верхний забрался на уступ в 4 клетки: x=${pos(c, 2)[0]}, y=${pos(c, 2)[1]} (верх уступа — 13)`);
  // Один — не может.
  const d = new Sim(40, 20);
  box(d, 0, 18, 39, 19, EL.WALL); box(d, 14, 14, 39, 17, EL.WALL);
  d.placePlayer(2, d.idx(12, 17));
  for (let k = 0; k < 5; k++) d.step();
  for (let k = 0; k < 40; k++) { if (k === 1) d.playerSlot(2).input.jump = true; d.playerSlot(2).input.right = true; d.step(); }
  ok(pos(d, 2)[1] === 17, `один на уступ в 4 не забрался: y=${pos(d, 2)[1]}`);
}

console.log('38. Грязь растворяется в воде, как чёрные соли; грязь не пропадает');
{
  const solWith = g('solWith'), solPure = g('solPure');
  const MUD_DIRT_PER_PART = g('MUD_DIRT_PER_PART');
  // Сколько грязи всего: доли в клетках плюс отложенное на пикселях.
  const mudTotal = (s) => { let n = 0; for (let i = 0; i < s.type.length; i++) n += solGet(s.comp(i), EL.MUD) * MUD_DIRT_PER_PART + s.dirt[i]; return n / MUD_DIRT_PER_PART; };
  const s = new Sim(40, 40);
  box(s, 0, 38, 39, 39, EL.WALL); box(s, 0, 8, 0, 37, EL.WALL); box(s, 39, 8, 39, 37, EL.WALL);
  box(s, 1, 12, 38, 37, EL.WATER);
  box(s, 17, 2, 22, 6, EL.MUD);
  const m0 = mudTotal(s);
  for (let k = 0; k < 600; k++) s.step();
  let powder = 0, turbid = 0;
  for (let i = 0; i < s.type.length; i++) { if (s.type[i] === EL.MUD) powder++; else if (solGet(s.comp(i), EL.MUD)) turbid++; }
  const m1 = mudTotal(s);
  ok(m1 === m0 && powder < 15 && turbid > 100, `30 клеток грязи в баке через 600 кадров: сыпучей осталось ${powder}, мутных клеток ${turbid}; грязи было ${m0} долей, стало ${m1}`);

  console.log('39. Мутная вода откладывает грязь на пиксели, чистая забирает обратно');
  // Каменный блок в мутной воде (доля грязи на 9 воды), потом воду меняют
  // на чистую: грязь с камня уходит в воду.
  const t = new Sim(30, 30);
  box(t, 0, 28, 29, 29, EL.WALL); box(t, 0, 5, 0, 27, EL.WALL); box(t, 29, 5, 29, 27, EL.WALL);
  box(t, 10, 18, 19, 27, EL.STONE);
  const fill = (mud) => {
    for (let y = 6; y <= 27; y++) for (let x = 1; x <= 28; x++) {
      const i = t.idx(x, y);
      if (t.type[i] === EL.STONE) continue;
      t.spawn(i, EL.WATER);
      if (mud) t.setComposition(i, solWith(solPure(EL.WATER, 9), EL.MUD, 1));
    }
  };
  const onStone = () => { let n = 0, sum = 0; for (let y = 18; y <= 27; y++) for (let x = 10; x <= 19; x++) { const d = t.dirt[t.idx(x, y)]; sum += d; if (d) n++; } return { n, parts: sum / MUD_DIRT_PER_PART }; };
  fill(true);
  const before = mudTotal(t);
  for (let k = 0; k < 400; k++) t.step();
  const dirty = onStone(), after = mudTotal(t);
  fill(false);
  for (let k = 0; k < 900; k++) t.step();
  const clean = onStone();
  let inWater = 0; for (let i = 0; i < t.type.length; i++) inWater += solGet(t.comp(i), EL.MUD);
  const inner = t.dirt[t.idx(14, 22)];
  ok(dirty.n >= 15 && after === before && clean.parts < dirty.parts / 3 && inWater > 0 && inner === 0,
    `на камне осело ${dirty.parts.toFixed(0)} долей на ${dirty.n} пикселях (грязи всего ${before} → ${after}); после чистой воды на камне ${clean.parts.toFixed(1)}, ушло в воду ${inWater}; внутри блока — ${inner}`);
}

console.log('40. Отравление реагентом, сыпучие растворы, цвет грязи, спавн у открытого места');
{
  const solColor = g('solColor'), solWith = g('solWith'), solPure = g('solPure'), PART_COLOR = g('PART_COLOR'), MUD_DARK_COLOR = g('MUD_DARK_COLOR');
  // Протагонист касается реагента: желтеет, живёт, потом рассыпается окислом.
  const p = new Sim(20, 10);
  box(p, 0, 8, 19, 9, EL.WALL);
  p.placeProtagonist(p.idx(5, 7));
  p.setCell(6, 7, EL.REAGENT, false); p.setCell(6, 6, EL.WALL, false); p.setCell(7, 7, EL.WALL, false);
  for (let k = 0; k < 20; k++) p.step();
  const pi = p.findProtagonist(0), early = pi >= 0 ? p.stain[pi] : -1, aliveEarly = pi >= 0 && p.extra[pi] === 0;
  let frames = 20;
  for (; frames < 400 && p.findProtagonist(0) >= 0; frames++) p.step();
  // Чистый реагент — смертельная доза за полторы секунды (~90 кадров).
  ok(aliveEarly && early >= 40 && p.type[p.idx(5, 7)] === EL.OXIDE_LOOSE && p.playerState.death === 'Отравлен реагентом' && frames >= 80 && frames <= 100,
    `протагонист у реагента: через 20 кадров жив и желтеет (${early}), погиб на кадре ${frames} — рассыпался окислом (${p.type[p.idx(5, 7)] === EL.OXIDE_LOOSE}), причина: ${p.playerState.death}`);
  // Отравленный человек без яда рядом — приходит в себя (просьба
  // пользователя: отошёл от реагента — перестаёшь желтеть).
  const hs = new Sim(20, 10);
  box(hs, 0, 8, 19, 9, EL.WALL);
  hs.setCell(5, 7, EL.HUMAN, false);
  hs.stain[hs.idx(5, 7)] = 200;
  for (let k = 0; k < 450; k++) hs.step();
  let hum = -1; for (let i = 0; i < hs.type.length; i++) if (hs.type[i] === EL.HUMAN) hum = i;
  ok(hum >= 0 && hs.stain[hum] < 200 && hs.stain[hum] > 180, `отравленный (200) человек без яда рядом жив и медленно приходит в себя: ${hum >= 0 ? hs.stain[hum] : 'погиб'} за 450 кадров`);
  // Окисел камня: третья стадия травит втрое быстрее первой.
  const oxRate = (stage) => {
    const o = new Sim(20, 10);
    box(o, 0, 8, 19, 9, EL.WALL);
    o.placeProtagonist(o.idx(5, 7));
    o.setCell(6, 7, EL.STONE, false); o.setOxideStage(o.idx(6, 7), stage);
    for (let k = 0; k < 120; k++) o.step();
    const j = o.findProtagonist(0);
    return j >= 0 ? o.stain[j] : 255;
  };
  const ox1 = oxRate(1), ox3 = oxRate(3);
  ok(ox1 > 5 && ox3 > ox1 * 2, `окисел камня за 2 с: первая стадия — ${ox1}, третья — ${ox3}`);
  // Копание: множитель скорости (0 — нельзя), выносливость тратится.
  // Сколько кадров ломается камень вплотную (стойкость 5) при скорости speed.
  const dig = (speed) => {
    const d = new Sim(30, 10);
    box(d, 0, 8, 29, 9, EL.WALL);
    d.placeProtagonist(d.idx(5, 7));
    d.setCell(6, 7, EL.STONE, false);
    if (speed !== null) d.digSpeed = speed;
    d.playerInput.mine = true; d.playerInput.ax = 25; d.playerInput.ay = 7;
    let k = 0, minSt = 999;
    for (; k < 200 && d.type[d.idx(6, 7)] === EL.STONE; k++) { d.step(); minSt = Math.min(minSt, d.playerState.stamina); }
    return { frames: k, minSt };
  };
  const d0 = dig(0), d10 = dig(null), d20 = dig(20);
  ok(d0.frames === 200 && d10.frames >= 38 && d10.frames <= 45 && d20.frames < d10.frames * 0.7 && d10.minSt < 300,
    `камень ломается: скорость 0 — никогда (${d0.frames}), 10 — за ${d10.frames} кадров, 20 — за ${d20.frames}; выносливость упала до ${d10.minSt}`);
  // Удары: человека — три удара, кровь вокруг; игрока — только с огнём по
  // своим; урон заживает.
  const hit = new Sim(30, 10);
  box(hit, 0, 8, 29, 9, EL.WALL);
  hit.placeProtagonist(hit.idx(5, 7));
  hit.setCell(6, 7, EL.HUMAN, false); hit.setCell(7, 7, EL.WALL, false); hit.setCell(6, 6, EL.WALL, false);
  hit.playerInput.mine = true; hit.playerInput.ax = 20; hit.playerInput.ay = 7;
  let hk = 0; for (; hk < 100 && hit.type[hit.idx(6, 7)] === EL.HUMAN; hk++) hit.step();
  let blood = 0; for (let i = 0; i < hit.stain.length; i++) if (hit.stain[i]) blood++;
  ok(hit.type[hit.idx(6, 7)] !== EL.HUMAN && hk >= 20 && hk <= 25 && blood > 0, `человек убит за ${hk} кадров (три удара по 10), крови вокруг — ${blood} клеток`);
  const ff = (on) => {
    const f = new Sim(30, 10);
    box(f, 0, 8, 29, 9, EL.WALL);
    f.placePlayer(1, f.idx(5, 7)); f.placePlayer(2, f.idx(6, 7)); f.setCell(7, 7, EL.WALL, false);
    f.friendlyFire = on;
    const inp = f.playerSlot(1).input; inp.mine = true; inp.ax = 20; inp.ay = 7;
    for (let k = 0; k < 15; k++) f.step();
    return f.dirt[f.findProtagonist(2)];
  };
  const offHurt = ff(false), onHurt = ff(true);
  ok(offHurt === 0 && onHurt > 0, `по своему игроку: без огня по своим урон ${offHurt}, с ним — ${onHurt}`);
  const heal = new Sim(20, 10); box(heal, 0, 8, 19, 9, EL.WALL); heal.setCell(5, 7, EL.HUMAN, false); heal.dirt[heal.idx(5, 7)] = 85;
  for (let k = 0; k < 300; k++) heal.step();
  let hh = -1; for (let i = 0; i < heal.type.length; i++) if (heal.type[i] === EL.HUMAN) hh = i;
  ok(hh >= 0 && heal.dirt[hh] === 0, `ударенный человек зажил: урон ${hh >= 0 ? heal.dirt[hh] : '—'}`);
  // Земля падает на чёрные соли — смешивается; лежащие рядом — нет.
  const m = new Sim(20, 30);
  box(m, 0, 28, 19, 29, EL.WALL);
  box(m, 5, 22, 14, 27, EL.BLACK_SALT);
  box(m, 5, 2, 14, 6, EL.EARTH);
  for (let k = 0; k < 60; k++) m.step();
  let mixed = 0; for (let i = 0; i < m.type.length; i++) { const c = m.comp(i); if (solGet(c, EL.EARTH) && solGet(c, EL.BLACK_SALT)) mixed++; }
  const r = new Sim(20, 30);
  box(r, 0, 28, 19, 29, EL.WALL);
  // В коробе: края свободной стопки осыпаются — это движение, и там они
  // смешиваются по праву.
  box(r, 4, 14, 4, 27, EL.WALL); box(r, 15, 14, 15, 27, EL.WALL);
  box(r, 5, 22, 14, 27, EL.BLACK_SALT); box(r, 5, 16, 14, 21, EL.EARTH);
  for (let k = 0; k < 60; k++) r.step();
  let restMixed = 0; for (let i = 0; i < r.type.length; i++) { const c = r.comp(i); if (solGet(c, EL.EARTH) && solGet(c, EL.BLACK_SALT)) restMixed++; }
  ok(mixed > 0 && restMixed === 0, `земля, упавшая на соли: смешанных клеток ${mixed}; лежащая на солях с самого начала — ${restMixed}`);
  // Грязь: 5 долей с водой — ровно цвет грязи, 10 — темнее.
  const c5 = solColor(solWith(solPure(EL.WATER, 5), EL.MUD, 5)), c10 = solColor(solPure(EL.MUD));
  const mc = PART_COLOR[EL.MUD];
  ok(c5.every((v, k) => Math.round(v) === mc[k]) && c10.every((v, k) => Math.round(v) === MUD_DARK_COLOR[k]),
    `цвет: 5 грязи + 5 воды = ${c5.map(Math.round)} (грязь ${mc}), чистая грязь = ${c10.map(Math.round)}`);
  // Спавн: безопасное место в закрытой пещере и на открытой поверхности —
  // выбирается открытое.
  const sp = new Sim(40, 30);
  box(sp, 0, 20, 39, 29, EL.STONE);
  box(sp, 5, 10, 15, 19, EL.STONE); box(sp, 7, 12, 13, 16, EL.EMPTY);   // пещера внутри камня
  let inCave = 0;
  for (let k = 0; k < 40; k++) { const i = sp.findSafeSpawn(); const x = i % 40, y = (i / 40) | 0; if (x >= 7 && x <= 13 && y >= 12 && y <= 16) inCave++; }
  ok(inCave === 0, `спавн из 40 раз ни разу не в закрытой пещере (${inCave})`);
}

console.log(fails ? `\nПРОВАЛОВ: ${fails}` : '\nВСЁ OK');
process.exit(fails ? 1 : 0);
