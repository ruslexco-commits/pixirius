'use strict';

// Химия: кислота разъедает, реагент окисляет и гасится водой, вода ржавит
// металл, выделение газов при растворении, кислотный остаток.
//
// Методы класса Sim, вынесенные в отдельный файл: класс ниже — только
// контейнер, extendSim переносит его методы в Sim.prototype (см. core.js).

// Газообразное масло — единственное, что переходит обратно НЕ по
// температуре, а по сроку: 1-3 минуты при 60 кадрах в секунду.
const OIL_GAS_LIFE_MIN = 3600, OIL_GAS_LIFE_MAX = 10800;

// Окисление камня реагентом идёт в OXIDISE_SLOWER раз медленнее, чем
// растворение кислотой, и лишь в OXIDISE_COST случаев стоит реагенту доли
// — в отличие от кислоты, которая тратит долю на каждое растворение.
const OXIDISE_SLOWER = 5;
const OXIDISE_COST = 0.5;
// Кислота, встретив металл, с этим шансом не растворяет его, а окисляет —
// и в любом случае тратит на это свою долю.
const ACID_OXIDISE_METAL = 0.5;
// Вода тоже ржавит металл — медленно, но каждая удавшаяся попытка
// гарантированно съедает её долю (в отличие от реагента, который платит
// через раз).
const WATER_RUST_SLOWER = 5;
// Ржавление проверяется не каждый кадр, а по этому броску. Причина
// чисто вычислительная: клеток воды на карте бывают десятки тысяч, и
// обход четырёх соседей у каждой из них в каждом кадре стоил дороже, чем
// вся остальная химия вместе (замер: кадр 16 -> 29 мс). Реже проверять
// дешевле, чем проверять всем: на глаз ржавчина всё равно ползёт
// медленно, а лишняя работа уходит.
const RUST_TICK_CHANCE = 0.25;
// Изолятор растворяется в воде (просьба пользователя): клетка воды (или
// раствора с водой), касающаяся изолятора, с этим шансом в кадр растворяет
// одну его клетку — та становится чёрными солями, которые дальше живут по
// своим правилам (мокрые не взрываются, в воде перемешиваются долями).
// Шанс бросается, только если изолятор рядом есть: в озере соседей
// проверяет каждая клетка воды, и лишний бросок там дорог.
const INSULATOR_WATER_CHANCE = 0.004;

// Реагент, попав на дерево, поджигает его.
const REAGENT_IGNITE_WOOD = 0.08;

// Реагент и вода в одной клетке гасят друг друга: пара долей уходит в
// пустоту, клетка нагревается. Шанс в кадр — чтобы реакция была видимой
// вспышкой, а не мгновенным исчезновением смеси.
const REAGENT_WATER_CHANCE = 0.25;
const REAGENT_WATER_HEAT = 100;

// Растворитель (просьба пользователя): меняется долями с чем угодно, и
// его доля, ушедшая в ТВЁРДОЕ тело (или сыпучее), с шансом
// DISSOLVER_TO_REAGENT становится реагентом; при обмене с жидкостями и
// газами — не становится. Раньше шанс был на любой перенос, и лужа
// растворителя за полминуты вся выгорала в реагент, меняясь долями сама с
// собой и с уже получившимся реагентом. Шанс обмена в кадр — как у
// обычного перемешивания, умноженный на долю растворителя в клетке:
// раствор с одной долей растворителя из десяти растворяет в 10 раз реже
// чистого (то же "свойства по процентному отношению", что и у кислоты).
// Пар растворителя ведёт себя так же (и превращается в газ реагента).
const DISSOLVER_MIX_CHANCE = 0.5;
const DISSOLVER_TO_REAGENT = 0.2;

class SimChemistry {
  // Реагент и вода, оказавшись долями ОДНОЙ клетки, гасят друг друга:
  // пара долей (одна реагента, одна воды) уходит в пустоту, а клетка
  // разогревается на REAGENT_WATER_HEAT градусов. Пара за раз, а не весь
  // состав сразу — реакция должна читаться как вспышка с закипанием
  // (нагрев легко переваливает за точку кипения воды), а не как молчаливое
  // исчезновение смеси. Клетка, где от пары долей ничего не осталось,
  // исчезнет обычным порядком — через стягивание пустоты.
  quenchReagentWater(i) {
    const comp = this.comp(i);
    if (solGet(comp, P_REAGENT) === 0 || solGet(comp, P_WATER) === 0) return;
    if (Math.random() >= REAGENT_WATER_CHANCE) return;
    let next = solWith(comp, P_REAGENT, solGet(comp, P_REAGENT) - 1);
    next = solWith(next, P_WATER, solGet(next, P_WATER) - 1);
    this.temp[i] += REAGENT_WATER_HEAT;
    this.setComposition(i, next);
  }

  // Растворитель: меняется долями с любым соседом (dissolverMix), потом
  // обычный тик состава.
  reactDissolver(x, y, i) {
    const d = solGet(this.comp(i), P_DISSOLVER);
    if (Math.random() < DISSOLVER_MIX_CHANCE * d / SOL_PARTS) this.dissolverMix(x, y, i);
    if (!this.hasParts(i)) return;
    this.tickComposition(x, y, i);
  }

  // Обмен одной долей со случайным соседом ЛЮБОГО вещества (кроме
  // DISSOLVER_MIXABLE-исключений: стен, огня, живых): случайная доля
  // отсюда уходит туда, случайная доля оттуда — сюда. Доля растворителя,
  // уходящая в твёрдое тело, с шансом DISSOLVER_TO_REAGENT приходит
  // реагентом (пара — газом реагента). Обе клетки после обмена заново
  // решают, чем они стали (setComposition): камень, в который набралось
  // больше растворителя, чем камня, течёт, а растворитель, набравший
  // камня, — выпадает камнем.
  dissolverMix(x, y, i) {
    const k = (Math.random() * 4) | 0;
    const nx = x + DX4[k], ny = y + DY4[k];
    if (!this.inBounds(nx, ny)) return;
    const ni = this.idx(nx, ny);
    let nt = this.type[ni];
    if (DISSOLVER_MIXABLE[nt] !== 1) return;
    // Прибор под растворителем — сперва простой металл (усилитель —
    // медь), дальше как с ним (своих долей у приборов нет).
    if (DEVICE_BASE[nt] !== 0) {
      const base = DEVICE_BASE[nt];
      this.type[ni] = base;
      this.retypeComp(ni, nt, base);
      this.markDirty(ni);
      nt = base;
    }
    const a = this.comp(i), b = this.comp(ni);
    const pa = this.randomMatterPart(a), pb = this.randomMatterPart(b);
    if (pa < 0 || pb < 0 || pa === pb) return;
    let arrive = pa;
    if ((pa === P_DISSOLVER || pa === P_DISSOLVER_GAS) && PART_STATE[nt] === STATE_SOLID
        && Math.random() < DISSOLVER_TO_REAGENT) {
      arrive = pa === P_DISSOLVER ? P_REAGENT : EL.REAGENT_GAS;
    }
    const a2 = solMove(a, pa, pb);
    const b2 = solMove(b, pb, arrive);
    // Шестой вид не поместился в одну из клеток — обмена нет.
    if (a2 === a || (b2 === b && pb !== arrive)) return;
    this.setComposition(i, a2);
    this.setComposition(ni, b2);
  }

  // Кислота и раствор: перемешивание, фазовый переход, стягивание, и
  // только потом разъедание соседей — если в клетке ещё осталась кислота.
  // Растворитель в растворе действует по своей доле (см. reactDissolver).
  reactSolutionLike(x, y, i) {
    this.mixParts(x, y, i);
    // Мутная вода: грязь оседает (sim/mud.js).
    // Вода откладывает грязь на соседние пиксели и забирает с них (sim/mud.js).
    if (IS_LIQUID[this.type[i]] === 1 && (solGet(this.comp(i), EL.MUD) > 0 || this.dirtyNear(x, y, i))) this.mudStick(x, y, i);
    const d = solGet(this.comp(i), P_DISSOLVER);
    if (d && Math.random() < DISSOLVER_MIX_CHANCE * d / SOL_PARTS) this.dissolverMix(x, y, i);
    if (!this.hasParts(i)) return;
    this.tickComposition(x, y, i);
    // Чистый реагент сюда тоже попадает: он не разъедает (доли кислоты в
    // нём нет), но окисляет камень — см. oxidiseNeighbours ниже.
    const t = this.type[i];
    if (t !== EL.ACID && t !== EL.SOLUTION && t !== EL.REAGENT) return;
    if (solGet(this.comp(i), P_ACID) > 0) this.dissolveNeighbours(x, y, i);
    if (this.hasParts(i) && solGet(this.comp(i), P_REAGENT) > 0) this.oxidiseNeighbours(x, y, i);
    if (this.hasParts(i) && Math.random() < RUST_TICK_CHANCE && solGet(this.comp(i), P_WATER) > 0) this.rustNeighbours(x, y, i);
    if (this.beam[i] && IS_LIQUID[this.type[i]] === 1) this.reactLiquidOnBeam(x, y, i);
    if (this.hasParts(i) && solGet(this.comp(i), P_WATER) > 0) this.dissolveInsulator(x, y, i);
  }

  // Вода в клетке i растворяет соседний изолятор в чёрные соли (см.
  // INSULATOR_WATER_CHANCE). Соседи — справа, слева, снизу, сверху.
  dissolveInsulator(x, y, i) {
    const w = this.w, type = this.type, INS = EL.INSULATOR;
    let ni = -1;
    if (x < w - 1 && type[i + 1] === INS) ni = i + 1;
    else if (x > 0 && type[i - 1] === INS) ni = i - 1;
    else if (y < this.h - 1 && type[i + w] === INS) ni = i + w;
    else if (y > 0 && type[i - w] === INS) ni = i - w;
    if (ni < 0 || Math.random() >= INSULATOR_WATER_CHANCE) return;
    this.spawn(ni, EL.BLACK_SALT, false);
  }

  // Жидкость, стоящая в клетке с балкой, действует на балку так же, как на
  // соседа из того же материала (просьба пользователя: "если на балку
  // налить кислоту, она будет расщепляться, реагент — окисляться"):
  // кислота разъедает (металлическую — с тем же шансом окисляет), реагент
  // окисляет, вода ржавит металлическую, но не стальную. Течь сквозь
  // балку жидкости по-прежнему ничто не мешает, поэтому налитая на балку
  // лужа стоит в её клетках и ест её изнутри.
  //
  // Шансы и расход долей — те же, что у соседей (dissolveNeighbours,
  // oxidiseNeighbours, rustNeighbours); за кадр не больше одной реакции.
  // Растворённая балка остатка не оставляет — лечь ему некуда, клетка
  // занята самой кислотой.
  reactLiquidOnBeam(x, y, i) {
    const mat = this.beam[i];
    let comp = this.comp(i);
    const el = ELEMENTS[mat];
    const line = OXIDE_LINE[mat];
    const stage = this.beamStage(i);
    const acid = solGet(comp, P_ACID);
    const proof = !!line && line.acidProofStage > 0 && stage >= line.acidProofStage;
    if (acid > 0 && !el.acidImmune && !proof) {
      const chance = (el.acidSlow ? 0.015 : 0.06) * acid / SOL_PARTS;
      if (Math.random() < chance) {
        if (isRustLine(line) && Math.random() < ACID_OXIDISE_METAL) {
          if (stage < line.maxStage) this.oxidiseBeam(i, line, stage);
          comp = solWith(comp, P_ACID, acid - 1);
          comp = solWith(comp, P_VOID, solGet(comp, P_VOID) + 1);
        } else {
          this.removeBeam(i);
          comp = solMove(comp, P_ACID, solGet(comp, P_STONE) > 0 ? P_REAGENT : P_STONE);
          if (solGet(comp, P_ACID) === 0) {
            const st = solGet(comp, P_STONE);
            for (let k = 0; k < st; k++) comp = solMove(comp, P_STONE, P_REAGENT);
          }
          if (Math.random() < 0.2) this.ventGas(x, y, mat);
        }
        this.setComposition(i, comp, false);
        return;
      }
    }
    if (!line || stage < 0 || stage >= line.maxStage) return;
    const reagent = solGet(comp, P_REAGENT);
    if (reagent > 0 && Math.random() < 0.06 / OXIDISE_SLOWER * reagent / SOL_PARTS) {
      this.oxidiseBeam(i, line, stage);
      if (Math.random() < OXIDISE_COST) {
        comp = solWith(comp, P_REAGENT, reagent - 1);
        comp = solWith(comp, P_VOID, solGet(comp, P_VOID) + 1);
        this.setComposition(i, comp, false);
      }
      return;
    }
    const water = solGet(comp, P_WATER);
    const rustsInWater = line.waterRusts || (isRustLine(line) && solGet(comp, P_SALT) > 0);
    if (water > 0 && rustsInWater && Math.random() < RUST_TICK_CHANCE
        && Math.random() < 0.06 / WATER_RUST_SLOWER * water / SOL_PARTS) {
      this.oxidiseBeam(i, line, stage);
      comp = solMove(comp, P_WATER, P_SALT);   // как в rustNeighbours: доля воды — в чёрные соли
      this.setComposition(i, comp, false);
    }
  }

  // Вода ржавит металл. Медленнее кислоты (WATER_RUST_SLOWER) и только
  // металлическую линейку — камень и землю вода не трогает. В отличие от
  // реагента, который платит долей через раз, здесь каждая удавшаяся
  // попытка ГАРАНТИРОВАННО тратит долю воды: она становится долей чёрных
  // солей (P_SALT). Раньше доля уходила в пустоту и лужа мелела; теперь
  // (просьба пользователя) стоячая вода над ржавеющим железом постепенно
  // чернеет, а набравшая больше пяти долей соли клетка выпадает сыпучим
  // осадком на дно (см. setComposition).
  //
  // at — где жидкость сейчас: отслоившаяся ржавчина (rustFlake) меняется с
  // ней местами, и итоговый состав пишется уже туда.
  rustNeighbours(x, y, i) {
    const comp0 = this.comp(i);
    let comp = comp0;
    let water = solGet(comp, P_WATER);
    const salty = solGet(comp, P_SALT) > 0;
    let at = i;
    for (let k = 0; k < 4 && water > 0; k++) {
      const nx = x + DX4[k], ny = y + DY4[k];
      if (!this.inBounds(nx, ny)) continue;
      const ni = this.idx(nx, ny);
      // Сплав ржавеет по долям (sim/alloys.js): доля стали защищает его от
      // чистой воды, но не от солёной.
      if (this.type[ni] === EL.ALLOY) {
        if (Math.random() >= 0.06 / WATER_RUST_SLOWER * water / SOL_PARTS) continue;
        if (!this.alloyRustPart(ni, salty ? ALLOY_BY_SALTY_WATER : ALLOY_BY_WATER)) continue;
        comp = solMove(comp, P_WATER, P_SALT);
        water = solGet(comp, P_WATER);
        continue;
      }
      const line = OXIDE_LINE[this.type[ni]];
      // Чистая вода ржавит металл и его ржавчину, но не сталь; вода с
      // чёрными солями — и сталь (просьба: "вода с чёрными солями может
      // окислять даже титан"). Солёной она становится, как раз ржавя
      // металл, — так что сталь рядом с ржавеющим железом в одной луже
      // рано или поздно тоже пойдёт ржавчиной.
      if (!line || !(line.waterRusts || (salty && isRustLine(line)))) continue;
      const stage = this.oxideStage(ni);
      if (stage < 0 || stage >= line.maxStage) continue;
      const chance = 0.06 / WATER_RUST_SLOWER * water / SOL_PARTS;
      if (Math.random() >= chance) continue;
      this.setOxideStage(ni, stage + 1, line);
      comp = solMove(comp, P_WATER, P_SALT);
      water = solGet(comp, P_WATER);
      if (this.rustFlake(at, ni)) { at = ni; break; }
    }
    // Ничего не заржавело (почти всегда: бросок на ржавление редок) — и
    // состав прежний. setComposition тогда ничего не меняет, если тип уже
    // совпадает с единственным веществом состава; а зовётся это на каждой
    // четверти клеток воды каждый кадр, и в озере это была заметная доля
    // кадра. Смесь или несовпавший тип — прежним путём, пусть пересчитает.
    if (at === i && comp === comp0 && comp < 1024 && this.type[i] === (comp & 63)) return;
    this.setComposition(at, comp, false);
  }

  // Окисление камня химическим реагентом. Похоже на разъедание кислотой,
  // но с тремя отличиями, заданными в постановке:
  //  - окисляемая клетка НЕ исчезает, а поднимается на стадию окисла
  //    (камень -> окисел 1 -> 2 -> 3, выше не растёт);
  //  - идёт в OXIDISE_SLOWER раз медленнее разъедания;
  //  - реагенту это стоит доли лишь в OXIDISE_COST случаев, а не всегда,
  //    поэтому одна капля успевает окислить многое, прежде чем выдохнется.
  // Потраченная доля уходит в пустоту: реагент израсходован, и клетка
  // становится неполной — дальше её подберёт стягивание.
  // Металл при этом ржавеет и может отслоиться в реагент (rustFlake), как
  // в rustNeighbours — отсюда at.
  oxidiseNeighbours(x, y, i) {
    let comp = this.comp(i);
    let reagent = solGet(comp, P_REAGENT);
    let at = i;
    for (let k = 0; k < 4 && reagent > 0; k++) {
      const nx = x + DX4[k], ny = y + DY4[k];
      if (!this.inBounds(nx, ny)) continue;
      const ni = this.idx(nx, ny);
      const nt = this.type[ni];
      const chance = 0.06 / OXIDISE_SLOWER * reagent / SOL_PARTS;
      // Кислотный остаток реагент не окисляет по стадиям, а сразу
      // переводит в окисел металла первой стадии: осадок это уже не
      // порода, а продукт реакции, и дальше он живёт по линейке металла.
      if (nt === EL.ACID_RESIDUE) {
        if (Math.random() >= chance) continue;
        this.setOxideStage(ni, 1, OXIDE_LINE[EL.METAL]);
        if (Math.random() < OXIDISE_COST) {
          comp = solWith(comp, P_REAGENT, reagent - 1);
          comp = solWith(comp, P_VOID, solGet(comp, P_VOID) + 1);
          reagent = solGet(comp, P_REAGENT);
        }
        continue;
      }
      // Дерево реагент не окисляет, а поджигает.
      if (nt === EL.WOOD) {
        if (Math.random() >= chance * REAGENT_IGNITE_WOOD / 0.012) continue;
        const el = ELEMENTS[EL.WOOD];
        this.spawn(ni, EL.FIRE);
        this.life[ni] = el.burnLife + (Math.random() * 10 | 0);
        this.extra[ni] = 1;
        if (Math.random() < OXIDISE_COST) {
          comp = solWith(comp, P_REAGENT, reagent - 1);
          comp = solWith(comp, P_VOID, solGet(comp, P_VOID) + 1);
          reagent = solGet(comp, P_REAGENT);
        }
        continue;
      }
      // Сплав реагент окисляет по долям (sim/alloys.js).
      if (nt === EL.ALLOY) {
        if (Math.random() >= chance) continue;
        if (!this.alloyRustPart(ni, ALLOY_BY_REAGENT)) continue;
        if (Math.random() < OXIDISE_COST) {
          comp = solWith(comp, P_REAGENT, reagent - 1);
          comp = solWith(comp, P_VOID, solGet(comp, P_VOID) + 1);
          reagent = solGet(comp, P_REAGENT);
        }
        continue;
      }
      const line = OXIDE_LINE[nt];
      if (!line) continue;
      const stage = this.oxideStage(ni);
      if (stage < 0 || stage >= line.maxStage) continue;
      if (Math.random() >= chance) continue;
      this.setOxideStage(ni, stage + 1, line);
      if (Math.random() < OXIDISE_COST) {
        comp = solWith(comp, P_REAGENT, reagent - 1);
        comp = solWith(comp, P_VOID, solGet(comp, P_VOID) + 1);
        reagent = solGet(comp, P_REAGENT);
      }
      if (isRustLine(line) && this.rustFlake(at, ni)) { at = ni; break; }
    }
    this.setComposition(at, comp, false);
  }

  // Разъедание соседей клеткой с долей кислоты acid/10. Шанс на клетку в
  // кадр — как у прежней чистой кислоты (0.06, для acidSlow 0.015),
  // умноженный на долю кислоты: раствор с одной долей разъедает в 10 раз
  // реже и, поскольку у него ровно одна доля на трату, "живёт" в 10 раз
  // меньше. Не разъедаются: пустота, своя же среда (жидкая и газовая),
  // кислотный остаток и всё acidImmune (стена, стекло).
  // Окисленный кислотой металл может отслоиться в неё (rustFlake), как в
  // rustNeighbours — отсюда at.
  dissolveNeighbours(x, y, i) {
    let comp = this.comp(i);
    let acid = solGet(comp, P_ACID);
    let at = i;
    for (let k = 0; k < 4 && acid > 0; k++) {
      const nx = x + DX4[k], ny = y + DY4[k];
      if (!this.inBounds(nx, ny)) continue;
      const ni = this.idx(nx, ny);
      const nt = this.type[ni];
      // Своя среда (в том числе сыпучие чёрные соли — они растворяются в
      // кислоте, меняясь с ней долями, а не разъедаются) не трогается.
      if (nt === EL.EMPTY || isSolutionMedium(nt) || isVaporFamily(nt) || nt === EL.ACID_RESIDUE) continue;
      const nel = ELEMENTS[nt];
      if (!nel || nel.acidImmune || this.acidProof(ni)) continue;
      // У сплава скорость растворения — средняя по долям (sim/alloys.js).
      const base = nt === EL.ALLOY ? this.alloyAcidChance(ni) : (nel.acidSlow ? 0.015 : 0.06);
      const chance = base * acid / SOL_PARTS;
      if (Math.random() >= chance) continue;
      // Сплав кислота, как и металл, с равным шансом окисляет — одну его
      // металлическую долю.
      if (nt === EL.ALLOY && Math.random() < ACID_OXIDISE_METAL && this.alloyRustPart(ni, ALLOY_BY_ACID)) {
        comp = solWith(comp, P_ACID, acid - 1);
        comp = solWith(comp, P_VOID, solGet(comp, P_VOID) + 1);
        acid = solGet(comp, P_ACID);
        continue;
      }
      // Металл кислота с равным шансом либо разъедает, либо окисляет на
      // стадию. Доля кислоты тратится в обоих случаях: на окисление она
      // уходит целиком в пустоту (израсходована), а при растворении —
      // обычным порядком, в растворённое вещество (см. dissolveInto).
      const line = OXIDE_LINE[nt];
      if (isRustLine(line) && Math.random() < ACID_OXIDISE_METAL) {
        const stage = this.oxideStage(ni);
        const advanced = stage >= 0 && stage < line.maxStage;
        if (advanced) this.setOxideStage(ni, stage + 1, line);
        comp = solWith(comp, P_ACID, acid - 1);
        comp = solWith(comp, P_VOID, solGet(comp, P_VOID) + 1);
        acid = solGet(comp, P_ACID);
        if (advanced && this.rustFlake(at, ni)) { at = ni; break; }
        continue;
      }
      comp = this.dissolveInto(x, y, ni, comp, nt);
      acid = solGet(comp, P_ACID);
    }
    this.setComposition(at, comp, false);
  }

  // Один акт растворения клетки ni. Возвращает новый состав кислоты.
  //  1. Одна доля кислоты тратится.
  //  2. Если доли растворённого вещества ещё не было — она появляется
  //     вместо потраченной кислоты, а растворённая клетка просто
  //     исчезает. Если была — прежняя доля вещества становится долей
  //     реагента, новая встаёт на её место, а растворённая клетка
  //     превращается в кислотный остаток: так кислота оставляет за собой
  //     след на каждом следующем растворении.
  //  3. Когда кислоты не осталось, последняя доля вещества тоже
  //     становится реагентом.
  //  4. С шансом 20% выделяется газ (см. ventGas). У клетки из нескольких
  //     веществ (сплав и прочие смеси) газ — газ случайной доли: бросок от 1
  //     до 10 по её долям, какая выпала, та и выделяет свой газ (просьба
  //     пользователя).
  dissolveInto(x, y, ni, comp, sourceId) {
    const niComp = this.comp(ni);
    const hadStone = solGet(comp, P_STONE) > 0;
    if (hadStone) {
      comp = solMove(comp, P_ACID, P_REAGENT);
      this.spawn(ni, EL.ACID_RESIDUE);
    } else {
      comp = solMove(comp, P_ACID, P_STONE);
      this.clearCell(ni);
    }
    if (solGet(comp, P_ACID) === 0) {
      const st = solGet(comp, P_STONE);
      for (let k = 0; k < st; k++) comp = solMove(comp, P_STONE, P_REAGENT);
    }
    const GAS_CHANCE = 0.2;
    if (Math.random() < GAS_CHANCE) this.ventGas(x, y, niComp >= 1024 ? this.randomMatterPart(niComp) : sourceId);
    return comp;
  }

  // Газ, выделяющийся при растворении. Половина случаев — привычный
  // кислотный газ полной клеткой. По четверти — газообразный реагент и
  // газообразное масло: этих выходит СЛУЧАЙНОЕ число долей (остальное
  // пустота, и такие клетки потом стягиваются между собой), и оба выходят
  // горячими, на 300 градусах. Масло вдобавок получает свой срок: оно
  // единственное выпадает не по остыванию, а по таймеру на 1-3 минуты.
  ventGas(x, y, sourceId) {
    const target = this.freeNeighbour(x, y, true);
    if (target < 0) return;
    const line = OXIDE_LINE[sourceId];
    const fromMetal = isRustLine(line);
    const fromWood = sourceId === EL.WOOD;
    // Земля и всё, что кислоте поддаётся как земля (изолятор), — по
    // семье окисла, а не по основе линейки.
    const fromEarth = !!line && line.solid === EL.EARTH_OXIDE;
    // Доли газа — газовые элементы (пар, кислотный газ, газ реагента и
    // масла), см. фазы в data/composition.js.
    let comp = 0, hot = false, life = 0;
    if (fromWood) {
      // Дерево отдаёт летучую органику и влагу: смесь масла и воды в
      // случайном соотношении.
      comp = this.randomGasMix([EL.OIL_GAS, EL.STEAM]);
    } else if (fromEarth) {
      // Земля богаче: масло, вода и кислота вперемешку, тоже случайно.
      comp = this.randomGasMix([EL.OIL_GAS, EL.STEAM, EL.ACID_GAS]);
    } else if (fromMetal) {
      // Из металла выходит только кислотный газ: органики в нём нет.
      comp = solPure(EL.ACID_GAS, SOL_PARTS);
    } else {
      const r = Math.random();
      let kind = EL.ACID_GAS, n = SOL_PARTS;
      if (r >= 0.5 && r < 0.75) { kind = EL.REAGENT_GAS; n = 1 + (Math.random() * SOL_PARTS | 0); hot = true; }
      else if (r >= 0.75) { kind = EL.OIL_GAS; n = 1 + (Math.random() * SOL_PARTS | 0); hot = true; }
      comp = solPure(kind, n);
    }
    if (solGet(comp, EL.OIL_GAS) > 0) {
      life = OIL_GAS_LIFE_MIN + (Math.random() * (OIL_GAS_LIFE_MAX - OIL_GAS_LIFE_MIN) | 0);
    }
    if (solMatter(comp) === 0) return;
    this.placeGas(target, comp, life, hot);
  }

  // Ставит в пустую клетку target газ системы долей с составом comp: свой
  // оттенок, срок life (только у газообразного масла), и стартовая
  // температура не ниже той, при которой каждый его компонент — газ.
  // Общая для газа от растворения (ventGas) и от плавления окисла
  // (meltStoneOxide).
  placeGas(target, comp, life, hot) {
    this.extra[target] = 0;
    this.shade[target] = (Math.random() * 30 - 15) | 0;
    this.setComposition(target, comp);
    this.life[target] = life;
    // Стартовая температура — по самому тугоплавкому из того, что внутри:
    // иначе один компонент сконденсировался бы в первый же кадр.
    let want = hot ? HOT_GAS_TEMP : 0;
    for (let s = 0; s < SOL_SLOTS; s++) {
      const slot = solSlot(comp, s);
      if (!slot) break;
      const t = this.gasSpawnTemp(slotId(slot));
      if (t > want) want = t;
    }
    if (this.temp[target] < want) this.temp[target] = want;
    this.moved[target] = 1;
  }

  // Случайная газовая смесь из перечисленных видов: сколько всего долей и
  // как они поделены между видами — оба раза случайно, поэтому один и тот
  // же источник даёт то почти чистый газ, то ровную смесь.
  randomGasMix(kinds) {
    let n = 1 + (Math.random() * SOL_PARTS | 0);
    if (n > SOL_PARTS) n = SOL_PARTS;
    let comp = solWith(0, P_VOID, SOL_PARTS - n);
    for (let left = n; left > 0; left--) {
      const k = kinds[(Math.random() * kinds.length) | 0];
      comp = solWith(comp, k, solGet(comp, k) + 1);
    }
    return comp;
  }

  // Кислотный остаток (сыпучее, extra = уровень 1..4). Смотрит только на
  // клетку НАД собой:
  //  - там кислота (чистая или раствор с долей кислоты) — меняется с ней
  //    местами, пропуская её вниз: остаток не должен ложиться плёнкой
  //    между кислотой и тем, что она разъедает;
  //  - там такой же остаток — сливаются в один: уровни складываются
  //    (остаток становится темнее и менее похожим на камень), с пятого
  //    уровня остаток превращается в химический реагент.
  // Обход поля идёт снизу вверх, поэтому из двух остатков друг на друге
  // первым обрабатывается нижний — он и поглощает верхний.
  //
  // Остаток — это растворённый камень, поэтому в жару он плавится, как
  // камень, в расплавленный камень (лаву; см. плавление в data/elements.js).
  reactAcidResidue(x, y, i) {
    if (this.meltRoll(i, EL.ACID_RESIDUE)) { this.spawn(i, ELEMENTS[EL.ACID_RESIDUE].meltsInto, false); return; }
    if (y === 0) return;
    const ai = this.idx(x, y - 1);
    const at = this.type[ai];
    if (at === EL.ACID_RESIDUE) {
      this.extra[i] = Math.min(255, this.extra[i] + this.extra[ai]);
      this.clearCell(ai);
      if (this.extra[i] >= 5) this.spawn(i, EL.REAGENT);
      return;
    }
    if (isSolutionFamily(at) && solGet(this.comp(ai), P_ACID) > 0) {
      this.swap(i, ai); this.moved[ai] = 1;
    }
  }
}

extendSim(SimChemistry);
