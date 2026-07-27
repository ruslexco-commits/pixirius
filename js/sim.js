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
  }

  spawn(i, id) {
    this.type[i] = id;
    this.shade[i] = (Math.random() * 30 - 15) | 0;
    this.extra[i] = 0;
    switch (id) {
      case EL.ACID: this.life[i] = 50 + (Math.random() * 40 | 0); break;
      case EL.STEAM: this.life[i] = 90 + (Math.random() * 60 | 0); break;
      case EL.SMOKE: this.life[i] = 50 + (Math.random() * 40 | 0); break;
      case EL.FIRE: this.life[i] = 18 + (Math.random() * 14 | 0); break;
      default: this.life[i] = 0;
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
  }

  swap(i, j) {
    let t = this.type[i]; this.type[i] = this.type[j]; this.type[j] = t;
    t = this.life[i]; this.life[i] = this.life[j]; this.life[j] = t;
    t = this.extra[i]; this.extra[i] = this.extra[j]; this.extra[j] = t;
    t = this.shade[i]; this.shade[i] = this.shade[j]; this.shade[j] = t;
    this.disturbWind(i, j);
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
      // Содержимое принимающей клетки "оборачивается" в начало цепочки —
      // остальные клетки просто получают содержимое своего предшественника,
      // идём с дальнего конца к ближнему, чтобы не затереть источник раньше времени.
      const farType = this.type[ni], farLife = this.life[ni], farExtra = this.extra[ni], farShade = this.shade[ni];
      for (let k = chain.length - 1; k >= 0; k--) {
        const to = (k === chain.length - 1) ? ni : chain[k + 1];
        const from = chain[k];
        this.type[to] = this.type[from];
        this.life[to] = this.life[from];
        this.extra[to] = this.extra[from];
        this.shade[to] = this.shade[from];
        this.moved[to] = 1;
      }
      this.type[chain[0]] = farType;
      this.life[chain[0]] = farLife;
      this.extra[chain[0]] = farExtra;
      this.shade[chain[0]] = farShade;
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
      case EL.ACID: this.reactAcid(x, y, i); break;
      case EL.STEAM: this.reactSteam(x, y, i); break;
      case EL.SMOKE: this.reactSmoke(x, y, i); break;
      case EL.SAND: this.reactSand(x, y, i); break;
      case EL.SALT: this.reactSalt(x, y, i); break;
      case EL.WATER: this.reactWater(x, y, i); break;
      case EL.VOID: this.reactVoid(x, y, i); break;
      case EL.CLONE: this.reactClone(x, y, i); break;
      case EL.STONE: case EL.METAL: case EL.GLASS: this.reactMelt(x, y, i, id); break;
    }
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

  reactLava(x, y, i) {
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

  reactAcid(x, y, i) {
    for (let k = 0; k < 4; k++) {
      const nx = x + DX4[k], ny = y + DY4[k];
      if (!this.inBounds(nx, ny)) continue;
      const ni = this.idx(nx, ny);
      const nt = this.type[ni];
      if (nt === EL.EMPTY || nt === EL.ACID) continue;
      const nel = ELEMENTS[nt];
      if (nel.acidImmune) continue;
      const chance = nel.acidSlow ? 0.015 : 0.06;
      if (Math.random() < chance) {
        this.clearCell(ni);
        this.life[i] -= 3;
      }
    }
    if (this.life[i] <= 0) this.clearCell(i);
  }

  reactSteam(x, y, i) {
    this.life[i]--;
    if (this.life[i] <= 0 || Math.random() < 0.01) this.spawn(i, EL.WATER);
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

  // Твёрдые материалы плавятся в лаву у огня/лавы. Дерево/масло(-плёнка)/
  // порох сюда не входят — у них своя реакция горения (reactFlammable);
  // лёд тоже не входит — у него уже есть reactIce (топится в воду, а не
  // в лаву, плюс попутно замораживает воду рядом — отдельный, не сводимый
  // к простому "плавлению" механизм). meltChance/meltsInto — данные на
  // элементе (см. elements.js), тот же принцип, что и burnChance у горючих:
  // generic-функция, а не отдельная реакция на каждый плавящийся материал.
  reactMelt(x, y, i, id) {
    const el = ELEMENTS[id];
    for (let k = 0; k < 4; k++) {
      const nx = x + DX4[k], ny = y + DY4[k];
      if (!this.inBounds(nx, ny)) continue;
      const nt = this.type[this.idx(nx, ny)];
      if (nt === EL.FIRE || nt === EL.LAVA) {
        if (Math.random() < el.meltChance) this.spawn(i, el.meltsInto);
        return;
      }
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

  reactWater(x, y, i) {
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

  // ---- движение по категориям ----

  attemptSwapOrMove(i, ni, el, rising) {
    const nt = this.type[ni];
    if (nt === EL.EMPTY) { this.swap(i, ni); this.moved[ni] = 1; return true; }
    const nEl = ELEMENTS[nt];
    if (!nEl || !isMovable(nEl.cat)) return false;
    if (rising ? (nEl.density > el.density) : (nEl.density < el.density)) {
      this.swap(i, ni); this.moved[ni] = 1; return true;
    }
    return false;
  }

  // Всплытие жидкости сквозь более плотную жидкость сверху. В отличие от
  // attemptSwapOrMove, пустая клетка сверху НЕ считается поводом для движения —
  // иначе любая осевшая жидкость с открытым воздухом над собой "кипела" бы,
  // бесконечно прыгая на клетку вверх-вниз (пустота не притягивает жидкость,
  // тянет только более лёгкая vs более тяжёлая жидкость друг сквозь друга).
  attemptBuoyantRise(i, ni, el) {
    const nt = this.type[ni];
    if (nt === EL.EMPTY) return false;
    const nEl = ELEMENTS[nt];
    if (!nEl || !isMovable(nEl.cat)) return false;
    if (nEl.density > el.density) {
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
      const ni = this.idx(nx, y + 1);
      if (this.attemptSwapOrMove(i, ni, el, false)) return;
    }
  }

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
    if (y - 1 >= 0) {
      const ai = this.idx(x, y - 1);
      if (this.attemptBuoyantRise(i, ai, el)) return;
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

  snapshot() {
    return {
      type: this.type.slice(),
      life: this.life.slice(),
      extra: this.extra.slice(),
      shade: this.shade.slice(),
    };
  }

  restore(snap) {
    this.type.set(snap.type);
    this.life.set(snap.life);
    this.extra.set(snap.extra);
    this.shade.set(snap.shade);
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
    };
  }

  deserialize(obj) {
    if (!obj || obj.w !== this.w || obj.h !== this.h) return false;
    this.type.set(new Uint8Array(b64ToBuf(obj.type)));
    this.life.set(new Int16Array(b64ToBuf(obj.life)));
    this.extra.set(new Uint8Array(b64ToBuf(obj.extra)));
    this.shade.set(new Int8Array(b64ToBuf(obj.shade)));
    this.moved.fill(0);
    return true;
  }
}
