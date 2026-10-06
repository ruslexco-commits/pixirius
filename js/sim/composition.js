'use strict';

// Механика состава (формат — в data/composition.js): смешивание соседей,
// стягивание пустоты, выбор элемента клетки по составу, выделение газа
// отдельным пикселем и покомпонентные кипение, конденсация, замерзание и
// таяние.
//
// Методы класса Sim, вынесенные в отдельный файл: класс ниже — только
// контейнер, extendSim переносит его методы в Sim.prototype (см. core.js).

// ---- темпы процессов (см. data/composition.js) ----
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

// Температура газа, у которого нет точки кипения (газ масла) — горячий
// выхлоп растворения.
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
// направление. Вверх — для газа (он идёт наверх), вниз — для капли.
// Плоские массивы, чтобы не создавать мусор на каждый вызов.
const FREE_ORDER_UP = [0, -1, -1, 0, 1, 0, 0, 1];
const FREE_ORDER_DOWN = [0, 1, -1, 0, 1, 0, 0, -1];

class SimComposition {
  // ---- состав: смешивание, стягивание, фазы ----
  //
  // Общая картина (формат и таблицы фаз — в data/composition.js):
  //  - Клетка это 10 долей, доля — элемент в своей фазе (вода, пар, лёд,
  //    камень...). Недостающие до десяти — ПУСТОТА: клетка неполная.
  //  - Какой элемент клетка, решает её состав (setComposition): газ,
  //    жидкость или твёрдое — по фазам долей.
  //  - Соседи одной среды постоянно меняются по одной вещественной доле
  //    (mixParts) — отсюда хаотичное перемешивание и разбавление.
  //    Растворитель меняется долями с чем угодно (dissolverMix).
  //  - Пустота живёт по своим правилам (tickCompaction): в полную клетку
  //    ей хода нет, а между двумя неполными она уходит туда, где пустоты
  //    и так больше. Вещество за счёт этого стягивается в целые клетки, а
  //    опустевшие целиком исчезают.
  //  - Фазовый переход идёт ПОКОМПОНЕНТНО (tickPhase): доли одного вида
  //    превращаются в другой (вода -> пар), а газ, оказавшийся в одной
  //    клетке с жидкостью или твёрдым, выходит в свободную соседнюю
  //    клетку отдельным пикселем (splitGas).
  //  - Кислота вдобавок разъедает соседей, тратя на каждое растворение
  //    одну свою долю (dissolveNeighbours / dissolveInto).

  // Клетка, у которой состав живёт сам (см. hasComposition).
  hasParts(i) { return hasComposition(this.type[i]); }

  // Две клетки — части одной среды и могут обмениваться долями сами
  // собой. Масло держится особняком: с водой оно не смешивается. Сыпучие
  // чёрные соли — той же среды, что и растворы: так соль растворяется в
  // воде и выпадает из неё. С чем угодно меняется только растворитель, и
  // делает это отдельно (dissolverMix).
  samePartsFamily(a, b) {
    // Расплавы (лава, металлы, их смесь) — своя среда, как растворы у
    // жидкостей: так металлы смешиваются в сплав (sim/alloys.js).
    if (IS_MOLTEN[a] === 1 || IS_MOLTEN[b] === 1) return IS_MOLTEN[a] === 1 && IS_MOLTEN[b] === 1;
    if (a === EL.OIL || b === EL.OIL) return a === b;
    if (isVaporFamily(a)) return isVaporFamily(b);
    return isSolutionMedium(a) && isSolutionMedium(b);
  }

  // Записывает состав в клетку и подбирает ей элемент по правилам
  // пользователя:
  //  - одни газы — газ: одного вида — его элемент (пар, кислотный газ...),
  //    нескольких — "смешанный газ";
  //  - иначе газ не в счёт (он выйдет отдельным пикселем, см. splitGas), а
  //    жидкое и твёрдое меряются числом долей: твёрдых (и сыпучих) не
  //    меньше — клетка твёрдая, элементом того твёрдого, которого больше
  //    всего; при равенстве берётся прежний тип клетки, если он из
  //    претендентов (иначе ржавчина от одной чужой доли могла бы
  //    перескочить в соседний элемент);
  //  - жидкость: одного вида — его элемент; смесь — "раствор". Кроме
  //    жидкостей вне семейства растворов (лава, масло): с примесью
  //    твёрдого они остаются собой — лава с долей камня всё ещё лава;
  //  - сплавы (sim/alloys.js): смесь одних расплавов — "Расплав"; твёрдое
  //    из двух и больше видов сплавных долей, среди которых есть металл, —
  //    "Сплав", а проржавевшее на ALLOY_CRUMBLE_AT долей — рыхлая ржавчина
  //    сплава.
  // Пустота на выбор элемента не влияет: неполная клетка воды это всё ещё
  // вода. Клетка без единой вещественной доли исчезает.
  //
  // Тип ставится напрямую, а не через spawn(): температура, оттенок и
  // прочие поля принадлежат той же самой частице и меняться не должны.
  //
  // Раньше здесь было отдельное правило "солей 6 долей и больше —
  // сыпучее"; теперь это частный случай общего: соль твёрдая, и 5 долей
  // соли на 5 воды — уже сыпучее (поровну — в пользу твёрдого).
  setComposition(i, comp) {
    let gas = 0, liquid = 0, solid = 0;
    let gasKinds = 0, gasId = 0, liqKinds = 0, liqId = 0, solidId = 0, solidBest = 0;
    let moltenKinds = 0, alloyKinds = 0, metallic = false, rust = 0;
    const cur = this.type[i];
    for (let s = 0; s < SOL_SLOTS; s++) {
      const slot = solSlot(comp, s);
      if (!slot) break;
      const id = slotId(slot), n = slotCount(slot);
      const st = PART_STATE[id];
      if (st === STATE_GAS) { gas += n; gasKinds++; gasId = id; }
      else if (st === STATE_LIQUID) { liquid += n; liqKinds++; liqId = id; if (IS_MOLTEN[id] === 1) moltenKinds++; }
      else {
        solid += n;
        if (ALLOY_PART[id] === 1) { alloyKinds++; if (ALLOY_METALLIC[id] === 1) metallic = true; }
        if (ALLOY_OXIDE_PART[id] === 1) rust += n;
        if (n > solidBest || (n === solidBest && id === cur)) { solidBest = n; solidId = id; }
      }
    }
    if (gas + liquid + solid === 0) { this.clearCell(i); return; }
    let id;
    if (liquid + solid === 0) id = gasKinds === 1 ? gasId : EL.VAPOR;
    else if (solid >= liquid) id = alloyKinds >= 2 && metallic ? (rust >= ALLOY_CRUMBLE_AT ? EL.ALLOY_RUST : EL.ALLOY) : solidId;
    else if (liqKinds === 1 && (solid === 0 || !isSolutionFamily(liqId))) id = liqId;
    else if (moltenKinds === liqKinds) id = EL.MOLTEN_ALLOY;
    else id = EL.SOLUTION;
    if (this.type[i] !== id) { this.type[i] = id; this.markDirty(i); }
    this.setComp(i, comp);
  }

  // Случайный ВЕЩЕСТВЕННЫЙ вид из состава, взвешенный по числу долей.
  // Пустота не участвует: у неё свои правила движения (tickCompaction).
  // -1 = вещества в клетке не осталось вовсе.
  randomMatterPart(comp) {
    const matter = solMatter(comp);
    if (matter <= 0) return -1;
    let r = (Math.random() * matter) | 0;
    for (let s = 0; s < SOL_SLOTS; s++) {
      const slot = solSlot(comp, s);
      if (!slot) break;
      const c = slotCount(slot);
      if (r < c) return slotId(slot);
      r -= c;
    }
    return -1;
  }

  // Ближайшая пустая клетка для новой фазы: сначала предпочтительное
  // направление (вверх для газа, вниз для капли), затем бока, затем
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

  // Полный тик состава клетки: возможный фазовый переход, выход газа
  // отдельным пикселем, стягивание пустоты. Между ними проверка типа:
  // переход мог увести клетку из живых составов (например, всё замёрзло).
  tickComposition(x, y, i) {
    // Чистая полная клетка (одно вещество, все 10 долей — почти любая вода
    // и масло в мире): реагенту с водой здесь не встретиться, делить на газ
    // нечего, пустоты нет — остаётся только фазовый переход. Прочие шаги
    // вышли бы сразу, ничего не тратя, так что выход тот же.
    const c = this.comp(i);
    if (c < 1024 && ((c >>> 6) & 15) === SOL_PARTS) { this.tickPhase(x, y, i); return; }
    this.quenchReagentWater(i);
    if (!this.hasParts(i)) return;
    this.tickPhase(x, y, i);
    if (!this.hasParts(i)) return;
    this.splitGas(x, y, i);
    if (!this.hasParts(i)) return;
    this.tickCompaction(x, y, i);
  }

  // Фазовый переход одного вида за тик: все доли этого вида разом
  // превращаются в его газ, жидкость или твёрдое (см. PHASE_LINKS).
  //
  //  - Жидкость кипит, когда температура дошла до её точки кипения; из
  //    нескольких кипящих первой уходит самая летучая. Пример из
  //    постановки: раствор 5 воды + 2 кислоты + 3 реагента при 60 градусах
  //    — в газ превращаются ровно 2 доли кислоты, и они выходят рядом
  //    кислотным газом (splitGas), а вода и реагент остаются лежать.
  //  - Газ, остывший ниже точки кипения своей жидкости, выпадает; из
  //    нескольких первым — наименее летучий. Масляный газ — по сроку (life),
  //    а не по температуре.
  //  - Жидкость ниже точки замерзания застывает (первым — вид с самой
  //    высокой точкой замерзания: при охлаждении раствора сперва выходит
  //    лёд), твёрдое выше неё — тает.
  // Что станет со всей клеткой, решает setComposition: вся материя ушла
  // в газ — клетка стала газом на месте; вода в растворе замёрзла
  // наполовину — твёрдого не меньше, чем жидкого, и это уже лёд с кислотой
  // внутри.
  //
  // Оптимизация. Проверка стоит на каждой клетке каждого кадра, поэтому
  // разбор идёт по ячейкам состава (их обычно одна-две), а редкие переходы
  // бросают кость только тогда, когда условие по температуре уже выполнено.
  tickPhase(x, y, i) {
    const T = this.temp[i];
    const comp = this.comp(i);
    // Отсев одним сравнением для клетки из одного вещества (почти любая
    // вода и пар в мире): вода между 0 и 100 градусами ничем не станет.
    // Без него мир из воды шёл на 12% медленнее прежнего формата.
    if (comp < 1024) {
      const id = comp & 63;
      const st = PART_STATE[id];
      if (st === STATE_LIQUID && T > FREEZE_POINT[id] && T < BOIL_POINT[id]) return;
      if (st === STATE_GAS && id !== EL.OIL_GAS && (!CONDENSE_TO[id] || T >= BOIL_POINT[CONDENSE_TO[id]])) return;
      if (st === STATE_SOLID && (!THAW_TO[id] || T <= FREEZE_POINT[THAW_TO[id]])) return;
    }
    let freezeId = 0, boilId = 0, condId = 0, thawId = 0;
    for (let s = 0; s < SOL_SLOTS; s++) {
      const slot = solSlot(comp, s);
      if (!slot) break;
      const id = slotId(slot);
      const st = PART_STATE[id];
      if (st === STATE_LIQUID) {
        if (FREEZE_TO[id] && T <= FREEZE_POINT[id] && (!freezeId || FREEZE_POINT[id] > FREEZE_POINT[freezeId])) freezeId = id;
        if (BOIL_TO[id] && T >= BOIL_POINT[id] && (!boilId || BOIL_POINT[id] < BOIL_POINT[boilId])) boilId = id;
      } else if (st === STATE_GAS) {
        const liq = CONDENSE_TO[id];
        if (!liq) continue;
        const due = id === EL.OIL_GAS ? this.life[i] <= 0 : T < BOIL_POINT[liq];
        if (due && (!condId || BOIL_POINT[liq] > BOIL_POINT[CONDENSE_TO[condId]])) condId = id;
      } else if (st === STATE_SOLID) {
        const liq = THAW_TO[id];
        if (liq && T > FREEZE_POINT[liq]) thawId = id;
      }
    }
    let from = 0, to = 0;
    if (freezeId && Math.random() < FREEZE_CHANCE) { from = freezeId; to = FREEZE_TO[freezeId]; }
    else if (boilId) { from = boilId; to = BOIL_TO[boilId]; }
    else if (condId && (condId === EL.OIL_GAS || Math.random() < COND_CHANCE)) { from = condId; to = CONDENSE_TO[condId]; }
    else if (thawId && Math.random() < MELT_CHANCE) { from = thawId; to = THAW_TO[thawId]; }
    if (!from) return;
    const n = solGet(comp, from);
    const next = solWith(solWith(comp, from, 0), to, solGet(comp, to) + n);
    if (solMatter(next) !== solMatter(comp)) return;   // шестой вид не поместился — ждём
    // Выпавшее из газа масло начинает жизнь жидкостью заново, без срока.
    if (from === EL.OIL_GAS) this.life[i] = 0;
    this.setComposition(i, next);
  }

  // Газ в одной клетке с жидкостью или твёрдым выходит в свободную
  // соседнюю клетку отдельным пикселем (просьба: "если намешано что-либо
  // и газообразное, оно при наличии рядом свободного пространства создаёт
  // отдельный пиксель газа"). Места нет — газ ждёт внутри, а клетка
  // остаётся жидкой или твёрдой по остальному составу.
  splitGas(x, y, i) {
    const comp = this.comp(i);
    if (comp < 1024) return;   // одна ячейка — делить нечего
    let gasComp = 0, rest = comp, other = false;
    for (let s = 0; s < SOL_SLOTS; s++) {
      const slot = solSlot(comp, s);
      if (!slot) break;
      const id = slotId(slot);
      if (PART_STATE[id] === STATE_GAS) {
        gasComp = solWith(gasComp, id, slotCount(slot));
        rest = solWith(rest, id, 0);
      } else other = true;
    }
    if (!gasComp || !other) return;
    const target = this.freeNeighbour(x, y, true);
    if (target < 0) return;
    const T = this.temp[i];
    this.setComposition(i, rest);
    this.temp[target] = T;
    const life = solGet(gasComp, EL.OIL_GAS)
      ? OIL_GAS_LIFE_MIN + (Math.random() * (OIL_GAS_LIFE_MAX - OIL_GAS_LIFE_MIN) | 0) : 0;
    this.placeGas(target, gasComp, life, false);
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
  // вещественная доля приходит к нам. Объём мира при этом сохраняется —
  // и если нашей клетке эту долю некуда положить (пять разных веществ
  // уже есть), обмена нет.
  tickCompaction(x, y, i) {
    const comp = this.comp(i);
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
      const vn = solGet(this.comp(ni), P_VOID);
      if (vn === 0 || vn < v) continue;
      const pref = gas ? DY4[k] > 0 : DY4[k] < 0;
      if (vn === v && !pref) continue;
      const score = vn * 2 + (pref ? 1 : 0);
      if (score > bestScore) { bestScore = score; best = ni; }
    }
    if (best < 0) return;
    const nComp = this.comp(best);
    const kind = this.randomMatterPart(nComp);
    if (kind < 0) return;
    const mine = solMove(comp, P_VOID, kind);
    if (mine === comp) return;
    this.setComposition(i, mine);
    this.setComposition(best, solMove(nComp, kind, P_VOID));
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
    // Два сыпучих (грязь, чёрные соли) сами собой не мешаются — только при
    // движении (powderMix, sim/mud.js).
    if (IS_POWDER_MIX[id] === 1 && IS_POWDER_MIX[nid] === 1) return;
    const a = this.comp(i), b = this.comp(ni);
    // Одно и то же чистое вещество по обе стороны — меняться нечем (любой
    // обмен вернул бы те же составы); выходим, не тратя бросков. Это почти
    // каждая клетка озера или лужи расплава.
    if (a === b && a < 1024) return;
    if (solGet(a, P_VOID) === 0 && solGet(b, P_VOID) === 0
        && ((id === EL.ACID && nid === EL.WATER) || (id === EL.WATER && nid === EL.ACID))) {
      const half = solWith(solWith(0, P_ACID, SOL_PARTS / 2), P_WATER, SOL_PARTS / 2);
      this.setComposition(i, half);
      this.setComposition(ni, half);
      return;
    }
    if (Math.random() >= MIX_CHANCE) return;
    const pa = this.randomMatterPart(a), pb = this.randomMatterPart(b);
    if (pa < 0 || pb < 0 || pa === pb) return;
    const a2 = solMove(a, pa, pb), b2 = solMove(b, pb, pa);
    if (a2 === a || b2 === b) return;   // шестой вид не поместился
    this.setComposition(i, a2);
    this.setComposition(ni, b2);
  }

  // Температура, с которой рождается газ данного вида: на
  // GAS_SPAWN_MARGIN выше точки кипения его жидкости. Без запаса свежий
  // газ стоит ровно на границе перехода, и первый же бросок конденсации
  // возвращает его обратно в жидкость, не дав никуда подняться. Для того,
  // что по температуре не кипит вовсе (масло), — горячий выхлоп.
  gasSpawnTemp(gasId) {
    const liq = CONDENSE_TO[gasId];
    const boil = liq ? BOIL_POINT[liq] : Infinity;
    return boil === Infinity ? HOT_GAS_TEMP : boil + GAS_SPAWN_MARGIN;
  }

  // Любой газ: считает свой срок (он есть только у газа масла),
  // перемешивается с соседним газом, переходит в жидкость покомпонентно и
  // стягивает пустоту. Кислотный газ при этом НЕ разъедает ничего:
  // разъедание живёт в reactSolutionLike, то есть в жидкой фазе. Пока
  // кислота летает газом, она свои свойства не проявляет и просто ждёт,
  // когда остынет ниже 60 и выпадет обратно.
  //
  // Пар растворителя — то же, что растворитель (просьба: "пар должен иметь
  // такие же свойства"): меняется долями с чем угодно по своей доле в
  // газе (см. dissolverMix).
  reactVapor(x, y, i) {
    if (this.life[i] > 0) this.life[i]--;
    this.mixParts(x, y, i);
    const dg = solGet(this.comp(i), P_DISSOLVER_GAS);
    if (dg && Math.random() < DISSOLVER_MIX_CHANCE * dg / SOL_PARTS) this.dissolverMix(x, y, i);
    if (!this.hasParts(i)) return;
    this.tickComposition(x, y, i);
  }
}

extendSim(SimComposition);
