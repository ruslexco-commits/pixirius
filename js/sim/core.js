'use strict';

// Ядро симуляции: класс Sim — поля мира, создание/очистка/обмен клеток,
// шаг кадра и диспетчер реакций по типу элемента.
//
// Остальные методы Sim разложены по файлам js/sim/*.js по подсистемам.
// Каждый такой файл объявляет класс-контейнер и вызывает extendSim(),
// которая переносит его методы в Sim.prototype. Для остального кода это
// обычные методы Sim: this.reactHuman(...) и т.д.

const DX4 = [1, -1, 0, 0];
const DY4 = [0, 0, 1, -1];
const DX8 = [1, -1, 0, 0, 1, 1, -1, -1];

const DY8 = [0, 0, 1, -1, 1, -1, 1, -1];

// Коды направлений для "единственной связи" OILFILM (см. reactOil/computeStability):
// 0=вверх, 1=вправо, 2=вниз, 3=влево.
const OILDIR_DX = [0, 1, 0, -1];
const OILDIR_DY = [-1, 0, 1, 0];
function oilDirCode(dx, dy) {
  for (let k = 0; k < 4; k++) if (OILDIR_DX[k] === dx && OILDIR_DY[k] === dy) return k;
  return -1;
}
function oilOppositeDir(code) { return (code + 2) % 4; }

// Переносит методы класса-контейнера в Sim.prototype. Совпадение имён —
// ошибка: без проверки метод из одного файла молча затёр бы одноимённый
// из другого.
function extendSim(part) {
  for (const name of Object.getOwnPropertyNames(part.prototype)) {
    if (name === 'constructor') continue;
    if (Object.prototype.hasOwnProperty.call(Sim.prototype, name)) {
      throw new Error(`Sim.${name} объявлен дважды (повтор в ${part.name})`);
    }
    Object.defineProperty(Sim.prototype, name, Object.getOwnPropertyDescriptor(part.prototype, name));
  }
}

// ---- поля клетки ----
//
// Всё состояние клетки, которое переживает кадр. По этому списку работают
// отмена (snapshot/restore), файл сохранения (serialize/deserialize) и
// clear(). Новое поле клетки (typed-массив на w*h) заводится в
// конструкторе и вписывается СЮДА — больше нигде перечислять его не надо.
//
// Единственное исключение — swapFields: там поля с moves: true обмениваются
// вручную, потому что это самый горячий путь симуляции (цикл по списку
// там заметно дороже). tools/check.js сверяет, что swapFields ничего не
// забыл.
//
//   name     — имя поля в Sim;
//   saveKey  — ключ в файле сохранения, если отличается от name;
//   empty    — значение пустой клетки (для clear и для старых файлов);
//   required — без этого поля файл сохранения не читается вовсе;
//   moves    — поле принадлежит частице и едет вместе с ней при движении
//              (false — привязано к месту на карте).
const PARTICLE_FIELDS = [
  { name: 'type', empty: 0, required: true, moves: true },
  { name: 'life', empty: 0, required: true, moves: true },
  { name: 'extra', empty: 0, required: true, moves: true },
  { name: 'shade', empty: 0, required: true, moves: true },
  { name: 'temp', empty: 0, moves: true },
  { name: 'moisture', empty: 0, moves: true },
  // Ключ именно sol32: формат состава сменился с Uint16/4 видов на
  // Uint32/6 видов, и старый sol прочитать как новый нельзя. Файлы
  // прошлого формата просто теряют состав (см. deserialize) — это
  // честнее, чем молча истолковать чужие биты.
  { name: 'sol', saveKey: 'sol32', empty: 0, moves: true },
  // Балка — второй слой, стоит на месте, частицы проходят сквозь неё.
  { name: 'beam', empty: 0, moves: false },
  // -1 = склад колониста ещё не выбран (0 — валидная координата).
  { name: 'colonistHomeX', empty: -1, moves: true },
  { name: 'colonistHomeY', empty: -1, moves: true },
];

class Sim {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    const n = w * h;
    this.type = new Uint8Array(n);
    this.life = new Int16Array(n);
    this.extra = new Uint8Array(n);
    this.shade = new Int8Array(n);
    this.moved = new Uint8Array(n);
    this.stability = new Int16Array(n);
    this.sideCounter = new Int16Array(n);

    // Сетка потоков воздуха — грубее основной (по airCell клеток симуляции на
    // одну клетку ветра), иначе пересчёт диффузии/затухания на полном
    // разрешении был бы заметно дороже, а визуально течения и так плавные,
    // крупномасштабные — точность на уровне одной клетки симуляции тут не нужна.
    this.airCell = 4;
    this.airW = Math.ceil(w / this.airCell);
    this.airH = Math.ceil(h / this.airCell);
    this.windVX = new Float32Array(this.airW * this.airH);
    this.windVY = new Float32Array(this.airW * this.airH);
    // Замороженный снимок ветра на начало кадра (см. step()) — то, что
    // реально читают tryWindPush/windDir через getWindVX/getWindVY. Без
    // этого разные клетки ОДНОЙ ещё целой цепочки, обработанные в разный
    // момент одного и того же кадра, видели бы РАЗНЫЕ значения: любое
    // движение (в т.ч. чужое, соседней клетки, обработанной чуть раньше в
    // этом же кадре) сразу же чуть возмущает windVX/windVY через
    // disturbWind — и клетка, до которой очередь в развёртке дошла позже,
    // читала бы уже слегка изменённый ветер, а не тот, что был в начале
    // кадра. На протяжённом объекте это накапливалось вдоль его длины и
    // рвало форму даже при общем броске _windRoll. Снимок берётся один раз
    // в step() сразу после updateWind() и не меняется до конца кадра —
    // движение по-прежнему пишет в live windVX/windVY (через disturbWind),
    // это просто повлияет на снимок уже СЛЕДУЮЩЕГО кадра.
    this.windVXFrame = new Float32Array(this.airW * this.airH);
    this.windVYFrame = new Float32Array(this.airW * this.airH);
    // Один "бросок" на весь кадр для ветро-зависимых решений (см. step()) —
    // не Math.random() отдельно на каждую клетку.
    this._windRoll = 0;

    // "Открытость" каждой клетки сетки ветра — 1 = воздух течёт свободно,
    // 0 = преграда (см. isAirtight и computeAirBlock). Клетка сетки ветра
    // грубее основной (airCell клеток симуляции на одну), но блокируется
    // целиком, если внутри есть ХОТЯ БЫ ОДНА непроницаемая клетка — иначе
    // при дробном пересчёте (доля перекрытия) обычная тонкая стена в одну
    // клетку почти не мешала бы потоку (перекрывала бы жалкую 1/16 клетки
    // сетки ветра), а стена обязана держать по-настоящему. Пересчитывается
    // каждый кадр, т.к. материалы двигаются/падают.
    this.airOpen = new Float32Array(this.airW * this.airH).fill(1);
    this._airBlocked = new Uint8Array(this.airW * this.airH);

    // Температура — своё, ПОЛНОЕ разрешение (одно число на каждую клетку
    // симуляции, как type/life/extra/shade), А НЕ грубая сетка вроде ветра.
    // Раньше была на той же грубой airW*airH сетке — и из-за этого при
    // движении частицы (swap()) её накопленное тепло оставалось лежать на
    // СТАРОЙ позиции в сетке тепла, а не переезжало вместе с частицей: для
    // жидкости вроде лавы, которая почти всегда хоть немного да течёт, это
    // означало, что она постоянно "бросала" своё тепло позади себя.
    // Теперь temp swap()ается вместе с остальными полями клетки (см. swap())
    // — тепло принадлежит клетке-частице, а не точке на карте.
    // Не нужен отдельный замороженный снимок на кадр (как windVXFrame для
    // ветра): temp только ЧИТАЕТСЯ во время покадрового обхода клеток
    // (reactMelt), ничего не пишет в него в процессе — в отличие от ветра,
    // где движение (disturbWind) само правит live-сетку прямо во время
    // обхода. updateTemp() пересчитывает всё целиком один раз в начале
    // кадра, до обхода клеток — этого достаточно.
    this.temp = new Float32Array(n);
    this._temp2 = new Float32Array(n);
    // Вес клетки для диффузии тепла (см. computeHeatWeight/updateTemp):
    // 0 = теплоизолятор (стена — настоящая преграда, полностью останавливает
    // передачу), AIR_COND (малая доля) = открытый воздух — плохой проводник
    // по сравнению с прямым контактом с веществом, 1 = любое вещество
    // (включая металл: он блокирует ВОЗДУХ через isAirtight, но обязан
    // проводить/принимать тепло, иначе никогда не смог бы нагреться выше 0
    // и расплавиться). В отличие от ветра, здесь не нужна отдельная
    // агрегация по грубому блоку — вес клетки определяется только ЕЮ САМОЙ,
    // поэтому считается заново, но простым прямым проходом, без блоков.
    this.heatWeight = new Float32Array(n).fill(1);

    // Кэш "ветер на всю связную компоненту" для осыпавшихся структурных
    // обломков — см. computeDebrisWindChance(). Даже с заморозкой снимка
    // ветра на кадр, у ДОСТАТОЧНО ПРОТЯЖЁННОГО куска за много кадров
    // накапливается настоящий (не шумовой) перепад силы ветра вдоль его
    // длины — и клетки на разных концах, каждая честно читая свою точку,
    // могут в одном кадре прийти к разным решениям "толкает/не толкает",
    // разрывая форму. Одно общее значение на всю компоненту убирает саму
    // возможность разногласия.
    this._debrisWindVX = new Float32Array(n);
    this._debrisVisited = new Uint8Array(n);

    // Кэш "есть ли у этой жидкости вообще путь наружу" — см.
    // computeLiquidEscape()/attemptSwapOrMove(). 1 = связная область той же
    // жидкости (напрямую или через цепочку соседей того же типа) где-то
    // касается хотя бы одной пустой клетки, 0 = карман запечатан со всех
    // сторон целиком.
    this._liquidEscape = new Uint8Array(n);
    this._liquidVisited = new Uint8Array(n);

    // Рабочие буферы displaceLiquidThroughBody() (BFS по связной луже при
    // вытеснении тонущим объектом). _dispVisited хранит НОМЕР ПОКОЛЕНИЯ
    // (_dispGen) последнего поиска, который заходил в клетку, а не 0/1 —
    // чтобы не обнулять массив размером с поле перед каждым из десятков
    // поисков за кадр (поиск запускается на каждую вытесняемую клетку).
    // _dispParent — откуда BFS пришёл в клетку (для сдвига по найденному
    // пути), _dispQueue — очередь BFS фиксированного размера.
    this._dispVisited = new Uint32Array(n);
    this._dispParent = new Int32Array(n);
    this._dispDist = new Int32Array(n);
    this._dispQueue = new Int32Array(n);
    this._dispGen = 0;

    // Запас впитанной воды у ЗЕМЛИ/МОКРОЙ ЗЕМЛИ (0..3, см. tickMoisture) —
    // отдельное поле, а не перегрузка extra/life: обеим нужен независимый
    // от типа клетки счётчик, который переживает переход земля<->мокрая
    // земля (spawn() его не трогает и не обнуляет, в отличие от extra/life).
    this.moisture = new Uint8Array(n);
    // Состав клетки (см. блок "состав" в data/composition.js) — 10 долей, по 4
    // бита на каждый из шести видов, включая пустоту. Есть у ЛЮБОЙ клетки
    // семейства долей, а не только у смесей: клетка воды тоже может быть
    // неполной (часть долей — пустота), и именно это делает жидкость
    // стягивающейся к целым клеткам (см. tickCompaction).
    this.sol = new Uint32Array(n);
    // Общая скорость течения времени — 100 = обычная (см. ползунок
    // "Течение времени" во вкладке "Разное"). Сама Sim о ней ничего не
    // знает: она читается СНАРУЖИ, в игровом цикле main.js, который решает,
    // сколько раз вызвать step() на один кадр отрисовки. Это разом ускоряет/
    // замедляет буквально всё внутри step() — падение, растекание жидкостей,
    // диффузию тепла и ветра, тик влажности земли и т.д. — единым способом,
    // а не отдельной подстройкой каждой механики по отдельности.
    this.timeScale = 100;

    // Точка, которую КОЛОНИСТ сам выбрал складом на текущую ходку копания
    // (см. reactColonist) — ровно там, где он стоял, начиная копать: всегда
    // открытое место, раз он там стоял. Отдельные поля, а не перегрузка
    // life/extra (те уже заняты грузом и его материалом одновременно).
    // -1 = "склад ещё не выбран" — координата 0 сама по себе валидна
    // (крайняя левая клетка карты), поэтому нужен именно отдельный
    // недостижимый признак, а не значение по умолчанию typed-массива.
    this.colonistHomeX = new Int16Array(n).fill(-1);
    this.colonistHomeY = new Int16Array(n).fill(-1);

    // Личная память каждого человека: ключ — его номер (life[i], едет
    // вместе с клеткой при движении), значение — запретные клетки,
    // текущее направление и счётчик воды над головой. Держать это в полях
    // на клетку не выйдет: запретов у человека много, а полей на клетку
    // ровно одно значение.
    this._humans = new Map();
    this._humanSeq = 0;

    // ВТОРОЙ СЛОЙ: балки. Балки нет в this.type вовсе — она лежит здесь,
    // отдельно, и взаимодействует только с твёрдыми телами (держит их в
    // расчёте устойчивости, см. stabId). Для жидкостей, газов, сыпучего и
    // людей её попросту не существует: они ходят по клетке с балкой так
    // же, как по пустой, и ни одна строчка их кода о балке не знает.
    //
    // Раньше балка лежала в общем массиве веществ, и «проходимость»
    // изображалась подменой цели движения — частица телепортировалась
    // сквозь неё на первую свободную клетку. Это и было тем, что не
    // устраивало: на жидкость такой перескок влиял (менял, куда она
    // попадёт), да и перескоком он оставался.
    //
    // Значение — маска направлений (биты по индексам DX4), где на момент
    // установки стояла опора; 0 означает «балки здесь нет». Балку без
    // единой опоры ставить некуда — она сразу становится обычным камнем
    // (см. placeBeam), поэтому ноль никогда не бывает валидной маской.
    this.beam = new Uint8Array(n);

    this.paused = false;
    this.frame = 0;
  }

  idx(x, y) { return y * this.w + x; }

  inBounds(x, y) { return x >= 0 && x < this.w && y >= 0 && y < this.h; }

  airIdx(x, y) {
    const ax = Math.min(this.airW - 1, (x / this.airCell) | 0);
    const ay = Math.min(this.airH - 1, (y / this.airCell) | 0);
    return ay * this.airW + ax;
  }

  clearCell(i) {
    this.type[i] = EL.EMPTY;
    this.life[i] = 0;
    this.extra[i] = 0;
    this.shade[i] = 0;
    this.sol[i] = 0;
  }

  // seedHeat=false — используется РОВНО одним вызывающим (reactMelt): когда
  // материал плавится, он и так уже минимум на своём meltPoint (иначе бы
  // не расплавился) — реальная физика не требует, чтобы свежий расплав
  // ВНЕЗАПНО подскакивал до полного heatSource лавы (600). Если бы каждое
  // плавление заново поднимало клетку до heatSource, получалась бы
  // самоподдерживающаяся цепная реакция: одна клетка лавы плавит соседа,
  // тот СРАЗУ становится ПОЛНОЦЕННЫМ источником тепла 600 градусов и
  // плавит следующего, тот — следующего, и так далее без затухания —
  // засеянная одним пикселем лава на практике успевала на пике расплавить
  // едва ли не половину любого связного массива камня, прежде чем волна
  // остывала. Расплав вместо этого просто СОХРАНЯЕТ ту температуру, что у
  // него уже была на момент плавления, и дальше остывает как обычно.
  spawn(i, id, seedHeat = true) {
    this.type[i] = id;
    this.shade[i] = (Math.random() * 30 - 15) | 0;
    this.extra[i] = 0;
    // Состав принадлежит той частице, что была здесь раньше, — новая о нём
    // знать не должна (та же причина, по которой обнуляется extra). Свежая
    // частица из таблицы элементов всегда ПОЛНАЯ и чистая: 10 долей своего
    // вещества, без пустоты. Смеси (EL.SOLUTION/EL.VAPOR) через spawn не
    // создаются вовсе — только через setComposition, которому состав уже
    // известен, поэтому их здесь нет и затирать нечего.
    this.sol[i] = PURE_COMP_BY_ELEMENT[id] || 0;
    switch (id) {
      // Ни у кислоты, ни у пара, ни у кислотного газа нет срока жизни в
      // кадрах. Кислота расходуется долями состава (см. dissolveInto), а
      // газы ЖДУТ условий: каждый выпадает, когда остынет ниже своей
      // точки кипения (tickPhase). Срок жизни остался ровно у одного
      // газа — масляного, и задаётся он при выделении (dissolveInto).
      case EL.SMOKE: this.life[i] = 50 + (Math.random() * 40 | 0); break;
      case EL.FIRE: this.life[i] = 18 + (Math.random() * 14 | 0); break;
      default: this.life[i] = 0;
    }
    // Источники тепла (FIRE/LAVA), появляющиеся НЕ из плавления (покраска
    // игроком, вспышка от огня/лавы, взрыв пороха) засевают СВОЮ клетку
    // ОДИН РАЗ, в момент появления — max(), а не "+=", чтобы повторный
    // spawn в уже горячей области не разгонял температуру выше heatSource.
    // Дальше это тепло живёт по общим правилам updateTemp() — диффундирует
    // и остывает само, никто больше не подпитывает его насильно каждый
    // кадр (см. комментарий в updateTemp про прежний баг с термостатом), и
    // переезжает вместе с клеткой при движении (см. swap()).
    const el = ELEMENTS[id];
    // Свежая частица приносит СВОЮ температуру, прибавляя её к температуре
    // места, а не принимая температуру фона целиком. Раньше нарисованный в
    // раскалённой зоне лёд оказывался сразу раскалённым, а вылитая туда же
    // вода — кипящей, хотя ни лёд, ни вода своего холода никуда не девали.
    // Знак берётся сам собой: у обычных веществ комнатные +20, у льда и
    // замёрзших жидкостей — минус, так что место остывает.
    // Источники тепла (лава, огонь) и газы сюда не попадают: у первых свой
    // heatSource ниже, у вторых — gasSpawnTemp.
    if (el && !el.heatSource && el.cat !== CAT.GAS) {
      this.temp[i] += (el.baseTemp !== undefined) ? el.baseTemp : DEFAULT_BASE_TEMP;
    }
    if (seedHeat && el && el.heatSource && this.temp[i] < el.heatSource) this.temp[i] = el.heatSource;
    // Пар не бывает холоднее точки кипения в момент появления — иначе пар
    // из воды, вскипевшей от касания лавы (сама вода при этом могла быть
    // ещё холодной), тут же начал бы конденсироваться обратно (tickPhase).
    // Дальше остывает по общим правилам updateTemp.
    // Свежий газ рождается с запасом над своей точкой кипения (см.
    // gasSpawnTemp): ровно на границе он сконденсировался бы обратно в
    // первые же кадры, не успев подняться. Касается и пара от лавы, и
    // кислотного газа.
    if (id === EL.STEAM) {
      const want = this.gasSpawnTemp(P_WATER);
      if (this.temp[i] < want) this.temp[i] = want;
    } else if (id === EL.ACID_GAS) {
      const want = this.gasSpawnTemp(P_ACID);
      if (this.temp[i] < want) this.temp[i] = want;
    }
    // Кислотный остаток появляется первого уровня (см. reactAcidResidue).
    if (id === EL.ACID_RESIDUE) this.extra[i] = 1;
    // Человек получает личный номер и заводит себе память.
    if (id === EL.HUMAN) {
      this.life[i] = ++this._humanSeq;
      this.extra[i] = 0;
      this._humans.set(this.life[i], { bans: new Set(), banOrder: [], dir: Math.random() < 0.5 ? 1 : -1, wet: 0, flee: 0 });
    }
    // Окисел без явно заданной стадии — первой (см. setOxideStage), а
    // рыхлый окисел — сразу последней в своей линейке.
    if (id === EL.OXIDE || id === EL.METAL_OXIDE) this.extra[i] = 1;
    else if (id === EL.OXIDE_LOOSE) this.extra[i] = OXIDE_LINE[EL.OXIDE_LOOSE].maxStage;
    else if (id === EL.METAL_OXIDE_LOOSE) this.extra[i] = OXIDE_LINE[EL.METAL_OXIDE_LOOSE].maxStage;
  }

  clear() {
    for (const f of PARTICLE_FIELDS) this[f.name].fill(f.empty);
    this.moved.fill(0);
    this.windVX.fill(0);
    this.windVY.fill(0);
    // Снимок ветра на кадр и кэш ветра для обломков — тоже часть потоков.
    // Без них "Очистить" на паузе оставляло на экране прежние течения: сам
    // windVX обнулялся, но читают-то все getWindVX/getWindVY, а те смотрят
    // в снимок, который обновляется только в step() — то есть никогда,
    // пока стоит пауза.
    this.windVXFrame.fill(0);
    this.windVYFrame.fill(0);
    this._debrisWindVX.fill(0);
    this._windRoll = 1;
    this._humans.clear();
  }

  // Единая точка входа для ВСЕГО движения частиц: обмен содержимым двух
  // клеток + возмущение ветра в направлении движения (см. disturbWind).
  swap(i, j) {
    this.swapFields(i, j);
    this.disturbWind(i, j);
  }

  // Чистый обмен всех полей клетки-частицы БЕЗ побочного эффекта на ветер.
  // Напрямую (мимо swap) зовётся только там, где одно логическое движение
  // складывается из цепочки обменов (displaceLiquidThroughBody): для ветра
  // это одно перемещение, а не десятки, и возмущать его нужно один раз.
  //
  // Обязан обменивать ВСЕ поля PARTICLE_FIELDS с moves: true (проверяет
  // tools/check.js) плюс покадровый кэш _liquidEscape.
  swapFields(i, j) {
    let t = this.type[i]; this.type[i] = this.type[j]; this.type[j] = t;
    t = this.life[i]; this.life[i] = this.life[j]; this.life[j] = t;
    t = this.extra[i]; this.extra[i] = this.extra[j]; this.extra[j] = t;
    t = this.shade[i]; this.shade[i] = this.shade[j]; this.shade[j] = t;
    // Температура тоже часть клетки-частицы, а не точки на карте — двигаясь,
    // частица уносит своё тепло с собой (см. комментарий в конструкторе про
    // temp). Именно это раньше отсутствовало: temp жила на отдельной сетке,
    // привязанной к позиции, и текущая/падающая лава просто оставляла своё
    // тепло на месте, вместо того чтобы нести его с собой.
    t = this.temp[i]; this.temp[i] = this.temp[j]; this.temp[j] = t;
    // Влажность земли/мокрой земли — та же логика, что и у temp чуть выше:
    // это тоже часть клетки-частицы (сколько воды впитано именно в ЭТУ
    // землю), а не точки на карте. Без этого падающая мокрая земля роняла
    // бы свою влажность на месте при каждом свопе и высыхала бы "сама по
    // себе" почти мгновенно на первом же тике после падения, хотя реально
    // влагу никуда не теряла — просто клетка сдвинулась, а число осталось.
    t = this.moisture[i]; this.moisture[i] = this.moisture[j]; this.moisture[j] = t;
    // Та же логика ещё раз, для точки склада колониста — иначе колонист,
    // двигаясь (а он двигается практически каждый кадр), забывал бы, куда
    // именно несёт груз, при первом же шаге.
    t = this.colonistHomeX[i]; this.colonistHomeX[i] = this.colonistHomeX[j]; this.colonistHomeX[j] = t;
    t = this.colonistHomeY[i]; this.colonistHomeY[i] = this.colonistHomeY[j]; this.colonistHomeY[j] = t;
    // Флаг "у моей лужи есть выход" (см. computeLiquidEscape) считается один
    // раз в начале кадра ПО ПОЗИЦИЯМ, но смысл у него — свойство частицы
    // жидкости ("моя компонента куда-то выходит"), и оно не меняется от
    // того, что частица сдвинулась на клетку. Без переноса вода, въехавшая
    // в течение кадра в клетку, которая в начале кадра была камнем или
    // пустотой, читала бы там чужой, устаревший флаг (обычно 0) — и
    // тонущее тело над ней на этот кадр застывало (sinkIntoLiquid ->
    // false), а на следующий, после пересчёта, снова тонуло. Именно так
    // блок камня, входя в воду, "расслаивался": разные ряды тонули в
    // разные кадры и между ними вклинивалась вода.
    t = this._liquidEscape[i]; this._liquidEscape[i] = this._liquidEscape[j]; this._liquidEscape[j] = t;
    // Состав раствора — тоже свойство частицы, а не точки (как temp).
    t = this.sol[i]; this.sol[i] = this.sol[j]; this.sol[j] = t;
  }

  step() {
    if (this.paused) return;
    this.frame++;
    this.moved.fill(0);
    this.computeStability();
    this.updateBeams();
    this.updateWind();
    this.updateTemp();
    this.windVXFrame.set(this.windVX);
    this.windVYFrame.set(this.windVY);
    // Один общий "бросок" на весь кадр для ветро-зависимых решений (см.
    // tryWindPush/windDir) — если бы каждая клетка бросала свой Math.random()
    // независимо, разные клетки ОДНОГО цельного куска (например, прямой
    // палки) толкались бы ветром в разные, случайно несовпадающие моменты и
    // расходились бы в стороны, превращая падающее тело в облако пыли вместо
    // того, чтобы просто отнести его целиком. Общий бросок на кадр даёт
    // клеткам с одинаковым (или близким) локальным ветром одинаковый ответ
    // "да/нет" в этом кадре — форма не рвётся, а долгосрочная частота
    // срабатывания (в среднем по многим кадрам) остаётся той же chance, что
    // и раньше, просто не независимой по каждой клетке.
    this._windRoll = Math.random();
    this.computeDebrisWindChance();
    this.computeLiquidEscape();
    const w = this.w, h = this.h;
    const ltr = (this.frame & 1) === 0;
    for (let y = h - 1; y >= 0; y--) {
      if (ltr) {
        for (let x = 0; x < w; x++) this.updateCell(x, y);
      } else {
        for (let x = w - 1; x >= 0; x--) this.updateCell(x, y);
      }
    }
  }

  updateCell(x, y) {
    const i = this.idx(x, y);
    if (this.moved[i]) return;
    const id = this.type[i];
    if (id === EL.EMPTY) return;

    this.react(x, y, i, id);

    const id2 = this.type[i];
    if (id2 === EL.EMPTY || this.moved[i]) return;
    const el2 = ELEMENTS[id2];
    // windScale=0 у обычного сыпучего (песок и т.п.) — оно и так тяжёлое и
    // осознанно оставлено ветром не сносимым (см. updatePowder).
    if (el2.cat === CAT.POWDER) this.updatePowder(x, y, i, el2, 0.05);
    else if (el2.cat === CAT.LIQUID) this.updateLiquid(x, y, i, el2);
    else if (el2.cat === CAT.GAS) this.updateGas(x, y, i, el2);
    else if (id2 === EL.FIRE) this.updateFireMovement(x, y, i);
    // Структурная клетка, вышедшая за бюджет устойчивости (stability===0),
    // больше не держится за соседей — она в буквальном смысле рассыпалась,
    // и дальше падает точно так же, как сыпучий материал (вниз, а если
    // прямо под ней занято — по диагонали в сторону): та же updatePowder,
    // с той же плотностью материала для сравнения при вытеснении жидкостей.
    // В отличие от обычного песка, ветер ЗАМЕТНО меняет её траекторию
    // падения (windScale>0) — обломки лёгкие и рыхлые в сравнении с целым,
    // ещё держащимся телом.
    else if (isStructural(id2) && this.stability[i] === 0) this.updatePowder(x, y, i, el2, 0.12);
  }

  react(x, y, i, id) {
    switch (id) {
      case EL.WOOD: this.reactFlammable(x, y, i, id); break;
      case EL.OIL: this.tickComposition(x, y, i); if (this.type[i] === EL.OIL) this.reactOil(x, y, i); break;
      case EL.OILFILM: this.reactFlammable(x, y, i, id); break;
      case EL.GUNP: this.reactFlammable(x, y, i, id); break;
      case EL.FIRE: this.reactFire(x, y, i); break;
      case EL.LAVA: this.reactLava(x, y, i); break;
      case EL.ICE: this.tickPhase(x, y, i); if (this.type[i] === EL.ICE) this.reactIce(x, y, i); break;
      case EL.ACID_ICE: case EL.REAGENT_ICE: this.tickPhase(x, y, i); break;
      case EL.ACID: case EL.SOLUTION: case EL.REAGENT: this.reactSolutionLike(x, y, i); break;
      case EL.ACID_RESIDUE: this.reactAcidResidue(x, y, i); break;
      case EL.OXIDE: case EL.OXIDE_LOOSE: this.reactOxide(x, y, i); break;
      case EL.ACID_GAS: case EL.STEAM: case EL.VAPOR: this.reactVapor(x, y, i); break;
      case EL.SMOKE: this.reactSmoke(x, y, i); break;
      case EL.SAND: this.reactSand(x, y, i); break;
      case EL.SALT: this.reactSalt(x, y, i); break;
      case EL.WATER: this.reactWater(x, y, i); break;
      case EL.VOID: this.reactVoid(x, y, i); break;
      case EL.CLONE: this.reactClone(x, y, i); break;
      case EL.STONE: case EL.METAL: case EL.GLASS: this.reactMelt(x, y, i, id); break;
      case EL.EARTH: this.tickMoisture(x, y, i, EL.EARTH); break;
      case EL.WET_EARTH:
        this.tickMoisture(x, y, i, EL.WET_EARTH);
        this.tryEvaporateMoisture(x, y, i);
        break;
      case EL.COLONIST: this.reactColonist(x, y, i); break;
      case EL.HUMAN: this.reactHuman(x, y, i); break;
    }
  }
}
