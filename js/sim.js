'use strict';

const DX4 = [1, -1, 0, 0];
const DY4 = [0, 0, 1, -1];
const DX8 = [1, -1, 0, 0, 1, 1, -1, -1];
const DY8 = [0, 0, 1, -1, 1, -1, 1, -1];

// Масштаб бокового счётчика в computeStability(): позволяет угловым клеткам
// стоить вдвое дешевле обычного шага, оставаясь при этом целыми числами.
const STEP_UNIT = 2;

// Коды направлений для "единственной связи" OILFILM (см. reactOil/computeStability):
// 0=вверх, 1=вправо, 2=вниз, 3=влево.
const OILDIR_DX = [0, 1, 0, -1];
const OILDIR_DY = [-1, 0, 1, 0];
function oilDirCode(dx, dy) {
  for (let k = 0; k < 4; k++) if (OILDIR_DX[k] === dx && OILDIR_DY[k] === dy) return k;
  return -1;
}
function oilOppositeDir(code) { return (code + 2) % 4; }

function bufToB64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function b64ToBuf(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

class Sim {
  // Во сколько раз окружающее пространство (воздух и остывание "в никуда")
  // забирает тепло у ВЕЩЕСТВА медленнее, чем в исходной калибровке. Одна
  // константа на оба канала утечки тепла — см. computeHeatWeight (AIR_COND)
  // и updateTemp (DECAY_MATTER). Само остывание воздуха (DECAY_AIR) и
  // обмен воздух-воздух (AIR_AIR_RATE) этот множитель НЕ трогает.
  static ENV_SLOWDOWN = 20;

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
    // Состав раствора (см. блок "раствор" в elements.js) — 10 долей, по 4
    // бита на каждый из четырёх видов. Осмысленно только у EL.SOLUTION;
    // чистые вода/кислота/реагент его не читают (liquidParts).
    this.sol = new Uint16Array(n);
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
    // Состав раствора принадлежит той частице, что была здесь раньше, —
    // новая о нём знать не должна (та же причина, по которой обнуляется
    // extra). Смена состава без смены частицы идёт мимо spawn, через
    // setLiquidComposition, так что здесь обнулять безопасно.
    this.sol[i] = 0;
    switch (id) {
      // Кислота больше не имеет "жизни" в кадрах — её ресурс это доли
      // кислоты в составе раствора (см. elements.js, блок "раствор").
      // Пар: раньше жил 90-150 кадров и вдобавок каждый кадр с шансом 1%
      // конденсировался — в среднем ~70 кадров, т.е. в поле высотой в
      // сотни клеток он выпадал дождём, не долетев и до середины. Теперь
      // 15-30 с (900-1800 кадров): успевает подняться к потолку, собраться
      // там в облако и лишь потом, по одной клетке в разное время,
      // выпасть обратно (см. reactSteam — плюс конденсация от холода).
      case EL.STEAM: this.life[i] = 900 + (Math.random() * 900 | 0); break;
      case EL.ACID_GAS: this.life[i] = 300 + (Math.random() * 300 | 0); break;
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
    if (seedHeat && el && el.heatSource && this.temp[i] < el.heatSource) this.temp[i] = el.heatSource;
    // Пар не бывает холоднее точки кипения в момент появления — иначе пар
    // из воды, вскипевшей от касания лавы (сама вода при этом могла быть
    // ещё холодной), тут же сконденсировался бы обратно по холоду (см.
    // reactSteam). Дальше остывает по общим правилам updateTemp.
    if (id === EL.STEAM) {
      const bp = ELEMENTS[EL.WATER].boilPoint;
      if (this.temp[i] < bp) this.temp[i] = bp;
    }
    // Кислотный остаток появляется первого уровня (см. reactAcidResidue).
    if (id === EL.ACID_RESIDUE) this.extra[i] = 1;
    // Балка запоминает связь с опорой РОВНО в момент появления, а не позже
    // (см. reactBeam) — битовая маска направлений (по индексам DX4/DY4:
    // 1=вправо, 2=влево, 4=вниз, 8=вверх), где на момент спавна стоял
    // структурный материал или якорь. Если тогда рядом не было НИ ОДНОГО
    // такого соседа — связи не было и не будет: reactBeam увидит mask===0
    // и сразу превратит клетку в обычный камень.
    if (id === EL.BEAM) {
      const w = this.w, x = i % w, y = (i / w) | 0;
      let mask = 0;
      for (let k = 0; k < 4; k++) {
        const nx = x + DX4[k], ny = y + DY4[k];
        if (!this.inBounds(nx, ny)) continue;
        const nt = this.type[this.idx(nx, ny)];
        if (isStructural(nt) || isAnchor(nt)) mask |= (1 << k);
      }
      this.extra[i] = mask;
    }
  }

  clear() {
    this.type.fill(0);
    this.life.fill(0);
    this.extra.fill(0);
    this.shade.fill(0);
    this.moved.fill(0);
    this.windVX.fill(0);
    this.windVY.fill(0);
    this.temp.fill(0);
    this.moisture.fill(0);
    this.sol.fill(0);
    this.colonistHomeX.fill(-1);
    this.colonistHomeY.fill(-1);
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

  // Любое реальное перемещение частицы (через swap — единая точка входа для
  // ВСЕГО движения в симуляции) слегка возмущает воздух в направлении этого
  // движения. Течения тем самым естественно возникают из самой обычной
  // физики — падающего песка, текущей воды, поднимающегося пара — а не
  // только от явных источников вроде вентилятора.
  disturbWind(i, j) {
    const w = this.w;
    const xi = i % w, yi = (i / w) | 0;
    const xj = j % w, yj = (j / w) | 0;
    const dx = xj - xi, dy = yj - yi;
    if (dx === 0 && dy === 0) return;
    const ai = this.airIdx(xi, yi);
    const DISTURB = 0.03;
    this.windVX[ai] += dx * DISTURB;
    this.windVY[ai] += dy * DISTURB;
  }

  // ---- игровой цикл ----

  step() {
    if (this.paused) return;
    this.frame++;
    this.moved.fill(0);
    this.computeStability();
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
    if (el2.cat === CAT.POWDER) this.updatePowder(x, y, i, el2, 0);
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
    else if (isStructural(id2) && this.stability[i] === 0) this.updatePowder(x, y, i, el2, 0.06);
  }

  // ---- структурная устойчивость твёрдых тел ----

  // У каждого структурного материала своя maxStability (значение, которое
  // получает клетка, касающаяся низа поля или якоря — стена/пустота/клонер)
  // и toughness = X (через сколько клеток БОКОВОГО пути стабильность падает
  // на 1). По вертикали (вверх ИЛИ вниз) стабильность передаётся соседу
  // целиком, бесплатно, без всякого счётчика — столб, просто стоящий друг
  // на друге (или свисающий по прямой вниз от опоры), в реальности держится
  // собственным весом и сцеплением, и его высота сама по себе никак его не
  // ослабляет. Бюджет (toughness) расходуется только на боковой, консольный
  // вылет — именно там материалу физически не на что опереться напрямую.
  // Боковой счётчик при движении по вертикали не сбрасывается и не растёт —
  // просто переносится как есть, так что боковой вылет, начатый с любой
  // высоты столба, получает полный горизонтальный бюджет с нуля.
  // X берётся из материала ПРИНИМАЮЩЕЙ клетки (не источника).
  // Угловые/стыковые клетки (подпёртые сразу с двух сторон, не только
  // оттуда, откуда идёт распространение) держатся крепче прямого участка —
  // боковой шаг туда стоит вдвое дешевле (см. hasOtherStableNeighbor и
  // STEP_UNIT).
  computeStability() {
    const w = this.w, h = this.h, n = w * h;
    const stab = this.stability;
    const sideC = this.sideCounter;
    stab.fill(0);
    sideC.fill(0);

    const maxLevel = 64;
    const buckets = this._stabBuckets || (this._stabBuckets = Array.from({ length: maxLevel + 1 }, () => []));
    for (let lvl = 0; lvl <= maxLevel; lvl++) buckets[lvl].length = 0;

    const seed = (i, id) => {
      const s = Math.min(ELEMENTS[id].maxStability || 0, maxLevel);
      if (s > stab[i]) { stab[i] = s; sideC[i] = 0; buckets[s].push(i); }
    };
    for (let x = 0; x < w; x++) {
      const i = this.idx(x, h - 1);
      if (isStructural(this.type[i])) seed(i, this.type[i]);
    }
    for (let i = 0; i < n; i++) {
      if (!isAnchor(this.type[i])) continue;
      const x = i % w, y = (i / w) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = x + DX4[k], ny = y + DY4[k];
        if (!this.inBounds(nx, ny)) continue;
        const ni = this.idx(nx, ny);
        if (isStructural(this.type[ni])) seed(ni, this.type[ni]);
      }
    }

    const steps = [[0, -1], [0, 1], [1, 0], [-1, 0]];
    for (let level = maxLevel; level >= 1; level--) {
      const bucket = buckets[level];
      for (let bi = 0; bi < bucket.length; bi++) {
        const i = bucket[bi];
        if (stab[i] !== level) continue; // устарело — клетку с тех пор улучшили
        const x = i % w, y = (i / w) | 0;
        // Застывшее масло — тупик: получает устойчивость от своей единственной
        // связи (проверка ниже, при рассмотрении его как соседа), но само
        // никому её не передаёт — иначе стало бы мостом между двумя объектами.
        if (this.type[i] === EL.OILFILM) continue;
        for (const [dx, dy] of steps) {
          const nx = x + dx, ny = y + dy;
          if (!this.inBounds(nx, ny)) continue;
          const ni = this.idx(nx, ny);
          const nid = this.type[ni];
          if (!isStructural(nid)) continue;
          if (nid === EL.OILFILM && this.extra[ni] !== oilOppositeDir(oilDirCode(dx, dy))) continue;
          let newStab, newSideC;
          if (dx === 0) {
            newStab = stab[i];
            newSideC = sideC[i];
          } else {
            const X = ELEMENTS[nid].toughness || 1;
            // Угол/стык (клетка того же материала, подпёртая ещё и с ДРУГОЙ
            // стороны, не только оттуда, откуда пришло это распространение)
            // держится крепче прямого участка — вдвое дешевле по счётчику.
            // Реализовано через масштаб x2: обычный шаг стоит 2 "юнита",
            // угловой — 1, а порог смещён на X*2, так что на прямом участке
            // счёт идёт ровно так же, как и раньше (X шагов на -1), а
            // угловые шаги считаются за половину.
            const corner = this.hasOtherStableNeighbor(nx, ny, dx, dy, nid);
            newSideC = sideC[i] + (corner ? 1 : STEP_UNIT);
            const threshold = X * STEP_UNIT;
            if (newSideC >= threshold) { newStab = stab[i] - 1; newSideC = 0; } else newStab = stab[i];
          }
          if (newStab > stab[ni]) {
            stab[ni] = newStab; sideC[ni] = newSideC;
            if (newStab >= 1) buckets[Math.min(newStab, maxLevel)].push(ni);
          }
        }
      }
    }
  }

  // Есть ли у клетки (x,y) ещё один уже устойчивый (stability>0) сосед того
  // же материала, помимо того, откуда пришло текущее распространение
  // (fromDx,fromDy — направление ИЗ источника В эту клетку)? Если да — это
  // геометрический угол/стык (подпёрта сразу с двух сторон), а не середина
  // прямого участка.
  hasOtherStableNeighbor(x, y, fromDx, fromDy, matchType) {
    for (let k = 0; k < 4; k++) {
      const ddx = DX4[k], ddy = DY4[k];
      if (ddx === -fromDx && ddy === -fromDy) continue; // это как раз тот сосед, откуда мы пришли
      const nx = x + ddx, ny = y + ddy;
      if (!this.inBounds(nx, ny)) continue;
      const ni = this.idx(nx, ny);
      if (this.type[ni] === matchType && this.stability[ni] > 0) return true;
    }
    return false;
  }

  // ---- потоки воздуха ----

  // Раз в кадр, ДО того как хоть одна клетка успела сдвинуться: для каждой
  // ещё не рассмотренной клетки осыпавшегося структурного материала
  // (isStructural && stability===0) находит её связную (4-соседство, тот
  // же материал) компоненту целиком и запоминает ОДНО общее значение силы
  // ветра для всех её клеток — сэмплированное из уже замороженного на этот
  // кадр снимка (getWindVX) в ОДНОЙ фиксированной точке компоненты. tryWindPush
  // читает именно этот кэш для таких клеток (см. ниже), поэтому любая клетка
  // ещё не разорванной цепочки в этом кадре видит один и тот же ветер и
  // приходит к тому же решению "толкает/не толкает" — само разногласие
  // становится невозможным, а не просто маловероятным.
  computeDebrisWindChance() {
    const w = this.w, n = w * this.h;
    const visited = this._debrisVisited;
    visited.fill(0);
    const cache = this._debrisWindVX;
    const stab = this.stability;
    const stack = this._debrisStack || (this._debrisStack = []);
    for (let i = 0; i < n; i++) {
      if (visited[i]) continue;
      visited[i] = 1;
      const t = this.type[i];
      if (!isStructural(t) || stab[i] !== 0) continue;
      const wind = this.getWindVX(i % w, (i / w) | 0);
      stack.length = 0;
      stack.push(i);
      cache[i] = wind;
      while (stack.length) {
        const ci = stack.pop();
        const cx = ci % w, cy = (ci / w) | 0;
        for (let k = 0; k < 4; k++) {
          const nx = cx + DX4[k], ny = cy + DY4[k];
          if (!this.inBounds(nx, ny)) continue;
          const ni = this.idx(nx, ny);
          if (visited[ni]) continue;
          visited[ni] = 1;
          if (this.type[ni] === t && stab[ni] === 0) {
            cache[ni] = wind;
            stack.push(ni);
          }
        }
      }
    }
  }

  // Раз в кадр, тем же приёмом, что и computeDebrisWindChance() выше: для
  // каждой ещё не рассмотренной клетки жидкости находит её связную (4-соседство,
  // ТОЛЬКО тот же тип — вода не считается путём наружу для лавы и наоборот)
  // компоненту целиком и запоминает ОДИН флаг на всю компоненту — есть ли у
  // неё где-нибудь хоть одна пустая клетка-сосед. attemptSwapOrMove читает
  // именно этот кэш: если у всей связной лужи нет НИ ОДНОГО выхода вообще
  // (запечатана целиком твёрдым/другим веществом со всех сторон), тонущий
  // объект её не вытесняет — жидкость несжимаема и ей физически некуда
  // деться, поэтому объект остаётся лежать поверх, а не проваливается
  // сквозь. Если выход есть хоть где-то в компоненте (пусть за десятки
  // клеток от места вытеснения) — вытеснение по-прежнему разрешено: сама
  // лужа за много кадров успеет перераспределиться к этому выходу, это
  // просто не мгновенно и не обязано укладываться в бюджет одного поиска
  // displaceLiquidThroughBody.
  computeLiquidEscape() {
    const w = this.w, h = this.h, n = w * h;
    const type = this.type;
    const visited = this._liquidVisited;
    visited.fill(0);
    const escape = this._liquidEscape;
    const stack = this._liquidStack || (this._liquidStack = []);
    const comp = this._liquidComp || (this._liquidComp = []);
    for (let i = 0; i < n; i++) {
      if (visited[i]) continue;
      visited[i] = 1;
      const t = type[i];
      const el = ELEMENTS[t];
      if (!el || el.cat !== CAT.LIQUID) continue;
      // Связность — по "фазе" (LIQUID_PHASE в elements.js): всё семейство
      // растворов (вода/кислота/реагент/раствор) — одна жидкость.
      const ph = LIQUID_PHASE[t];
      stack.length = 0; stack.push(i);
      comp.length = 0; comp.push(i);
      let hasEscape = false;
      while (stack.length) {
        const ci = stack.pop();
        const cx = ci % w, cy = (ci / w) | 0;
        if (cx > 0) {
          const ni = ci - 1;
          if (type[ni] === EL.EMPTY) hasEscape = true;
          else if (!visited[ni] && LIQUID_PHASE[type[ni]] === ph) { visited[ni] = 1; stack.push(ni); comp.push(ni); }
        }
        if (cx < w - 1) {
          const ni = ci + 1;
          if (type[ni] === EL.EMPTY) hasEscape = true;
          else if (!visited[ni] && LIQUID_PHASE[type[ni]] === ph) { visited[ni] = 1; stack.push(ni); comp.push(ni); }
        }
        if (cy > 0) {
          const ni = ci - w;
          if (type[ni] === EL.EMPTY) hasEscape = true;
          else if (!visited[ni] && LIQUID_PHASE[type[ni]] === ph) { visited[ni] = 1; stack.push(ni); comp.push(ni); }
        }
        if (cy < h - 1) {
          const ni = ci + w;
          if (type[ni] === EL.EMPTY) hasEscape = true;
          else if (!visited[ni] && LIQUID_PHASE[type[ni]] === ph) { visited[ni] = 1; stack.push(ni); comp.push(ni); }
        }
      }
      const val = hasEscape ? 1 : 0;
      for (let k = 0; k < comp.length; k++) escape[comp[k]] = val;
    }
  }

  // Помечает клетки сетки ветра, содержащие хотя бы одну непроницаемую
  // клетку симуляции (см. isAirtight), как полностью закрытые. Пересчитывается
  // каждый кадр перед диффузией, т.к. стена/металл могут появляться, а
  // обломки — падать и открывать проход.
  computeAirBlock() {
    const w = this.w, h = this.h, ac = this.airCell, aw = this.airW;
    const an = aw * this.airH;
    const blocked = this._airBlocked;
    blocked.fill(0);
    const type = this.type;
    for (let y = 0; y < h; y++) {
      const rowBase = ((y / ac) | 0) * aw;
      for (let x = 0; x < w; x++) {
        const ai = rowBase + ((x / ac) | 0);
        if (!blocked[ai] && isAirtight(type[y * w + x])) blocked[ai] = 1;
      }
    }
    const open = this.airOpen;
    for (let ai = 0; ai < an; ai++) open[ai] = blocked[ai] ? 0 : 1;
  }

  // Вес каждой клетки для диффузии тепла — см. комментарий про heatWeight
  // в конструкторе. В отличие от ветра (computeAirBlock), здесь не нужна
  // агрегация по грубому блоку 4x4: вес клетки зависит только от НЕЁ
  // САМОЙ (что там за материал), поэтому один простой прямой проход.
  // AIR_COND — теплопроводность полностью открытого воздуха относительно
  // прямого контакта с веществом (1.0). Даже на таком малом значении
  // источник не становится бесконечной батарейкой: DECAY_MATTER (лёгкое
  // остывание "на месте", в updateTemp) действует независимо от диффузии
  // и всё равно рано или поздно гасит изолированное тепло — просто через
  // decay, а не через утечку в соседний воздух.
  //
  // Это вес ТОЛЬКО для стороны "вещество теряет тепло в воздух": когда
  // сам воздух смотрит на горячего соседа-вещество, он берёт его с полным
  // весом 1 (см. updateTemp — o = weight[ni], а вещество весит 1). Обмен
  // намеренно несимметричный: воздух рядом с лавой прогревается быстро и
  // заметно, а лава от этого почти не остывает.
  //
  // Значение = ENV_SLOWDOWN раз меньше прежних 0.012 — по просьбе:
  // "окружающее пространство забирало температуру вещества в 20 раз
  // медленнее". Утечка тепла из вещества в окружение складывается из двух
  // независимых каналов, и замедлены ОБА одним и тем же множителем (иначе
  // второй канал оставался бы "потолком" скорости остывания):
  //   1) контакт с воздухом — этот AIR_COND;
  //   2) остывание "в никуда" — DECAY_MATTER в updateTemp.
  computeHeatWeight() {
    const n = this.w * this.h;
    const type = this.type;
    const weight = this.heatWeight;
    const AIR_COND = 0.012 / Sim.ENV_SLOWDOWN;
    for (let i = 0; i < n; i++) {
      const t = type[i];
      weight[i] = isHeatInsulator(t) ? 0 : (t === EL.EMPTY ? AIR_COND : 1);
    }
  }

  // Раз в кадр: лёгкое затухание (трение, чтобы ветер не дул вечно) и
  // диффузия (смешивание с соседними клетками сетки ветра, чтобы резкое
  // возмущение в одном месте плавно расползалось, а не оставалось иглой).
  // Сама сетка ветра пополняется отдельно — инструментом "давление" (см.
  // applyPressureBrush) и разовыми возмущениями от любого реального
  // движения частиц (см. disturbWind, вызывается из swap()).
  //
  // Скорость диффузии (rate) не постоянна, а растёт вместе с локальным
  // перепадом (разницей между клеткой и соседями) — лёгкий сквозняк
  // выравнивается медленно и плавно, как раньше, а сильный перепад
  // давления "летит" заметно быстрее, а не ползёт с той же фиксированной
  // долей за кадр.
  //
  // За кадр делается несколько (WIND_SUBSTEPS) проходов диффузии подряд,
  // а не один. Один проход смешивает клетку только с её ПРЯМЫМИ соседями —
  // сколько бы ни был высок rate, за один проход возмущение физически не
  // может уйти дальше чем на 1 клетку сетки ветра, и с фиксированным
  // затуханием (DECAY) оно попросту гаснет раньше, чем успевает расползтись
  // на сколько-нибудь заметное расстояние (на глаз — распространение почти
  // не заметно, хотя видно, что клетка-источник довольно быстро остывает).
  // Несколько проходов за тот же кадр дают возмущению пройти несколько
  // клеток сетки ветра за кадр, оставаясь тем же диффузионным механизмом
  // (просто применённым чаще), без пересмотра модели на что-то вроде
  // полноценной адвекции/уравнений Навье-Стокса. DECAY также немного
  // ослаблен (0.995 -> 0.997) — при неизменном "трении" возмущение попросту
  // не успевало прожить достаточно кадров, чтобы уйти далеко, сколько бы
  // проходов диффузии на кадр ни делалось. DIFFUSE_MAX на один проход при
  // этом снижен (0.85 -> 0.5) — тот же суммарный эффект за кадр даёт
  // несколько более мягких проходов подряд, что и было целью, а не один
  // резкий (колебаний на резких перепадах не обнаружено ни на старом, ни на
  // новом рейте, но более мягкий шаг всё равно оставлен с запасом).
  //
  // Стена и металл (isAirtight) для этой диффузии — настоящая преграда:
  // вклад каждой клетки (и своей, и соседской) в сумму взвешен её долей
  // "открытости" (airOpen, см. computeAirBlock), точно так же, как уже
  // исключались из соседей клетки за границей поля — сплошная преграда для
  // соседа неотличима от края симуляции. Внутри самой преграды воздуха
  // нет — её результирующая скорость гасится той же долей открытости.
  updateWind() {
    const aw = this.airW, ah = this.airH, an = aw * ah;
    this.computeAirBlock();
    const open = this.airOpen;
    const DECAY = 0.997;
    const DIFFUSE_BASE = 0.15;
    const DIFFUSE_GAIN = 0.6;
    const DIFFUSE_MAX = 0.5;
    const WIND_SUBSTEPS = 4;
    if (!this._windVX2 || this._windVX2.length !== an) {
      this._windVX2 = new Float32Array(an);
      this._windVY2 = new Float32Array(an);
    }
    let vx = this.windVX, vy = this.windVY;
    let vx2 = this._windVX2, vy2 = this._windVY2;
    for (let step = 0; step < WIND_SUBSTEPS; step++) {
      const isLast = step === WIND_SUBSTEPS - 1;
      for (let ay = 0; ay < ah; ay++) {
        for (let ax = 0; ax < aw; ax++) {
          const ai = ay * aw + ax;
          const selfOpen = open[ai];
          let sumX = vx[ai] * selfOpen, sumY = vy[ai] * selfOpen, cnt = selfOpen;
          if (ax > 0) { const ni = ai - 1; const o = open[ni]; sumX += vx[ni] * o; sumY += vy[ni] * o; cnt += o; }
          if (ax < aw - 1) { const ni = ai + 1; const o = open[ni]; sumX += vx[ni] * o; sumY += vy[ni] * o; cnt += o; }
          if (ay > 0) { const ni = ai - aw; const o = open[ni]; sumX += vx[ni] * o; sumY += vy[ni] * o; cnt += o; }
          if (ay < ah - 1) { const ni = ai + aw; const o = open[ni]; sumX += vx[ni] * o; sumY += vy[ni] * o; cnt += o; }
          const avgX = cnt > 1e-4 ? sumX / cnt : 0, avgY = cnt > 1e-4 ? sumY / cnt : 0;
          const diffX = avgX - vx[ai], diffY = avgY - vy[ai];
          const rate = Math.min(DIFFUSE_MAX, DIFFUSE_BASE + Math.hypot(diffX, diffY) * DIFFUSE_GAIN);
          let nx = vx[ai] + diffX * rate;
          let ny = vy[ai] + diffY * rate;
          if (isLast) { nx *= DECAY; ny *= DECAY; }
          nx *= selfOpen; ny *= selfOpen;
          // Совсем крошечные значения обнуляем, чтобы не гонять вечный
          // фоновый шум там, где ветра по сути уже нет.
          if (isLast) {
            if (Math.abs(nx) < 0.001) nx = 0;
            if (Math.abs(ny) < 0.001) ny = 0;
          }
          vx2[ai] = nx; vy2[ai] = ny;
        }
      }
      const tx = vx; vx = vx2; vx2 = tx;
      const ty = vy; vy = vy2; vy2 = ty;
    }
    this.windVX = vx; this._windVX2 = vx2;
    this.windVY = vy; this._windVY2 = vy2;
  }

  // Читают ЗАМОРОЖЕННЫЙ снимок (windVXFrame/windVYFrame), а не живые
  // windVX/windVY — см. комментарий в конструкторе про windVXFrame.
  getWindVX(x, y) { return this.windVXFrame[this.airIdx(x, y)]; }
  getWindVY(x, y) { return this.windVYFrame[this.airIdx(x, y)]; }

  // Раз в кадр: обычная диффузия+остывание к 0, тем же простым
  // Джакоби-проходом, что и у ветра, но скаляром (одно число на клетку,
  // а не вектор), НА ПОЛНОМ разрешении (клетка симуляции = клетка сетки
  // тепла, см. конструктор) и БЕЗ под-шагов (WIND_SUBSTEPS у ветра нарочно
  // ускорял распространение — здесь наоборот хочется, чтобы "потихоньку
  // краснело", а не сразу; один проход в кадр держит нагрев заметно
  // более медленным и плавным).
  //
  // Важно: источники тепла (FIRE/LAVA) НЕ подпитываются здесь заново
  // каждый кадр — их клетка засевается один раз при появлении (см.
  // spawn()) и дальше живёт по тем же правилам, что и всё остальное
  // тепло: диффундирует, остывает и переезжает вместе с клеткой при
  // движении (см. swap()). Раньше был термостат ("если ниже heatSource —
  // подтянуть обратно к heatSource" каждый кадр), и из-за него ОДНА
  // клетка лавы была неисчерпаемым источником — расплавит сколько угодно
  // камня и сама не остынет ни на градус, пока стоит на месте. Реальная
  // лава должна отдавать своё тепло и в процессе остывать (см. reactLava
  // — при достаточном остывании застывает обратно в камень), а не
  // действовать как вечная батарейка.
  updateTemp() {
    const w = this.w, h = this.h;
    this.computeHeatWeight();
    const weight = this.heatWeight;
    const type = this.type;
    const src = this.temp;
    // История DECAY. Сначала был ослаблен (0.995 -> 0.9993): пока чинили баг с цепной
    // реакцией плавления (spawn каждый раз подкидывал расплаву полный
    // heatSource), именно ЭТА непрерывная подпитка маскировала настоящую
    // скорость затухания — мир выглядел "не остывающим". С прежним DECAY
    // отдельная клетка без подпитки теряла половину температуры всего за
    // ~140 кадров (~2.3 с при 60 fps) — при починенной цепной реакции это
    // стало отчётливо видно как "температура сама по себе тает в ноль",
    // причём ДАЖЕ у клетки, полностью изолированной от соседей (напр.,
    // огромный ровно прогретый массив камня — диффузия между одинаково
    // горячими соседями практически ничего не делает, весь уход тепла шёл
    // через один голый DECAY). Новое значение держит половину тепла ~1000
    // кадров (~16-17 с) — тепло всё ещё гарантированно гаснет само по себе,
    // просто не за пару секунд.
    //
    // Затем остывание ВЕЩЕСТВА замедлено ещё в ENV_SLOWDOWN (20) раз — по
    // просьбе "окружающее пространство забирало температуру вещества в 20
    // раз медленнее" (второй канал утечки, AIR_COND в computeHeatWeight,
    // замедлен тем же множителем — см. комментарий там). Теперь у клетки
    // вещества без подпитки половина тепла держится ~20000 кадров (~5.5 мин
    // при 60 fps). Множитель разделён на два:
    //   DECAY_MATTER — для клеток вещества (в т.ч. теплоизолятора-стены);
    //   DECAY_AIR    — для пустоты (воздуха), ОСТАВЛЕН ПРЕЖНИМ: воздух и есть
    //                  то самое "окружающее пространство", которое должно
    //                  рассеивать попавшее в него тепло так же, как раньше.
    //                  Иначе тепло от каждого костра копилось бы в воздухе
    //                  20 раз дольше и постепенно прогревало бы всю карту.
    // Обе константы ниже 1 — тепло по-прежнему гарантированно гаснет само.
    const DECAY_AIR = 0.9993;
    const DECAY_MATTER = 1 - (1 - DECAY_AIR) / Sim.ENV_SLOWDOWN;
    // Граница поля адиабатическая: у клетки на краю просто НЕТ соседа за
    // пределами карты (ветки x>0 / x<w-1 / y>0 / y<h-1 ниже), поэтому в
    // среднее он не входит ни с каким весом — край ни отбирает тепло, ни
    // отдаёт его, ни фиксирует какую-либо "температуру за стенкой". Краевая
    // клетка обменивается только с реально существующими соседями (их
    // 2-3 вместо 4) и остывает "в никуда" тем же DECAY_*, что и любая
    // другая. Никакого специального кода для краёв не нужно и быть не
    // должно — если он когда-нибудь появится, это будет регрессия.
    const DIFFUSE_RATE = 0.25;
    // Воздух рядом с воздухом (обе клетки EMPTY) — отдельная, куда более
    // медленная теплопроводность, чем между обычным веществом (вес 1) —
    // именно в 5 раз медленнее, по просьбе: "прогретые участки воздуха
    // могли передавать свою температуру соседям... в пять раз медленнее".
    // Раньше воздух-воздух молча использовал ТОТ ЖЕ AIR_COND (0.012), что
    // и граница объект-воздух, а тот специально сделан очень маленьким
    // (см. computeHeatWeight) — чтобы лава посреди пустоты не остывала
    // мгновенно. Из-за этого прогретый воздух, ничем не окружённый, вообще
    // не передавал тепло СОСЕДНЕМУ воздуху (вклад соседа в среднее был
    // мизерным) — тепло не расползалось, а тихо гасло на месте одним
    // DECAY, что и выглядело как "пропадает, даже не в воздух". AIR_COND
    // (граница вещество-воздух) остаётся прежним — это разные явления:
    // насколько быстро ГОРЯЧИЙ ОБЪЕКТ теряет тепло в воздух (низкое) vs
    // насколько быстро прогретый ВОЗДУХ делится теплом с соседним воздухом
    // (это новое, отдельное AIR_AIR_RATE).
    const AIR_AIR_RATE = 0.2;
    // Конвекция: только между двумя клетками воздуха, только по вертикали.
    // Если клетка холоднее соседа СНИЗУ или теплее соседа СВЕРХУ — тепло в
    // этом направлении течёт ВВЕРХ (из более горячей клетки в более
    // холодную, находящуюся выше) — такой обмен усилен. Обратное
    // направление (тепло идёт ВНИЗ, из горячей клетки верхнему соседу в
    // холодную клетку под ней) — усиления нет, обычный AIR_AIR_RATE. Итог:
    // тёплый воздух прогревает то, что над ним, охотно и быстро, а холодный
    // воздух точно так же охотно "стекает" вниз (не прогревается сверху) —
    // простая, но узнаваемая конвекция без честной адвекции/переноса массы.
    const CONVECTION_BOOST = 3;
    const dst = this._temp2;
    for (let y = 0; y < h; y++) {
      const rowBase = y * w;
      for (let x = 0; x < w; x++) {
        const i = rowBase + x;
        if (!weight[i]) {
          // Теплоизолятор (стена) не обменивается теплом с соседями ни в
          // одну, ни в другую сторону — но если он САМ каким-то образом
          // горячий, это не обнуляется мгновенно, а просто угасает
          // обычным DECAY, как и везде (в реальности стена сама по себе
          // не бывает "горячей", т.к. никто не засевает ей heatSource, но
          // это на случай, если тепло дошло до неё раньше — не роняем
          // резко в 0).
          let nt = src[i] * DECAY_MATTER;
          if (Math.abs(nt) < 0.05) nt = 0;
          dst[i] = nt;
          continue;
        }
        // Вес соседа — насколько он теплопроводен (см. computeHeatWeight):
        // полностью открытый воздух проводит тепло куда хуже прямого
        // контакта с веществом. Без этого множителя открытый воздух и
        // соседний камень отбирали бы тепло с одинаковой скоростью, и
        // одиночная лава посреди пустоты остывала бы так же быстро, как
        // лава, обложенная камнем со всех сторон, — а физически это два
        // совсем разных случая. Пара "воздух-воздух" (обе клетки EMPTY) —
        // единственное исключение: там вместо weight[ni] (=AIR_COND,
        // рассчитан на границу с веществом) берётся отдельный AIR_AIR_RATE,
        // а по вертикали ещё и с конвективной асимметрией (см. выше).
        const selfAir = type[i] === EL.EMPTY;
        const vi = src[i];
        let sum = vi, cnt = 1;
        if (x > 0) {
          const ni = i - 1;
          const o = (selfAir && type[ni] === EL.EMPTY) ? AIR_AIR_RATE : weight[ni];
          sum += src[ni] * o; cnt += o;
        }
        if (x < w - 1) {
          const ni = i + 1;
          const o = (selfAir && type[ni] === EL.EMPTY) ? AIR_AIR_RATE : weight[ni];
          sum += src[ni] * o; cnt += o;
        }
        if (y > 0) {
          const ni = i - w;
          let o = weight[ni];
          if (selfAir && type[ni] === EL.EMPTY) {
            o = AIR_AIR_RATE;
            if (src[ni] < vi) o *= CONVECTION_BOOST; // мы теплее клетки сверху — тепло охотно уходит вверх
          }
          sum += src[ni] * o; cnt += o;
        }
        if (y < h - 1) {
          const ni = i + w;
          let o = weight[ni];
          if (selfAir && type[ni] === EL.EMPTY) {
            o = AIR_AIR_RATE;
            if (src[ni] > vi) o *= CONVECTION_BOOST; // клетка снизу теплее нас — тепло охотно идёт к нам (тоже вверх)
          }
          sum += src[ni] * o; cnt += o;
        }
        const avg = cnt > 1e-4 ? sum / cnt : 0;
        let nt = (vi + (avg - vi) * DIFFUSE_RATE) * (selfAir ? DECAY_AIR : DECAY_MATTER);
        if (Math.abs(nt) < 0.05) nt = 0;
        dst[i] = nt;
      }
    }
    this.temp = dst; this._temp2 = src;
  }

  getTemp(x, y) { return this.temp[this.idx(x, y)]; }

  // Инструмент "температура" — та же кисть, что и у давления (rx,ry в
  // клетках симуляции), теперь напрямую в тех же координатах, без
  // перевода в грубую сетку (temp — полного разрешения). Правит sim.temp
  // напрямую (скаляр, без направления): sign>0 (ЛКМ) — греет, sign<0
  // (ПКМ) — студит. В отличие от applyPressureBrush тут нет смысла в
  // радиальном push/pull от центра — "температура" не течёт в
  // направлении, а просто повышается или понижается на охваченной кистью
  // площади.
  applyTempBrush(cx, cy, rx, ry, sign) {
    const rx2 = Math.max(rx, 0.5), ry2 = Math.max(ry, 0.5);
    const x0 = Math.max(0, Math.floor(cx - rx)), x1 = Math.min(this.w - 1, Math.ceil(cx + rx));
    const y0 = Math.max(0, Math.floor(cy - ry)), y1 = Math.min(this.h - 1, Math.ceil(cy + ry));
    const PUSH = 3;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const nx = (x - cx) / rx2, ny = (y - cy) / ry2;
        if (nx * nx + ny * ny > 1) continue;
        this.temp[this.idx(x, y)] += sign * PUSH;
      }
    }
  }

  // Направление ±1 по X, статистически смещённое локальным ветром — не
  // жёстко диктует направление (иначе газ/жидкость в потоке выглядели бы
  // механически), а лишь делает движение "по ветру" вероятнее. scale задаёт
  // силу влияния: у газа заметно сильнее, чем у более тяжёлой жидкости.
  // Сравнивается с ОБЩИМ на кадр _windRoll (см. tryWindPush — та же причина).
  // Для осыпавшихся структурных обломков берёт кэш всей компоненты (см.
  // computeDebrisWindChance), а не свою точку — та же причина, что и там.
  windDir(x, y, scale) {
    const i = this.idx(x, y);
    const wind = (isStructural(this.type[i]) && this.stability[i] === 0) ? this._debrisWindVX[i] : this.getWindVX(x, y);
    const pRight = Math.max(0.05, Math.min(0.95, 0.5 + wind * scale));
    return this._windRoll < pRight ? 1 : -1;
  }

  // Пытается толкнуть частицу чисто горизонтально по ветру, с шансом,
  // растущим вместе с силой локального ветра — используется как попытка,
  // "перебивающая" обычное движение по гравитации/плавучести, ПЕРЕД ним.
  // Без этого в открытом пространстве обычное падение/всплытие почти
  // всегда успевало бы сработать раньше, и ветер оставался бы заметен
  // только там, где путь и так уже перекрыт, а не в самом обычном случае
  // свободного падения/подъёма. windScale масштабирует чувствительность
  // (0 или отсутствие — полностью выключает эффект для этого вызова),
  // maxChance ограничивает шанс сверху, чтобы ветер не мог КАЖДЫЙ кадр
  // полностью отменять гравитацию/плавучесть. rising — как в
  // attemptSwapOrMove (газ поднимается — true, жидкость/сыпучее падают — false).
  //
  // Сравнение идёт с ОБЩИМ на весь кадр _windRoll (а не с независимым
  // Math.random() на каждую клетку) И с ЗАМОРОЖЕННЫМ на весь кадр снимком
  // ветра (getWindVX/getWindVY — см. windVXFrame в конструкторе), а не с
  // живым windVX/windVY. Без ЛЮБОГО из этих двух разные клетки одного
  // цельного куска (например, падающей прямой палки) толкались бы ветром
  // в разные моменты и расходились бы в стороны, разрывая форму: без
  // общего roll — по случайности броска на каждую клетку; без заморозки
  // снимка — потому что клетка, до которой очередь в развёртке кадра
  // дошла позже, уже видела бы чуть возмущённый (чужим же движением,
  // через disturbWind) ветер, а не тот, что было в начале кадра. Вместе
  // они дают любой клетке ещё целой цепочки одинаковый ответ "да/нет" в
  // этом кадре — долгосрочная частота срабатывания (в среднем по многим
  // кадрам) при этом не меняется, просто перестаёт быть независимой по
  // каждой клетке.
  tryWindPush(x, y, i, el, windScale, maxChance, rising) {
    if (!windScale) return false;
    const w = this.w;
    // Для клеток структурного мусора (stability===0) берём ЕДИНЫЙ на весь
    // связный кусок ветер из computeDebrisWindChance, а не локальный —
    // иначе даже с общим roll и заморозкой снимка разные клетки одной
    // цепочки могут со временем накопить разный локальный ветер (реальный
    // пространственный градиент вдоль широкого объекта) и разойтись.
    const wind = (isStructural(this.type[i]) && this.stability[i] === 0) ? this._debrisWindVX[i] : this.getWindVX(x, y);
    const chance = Math.min(maxChance, Math.abs(wind) * windScale);
    if (this._windRoll >= chance) return false;
    const wdir = wind > 0 ? 1 : -1;
    const nx = x + wdir;
    if (nx < 0 || nx >= w) return false;
    const ni = this.idx(nx, y);
    // Соседняя клетка ТОГО ЖЕ материала, вытянутого вдоль направления
    // толчка (например, горизонтальная палка, которую толкает ГОРИЗОНТАЛЬНО),
    // ещё не сдвинулась в этом кадре и потому блокирует одиночный своп —
    // а раз следующая клетка дальше по цепочке в СЛЕДУЮЩЕЙ итерации того же
    // кадра решит толкнуться туда же (тот же общий бросок, тот же локальный
    // ветер), одиночные свопы просто упирались бы друг в друга, и толкалась
    // бы только передняя кромка, отрываясь от остального куска. Сдвигаем
    // всю связную цепочку одним атомарным действием вместо этого.
    if (this.type[ni] === this.type[i]) return this.shiftChain(x, y, wdir, el, rising);
    return this.attemptSwapOrMove(i, ni, el, rising);
  }

  // Сдвигает связную цепочку клеток одного материала, начинающуюся в (x,y)
  // и тянущуюся в направлении wdir, на один шаг в ту же сторону целиком —
  // но только если на дальнем конце цепочки вообще есть куда деться (пусто
  // или вытесняемая более лёгкая/плотная — как в attemptSwapOrMove —
  // жидкость/газ/сыпучее). Все клетки цепочки и принимающая клетка на
  // дальнем конце помечаются moved, чтобы не обработаться повторно в этом
  // же кадре. maxChain ограничивает длину поиска.
  shiftChain(x, y, wdir, el, rising) {
    const w = this.w;
    const t = this.type[this.idx(x, y)];
    const maxChain = 64;
    const chain = [this.idx(x, y)];
    let cx = x;
    for (let step = 1; step <= maxChain; step++) {
      const nx = cx + wdir;
      if (nx < 0 || nx >= w) return false;
      const ni = this.idx(nx, y);
      const nt = this.type[ni];
      if (nt === t) { chain.push(ni); cx = nx; continue; }
      let canAccept = nt === EL.EMPTY;
      if (!canAccept) {
        const nEl = ELEMENTS[nt];
        canAccept = !!nEl && isMovable(nEl.cat) && (rising ? nEl.density > el.density : nEl.density < el.density);
      }
      if (!canAccept) return false;
      // Циклический сдвиг делается цепочкой обменов swapFields, идя с
      // ДАЛЬНЕГО конца к ближнему: сначала последняя клетка меняется с
      // принимающей, потом предпоследняя с последней и так далее. Итог
      // ровно тот же, что и при копировании по одной клетке вперёд —
      // каждая получает содержимое предшественника, а содержимое
      // принимающей клетки "оборачивается" в начало цепочки.
      //
      // Раньше здесь поля копировались вручную, и перечислены были только
      // четыре: тип, жизнь, extra и оттенок. Всё остальное, что делает
      // частицу собой, молча оставалось на месте — температура, влажность
      // земли и (с появлением химии) состав раствора. Для состава это было
      // не просто потерей: клетка на конце цепочки получала тип "раствор"
      // с НУЛЕВЫМ составом, а нулевой состав читался как чистая вода — на
      // сцене, где воды нет вообще, кислота на камне рождала воду из
      // ниоткуда, и перемешивание разносило её по всей луже. Ровно тот
      // симптом, о котором сообщил пользователь.
      //
      // swapFields — единственная точка, которая знает ПОЛНЫЙ список полей
      // частицы; вызывая её, этот код больше не может отстать от него при
      // добавлении новых полей. Ветер возмущается один раз в самом конце
      // (для него это одно перемещение), поэтому обмен идёт через
      // swapFields, а не через swap.
      for (let k = chain.length - 1; k >= 0; k--) {
        const to = (k === chain.length - 1) ? ni : chain[k + 1];
        this.swapFields(chain[k], to);
        this.moved[to] = 1;
      }
      this.moved[chain[0]] = 1;
      this.disturbWind(chain[0], ni);
      return true;
    }
    return false;
  }

  // Инструмент "давление" — не рисует материал, а напрямую правит сетку
  // ветра под кистью (кисть та же, что и для рисования: rx,ry в клетках
  // симуляции). sign>0 (ЛКМ, "усилить") толкает воздух РАДИАЛЬНО НАРУЖУ
  // от центра кисти — локальная зона повышенного давления; sign<0 (ПКМ,
  // "погасить") тянет воздух НАЗАД к центру — зона пониженного давления
  // (всасывание). В самом центре направление не определено (некуда
  // "наружу" от самой точки) — там ничего не меняется, эффект виден на
  // остальной площади кисти.
  applyPressureBrush(cx, cy, rx, ry, sign) {
    const acx = cx / this.airCell, acy = cy / this.airCell;
    const arx = Math.max(0.5, rx / this.airCell), ary = Math.max(0.5, ry / this.airCell);
    const ax0 = Math.max(0, Math.floor(acx - arx)), ax1 = Math.min(this.airW - 1, Math.ceil(acx + arx));
    const ay0 = Math.max(0, Math.floor(acy - ary)), ay1 = Math.min(this.airH - 1, Math.ceil(acy + ary));
    const PUSH = 0.5;
    for (let ay = ay0; ay <= ay1; ay++) {
      for (let ax = ax0; ax <= ax1; ax++) {
        const nx = (ax - acx) / arx, ny = (ay - acy) / ary;
        if (nx * nx + ny * ny > 1) continue;
        let pdx = ax - acx, pdy = ay - acy;
        const len = Math.sqrt(pdx * pdx + pdy * pdy) || 1;
        pdx /= len; pdy /= len;
        const ai = ay * this.airW + ax;
        this.windVX[ai] += sign * PUSH * pdx;
        this.windVY[ai] += sign * PUSH * pdy;
      }
    }
  }

  // ---- реакции ----

  react(x, y, i, id) {
    switch (id) {
      case EL.WOOD: this.reactFlammable(x, y, i, id); break;
      case EL.OIL: this.reactOil(x, y, i); break;
      case EL.OILFILM: this.reactFlammable(x, y, i, id); break;
      case EL.GUNP: this.reactFlammable(x, y, i, id); break;
      case EL.FIRE: this.reactFire(x, y, i); break;
      case EL.LAVA: this.reactLava(x, y, i); break;
      case EL.ICE: this.reactIce(x, y, i); break;
      case EL.ACID: this.reactAcidic(x, y, i); break;
      case EL.SOLUTION: this.reactSolution(x, y, i); break;
      case EL.ACID_RESIDUE: this.reactAcidResidue(x, y, i); break;
      case EL.ACID_GAS: this.reactAcidGas(x, y, i); break;
      case EL.STEAM: this.reactSteam(x, y, i); break;
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
      case EL.BEAM: this.reactBeam(x, y, i); break;
      case EL.COLONIST: this.reactColonist(x, y, i); break;
    }
  }

  // Колонист (заготовка под "строительство города" — пока умеет только
  // копать шахты). life[i] — сколько единиц груза сейчас несёт (0..
  // CARRY_CAPACITY), extra[i] — материал этого груза (та же идея, что у
  // OILFILM/маска у BEAM — служебное поле конкретного элемента).
  // colonistHomeX/Y[i] — склад, который колонист выбрал СЕБЕ САМ на
  // текущую ходку: ровно та точка, где он стоял, начиная копать (значит,
  // заведомо открытое место). Вся земля, выкопанная за эту ходку,
  // относится туда же, а не разбрасывается где попало по дороге — иначе
  // на глаз это смотрится как бессмысленные прыжки туда-сюда, а по факту
  // вело к массовым обвалам шахты (см. ниже) и потере большей части
  // выкопанного.
  //
  // Ёмкость больше одной единицы НАРОЧНО: набрать один пиксель и тут же
  // тащить его домой и обратно ради КАЖДОЙ выкопанной клетки на практике
  // означает десятки лишних проходов туда-обратно по одной и той же узкой
  // шахте — а сыпучая земля вокруг неё не держит вертикальные стенки
  // (обычная физика сыпучего) и постепенно осыпается обратно от одного
  // лишь количества проходов мимо. Набор нескольких пикселей за один
  // спуск резко сокращает число таких походов.
  //
  // Если несёт хоть что-то и либо ПОЛОН, либо копать сейчас не на чем —
  // "везёт груз домой": поднимается до уровня склада (той же дорогой,
  // какой шёл вниз — clearObstacleForColonist расчищает завалы по пути,
  // предпочитая сдвинуть мешающую землю в сторону, а не терять её
  // безвозвратно), затем идёт по горизонтали до столбца склада (на
  // практике почти всегда уже там — копает-то он всегда строго вниз, без
  // отклонений по x, так что достаточно только подъёма; горизонтальный
  // шаг — просто подстраховка на будущее), и там сбрасывает по одной
  // единице за кадр в радиусе одного пикселя от себя (запрошенный способ
  // переноса стройматериалов) — то есть буквально рядом со складом, а не
  // где придётся по дороге.
  //
  // Если не полон: под пустотой, без груза — не его забота, обычная
  // гравитация сыпучего (updateCell/updatePowder) сама уронит его дальше.
  // Если рядом (сбоку или по диагонали вниз) уже есть ГОТОВЫЙ, полностью
  // пустой проход, ведущий к камню — идёт туда, а не копает заново рядом
  // с готовым проходом (см. hasOpenPathDown). Иначе, если под ЗЕМЛЁЙ в
  // пределах разумной глубины по той же колонке вниз достижим КАМЕНЬ —
  // копает ещё одну единицу, запоминая точку старта складом, если это
  // первая лопата новой ходки; движение вниз, в опустевшую клетку,
  // обеспечит та же гравитация сразу же в этом кадре (react()
  // отрабатывает раньше updatePowder), так что колонист опускается
  // глубже сам. Если копать не на чем и нечего нести — "блуждание"
  // (wanderColonist).
  reactColonist(x, y, i) {
    const w = this.w, h = this.h;
    const CARRY_CAPACITY = 8;
    const carrying = this.life[i];

    if (carrying < CARRY_CAPACITY && y + 1 < h) {
      const belowI = this.idx(x, y + 1);
      const belowT = this.type[belowI];
      if (belowT === EL.EMPTY && carrying === 0) return; // просто падение
      if (belowT === EL.EARTH && (carrying === 0 || this.extra[i] === EL.EARTH)) {
        // Готовый (полностью пустой) проход рядом — предпочитаем его новой
        // раскопке. ВАЖНО проверять это только тут, а не безусловно каждый
        // кадр: колонист, уже стоящий НАД открытым проходом (belowT уже
        // EMPTY), не должен продолжать озираться по сторонам в поисках
        // ЕЩЁ более открытого соседа — иначе с любым открытым столбцом
        // по соседству (например, просто открытый воздух сбоку от края
        // раскопок) он бы бесконечно уходил боком, кадр за кадром находя
        // очередной "тоже открытый" сосед, вместо того чтобы просто упасть
        // вниз по уже открытому пути под собой.
        const OPEN_CHECKS = [[-1, 0], [1, 0], [-1, 1], [1, 1]];
        for (const [dx, dy] of OPEN_CHECKS) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          if (this.type[this.idx(nx, ny)] !== EL.EMPTY) continue;
          if (this.hasOpenPathDown(nx, ny)) {
            const ni = this.idx(nx, ny);
            this.swap(i, ni);
            this.moved[ni] = 1;
            return;
          }
        }

        // Глубина ограничена только самой картой (cy>=h ниже) — произвольный
        // потолок вроде "50 клеток" на практике почти всегда меньше
        // реальной толщины слоя земли (карта высотой в сотни клеток), и
        // колонист попросту никогда не "видел" камень глубже него — то
        // самое "не стремится к открытому источнику камня" из бага.
        let stoneReachable = false;
        for (let d = 1; ; d++) {
          const cy = y + 1 + d;
          if (cy >= h) break;
          const ct = this.type[this.idx(x, cy)];
          if (ct === EL.STONE) { stoneReachable = true; break; }
          if (ct !== EL.EARTH && ct !== EL.EMPTY) break; // не наша прямая шахта дальше
        }
        if (stoneReachable) {
          // Склад запоминаем ТОЛЬКО при переходе в новый столбец — не при
          // каждом carrying===0: после полной сдачи груза колонист падает
          // обратно на дно СВОЕЙ ЖЕ уже наполовину прокопанной шахты (тот
          // же x, что и раньше) и тут же начинает новую ходку оттуда — если
          // бы склад переустанавливался и тут, он бы каждый раз съезжал
          // всё глубже вслед за забоем, а не оставался у поверхности, где
          // колонист начал копать этот столбец первый раз.
          if (carrying === 0 && x !== this.colonistHomeX[i]) {
            this.colonistHomeX[i] = x;
            this.colonistHomeY[i] = y;
          }
          this.clearCell(belowI);
          this.life[i] = carrying + 1;
          this.extra[i] = EL.EARTH;
          return;
        }
      }
    }

    if (carrying > 0) {
      const homeX = this.colonistHomeX[i], homeY = this.colonistHomeY[i];

      if (y > homeY) {
        const ui = this.idx(x, y - 1);
        if (this.clearObstacleForColonist(ui, i)) {
          this.swap(i, ui);
          this.moved[ui] = 1;
        }
        return;
      }

      if (x !== homeX) {
        const nx = x + (x < homeX ? 1 : -1);
        const ni = this.idx(nx, y);
        if (this.clearObstacleForColonist(ni, i)) {
          this.swap(i, ni);
          this.moved[ni] = 1;
        }
        return;
      }

      // На месте склада — сбрасываем одну единицу груза в радиусе одного
      // пикселя от себя.
      const DIRS = [[-1, 0], [1, 0], [-1, -1], [1, -1], [-1, 1], [1, 1], [0, -1], [0, 1]];
      for (const [dx, dy] of DIRS) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const ni = this.idx(nx, ny);
        if (this.type[ni] === EL.EMPTY) {
          this.spawn(ni, this.extra[i]);
          this.moved[ni] = 1;
          this.life[i] = carrying - 1;
          // Сброс груза сам колониста не двигает — но обычная гравитация
          // сыпучего (updateCell -> updatePowder) сработает сразу следом
          // в этом же кадре, а колонист, скорее всего, стоит в СВОЕЙ ЖЕ
          // прокопанной (пустой под ним) шахте — без этого флага он тут же
          // падал бы обратно вниз на дно шахты, сводя на нет весь только
          // что пройденный подъём ради одного сброшенного пикселя.
          this.moved[i] = 1;
          return;
        }
      }
      return; // склад временно завален со всех сторон — подождём
    }

    this.wanderColonist(x, y, i);
  }

  // Есть ли УЖЕ готовый (полностью пустой, копать не надо) проход вниз от
  // (x,y) до камня — в отличие от проверки внутри reactColonist (та
  // разрешает землю на пути, её как раз предстоит копать), тут годится
  // только то, что уже открыто, чтобы предпочесть готовый проход новой
  // раскопке.
  hasOpenPathDown(x, y) {
    const h = this.h;
    // Как и в reactColonist — глубина ограничена только самой картой, без
    // отдельного произвольного потолка (см. комментарий там же).
    for (let d = 0; ; d++) {
      const cy = y + d;
      if (cy >= h) return false;
      const ct = this.type[this.idx(x, cy)];
      if (ct === EL.STONE) return d > 0; // сама точка (x,y) не в счёт, нужен хоть шаг вниз
      if (ct !== EL.EMPTY) return false;
    }
  }

  // Пытается освободить клетку ni для колониста, идущего домой: если уже
  // пуста — сразу готово. Если там земля — сначала пробует СДВИНУТЬ её в
  // сторону (в её собственном радиусе одного пикселя, не считая originI —
  // обычно самого колониста, которого не должно толкать землёй в упор), и
  // только если рядом с ней самой тоже всюду занято — расчищает
  // безвозвратно, но лишь как крайний случай. Любой другой материал
  // (камень, стена и т.п.) не трогает вовсе — не его забота, возвращает
  // false. true — если ni в итоге свободна и в неё можно шагать.
  //
  // ВАЖНО вызывать освобождение и сам шаг одним атомарным действием
  // (см. вызовы в reactColonist), а не порознь на следующем кадре: обход
  // клеток идёт снизу вверх по глубине (клетки ГЛУБЖЕ обрабатываются
  // РАНЬШЕ более мелких в том же кадре), так что при раздельном подъёме
  // земля, стоящая ЕЩЁ выше по пути, в этом же самом кадре успела бы
  // просесть в свежую пустоту раньше, чем колонист вообще попробует туда
  // шагнуть — и колонист вечно разбирал бы один и тот же уровень, ни разу
  // реально не продвинувшись, попутно скармливая себе всю землю сверху.
  clearObstacleForColonist(ni, originI) {
    const t = this.type[ni];
    if (t === EL.EMPTY) return true;
    if (t !== EL.EARTH) return false;
    const w = this.w, h = this.h;
    const ux = ni % w, uy = (ni / w) | 0;
    const PUSH_DIRS = [[-1, 0], [1, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]];
    for (const [pdx, pdy] of PUSH_DIRS) {
      const pnx = ux + pdx, pny = uy + pdy;
      if (pnx < 0 || pnx >= w || pny < 0 || pny >= h) continue;
      const pni = this.idx(pnx, pny);
      if (pni === originI || this.type[pni] !== EL.EMPTY) continue;
      this.swap(ni, pni);
      this.moved[pni] = 1;
      return true;
    }
    this.clearCell(ni);
    return true;
  }

  // Блуждание — редкий случайный шаг вбок (не вниз: за падение отвечает
  // обычная гравитация сыпучего тела), когда копать сейчас негде. Не
  // каждый кадр, иначе колонисты дрожали бы на месте, а не неспешно
  // бродили.
  wanderColonist(x, y, i) {
    const WANDER_CHANCE = 0.05;
    if (Math.random() >= WANDER_CHANCE) return;
    const w = this.w;
    const dir = Math.random() < 0.5 ? 1 : -1;
    for (const dx of [dir, -dir]) {
      const nx = x + dx;
      if (nx < 0 || nx >= w) continue;
      const ni = this.idx(nx, y);
      if (this.type[ni] === EL.EMPTY) {
        this.swap(i, ni);
        this.moved[ni] = 1;
        return;
      }
    }
  }

  // Раз в кадр проверяет, что связь балки с опорой (запомненная один раз
  // при спавне — см. spawn()) всё ещё цела: у каждого направления в маске
  // extra[i] на месте должен стоять структурный материал/якорь ПРЯМО
  // СЕЙЧАС, не важно, тот же самый или другой — связь про факт опоры в эту
  // сторону, а не про конкретного соседа. Если хоть одно из направлений
  // связи нарушено (или связи не было вовсе, mask===0 — см. spawn()) —
  // балка необратимо становится обычным камнем: reactMelt для камня
  // выполняется уже на следующий кадр как для STONE, отдельно вызывать не
  // нужно. Пока связь цела — ведёт себя как STONE и в остальном (плавление
  // через reactMelt).
  reactBeam(x, y, i) {
    const mask = this.extra[i];
    let broken = mask === 0;
    if (!broken) {
      for (let k = 0; k < 4; k++) {
        if (!(mask & (1 << k))) continue;
        const nx = x + DX4[k], ny = y + DY4[k];
        const nt = this.inBounds(nx, ny) ? this.type[this.idx(nx, ny)] : EL.EMPTY;
        if (!isStructural(nt) && !isAnchor(nt)) { broken = true; break; }
      }
    }
    if (broken) { this.spawn(i, EL.STONE); return; }
    this.reactMelt(x, y, i, EL.BEAM);
  }

  reactFlammable(x, y, i, id) {
    const el = ELEMENTS[id];
    for (let k = 0; k < 4; k++) {
      const nx = x + DX4[k], ny = y + DY4[k];
      if (!this.inBounds(nx, ny)) continue;
      const nt = this.type[this.idx(nx, ny)];
      if (nt === EL.FIRE || nt === EL.LAVA) {
        if (id === EL.GUNP) {
          this.detonateGunpowder(x, y);
          return;
        }
        if (Math.random() < el.burnChance) {
          this.spawn(i, EL.FIRE);
          this.life[i] = el.burnLife + (Math.random() * 10 | 0);
          this.extra[i] = (id === EL.WOOD) ? 1 : 0;
        }
        return;
      }
    }
  }

  // Масло застывает при касании твёрдого тела или якоря (не при касании
  // другого масла — иначе слой мог бы бесконтрольно нарастать) — становится
  // OILFILM с запомненным направлением ЕДИНСТВЕННОЙ связи (см. computeStability:
  // застывшее масло держится только за эту связь и никогда не передаёт
  // устойчивость дальше, поэтому не может склеить два разных объекта).
  // Горение по-прежнему в приоритете: если рядом ещё и огонь/лава — масло
  // просто вспыхивает, а не застывает.
  reactOil(x, y, i) {
    const el = ELEMENTS[EL.OIL];
    let solidifyDir = -1;
    for (let k = 0; k < 4; k++) {
      const nx = x + DX4[k], ny = y + DY4[k];
      if (!this.inBounds(nx, ny)) continue;
      const nt = this.type[this.idx(nx, ny)];
      if (nt === EL.FIRE || nt === EL.LAVA) {
        if (Math.random() < el.burnChance) {
          this.spawn(i, EL.FIRE);
          this.life[i] = el.burnLife + (Math.random() * 10 | 0);
        }
        return;
      }
      // OILFILM намеренно исключено: иначе слой мог бы бесконтрольно расти,
      // застывая каждый раз заново от уже застывшего масла рядом (OILFILM
      // входит в isStructural() ради физики падения/устойчивости, но это
      // отдельный вопрос от того, что именно триггерит застывание).
      if (solidifyDir === -1 && nt !== EL.OILFILM && (isStructural(nt) || isAnchor(nt))) {
        solidifyDir = oilDirCode(DX4[k], DY4[k]);
      }
    }
    if (solidifyDir !== -1) {
      this.spawn(i, EL.OILFILM);
      this.extra[i] = solidifyDir;
    }
  }

  // Порох детонирует мгновенно и целиком: обычная покадровая передача огня
  // (как у дерева) не успевает пройти по всей связной массе за короткое время
  // жизни огня, и часть пороха гаснет непровзорвавшейся. Взрывчатке нужен
  // надёжный мгновенный подрыв всего связного куска, а не вероятностная волна.
  detonateGunpowder(x0, y0) {
    const w = this.w, h = this.h;
    const startI = this.idx(x0, y0);
    if (this.type[startI] !== EL.GUNP) return;
    const burnLife = ELEMENTS[EL.GUNP].burnLife;
    const stack = [startI];
    const visited = new Uint8Array(w * h);
    visited[startI] = 1;
    while (stack.length) {
      const i = stack.pop();
      this.spawn(i, EL.FIRE);
      this.life[i] = burnLife + (Math.random() * 10 | 0);
      this.moved[i] = 1;
      const x = i % w, y = (i / w) | 0;
      if (x > 0) { const ni = i - 1; if (!visited[ni]) { visited[ni] = 1; if (this.type[ni] === EL.GUNP) stack.push(ni); } }
      if (x < w - 1) { const ni = i + 1; if (!visited[ni]) { visited[ni] = 1; if (this.type[ni] === EL.GUNP) stack.push(ni); } }
      if (y > 0) { const ni = i - w; if (!visited[ni]) { visited[ni] = 1; if (this.type[ni] === EL.GUNP) stack.push(ni); } }
      if (y < h - 1) { const ni = i + w; if (!visited[ni]) { visited[ni] = 1; if (this.type[ni] === EL.GUNP) stack.push(ni); } }
    }
  }

  reactFire(x, y, i) {
    this.life[i]--;
    if (this.life[i] <= 0) {
      const fromWood = this.extra[i] === 1;
      const r = Math.random();
      if (fromWood && r < 0.3) this.spawn(i, EL.ASH);
      else if (r < 0.5) this.spawn(i, EL.SMOKE);
      else this.clearCell(i);
      return;
    }
    if (Math.random() < 0.06) {
      const ny = y - 1;
      if (this.inBounds(x, ny)) {
        const ni = this.idx(x, ny);
        if (this.type[ni] === EL.EMPTY) { this.spawn(ni, EL.SMOKE); this.moved[ni] = 1; }
      }
    }
  }

  updateFireMovement(x, y, i) {
    if (Math.random() < 0.35) {
      const w = this.w;
      const nx = x + ((Math.random() * 3 | 0) - 1);
      const ny = y - 1;
      if (nx >= 0 && nx < w && ny >= 0) {
        const ni = this.idx(nx, ny);
        if (this.type[ni] === EL.EMPTY) { this.swap(i, ni); this.moved[ni] = 1; }
      }
    }
  }

  // Порог застывания заметно ниже meltPoint камня (55), а не тот же самый —
  // иначе клетка на самой границе колебалась бы между лавой и камнем каждый
  // кадр от мельчайших шумовых колебаний температуры около одного и того же
  // числа (гистерезис: плавится при 55+, застывает только при 30-, между
  // ними остаётся тем, чем уже является).
  reactLava(x, y, i) {
    if (this.temp[i] < 30) { this.spawn(i, EL.STONE); return; }
    for (let k = 0; k < 4; k++) {
      const nx = x + DX4[k], ny = y + DY4[k];
      if (!this.inBounds(nx, ny)) continue;
      const ni = this.idx(nx, ny);
      const nt = this.type[ni];
      if (nt === EL.WATER) {
        if (Math.random() < 0.6) this.spawn(ni, EL.STEAM);
        if (Math.random() < 0.5) { this.spawn(i, EL.STONE); return; }
      } else if (nt === EL.ICE) {
        if (Math.random() < 0.4) this.spawn(ni, EL.WATER);
      } else if (nt === EL.GUNP) {
        this.detonateGunpowder(nx, ny);
      } else if (nt === EL.WOOD || nt === EL.OIL) {
        const el = ELEMENTS[nt];
        if (Math.random() < el.burnChance) {
          this.spawn(ni, EL.FIRE);
          this.life[ni] = el.burnLife + (Math.random() * 10 | 0);
          this.extra[ni] = (nt === EL.WOOD) ? 1 : 0;
        }
      }
    }
  }

  reactIce(x, y, i) {
    for (let k = 0; k < 4; k++) {
      const nx = x + DX4[k], ny = y + DY4[k];
      if (!this.inBounds(nx, ny)) continue;
      const ni = this.idx(nx, ny);
      const nt = this.type[ni];
      if (nt === EL.FIRE || nt === EL.LAVA) {
        if (Math.random() < 0.5) { this.spawn(i, EL.WATER); return; }
      } else if (nt === EL.WATER) {
        if (Math.random() < 0.015) this.spawn(ni, EL.ICE);
      }
    }
  }

  // ---- химия кислоты: раствор, растворение, остаток, газ ----
  //
  // Общая картина (подробности про доли — в elements.js, блок "раствор"):
  //  - Чистая кислота (EL.ACID) = раствор из 10 долей кислоты. Разъедает
  //    соседей; каждое растворение тратит одну долю кислоты и превращает
  //    её в долю "растворённого вещества". Со второго растворения та
  //    доля вещества становится долей реагента, а на месте растворённой
  //    клетки остаётся кислотный остаток (сыпучее). Так за кислотой
  //    тянется след остатка, а сама она беднеет кислотой, пока не станет
  //    чистым химическим реагентом (EL.REAGENT).
  //  - Кислота с водой не "растворяет" воду, а разбавляется ею: раствор
  //    (EL.SOLUTION) со смешанным составом; действует как кислота,
  //    ослабленная пропорционально доле кислоты.
  //  - Раствор постоянно хаотично перемешивается с соседними жидкостями
  //    семейства (mixWithNeighbour), обмениваясь по одной доле за раз.
  //  - С шансом 20% каждое растворение выделяет кислотный газ.

  // Состав клетки-жидкости семейства растворов (упакованный, см. solPack).
  // Для чистых элементов состав подразумевается и Sim.sol не читается.
  liquidParts(i) {
    switch (this.type[i]) {
      case EL.WATER: return SOL_PURE_WATER;
      case EL.ACID: return SOL_PURE_ACID;
      case EL.REAGENT: return SOL_PURE_REAGENT;
      // Нулевой состав у раствора — всегда чья-то ошибка (клетка получила
      // тип "раствор", но не получила состав). Страховка отдаёт ИНЕРТНЫЙ
      // реагент, а не воду, как было раньше: вода — действующее вещество
      // этой химии (она разбавляет кислоту и красит лужу в синий), и
      // подменять ею сбой значит выдумывать вещество из ниоткуда и
      // прятать сам сбой. Единственный источник такого состава был в
      // shiftChain (см. там) и устранён; страховка оставлена на случай,
      // если новый код снова заведёт клетку раствора в обход
      // setLiquidComposition.
      case EL.SOLUTION: return this.sol[i] || SOL_PURE_REAGENT;
      default: return 0;
    }
  }

  // Записывает состав в клетку-жидкость: чистый состав — снова чистый
  // элемент (вода/кислота/реагент), любая смесь — EL.SOLUTION. Тип
  // ставится напрямую, а не через spawn(): температура, оттенок и прочие
  // поля частицы при смене состава не меняются — это та же капля.
  setLiquidComposition(i, comp) {
    let id;
    if (comp === SOL_PURE_WATER) id = EL.WATER;
    else if (comp === SOL_PURE_ACID) id = EL.ACID;
    else if (comp === SOL_PURE_REAGENT) id = EL.REAGENT;
    else id = EL.SOLUTION;
    this.type[i] = id;
    this.sol[i] = comp;
  }

  // Случайная доля из состава (индекс вида, взвешенный по числу долей).
  randomPart(comp) {
    let r = (Math.random() * SOL_PARTS) | 0;
    for (let slot = 0; slot < 4; slot++) {
      const c = solGet(comp, slot);
      if (r < c) return slot;
      r -= c;
    }
    return SOL_WATER;
  }

  // Переложить одну долю вида slot из состава: -1 в from, +1 в to.
  static solMove(comp, from, to) {
    return comp - (1 << (from * 4)) + (1 << (to * 4));
  }

  // Хаотичное перемешивание: клетка i (раствор или чистая кислота) берёт
  // одного случайного соседа по 4-соседству и, если он из семейства
  // растворов, обменивается с ним одной случайной долей. Две чистые
  // жидкости так друг в друга не лезут (реагент и вода рядом остаются
  // собой) — инициатор всегда либо смесь, либо кислота. Особый случай:
  // чистая кислота и чистая вода при касании сразу дают ПОРОВНУ —
  // 5 долей кислоты + 5 воды в каждой из двух клеток.
  mixWithNeighbour(x, y, i) {
    const k = (Math.random() * 4) | 0;
    const nx = x + DX4[k], ny = y + DY4[k];
    if (!this.inBounds(nx, ny)) return;
    const ni = this.idx(nx, ny);
    const t = this.type[i], nt = this.type[ni];
    if (!isSolutionFamily(nt)) return;
    if (t === EL.ACID && nt === EL.WATER) {
      const half = solPack(SOL_PARTS / 2, SOL_PARTS / 2, 0, 0);
      this.setLiquidComposition(i, half);
      this.setLiquidComposition(ni, half);
      return;
    }
    if (t === EL.ACID && nt === EL.ACID) return;
    const MIX_CHANCE = 0.5;
    if (Math.random() >= MIX_CHANCE) return;
    let a = this.liquidParts(i), b = this.liquidParts(ni);
    const pa = this.randomPart(a), pb = this.randomPart(b);
    if (pa === pb) return;
    a = Sim.solMove(a, pa, pb);
    b = Sim.solMove(b, pb, pa);
    this.setLiquidComposition(i, a);
    this.setLiquidComposition(ni, b);
  }

  // Чистая кислота: перемешивание с соседями + растворение.
  reactAcidic(x, y, i) {
    this.mixWithNeighbour(x, y, i);
    if (this.type[i] === EL.ACID || this.type[i] === EL.SOLUTION) this.dissolveNeighbours(x, y, i);
  }

  // Раствор: то же самое; растворяет только если в нём есть кислота.
  reactSolution(x, y, i) {
    this.mixWithNeighbour(x, y, i);
    if (this.type[i] === EL.SOLUTION && solGet(this.sol[i], SOL_ACID) > 0) this.dissolveNeighbours(x, y, i);
  }

  // Разъедание соседей клеткой i с долей кислоты acid/10. Шанс на клетку
  // в кадр — как у прежней чистой кислоты (0.06, для acidSlow 0.015),
  // умноженный на долю кислоты: раствор с одной долей разъедает в 10 раз
  // реже и, поскольку у него ровно одна доля на трату, "живёт" в 10 раз
  // меньше — ровно как просили. Не разъедаются: пустота, всё семейство
  // растворов, кислотный газ и остаток, acidImmune (стена, стекло).
  dissolveNeighbours(x, y, i) {
    let comp = this.liquidParts(i);
    let acid = solGet(comp, SOL_ACID);
    for (let k = 0; k < 4 && acid > 0; k++) {
      const nx = x + DX4[k], ny = y + DY4[k];
      if (!this.inBounds(nx, ny)) continue;
      const ni = this.idx(nx, ny);
      const nt = this.type[ni];
      if (nt === EL.EMPTY || isSolutionFamily(nt) || nt === EL.ACID_GAS || nt === EL.ACID_RESIDUE) continue;
      const nel = ELEMENTS[nt];
      if (!nel || nel.acidImmune) continue;
      const chance = (nel.acidSlow ? 0.015 : 0.06) * acid / SOL_PARTS;
      if (Math.random() < chance) {
        comp = this.dissolveInto(x, y, i, ni, comp);
        acid = solGet(comp, SOL_ACID);
      }
    }
    this.setLiquidComposition(i, comp);
  }

  // Один акт растворения клетки ni кислотным раствором i с составом comp.
  // Возвращает новый состав (в клетку его пишет вызывающий).
  //  1. Одна доля кислоты тратится.
  //  2. Если доли растворённого вещества (SOL_STONE) ещё не было — она
  //     появляется вместо потраченной кислоты, а растворённая клетка
  //     просто исчезает (первое растворение "съедает" вещество целиком).
  //     Если уже была — прежняя доля вещества становится долей реагента,
  //     новая доля вещества встаёт на её место, а растворённая клетка
  //     превращается в кислотный остаток первого уровня: так кислота
  //     оставляет за собой след остатка на каждом следующем растворении.
  //  3. Когда кислоты не остаётся, последняя доля вещества тоже
  //     становится реагентом — раствор без кислоты это вода + реагент,
  //     а без воды — чистый химический реагент.
  //  4. С шансом 20% в случайную пустую клетку рядом с кислотой (или на
  //     место только что растворённой, если оно опустело) выделяется
  //     кислотный газ.
  dissolveInto(x, y, i, ni, comp) {
    const hadStone = solGet(comp, SOL_STONE) > 0;
    if (hadStone) {
      comp = Sim.solMove(comp, SOL_ACID, SOL_REAGENT);
      this.spawn(ni, EL.ACID_RESIDUE);
    } else {
      comp = Sim.solMove(comp, SOL_ACID, SOL_STONE);
      this.clearCell(ni);
    }
    if (solGet(comp, SOL_ACID) === 0) {
      const s = solGet(comp, SOL_STONE);
      for (let k = 0; k < s; k++) comp = Sim.solMove(comp, SOL_STONE, SOL_REAGENT);
    }
    const GAS_CHANCE = 0.2;
    if (Math.random() < GAS_CHANCE) {
      const opts = [];
      for (let k = 0; k < 4; k++) {
        const ox = x + DX4[k], oy = y + DY4[k];
        if (!this.inBounds(ox, oy)) continue;
        const oi = this.idx(ox, oy);
        if (this.type[oi] === EL.EMPTY) opts.push(oi);
      }
      if (opts.length) this.spawn(opts[(Math.random() * opts.length) | 0], EL.ACID_GAS);
    }
    return comp;
  }

  // Кислотный остаток (сыпучее, extra = уровень 1..4). Смотрит только на
  // клетку НАД собой:
  //  - там кислота (чистая или раствор с долей кислоты) — меняется с ней
  //    местами, пропуская её вниз: остаток не должен ложиться плёнкой
  //    между кислотой и тем, что она разъедает;
  //  - там такой же остаток — сливаются в один: уровни складываются
  //    (остаток становится темнее и менее похожим на камень, см.
  //    render.js), с пятого уровня остаток превращается в химический
  //    реагент.
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
    if (at === EL.ACID || (at === EL.SOLUTION && solGet(this.sol[ai], SOL_ACID) > 0)) {
      this.swap(i, ai); this.moved[ai] = 1;
    }
  }

  // Кислотный газ: просто рассеивается со временем (life задаётся в spawn).
  reactAcidGas(x, y, i) {
    this.life[i]--;
    if (this.life[i] <= 0) this.clearCell(i);
  }

  // Пар живёт долго (см. spawn) и выпадает водой, когда вышел срок ИЛИ
  // когда остыл ниже COND_TEMP — холод (инструмент "Температура",
  // соседство со льдом) осаждает облако раньше срока. Прежний ежекадровый
  // шанс 1% на конденсацию убран: он и делал пар слишком короткоживущим.
  // Выпавшая капля не должна быть горячее точки кипения — иначе она
  // тут же вскипела бы снова (см. reactWater), и пар "мерцал" бы на
  // месте вместо того, чтобы упасть дождём.
  reactSteam(x, y, i) {
    this.life[i]--;
    const COND_TEMP = 10;
    if (this.life[i] <= 0 || this.temp[i] < COND_TEMP) {
      this.spawn(i, EL.WATER);
      const bp = ELEMENTS[EL.WATER].boilPoint;
      if (this.temp[i] > bp - 6) this.temp[i] = bp - 6;
    }
  }

  reactSmoke(x, y, i) {
    this.life[i]--;
    if (this.life[i] <= 0) this.clearCell(i);
  }

  reactSand(x, y, i) {
    for (let k = 0; k < 4; k++) {
      const nx = x + DX4[k], ny = y + DY4[k];
      if (!this.inBounds(nx, ny)) continue;
      const nt = this.type[this.idx(nx, ny)];
      if (nt === EL.LAVA || nt === EL.FIRE) {
        if (Math.random() < 0.01) this.spawn(i, EL.GLASS);
        return;
      }
    }
  }

  // Твёрдые материалы плавятся в лаву, если ЛОКАЛЬНАЯ температура (см.
  // updateTemp/getTemp) достигла их meltPoint — не по факту касания
  // огня/лавы напрямую, а через тепло, которое от них диффундирует
  // (см. updateTemp): тело рядом, но не впритык, тоже постепенно
  // нагреется и в итоге расплавится, просто медленнее. meltChance —
  // шанс В КАДР собственно перехода, если условие по температуре уже
  // выполнено (не "успеет ли расплавиться вообще", а "именно в этот
  // кадр" — чтобы разные клетки одного блока не плавились все разом в
  // ту же миллисекунду, когда переваливают порог). Дерево/масло(-плёнка)/
  // порох сюда не входят — у них своя реакция горения (reactFlammable);
  // лёд тоже не входит — у него уже есть reactIce (топится в воду, а не
  // в лаву, плюс попутно замораживает воду рядом — отдельный, не сводимый
  // к простому "плавлению" механизм).
  reactMelt(x, y, i, id) {
    const el = ELEMENTS[id];
    if (this.temp[i] >= el.meltPoint && Math.random() < el.meltChance) {
      // seedHeat=false — см. комментарий у spawn(): расплав сохраняет
      // свою уже-достаточную-для-плавления температуру, а не подскакивает
      // до полного heatSource лавы (иначе цепная реакция плавления не
      // затухает).
      this.spawn(i, el.meltsInto, false);
    }
  }

  reactSalt(x, y, i) {
    for (let k = 0; k < 4; k++) {
      const nx = x + DX4[k], ny = y + DY4[k];
      if (!this.inBounds(nx, ny)) continue;
      if (this.type[this.idx(nx, ny)] === EL.WATER) {
        if (Math.random() < 0.03) this.clearCell(i);
        return;
      }
    }
  }

  // Вода тушит огонь и кипит: если ЛОКАЛЬНАЯ температура (updateTemp)
  // достигла boilPoint — с небольшим шансом в кадр становится паром (тем
  // же, что и от касания лавы в reactLava). Раньше по температуре вода не
  // кипела вовсе — только от прямого контакта с лавой; нагрев инструментом
  // "Температура" ничего не давал.
  reactWater(x, y, i) {
    const BOIL_CHANCE = 0.05;
    if (this.temp[i] >= ELEMENTS[EL.WATER].boilPoint && Math.random() < BOIL_CHANCE) {
      this.spawn(i, EL.STEAM);
      return;
    }
    for (let k = 0; k < 4; k++) {
      const nx = x + DX4[k], ny = y + DY4[k];
      if (!this.inBounds(nx, ny)) continue;
      const ni = this.idx(nx, ny);
      if (this.type[ni] === EL.FIRE) {
        if (Math.random() < 0.5) this.clearCell(ni);
      }
    }
  }

  reactVoid(x, y, i) {
    for (let k = 0; k < 4; k++) {
      const nx = x + DX4[k], ny = y + DY4[k];
      if (!this.inBounds(nx, ny)) continue;
      const ni = this.idx(nx, ny);
      const nt = this.type[ni];
      if (nt !== EL.EMPTY && nt !== EL.WALL && nt !== EL.VOID) {
        if (Math.random() < 0.9) this.clearCell(ni);
      }
    }
  }

  reactClone(x, y, i) {
    if (this.extra[i] === 0) {
      for (let k = 0; k < 8; k++) {
        const nx = x + DX8[k], ny = y + DY8[k];
        if (!this.inBounds(nx, ny)) continue;
        const nt = this.type[this.idx(nx, ny)];
        if (nt !== EL.EMPTY && nt !== EL.CLONE && nt !== EL.WALL) { this.extra[i] = nt; break; }
      }
    }
    if (this.extra[i] !== 0) {
      for (let k = 0; k < 8; k++) {
        const nx = x + DX8[k], ny = y + DY8[k];
        if (!this.inBounds(nx, ny)) continue;
        const ni = this.idx(nx, ny);
        if (this.type[ni] === EL.EMPTY && Math.random() < 0.25) {
          const remembered = this.extra[i];
          this.spawn(ni, remembered);
          this.moved[ni] = 1;
        }
      }
    }
  }

  // Раз в тик влажности (фиксировано, TICK_FRAMES кадров симуляции). Общая
  // скорость времени (sim.timeScale) теперь регулируется ОДНИМ способом
  // сразу для всех процессов — см. main.js: она правит тем, СКОЛЬКО РАЗ
  // step() вызывается на кадр отрисовки, а не отдельными порогами внутри
  // конкретных механик. Этот счётчик поэтому специально НЕ завязан на
  // timeScale напрямую — при двойной завязке (и тут, и там) земля мокла бы
  // не линейно, а квадратично быстрее при ускорении времени.
  //
  // Земля/мокрая земля по очереди: (1) впитывает соседний пиксель воды,
  // если есть запас ёмкости (MAX_MOISTURE) — именно от этого земля впервые
  // становится мокрой землёй; (2) отдаёт ровно 1 единицу влажности САМОМУ
  // СУХОМУ соседу своего же семейства (земля/мокрая земля), если у него
  // меньше — простая диффузия влажности, которая может домочить соседнюю
  // сухую землю; (3) — только мокрая земля, только в покое (stability>0 —
  // уже не собирается падать в этот кадр) и только если внизу есть куда
  // упасть воде — капает, теряя 1 единицу влажности. Каждый из этих шагов —
  // строго атомарная пара "убрать у источника / добавить получателю"
  // (никогда одно без другого), чтобы вода не дублировалась и не терялась
  // в никуда. Высохшая до 0 мокрая земля возвращается в обычную землю.
  tickMoisture(x, y, i, id) {
    const TICK_FRAMES = 60;
    this.life[i]++;
    if (this.life[i] < TICK_FRAMES) return;
    this.life[i] = 0;

    const w = this.w, h = this.h;
    const MAX_MOISTURE = 3;
    let moisture = this.moisture[i];
    let curId = id;

    if (moisture < MAX_MOISTURE) {
      for (let k = 0; k < 4; k++) {
        const nx = x + DX4[k], ny = y + DY4[k];
        if (!this.inBounds(nx, ny)) continue;
        const ni = this.idx(nx, ny);
        if (this.type[ni] === EL.WATER) {
          this.clearCell(ni);
          moisture++;
          if (curId === EL.EARTH) { this.spawn(i, EL.WET_EARTH); curId = EL.WET_EARTH; }
          break;
        }
      }
    }

    if (moisture > 0) {
      let targetNi = -1, targetMoisture = moisture;
      for (let k = 0; k < 4; k++) {
        const nx = x + DX4[k], ny = y + DY4[k];
        if (!this.inBounds(nx, ny)) continue;
        const ni = this.idx(nx, ny);
        const nt = this.type[ni];
        if (nt !== EL.EARTH && nt !== EL.WET_EARTH) continue;
        const nm = this.moisture[ni];
        if (nm < targetMoisture) { targetMoisture = nm; targetNi = ni; }
      }
      if (targetNi !== -1) {
        if (this.type[targetNi] === EL.EARTH) this.spawn(targetNi, EL.WET_EARTH);
        this.moisture[targetNi]++;
        moisture--;
      }
    }

    if (curId === EL.WET_EARTH && moisture > 0 && this.stability[i] > 0) {
      const slots = [];
      if (y + 1 < h) {
        const bi = this.idx(x, y + 1);
        if (this.type[bi] === EL.EMPTY) slots.push(bi);
        if (x > 0) { const bli = this.idx(x - 1, y + 1); if (this.type[bli] === EL.EMPTY) slots.push(bli); }
        if (x < w - 1) { const bri = this.idx(x + 1, y + 1); if (this.type[bri] === EL.EMPTY) slots.push(bri); }
      }
      if (slots.length > 0) {
        const drip = slots[(Math.random() * slots.length) | 0];
        this.spawn(drip, EL.WATER);
        moisture--;
      }
    }

    this.moisture[i] = moisture;
    if (curId === EL.WET_EARTH && moisture === 0) this.spawn(i, EL.EARTH);
  }

  // Каждый кадр (как обычное плавление reactMelt, а не по тику влажности) —
  // если клетку нагрело до точки кипения воды (ELEMENTS[EL.WATER].boilPoint),
  // есть небольшой шанс, что часть влаги просочится наружу паром через
  // любую соседнюю пустую клетку (по возможности вверх — пар поднимается).
  tryEvaporateMoisture(x, y, i) {
    if (this.moisture[i] <= 0) return;
    const boilPoint = ELEMENTS[EL.WATER].boilPoint;
    if (this.temp[i] < boilPoint) return;
    const EVAP_CHANCE = 0.05;
    if (Math.random() >= EVAP_CHANCE) return;
    const w = this.w, h = this.h;
    let target = -1;
    if (y - 1 >= 0) {
      const ni = this.idx(x, y - 1);
      if (this.type[ni] === EL.EMPTY) target = ni;
    }
    if (target === -1) {
      const opts = [];
      if (x > 0) { const ni = this.idx(x - 1, y); if (this.type[ni] === EL.EMPTY) opts.push(ni); }
      if (x < w - 1) { const ni = this.idx(x + 1, y); if (this.type[ni] === EL.EMPTY) opts.push(ni); }
      if (y + 1 < h) { const ni = this.idx(x, y + 1); if (this.type[ni] === EL.EMPTY) opts.push(ni); }
      if (opts.length) target = opts[(Math.random() * opts.length) | 0];
    }
    if (target === -1) return;
    this.spawn(target, EL.STEAM);
    this.moisture[i]--;
    if (this.moisture[i] === 0) this.spawn(i, EL.EARTH);
  }

  // ---- движение по категориям ----

  attemptSwapOrMove(i, ni, el, rising) {
    const nt = this.type[ni];
    // Балка не задерживает падающее/сыпучее/текучее (rising=false — газ,
    // единственный, кто зовёт с rising=true, сквозь неё по-прежнему не
    // проходит, ведёт себя как обычный камень) — ищем первую НЕ-балочную
    // клетку в том же направлении движения (сквозь несколько балок подряд
    // разом, если они есть) и адресуем всю обычную проверку ЕЙ, как будто
    // балки на пути вовсе не было. Сама балка при этом никуда не сдвигается
    // и остаётся собой — это не своп с ней, а взгляд СКВОЗЬ.
    if (!rising && nt === EL.BEAM) {
      const w = this.w;
      const dx = (ni % w) - (i % w), dy = ((ni / w) | 0) - ((i / w) | 0);
      let cx = ni % w, cy = (ni / w) | 0, ti = ni;
      while (this.type[ti] === EL.BEAM) {
        cx += dx; cy += dy;
        if (cx < 0 || cx >= w || cy < 0 || cy >= this.h) return false;
        ti = this.idx(cx, cy);
      }
      return this.attemptSwapOrMove(i, ti, el, rising);
    }
    if (nt === EL.EMPTY) { this.swap(i, ni); this.moved[ni] = 1; return true; }
    const nEl = ELEMENTS[nt];
    if (!nEl || !isMovable(nEl.cat)) return false;
    if (rising ? (nEl.density > el.density) : (nEl.density < el.density)) {
      // Тонущий тяжёлый материал (rising=false — обычное падение, не
      // всплытие пузыря) вытесняет жидкость к ближайшей свободной
      // поверхности самой лужи (см. sinkIntoLiquid /
      // displaceLiquidThroughBody), а не топорно себе на смену: простой
      // своп сажает жидкость ровно в клетку i, откуда только что ушёл
      // вытесняющий материал — обычно прямо НАД ним. Повторяясь кадр за
      // кадром, пока объект тонет, это протаскивало бы вытесненную
      // жидкость сквозь всё тело наверх вместо того, чтобы она растекалась
      // вокруг, как в реальности.
      if (!rising && nEl.cat === CAT.LIQUID) return this.sinkIntoLiquid(i, ni);
      this.swap(i, ni); this.moved[ni] = 1; return true;
    }
    return false;
  }

  // Тонущий (более плотный, не всплывающий) объект в клетке solidIdx входит
  // в клетку жидкости liqIdx. Общая точка для ОБОИХ направлений инициативы —
  // "объект смотрит вниз и видит жидкость" (attemptSwapOrMove) и "жидкость
  // смотрит вверх и видит над собой тонущий объект" (attemptBuoyantRise):
  // из-за построчного обхода снизу вверх на практике чаще срабатывает
  // именно второй, и без единой точки любой фикс вытеснения тихо обходился
  // бы им стороной.
  //
  // Порядок:
  //   1. Лужа запечатана целиком (нет ни одной пустой клетки-соседа у всей
  //      связной компоненты, см. computeLiquidEscape) — жидкость
  //      несжимаема, деваться ей некуда, объект остаётся лежать поверх.
  //   2. displaceLiquidThroughBody: увезти жидкость из liqIdx к БЛИЖАЙШЕЙ
  //      свободной клетке, достижимой ПО САМОЙ ЛУЖЕ (см. там), после чего
  //      liqIdx пуст и объект просто съезжает в него.
  //   3. Свободная клетка есть, но слишком далеко (поиск упёрся в бюджет) —
  //      прежнее поведение: простой своп, жидкость временно оказывается на
  //      месте объекта и сама растечётся за следующие кадры.
  sinkIntoLiquid(solidIdx, liqIdx) {
    if (!this._liquidEscape[liqIdx]) return false;
    this.displaceLiquidThroughBody(liqIdx);
    this.swap(solidIdx, liqIdx);
    this.moved[liqIdx] = 1;
    return true;
  }

  // Вытеснение жидкости из клетки start тонущим объектом — как у настоящей
  // несжимаемой жидкости: давление передаётся через всю связную лужу, и
  // "лишняя" вода выходит на ближайшей свободной поверхности, а не там,
  // где ей случайно оказалось удобно.
  //
  // Раньше (displaceLiquidSideways) жидкость сдвигалась только по своей
  // строке через ПУСТЫЕ клетки, а если рядом было занято (другая вода —
  // самый обычный случай посреди лужи) — просто менялась местами с
  // объектом и оказывалась НАД ним. Для широкого тела, входящего в воду,
  // это повторялось кадр за кадром на каждой клетке его нижнего ряда, и
  // вода поклеточно "просачивалась" сквозь всё тело, выныривая на его
  // ВЕРХНЕЙ стороне — там, где воды нет и куда физически её вытеснить
  // нельзя (объект между ней и лужей).
  //
  // Теперь: BFS (поиск в ширину, 4-соседство) от start строго по клеткам
  // ТОЙ ЖЕ жидкости. Кандидат — ПУСТАЯ клетка, примыкающая к обойдённой
  // части лужи: между ней и start есть непрерывная водная дорога, и никакое
  // тело её не разделяет (вода не может пройти сквозь камень, но может
  // обогнуть его по луже). Пустая клетка сбоку от start находится сразу
  // (глубина 0) — прежний "сдвиг в сторону" остаётся частным случаем.
  //
  // Из кандидатов берётся не первый попавшийся (ближайший), а САМЫЙ НИЗКИЙ
  // (наибольший y) среди найденных в пределах EXTRA_LEVELS уровней BFS после
  // первого попадания; при равной высоте — ближайший. Чисто "ближайшее"
  // правило складывало всю вытесненную воду в один столбик вплотную к
  // борту тонущего тела (у широкого тела — по 10 клеток за кадр на каждую
  // сторону): столбик вырастал выше верха тела и переливался на него
  // сверху — снова "вода там, где её быть не должно", хоть и без
  // телепорта. Лужа под тяжестью стремится к ровному уровню, поэтому
  // лишняя вода должна выходить на самом низком доступном участке
  // поверхности — и тогда она ложится тонким расползающимся слоем вокруг
  // тела, а не иглой у борта. Обход всей компоненты целиком ради
  // глобально самой низкой точки был бы слишком дорог (см. бюджет ниже),
  // отсюда ограниченное окно EXTRA_LEVELS за первым попаданием.
  //
  // Перенос — не телепорт клетки start в цель, а сдвиг всей цепочки вдоль
  // найденного пути на одну клетку: цель <- последняя клетка пути <- ... <-
  // start, start пустеет. Так каждая частица уезжает лишь на клетку, и её
  // поля (температура, влажность) остаются там, где им физически место —
  // горячая вода у лавы не выпрыгивает вдруг на поверхность. Обмены идут
  // через swapFields (без ветра); ветер возмущается один раз, только у
  // start в направлении первого шага — для ветра это ОДНО перемещение.
  //
  // Кандидат отбрасывается, если прямо над ним стоит тело/сыпучее, которое
  // в ЭТОМ же кадре ещё только собирается упасть (см. isPendingFaller).
  // Клетки поля обходятся построчно снизу вверх, а цельное тело (блок
  // камня без опоры) — это много отдельных клеток, каждая падает сама: к
  // моменту, когда его нижний ряд уже съехал на клетку вниз, верхние ряды
  // ещё стоят, и между ними на долю кадра возникает пустая "щель". Она
  // ниже поверхности лужи, так что правило "самая низкая свободная
  // клетка" с радостью заливало бы её водой — вода оказывалась ВНУТРИ
  // тела, между его рядами, а верхний ряд затем должен был вытеснять её
  // заново (лишний поиск на каждую клетку каждого ряда). Физически же
  // тело едет вниз целиком, и никакой щели в нём нет: клетка над щелью
  // упадёт в неё ещё до конца кадра. Такие щели — не поверхность лужи, а
  // артефакт порядка обхода, и водой заполняться не должны. Верхняя грань
  // тела (над ней воздух/вода, а не падающая клетка) под правило не
  // попадает — вакантное место над ушедшим вниз телом вода занимает как и
  // положено.
  //
  // Все клетки пути помечаются moved: они уже сдвинулись в этом кадре, и
  // повторная обработка той же строкой дала бы им двойной ход.
  //
  // Бюджет DISPLACE_BUDGET ограничивает число обойдённых клеток (BFS с
  // отдельным поиском на каждую вытесняемую клетку — при широком теле их
  // десятки за кадр). Свободная поверхность на расстоянии d по луже
  // обходит ~2*d^2 клеток, так что бюджет покрывает глубину ~90 клеток;
  // дальше — false, и вызывающий делает прежний простой своп.
  displaceLiquidThroughBody(start) {
    const w = this.w, h = this.h;
    const type = this.type;
    // Путь ищется по "фазе" жидкости (см. LIQUID_PHASE): раствор и вода —
    // одна лужа, вытесняемая вода вольна выйти на поверхность сквозь
    // кислоту и наоборот.
    const ph = LIQUID_PHASE[type[start]];
    const visited = this._dispVisited;
    const parent = this._dispParent;
    const queue = this._dispQueue;
    const dist = this._dispDist;
    const gen = ++this._dispGen;
    const DISPLACE_BUDGET = 16384;
    const EXTRA_LEVELS = 16;
    // Случайный поворот порядка соседей на каждый поиск: при равной
    // дальности нескольких свободных клеток (типично — поверхность слева и
    // справа от тела) выбор не должен всегда падать на одну и ту же
    // сторону, иначе уровень у одного борта рос бы заметно быстрее.
    const rot = (Math.random() * 4) | 0;
    let head = 0, tail = 0;
    queue[tail++] = start; visited[start] = gen; parent[start] = -1; dist[start] = 0;
    let target = -1, from = -1, targetY = -1, stopDepth = -1;
    while (head < tail && head < DISPLACE_BUDGET) {
      const c = queue[head++];
      const depth = dist[c];
      if (stopDepth >= 0 && depth > stopDepth) break;
      const cx = c % w, cy = (c / w) | 0;
      for (let k = 0; k < 4; k++) {
        const d = (k + rot) & 3;
        let ni;
        if (d === 0) { if (cx === 0) continue; ni = c - 1; }
        else if (d === 1) { if (cx === w - 1) continue; ni = c + 1; }
        else if (d === 2) { if (cy === 0) continue; ni = c - w; }
        else { if (cy === h - 1) continue; ni = c + w; }
        const nt = type[ni];
        if (nt === EL.EMPTY) {
          if (ni >= w && this.isPendingFaller(ni - w)) continue;
          const ny = (ni / w) | 0;
          if (ny > targetY) { target = ni; from = c; targetY = ny; }
          if (stopDepth < 0) stopDepth = depth + EXTRA_LEVELS;
          continue;
        }
        if (LIQUID_PHASE[nt] !== ph || visited[ni] === gen) continue;
        visited[ni] = gen; parent[ni] = c; dist[ni] = depth + 1; queue[tail++] = ni;
      }
    }
    if (target < 0) return false;
    // Сдвиг цепочки от цели к start: "дырка" едет по пути назад к start.
    // Первая клетка пути после start (куда уехало содержимое start) нужна
    // для одиночного возмущения ветра — запоминаем её по дороге.
    let hole = target, cur = from, firstStep = target;
    while (cur >= 0) {
      this.swapFields(cur, hole);
      this.moved[hole] = 1;
      if (parent[cur] === start) firstStep = hole;
      hole = cur; cur = parent[cur];
    }
    this.disturbWind(start, firstStep);
    return true;
  }

  // Клетка j "ещё только собирается упасть в этом кадре": сыпучее, либо
  // структурная клетка, вышедшая за бюджет устойчивости (stability===0 —
  // см. updateCell, такие падают через updatePowder), и при этом ещё не
  // обработанная в этом кадре (moved===0). Используется в
  // displaceLiquidThroughBody, чтобы не заливать водой щели под ними.
  isPendingFaller(j) {
    if (this.moved[j]) return false;
    const t = this.type[j];
    if (t === EL.EMPTY) return false;
    const el = ELEMENTS[t];
    if (!el) return false;
    if (el.cat === CAT.POWDER) return true;
    return isStructural(t) && this.stability[j] === 0;
  }

  // Всплытие жидкости сквозь более плотную жидкость сверху. В отличие от
  // attemptSwapOrMove, пустая клетка сверху НЕ считается поводом для движения —
  // иначе любая осевшая жидкость с открытым воздухом над собой "кипела" бы,
  // бесконечно прыгая на клетку вверх-вниз (пустота не притягивает жидкость,
  // тянет только более лёгкая vs более тяжёлая жидкость друг сквозь друга).
  //
  // Это ЗЕРКАЛЬНЫЙ путь к тому же самому "тонущий объект вытесняет жидкость"
  // из attemptSwapOrMove — только инициатор здесь сама жидкость (смотрит
  // вверх, видит более плотное над собой, поднимается ему навстречу), а не
  // тонущий объект (смотрит вниз/по диагонали). Без своей собственной
  // проверки пути наружу этот путь тихо обходил бы стороной весь фикс
  // attemptSwapOrMove: тонущему объекту НЕ обязательно самому свопаться
  // вниз — запечатанная жидкость снизу с тем же успехом всплывёт В НЕГО
  // сама, и объект "провалится" тем же на вид результатом, только
  // инициированным с другого конца пары клеток.
  attemptBuoyantRise(i, ni, el) {
    const nt = this.type[ni];
    if (nt === EL.EMPTY) return false;
    const nEl = ELEMENTS[nt];
    if (!nEl || !isMovable(nEl.cat)) return false;
    if (nEl.density > el.density) {
      // Сверху не жидкость, а тонущее тело/сыпучее — это то же самое
      // вытеснение, что и в attemptSwapOrMove, только увиденное снизу;
      // считаем его там же (sinkIntoLiquid), чтобы вода не просачивалась
      // сквозь тело своими собственными всплытиями по одной клетке.
      if (nEl.cat !== CAT.LIQUID) return this.sinkIntoLiquid(ni, i);
      if (!this._liquidEscape[i]) return false;
      this.swap(i, ni); this.moved[ni] = 1; return true;
    }
    return false;
  }

  // windScale — см. tryWindPush; для настоящего сыпучего (песок и т.п.)
  // вызывается с 0 (эффект выключен, поведение как раньше), для осыпавшихся
  // структурных обломков — с ненулевым (см. вызов в updateCell).
  updatePowder(x, y, i, el, windScale) {
    const w = this.w, h = this.h;
    if (this.tryWindPush(x, y, i, el, windScale, 0.35, false)) return;
    if (y + 1 >= h) return;
    const bi = this.idx(x, y + 1);
    if (this.attemptSwapOrMove(i, bi, el, false)) return;
    const dir = windScale ? this.windDir(x, y, windScale) : (Math.random() < 0.5 ? 1 : -1);
    for (const dx of [dir, -dir]) {
      const nx = x + dx;
      if (nx < 0 || nx >= w) continue;
      // Диагональ вниз-вбок запрещена, если "боковая" клетка (та же строка,
      // куда сдвигаемся) занята — прямо вниз мы уже точно не можем (иначе
      // не дошли бы до этого цикла), так что занятая боковая клетка вместе
      // с занятой нижней означает, что диагональ ведёт ровно в угол стыка
      // двух препятствий, соприкасающихся только точкой, а не в настоящий
      // проход. Без этой проверки сыпучее (в т.ч. земля) просачивалось бы
      // сквозь такой угол, чего быть не должно — а жидкость (updateLiquid)
      // эта проверка не касается вовсе, у неё свой, отдельный код растекания.
      if (this.type[this.idx(nx, y)] !== EL.EMPTY) continue;
      const ni = this.idx(nx, y + 1);
      if (this.attemptSwapOrMove(i, ni, el, false)) return;
    }
  }

  // Порядок попыток намеренно "вниз -> в бок -> и только потом вверх":
  // всплытие сквозь более плотное вещество сверху (attemptBuoyantRise) —
  // единственный способ подняться строго вверх, и это на практике то же
  // самое, что происходит с жидкостью, которую топит тонущий тяжёлый
  // объект (тот проваливается вниз через неё точно такими же покл еточными
  // свопами). Раньше эта попытка шла ВТОРОЙ (сразу после падения вниз, до
  // растекания в стороны) — и из-за построчного (снизу вверх) обхода кадра
  // именно она успевала сработать раньше, чем жидкость вообще пробовала
  // податься вбок: тонущий объект каждый кадр выталкивал клетку жидкости
  // прямо над собой на одну клетку вверх, и так по цепочке — жидкость
  // громоздилась ровно колонкой над тонущим объектом до самой поверхности,
  // а не растекалась вокруг него, как в реальности. Теперь всплытие строго
  // вверх — последний вариант, после того как и диагональ-вниз, и обычное
  // горизонтальное растекание уже не нашли куда податься.
  updateLiquid(x, y, i, el) {
    const w = this.w, h = this.h;
    // Ветер должен уметь заметно расталкивать жидкость (не только чуть
    // смещать вероятность уже сработавшего растекания) — та же
    // "перебивающая" попытка, что и у газа/осыпавшихся тел, только слабее
    // (жидкость тяжелее, гравитацию перебивает не так легко).
    if (this.tryWindPush(x, y, i, el, 0.08, 0.3, false)) return;
    if (y + 1 < h) {
      const bi = this.idx(x, y + 1);
      if (this.attemptSwapOrMove(i, bi, el, false)) return;
    }
    const dir = this.windDir(x, y, 0.05);
    if (y + 1 < h) {
      for (const dx of [dir, -dir]) {
        const nx = x + dx;
        if (nx < 0 || nx >= w) continue;
        const ni = this.idx(nx, y + 1);
        if (this.attemptSwapOrMove(i, ni, el, false)) return;
      }
    }
    const disp = el.dispersion || 3;
    for (const dx0 of [dir, -dir]) {
      let targetStep = 0;
      for (let step = 1; step <= disp; step++) {
        const nx = x + dx0 * step;
        if (nx < 0 || nx >= w) break;
        if (this.type[this.idx(nx, y)] !== EL.EMPTY) break;
        targetStep = step;
      }
      if (targetStep > 0) {
        const ni = this.idx(x + dx0 * targetStep, y);
        this.swap(i, ni); this.moved[ni] = 1; return;
      }
    }
    if (y - 1 >= 0) {
      const ai = this.idx(x, y - 1);
      if (this.attemptBuoyantRise(i, ai, el)) return;
    }
  }

  updateGas(x, y, i, el) {
    const w = this.w;
    // Газ — самый лёгкий, ветер "перебивает" его обычное всплытие вверх
    // заметнее всего (у жидкости и осыпавшихся тел та же tryWindPush
    // работает с меньшим scale — см. их функции).
    if (this.tryWindPush(x, y, i, el, 0.2, 0.6, true)) return;
    if (y - 1 >= 0) {
      const ai = this.idx(x, y - 1);
      if (this.attemptSwapOrMove(i, ai, el, true)) return;
    }
    const dir = this.windDir(x, y, 0.15);
    if (y - 1 >= 0) {
      for (const dx of [dir, -dir]) {
        const nx = x + dx;
        if (nx < 0 || nx >= w) continue;
        const ni = this.idx(nx, y - 1);
        if (this.attemptSwapOrMove(i, ni, el, true)) return;
      }
    }
    if (Math.random() < 0.8) {
      const nx = x + dir;
      if (nx >= 0 && nx < w) {
        const ni = this.idx(nx, y);
        if (this.attemptSwapOrMove(i, ni, el, true)) return;
      }
    }
  }

  // ---- рисование ----

  setCell(x, y, elementId, onlyEmpty) {
    if (!this.inBounds(x, y)) return;
    const i = this.idx(x, y);
    if (onlyEmpty && this.type[i] !== EL.EMPTY) return;
    if (elementId === EL.EMPTY) this.clearCell(i);
    else this.spawn(i, elementId);
  }

  // onlyEmpty: не трогать уже занятые клетки (обычная кисть не должна
  // заменять то, что уже стоит на поле — только заливка делает замену осознанно).
  stampBrush(cx, cy, shape, rx, ry, elementId, onlyEmpty) {
    const x0 = Math.max(0, Math.floor(cx - rx)), x1 = Math.min(this.w - 1, Math.ceil(cx + rx));
    const y0 = Math.max(0, Math.floor(cy - ry)), y1 = Math.min(this.h - 1, Math.ceil(cy + ry));
    const rx2 = Math.max(rx, 0.5), ry2 = Math.max(ry, 0.5);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (shape === 'circle') {
          const dx = (x - cx) / rx2, dy = (y - cy) / ry2;
          if (dx * dx + dy * dy > 1) continue;
        }
        this.setCell(x, y, elementId, onlyEmpty);
      }
    }
  }

  stampLine(x0, y0, x1, y1, shape, rx, ry, elementId, onlyEmpty) {
    let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    let x = x0, y = y0;
    let guard = 0;
    const guardMax = (this.w + this.h) * 4 + 16;
    while (guard++ < guardMax) {
      this.stampBrush(x, y, shape, rx, ry, elementId, onlyEmpty);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
    }
  }

  floodFill(x0, y0, elementId, erase) {
    if (!this.inBounds(x0, y0)) return;
    const startI = this.idx(x0, y0);
    const target = this.type[startI];
    const replacement = erase ? EL.EMPTY : elementId;
    if (target === replacement) return;
    const w = this.w, h = this.h;
    const stack = [startI];
    const visited = new Uint8Array(w * h);
    visited[startI] = 1;
    while (stack.length) {
      const i = stack.pop();
      if (this.type[i] !== target) continue;
      if (replacement === EL.EMPTY) this.clearCell(i); else this.spawn(i, replacement);
      const x = i % w, y = (i / w) | 0;
      if (x > 0) { const ni = i - 1; if (!visited[ni]) { visited[ni] = 1; if (this.type[ni] === target) stack.push(ni); } }
      if (x < w - 1) { const ni = i + 1; if (!visited[ni]) { visited[ni] = 1; if (this.type[ni] === target) stack.push(ni); } }
      if (y > 0) { const ni = i - w; if (!visited[ni]) { visited[ni] = 1; if (this.type[ni] === target) stack.push(ni); } }
      if (y < h - 1) { const ni = i + w; if (!visited[ni]) { visited[ni] = 1; if (this.type[ni] === target) stack.push(ni); } }
    }
  }

  // ---- отмена (Ctrl+Z) ----

  // temp — часть отменяемого состояния, в отличие от ветра (windVX/VY,
  // см. комментарий в input.js про pressureInc/Dec): ветер — фоновое,
  // самопроизвольно гуляющее состояние, которое ни от чего "не зависит"
  // с точки зрения истории действий. Температура — иначе: она НАПРЯМУЮ
  // определяет, расплавится ли материал (reactMelt), и это необратимое,
  // "случившееся один раз" превращение. Без temp в снимке отмена вернёт
  // камню его type=STONE, но клетка сетки тепла останется такой же
  // горячей — и камень тут же расплавится заново на следующий же кадр,
  // так что отмена выглядела бы так, будто она вообще не сработала.
  snapshot() {
    return {
      type: this.type.slice(),
      life: this.life.slice(),
      extra: this.extra.slice(),
      shade: this.shade.slice(),
      temp: this.temp.slice(),
      moisture: this.moisture.slice(),
      sol: this.sol.slice(),
      colonistHomeX: this.colonistHomeX.slice(),
      colonistHomeY: this.colonistHomeY.slice(),
    };
  }

  restore(snap) {
    this.type.set(snap.type);
    this.life.set(snap.life);
    this.extra.set(snap.extra);
    this.shade.set(snap.shade);
    this.temp.set(snap.temp);
    if (snap.moisture) this.moisture.set(snap.moisture);
    else this.moisture.fill(0);
    if (snap.sol) this.sol.set(snap.sol);
    else this.sol.fill(0);
    if (snap.colonistHomeX) this.colonistHomeX.set(snap.colonistHomeX);
    else this.colonistHomeX.fill(-1);
    if (snap.colonistHomeY) this.colonistHomeY.set(snap.colonistHomeY);
    else this.colonistHomeY.fill(-1);
    this.moved.fill(0);
  }

  // ---- сохранение ----

  serialize() {
    return {
      v: 1, w: this.w, h: this.h,
      type: bufToB64(this.type.buffer),
      life: bufToB64(this.life.buffer),
      extra: bufToB64(this.extra.buffer),
      shade: bufToB64(this.shade.buffer),
      temp: bufToB64(this.temp.buffer),
      moisture: bufToB64(this.moisture.buffer),
      sol: bufToB64(this.sol.buffer),
      colonistHomeX: bufToB64(this.colonistHomeX.buffer),
      colonistHomeY: bufToB64(this.colonistHomeY.buffer),
    };
  }

  deserialize(obj) {
    if (!obj || obj.w !== this.w || obj.h !== this.h) return false;
    this.type.set(new Uint8Array(b64ToBuf(obj.type)));
    this.life.set(new Int16Array(b64ToBuf(obj.life)));
    this.extra.set(new Uint8Array(b64ToBuf(obj.extra)));
    this.shade.set(new Int8Array(b64ToBuf(obj.shade)));
    // temp/moisture/colonistHomeX/Y отсутствуют в файлах, сохранённых до их
    // появления — тогда явно обнуляем, а НЕ оставляем как есть: "как есть"
    // — это состояние ТЕКУЩЕЙ, ещё не выгруженной сессии, а не сохранённого
    // мира. Без явного обнуления что-нибудь горячее/мокрое, над чем шёл
    // эксперимент до нажатия "Загрузить", утекало бы в свежезагруженный
    // мир, где ничего подобного в принципе быть не должно.
    if (obj.temp) this.temp.set(new Float32Array(b64ToBuf(obj.temp)));
    else this.temp.fill(0);
    if (obj.moisture) this.moisture.set(new Uint8Array(b64ToBuf(obj.moisture)));
    else this.moisture.fill(0);
    if (obj.sol) this.sol.set(new Uint16Array(b64ToBuf(obj.sol)));
    else this.sol.fill(0);
    if (obj.colonistHomeX) this.colonistHomeX.set(new Int16Array(b64ToBuf(obj.colonistHomeX)));
    else this.colonistHomeX.fill(-1);
    if (obj.colonistHomeY) this.colonistHomeY.set(new Int16Array(b64ToBuf(obj.colonistHomeY)));
    else this.colonistHomeY.fill(-1);
    this.moved.fill(0);
    return true;
  }
}
