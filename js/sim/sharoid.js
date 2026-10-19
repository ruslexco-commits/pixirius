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
//     оправе с бликом (SHAR_GLOSS). Смещается до SHAR_LOOK клеток туда, куда
//     шароид смотрит: по ходу, а у игрока в игре — на курсор (input.aim,
//     клетка ax/ay; просьба пользователя). Цвет — бирюзовый, у шароида игрока
//     — цвет игрока, у шароида-"человека" — цвет человека.
//  3. Три ноги: ступня — "Т" (перекладина в три клетки и ножка в две), от
//     ножки до точки крепления на теле — ровная прямая не длиннее
//     SHAR_LEG_MAX. Ноги — не клетки поля, а часть сущности (sim.sharoids):
//     рисуются поверх поля (Renderer.drawSharoids), а ступни стоят на
//     настоящих клетках. Опора — любое твёрдое и сыпучее: пол (перекладина
//     лёжа, leg.n = SHAR_ON_FLOOR) или стена слева или справа (перекладина
//     стоймя к стене, SHAR_ON_LEFT / SHAR_ON_RIGHT; просьба пользователя:
//     "опираться и на горизонтальные, и на вертикальные опоры").
//
// Опора тела (sharHeld): стоят хотя бы две ступни, и среди них есть ступня на
// полу или ступни на стенах с обеих сторон — так он держится враспор в шахте
// и ходит в ней вверх и вниз (W/S). На одной стене не держится: ступня,
// которую тело оттянуло дальше длины ноги, отрывается.
//
// Ходьба (sharoidWalk): ступня, отставшая от своего места на SHAR_STEP_LAG
// клеток по ходу, переставляется на SHAR_STEP_LEAD клеток вперёд — по дуге
// за SHAR_STEP_FRAMES кадров. Куда именно: ближайшая к желаемой точке опора
// (sharFindHold) — на ровном полу прямо под ней, на склоне и ступеньке —
// выше или ниже, у стены — на стене. Раньше ступня искала пол только строго
// вниз по своему столбцу и на склоне упиралась в его подножие (жалоба
// пользователя: "не может взбираться на уклоны"). В воздухе всегда не больше
// одной ноги: шаг начинается, только если две оставшиеся держат тело
// (просьба пользователя). Тело идёт на клетку раз в SHAR_MOVE_FRAMES кадров,
// пока каждая стоящая нога до него дотягивается, — нет, ждёт шага. Упёрлось
// в склон — пробует шагнуть вверх-вбок. Высота тела — по средней высоте
// ступней на полу. Куда ступить нельзя или во что упирается тело — стоит.
// Обрыв игрок переходит — шагает вниз и падает; "человек" разворачивается.
//
// Физика: тело не держится — падает с разгоном (SHAR_GRAVITY), в жидкости
// медленнее, в воздухе можно сместиться вбок (s.vx); на тросе (sim/rope.js)
// раскачивается. Висящие ноги идут к своему месту под телом, а не
// перескакивают (SHAR_LEG_FOLLOW), сквозь твёрдое не проходят и встают на
// опору, которой коснулись (sharGrabHolds). Тело двигается только в пустоту,
// жидкость и газ, вытесняя их назад (moveSharoid).
//
// Прыжок (пробел/W, на полу): сначала присед на SHAR_JUMP_CROUCH клеток,
// потом толчок вверх (SHAR_JUMP_V). S — присесть.
//
// Кто управляет (ctrl): SHAR_CTRL_NONE — никто (ИИ у шароида нет, он стоит
// и только подчиняется физике); номер игрока (0 — одиночная игра) — игрок,
// через input своего слота, как протагонист; SHAR_CTRL_HUMAN — ведёт себя
// как человек (бродит, обходит опасное и обрывы). Игроком управление
// получает щелчок протагонистом или точкой спавна игрока по шароиду
// (commandSharoid / setSpawnMark), человеком — щелчок человеком. Тело у
// игрока одно: шароид игрока заменяет его протагониста (и наоборот,
// placePlayer освобождает шароид).
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
// оправа сенсора, сенсор. Клетка сенсора — SHAR_PART_EYE + цвет *
// SHAR_GLOSS_N + блик: цвет — SHAR_EYE_CYAN (ничей), SHAR_EYE_HUMAN
// ("человек") или SHAR_EYE_PLAYER + номер игрока (цвет игрока, номера до 15,
// как у протагониста); блик — SHAR_GLOSS (ниже).
const SHAR_PART_RIM = 1;
const SHAR_PART_DARK = 2;
const SHAR_PART_LIGHT = 3;
const SHAR_PART_FRAME = 4;
const SHAR_PART_EYE = 32;
const SHAR_EYE_CYAN = 0;
const SHAR_EYE_HUMAN = 1;
const SHAR_EYE_PLAYER = 2;
// Цвета частей корпуса. Обод на макете чёрный, но поле тёмное — чёрный обод
// сливался бы с фоном, поэтому он тёмно-серый.
const SHAR_PART_COLOR = [null, [44, 44, 50], [98, 98, 106], [152, 152, 160], [22, 22, 26]];
// Цвет сенсора: ничей — бирюзовый, "человека" — цвет человека.
const SHAR_EYE_COLOR = [[40, 236, 240], ELEMENTS[EL.HUMAN].color];
// Блик сенсора (просьба пользователя: "добавь на сенсор немного красок" по
// его картинке 12x12 — затемнение и засветление частей сенсора). Картинка
// разобрана, а не наложена: она — стеклянный шарик со светом справа сверху
// (направление SHAR_GLOSS_LIGHT). Край креста темнеет — с теневой стороны
// сильнее; середина креста со стороны света — блик, ярче всего у центра.
// Так блик едет вместе с сенсором и не зависит от его цвета. Уровни —
// [к какому цвету, доля из 255], прозрачность — как в картинке.
const SHAR_GLOSS = [[0, 49], [0, 26], [0, 0], [255, 49], [255, 106]];
const SHAR_GLOSS_N = 5;
const SHAR_GLOSS_LIGHT = [2, -1];
// Цвета ног (Renderer.drawSharoids): прямая, ножка ступни, перекладина.
const SHAR_LEG_COLOR = [108, 108, 116];
const SHAR_SHIN_COLOR = [76, 76, 84];
const SHAR_FOOT_COLOR = [56, 56, 62];
// Сенсор: крест 2-4-4-2 в строках 4..7 тела, по центру; смотрит в сторону
// хода или на курсор — сдвигом до SHAR_LOOK клеток по каждой оси.
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
// На что опирается ступня (leg.n): пол под перекладиной, стена слева от неё,
// стена справа.
const SHAR_ON_FLOOR = 0;
const SHAR_ON_LEFT = 1;
const SHAR_ON_RIGHT = 2;
// Перекладина ступни стоя — на SHAR_STAND строк ниже верха тела (по
// макету: тело 12, ноги 7, ступня 1). Под телом ступня не выше SHAR_FOOT_MIN
// (ножке нужно место). В шахте боковые ступни — на SHAR_WALL_HOLD строк ниже
// верха тела.
const SHAR_STAND = 19;
const SHAR_FOOT_MIN = 15;
const SHAR_WALL_HOLD = 13;
// Самая длинная нога — прямая от крепления до верха ножки. Раньше длины не
// было вовсе: оставшаяся на земле нога тянулась за прыгнувшим шароидом
// "неправдоподобно длинным тросом" (жалоба пользователя). Стоящую ногу тело
// дальше не оттянет (ждёт шага), а оттянутую силой — отпускает.
const SHAR_LEG_MAX = 17;
// Поиск опоры для шага (sharFindHold): по столбцам на SHAR_SEEK_X от
// желаемого места, по строкам — на SHAR_SEEK_UP выше и SHAR_SEEK_DOWN ниже
// (на склоне передняя ступня встаёт заметно выше). Опора на стене при
// ходьбе по полу дороже на SHAR_WALL_COST — по полу нога идёт, пока он есть.
// В шахте ищется шире (SHAR_SEEK_SHAFT по строкам, SHAR_SEEK_SHAFT_X по
// столбцам: средней ноге до стены от середины тела далеко) и стены не дороже
// пола.
const SHAR_SEEK_X = 3;
const SHAR_SEEK_UP = 16;
const SHAR_SEEK_DOWN = 8;
const SHAR_SEEK_SHAFT = 9;
const SHAR_SEEK_SHAFT_X = 14;
const SHAR_WALL_COST = 40;
// Касание опоры висящей ногой — в пределах SHAR_GRAB клеток по строкам и
// SHAR_GRAB_X по столбцам: место висящей ступни бывает внутри стены шахты, а
// её грань — в нескольких клетках сбоку.
const SHAR_GRAB = 2;
const SHAR_GRAB_X = 4;
// Шаг: ступня отстала от своего места на SHAR_STEP_LAG — шагает на
// SHAR_STEP_LEAD вперёд своего места, по дуге высотой SHAR_STEP_LIFT за
// SHAR_STEP_FRAMES кадров. Стоящая ступня на полу дальше SHAR_REACH от своего
// места не отпускает тело. Тело — на клетку раз в SHAR_MOVE_FRAMES кадров.
// Шаг был за 5 кадров на 5 клеток — ноги дёргались (просьба пользователя:
// "замедли ноги раза в 2, а не самого роботика"): теперь он вдвое дольше и
// вдвое шире, и тело идёт с прежней скоростью — три шага по 10 кадров на 10
// клеток хода.
const SHAR_STEP_LAG = 3;
const SHAR_STEP_LEAD = 6;
const SHAR_STEP_LIFT = 3;
const SHAR_STEP_FRAMES = 10;
const SHAR_REACH = 7;
const SHAR_MOVE_FRAMES = 3;
// Висящая нога (в прыжке, в падении, без опоры) не прыгает на своё место, а
// идёт к нему — каждый кадр на эту долю оставшегося пути (просьба
// пользователя: в прыжке ноги сразу оказывались на месте — как "Т-поза"), и
// сквозь твёрдое не проходит: раньше она проваливалась в препятствие и
// шароид застревал. Падая, ноги поджимаются к телу, поднимаясь в прыжке —
// вытягиваются вниз: на полной скорости — на SHAR_LEG_TUCK клеток от стойки.
const SHAR_LEG_FOLLOW = 0.2;
const SHAR_LEG_TUCK = 3;
// Приземление с разгона: ядро по инерции приседает — на клетку за каждые
// 1 / SHAR_LAND_DIP_PER_V скорости падения, не больше SHAR_LAND_DIP_MAX, —
// и выпрямляется, клетка за SHAR_LAND_RECOVER кадров (просьба пользователя).
// Медленнее SHAR_LAND_DIP_MIN_V — не приседает (шаг с бордюра).
const SHAR_LAND_DIP_PER_V = 4;
const SHAR_LAND_DIP_MAX = 4;
const SHAR_LAND_DIP_MIN_V = 0.3;
const SHAR_LAND_RECOVER = 3;
// Высота тела догоняет ступни на клетку раз в столько кадров.
const SHAR_RISE_FRAMES = 2;
// Падение: разгон за кадр и предел (клеток за кадр); в жидкости — медленно.
const SHAR_GRAVITY = 0.09;
const SHAR_FALL_MAX = 1;
const SHAR_SINK_MAX = 0.3;
// В воздухе — вбок со скоростью до SHAR_AIR_VX клеток за кадр (как шаг тела),
// набирая её на долю SHAR_AIR_CTRL за кадр.
const SHAR_AIR_VX = 1 / 3;
const SHAR_AIR_CTRL = 0.15;
// Прыжок: подготовка SHAR_JUMP_PREP кадров — присед до SHAR_JUMP_CROUCH
// клеток, потом толчок SHAR_JUMP_V; нажатие ждёт опоры SHAR_JUMP_BUFFER
// кадров. Присед клавишей S — на SHAR_CROUCH, W — обратное: вытянуться на
// SHAR_STRETCH выше стойки (просьба пользователя). Прыжок был втрое ниже, а
// подготовка — втрое короче (просьба: "в 3 раза больше прыжок и подготовка
// к нему в 3 раза дольше"): толчок 2.3 вместо 1.5 — на деле прыжок с
// приседа и с ногами выходит примерно втрое выше прежнего.
const SHAR_JUMP_PREP = 12;
const SHAR_JUMP_CROUCH = 3;
const SHAR_JUMP_V = 2.3;
const SHAR_JUMP_BUFFER = 8;
const SHAR_CROUCH = 4;
const SHAR_STRETCH = 3;
// На тело сверху что-то легло — он вжимается в пол до предела (просьба
// пользователя): ступня под телом может оказаться ближе обычного
// SHAR_FOOT_MIN, до SHAR_FOOT_PRESSED (ножке под телом нужно две клетки).
const SHAR_FOOT_PRESSED = 14;
const SHAR_PRESS_HOLD = 20;
// Висящие боковые ноги: поднимаясь в прыжке, сдвигаются к телу на
// SHAR_LEG_TUCK_X, падая — расходятся в стороны на столько же и тянутся к
// опоре под собой, если она не дальше SHAR_LEG_REACH_DOWN клеток ниже стойки
// (просьба: "подстраиваться под опору ещё в воздухе").
const SHAR_LEG_TUCK_X = 3;
const SHAR_LEG_REACH_DOWN = 4;
// Клетка тела, на которой держится нога (у средней столбец — от взгляда, как
// у крепления). Пропала — нога отваливается металлом (просьба пользователя).
const SHAR_ANCHOR_X = [3, 0, 8];
const SHAR_ANCHOR_Y = [10, 11, 10];
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
// Блик каждой клетки креста сенсора (индекс SHAR_GLOSS) — по картинке
// пользователя, см. SHAR_GLOSS: d — насколько клетка повёрнута к свету
// (от центра креста, в полуклетках).
const SHAR_EYE_GLOSS = new Uint8Array(SHAR_W * SHAR_H);
{
  const eye = new Uint8Array(SHAR_W * SHAR_H);
  for (const [dy, a, b] of SHAR_EYE_ROWS) for (let dx = a; dx <= b; dx++) eye[dy * SHAR_W + dx] = 1;
  for (const [dy, a, b] of SHAR_EYE_ROWS) {
    for (let dx = a; dx <= b; dx++) {
      const d = ((dx - 5.5) * SHAR_GLOSS_LIGHT[0] + (dy - 5.5) * SHAR_GLOSS_LIGHT[1]) / 2;
      const edge = !eye[dy * SHAR_W + dx - 1] || !eye[dy * SHAR_W + dx + 1] || !eye[(dy - 1) * SHAR_W + dx] || !eye[(dy + 1) * SHAR_W + dx];
      SHAR_EYE_GLOSS[dy * SHAR_W + dx] = edge ? (d < -0.5 ? 0 : 1) : (d > 0.5 ? 4 : d > -0.5 ? 3 : 2);
    }
  }
}
// Рабочий список клеток тела и разметка связности (только главный поток, см.
// шапку).
const SHAR_LIST = new Int32Array(SHAR_W * SHAR_H);
const SHAR_COMP = new Int16Array(SHAR_W * SHAR_H);
const SHAR_QUEUE = new Int32Array(SHAR_W * SHAR_H);

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
      id, x: x0, y: y0, face: 0, lookX: 0, lookY: 0, ctrl: SHAR_CTRL_NONE, cells: SHAR_CELLS,
      legs: [0, 1, 2].map(() => ({ x: 0, y: 0, on: false, n: SHAR_ON_FLOOR })),
      // Шаг: какая нога в воздухе (-1 — никакая), сколько кадров идёт,
      // откуда и куда, на что встанет.
      sw: -1, swT: 0, swX0: 0, swY0: 0, swX1: 0, swY1: 0, swN0: SHAR_ON_FLOOR, swN1: SHAR_ON_FLOOR,
      vx: 0, vy: 0, fx: 0, fy: 0, moveT: 0, riseT: 0, crouch: 0, jumpT: 0, jumpBuf: 0,
      // Присед приземления: на сколько клеток и сколько кадров идёт.
      dip: 0, dipT: 0,
      // Сколько кадров ещё вжат под грузом (SHAR_PRESS_HOLD).
      pressT: 0,
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
    for (let k = 0; k < 3; k++) this.sharHang(s, k, true);
    this.sharGrabHolds(s);
    this.paintSharoid(s);
    return true;
  }

  // ---- ноги: геометрия ----

  // Точка крепления ноги k на теле.
  sharAttachX(s, k) { return s.x + (k === 1 ? (s.face < 0 ? 5 : 6) : SHAR_ATTACH_X[k]); }
  sharAttachY(s, k) { return s.y + SHAR_ATTACH_Y[k]; }
  // Верх ножки ступни в (x, y) на опоре n — сюда приходит прямая ноги.
  sharShinX(x, n) { return n === SHAR_ON_LEFT ? x + 2 : n === SHAR_ON_RIGHT ? x - 2 : x; }
  sharShinY(y, n) { return n === SHAR_ON_FLOOR ? y - 2 : y; }

  // Место ступни ноги k: по столбцу — под телом; по строке — стойка, а в
  // шахте у боковых ног — SHAR_WALL_HOLD.
  sharHomeX(s, k) { return s.x + (k === 1 ? (s.face < 0 ? 5 : 6) : SHAR_HOME_X[k]); }
  sharHomeY(s, k, floor) { return s.y + (floor || k === 1 ? SHAR_STAND : SHAR_WALL_HOLD); }

  // Длина ноги k со ступнёй в (x, y) на опоре n.
  sharLegLen(s, k, x, y, n) {
    const dx = this.sharShinX(x, n) - this.sharAttachX(s, k), dy = this.sharShinY(y, n) - this.sharAttachY(s, k);
    return Math.sqrt(dx * dx + dy * dy);
  }

  // Нога k со ступнёй в (x, y) на опоре n не проходит сквозь твёрдое: прямая
  // от точки крепления до ножки — по проходимому (или по своему телу). Без
  // этого ступня перешагивала стену и вставала за ней.
  sharLegClear(s, k, x, y, n) {
    let px = this.sharAttachX(s, k), py = this.sharAttachY(s, k);
    const tx = this.sharShinX(x, n), ty = this.sharShinY(y, n), w = this.w;
    const dx = Math.abs(tx - px), dy = -Math.abs(ty - py), sx = px < tx ? 1 : -1, sy = py < ty ? 1 : -1;
    let err = dx + dy;
    for (let g = 0; g < 256; g++) {
      if (px < 0 || px >= w || py >= this.h) return false;
      if (py >= 0) {
        const i = py * w + px, t = this.type[i];
        if (!this.sharPassable(t) && !(t === EL.SHAROID && this.life[i] === s.id)) return false;
      }
      if (px === tx && py === ty) return true;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; px += sx; }
      if (e2 <= dx) { err += dx; py += sy; }
    }
    return false;
  }

  // Опора ступни шароида s в (x, y) — но не его собственное тело: средняя
  // нога в шахте "опиралась" о свой корпус и держала его сама.
  sharSupportFor(s, x, y) {
    if (!this.sharSupportAt(x, y)) return false;
    if (y >= this.h) return true;
    const i = y * this.w + x;
    return !(this.type[i] === EL.SHAROID && this.life[i] === s.id);
  }

  // Есть ли у ступни в (x, y) опора n: пол под перекладиной (и низ поля),
  // стена сбоку от неё (и край поля).
  sharHasSupport(s, x, y, n) {
    if (n === SHAR_ON_FLOOR) return this.sharSupportFor(s, x - 1, y + 1) || this.sharSupportFor(s, x, y + 1) || this.sharSupportFor(s, x + 1, y + 1);
    const sx = n === SHAR_ON_LEFT ? x - 1 : x + 1;
    if (sx < 0 || sx >= this.w) return true;
    return this.sharSupportFor(s, sx, y - 1) || this.sharSupportFor(s, sx, y) || this.sharSupportFor(s, sx, y + 1);
  }

  // Может ли нога k встать ступнёй в (x, y) на опору n: перекладина и ножка —
  // в проходимом, опора есть, нога не длиннее SHAR_LEG_MAX и не сквозь стену.
  sharHoldOk(s, k, x, y, n) {
    if (n === SHAR_ON_FLOOR) {
      if (!this.sharFreeAt(x - 1, y) || !this.sharFreeAt(x, y) || !this.sharFreeAt(x + 1, y) || !this.sharFreeAt(x, y - 1) || !this.sharFreeAt(x, y - 2)) return false;
    } else {
      const d = n === SHAR_ON_LEFT ? 1 : -1;
      if (y - 1 < 0 || y + 1 >= this.h) return false;
      if (!this.sharFreeAt(x, y - 1) || !this.sharFreeAt(x, y) || !this.sharFreeAt(x, y + 1) || !this.sharFreeAt(x + d, y) || !this.sharFreeAt(x + 2 * d, y)) return false;
    }
    if (!this.sharHasSupport(s, x, y, n)) return false;
    if (this.sharLegLen(s, k, x, y, n) > SHAR_LEG_MAX) return false;
    return this.sharLegClear(s, k, x, y, n);
  }

  // Ближайшая к (tx, ty) опора для ноги k: столбцы — на rx в стороны, строки —
  // на up выше и down ниже; цена — 4*dx² + dy², на стене ещё wall; only — только
  // опора этой стороны (-1 — любая). null — нет.
  sharFindHold(s, k, tx, ty, rx, up, down, wall, only = -1) {
    let best = null, bestScore = Infinity;
    for (let dy = -up; dy <= down; dy++) {
      for (let dx = -rx; dx <= rx; dx++) {
        const base = 4 * dx * dx + dy * dy;
        for (let n = 0; n < 3; n++) {
          if (only >= 0 && n !== only) continue;
          const score = base + (n === SHAR_ON_FLOOR ? 0 : wall);
          if (score >= bestScore) continue;
          if (!this.sharHoldOk(s, k, tx + dx, ty + dy, n)) continue;
          best = { x: tx + dx, y: ty + dy, n };
          bestScore = score;
        }
      }
    }
    return best;
  }

  // Стоит ли ступня: опора на её стороне на месте.
  sharFootHeld(s, leg) { return this.sharHasSupport(s, Math.round(leg.x), Math.round(leg.y), leg.n); }

  // Сколько ступней стоит (без шагающей и без ноги skip) — всего, на полу, на
  // стенах слева и справа.
  sharCount(s, skip = -1) {
    let all = 0, floor = 0, left = 0, right = 0;
    for (let k = 0; k < 3; k++) {
      const leg = s.legs[k];
      if (!leg.on || s.sw === k || k === skip) continue;
      all++;
      if (leg.n === SHAR_ON_FLOOR) floor++; else if (leg.n === SHAR_ON_LEFT) left++; else right++;
    }
    return { all, floor, left, right };
  }

  sharPlanted(s) { return this.sharCount(s).all; }

  // Держат ли ноги тело (без ноги skip): две ступни, и есть пол или стены с
  // обеих сторон (см. шапку).
  sharHeld(s, skip = -1) {
    const c = this.sharCount(s, skip);
    return c.all >= 2 && (c.floor > 0 || (c.left > 0 && c.right > 0));
  }

  // ---- ноги: висящие ----

  // Высота висящей ступни под верхом тела: стойка, в падении — выше
  // (поджаты), при подъёме — ниже (вытянуты), см. SHAR_LEG_TUCK.
  sharHangRel(s) {
    const k = s.vy > 0 ? -Math.min(1, s.vy / SHAR_FALL_MAX) : Math.min(1, -s.vy / SHAR_JUMP_V);
    return SHAR_STAND + k * SHAR_LEG_TUCK;
  }

  // Нога k висит: идёт к своему месту под телом (SHAR_LEG_FOLLOW), сквозь
  // твёрдое не проходит; snap — сразу на месте (только что поставлен). Нога,
  // оказавшаяся длиннее SHAR_LEG_MAX, подтягивается к телу.
  sharHang(s, k, snap = false) {
    const leg = s.legs[k];
    if (leg.gone) return;
    // В прыжке боковые ноги — к телу, в падении — в стороны (SHAR_LEG_TUCK_X),
    // и падая, нога тянется к опоре под собой (sharGroundBelow).
    const side = k === 0 ? -1 : k === 2 ? 1 : 0;
    const tx = this.sharHomeX(s, k) + side * (s.vy < 0 ? -SHAR_LEG_TUCK_X : s.vy > SHAR_GRAVITY ? SHAR_LEG_TUCK_X : 0);
    let ty = s.y + this.sharHangRel(s);
    if (s.vy > SHAR_GRAVITY) {
      const g = this.sharGroundBelow(s, Math.round(tx));
      if (g >= 0) ty = g;
    }
    leg.on = false;
    leg.n = SHAR_ON_FLOOR;
    if (snap) { leg.x = tx; leg.y = ty; return; }
    const nx = leg.x + (tx - leg.x) * SHAR_LEG_FOLLOW, ny = leg.y + (ty - leg.y) * SHAR_LEG_FOLLOW;
    const rx = Math.round(nx), ry = Math.round(ny), ox = Math.round(leg.x), oy = Math.round(leg.y);
    // Уже внутри твёрдого (поставлен вплотную, опору засыпало) — выходит свободно.
    if (this.sharFreeAt(rx, ry) || !this.sharFreeAt(ox, oy)) { leg.x = nx; leg.y = ny; }
    else if (this.sharFreeAt(rx, oy)) leg.x = nx;
    else if (this.sharFreeAt(ox, ry)) leg.y = ny;
    this.sharClampLeg(s, k);
  }

  // Нога k длиннее SHAR_LEG_MAX — ступня подтягивается к телу по прямой ноги
  // (висящая и шагающая: стоящую оттянутую отпускает updateSharoid).
  sharClampLeg(s, k) {
    const leg = s.legs[k], n = leg.n;
    if (leg.gone) return;
    const ax = this.sharAttachX(s, k), ay = this.sharAttachY(s, k);
    const tx = this.sharShinX(leg.x, n), ty = this.sharShinY(leg.y, n);
    const dx = tx - ax, dy = ty - ay, len = Math.sqrt(dx * dx + dy * dy);
    if (len <= SHAR_LEG_MAX) return;
    leg.x += ax + dx * SHAR_LEG_MAX / len - tx;
    leg.y += ay + dy * SHAR_LEG_MAX / len - ty;
  }

  // Строка пола под столбцом x для ступни падающего шароида: первая свободная
  // строка с опорой под ней — от SHAR_FOOT_MIN до SHAR_LEG_REACH_DOWN ниже
  // стойки; -1 — опоры в пределах ног нет.
  sharGroundBelow(s, x) {
    for (let r = s.y + SHAR_FOOT_MIN; r <= s.y + SHAR_STAND + SHAR_LEG_REACH_DOWN; r++) {
      if (!this.sharFreeAt(x, r)) return -1;
      if (this.sharSupportFor(s, x - 1, r + 1) || this.sharSupportFor(s, x, r + 1) || this.sharSupportFor(s, x + 1, r + 1)) return r;
    }
    return -1;
  }

  // Висящие ноги встают на опору, которой коснулись (в пределах SHAR_GRAB).
  sharGrabHolds(s) {
    for (let k = 0; k < 3; k++) {
      const leg = s.legs[k];
      if (leg.on || leg.gone || s.sw === k) continue;
      const h = this.sharFindHold(s, k, Math.round(leg.x), Math.round(leg.y), SHAR_GRAB_X, SHAR_GRAB, SHAR_GRAB, 0);
      if (h) { leg.x = h.x; leg.y = h.y; leg.n = h.n; leg.on = true; }
    }
  }

  // ---- тело ----

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
  // сыпучее, край поля или натянутый трос (sim/rope.js) — не двигается (false).
  moveSharoid(s, dx, dy) {
    const w = this.w, h = this.h, type = this.type, life = this.life, id = s.id;
    if (this.ropes.length && !this.ropeAllowsSharoid(s, dx, dy)) return false;
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
    // Висящие ступни едут с телом (к своему месту идут сами, sharHang), но
    // не въезжают в твёрдое: так ступня, висевшая над краем шахты, уходила в
    // её стену, и шароид пролетал шахту насквозь.
    for (let k = 0; k < 3; k++) {
      const leg = s.legs[k];
      if (leg.on || s.sw === k) continue;
      const inside = !this.sharFreeAt(Math.round(leg.x), Math.round(leg.y));
      if (inside || this.sharFreeAt(Math.round(leg.x + dx), Math.round(leg.y + dy))) { leg.x += dx; leg.y += dy; }
    }
    return true;
  }

  // Раскрасить корпус (extra клеток) — сенсор смотрит в сторону взгляда и
  // светится цветом того, кто управляет. Только при смене.
  paintSharoid(s) {
    const lx = s.lookX, ly = s.lookY;
    const eye = SHAR_PART_EYE + SHAR_GLOSS_N * (s.ctrl >= 0 && s.ctrl < 16 ? SHAR_EYE_PLAYER + s.ctrl : s.ctrl === SHAR_CTRL_HUMAN ? SHAR_EYE_HUMAN : SHAR_EYE_CYAN);
    const key = ((lx + 8) * 16 + ly + 8) * 128 + eye;
    if (s.painted === key) return;
    s.painted = key;
    const w = this.w, h = this.h;
    const set = (dx, dy, part) => {
      const x = s.x + dx, y = s.y + dy;
      if (x < 0 || x >= w || y < 0 || y >= h || dx < 0 || dx >= SHAR_W || dy < 0 || dy >= SHAR_H || !SHAR_MASK[dy * SHAR_W + dx]) return;
      const i = y * w + x;
      if (this.type[i] !== EL.SHAROID || this.life[i] !== s.id) return;
      if (this.extra[i] !== part) { this.extra[i] = part; this.markDirty(i); }
    };
    for (let k = 0; k < SHAR_MASK.length; k++) if (SHAR_MASK[k]) set(k % SHAR_W, (k / SHAR_W) | 0, SHAR_RING[k]);
    // Оправа — соседи креста (по 4 сторонам), потом сам крест поверх.
    for (const [dy, a, b] of SHAR_EYE_ROWS) {
      for (let dx = a; dx <= b; dx++) {
        set(dx + lx - 1, dy + ly, SHAR_PART_FRAME); set(dx + lx + 1, dy + ly, SHAR_PART_FRAME);
        set(dx + lx, dy + ly - 1, SHAR_PART_FRAME); set(dx + lx, dy + ly + 1, SHAR_PART_FRAME);
      }
    }
    for (const [dy, a, b] of SHAR_EYE_ROWS) for (let dx = a; dx <= b; dx++) set(dx + lx, dy + ly, eye + SHAR_EYE_GLOSS[dy * SHAR_W + dx]);
  }

  // Раз в кадр перед обходом клеток (главным потоком, см. шапку).
  updateSharoids() {
    if (this._sharSweep) this.sweepSharoidOrphans();
    if (this.sharoids.length === 0) return;
    let gone = false;
    for (const s of this.sharoids) {
      const n = this.sharIntegrity(s);
      if (n < s.cells * SHAR_ALIVE_PART) { this.destroySharoid(s); gone = true; continue; }
      this.updateSharoid(s);
    }
    if (gone) this.sharoids = this.sharoids.filter((s) => !s.dead);
  }

  // Целость шароида s (просьба пользователя: "от шароида можно отламывать
  // целые куски"): куски тела, не связанные (по 4 соседям) с самым большим,
  // отрываются — становятся металлом и падают (sharDetachCell); раньше
  // оставшиеся после плавления островки клеток шароида висели в воздухе.
  // Нога, чья опорная клетка тела пропала (SHAR_ANCHOR_*), отваливается
  // (sharDropLeg). Возвращает, сколько клеток осталось в теле.
  sharIntegrity(s) {
    const n = this.sharCollect(s), w = this.w;
    SHAR_COMP.fill(-1);
    for (let k = 0; k < n; k++) SHAR_COMP[(((SHAR_LIST[k] / w) | 0) - s.y) * SHAR_W + SHAR_LIST[k] % w - s.x] = 0;
    let label = 0, best = 0, bestSize = 0;
    for (let k = 0; k < n; k++) {
      const c0 = (((SHAR_LIST[k] / w) | 0) - s.y) * SHAR_W + SHAR_LIST[k] % w - s.x;
      if (SHAR_COMP[c0] !== 0) continue;
      label++;
      let head = 0, tail = 0;
      SHAR_COMP[c0] = label; SHAR_QUEUE[tail++] = c0;
      while (head < tail) {
        const c = SHAR_QUEUE[head++], cx = c % SHAR_W;
        if (cx > 0 && SHAR_COMP[c - 1] === 0) { SHAR_COMP[c - 1] = label; SHAR_QUEUE[tail++] = c - 1; }
        if (cx < SHAR_W - 1 && SHAR_COMP[c + 1] === 0) { SHAR_COMP[c + 1] = label; SHAR_QUEUE[tail++] = c + 1; }
        if (c >= SHAR_W && SHAR_COMP[c - SHAR_W] === 0) { SHAR_COMP[c - SHAR_W] = label; SHAR_QUEUE[tail++] = c - SHAR_W; }
        if (c + SHAR_W < SHAR_COMP.length && SHAR_COMP[c + SHAR_W] === 0) { SHAR_COMP[c + SHAR_W] = label; SHAR_QUEUE[tail++] = c + SHAR_W; }
      }
      if (tail > bestSize) { bestSize = tail; best = label; }
    }
    if (label > 1) {
      for (let k = 0; k < n; k++) {
        const i = SHAR_LIST[k];
        if (SHAR_COMP[(((i / w) | 0) - s.y) * SHAR_W + i % w - s.x] !== best) this.sharDetachCell(i);
      }
    }
    for (let k = 0; k < 3; k++) {
      if (s.legs[k].gone) continue;
      const ax = k === 1 ? (s.face < 0 ? 5 : 6) : SHAR_ANCHOR_X[k];
      if (SHAR_COMP[SHAR_ANCHOR_Y[k] * SHAR_W + ax] !== best || best === 0) this.sharDropLeg(s, k);
    }
    return bestSize;
  }

  // Оттенок (shade), с которым клетка вещества id выглядит цветом rgb, —
  // насколько удаётся сдвигом яркости (просьба пользователя: металл, в
  // который превращается шароид, — того же цвета).
  sharShadeFor(rgb, id) {
    const c = ELEMENTS[id].color;
    return Math.max(-128, Math.min(127, Math.round((rgb[0] + rgb[1] + rgb[2] - c[0] - c[1] - c[2]) / 3)));
  }

  // Цвет клетки корпуса шароида по её части (как Renderer.sharoidColor, без
  // цвета игрока — у металла его нет).
  sharPartColor(part) {
    if (part < SHAR_PART_EYE) return SHAR_PART_COLOR[part] || ELEMENTS[EL.SHAROID].color;
    const col = ((part - SHAR_PART_EYE) / SHAR_GLOSS_N) | 0;
    return SHAR_EYE_COLOR[col] || SHAR_EYE_COLOR[SHAR_EYE_CYAN];
  }

  // Клетка шароида отрывается: становится тем, что в ней по составу (обычно
  // сталью, разъеденная — её смесью), того же цвета (shade), и дальше живёт
  // как обычное твёрдое — без опоры падает.
  sharDetachCell(i) {
    const comp = this.comp(i), rgb = this.sharPartColor(this.extra[i]);
    this.type[i] = EL.STEEL; this.life[i] = 0; this.extra[i] = 0;
    this.setComposition(i, comp);
    const t = this.type[i];
    if (t !== EL.EMPTY && !hasComposition(t) && comp < 1024) this.shade[i] = this.sharShadeFor(rgb, t);
    this.markDirty(i);
  }

  // Клетки ноги k шароида s: fn(x, y, часть) — прямая (0), ножка (1),
  // перекладина (2). Ступня на стене повёрнута (перекладина стоймя, ножка от
  // стены). Её же рисует Renderer.drawSharoids.
  sharLegCells(s, k, fn) {
    const leg = s.legs[k], fx = Math.round(leg.x), fy = Math.round(leg.y), n = leg.n | 0;
    let x = this.sharAttachX(s, k), y = this.sharAttachY(s, k);
    const tx = this.sharShinX(fx, n), ty = this.sharShinY(fy, n);
    const dx = Math.abs(tx - x), dy = -Math.abs(ty - y), sx = x < tx ? 1 : -1, sy = y < ty ? 1 : -1;
    let err = dx + dy;
    for (let g = 0; g < 256; g++) {
      fn(x, y, 0);
      if (x === tx && y === ty) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
    }
    if (n === SHAR_ON_FLOOR) { fn(fx, fy - 2, 1); fn(fx, fy - 1, 1); for (let d = -1; d <= 1; d++) fn(fx + d, fy, 2); }
    else {
      const d = n === SHAR_ON_LEFT ? 1 : -1;
      fn(fx + d, fy, 1); fn(fx + 2 * d, fy, 1);
      for (let e = -1; e <= 1; e++) fn(fx, fy + e, 2);
    }
  }

  // Нога k отваливается (нет опорной клетки тела) или шароид разрушен:
  // её клетки становятся металлом её цвета там, где пусто (просьба
  // пользователя), и падают как обломки.
  sharDropLeg(s, k) {
    const colors = [SHAR_LEG_COLOR, SHAR_SHIN_COLOR, SHAR_FOOT_COLOR], w = this.w;
    this.sharLegCells(s, k, (x, y, part) => {
      if (!this.inBounds(x, y)) return;
      const i = y * w + x;
      if (this.type[i] !== EL.EMPTY) return;
      this.spawn(i, EL.STEEL);
      this.shade[i] = this.sharShadeFor(colors[part], EL.STEEL);
    });
    const leg = s.legs[k];
    leg.gone = true; leg.on = false;
    if (s.sw === k) s.sw = -1;
  }

  // Шароид разрушен: уцелевшие клетки — металл того же цвета (sharDetachCell),
  // ноги — тоже, игрок за ним — погиб.
  destroySharoid(s) {
    const n = this.sharCollect(s);
    for (let k = 0; k < n; k++) this.sharDetachCell(SHAR_LIST[k]);
    for (let k = 0; k < 3; k++) if (!s.legs[k].gone) this.sharDropLeg(s, k);
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

  // ---- управление ----

  // Что хочет тот, кто управляет: ход по полу (dir), прыжок, присед, ход по
  // шахте (vert: -1 вверх, 1 вниз) и куда смотреть (aim, клетка ax/ay).
  sharoidIntent(s) {
    if (s.ctrl >= 0) {
      const inp = this.playerSlot(s.ctrl).input;
      const dir = inp.left === inp.right ? 0 : (inp.left ? -1 : 1);
      // Прыгает шароид только на пробел: W у него — обратное приседу
      // (вытянуться, в шахте — лезть вверх; просьба пользователя). inp.w — W
      // зажата (js/play.js): её нажатие тоже ставит jump, ради протагониста.
      const jump = inp.jump && !inp.w;
      inp.jump = false;
      return { dir, jump, crouch: !!inp.down, vert: inp.w ? -1 : inp.down ? 1 : 0, aim: !!inp.aim, ax: inp.ax | 0, ay: inp.ay | 0 };
    }
    if (s.ctrl === SHAR_CTRL_HUMAN) return this.sharoidHumanIntent(s);
    return { dir: 0, jump: false, crouch: false, vert: 0, aim: false, ax: 0, ay: 0 };
  }

  // Шароид-"человек" (просьба: "будет вести себя как человек"): бродит
  // туда-сюда, останавливается, передумывает; опасное впереди (то, чего
  // боится человек, humanDanger) и обрыв — разворачивается; упёрся —
  // пробует перепрыгнуть, не вышло — назад. В шахте лезет вверх или вниз.
  sharoidHumanIntent(s) {
    const still = { dir: 0, jump: false, crouch: false, vert: 0, aim: false, ax: 0, ay: 0 };
    if (s.walk === 0) {
      if (Math.random() < SHAR_AI_GO_CHANCE) s.walk = Math.random() < 0.5 ? -1 : 1;
      return still;
    }
    if (Math.random() < SHAR_AI_STOP_CHANCE) { s.walk = 0; s.stuck = 0; return still; }
    if (Math.random() < SHAR_AI_TURN_CHANCE) s.walk = -s.walk;
    let jump = false;
    if (this.frame % SHAR_AI_SCAN_PERIOD === s.id % SHAR_AI_SCAN_PERIOD && this.sharDangerAhead(s, s.walk)) { s.walk = -s.walk; s.stuck = 0; }
    else if (this.sharHeld(s) && this.sharCount(s).floor > 0) {
      // Обрыв: передней ноге на её следующем месте не на что встать.
      const front = s.walk > 0 ? 2 : 0;
      if (!this.sharStepHold(s, front, s.walk, 0, true, SHAR_STEP_LEAD + 1)) { s.walk = -s.walk; s.stuck = 0; }
    }
    if (s.stuck >= SHAR_AI_STUCK) {
      s.stuck = 0;
      if (Math.random() < SHAR_AI_JUMP_CHANCE) jump = true; else s.walk = -s.walk;
    }
    return { dir: s.walk, jump, crouch: false, vert: s.walk, aim: false, ax: 0, ay: 0 };
  }

  // Есть ли впереди (по ходу dir, SHAR_AI_SIGHT столбцов от края тела, по
  // всей высоте шароида) то, чего боится человек.
  sharDangerAhead(s, dir) {
    const w = this.w, h = this.h;
    const x0 = dir > 0 ? s.x + SHAR_W : s.x - 1;
    for (let c = 0; c < SHAR_AI_SIGHT; c++) {
      const x = x0 + dir * c;
      if (x < 0 || x >= w) break;
      for (let y = Math.max(0, s.y); y <= Math.min(h - 1, s.y + SHAR_STAND + SHAR_SEEK_DOWN); y++) {
        if (this.humanDanger(this.type[y * w + x])) return true;
      }
    }
    return false;
  }

  // Куда смотрит сенсор: игрок в игре — на курсор (просьба пользователя),
  // остальные — по ходу.
  sharLook(s, want) {
    let lx = s.face * SHAR_LOOK, ly = 0;
    if (want.aim) {
      const dx = want.ax + 0.5 - (s.x + 6), dy = want.ay + 0.5 - (s.y + 6), d = Math.sqrt(dx * dx + dy * dy);
      if (d >= 1) { lx = Math.round(SHAR_LOOK * dx / d); ly = Math.round(SHAR_LOOK * dy / d); } else { lx = 0; ly = 0; }
    }
    // Сенсор не заезжает туда, где тела уже нет (просьба пользователя):
    // ближайший к желаемому сдвиг, при котором все клетки креста — целые
    // клетки тела; нет такого — остаётся где был.
    let best = null, bestD = Infinity;
    for (let oy = -SHAR_LOOK; oy <= SHAR_LOOK; oy++) {
      for (let ox = -SHAR_LOOK; ox <= SHAR_LOOK; ox++) {
        const d = (ox - lx) * (ox - lx) + (oy - ly) * (oy - ly);
        if (d >= bestD || !this.sharEyeFits(s, ox, oy)) continue;
        best = [ox, oy]; bestD = d;
      }
    }
    if (best) { s.lookX = best[0]; s.lookY = best[1]; }
  }

  // Все ли клетки креста сенсора при сдвиге (ox, oy) — клетки тела s.
  sharEyeFits(s, ox, oy) {
    const w = this.w;
    for (const [dy, a, b] of SHAR_EYE_ROWS) {
      for (let dx = a; dx <= b; dx++) {
        const x = s.x + dx + ox, y = s.y + dy + oy;
        if (!this.inBounds(x, y)) return false;
        const i = y * w + x;
        if (this.type[i] !== EL.SHAROID || this.life[i] !== s.id) return false;
      }
    }
    return true;
  }

  updateSharoid(s) {
    const want = this.sharoidIntent(s);
    if (want.dir) s.face = want.dir;
    this.sharLook(s, want);
    if (want.jump) s.jumpBuf = SHAR_JUMP_BUFFER; else if (s.jumpBuf > 0) s.jumpBuf--;
    // Ступни, из-под которых ушла опора или которые тело оттянуло дальше
    // длины ноги, повисают.
    for (let k = 0; k < 3; k++) {
      const leg = s.legs[k];
      if (!leg.on || s.sw === k) continue;
      if (!this.sharFootHeld(s, leg) || this.sharLegLen(s, k, leg.x, leg.y, leg.n) > SHAR_LEG_MAX + 0.5) { leg.on = false; leg.n = SHAR_ON_FLOOR; }
    }
    if (s.vy < 0 || !this.sharHeld(s)) this.sharoidAir(s, want.dir);
    else this.sharoidWalk(s, want);
    this.paintSharoid(s);
  }

  // В воздухе: подъём прыжка или падение, вбок — понемногу (s.vx); на тросе
  // — качается (ropeSwingSharoid). Ноги висят и встают на опору, которой
  // коснутся (только на спуске).
  sharoidAir(s, dir) {
    s.sw = -1; s.crouch = 0; s.jumpT = 0;
    const below = s.y + SHAR_H < this.h ? this.type[(s.y + SHAR_H) * this.w + s.x + (SHAR_W >> 1)] : EL.EMPTY;
    const max = IS_LIQUID[below] === 1 ? SHAR_SINK_MAX : SHAR_FALL_MAX;
    s.vy = Math.min(max, s.vy + SHAR_GRAVITY);
    // Вбок — только пока держат клавишу: без неё скорость сохраняется
    // (инерция прыжка, качание на тросе).
    if (dir) s.vx += (dir * SHAR_AIR_VX - s.vx) * SHAR_AIR_CTRL;
    if (this.ropes.length) this.ropeSwingSharoid(s);
    s.fy += s.vy;
    s.fx += s.vx;
    while (s.fy <= -1) {
      s.fy += 1;
      if (!this.moveSharoid(s, 0, -1)) { s.vy = 0; s.fy = 0; break; }   // ударился о потолок
    }
    while (s.fy >= 1) {
      s.fy -= 1;
      if (!this.moveSharoid(s, 0, 1)) { s.vy = 0; s.fy = 0; break; }    // лёг на опору
      if (s.vy >= 0) { this.sharGrabHolds(s); if (this.sharHeld(s)) break; }
    }
    while (Math.abs(s.fx) >= 1) {
      const d = s.fx > 0 ? 1 : -1;
      s.fx -= d;
      if (!this.moveSharoid(s, d, 0)) { s.vx = 0; s.fx = 0; break; }
    }
    for (let k = 0; k < 3; k++) if (!s.legs[k].on) this.sharHang(s, k);
    if (s.vy >= 0) this.sharGrabHolds(s);
    if (this.sharHeld(s)) {
      // Встал с разгона — ядро по инерции приседает (SHAR_LAND_DIP_*).
      if (s.vy >= SHAR_LAND_DIP_MIN_V) { s.dip = Math.min(SHAR_LAND_DIP_MAX, Math.round(s.vy * SHAR_LAND_DIP_PER_V)); s.dipT = 0; }
      s.vy = 0; s.fy = 0; s.vx = 0; s.fx = 0;
    }
  }

  // Лежит ли что-то на теле сверху: над верхней клеткой тела в каком-нибудь
  // столбце — не проходимое и не сам шароид.
  sharPressed(s) {
    const w = this.w, type = this.type, life = this.life;
    for (let dx = 0; dx < SHAR_W; dx++) {
      const x = s.x + dx;
      for (let dy = 0; dy < SHAR_H; dy++) {
        const y = s.y + dy, i = y * w + x;
        if (type[i] !== EL.SHAROID || life[i] !== s.id) continue;
        if (y > 0 && !this.sharPassable(type[i - w]) && !(type[i - w] === EL.SHAROID && life[i - w] === s.id)) return true;
        break;
      }
    }
    return false;
  }

  // Может ли тело сдвинуться на (dx, dy), не оторвавшись от стоящих ног:
  // каждая не длиннее SHAR_LEG_MAX, а на полу при ходе вбок — не дальше
  // SHAR_REACH от своего места.
  sharBodyMoveOk(s, dx, dy) {
    for (let k = 0; k < 3; k++) {
      const leg = s.legs[k];
      if (!leg.on || s.sw === k) continue;
      const ax = this.sharAttachX(s, k) + dx, ay = this.sharAttachY(s, k) + dy;
      const ex = this.sharShinX(leg.x, leg.n) - ax, ey = this.sharShinY(leg.y, leg.n) - ay;
      if (ex * ex + ey * ey > SHAR_LEG_MAX * SHAR_LEG_MAX) return false;
      if (dx && leg.n === SHAR_ON_FLOOR && Math.abs(leg.x - (this.sharHomeX(s, k) + dx)) > SHAR_REACH) return false;
    }
    return true;
  }

  // На ногах: на полу — прыжок (присед, толчок), шаги, ход вбок и высота
  // тела; враспор в шахте — шаги и ход вверх-вниз (want.vert).
  sharoidWalk(s, want) {
    s.vy = 0; s.fy = 0; s.vx = 0; s.fx = 0;
    let floor = this.sharCount(s).floor > 0;
    // Игрок стоит над шахтой (под серединой тела пола нет) и жмёт S — лезет в
    // неё враспор: ноги переступают на её стены, как в самой шахте. Иначе
    // встав поперёк шахты на её края, он спуститься в неё не мог.
    if (floor && s.ctrl >= 0 && want.vert > 0 && !this.sharStepHold(s, 1, 0, 0, true, 0)) floor = false;
    // На дне шахты W — лезть вверх, а не прыгать: стены по обе стороны в
    // пределах ног.
    if (floor && s.ctrl >= 0 && want.vert < 0 && this.sharInShaft(s)) floor = false;
    const dir = floor ? want.dir : 0, vert = floor ? 0 : want.vert;
    if (!floor) { s.jumpBuf = 0; s.jumpT = 0; }
    // Прыжок: присед за SHAR_JUMP_PREP кадров до SHAR_JUMP_CROUCH, потом
    // толчок (см. шапку).
    if (s.jumpT === 0 && s.jumpBuf > 0) { s.jumpBuf = 0; s.jumpT = SHAR_JUMP_PREP; }
    if (s.jumpT > 0) {
      if (--s.jumpT === 0) {
        s.sw = -1; s.crouch = 0;
        for (let k = 0; k < 3; k++) { s.legs[k].on = false; s.legs[k].n = SHAR_ON_FLOOR; }
        s.vy = -SHAR_JUMP_V;
        s.vx = dir * SHAR_AIR_VX;
        s.fy = 0;
        this.sharoidAir(s, dir);
        return;
      }
      s.crouch = Math.ceil((SHAR_JUMP_PREP - s.jumpT) * SHAR_JUMP_CROUCH / SHAR_JUMP_PREP);
    } else {
      s.crouch = floor && want.crouch ? SHAR_CROUCH : floor && s.ctrl >= 0 && want.vert < 0 ? -SHAR_STRETCH : 0;
    }
    // Сверху что-то лежит — вжаться в пол до предела (SHAR_FOOT_PRESSED) и
    // побыть так SHAR_PRESS_HOLD кадров: упавший груз ложится следом, а
    // неподвижный (стена) иначе дёргал бы тело вверх-вниз на клетку.
    if (floor && this.sharPressed(s)) s.pressT = SHAR_PRESS_HOLD; else if (s.pressT > 0) s.pressT--;
    const pressed = floor && s.pressT > 0;
    // Присед приземления выпрямляется понемногу (SHAR_LAND_RECOVER).
    if (s.dip > 0 && ++s.dipT >= SHAR_LAND_RECOVER) { s.dipT = 0; s.dip--; }
    this.sharSwing(s);
    if (s.sw < 0 && s.jumpT === 0) this.sharStartStep(s, dir, vert, floor);
    // Ход тела: каждая стоящая нога должна дотягиваться до нового места.
    let blocked = false;
    if ((dir || vert) && s.jumpT === 0 && ++s.moveT >= SHAR_MOVE_FRAMES) {
      s.moveT = 0;
      // Ноги уходят с опоры, только когда видят новую: у обрыва передней
      // ступне некуда встать — тело стоит (раньше игрок шёл дальше, и нога со
      // стороны обрыва повисала в воздухе — жалоба пользователя). Вниз — прыжком.
      const ok = this.sharBodyMoveOk(s, dir, vert);
      if (ok) {
        if (this.moveSharoid(s, dir, vert)) {
          for (let k = 0; k < 3; k++) {
            const leg = s.legs[k];
            if (!leg.on || s.sw === k) continue;
            if (this.sharLegLen(s, k, leg.x, leg.y, leg.n) > SHAR_LEG_MAX + 0.5 || (leg.n === SHAR_ON_FLOOR && Math.abs(leg.x - this.sharHomeX(s, k)) > SHAR_REACH)) { leg.on = false; leg.n = SHAR_ON_FLOOR; }
          }
        } else if (dir && this.sharBodyMoveOk(s, 0, -1) && this.moveSharoid(s, 0, -1)) {
          // Упёрся телом в склон — шаг вверх-вбок; не вышло — обратно вниз.
          if (!(this.sharBodyMoveOk(s, dir, 0) && this.moveSharoid(s, dir, 0))) { this.moveSharoid(s, 0, 1); blocked = true; }
        } else blocked = true;
      } else if (s.sw < 0) blocked = true;
    }
    s.stuck = blocked ? s.stuck + 1 : 0;
    // Высота тела на полу — по средней высоте ступней на полу (и приседу).
    if (floor && ++s.riseT >= (s.jumpT > 0 || s.dip > 0 || pressed ? 1 : SHAR_RISE_FRAMES)) {
      s.riseT = 0;
      let sum = 0, m = 0, low = Infinity;
      for (let k = 0; k < 3; k++) {
        const leg = s.legs[k];
        if (!leg.on || s.sw === k || leg.n !== SHAR_ON_FLOOR) continue;
        sum += leg.y; m++;
        // Ступня под телом — ниже неё ножке нужно место.
        if (leg.x >= s.x - 1 && leg.x <= s.x + SHAR_W) low = Math.min(low, leg.y);
      }
      if (m > 0) {
        const target = pressed ? low - SHAR_FOOT_PRESSED : Math.min(Math.round(sum / m) - SHAR_STAND + s.crouch + s.dip, low - SHAR_FOOT_MIN);
        if (target > s.y && this.sharBodyMoveOk(s, 0, 1)) this.moveSharoid(s, 0, 1);
        else if (target < s.y && this.sharBodyMoveOk(s, 0, -1)) this.moveSharoid(s, 0, -1);
      }
    }
    for (let k = 0; k < 3; k++) {
      const leg = s.legs[k];
      if (!leg.on && s.sw !== k) this.sharHang(s, k);
    }
    // Тело ушло, пока нога только оторвалась, — и она за ним.
    if (s.sw >= 0) this.sharClampLeg(s, s.sw);
  }

  // Нога в шаге: по дуге от (swX0, swY0) к (swX1, swY1) — от опоры прочь
  // (на пол — вверх, на стену — от стены); в конце встаёт, если опора на
  // месте, иначе повисает.
  sharSwing(s) {
    if (s.sw < 0) return;
    const leg = s.legs[s.sw];
    const t = ++s.swT / SHAR_STEP_FRAMES;
    if (t >= 1) {
      if (this.sharHoldOk(s, s.sw, s.swX1, s.swY1, s.swN1)) { leg.x = s.swX1; leg.y = s.swY1; leg.n = s.swN1; leg.on = true; }
      else { leg.x = s.swX1; leg.y = s.swY1; this.sharHang(s, s.sw); }
      s.sw = -1;
      return;
    }
    const lift = SHAR_STEP_LIFT * Math.sin(Math.PI * t);
    leg.x = s.swX0 + (s.swX1 - s.swX0) * t + (s.swN1 === SHAR_ON_LEFT ? lift : s.swN1 === SHAR_ON_RIGHT ? -lift : 0);
    leg.y = s.swY0 + (s.swY1 - s.swY0) * t - (s.swN1 === SHAR_ON_FLOOR ? lift : 0);
    leg.n = t < 0.5 ? s.swN0 : s.swN1;
    this.sharClampLeg(s, s.sw);
  }

  // Стоит ли шароид в шахте: левой ноге есть опора на левой стене, правой —
  // на правой (там, где они держались бы враспор).
  sharInShaft(s) {
    const r = SHAR_SEEK_SHAFT_X, v = SHAR_SEEK_SHAFT;
    return !!this.sharFindHold(s, 0, this.sharHomeX(s, 0), this.sharHomeY(s, 0, false), r, v, v, 0, SHAR_ON_LEFT)
      && !!this.sharFindHold(s, 2, this.sharHomeX(s, 2), this.sharHomeY(s, 2, false), r, v, v, 0, SHAR_ON_RIGHT);
  }

  // Опора для шага ноги k по ходу (mx, my) на lead клеток вперёд её места
  // (см. sharFindHold): на полу — узко по столбцам, стена дороже; в шахте —
  // шире и стены не дороже.
  sharStepHold(s, k, mx, my, floor, lead, shift = 0) {
    const tx = this.sharHomeX(s, k) + mx * lead + shift, ty = this.sharHomeY(s, k, floor) + my * lead;
    return floor
      ? this.sharFindHold(s, k, tx, ty, SHAR_SEEK_X, SHAR_SEEK_UP, SHAR_SEEK_DOWN, SHAR_WALL_COST)
      : this.sharFindHold(s, k, tx, ty, SHAR_SEEK_SHAFT_X, SHAR_SEEK_SHAFT, SHAR_SEEK_SHAFT, 0);
  }

  // Начать шаг: висящая нога — встать; иначе самая отставшая по ходу (mx,
  // my), если отстала на SHAR_STEP_LAG и две другие удержат тело; стоит на
  // месте — подтянуть сбившуюся к своему месту. Шагать некуда — нога ждёт.
  sharStartStep(s, mx, my, floor) {
    let best = -1, bestLag = 0, stuck = -1, shift = 0;
    for (let k = 0; k < 3 && best < 0; k++) if (!s.legs[k].on && !s.legs[k].gone) best = k;
    if (best < 0) {
      for (let k = 0; k < 3; k++) {
        const leg = s.legs[k];
        if (leg.gone) continue;
        const ox = this.sharHomeX(s, k) - leg.x, oy = this.sharHomeY(s, k, floor) - leg.y;
        let lag = mx || my ? ox * mx + oy * my : (floor ? Math.abs(ox) : 0);
        // Следующий ход тела растянул бы ногу сверх длины — она тоже
        // отстала (на склоне задняя нога упиралась в длину раньше, чем
        // отставала на SHAR_STEP_LAG, и тело вставало).
        if ((mx || my) && this.sharLegLen(s, k, leg.x - mx, leg.y - my, leg.n) > SHAR_LEG_MAX) lag = Math.max(lag, SHAR_STEP_LAG + SHAR_REACH);
        // На полу ступня на стене (зацепилась в прыжке) переходит на пол, если
        // он рядом: иначе она держала тело на весу и не давала ему опуститься.
        if (floor && leg.n !== SHAR_ON_FLOOR) lag = Math.max(lag, SHAR_STEP_LAG + SHAR_REACH);
        if (lag < (mx || my ? SHAR_STEP_LAG : 2)) continue;
        if (!this.sharHeld(s, k)) { stuck = k; continue; }
        // Равные — задняя нога первой (у правого хода задняя — левая).
        if (lag > bestLag || (lag === bestLag && mx < 0)) { best = k; bestLag = lag; }
      }
      // В шахте отставшую ногу не поднять: средняя стоит на той же стене,
      // что и третья, и тело повисло бы на одной стене. Средняя
      // переступает на стену отставшей — потом шагнёт и та.
      if (best < 0 && stuck >= 0 && stuck !== 1 && !floor && !s.legs[1].gone && this.sharHeld(s, 1) && s.legs[1].n !== s.legs[stuck].n) {
        best = 1; shift = stuck === 2 ? SHAR_STEP_LEAD : -SHAR_STEP_LEAD;
      }
      if (best < 0) return;
    }
    if (this.sharStepTo(s, best, mx, my, floor, shift, shift ? s.legs[stuck].n : -1)) return;
    // Средней некуда шагнуть по ходу — пусть переступит на стену отставшей.
    if (best === 1 && !shift && stuck >= 0 && !s.legs[1].gone && stuck !== 1 && !floor && s.legs[1].n !== s.legs[stuck].n) {
      this.sharStepTo(s, 1, mx, my, floor, stuck === 2 ? SHAR_STEP_LEAD : -SHAR_STEP_LEAD, s.legs[stuck].n);
    }
  }

  // Шаг ноги k: как можно дальше вперёд, но на опору и не сквозь стену
  // (only — только на опору этой стороны). false — шагнуть некуда.
  sharStepTo(s, k, mx, my, floor, shift, only) {
    const leg = s.legs[k];
    // Со стены на пол (см. sharStartStep) — пол ищется шире: место ступни
    // бывает внутри той самой стены.
    if (floor && leg.on && leg.n !== SHAR_ON_FLOOR && only < 0) {
      const tx = this.sharHomeX(s, k) + mx * SHAR_STEP_LEAD, ty = this.sharHomeY(s, k, true);
      const h = this.sharFindHold(s, k, tx, ty, SHAR_SEEK_SHAFT_X, SHAR_SEEK_UP, SHAR_SEEK_DOWN, 0, SHAR_ON_FLOOR);
      if (h) {
        s.sw = k; s.swT = 0;
        s.swX0 = leg.x; s.swY0 = leg.y; s.swN0 = leg.n;
        s.swX1 = h.x; s.swY1 = h.y; s.swN1 = h.n;
        leg.on = false;
        return true;
      }
    }
    for (const lead of mx || my ? [SHAR_STEP_LEAD, SHAR_STEP_LEAD >> 1, 0] : [0]) {
      const h = this.sharStepHold(s, k, mx, my, floor, lead, shift);
      if (!h || (only >= 0 && h.n !== only)) continue;
      if (leg.on && h.x === leg.x && h.y === leg.y && h.n === leg.n) return false;
      s.sw = k; s.swT = 0;
      s.swX0 = leg.x; s.swY0 = leg.y; s.swN0 = leg.n;
      s.swX1 = h.x; s.swY1 = h.y; s.swN1 = h.n;
      leg.on = false;
      return true;
    }
    return false;
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

  // Клетка тела игрока n: середина сенсора его шароида, иначе протагонист, -1
  // — нет на поле. Экран игры (js/play.js) и мультиплеер (js/net.js) смотрят
  // отсюда, а не в findProtagonist: тело игрока может быть шароидом.
  playerCell(n = 0) {
    const s = this.playerSharoid(n);
    if (s) {
      const x = Math.min(this.w - 1, Math.max(0, s.x + 5 + s.lookX + (s.face > 0 ? 1 : 0)));
      const y = Math.min(this.h - 1, Math.max(0, s.y + 5 + s.lookY));
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
    for (const s of this.sharoids) {
      if (s.id > this._sharSeq) this._sharSeq = s.id;
      // Снимки и файлы прежних версий: без приседа приземления, скорости
      // вбок, взгляда и опор на стены.
      if (s.dip === undefined) { s.dip = 0; s.dipT = 0; }
      if (s.vx === undefined) { s.vx = 0; s.fx = 0; }
      if (s.lookX === undefined) { s.lookX = s.face * SHAR_LOOK; s.lookY = 0; }
      if (s.swN0 === undefined) { s.swN0 = SHAR_ON_FLOOR; s.swN1 = SHAR_ON_FLOOR; }
      if (s.pressT === undefined) s.pressT = 0;
      for (const leg of s.legs) if (leg.n === undefined) leg.n = SHAR_ON_FLOOR;
    }
    this._sharSweep = true;
  }
}

extendSim(SimSharoid);
