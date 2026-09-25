'use strict';

// Механика системы долей (формат — в data/composition.js): смешивание
// соседей, стягивание пустоты, покомпонентные кипение, конденсация,
// замерзание и таяние.
//
// Методы класса Sim, вынесенные в отдельный файл: класс ниже — только
// контейнер, extendSim переносит его методы в Sim.prototype (см. core.js).

// ---- темпы процессов системы долей (см. блок "состав" в data/composition.js) ----
// Все три — вероятности В КАДР, и все три существуют ради одного: работа
// размазывается по кадрам вместо того, чтобы делаться вся сразу. На глаз
// разницы нет (процессы и так идут десятки кадров), а стоимость кадра
// падает во столько же раз.
const MIX_CHANCE = 0.5;      // перемешивание с соседом
const COMPACT_CHANCE = 0.5;  // переток пустоты к соседу
// Конденсация нарочно редкая: газ, остывший ниже своей точки кипения,
// выпадает не мгновенно, а в среднем через ~1/COND_CHANCE кадров. Именно
// это даёт пару подняться к потолку и повисеть там облаком, прежде чем
// прольётся дождём, вместо того чтобы выпасть сразу за границей остывания.
const COND_CHANCE = 0.0025;

// Температура газа, выделяющегося при растворении (реагент/масло).
const HOT_GAS_TEMP = 300;

// Замерзание и таяние — с броском, как и конденсация: переход должен
// занимать заметное время, а не срабатывать в первый же кадр за порогом.

const FREEZE_CHANCE = 0.02;
const MELT_CHANCE = 0.02;

// Насколько градусов выше точки кипения рождается газ. Без этого запаса
// свежий газ стоит ровно на границе перехода и норовит сконденсироваться
// в первые же кадры, не успев никуда подняться.
const GAS_SPAWN_MARGIN = 100;

// Порядок обхода соседей при поиске свободной клетки: пара смещений на
// направление. Вверх — для испарения (газ идёт наверх), вниз — для
// конденсации (капля падает). Плоские массивы, чтобы не создавать мусор
// на каждый вызов.
const FREE_ORDER_UP = [0, -1, -1, 0, 1, 0, 0, 1];
const FREE_ORDER_DOWN = [0, 1, -1, 0, 1, 0, 0, -1];

class SimComposition {
  // ---- система долей: смешивание, стягивание, фазы, химия кислоты ----
  //
  // Общая картина (виды долей и их точки кипения — в data/composition.js, блок
  // "состав"). Одна и та же механика описывает жидкости и газы:
  //  - Клетка это 10 долей. Доли бывают вещественные (вода, кислота,
  //    реагент, масло, растворённое вещество) и ПУСТЫЕ — недостающий
  //    объём. Клетка с пустотой называется неполной.
  //  - Соседи одной среды постоянно меняются по одной вещественной доле
  //    (mixParts) — отсюда хаотичное перемешивание и разбавление.
  //  - Пустота живёт по своим правилам (tickCompaction): в полную клетку
  //    ей хода нет, а между двумя неполными она уходит туда, где пустоты
  //    и так больше. Вещество за счёт этого стягивается в целые клетки, а
  //    опустевшие целиком исчезают.
  //  - Фазовый переход идёт ПОКОМПОНЕНТНО (tickPhase): из раствора при
  //    60 градусах уходит паром только кислота, вода и реагент остаются
  //    лежать; остывающий газ ровно так же отдаёт обратно по одному виду.
  //  - Кислота вдобавок разъедает соседей, тратя на каждое растворение
  //    одну свою долю (dissolveNeighbours / dissolveInto).

  // Клетка, у которой вообще есть состав.
  hasParts(i) { return hasComposition(this.type[i]); }

  // Две клетки — части одной среды и могут обмениваться долями. Масло
  // держится особняком: с водой оно не смешивается, поэтому обменивается
  // только с маслом (в системе долей оно живёт в основном как газовый
  // компонент, а сконденсировавшись, сразу становится обычным маслом).
  samePartsFamily(a, b) {
    if (a === EL.OIL || b === EL.OIL) return a === b;
    if (isVaporFamily(a)) return isVaporFamily(b);
    return isSolutionFamily(a) && isSolutionFamily(b);
  }

  // Записывает состав в клетку и подбирает ей элемент: состав из одного
  // вещества показывается привычным чистым элементом (вода, кислота,
  // реагент, масло, пар, кислотный газ), смесь — общим "раствором" или
  // "смешанным газом". Пустота на выбор элемента не влияет: неполная
  // клетка воды это всё ещё вода, просто её меньше десяти долей.
  // Клетка, где не осталось ни одной вещественной доли, исчезает.
  // Тип ставится напрямую, а не через spawn(): температура, оттенок и
  // прочие поля принадлежат той же самой частице и меняться не должны.
  setComposition(i, comp, gas) {
    if (solMatter(comp) === 0) { this.clearCell(i); return; }
    let kinds = 0, last = -1;
    for (let k = 1; k < P_COUNT; k++) if (solGet(comp, k)) { kinds++; last = k; }
    let id = 0;
    if (kinds === 1) id = gas ? PART_GAS[last] : PART_LIQUID[last];
    if (!id) id = gas ? EL.VAPOR : EL.SOLUTION;
    this.type[i] = id;
    this.sol[i] = comp;
  }

  // Случайный ВЕЩЕСТВЕННЫЙ вид из состава, взвешенный по числу долей.
  // Пустота не участвует: у неё свои правила движения (tickCompaction).
  // -1 = вещества в клетке не осталось вовсе.
  randomMatterPart(comp) {
    const matter = solMatter(comp);
    if (matter <= 0) return -1;
    let r = (Math.random() * matter) | 0;
    for (let k = 1; k < P_COUNT; k++) {
      const c = solGet(comp, k);
      if (r < c) return k;
      r -= c;
    }
    return -1;
  }

  // Ближайшая пустая клетка для новой фазы: сначала предпочтительное
  // направление (вверх для пара, вниз для капли), затем бока, затем
  // противоположное. Стороны берутся в случайном порядке, иначе всё
  // выделение газа сносило бы в одну и ту же сторону. -1 = места нет, и
  // тогда переход просто ждёт следующего кадра.
  freeNeighbour(x, y, up) {
    const order = up ? FREE_ORDER_UP : FREE_ORDER_DOWN;
    const flip = Math.random() < 0.5;
    for (let k = 0; k < 4; k++) {
      let idx = k;
      if (flip && k === 1) idx = 2; else if (flip && k === 2) idx = 1;
      const nx = x + order[idx * 2], ny = y + order[idx * 2 + 1];
      if (!this.inBounds(nx, ny)) continue;
      const ni = this.idx(nx, ny);
      if (this.type[ni] === EL.EMPTY) return ni;
    }
    return -1;
  }

  // Полный тик состава клетки: сначала возможный фазовый переход, затем
  // стягивание пустоты. Между ними проверка типа: переход мог увести
  // клетку из системы долей (например, испариться целиком).
  tickComposition(x, y, i) {
    this.quenchReagentWater(i);
    if (!this.hasParts(i)) return;
    this.tickPhase(x, y, i);
    if (!this.hasParts(i)) return;
    this.tickCompaction(x, y, i);
  }

  // Фазовый переход одного вида за тик.
  //
  // Жидкость: кипит тот вид, чья точка кипения уже достигнута; из
  // нескольких таких первым уходит самый летучий. Пример из постановки
  // задачи: раствор 5 воды + 2 кислоты + 3 реагента при 60 градусах — в
  // газ уходят ровно 2 доли кислоты, на их месте в жидкости остаётся
  // пустота, а рядом появляется кислотный газ из 2 долей кислоты и 8
  // долей пустоты.
  //
  // Газ: выпадает тот вид, чья точка кипения ВЫШЕ текущей температуры;
  // из нескольких первым выпадает наименее летучий. Газ из реагента и
  // воды при 150 градусах отдаёт реагент (кипит при 250) и остаётся
  // паром (вода кипит при 100). Масло — исключение: оно не смотрит на
  // температуру вовсе, а выпадает по своему сроку (life).
  //
  // Оптимизация. Проверка стоит на каждой клетке каждого кадра, поэтому
  // первым делом идёт отсев одним сравнением: жидкость холоднее самой
  // низкой точки кипения вообще ничем кипеть не может, газ горячее самой
  // высокой — ничего сконденсировать. Подавляющее большинство клеток
  // мира отваливается здесь, не разбирая состав. Дальше — редкий бросок
  // COND_CHANCE, и только потом разбор шести долей.
  //
  // Если переходит ВСЯ материя клетки, фаза меняется на месте: не нужно
  // ни искать свободную клетку, ни делить состав.
  tickPhase(x, y, i) {
    const id = this.type[i];
    // Твёрдая фаза (лёд, замёрзшие кислота и реагент) живёт своим,
    // встречным переходом: оттаивает, когда стало теплее её точки
    // замерзания. Состава у неё нет — это всегда одно чистое вещество.
    if (isFrozenLiquid(id)) { this.tickThaw(i, id); return; }
    const gas = isVaporFamily(id);
    const T = this.temp[i];
    const comp = this.sol[i];
    // Замерзание проверяется до кипения и по той же схеме: сначала отсев
    // одним сравнением (жидкость теплее самой высокой точки замерзания не
    // застынет ничем), потом редкий бросок, и только потом разбор состава.
    if (!gas && T <= PART_FREEZE_MAX && this.tickFreeze(x, y, i, T, comp)) return;
    let pick = -1;
    if (gas) {
      const oilDue = solGet(comp, P_OIL) > 0 && this.life[i] <= 0;
      if (T > PART_BOIL_MAX && !oilDue) return;
      if (oilDue) pick = P_OIL;
      else {
        if (Math.random() >= COND_CHANCE) return;
        for (let k = 1; k < P_COUNT; k++) {
          if (k === P_OIL || !solGet(comp, k)) continue;
          if (PART_BOIL[k] <= T) continue;
          if (pick < 0 || PART_BOIL[k] > PART_BOIL[pick]) pick = k;
        }
      }
    } else {
      if (T < PART_BOIL_MIN) return;
      for (let k = 1; k < P_COUNT; k++) {
        if (!solGet(comp, k)) continue;
        if (PART_BOIL[k] > T) continue;
        if (pick < 0 || PART_BOIL[k] < PART_BOIL[pick]) pick = k;
      }
    }
    if (pick < 0) return;
    const n = solGet(comp, pick);
    if (n === solMatter(comp)) {
      this.setComposition(i, comp, !gas);
      if (!gas && pick === P_OIL) this.life[i] = 0;
      return;
    }
    const target = this.freeNeighbour(x, y, !gas);
    if (target < 0) return;
    let rest = solWith(comp, pick, 0);
    rest = solWith(rest, P_VOID, solGet(rest, P_VOID) + n);
    this.setComposition(i, rest, gas);
    this.life[target] = 0;
    this.extra[target] = 0;
    this.shade[target] = (Math.random() * 30 - 15) | 0;
    this.temp[target] = T;
    // Свежий пар выходит с запасом над точкой кипения (см. gasSpawnTemp):
    // иначе он рождается ровно на границе и норовит выпасть обратно
    // раньше, чем успеет подняться. Капля, наоборот, никакого запаса не
    // получает — она уже холодная, на то и сконденсировалась.
    if (!gas) {
      const want = this.gasSpawnTemp(pick);
      if (this.temp[target] < want) this.temp[target] = want;
    }
    this.setComposition(target, solPure(pick, n), !gas);
    this.moved[target] = 1;
  }

  // Замерзание жидкости, по одному виду за раз. Из нескольких застывающих
  // первым выпадает самый "тёплый" — тот, чья точка замерзания выше: при
  // охлаждении раствора сперва выходит лёд, и только глубже по минусу
  // кислота и реагент. Это зеркало кипения, где первым уходит самый
  // летучий.
  //
  // Если застывает вся материя клетки, она просто становится твёрдой на
  // месте. Если часть — твёрдое выпадает в соседнюю свободную клетку
  // (ровно как просили: "если в растворе один компонент замерзает раньше
  // другого, спавним лёд рядышком"), а в жидкости на его месте остаётся
  // пустота, которую потом подберёт стягивание.
  tickFreeze(x, y, i, T, comp) {
    let pick = -1;
    for (let k = 1; k < P_COUNT; k++) {
      if (!solGet(comp, k)) continue;
      if (T > PART_FREEZE[k]) continue;
      if (!PART_SOLID[k]) continue;
      if (pick < 0 || PART_FREEZE[k] > PART_FREEZE[pick]) pick = k;
    }
    if (pick < 0) return false;
    if (Math.random() >= FREEZE_CHANCE) return false;
    const n = solGet(comp, pick);
    if (n === solMatter(comp)) {
      this.type[i] = PART_SOLID[pick];
      this.sol[i] = 0;
      this.extra[i] = 0;
      return true;
    }
    const target = this.freeNeighbour(x, y, false);
    if (target < 0) return false;
    let rest = solWith(comp, pick, 0);
    rest = solWith(rest, P_VOID, solGet(rest, P_VOID) + n);
    this.setComposition(i, rest, false);
    this.life[target] = 0;
    this.extra[target] = 0;
    this.shade[target] = (Math.random() * 30 - 15) | 0;
    this.temp[target] = T;
    this.type[target] = PART_SOLID[pick];
    this.sol[target] = 0;
    this.moved[target] = 1;
    return true;
  }

  // Оттаивание: твёрдая фаза возвращается в свою жидкость, когда стало
  // теплее её точки замерзания. Лёд при этом получает полный состав воды,
  // кислотный лёд — кислоты и так далее, так что вещество не подменяется
  // (растаявшая кислота остаётся кислотой, а не превращается в воду).
  tickThaw(i, id) {
    const kind = SOLID_PART[id];
    if (!kind) return;
    if (this.temp[i] <= PART_FREEZE[kind]) return;
    if (Math.random() >= MELT_CHANCE) return;
    this.extra[i] = 0;
    this.life[i] = 0;
    this.setComposition(i, solPure(kind, SOL_PARTS), false);
  }

  // Стягивание: пустота уходит к соседу, у которого её больше.
  //
  // Правила ровно те, что были заданы: в ПОЛНУЮ клетку пустота не
  // переходит никогда (в отличие от вещественных долей, которыми соседи
  // меняются свободно); из двух неполных клеток пустота идёт из той, где
  // её меньше, в ту, где больше; клетка, где не осталось ничего кроме
  // пустоты, исчезает.
  //
  // Поровну пустоты — случай, оставленный на моё усмотрение. Выбрано
  // направление: в жидкости пустота идёт ВВЕРХ, в газе ВНИЗ. Это ровно
  // то, как ведёт себя пузырь: пустота в воде всплывает, а разрежение в
  // облаке оседает. Заодно это не даёт двум одинаковым соседям
  // перекидывать пустоту друг другу вечно — направление задано, и обмен
  // всегда идёт в одну сторону, а не туда-обратно.
  //
  // Обмен всегда парный: наша доля пустоты уходит соседу, его случайная
  // вещественная доля приходит к нам. Объём мира при этом сохраняется.
  tickCompaction(x, y, i) {
    const comp = this.sol[i];
    const v = solGet(comp, P_VOID);
    if (v === 0) return;
    if (v >= SOL_PARTS) { this.clearCell(i); return; }
    if (Math.random() >= COMPACT_CHANCE) return;
    const id = this.type[i];
    const gas = isVaporFamily(id);
    let best = -1, bestScore = -1;
    for (let k = 0; k < 4; k++) {
      const nx = x + DX4[k], ny = y + DY4[k];
      if (!this.inBounds(nx, ny)) continue;
      const ni = this.idx(nx, ny);
      if (!this.samePartsFamily(id, this.type[ni])) continue;
      const vn = solGet(this.sol[ni], P_VOID);
      if (vn === 0 || vn < v) continue;
      const pref = gas ? DY4[k] > 0 : DY4[k] < 0;
      if (vn === v && !pref) continue;
      const score = vn * 2 + (pref ? 1 : 0);
      if (score > bestScore) { bestScore = score; best = ni; }
    }
    if (best < 0) return;
    const nComp = this.sol[best];
    const kind = this.randomMatterPart(nComp);
    if (kind < 0) return;
    this.setComposition(i, solWith(solWith(comp, P_VOID, v - 1), kind, solGet(comp, kind) + 1), gas);
    this.setComposition(best, solWith(solWith(nComp, P_VOID, solGet(nComp, P_VOID) + 1), kind, solGet(nComp, kind) - 1), gas);
  }

  // Хаотичное перемешивание со случайным соседом той же среды: обмен
  // одной вещественной долей. Пустота в обмене не участвует. Особый
  // случай — две ПОЛНЫЕ клетки чистой кислоты и чистой воды: они сразу
  // дают поровну, 5 долей кислоты и 5 воды в каждой.
  mixParts(x, y, i) {
    const k = (Math.random() * 4) | 0;
    const nx = x + DX4[k], ny = y + DY4[k];
    if (!this.inBounds(nx, ny)) return;
    const ni = this.idx(nx, ny);
    const id = this.type[i], nid = this.type[ni];
    if (!this.samePartsFamily(id, nid)) return;
    const gas = isVaporFamily(id);
    let a = this.sol[i], b = this.sol[ni];
    if (!gas && solGet(a, P_VOID) === 0 && solGet(b, P_VOID) === 0
        && ((id === EL.ACID && nid === EL.WATER) || (id === EL.WATER && nid === EL.ACID))) {
      const half = solWith(solWith(0, P_ACID, SOL_PARTS / 2), P_WATER, SOL_PARTS / 2);
      this.setComposition(i, half, false);
      this.setComposition(ni, half, false);
      return;
    }
    if (Math.random() >= MIX_CHANCE) return;
    const pa = this.randomMatterPart(a), pb = this.randomMatterPart(b);
    if (pa < 0 || pb < 0 || pa === pb) return;
    a = solMove(a, pa, pb);
    b = solMove(b, pb, pa);
    this.setComposition(i, a, gas);
    this.setComposition(ni, b, gas);
  }

  // Температура, с которой рождается газ данного вида: на
  // GAS_SPAWN_MARGIN выше точки кипения этого же вещества. Без запаса
  // свежий газ стоит ровно на границе перехода, и первый же бросок
  // конденсации возвращает его обратно в жидкость, не дав никуда
  // подняться. Для того, что по температуре не кипит вовсе (масло), берём
  // общую температуру горячего выхлопа.
  gasSpawnTemp(kind) {
    const boil = PART_BOIL[kind];
    return boil === Infinity ? HOT_GAS_TEMP : boil + GAS_SPAWN_MARGIN;
  }

  // Любой газ системы долей: считает свой срок (он есть только у
  // масляного), перемешивается с соседним газом, переходит в жидкость
  // покомпонентно и стягивает пустоту. Кислотный газ при этом НЕ
  // разъедает ничего: разъедание живёт в reactSolutionLike, то есть в
  // жидкой фазе. Пока кислота летает газом, она свои свойства не
  // проявляет и просто ждёт, когда остынет ниже 60 и выпадет обратно.
  reactVapor(x, y, i) {
    if (this.life[i] > 0) this.life[i]--;
    this.mixParts(x, y, i);
    if (!this.hasParts(i)) return;
    this.tickComposition(x, y, i);
  }
}

extendSim(SimComposition);
