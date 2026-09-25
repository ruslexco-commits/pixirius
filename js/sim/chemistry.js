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

// Реагент, попав на дерево, поджигает его.
const REAGENT_IGNITE_WOOD = 0.08;

// Реагент и вода в одной клетке гасят друг друга: пара долей уходит в
// пустоту, клетка нагревается. Шанс в кадр — чтобы реакция была видимой
// вспышкой, а не мгновенным исчезновением смеси.
const REAGENT_WATER_CHANCE = 0.25;
const REAGENT_WATER_HEAT = 100;

class SimChemistry {
  // Реагент и вода, оказавшись долями ОДНОЙ клетки, гасят друг друга:
  // пара долей (одна реагента, одна воды) уходит в пустоту, а клетка
  // разогревается на REAGENT_WATER_HEAT градусов. Пара за раз, а не весь
  // состав сразу — реакция должна читаться как вспышка с закипанием
  // (нагрев легко переваливает за точку кипения воды), а не как молчаливое
  // исчезновение смеси. Клетка, где от пары долей ничего не осталось,
  // исчезнет обычным порядком — через стягивание пустоты.
  quenchReagentWater(i) {
    const comp = this.sol[i];
    if (solGet(comp, P_REAGENT) === 0 || solGet(comp, P_WATER) === 0) return;
    if (Math.random() >= REAGENT_WATER_CHANCE) return;
    let next = solWith(comp, P_REAGENT, solGet(comp, P_REAGENT) - 1);
    next = solWith(next, P_WATER, solGet(next, P_WATER) - 1);
    next = solWith(next, P_VOID, solGet(next, P_VOID) + 2);
    this.temp[i] += REAGENT_WATER_HEAT;
    this.setComposition(i, next, isVaporFamily(this.type[i]));
  }

  // Кислота и раствор: перемешивание, фазовый переход, стягивание, и
  // только потом разъедание соседей — если в клетке ещё осталась кислота.
  reactSolutionLike(x, y, i) {
    this.mixParts(x, y, i);
    this.tickComposition(x, y, i);
    // Чистый реагент сюда тоже попадает: он не разъедает (доли кислоты в
    // нём нет), но окисляет камень — см. oxidiseNeighbours ниже.
    const t = this.type[i];
    if (t !== EL.ACID && t !== EL.SOLUTION && t !== EL.REAGENT) return;
    if (solGet(this.sol[i], P_ACID) > 0) this.dissolveNeighbours(x, y, i);
    if (this.hasParts(i) && solGet(this.sol[i], P_REAGENT) > 0) this.oxidiseNeighbours(x, y, i);
    if (this.hasParts(i) && Math.random() < RUST_TICK_CHANCE && solGet(this.sol[i], P_WATER) > 0) this.rustNeighbours(x, y, i);
  }

  // Вода ржавит металл. Медленнее кислоты (WATER_RUST_SLOWER) и только
  // металлическую линейку — камень и землю вода не трогает. В отличие от
  // реагента, который платит долей через раз, здесь каждая удавшаяся
  // попытка ГАРАНТИРОВАННО съедает долю воды: она уходит в пустоту,
  // связанная ржавчиной. Лужа поэтому мелеет на глазах, пока ржавеет
  // деталь под ней.
  rustNeighbours(x, y, i) {
    let comp = this.sol[i];
    let water = solGet(comp, P_WATER);
    for (let k = 0; k < 4 && water > 0; k++) {
      const nx = x + DX4[k], ny = y + DY4[k];
      if (!this.inBounds(nx, ny)) continue;
      const ni = this.idx(nx, ny);
      const line = OXIDE_LINE[this.type[ni]];
      if (!line || line.base !== EL.METAL) continue;
      const stage = this.oxideStage(ni);
      if (stage < 0 || stage >= line.maxStage) continue;
      const chance = 0.06 / WATER_RUST_SLOWER * water / SOL_PARTS;
      if (Math.random() >= chance) continue;
      this.setOxideStage(ni, stage + 1, line);
      comp = solWith(comp, P_WATER, water - 1);
      comp = solWith(comp, P_VOID, solGet(comp, P_VOID) + 1);
      water = solGet(comp, P_WATER);
    }
    this.setComposition(i, comp, false);
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
  oxidiseNeighbours(x, y, i) {
    let comp = this.sol[i];
    let reagent = solGet(comp, P_REAGENT);
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
    }
    this.setComposition(i, comp, false);
  }

  // Разъедание соседей клеткой с долей кислоты acid/10. Шанс на клетку в
  // кадр — как у прежней чистой кислоты (0.06, для acidSlow 0.015),
  // умноженный на долю кислоты: раствор с одной долей разъедает в 10 раз
  // реже и, поскольку у него ровно одна доля на трату, "живёт" в 10 раз
  // меньше. Не разъедаются: пустота, своя же среда (жидкая и газовая),
  // кислотный остаток и всё acidImmune (стена, стекло).
  dissolveNeighbours(x, y, i) {
    let comp = this.sol[i];
    let acid = solGet(comp, P_ACID);
    for (let k = 0; k < 4 && acid > 0; k++) {
      const nx = x + DX4[k], ny = y + DY4[k];
      if (!this.inBounds(nx, ny)) continue;
      const ni = this.idx(nx, ny);
      const nt = this.type[ni];
      if (nt === EL.EMPTY || isSolutionFamily(nt) || isVaporFamily(nt) || nt === EL.ACID_RESIDUE) continue;
      const nel = ELEMENTS[nt];
      if (!nel || nel.acidImmune || this.acidProof(ni)) continue;
      const chance = (nel.acidSlow ? 0.015 : 0.06) * acid / SOL_PARTS;
      if (Math.random() >= chance) continue;
      // Металл кислота с равным шансом либо разъедает, либо окисляет на
      // стадию. Доля кислоты тратится в обоих случаях: на окисление она
      // уходит целиком в пустоту (израсходована), а при растворении —
      // обычным порядком, в растворённое вещество (см. dissolveInto).
      const line = OXIDE_LINE[nt];
      if (line && line.base === EL.METAL && Math.random() < ACID_OXIDISE_METAL) {
        const stage = this.oxideStage(ni);
        if (stage >= 0 && stage < line.maxStage) this.setOxideStage(ni, stage + 1, line);
        comp = solWith(comp, P_ACID, acid - 1);
        comp = solWith(comp, P_VOID, solGet(comp, P_VOID) + 1);
        acid = solGet(comp, P_ACID);
        continue;
      }
      comp = this.dissolveInto(x, y, ni, comp, nt);
      acid = solGet(comp, P_ACID);
    }
    this.setComposition(i, comp, false);
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
  //  4. С шансом 20% выделяется газ (см. ventGas).
  dissolveInto(x, y, ni, comp, sourceId) {
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
    if (Math.random() < GAS_CHANCE) this.ventGas(x, y, sourceId);
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
    const fromMetal = !!line && line.base === EL.METAL;
    const fromWood = sourceId === EL.WOOD;
    const fromEarth = !!line && line.base === EL.EARTH;
    let comp = 0, hot = false, life = 0;
    if (fromWood) {
      // Дерево отдаёт летучую органику и влагу: смесь масла и воды в
      // случайном соотношении.
      comp = this.randomGasMix([P_OIL, P_WATER]);
    } else if (fromEarth) {
      // Земля богаче: масло, вода и кислота вперемешку, тоже случайно.
      comp = this.randomGasMix([P_OIL, P_WATER, P_ACID]);
    } else if (fromMetal) {
      // Из металла выходит только кислотный газ: органики в нём нет.
      comp = solPure(P_ACID, SOL_PARTS);
    } else {
      const r = Math.random();
      let kind = P_ACID, n = SOL_PARTS;
      if (r >= 0.5 && r < 0.75) { kind = P_REAGENT; n = 1 + (Math.random() * SOL_PARTS | 0); hot = true; }
      else if (r >= 0.75) { kind = P_OIL; n = 1 + (Math.random() * SOL_PARTS | 0); hot = true; }
      comp = solPure(kind, n);
    }
    if (solGet(comp, P_OIL) > 0) {
      life = OIL_GAS_LIFE_MIN + (Math.random() * (OIL_GAS_LIFE_MAX - OIL_GAS_LIFE_MIN) | 0);
    }
    if (solMatter(comp) === 0) return;
    this.extra[target] = 0;
    this.shade[target] = (Math.random() * 30 - 15) | 0;
    this.setComposition(target, comp, true);
    this.life[target] = life;
    // Стартовая температура — по самому тугоплавкому из того, что внутри:
    // иначе один компонент сконденсировался бы в первый же кадр.
    let want = hot ? HOT_GAS_TEMP : 0;
    for (let k = 1; k < P_COUNT; k++) {
      if (!solGet(comp, k)) continue;
      const t = this.gasSpawnTemp(k);
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
  reactAcidResidue(x, y, i) {
    if (y === 0) return;
    const ai = this.idx(x, y - 1);
    const at = this.type[ai];
    if (at === EL.ACID_RESIDUE) {
      this.extra[i] = Math.min(255, this.extra[i] + this.extra[ai]);
      this.clearCell(ai);
      if (this.extra[i] >= 5) this.spawn(i, EL.REAGENT);
      return;
    }
    if (isSolutionFamily(at) && solGet(this.sol[ai], P_ACID) > 0) {
      this.swap(i, ai); this.moved[ai] = 1;
    }
  }
}

extendSim(SimChemistry);
