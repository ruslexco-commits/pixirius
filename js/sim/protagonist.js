'use strict';

// Протагонист (EL.PROTAGONIST) — пиксель, которым управляет игрок в режиме
// игры (js/play.js, клавиша P). Падает он сам, своей гравитацией с разгоном
// (reactProtagonist), а не общей физикой сыпучего: песчинка на краю уступа
// скатывается по диагонали, и протагонист, шагнув на кочку в пиксель, в
// следующем кадре съезжал с неё обратно, а у края любой площадки сползал
// вниз (сообщил пользователь: "должен без проблем взбираться на
// неровности"). Поэтому только прямо вниз, в воде — медленно. Для обхода
// клеток он по-прежнему сыпучее (CAT.POWDER): тяжёлое проваливается сквозь
// него, а updateCell его движением не занимается. Гибнет по тем же
// правилам, что человек: касание смертельного (humanDeadly) и вода над
// головой дольше HUMAN_DROWN_FRAMES кадров. Мёртвый темнеет и больше не
// слушается, только падает.
//
// В одиночной игре он на поле один: новый, поставленный кистью, заменяет
// прежнего (placeProtagonist). Кисть для него — одна клетка в центре
// (brushRadiusFor в input.js), как у человека.
//
// Мультиплеер (js/net.js, js/lobby.js): протагонистов несколько, у каждого
// номер игрока в life клетки (0 — одиночная игра). Управление и состояние —
// у каждого своё: this.players[номер] = { input, state, idx, serial }
// (playerSlot). this.playerInput и this.playerState — то же самое у
// игрока 0, ради старого кода одиночной игры. Цвет протагониста игрока —
// this.playerColors[номер] (рендер и шейдер).
//
// Управление приходит от интерфейса через input своего игрока: влево/вправо
// держатся (left/right), прыжок — разовое нажатие (jump), вверх/вниз —
// плыть в жидкости (up/down; "вверх" держат W или пробел: всплывать и
// держаться на плаву). Состояние между кадрами (дыхание, фаза
// прыжка, скорость падения) — в state своего игрока.
//
// Прыжок плавный: подъём на PLAYER_JUMP клеток по клетке раз в
// PLAYER_RISE_FRAMES кадров, зависание в верхней точке, потом падение с
// разгоном. Раньше он переносился на две клетки вверх за один кадр и в
// следующем же начинал падать по клетке за кадр — дёргано, и допрыгнуть до
// верха стены в две клетки удавалось лишь случайно, если шаг вбок попадал
// ровно в тот единственный кадр наверху. Теперь в воздухе можно шагать, а
// в верхней точке он висит несколько шагов: стена в две клетки берётся
// прыжком со шагом в её сторону. Ступенька в одну клетку перешагивается
// с опоры всегда, без прыжка.
//
// Ломание (просьба пользователя): игрок зажимает ЛКМ — от протагониста к
// курсору проводится линия (input.mine, клетка курсора input.ax/ay, см.
// js/play.js). Первый твёрдый или сыпучий пиксель на ней, если он вплотную
// к протагонисту (8 соседей), ломается: удар раз в MINE_HIT_FRAMES кадров,
// ударов нужно столько, какова стойкость пикселя (cellStability: камень 5,
// железо 10), у сыпучего — MINE_POWDER_HITS. Пиксель темнеет по ударам: к
// последнему пережитому — на MINE_DARK_MAX своей яркости, каждый удар — на равную долю этого
// (shade — его и рисуют рендер и шейдер; просьба пользователя). Последний удар —
// пиксель исчезает. Стена и прочие якоря не ломаются. Ломание — часть шага
// мира (по нажатиям, как ходьба), поэтому в мультиплеере идёт по сиду у
// всех одинаково.
//
// Игрок на игроке (кооператив, просьба пользователя): кто стоит на другом
// протагонисте — едет с ним. Нижний шагнул вбок или на уступ — верхний
// переносится так же (carryRider), нижний поднимается в прыжке — верхнего
// сначала приподнимает (liftRider). Перенос — не ход верхнего (moved не
// ставится): в том же кадре он ещё сходит сам, и если шагает в ту же
// сторону, за кадр выходит две клетки — обгоняет нижнего; прыгнув с
// прыгающего, берёт препятствие в 4 клетки (2 нижнего + 2 своих). Стопка из
// нескольких едет вся. Вниз не переносится: падает верхний сам.
//
// Методы класса Sim, вынесенные в отдельный файл: класс ниже — только
// контейнер, extendSim переносит его методы в Sim.prototype (см. core.js).

// Ломание: удар раз в столько кадров; ударов у сыпучего; насколько темнеет
// пиксель к последнему пережитому удару (доля яркости).
const MINE_HIT_FRAMES = 10;
const MINE_POWDER_HITS = 2;
const MINE_DARK_MAX = 0.8;
// Скорость копания — множитель хоста (sim.digSpeed, js/net.js): MINE_SPEED_NORMAL
// — обычная (удар раз в MINE_HIT_FRAMES кадров), больше — чаще, 0 — копать
// нельзя. Удар по пикселю стоит выносливости (той же, что тратится вплавь),
// не хватает — удар ждёт, пока она восстановится (просьба пользователя).
const MINE_SPEED_NORMAL = 10;
// Выносливость тратится, пока игрок бьёт (зажата ЛКМ и есть цель), — ровно,
// MINE_STAMINA_DRAIN в кадр, и пока бьёт, не восстанавливается (просьба
// пользователя: "не с каждым ударом, а во время приказа ударять"). Кончилась
// — удары ждут.
const MINE_STAMINA_DRAIN = 1.25;
// На сколько клеток (по большей из осей) дотягивается удар: первый
// непроходимый пиксель на линии к курсору в этих пределах (просьба
// пользователя: "радиус ломания — 2 пикселя").
const MINE_REACH = 2;

// Шаг вбок — раз в столько кадров, пока клавиша держится: каждый кадр
// выходило 60 клеток в секунду, пиксель пролетал экран за десять секунд
// и на мелких уступах проскакивал мимо.
const PLAYER_STEP_FRAMES = 2;
// Высота прыжка в клетках (просьба: "прыгнуть на 2 пикселя вверх" — для одного
// пикселя; с телом в 16 клеток, просьба пользователя о многоклеточном
// протагонисте, — четыре).
const PLAYER_JUMP = 4;
// Ступенька, на которую он шагает без прыжка (клеток; с телом в 16 клеток —
// две).
const PLAYER_STEP_UP = 2;
// Подъём в прыжке — клетка раз в столько кадров; зависание наверху.
const PLAYER_RISE_FRAMES = 3;
const PLAYER_HANG_FRAMES = 5;
// Падение: разгон за кадр и предел (клеток за кадр); в жидкости — медленно.
const PLAYER_GRAVITY = 0.12;
const PLAYER_FALL_MAX = 1;
const PLAYER_SINK_MAX = 0.2;
// Прыжок, нажатый чуть раньше приземления, не теряется: столько кадров
// нажатие ждёт опоры.
const PLAYER_JUMP_BUFFER = 6;
// Всплытие и нырок в жидкости — раз в столько кадров.
const PLAYER_SWIM_FRAMES = 3;

class SimProtagonist {
  initProtagonist() {
    // Игроки по номеру (см. шапку). 0 — одиночная игра.
    this.players = [];
    this.playerColors = [];
    this.playerSlot(0);
    this.playerInput = this.players[0].input;
    this.playerState = this.players[0].state;
    // Насколько протагонист видит карту в игре (выбирается лупой, js/play.js):
    // 3 — только прямой взгляд и память, 2 — вся карта известна с начала
    // игры, а изменения видны только вблизи, 1 — видно всё, как в редакторе.
    this.playerVision = 3;
    // Лучевое зрение (выбирается лупой, js/play.js PLAY_RAYS): из протагониста,
    // как из камеры, расходятся лучи.
    this.playerRays = false;
    // Растёт, когда протагониста игрока 0 ставят на поле, где его не было:
    // для интерфейса это новый персонаж, и его память о карте начинается
    // заново (см. js/play.js). У игроков мультиплеера — свой serial.
    this.playerSerial = 0;
    // Регенерация урона живых (creatureHeal, sim/creature.js): правило мира, в
    // настройках (шестерёнка), входит в отмену (rules) и идёт вкладкам с тиком.
    this.regenOn = true;
  }

  // Управление и состояние игрока n (создаются при первом обращении).
  // state.death — от чего погиб (строка для экрана игры), deathKind — вид
  // смерти для точек респавна (sim/spawns.js), null — жив.
  playerSlot(n) {
    let p = this.players[n];
    if (!p) {
      p = this.players[n] = {
        input: { left: false, right: false, up: false, down: false, jump: false, mine: false, ax: 0, ay: 0 },
        state: { wet: 0, rise: 0, riseT: 0, hang: 0, vy: 0, fy: 0, jumpBuf: 0, stamina: SWIM_STAMINA, exhausted: false, death: null, deathKind: null, mineCell: -1, mineHits: 0, mineT: 0 },
        // Где протагонист был в прошлый раз (главная клетка) — чтобы
        // findProtagonist не искал его по всему полю каждый кадр.
        idx: -1,
        serial: 0,
      };
    }
    return p;
  }

  // Состояние "только что поставлен": живой, на опоре, отдышался.
  resetPlayerState(st) {
    Object.assign(st, { wet: 0, rise: 0, riseT: 0, hang: 0, vy: 0, fy: 0, jumpBuf: 0, stamina: SWIM_STAMINA, exhausted: false, death: null, deathKind: null, mineCell: -1, mineHits: 0, mineT: 0 });
  }

  // Главная клетка протагониста игрока n (0 — одиночная игра) или -1.
  findProtagonist(n = 0) {
    const pl = this.playerSlot(n);
    const k = pl.idx, type = this.type, life = this.life, extra = this.extra, w = this.w;
    const isPivot = (j) => type[j] === EL.PROTAGONIST && life[j] === n && (extra[j] & 127) === PERSON_PIVOT;
    if (k >= 0 && k < type.length) {
      if (isPivot(k)) return k;
      // Падение или шаг за кадр сдвигают тело — сначала смотрим рядом, а не по
      // всему полю.
      const kx = k % w, ky = (k / w) | 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const x = kx + dx, y = ky + dy;
          if (x < 0 || x >= w || y < 0 || y >= this.h) continue;
          const j = y * w + x;
          if (isPivot(j)) { pl.idx = j; return j; }
        }
      }
    }
    for (let i = 0; i < type.length; i++) if (isPivot(i)) { pl.idx = i; return i; }
    pl.idx = -1;
    return -1;
  }

  // Вид смерти (для точек респавна, sim/spawns.js) по веществу касания t.
  playerDeathKind(t) {
    if (t === EL.FIRE) return 'fire';
    if (t === EL.LAVA || IS_MOLTEN[t] === 1) return 'lava';
    if (t === EL.ACID || t === EL.SOLUTION) return 'acid';
    if (t === EL.REAGENT) return 'reagent';
    if (t === EL.OXIDE || t === EL.OXIDE_LOOSE) return 'oxide';
    return 'other';
  }

  // Причина смерти от смертельного касания вещества t — для экрана игры.
  playerDeathCause(t) {
    if (t === EL.FIRE) return 'Сгорел в огне';
    if (t === EL.LAVA) return 'Сгорел в лаве';
    if (IS_MOLTEN[t] === 1) return 'Сгорел в расплавленном металле';
    if (t === EL.ACID) return 'Растворён кислотой';
    if (t === EL.REAGENT) return 'Отравлен реагентом';
    if (t === EL.SOLUTION) return 'Растворён кислотным раствором';
    if (t === EL.OXIDE || t === EL.OXIDE_LOOSE) return 'Отравлен окислом камня';
    return 'Погиб: ' + (ELEMENTS[t] ? ELEMENTS[t].name.toLowerCase() : 'неизвестно');
  }

  // Поставить протагониста одиночной игры (игрок 0) с низом по центру в клетке
  // i, убрав прежнего: он один. Протагонистов игроков мультиплеера кисть не
  // трогает.
  placeProtagonist(i) {
    const had = this.placePlayer(0, i);
    if (!had) this.playerSerial++;
  }

  // Поставить протагониста игрока n с главной клеткой i (прежний этого игрока
  // убирается). Тело должно поместиться: не вмещается в i — ищется место
  // выше (до высоты тела), нигде — прежний остаётся на месте и ничего не
  // происходит. true — он уже был на поле.
  placePlayer(n, i) {
    const w = this.w, pl = this.playerSlot(n);
    const old = this.findProtagonist(n);
    const had = old >= 0;
    let oldDead = false;
    if (had) { oldDead = this.creatureDeadAt(old); this.removeCreature(old); }
    const x = i % w, y0 = (i / w) | 0;
    let p = -1;
    for (let up = 0; p < 0 && up <= PERSON_HEIGHT; up++) p = this.placeCreature(x, y0 - up, EL.PROTAGONIST, n, false);
    if (p < 0) {
      // Нет места — прежний на месте (он был, пока не убрали).
      if (had) this.placeCreature(old % w, (old / w) | 0, EL.PROTAGONIST, n, oldDead);
      return had;
    }
    pl.idx = p;
    this.resetPlayerState(pl.state);
    if (!had) pl.serial++;
    // Когда появился (таймер жизни в игре и чат о смерти: "сколько прожил").
    pl.bornAt = this.frame;
    // Новый протагонист не копает по старой зажатой кнопке.
    pl.input.mine = false;
    return had;
  }

  // Может ли протагонист войти в клетку сам (шагом или вплавь): пустота,
  // жидкость и газ — он их раздвигает, как тонущее тело.
  playerCanEnter(t) {
    if (t === EL.EMPTY) return true;
    const el = ELEMENTS[t];
    return !!el && (el.cat === CAT.LIQUID || el.cat === CAT.GAS);
  }

  // Протагонист, стоящий на голове тела с главной клеткой p (его стопы — в
  // ряду над макушкой): его главная клетка или -1. Живой.
  riderOf(p) {
    const w = this.w, y = ((p / w) | 0) - PERSON_HEIGHT, x0 = p % w;
    if (y < 0) return -1;
    for (let dx = -PERSON_PIVOT_COL; dx < PERSON_COLS - PERSON_PIVOT_COL; dx++) {
      const x = x0 + dx;
      if (x < 0 || x >= w) continue;
      const j = y * w + x;
      if (this.type[j] !== EL.PROTAGONIST || this.creatureDeadAt(j)) continue;
      const r = this.creaturePivot(j);
      if (r >= 0 && ((r / w) | 0) === y) return r;
    }
    return -1;
  }

  // Может ли тело p подняться на k клеток вместе со стоящими на нём (верхний
  // поднимается первым — его клетки над макушкой нижнего считаются свободными).
  canRise(p, k) {
    const r = this.riderOf(p);
    if (r >= 0 && !this.canRise(r, k)) return false;
    return this.creatureFree(p, 0, -k, true, r);
  }

  // Сдвинуть тело p на (dx, dy) вместе со стоящими на нём (см. шапку): вбок —
  // нижний, потом верхний; вверх — сначала верхний, потом нижний (иначе
  // макушка упёрлась бы в стопы); вниз верхний падает сам. Возвращает новую
  // главную клетку p или -1, если нижний не может.
  moveWithRiders(p, dx, dy) {
    const r = dy <= 0 ? this.riderOf(p) : -1;
    if (dy < 0 && r >= 0 && this.moveWithRiders(r, dx, dy) < 0) return -1;
    if (!this.creatureFree(p, dx, dy, true)) return -1;   // верхний уже ушёл
    const np = this.creatureMove(p, dx, dy);
    this.playerSlot(this.life[np]).idx = np;
    if (dy === 0 && r >= 0) this.moveWithRiders(r, dx, dy);
    return np;
  }

  // Ломается ли вещество t: твёрдое или сыпучее, кроме якорей (стена) и
  // живых существ.
  mineable(t) {
    const el = ELEMENTS[t];
    if (!el || IS_ANCHOR[t] === 1) return false;
    if (t === EL.PROTAGONIST || t === EL.HUMAN || t === EL.COLONIST) return false;
    return el.cat === CAT.SOLID || el.cat === CAT.POWDER;
  }

  // Сколько ударов нужно пикселю j: по стойкости, у сыпучего — MINE_POWDER_HITS.
  mineHitsNeeded(j) {
    const t = this.type[j];
    if (ELEMENTS[t].cat === CAT.POWDER) return MINE_POWDER_HITS;
    return Math.max(1, Math.ceil(this.cellStability(j, t)));
  }

  // Что ломает протагонист с главной клеткой p, целясь в (ax, ay): прямая от
  // руки (середина тела) к курсору идёт сквозь своё тело; первый
  // непроходимый чужой пиксель на ней, если он в пределах MINE_REACH от
  // тела (по большей из осей, от габарита тела), ломается, иначе -1.
  // Жидкость, газ и огонь линия проходит насквозь.
  playerMineTarget(p, ax, ay) {
    const w = this.w, h = this.h, x0 = p % w, y0 = (p / w) | 0, type = this.type, me = this.life[p];
    const hx = x0, hy = y0 + PERSON_MID_DY;
    const dx = Math.abs(ax - hx), dy = -Math.abs(ay - hy), sx = hx < ax ? 1 : -1, sy = hy < ay ? 1 : -1;
    let err = dx + dy, x = hx, y = hy;
    for (let k = 0; k < 4 * MINE_REACH + 2 * PERSON_HEIGHT; k++) {
      if (x === ax && y === ay) return -1;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
      if (!this.inBounds(x, y)) return -1;
      // Расстояние от габарита тела (своё тело линия проходит).
      const ex = Math.max(x0 - PERSON_PIVOT_COL - x, x - (x0 + PERSON_COLS - 1 - PERSON_PIVOT_COL), 0);
      const ey = Math.max(y0 - (PERSON_ROWS - 1) - y, y - y0, 0);
      if (Math.max(ex, ey) > MINE_REACH) return -1;
      if (ex === 0 && ey === 0 && personRel(x - x0, y - y0) >= 0) continue;   // своя клетка
      const j = y * w + x, t = type[j];
      if (t === EL.EMPTY || t === EL.FIRE || IS_LIQUID[t] === 1 || IS_GASLIKE[t] === 1) continue;
      return this.mineable(t) || this.hittable(t, j, me) ? j : -1;
    }
    return -1;
  }

  // Можно ли ударить живого в клетке j протагонисту игрока me: человека —
  // всегда, другого игрока — только с "огнём по своим" (sim.friendlyFire).
  hittable(t, j, me) {
    if (this.creatureDeadAt(j)) return false;
    if (t === EL.HUMAN) return true;
    return t === EL.PROTAGONIST && this.life[j] !== me && !!this.friendlyFire;
  }

  // Удар по цели, пока зажата кнопка (см. шапку). Сменилась цель — счёт
  // ударов заново; первый удар — сразу.
  playerMine(i, inp, st) {
    const j = inp.mine ? this.playerMineTarget(i, inp.ax | 0, inp.ay | 0) : -1;
    if (j < 0) { st.mineCell = -1; st.mineHits = 0; return; }
    const full = MINE_HIT_FRAMES * MINE_SPEED_NORMAL;
    if (j !== st.mineCell) { st.mineCell = j; st.mineHits = 0; st.mineT = full; st.mineShade0 = this.shade[j]; }
    // Бьёт — выносливость уходит ровно и не восстанавливается (см. MINE_STAMINA_DRAIN).
    st.stamina = Math.max(0, st.stamina - (st.regenNow || 0) - MINE_STAMINA_DRAIN);
    // Живой — удар (sim/human.js, hitCreature), а не ломание: раз в
    // MINE_HIT_FRAMES кадров, без множителя и выносливости.
    const tj = this.type[j];
    if (tj === EL.HUMAN || tj === EL.PROTAGONIST) {
      if (st.mineT < full) { st.mineT += MINE_SPEED_NORMAL; return; }
      st.mineT -= full - MINE_SPEED_NORMAL;
      if (this.hitCreature(j, i)) { st.mineCell = -1; st.mineHits = 0; }
      return;
    }
    // Пиксель: накопитель mineT растёт на скорость копания, удар — когда
    // набралось full (первый — сразу), и только если хватает выносливости.
    const speed = this.digSpeed === undefined ? MINE_SPEED_NORMAL : this.digSpeed;
    if (speed <= 0) return;
    if (st.mineT < full) { st.mineT += speed; return; }
    if (st.stamina <= 0) return;
    st.mineT -= full - speed;
    if (++st.mineHits >= this.mineHitsNeeded(j)) {
      this.clearCell(j);
      const pl = this.playerSlot(this.life[i]);
      if (pl.stats) pl.stats.broken++;
      st.mineCell = -1; st.mineHits = 0;
      return;
    }
    // Темнеет к MINE_DARK_MAX к последнему пережитому удару (см. шапку).
    const need = this.mineHitsNeeded(j), col = ELEMENTS[this.type[j]].color;
    const lum = (col[0] + col[1] + col[2]) / 3, k = need > 1 ? st.mineHits / (need - 1) : 1;
    this.shade[j] = Math.max(-128, Math.round((st.mineShade0 || 0) - MINE_DARK_MAX * lum * k));
    this.markDirty(j);
  }

  // Вода у тела: жидкость сбоку на уровне туловища или под ногами; макушка
  // под водой — над макушкой жидкость. Размеры — от формы тела.
  bodyInWater(p) {
    const w = this.w, h = this.h, type = this.type, x0 = p % w, y0 = (p / w) | 0;
    const liq = (x, y) => x >= 0 && x < w && y >= 0 && y < h && IS_LIQUID[type[y * w + x]] === 1;
    for (let dx = -PERSON_PIVOT_COL; dx < PERSON_COLS - PERSON_PIVOT_COL; dx++) if (liq(x0 + dx, y0 + 1)) return true;
    for (const dy of [-1, -5, -9]) if (liq(x0 - PERSON_PIVOT_COL - 1, y0 + dy) || liq(x0 + PERSON_COLS - PERSON_PIVOT_COL, y0 + dy)) return true;
    return false;
  }

  // Жидкость над макушкой.
  bodyHeadUnder(p) {
    const w = this.w, y = ((p / w) | 0) - PERSON_HEIGHT, x0 = p % w;
    if (y < 0) return false;
    for (let dx = -1; dx <= 2; dx++) if (IS_LIQUID[this.type[y * w + x0 + dx]] === 1) return true;
    return false;
  }

  // Уровень воды у головы, как swimLevelOk у одного пикселя: слева и справа от
  // головы нет пустоты, под которой нет опоры.
  bodyLevelOk(p, dy) {
    const x0 = p % this.w, y0 = ((p / this.w) | 0) + dy + PERSON_EYE_DY;
    return this.swimLevelOk(x0 - PERSON_PIVOT_COL - 1, y0) && this.swimLevelOk(x0 + PERSON_COLS - PERSON_PIVOT_COL, y0)
      ? true : false;
  }

  reactProtagonist(x, y, i) {
    const pl = this.playerSlot(this.life[i]);
    pl.idx = i;
    const inp = pl.input, st = pl.state;
    const w = this.w, h = this.h, type = this.type;
    let alive = !this.creatureDeadAt(i);
    // Главная клетка — где тело сейчас; меняется по ходу кадра (подъём или
    // падение и шаг вбок могут случиться в одном кадре).
    let cur = i;

    if (alive) {
      // 1. Касания по клеткам тела: огонь, лава, кислота жгут и разъедают
      //    ту клетку, что касаются; яд травит. Смерть — когда сумма дошла
      //    до порога (creatureDamage), от яда — creaturePoison.
      const con = this.creatureContact(cur);
      if (con.poison > 0) st.poisonKind = con.poisonType === EL.OXIDE || con.poisonType === EL.OXIDE_LOOSE ? 'oxide' : 'reagent';
      if (this.creaturePoison(cur) >= 1) {
        const ox = st.poisonKind === 'oxide';
        st.death = ox ? 'Отравлен окислом камня' : 'Отравлен реагентом';
        st.deathKind = ox ? 'oxide' : 'reagent';
        st.mineCell = -1;
        this.poisonDeathBody(cur);
        pl.idx = -1;
        return;
      }
      if (this.creatureDamage(cur) >= DEATH_DAMAGE) {
        this.creatureKill(cur); alive = false;
        const t = con.lastDeadly || EL.FIRE;
        st.death = this.playerDeathCause(t); st.deathKind = this.playerDeathKind(t);
      }
      // 2. Вода над головой или завален со всех сторон: задыхается за то же
      //    время, что и человек.
      if (alive) {
        const hy = ((cur / w) | 0) - PERSON_HEIGHT;
        const above = hy >= 0 ? type[hy * w + (cur % w)] : EL.EMPTY;
        if (above === EL.WATER || above === EL.SOLUTION || above === EL.BLOOD || this.creatureWalledIn(cur)) {
          st.wet++;
          if (st.wet >= HUMAN_DROWN_FRAMES) {
            this.creatureKill(cur); alive = false;
            const drowned = above === EL.WATER || above === EL.SOLUTION || above === EL.BLOOD;
            st.death = drowned ? 'Утонул' : 'Задохнулся под завалом';
            st.deathKind = drowned ? 'drown' : 'buried';
          }
        } else if (st.wet > 0) {
          st.wet--;
        }
      }
    }
    // Мёртвый не прыгает и не шагает — только падает.
    if (!alive) { inp.jump = false; st.rise = 0; st.hang = 0; st.jumpBuf = 0; }

    const free = (dx, dy) => this.creatureFree(cur, dx, dy, true);
    // Сдвиг вместе со стоящими на нём (см. moveWithRiders).
    const go = (dx, dy) => {
      const np = this.moveWithRiders(cur, dx, dy);
      if (np < 0) return false;
      cur = np;
      return true;
    };
    const grounded = () => !free(0, 1);
    const inWater = () => this.bodyInWater(cur);
    const headUnder = () => this.bodyHeadUnder(cur);
    const airAbove = () => {
      const y = ((cur / w) | 0) - PERSON_HEIGHT;
      return y < 0 || type[y * w + (cur % w)] === EL.EMPTY;
    };

    // 3. Прыжок — с опоры или с поверхности воды (тело в воде, над головой
    //    воздух). Нажатие ждёт опоры PLAYER_JUMP_BUFFER кадров.
    if (alive) {
      if (inp.jump) { st.jumpBuf = PLAYER_JUMP_BUFFER; inp.jump = false; }
      else if (st.jumpBuf > 0) st.jumpBuf--;
      if (st.jumpBuf > 0 && st.rise === 0 && st.hang === 0 && (grounded() || (inWater() && airAbove()))) {
        st.jumpBuf = 0; st.rise = PLAYER_JUMP; st.riseT = 0; st.vy = 0; st.fy = 0;
      }
    }

    // Выносливость: тратится, пока плывёт (всплывает или держится на
    // уровне воды), кончилась — плыть нельзя, пока не встанет на сухое.
    // Сухая опора — не дно под водой: рядом и над головой тоже не вода.
    // regenNow — сколько восстановилось в этом кадре: пока игрок бьёт,
    // оно отбирается обратно (playerMine).
    st.regenNow = 0;
    if (grounded() && !inWater() && !headUnder()) {
      st.exhausted = false;
      const was = st.stamina;
      st.stamina = Math.min(SWIM_STAMINA, st.stamina + SWIM_REGEN);
      st.regenNow = st.stamina - was;
    }
    const canSwim = alive && !st.exhausted && st.stamina > 0;
    let swam = false;

    // 4. По вертикали: подъём прыжка, зависание, плавание или падение.
    if (st.rise > 0) {
      if (st.riseT % PLAYER_RISE_FRAMES === 0) {
        if (go(0, -1)) {
          if (--st.rise === 0) st.hang = PLAYER_HANG_FRAMES;
        } else {
          st.rise = 0;   // ударился головой — падает
        }
      }
      st.riseT++;
    } else if (st.hang > 0) {
      st.hang--;
    } else if (canSwim && inp.up && headUnder() && this.bodyLevelOk(cur, -1)) {
      // Всплывает, пока держат "вверх" (W или пробел), — но не выше уровня
      // воды (см. bodyLevelOk).
      if (this.frame % PLAYER_SWIM_FRAMES === 0) go(0, -1);
      st.vy = 0; st.fy = 0; swam = true;
    } else if (canSwim && inp.up && inWater() && this.bodyLevelOk(cur, 0)) {
      // На уровне воды: держится на плаву, не тонет. Выпрыгнуть — нажать
      // прыжок ещё раз (см. шаг 3). Сбоку пустота — значит, торчит над
      // водой: не держится, уходит глубже (просьба: "чтобы не ходил по воде").
      st.vy = 0; st.fy = 0; swam = true;
    } else if (alive && inp.down && inWater() && this.frame % PLAYER_SWIM_FRAMES === 0) {
      go(0, 1); st.vy = 0; st.fy = 0;
    } else if (grounded()) {
      st.vy = 0; st.fy = 0;
    } else {
      const max = inWater() ? PLAYER_SINK_MAX : PLAYER_FALL_MAX;
      st.vy = Math.min(max, st.vy + PLAYER_GRAVITY);
      st.fy += st.vy;
      while (st.fy >= 1) {
        st.fy -= 1;
        if (!go(0, 1)) { st.vy = 0; st.fy = 0; break; }
      }
    }

    if (swam && --st.stamina <= 0) st.exhausted = true;

    // Ломание (см. шапку) — с того места, где он теперь; раны заживают.
    if (alive) { this.creatureHeal(cur); this.creatureSpread(cur); this.creatureBleed(cur); this.playerMine(cur, inp, st); }
    else st.mineCell = -1;
    // Статистика игрока за раунд (js/net.js: кнопка "Статистика" в лобби):
    // сколько кадров жив, в воде, отравлен; сломанные пиксели — в playerMine.
    if (alive && pl.stats) {
      pl.stats.alive++;
      if (inWater() || headUnder()) pl.stats.water++;
      if (this.creaturePoison(cur) > 0) pl.stats.tox++;
    }

    // 5. Шаг вбок: прямо, а если там препятствие до PLAYER_STEP_UP клеток — на
    //    него (над головой и над препятствием должно быть свободно). Прямой
    //    шаг — и на земле, и в воздухе: с вершины прыжка он шагает на стену
    //    в PLAYER_JUMP клеток. Шаг на уступ — только с опоры: иначе к клеткам
    //    прыжка добавлялись бы ещё.
    const dir = !alive || inp.left === inp.right ? 0 : (inp.left ? -1 : 1);
    if (dir && this.frame % PLAYER_STEP_FRAMES === 0) {
      if (free(dir, 0)) go(dir, 0);
      else if (grounded()) {
        for (let k = 1; k <= PLAYER_STEP_UP; k++) {
          if (!this.canRise(cur, k) || !this.creatureFree(cur, dir, -k, true, this.riderOf(cur))) continue;
          let ok = true;
          for (let s = 0; s < k && ok; s++) ok = go(0, -1);
          if (ok) go(dir, 0);
          break;
        }
      }
    }
  }
}

extendSim(SimProtagonist);
