'use strict';

// Шароид (EL.SHAROID, вкладка "Технологии"; просьба пользователя, макет —
// его презентация): шагающий робот — круглое стальное тело на трёх ногах.
//
// Из чего состоит:
//  1. Тело — круг 12x12 (SHAR_ROWS, по макету) из клеток EL.SHAROID: это
//     настоящие клетки поля со свойствами стали (плотность, стойкость,
//     кислота, плавление — data/elements.js), их состав — 10 долей стали.
//     Твёрдое, но не структурное: держится не за соседей, а на ногах, и
//     двигает его целиком этот файл (moveSharoid). В life клетки — номер
//     шароида, в extra — часть корпуса для цвета (SHAR_PART_*): обод,
//     тёмное и светлое кольцо, оправа сенсора, сенсор.
//  2. Сенсор — декоративный "глаз" в центре тела, крест 2-4-4-2 в тёмной
//     оправе. Смещается на SHAR_LOOK клеток туда, куда шароид смотрит
//     (последнее направление хода). Цвет — бирюзовый, у шароида игрока —
//     цвет игрока, у шароида-"человека" — цвет человека.
//  3. Три ноги: ступня — перевёрнутая "Т" (перекладина в три клетки и
//     ножка в две над ней), от ножки до точки крепления на теле — ровная
//     прямая. Ноги — не клетки поля, а часть сущности (sim.sharoids):
//     рисуются поверх поля (Renderer.drawSharoids), а ступни стоят на
//     настоящих клетках — опорой служит любое твёрдое и сыпучее.
//
// Ходьба (sharoidWalk): ступня, отставшая от своего места под телом на
// SHAR_STEP_LAG клеток, переставляется вперёд на SHAR_STEP_LEAD клеток
// дальше своего места — по дуге за SHAR_STEP_FRAMES кадров. В воздухе
// всегда не больше одной ноги: шаг начинается, только если остальные две
// стоят (просьба пользователя: "чтобы не было момента, когда у него всего 1
// нога удерживает тело"). Тело идёт на клетку раз в SHAR_MOVE_FRAMES
// кадров, пока каждая стоящая ступня дотягивается до него (SHAR_REACH), —
// не дотягивается, тело ждёт шага. Высота тела — по средней высоте стоящих
// ступней: на ступеньку ступня встаёт выше, и тело поднимается следом.
// Куда ступить нельзя (стена выше SHAR_FOOT_MIN под телом, край поля) или
// во что упирается само тело — шароид останавливается. Обрыв (опоры нет
// ближе SHAR_FOOT_MAX) игрок переходит — шароид шагает вниз и падает;
// шароид-"человек" перед обрывом разворачивается.
//
// Физика: стоящих ступней меньше двух — шароид падает, с разгоном
// (SHAR_GRAVITY), в жидкости медленнее; ноги висят под телом и встают на
// первую опору, которой коснутся. Тело упирается в препятствия: двигается
// только в пустоту, жидкость и газ, вытесняя их назад (moveSharoid: каждая
// клетка тела меняется местами с клеткой перед собой, от передних к
// задним, — жидкость перетекает за тело). Тело легло на опору — лежит.
//
// Прыжок (пробел/W): сначала присед на SHAR_JUMP_CROUCH клеток (тело
// опускается на согнутых ногах), потом толчок вверх (SHAR_JUMP_V), ноги
// поджаты под телом, в воздухе можно сместиться вбок. S — присесть.
//
// Кто управляет (ctrl): SHAR_CTRL_NONE — никто (ИИ у шароида нет, он стоит
// и только подчиняется физике); номер игрока (0 — одиночная игра) — игрок,
// через input своего слота, как протагонист (A/D — идти, W/пробел — прыжок,
// S — присесть); SHAR_CTRL_HUMAN — ведёт себя как человек (бродит, обходит
// опасное и обрывы). Игроком управление получает щелчок протагонистом или
// точкой спавна игрока по шароиду (commandSharoid / setSpawnMark), человеком
// — щелчок человеком. Тело у игрока одно: шароид игрока заменяет его
// протагониста (и наоборот, placePlayer освобождает шароид).
//
// Разрушение: кислота и растворитель меняют состав клетки — она становится
// простой сталью и отпадает; огонь и лава плавят; ломание, взрыв и ластик
// убирают клетки. Осталось меньше SHAR_ALIVE_PART тела — шароид разрушен:
// уцелевшие клетки становятся сталью, ноги пропадают, игрок — погиб.
//
// Состояние — this.sharoids (простые объекты): входит в отмену
// (snapshot), в файл сохранения и в мир мультиплеера (lockstepDump берёт
// все поля Sim). Считается главным потоком перед обходом клеток
// (updateSharoids), так что от потоков не зависит. Клетки шароида без
// хозяина (вставка выделения, старый снимок) становятся сталью
// (sweepSharoidOrphans).
//
// Методы класса Sim, вынесенные в отдельный файл: класс ниже — только
// контейнер, extendSim переносит его методы в Sim.prototype (см. core.js).

// Константы — по одной на строку: стенд (tools/harness.js) отдаёт проверкам
// только первое имя строки.
//
// Тело по макету: строки круга 12x12, [первый, последний] столбец.
const SHAR_W = 12;
const SHAR_H = 12;
const SHAR_ROWS = [[4, 7], [3, 8], [2, 9], [1, 10], [0, 11], [0, 11], [0, 11], [0, 11], [1, 10], [2, 9], [3, 8], [4, 7]];
// Части корпуса (extra клетки) — для цвета (Renderer.cellColor и шейдер):
// обод, тёмное и светлое кольцо (по удалённости от края, как на макете),
// оправа сенсора, сенсор. Сенсор игрока — SHAR_PART_PLAYER + номер игрока
// (цвет игрока, номера до 15, как у протагониста), "человека" — цвет человека.
const SHAR_PART_RIM = 1;
const SHAR_PART_DARK = 2;
const SHAR_PART_LIGHT = 3;
const SHAR_PART_FRAME = 4;
const SHAR_PART_EYE = 5;
const SHAR_PART_EYE_HUMAN = 6;
const SHAR_PART_PLAYER = 16;
// Цвета частей (сенсор игрока — цвет игрока). Обод на макете чёрный, но
// поле тёмное — чёрный обод сливался бы с фоном, поэтому он тёмно-серый.
const SHAR_PART_COLOR = [null, [44, 44, 50], [98, 98, 106], [152, 152, 160], [22, 22, 26], [40, 236, 240], ELEMENTS[EL.HUMAN].color];
// Цвета ног (Renderer.drawSharoids): прямая, ножка ступни, перекладина.
const SHAR_LEG_COLOR = [108, 108, 116];
const SHAR_SHIN_COLOR = [76, 76, 84];
const SHAR_FOOT_COLOR = [56, 56, 62];
// Сенсор: крест 2-4-4-2 в строках 4..7 тела, по центру; смотрит в сторону
// хода — сдвигом на SHAR_LOOK столбцов.
const SHAR_EYE_ROWS = [[4, 5, 6], [5, 4, 7], [6, 4, 7], [7, 5, 6]];
const SHAR_LOOK = 2;

// Кто управляет (s.ctrl): никто, человек; 0 и больше — номер игрока.
const SHAR_CTRL_NONE = -1;
const SHAR_CTRL_HUMAN = -2;

// Ноги: точки крепления (относительно левого верхнего угла тела) и места
// ступней под телом (столбец центра перекладины). Средняя нога — под
// центром, на клетку в сторону взгляда (тело чётной ширины).
const SHAR_ATTACH_X = [2, 0, 9];
const SHAR_ATTACH_Y = [11, 12, 11];
const SHAR_HOME_X = [-5, 0, 16];
// Перекладина ступни стоя — на SHAR_STAND строк ниже верха тела (по
// макету: тело 12, ноги 7, ступня 1). Ближе SHAR_FOOT_MIN ступня не
// поднимается (ниже тела должно оставаться место для ножки), дальше
// SHAR_FOOT_MAX нога не дотягивается — это уже обрыв.
const SHAR_STAND = 19;
const SHAR_FOOT_MIN = 15;
const SHAR_FOOT_MAX = 27;
// Шаг: ступня отстала от своего места на SHAR_STEP_LAG — шагает на
// SHAR_STEP_LEAD вперёд своего места, по дуге высотой SHAR_STEP_LIFT за
// SHAR_STEP_FRAMES кадров. Стоящая ступня дальше SHAR_REACH от своего места
// не отпускает тело. Тело — на клетку раз в SHAR_MOVE_FRAMES кадров.
const SHAR_STEP_LAG = 2;
const SHAR_STEP_LEAD = 3;
const SHAR_STEP_LIFT = 3;
const SHAR_STEP_FRAMES = 5;
const SHAR_REACH = 6;
const SHAR_MOVE_FRAMES = 3;
// Высота тела догоняет ступни на клетку раз в столько кадров.
const SHAR_RISE_FRAMES = 2;
// Падение: разгон за кадр и предел (клеток за кадр); в жидкости — медленно.
const SHAR_GRAVITY = 0.09;
const SHAR_FALL_MAX = 1;
const SHAR_SINK_MAX = 0.3;
// Прыжок: присед на столько клеток (по клетке в кадр), толчок; нажатие ждёт
// опоры SHAR_JUMP_BUFFER кадров. Присед клавишей S — на SHAR_CROUCH.
const SHAR_JUMP_CROUCH = 3;
const SHAR_JUMP_V = 1.5;
const SHAR_JUMP_BUFFER = 8;
const SHAR_CROUCH = 4;
// Меньше этой доли тела — разрушен.
const SHAR_ALIVE_PART = 0.5;
// Шароид-"человек" (SHAR_CTRL_HUMAN): шанс в кадр тронуться с места,
// остановиться и передумать; осмотр опасного впереди — раз в
// SHAR_AI_SCAN_PERIOD кадров на SHAR_AI_SIGHT клеток; упёрся на столько
// кадров — прыгает (с шансом) или разворачивается.
const SHAR_AI_GO_CHANCE = 0.02;
const SHAR_AI_STOP_CHANCE = 0.003;
const SHAR_AI_TURN_CHANCE = 0.003;
const SHAR_AI_SCAN_PERIOD = 8;
const SHAR_AI_SIGHT = 8;
const SHAR_AI_STUCK = 20;
const SHAR_AI_JUMP_CHANCE = 0.4;

// Маска тела и кольца корпуса (по удалённости от края по 4 соседям: 1 —
// обод, 2 — тёмное кольцо, дальше — светлое), индекс dy * SHAR_W + dx.
const SHAR_MASK = new Uint8Array(SHAR_W * SHAR_H);
const SHAR_RING = new Uint8Array(SHAR_W * SHAR_H);
for (let dy = 0; dy < SHAR_H; dy++) for (let dx = SHAR_ROWS[dy][0]; dx <= SHAR_ROWS[dy][1]; dx++) SHAR_MASK[dy * SHAR_W + dx] = 1;
for (let k = 0; k < SHAR_MASK.length; k++) {
  if (!SHAR_MASK[k]) continue;
  const x = k % SHAR_W, y = (k / SHAR_W) | 0;
  let d = 99;
  for (let yy = -1; yy <= SHAR_H; yy++) {
    for (let xx = -1; xx <= SHAR_W; xx++) {
      const inside = xx >= 0 && xx < SHAR_W && yy >= 0 && yy < SHAR_H && SHAR_MASK[yy * SHAR_W + xx];
      if (!inside) d = Math.min(d, Math.abs(xx - x) + Math.abs(yy - y));
    }
  }
  SHAR_RING[k] = d <= 1 ? SHAR_PART_RIM : d === 2 ? SHAR_PART_DARK : SHAR_PART_LIGHT;
}
const SHAR_CELLS = SHAR_MASK.reduce((a, b) => a + b, 0);
// Рабочий список клеток тела (только главный поток, см. шапку).
const SHAR_LIST = new Int32Array(SHAR_W * SHAR_H);

class SimSharoid {
  initSharoids() {
    this.sharoids = [];
    this._sharSeq = 0;
    // Есть ли на поле клетки шароидов без хозяина (см. sweepSharoidOrphans).
    this._sharSweep = false;
  }

  sharoidById(id) {
    for (const s of this.sharoids) if (s.id === id) return s;
    return null;
  }

  // Шароид, которому принадлежит клетка i, или null.
  sharoidAt(i) {
    if (i < 0 || i >= this.type.length || this.type[i] !== EL.SHAROID) return null;
    const s = this.sharoidById(this.life[i]);
    if (!s) return null;
    const x = i % this.w - s.x, y = ((i / this.w) | 0) - s.y;
    return x >= 0 && x < SHAR_W && y >= 0 && y < SHAR_H && SHAR_MASK[y * SHAR_W + x] ? s : null;
  }

  // Проходима ли клетка для тела и ступни: пустота, жидкость, газ, огонь.
  sharPassable(t) { return t === EL.EMPTY || t === EL.FIRE || IS_LIQUID[t] === 1 || IS_GASLIKE[t] === 1; }

  // Опора ступни: всё, что не проходимо (твёрдое, сыпучее, живые), и низ поля.
  sharSupportAt(x, y) {
    if (y >= this.h) return true;
    if (x < 0 || x >= this.w || y < 0) return false;
    return !this.sharPassable(this.type[y * this.w + x]);
  }

  sharFreeAt(x, y) {
    if (x < 0 || x >= this.w || y >= this.h) return false;
    if (y < 0) return true;
    return this.sharPassable(this.type[y * this.w + x]);
  }

  // Поставить шароида телом с центром в (cx, cy). Тело встаёт только в
  // пустоту, жидкость и газ — иначе не ставится (false). Ноги — под телом,
  // где опора; нет опоры — висят, и он падает.
  placeSharoid(cx, cy) {
    const x0 = cx - (SHAR_W >> 1) + 1, y0 = cy - (SHAR_H >> 1) + 1;
    const w = this.w;
    if (x0 < 0 || y0 < 0 || x0 + SHAR_W > w || y0 + SHAR_H > this.h) return false;
    for (let k = 0; k < SHAR_MASK.length; k++) {
      if (!SHAR_MASK[k]) continue;
      if (!this.sharPassable(this.type[(y0 + ((k / SHAR_W) | 0)) * w + x0 + k % SHAR_W])) return false;
    }
    // Номер — следующий свободный (life клетки — Int16).
    let id = this._sharSeq;
    do { id = id % 30000 + 1; } while (this.sharoidById(id));
    this._sharSeq = id;
    const s = {
      id, x: x0, y: y0, face: 0, ctrl: SHAR_CTRL_NONE, cells: SHAR_CELLS,
      legs: [0, 1, 2].map(() => ({ x: 0, y: 0, on: false })),
      // Шаг: какая нога в воздухе (-1 — никакая), сколько кадров идёт,
      // откуда и куда.
      sw: -1, swT: 0, swX0: 0, swY0: 0, swX1: 0, swY1: 0,
      vy: 0, fy: 0, moveT: 0, riseT: 0, crouch: 0, jumpT: 0, jumpBuf: 0,
      // Шароид-"человек": куда идёт (0 — стоит), сколько кадров упирается.
      walk: 0, stuck: 0, painted: -1,
    };
    for (let k = 0; k < SHAR_MASK.length; k++) {
      if (!SHAR_MASK[k]) continue;
      const i = (y0 + ((k / SHAR_W) | 0)) * w + x0 + k % SHAR_W;
      this.spawn(i, EL.SHAROID);
      this.life[i] = id;
      this.shade[i] = 0;
    }
    this.sharoids.push(s);
    for (let k = 0; k < 3; k++) this.sharHang(s, k);
    this.sharPlantHanging(s);
    this.paintSharoid(s);
    return true;
  }

  // Место ступни ноги k под телом (столбец центра перекладины).
  sharHomeX(s, k) { return s.x + (k === 1 ? (s.face < 0 ? 5 : 6) : SHAR_HOME_X[k]); }

  // Повесить ногу k под телом (в воздухе, перекладина — на высоте стойки).
  sharHang(s, k) {
    const leg = s.legs[k];
    leg.x = this.sharHomeX(s, k);
    leg.y = s.y + SHAR_STAND;
    leg.on = false;
  }

  // Строка перекладины ступни в столбце tx под телом с верхом by: первая
  // строка от SHAR_FOOT_MIN до maxRel, где перекладина и ножка в
  // проходимом, а под перекладиной опора. -1 — опоры нет (обрыв или ещё
  // не долетел), -2 — шагнуть нельзя (стена выше SHAR_FOOT_MIN, край поля).
  sharFootGround(tx, by, maxRel = SHAR_FOOT_MAX) {
    if (tx - 1 < 0 || tx + 1 >= this.w) return -2;
    for (let r = by + SHAR_FOOT_MIN; r <= by + maxRel; r++) {
      if (r >= this.h) return -1;
      const free = this.sharFreeAt(tx - 1, r) && this.sharFreeAt(tx, r) && this.sharFreeAt(tx + 1, r) && this.sharFreeAt(tx, r - 1);
      if (!free) return r === by + SHAR_FOOT_MIN ? -2 : -1;
      if (this.sharSupportAt(tx - 1, r + 1) || this.sharSupportAt(tx, r + 1) || this.sharSupportAt(tx + 1, r + 1)) return r;
    }
    return -1;
  }

  // Нога k со ступнёй в (tx, r) не проходит сквозь твёрдое: прямая от
  // точки крепления до ножки — по проходимому (или по своему телу). Без
  // этого ступня перешагивала стену и вставала за ней.
  sharLegClear(s, k, tx, r) {
    let x = s.x + (k === 1 ? (s.face < 0 ? 5 : 6) : SHAR_ATTACH_X[k]), y = s.y + SHAR_ATTACH_Y[k];
    const ty = r - 2, w = this.w;
    const dx = Math.abs(tx - x), dy = -Math.abs(ty - y), sx = x < tx ? 1 : -1, sy = y < ty ? 1 : -1;
    let err = dx + dy;
    for (let g = 0; g < 256; g++) {
      if (x < 0 || x >= w || y >= this.h) return false;
      if (y >= 0) {
        const i = y * w + x, t = this.type[i];
        if (!this.sharPassable(t) && !(t === EL.SHAROID && this.life[i] === s.id)) return false;
      }
      if (x === tx && y === ty) return true;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
    }
    return false;
  }

  // Стоит ли ступня: под перекладиной есть опора.
  sharFootHeld(leg) {
    const x = Math.round(leg.x), y = Math.round(leg.y) + 1;
    return this.sharSupportAt(x - 1, y) || this.sharSupportAt(x, y) || this.sharSupportAt(x + 1, y);
  }

  // Висящие ноги встают на опору, которой коснулись (не ниже стойки).
  sharPlantHanging(s) {
    for (let k = 0; k < 3; k++) {
      const leg = s.legs[k];
      if (leg.on || s.sw === k) continue;
      leg.x = this.sharHomeX(s, k);
      const r = this.sharFootGround(leg.x, s.y, SHAR_STAND);
      if (r >= 0 && this.sharLegClear(s, k, leg.x, r)) { leg.y = r; leg.on = true; } else leg.y = s.y + SHAR_STAND;
    }
  }

  sharPlanted(s) {
    let n = 0;
    for (let k = 0; k < 3; k++) if (s.legs[k].on && s.sw !== k) n++;
    return n;
  }

  // Клетки тела шароида s в SHAR_LIST; возвращает их число.
  sharCollect(s) {
    const w = this.w, h = this.h, type = this.type, life = this.life;
    let n = 0;
    for (let k = 0; k < SHAR_MASK.length; k++) {
      if (!SHAR_MASK[k]) continue;
      const x = s.x + k % SHAR_W, y = s.y + ((k / SHAR_W) | 0);
      if (x < 0 || x >= w || y < 0 || y >= h) continue;
      const i = y * w + x;
      if (type[i] === EL.SHAROID && life[i] === s.id) SHAR_LIST[n++] = i;
    }
    return n;
  }

  // Сдвинуть тело на клетку (dx, dy) — одно из них 0. Каждая клетка тела
  // меняется местами с клеткой перед собой, от передних к задним: жидкость
  // и газ перед телом оказываются позади него. Перед телом что-то твёрдое,
  // сыпучее или край поля — не двигается (false).
  moveSharoid(s, dx, dy) {
    const w = this.w, h = this.h, type = this.type, life = this.life, id = s.id;
    const n = this.sharCollect(s);
    if (n === 0) return false;
    const d = dy * w + dx;
    for (let k = 0; k < n; k++) {
      const i = SHAR_LIST[k], x = i % w + dx, y = ((i / w) | 0) + dy;
      if (x < 0 || x >= w || y < 0 || y >= h) return false;
      const j = i + d;
      if (type[j] === EL.SHAROID && life[j] === id) continue;
      if (!this.sharPassable(type[j])) return false;
    }
    // SHAR_LIST — по строкам сверху вниз и слева направо: передние клетки
    // в начале списка при ходе вверх и влево, в конце — вниз и вправо.
    if (dy > 0 || dx > 0) for (let k = n - 1; k >= 0; k--) this.swapFields(SHAR_LIST[k], SHAR_LIST[k] + d);
    else for (let k = 0; k < n; k++) this.swapFields(SHAR_LIST[k], SHAR_LIST[k] + d);
    s.x += dx; s.y += dy;
    return true;
  }

  // Раскрасить корпус (extra клеток) — сенсор смотрит в сторону взгляда и
  // светится цветом того, кто управляет. Только при смене.
  paintSharoid(s) {
    const look = s.face * SHAR_LOOK;
    const eye = s.ctrl >= 0 && s.ctrl < 16 ? SHAR_PART_PLAYER + s.ctrl : s.ctrl === SHAR_CTRL_HUMAN ? SHAR_PART_EYE_HUMAN : SHAR_PART_EYE;
    const key = (look + 8) * 64 + eye;
    if (s.painted === key) return;
    s.painted = key;
    const w = this.w, h = this.h;
    const set = (dx, dy, part) => {
      const x = s.x + dx, y = s.y + dy;
      if (x < 0 || x >= w || y < 0 || y >= h || dx < 0 || dx >= SHAR_W || !SHAR_MASK[dy * SHAR_W + dx]) return;
      const i = y * w + x;
      if (this.type[i] !== EL.SHAROID || this.life[i] !== s.id) return;
      if (this.extra[i] !== part) { this.extra[i] = part; this.markDirty(i); }
    };
    for (let k = 0; k < SHAR_MASK.length; k++) if (SHAR_MASK[k]) set(k % SHAR_W, (k / SHAR_W) | 0, SHAR_RING[k]);
    // Оправа — соседи креста (по 4 сторонам), потом сам крест поверх.
    for (const [dy, a, b] of SHAR_EYE_ROWS) {
      for (let dx = a; dx <= b; dx++) {
        set(dx + look - 1, dy, SHAR_PART_FRAME); set(dx + look + 1, dy, SHAR_PART_FRAME);
        set(dx + look, dy - 1, SHAR_PART_FRAME); set(dx + look, dy + 1, SHAR_PART_FRAME);
      }
    }
    for (const [dy, a, b] of SHAR_EYE_ROWS) for (let dx = a; dx <= b; dx++) set(dx + look, dy, eye);
  }

  // Раз в кадр перед обходом клеток (главным потоком, см. шапку).
  updateSharoids() {
    if (this._sharSweep) this.sweepSharoidOrphans();
    if (this.sharoids.length === 0) return;
    let gone = false;
    for (const s of this.sharoids) {
      const n = this.sharCollect(s);
      if (n < s.cells * SHAR_ALIVE_PART) { this.destroySharoid(s); gone = true; continue; }
      this.updateSharoid(s);
    }
    if (gone) this.sharoids = this.sharoids.filter((s) => !s.dead);
  }

  // Шароид разрушен: уцелевшие клетки — простая сталь (состав у них и так
  // стальной), ноги пропадают, игрок за ним — погиб.
  destroySharoid(s) {
    const n = this.sharCollect(s);
    for (let k = 0; k < n; k++) {
      const i = SHAR_LIST[k];
      this.type[i] = EL.STEEL; this.life[i] = 0; this.extra[i] = 0;
      this.markDirty(i);
    }
    s.dead = true;
    if (s.ctrl >= 0) {
      const st = this.playerSlot(s.ctrl).state;
      st.death = 'Шароид разрушен';
      st.deathKind = 'other';
    }
  }

  // Клетки шароидов без хозяина (или не на своём месте в его теле) —
  // простая сталь. Бывают после вставки выделения, отмены и загрузки:
  // клетки копируются, а сущность — нет.
  sweepSharoidOrphans() {
    this._sharSweep = false;
    const type = this.type;
    for (let i = 0; i < type.length; i++) {
      if (type[i] !== EL.SHAROID || this.sharoidAt(i)) continue;
      type[i] = EL.STEEL; this.life[i] = 0; this.extra[i] = 0;
      this.markDirty(i);
    }
  }

  // Что хочет тот, кто управляет: { dir, jump, crouch }.
  sharoidIntent(s) {
    if (s.ctrl >= 0) {
      const inp = this.playerSlot(s.ctrl).input;
      const dir = inp.left === inp.right ? 0 : (inp.left ? -1 : 1);
      const jump = inp.jump;
      inp.jump = false;
      return { dir, jump, crouch: !!inp.down };
    }
    if (s.ctrl === SHAR_CTRL_HUMAN) return this.sharoidHumanIntent(s);
    return { dir: 0, jump: false, crouch: false };
  }

  // Шароид-"человек" (просьба: "будет вести себя как человек"): бродит
  // туда-сюда, останавливается, передумывает; опасное впереди (то, чего
  // боится человек, humanDanger) и обрыв — разворачивается; упёрся —
  // пробует перепрыгнуть, не вышло — назад.
  sharoidHumanIntent(s) {
    if (s.walk === 0) {
      if (Math.random() < SHAR_AI_GO_CHANCE) s.walk = Math.random() < 0.5 ? -1 : 1;
      return { dir: 0, jump: false, crouch: false };
    }
    if (Math.random() < SHAR_AI_STOP_CHANCE) { s.walk = 0; s.stuck = 0; return { dir: 0, jump: false, crouch: false }; }
    if (Math.random() < SHAR_AI_TURN_CHANCE) s.walk = -s.walk;
    let jump = false;
    if (this.frame % SHAR_AI_SCAN_PERIOD === s.id % SHAR_AI_SCAN_PERIOD && this.sharDangerAhead(s, s.walk)) { s.walk = -s.walk; s.stuck = 0; }
    else if (this.sharPlanted(s) >= 2) {
      // Обрыв: под передней ступней на её следующем месте нет опоры.
      const front = s.walk > 0 ? 2 : 0;
      const g = this.sharFootGround(this.sharHomeX(s, front) + s.walk * (SHAR_STEP_LEAD + 1), s.y);
      if (g === -1) { s.walk = -s.walk; s.stuck = 0; }
    }
    if (s.stuck >= SHAR_AI_STUCK) {
      s.stuck = 0;
      if (Math.random() < SHAR_AI_JUMP_CHANCE) jump = true; else s.walk = -s.walk;
    }
    return { dir: s.walk, jump, crouch: false };
  }

  // Есть ли впереди (по ходу dir, SHAR_AI_SIGHT столбцов от края тела, по
  // всей высоте шароида) то, чего боится человек.
  sharDangerAhead(s, dir) {
    const w = this.w, h = this.h;
    const x0 = dir > 0 ? s.x + SHAR_W : s.x - 1;
    for (let c = 0; c < SHAR_AI_SIGHT; c++) {
      const x = x0 + dir * c;
      if (x < 0 || x >= w) break;
      for (let y = Math.max(0, s.y); y <= Math.min(h - 1, s.y + SHAR_FOOT_MAX + 1); y++) {
        if (this.humanDanger(this.type[y * w + x])) return true;
      }
    }
    return false;
  }

  updateSharoid(s) {
    const want = this.sharoidIntent(s);
    const dir = want.dir;
    if (dir) s.face = dir;
    if (want.jump) s.jumpBuf = SHAR_JUMP_BUFFER; else if (s.jumpBuf > 0) s.jumpBuf--;
    // Ступни, из-под которых ушла опора, повисают.
    for (let k = 0; k < 3; k++) {
      const leg = s.legs[k];
      if (leg.on && s.sw !== k && !this.sharFootHeld(leg)) leg.on = false;
    }
    if (s.vy < 0 || this.sharPlanted(s) < 2) this.sharoidAir(s, dir);
    else this.sharoidWalk(s, dir, want.crouch);
    this.paintSharoid(s);
  }

  // В воздухе: подъём прыжка или падение, ноги висят под телом и встают на
  // опору, которой коснутся (только на спуске). Вбок — как в прыжке.
  sharoidAir(s, dir) {
    s.sw = -1; s.crouch = 0; s.jumpT = 0;
    const below = s.y + SHAR_H < this.h ? this.type[(s.y + SHAR_H) * this.w + s.x + (SHAR_W >> 1)] : EL.EMPTY;
    const max = IS_LIQUID[below] === 1 ? SHAR_SINK_MAX : SHAR_FALL_MAX;
    s.vy = Math.min(max, s.vy + SHAR_GRAVITY);
    s.fy += s.vy;
    while (s.fy <= -1) {
      s.fy += 1;
      if (!this.moveSharoid(s, 0, -1)) { s.vy = 0; s.fy = 0; break; }   // ударился о потолок
    }
    while (s.fy >= 1) {
      s.fy -= 1;
      if (!this.moveSharoid(s, 0, 1)) { s.vy = 0; s.fy = 0; break; }    // лёг на опору
      if (s.vy >= 0) { this.sharPlantHanging(s); if (this.sharPlanted(s) >= 2) break; }
    }
    if (dir && ++s.moveT >= SHAR_MOVE_FRAMES) { s.moveT = 0; this.moveSharoid(s, dir, 0); }
    for (let k = 0; k < 3; k++) if (!s.legs[k].on) this.sharHang(s, k);
    if (s.vy >= 0) this.sharPlantHanging(s);
    if (this.sharPlanted(s) >= 2) { s.vy = 0; s.fy = 0; }
  }

  // На ногах: прыжок (присед, толчок), шаги, ход тела и его высота.
  sharoidWalk(s, dir, crouch) {
    s.vy = 0; s.fy = 0;
    // Прыжок: присед на SHAR_JUMP_CROUCH, потом толчок (см. шапку).
    if (s.jumpT === 0 && s.jumpBuf > 0) { s.jumpBuf = 0; s.jumpT = SHAR_JUMP_CROUCH + 1; }
    if (s.jumpT > 0) {
      if (--s.jumpT === 0) {
        s.sw = -1; s.crouch = 0;
        for (let k = 0; k < 3; k++) s.legs[k].on = false;
        s.vy = -SHAR_JUMP_V;
        s.fy = 0;
        this.sharoidAir(s, dir);
        return;
      }
      s.crouch = Math.min(SHAR_JUMP_CROUCH, s.crouch + 1);
    } else {
      s.crouch = crouch ? SHAR_CROUCH : 0;
    }
    this.sharSwing(s);
    if (s.sw < 0 && s.jumpT === 0) this.sharStartStep(s, dir);
    // Ход тела: каждая стоящая ступня должна дотягиваться до нового места.
    let blocked = false;
    if (dir && s.jumpT === 0 && ++s.moveT >= SHAR_MOVE_FRAMES) {
      s.moveT = 0;
      let reach = true;
      for (let k = 0; k < 3; k++) {
        const leg = s.legs[k];
        if (leg.on && s.sw !== k && Math.abs(leg.x - (this.sharHomeX(s, k) + dir)) > SHAR_REACH) reach = false;
      }
      // Обрыв игрок переходит: передней ступне некуда встать — тело идёт
      // дальше, отставшие ступни отрываются, и он падает (см. шапку).
      const front = dir > 0 ? 2 : 0;
      if (!reach && s.ctrl >= 0 && s.sw < 0 && this.sharFootGround(this.sharHomeX(s, front) + dir * SHAR_STEP_LEAD, s.y) === -1) reach = true;
      if (reach) {
        if (this.moveSharoid(s, dir, 0)) {
          for (let k = 0; k < 3; k++) {
            const leg = s.legs[k];
            if (leg.on && s.sw !== k && Math.abs(leg.x - this.sharHomeX(s, k)) > SHAR_REACH) leg.on = false;
          }
        } else blocked = true;
      } else if (s.sw < 0) blocked = true;
    }
    s.stuck = blocked ? s.stuck + 1 : 0;
    // Высота тела — по средней высоте стоящих ступней (и приседу).
    if (++s.riseT >= (s.jumpT > 0 ? 1 : SHAR_RISE_FRAMES)) {
      s.riseT = 0;
      let sum = 0, m = 0, low = Infinity;
      for (let k = 0; k < 3; k++) {
        const leg = s.legs[k];
        if (!leg.on || s.sw === k) continue;
        sum += leg.y; m++; low = Math.min(low, leg.y);
      }
      if (m > 0) {
        // Ниже, чем позволяет самая высокая ступня (ножке нужно место), — нельзя.
        const target = Math.min(Math.round(sum / m) - SHAR_STAND + s.crouch, low - SHAR_FOOT_MIN);
        if (target > s.y) this.moveSharoid(s, 0, 1);
        else if (target < s.y) this.moveSharoid(s, 0, -1);
      }
    }
    for (let k = 0; k < 3; k++) {
      const leg = s.legs[k];
      if (!leg.on && s.sw !== k) this.sharHang(s, k);
    }
  }

  // Нога в шаге: по дуге от (swX0, swY0) к (swX1, swY1), в конце встаёт.
  sharSwing(s) {
    if (s.sw < 0) return;
    const leg = s.legs[s.sw];
    const t = ++s.swT / SHAR_STEP_FRAMES;
    if (t >= 1) {
      leg.x = s.swX1;
      // Пока шагала, опора могла измениться — ищет заново в том же столбце.
      const r = this.sharFootGround(s.swX1, s.y);
      if (r >= 0 && this.sharLegClear(s, s.sw, s.swX1, r)) { leg.y = r; leg.on = true; } else { leg.on = false; this.sharHang(s, s.sw); }
      s.sw = -1;
      return;
    }
    leg.x = s.swX0 + (s.swX1 - s.swX0) * t;
    leg.y = s.swY0 + (s.swY1 - s.swY0) * t - SHAR_STEP_LIFT * Math.sin(Math.PI * t);
  }

  // Начать шаг: висящая нога — встать под тело; иначе (все три стоят)
  // самая отставшая по ходу, если отстала на SHAR_STEP_LAG; стоит на месте
  // — подтянуть сбившуюся к своему месту. Шагать некуда — нога ждёт.
  sharStartStep(s, dir) {
    let best = -1, bestLag = 0;
    for (let k = 0; k < 3 && best < 0; k++) if (!s.legs[k].on) best = k;
    if (best < 0) {
      if (this.sharPlanted(s) < 3) return;
      for (let k = 0; k < 3; k++) {
        const leg = s.legs[k], off = this.sharHomeX(s, k) - leg.x;
        const lag = dir ? off * dir : Math.abs(off);
        // Равные — задняя нога первой (у правого хода задняя — левая).
        if (lag >= (dir ? SHAR_STEP_LAG : 2) && (lag > bestLag || (lag === bestLag && dir < 0))) { best = k; bestLag = lag; }
      }
      if (best < 0) return;
    }
    // Куда ступить: как можно дальше вперёд, но на опору и не сквозь стену.
    const lead = dir * SHAR_STEP_LEAD, home = this.sharHomeX(s, best), leg = s.legs[best];
    for (let a = lead; dir ? a * dir >= -SHAR_STEP_LAG : a === 0; a -= dir || 1) {
      const tx = home + a;
      if (tx === leg.x && leg.on) break;
      const r = this.sharFootGround(tx, s.y);
      if (r < 0 || !this.sharLegClear(s, best, tx, r)) continue;
      s.sw = best; s.swT = 0;
      s.swX0 = leg.x; s.swY0 = leg.y; s.swX1 = tx; s.swY1 = r;
      leg.on = false;
      return;
    }
  }

  // Щелчок протагонистом (игрок, номер n) или человеком по шароиду: кто
  // им теперь управляет (см. шапку). false — в клетке i не шароид.
  commandSharoid(i, elementId, n = 0) {
    const s = this.sharoidAt(i);
    if (!s) return false;
    if (elementId === EL.HUMAN) { s.ctrl = SHAR_CTRL_HUMAN; s.walk = 0; s.stuck = 0; return true; }
    this.bindSharoidPlayer(s, n);
    return true;
  }

  // Шароид s — тело игрока n: прежнее тело игрока (протагонист, другой
  // шароид) убирается, состояние игрока — как у только что появившегося.
  bindSharoidPlayer(s, n) {
    for (const o of this.sharoids) if (o !== s && o.ctrl === n) o.ctrl = SHAR_CTRL_NONE;
    const old = this.findProtagonist(n);
    if (old >= 0) this.clearCell(old);
    const pl = this.playerSlot(n);
    if (s.ctrl !== n) pl.serial++;
    s.ctrl = n;
    this.resetPlayerState(pl.state);
    pl.bornAt = this.frame;
    pl.input.mine = false;
    if (n === 0) this.playerSerial++;
  }

  // Игрок n получил другое тело (placePlayer) — его шароид свободен.
  releaseSharoids(n) {
    for (const s of this.sharoids) if (s.ctrl === n) s.ctrl = SHAR_CTRL_NONE;
  }

  // Шароид игрока n или null.
  playerSharoid(n) {
    for (const s of this.sharoids) if (s.ctrl === n) return s;
    return null;
  }

  // Клетка тела игрока n: центр сенсора его шароида, иначе протагонист, -1 —
  // нет на поле. Экран игры (js/play.js) и мультиплеер (js/net.js) смотрят
  // отсюда, а не в findProtagonist: тело игрока может быть шароидом.
  playerCell(n = 0) {
    const s = this.playerSharoid(n);
    if (s) {
      const x = Math.min(this.w - 1, Math.max(0, s.x + 5 + (s.face > 0 ? 1 : 0) + s.face * SHAR_LOOK));
      const y = Math.min(this.h - 1, Math.max(0, s.y + 5));
      return y * this.w + x;
    }
    return this.findProtagonist(n);
  }

  // Мёртв ли игрок, чьё тело в клетке p (playerCell): шароид жив, пока он
  // есть; протагонист — по extra.
  playerDeadAt(p) {
    if (p < 0) return true;
    if (this.type[p] === EL.SHAROID) return false;
    return this.type[p] === EL.PROTAGONIST && this.extra[p] === 1;
  }

  // Снимок шароидов для отмены и файла (простые объекты, глубокая копия).
  sharoidsDump() { return JSON.parse(JSON.stringify(this.sharoids)); }

  sharoidsLoad(list) {
    this.sharoids = Array.isArray(list) ? JSON.parse(JSON.stringify(list)) : [];
    for (const s of this.sharoids) if (s.id > this._sharSeq) this._sharSeq = s.id;
    this._sharSweep = true;
  }
}

extendSim(SimSharoid);
