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
// Высота прыжка в клетках (просьба: "прыгнуть на 2 пикселя вверх").
const PLAYER_JUMP = 2;
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
        // Где протагонист был в прошлый раз — чтобы findProtagonist не
        // искал его по всему полю каждый кадр.
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

  // Индекс клетки протагониста игрока n (0 — одиночная игра) или -1.
  findProtagonist(n = 0) {
    const pl = this.playerSlot(n);
    const k = pl.idx, type = this.type, life = this.life, w = this.w;
    if (k >= 0 && k < type.length) {
      if (type[k] === EL.PROTAGONIST && life[k] === n) return k;
      // Обычная физика сыпучего сдвигает его на клетку (падение, скат) —
      // сначала смотрим рядом, а не по всему полю.
      const kx = k % w, ky = (k / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = kx + dx, y = ky + dy;
          if (x < 0 || x >= w || y < 0 || y >= this.h) continue;
          const j = y * w + x;
          if (type[j] === EL.PROTAGONIST && life[j] === n) { pl.idx = j; return j; }
        }
      }
    }
    for (let i = 0; i < type.length; i++) if (type[i] === EL.PROTAGONIST && life[i] === n) { pl.idx = i; return i; }
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

  // Поставить протагониста одиночной игры (игрок 0) в клетку i, убрав
  // прежнего: он один. Протагонистов игроков мультиплеера кисть не трогает.
  placeProtagonist(i) {
    const had = this.placePlayer(0, i);
    if (!had) this.playerSerial++;
  }

  // Поставить протагониста игрока n в клетку i (прежний этого игрока
  // убирается). true — он уже был на поле.
  placePlayer(n, i) {
    const type = this.type, life = this.life;
    let had = false;
    for (let k = 0; k < type.length; k++) {
      if (type[k] === EL.PROTAGONIST && life[k] === n) { had = true; if (k !== i) this.clearCell(k); }
    }
    if (type[i] !== EL.PROTAGONIST || life[i] !== n) this.spawn(i, EL.PROTAGONIST);
    this.life[i] = n;
    this.extra[i] = 0;
    this.markDirty(i);
    const pl = this.playerSlot(n);
    pl.idx = i;
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

  playerMove(i, ni) {
    this.swapFields(i, ni);
    this.moved[ni] = 1;
    this.playerSlot(this.life[ni]).idx = ni;
  }

  // Живой протагонист в клетке r.
  liveRiderAt(r) { return r >= 0 && r < this.type.length && this.type[r] === EL.PROTAGONIST && this.extra[r] !== 1; }

  // Перенести стоящего в клетке r (и всех, кто стоит на нём) на d: вбок или
  // вбок-вверх, если там свободно (см. шапку).
  carryRider(r, d) {
    if (!this.liveRiderAt(r)) return;
    const w = this.w, t = r + d;
    if (t < 0 || t >= this.type.length || Math.abs((r % w) - (t % w)) > 1) return;
    if (!this.playerCanEnter(this.type[t])) return;
    const above = r - w;
    this.swapFields(r, t);
    this.playerSlot(this.life[t]).idx = t;
    this.carryRider(above, d);
  }

  // Освободить клетку r над поднимающимся: стоящего в ней (со всей
  // стопкой) поднять на клетку. true — клетка теперь свободна.
  liftRider(r) {
    if (!this.liveRiderAt(r)) return false;
    const w = this.w, up = r - w;
    if (up < 0) return false;
    if (!this.playerCanEnter(this.type[up]) && !this.liftRider(up)) return false;
    this.swapFields(r, up);
    this.playerSlot(this.life[up]).idx = up;
    return true;
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

  // Что ломает протагонист в клетке i, целясь в (ax, ay): первый не
  // проходимый пиксель на линии к курсору, если он вплотную к i и
  // ломается, иначе -1. Жидкость, газ и огонь линия проходит насквозь.
  playerMineTarget(i, ax, ay) {
    const w = this.w, x0 = i % w, y0 = (i / w) | 0, type = this.type, me = this.life[i];
    const dx = Math.abs(ax - x0), dy = -Math.abs(ay - y0), sx = x0 < ax ? 1 : -1, sy = y0 < ay ? 1 : -1;
    let err = dx + dy, x = x0, y = y0;
    for (let k = 0; k < 4 * MINE_REACH; k++) {
      if (x === ax && y === ay) return -1;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
      if (Math.abs(x - x0) > MINE_REACH || Math.abs(y - y0) > MINE_REACH || !this.inBounds(x, y)) return -1;
      const j = y * w + x, t = type[j];
      if (t === EL.EMPTY || t === EL.FIRE || IS_LIQUID[t] === 1 || IS_GASLIKE[t] === 1) continue;
      return this.mineable(t) || this.hittable(t, j, me) ? j : -1;
    }
    return -1;
  }

  // Можно ли ударить живого в клетке j протагонисту игрока me: человека —
  // всегда, другого игрока — только с "огнём по своим" (sim.friendlyFire).
  hittable(t, j, me) {
    if (this.extra[j] === 1) return false;
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

  reactProtagonist(x, y, i) {
    const pl = this.playerSlot(this.life[i]);
    pl.idx = i;
    const inp = pl.input, st = pl.state;
    const w = this.w, h = this.h, type = this.type;
    let alive = !this.extra[i];

    if (alive) {
      // 1. Смертельные прикосновения — как у человека (reactHuman); яд
      //    (реагент, окисел камня) — травит, пока не рассыплется окислом.
      let poisoned = 0;
      for (let k = 0; k < 4 && alive; k++) {
        const nx = x + DX4[k], ny = y + DY4[k];
        if (!this.inBounds(nx, ny)) continue;
        const ni = this.idx(nx, ny), nt = type[ni];
        if (this.poisoner(nt, ni)) {
          const r = this.poisonRate(nt, ni);
          if (r > poisoned) { poisoned = r; st.poisonKind = nt === EL.OXIDE || nt === EL.OXIDE_LOOSE ? 'oxide' : 'reagent'; }
          continue;
        }
        if (nt === EL.SOLUTION) {
          const c = this.comp(ni);
          if (!solGet(c, P_ACID)) continue;
        }
        if (this.humanDeadly(nt)) { this.extra[i] = 1; alive = false; st.death = this.playerDeathCause(nt); st.deathKind = this.playerDeathKind(nt); }
      }
      if (alive && this.poisonTick(i, poisoned)) {
        const ox = st.poisonKind === 'oxide';
        st.death = ox ? 'Отравлен окислом камня' : 'Отравлен реагентом';
        st.deathKind = ox ? 'oxide' : 'reagent';
        st.mineCell = -1;
        this.poisonDeath(i);
        pl.idx = -1;
        return;
      }
      // 2. Вода над головой или завален со всех сторон: задыхается за то же
      //    время, что и человек.
      const above = y > 0 ? type[i - w] : EL.EMPTY;
      if (alive && (above === EL.WATER || above === EL.SOLUTION || this.walledIn(x, y))) {
        st.wet++;
        if (st.wet >= HUMAN_DROWN_FRAMES) {
          this.extra[i] = 1; alive = false;
          const drowned = above === EL.WATER || above === EL.SOLUTION;
          st.death = drowned ? 'Утонул' : 'Задохнулся под завалом';
          st.deathKind = drowned ? 'drown' : 'buried';
        }
      } else if (st.wet > 0) {
        st.wet--;
      }
    }
    // Мёртвый не прыгает и не шагает — только падает.
    if (!alive) { inp.jump = false; st.rise = 0; st.hang = 0; st.jumpBuf = 0; }

    // Текущая клетка меняется по ходу кадра: подъём или падение и шаг вбок
    // могут случиться в одном кадре (прыжок в сторону, шаг с уступа).
    let cur = i, cx = x, cy = y;
    // Шаг вбок или вбок-вверх везёт стоящего на нём (carryRider, см. шапку).
    const go = (ni) => {
      const d = ni - cur, r = cur - w;
      this.playerMove(cur, ni);
      if (d !== w && d !== -w && cy > 0 && ni < cur + w - 1) this.carryRider(r, d);
      cur = ni; cx = ni % w; cy = (ni / w) | 0;
    };
    const free = (k) => this.playerCanEnter(type[k]);
    const grounded = () => cy + 1 >= h || !free(cur + w);
    const liquidBelow = () => cy + 1 < h && IS_LIQUID[type[cur + w]] === 1;
    const liquidAbove = () => cy > 0 && IS_LIQUID[type[cur - w]] === 1;

    // 3. Прыжок — с опоры или с поверхности воды (под ним вода, над ним
    //    воздух). Нажатие ждёт опоры PLAYER_JUMP_BUFFER кадров.
    if (alive) {
      if (inp.jump) { st.jumpBuf = PLAYER_JUMP_BUFFER; inp.jump = false; }
      else if (st.jumpBuf > 0) st.jumpBuf--;
      if (st.jumpBuf > 0 && st.rise === 0 && st.hang === 0
        && (grounded() || (liquidBelow() && cy > 0 && type[cur - w] === EL.EMPTY))) {
        st.jumpBuf = 0; st.rise = PLAYER_JUMP; st.riseT = 0; st.vy = 0; st.fy = 0;
      }
    }

    // Выносливость: тратится, пока плывёт (всплывает или держится на
    // уровне воды), кончилась — плыть нельзя, пока не встанет на сухое.
    // Сухая опора — не дно под водой: над головой тоже не вода.
    // regenNow — сколько восстановилось в этом кадре: пока игрок бьёт,
    // оно отбирается обратно (playerMine).
    st.regenNow = 0;
    if (grounded() && !liquidBelow() && !liquidAbove()) {
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
        // Над головой стоит другой игрок — поднимается вместе с ним.
        if (cy > 0 && (free(cur - w) || this.liftRider(cur - w))) {
          go(cur - w);
          if (--st.rise === 0) st.hang = PLAYER_HANG_FRAMES;
        } else {
          st.rise = 0;   // ударился головой — падает
        }
      }
      st.riseT++;
    } else if (st.hang > 0) {
      st.hang--;
    } else if (canSwim && inp.up && liquidAbove() && this.swimLevelOk(cx, cy - 1)) {
      // Всплывает, пока держат "вверх" (W или пробел), — но не выше уровня
      // воды (см. swimLevelOk).
      if (this.frame % PLAYER_SWIM_FRAMES === 0) go(cur - w);
      st.vy = 0; st.fy = 0; swam = true;
    } else if (canSwim && inp.up && liquidBelow() && this.swimLevelOk(cx, cy)) {
      // На уровне воды: держится на плаву, не тонет. Выпрыгнуть — нажать
      // прыжок ещё раз (см. шаг 3). Сбоку пустота — значит, торчит над
      // водой: не держится, уходит глубже (просьба: "чтобы не ходил по воде").
      st.vy = 0; st.fy = 0; swam = true;
    } else if (alive && inp.down && liquidBelow() && this.frame % PLAYER_SWIM_FRAMES === 0) {
      go(cur + w); st.vy = 0; st.fy = 0;
    } else if (grounded()) {
      st.vy = 0; st.fy = 0;
    } else {
      const max = liquidBelow() ? PLAYER_SINK_MAX : PLAYER_FALL_MAX;
      st.vy = Math.min(max, st.vy + PLAYER_GRAVITY);
      st.fy += st.vy;
      while (st.fy >= 1) {
        st.fy -= 1;
        if (cy + 1 < h && free(cur + w)) go(cur + w);
        else { st.vy = 0; st.fy = 0; break; }
      }
    }

    if (swam && --st.stamina <= 0) st.exhausted = true;

    // Ломание (см. шапку) — с того места, где он теперь; урон заживает.
    if (alive) { this.healTick(cur); this.playerMine(cur, inp, st); }
    else st.mineCell = -1;
    // Статистика игрока за раунд (js/net.js: кнопка "Статистика" в лобби):
    // сколько кадров жив, в воде, отравлен; сломанные пиксели — в playerMine.
    if (alive && pl.stats) {
      pl.stats.alive++;
      if (liquidAbove() || liquidBelow()) pl.stats.water++;
      if (this.type[cur] === EL.PROTAGONIST && this.stain[cur] > 0) pl.stats.tox++;
    }

    // 5. Шаг вбок: прямо, а если там препятствие в одну клетку — на него
    //    (над головой и над препятствием должно быть свободно). Прямой шаг —
    //    и на земле, и в воздухе: с вершины прыжка он шагает на стену в две
    //    клетки. Шаг на уступ — только с опоры: иначе к двум клеткам
    //    прыжка добавлялась бы третья, и прыжок брал стену в три клетки.
    const dir = !alive || inp.left === inp.right ? 0 : (inp.left ? -1 : 1);
    if (dir && this.frame % PLAYER_STEP_FRAMES === 0) {
      const nx = cx + dir;
      if (nx < 0 || nx >= w) return;
      if (free(cur + dir)) go(cur + dir);
      else if (grounded() && cy > 0 && free(cur - w) && free(cur - w + dir)) go(cur - w + dir);
    }
  }
}

extendSim(SimProtagonist);
