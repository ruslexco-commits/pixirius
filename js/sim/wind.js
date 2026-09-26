'use strict';

// Потоки воздуха: грубая сетка ветра (airCell x airCell клеток на одну),
// её диффузия и затухание, возмущение от движения частиц, толчок вещества
// ветром и кисть давления.
//
// Методы класса Sim, вынесенные в отдельный файл: класс ниже — только
// контейнер, extendSim переносит его методы в Sim.prototype (см. core.js).

// Порог, ниже которого поток вещество не двигает вовсе.
//
// Без него получалась самоподдерживающаяся карусель: каждое движение
// частицы слегка толкает воздух (disturbWind), этого хватало, чтобы
// сдвинуть соседнюю частицу, та толкала воздух дальше — и всё, что игрок
// ни поставит, медленно уносило «как пыль» в поток, который никогда не
// затихал, потому что сам себя и подпитывал.
//
// Теперь фоновая рябь от падающих капель и осыпающегося песка честно
// остаётся рябью: двигает вещество только поток, заметно превосходящий
// её — то есть нагнетённый кистью давления или поднятый взрывом.
const WIND_PUSH_MIN = 0.45;

// Math.hypot(a, b) побитно, но втрое быстрее встроенного — повтор его же
// алгоритма из V8 (src/builtins/math.tq: деление на наибольший модуль и
// сумма квадратов с компенсацией Кэхэна). Встроенный hypot в updateWind
// зовётся 4 * 11664 раза за кадр и один съедал ~2 мс из 3. Простой
// Math.sqrt(a*a + b*b) быстрее ещё, но в последнем бите расходится с
// hypot почти у половины входов — ветер пошёл бы по-другому, и
// tools/compare.js это ловит. Этот вариант сверен с Math.hypot на 2e7
// случайных входах без единого расхождения. Только для конечных чисел
// (ветер всегда конечен); NaN/Infinity не обрабатываются.
function windHypot(a, b) {
  a = Math.abs(a); b = Math.abs(b);
  const m = a > b ? a : b;
  if (m === 0) return 0;
  const x = a / m, y = b / m;
  let sum = 0, comp = 0;
  let s = x * x - comp; let p = sum + s; comp = (p - sum) - s; sum = p;
  s = y * y - comp; p = sum + s; sum = p;
  return Math.sqrt(sum) * m;
}

class SimWind {
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
    // Возмущение воздуха от одного шага частицы. Втрое слабее прежнего:
    // именно сумма этих толчков от всего падающего и текущего на карте и
    // раскручивала тот самый вечный поток.
    const DISTURB = 0.01;
    this.windVX[ai] += dx * DISTURB;
    this.windVY[ai] += dy * DISTURB;
  }

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
    // Стек заливки — typed-массив на все клетки, а не JS-массив с
    // push/pop (компонента не больше поля, переполниться ему нечем).
    const stack = this._debrisStack || (this._debrisStack = new Int32Array(n));
    const type = this.type, h = this.h, windFrame = this.windVXFrame;
    const rowOf = this._airRowOf, colOf = this._airColOf;
    // Только клетки кусков, которые считаются в этом кадре (sim/sleep.js):
    // кэш читают лишь их обломки. Порядок — тот же, что по возрастанию i.
    const active = this._chunkActive, cw = this._chunkW;
    for (let y = 0; y < h; y++) {
     const rowChunk = ((y / SLEEP_CHUNK) | 0) * cw;
     for (let ck = 0; ck < cw; ck++) {
      if (!active[rowChunk + ck]) continue;
      const xe = Math.min(w, (ck + 1) * SLEEP_CHUNK);
      for (let i = y * w + ck * SLEEP_CHUNK; i < y * w + xe; i++) {
      // Сперва тип, потом visited: у клетки, которая не обломок, флаг
      // visited ни на что не влияет (заливка ниже её всё равно не возьмёт —
      // тип другой), а проверка по таблице дешевле записи флага в каждую
      // из 187 тыс. клеток.
      const t = type[i];
      if (IS_STRUCTURAL[t] !== 1 || stab[i] !== 0) continue;
      if (visited[i]) continue;
      visited[i] = 1;
      const y0 = (i / w) | 0;
      const wind = windFrame[rowOf[y0] + colOf[i - y0 * w]];  // = getWindVX(x, y)
      cache[i] = wind;
      let sp = 0;
      stack[sp++] = i;
      // Порядок обхода на итог не влияет: помечены будут та же компонента
      // и её граница, и всей компоненте пишется одно и то же wind.
      while (sp > 0) {
        const ci = stack[--sp];
        const cy = (ci / w) | 0, cx = ci - cy * w;
        if (cx > 0) {
          const ni = ci - 1;
          if (!visited[ni]) { visited[ni] = 1; if (type[ni] === t && stab[ni] === 0) { cache[ni] = wind; stack[sp++] = ni; } }
        }
        if (cx < w - 1) {
          const ni = ci + 1;
          if (!visited[ni]) { visited[ni] = 1; if (type[ni] === t && stab[ni] === 0) { cache[ni] = wind; stack[sp++] = ni; } }
        }
        if (cy > 0) {
          const ni = ci - w;
          if (!visited[ni]) { visited[ni] = 1; if (type[ni] === t && stab[ni] === 0) { cache[ni] = wind; stack[sp++] = ni; } }
        }
        if (cy < h - 1) {
          const ni = ci + w;
          if (!visited[ni]) { visited[ni] = 1; if (type[ni] === t && stab[ni] === 0) { cache[ni] = wind; stack[sp++] = ni; } }
        }
      }
      }
     }
    }
  }

  // Помечает клетки сетки ветра, содержащие хотя бы одну непроницаемую
  // клетку симуляции (см. isAirtight), как полностью закрытые. Пересчитывается
  // каждый кадр перед диффузией, т.к. стена/металл могут появляться, а
  // обломки — падать и открывать проход.
  //
  // Полный проход — только в первый раз; дальше пересчитываются лишь клетки
  // ветра в кусках поля, где что-то менялось (chunkChanged, sim/sleep.js):
  // стена и металл без записи в клетку не появляются и не исчезают. Кусок
  // сна кратен клетке ветра (SLEEP_CHUNK % airCell === 0), так что клетка
  // ветра всегда целиком в одном куске.
  computeAirBlock() {
    const w = this.w, h = this.h, ac = this.airCell, aw = this.airW;
    const blocked = this._airBlocked, open = this.airOpen, type = this.type;
    if (!this._airBlockValid) {
      blocked.fill(0);
      for (let y = 0; y < h; y++) {
        const rowBase = ((y / ac) | 0) * aw;
        const off = y * w;
        for (let x = 0; x < w; x++) {
          if (IS_AIRTIGHT[type[off + x]] === 1) blocked[rowBase + ((x / ac) | 0)] = 1;
        }
      }
      for (let ai = 0; ai < aw * this.airH; ai++) open[ai] = blocked[ai] ? 0 : 1;
      this._airBlockValid = true;
      return;
    }
    const count = this._chunkW * this._chunkH;
    for (let c = 0; c < count; c++) {
      if (!this.chunkChanged(c)) continue;
      const [x0, y0, x1, y1] = this.chunkBounds(c);
      const ax0 = (x0 / ac) | 0, ax1 = ((x1 - 1) / ac) | 0, ay0 = (y0 / ac) | 0, ay1 = ((y1 - 1) / ac) | 0;
      for (let ay = ay0; ay <= ay1; ay++) for (let ax = ax0; ax <= ax1; ax++) blocked[ay * aw + ax] = 0;
      for (let y = y0; y < y1; y++) {
        const rowBase = ((y / ac) | 0) * aw;
        const off = y * w;
        for (let x = x0; x < x1; x++) {
          if (IS_AIRTIGHT[type[off + x]] === 1) blocked[rowBase + ((x / ac) | 0)] = 1;
        }
      }
      for (let ay = ay0; ay <= ay1; ay++) for (let ax = ax0; ax <= ax1; ax++) open[ay * aw + ax] = blocked[ay * aw + ax] ? 0 : 1;
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
    // Трение воздуха. Усилено (0.997 -> 0.992): поток должен затихать за
    // считанные секунды, если его перестали подпитывать, а не жить минуту.
    const DECAY = 0.992;
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
    // Полный штиль (частый случай в спокойном мире: ветер от движения
    // гаснет до нуля) — диффузия нулей даёт нули, её можно не считать.
    let any = false;
    for (let ai = 0; ai < an; ai++) if (vx[ai] !== 0 || vy[ai] !== 0) { any = true; break; }
    if (!any) return;
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
          const rate = Math.min(DIFFUSE_MAX, DIFFUSE_BASE + windHypot(diffX, diffY) * DIFFUSE_GAIN);
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

  // Снимок ветра на кадр (см. windVXFrame в конструкторе) и попутно —
  // есть ли в нём вообще ветер, способный что-то толкнуть. Обычно нет: в
  // спокойном мире tryWindPush на каждой частице жидкости и газа читала
  // бы ветер только затем, чтобы отказать. Сумма максимумов модулей по
  // осям — верхняя граница для |vx| + |vy| любой клетки, читающей снимок,
  // так что _windPushQuiet = true — это ровно тот же ответ, что дала бы
  // проверка mag <= WIND_PUSH_MIN в tryWindPush, только один раз за кадр
  // (обломки — исключение, см. там).
  snapshotWindFrame() {
    const fx = this.windVXFrame, fy = this.windVYFrame;
    fx.set(this.windVX);
    fy.set(this.windVY);
    let mx = 0, my = 0;
    for (let k = 0; k < fx.length; k++) {
      const ax = Math.abs(fx[k]), ay = Math.abs(fy[k]);
      if (ax > mx) mx = ax;
      if (ay > my) my = ay;
    }
    this._windPushQuiet = mx + my <= WIND_PUSH_MIN;
  }

  // Читают ЗАМОРОЖЕННЫЙ снимок (windVXFrame/windVYFrame), а не живые
  // windVX/windVY — см. комментарий в конструкторе про windVXFrame.
  getWindVX(x, y) { return this.windVXFrame[this.airIdx(x, y)]; }

  getWindVY(x, y) { return this.windVYFrame[this.airIdx(x, y)]; }

  // Направление ±1 по X, статистически смещённое локальным ветром — не
  // жёстко диктует направление (иначе газ/жидкость в потоке выглядели бы
  // механически), а лишь делает движение "по ветру" вероятнее. scale задаёт
  // силу влияния: у газа заметно сильнее, чем у более тяжёлой жидкости.
  // Сравнивается с ОБЩИМ на кадр _windRoll (см. tryWindPush — та же причина).
  // Для осыпавшихся структурных обломков берёт кэш всей компоненты (см.
  // computeDebrisWindChance), а не свою точку — та же причина, что и там.
  windDir(x, y, scale) {
    const i = this.idx(x, y);
    const wind = (IS_STRUCTURAL[this.type[i]] === 1 && this.stability[i] === 0)
      ? this._debrisWindVX[i]
      : this.windVXFrame[this._airRowOf[y] + this._airColOf[x]];  // = getWindVX(x, y)
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
  // Толчок ветром. Поток не просто подкручивает вероятность обычного
  // движения, а РАЗДВИГАЕТ вещество: нагнетённое в озере давление
  // расшвыривает воду во все стороны, а поданное под падающий камень —
  // подкидывает его вверх.
  //
  // Раньше учитывалась только горизонтальная составляющая, и вертикальный
  // поток не двигал ничего вовсе: сколько ни дуй снизу, объект продолжал
  // спокойно падать. Теперь берутся обе оси, и толчок пробуется сначала
  // вдоль сильнейшей из них, а если там занято — вдоль второй.
  //
  // Движение ВВЕРХ передаётся в attemptSwapOrMove как подъём (rising),
  // иначе тяжёлое не смогло бы обменяться с более лёгким над собой и
  // поток снизу упирался бы в собственную воду.
  tryWindPush(x, y, i, el, windScale, maxChance, rising) {
    if (!windScale) return false;
    // Для клеток структурного мусора (stability===0) берём ЕДИНЫЙ на весь
    // связный кусок ветер из computeDebrisWindChance, а не локальный —
    // иначе даже с общим roll и заморозкой снимка разные клетки одной
    // цепочки могут со временем накопить разный локальный ветер (реальный
    // пространственный градиент вдоль широкого объекта) и разойтись.
    const debris = IS_STRUCTURAL[this.type[i]] === 1 && this.stability[i] === 0;
    // Штиль во всём кадре (см. snapshotWindFrame) — только для не-обломков:
    // кэш обломка, задетого заливкой чужого материала, в этом кадре не
    // обновляется и может хранить ветер прошлых кадров, выше нынешнего
    // максимума.
    if (!debris && this._windPushQuiet) return false;
    const ai = this._airRowOf[y] + this._airColOf[x];  // = airIdx(x, y)
    const vx = debris ? this._debrisWindVX[i] : this.windVXFrame[ai];
    const vy = this.windVYFrame[ai];
    const ax = Math.abs(vx), ay = Math.abs(vy);
    const mag = ax + ay;
    // Слабее порога — это фоновая рябь, а не ветер (см. WIND_PUSH_MIN).
    // Считаем силу толчка от ИЗБЫТКА над порогом, иначе у самой границы
    // поток дёргал бы вещество рывками.
    if (mag <= WIND_PUSH_MIN) return false;
    const chance = Math.min(maxChance, (mag - WIND_PUSH_MIN) * windScale);
    if (this._windRoll >= chance) return false;
    const horizFirst = ax >= ay;
    for (let pass = 0; pass < 2; pass++) {
      const horiz = pass === 0 ? horizFirst : !horizFirst;
      let dx = 0, dy = 0;
      if (horiz) { if (!ax) continue; dx = vx > 0 ? 1 : -1; }
      else { if (!ay) continue; dy = vy > 0 ? 1 : -1; }
      const nx = x + dx, ny = y + dy;
      if (!this.inBounds(nx, ny)) continue;
      const ni = this.idx(nx, ny);
      // Соседняя клетка ТОГО ЖЕ материала, вытянутого вдоль направления
      // толчка (например, горизонтальная палка, которую толкает
      // ГОРИЗОНТАЛЬНО), ещё не сдвинулась в этом кадре и потому блокирует
      // одиночный своп — а раз следующая клетка дальше по цепочке в
      // СЛЕДУЮЩЕЙ итерации того же кадра решит толкнуться туда же (тот же
      // общий бросок, тот же локальный ветер), одиночные свопы просто
      // упирались бы друг в друга, и толкалась бы только передняя кромка,
      // отрываясь от остального куска. Сдвигаем всю связную цепочку одним
      // атомарным действием вместо этого.
      if (horiz && this.type[ni] === this.type[i]) {
        if (this.shiftChain(x, y, dx, el, rising)) return true;
        continue;
      }
      if (this.attemptSwapOrMove(i, ni, el, dy < 0 ? true : rising)) return true;
    }
    return false;
  }

  // Сдвигает связную цепочку клеток одного материала, начинающуюся в (x,y)
  // и тянущуюся в направлении wdir, на один шаг в ту же сторону целиком —
  // но только если на дальнем конце цепочки вообще есть куда деться (пусто
  // или вытесняемая более лёгкая/плотная — как в attemptSwapOrMove —
  // жидкость/газ/сыпучее). Все клетки цепочки и принимающая клетка на
  // дальнем конце помечаются moved, чтобы не обработаться повторно в этом
  // же кадре. maxChain ограничивает длину поиска.
  shiftChain(x, y, wdir, el, rising) {
    const t = this.type[this.idx(x, y)];
    const maxChain = 64;
    const chain = [this.idx(x, y)];
    let cx = x;
    for (let step = 1; step <= maxChain; step++) {
      const nx = cx + wdir;
      // _colMin.._colMax — всё поле, а при параллельном обходе своя полоса
      // с запасом (sim/threads.js): цепочка длиннее запаса за край полосы
      // в этот кадр не сдвигается.
      if (nx < this._colMin || nx > this._colMax) return false;
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
    // Кисть бьёт заметно сильнее фоновой ряби — иначе после введения
    // порога WIND_PUSH_MIN от неё почти ничего не оставалось: она сама
    // еле переваливала за порог, и от нагнетённого давления озеро только
    // морщилось. Фон при этом на порядок слабее и порога по-прежнему не
    // достаёт.
    const PUSH = 1.6;
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
}

extendSim(SimWind);
