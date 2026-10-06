'use strict';

// Пятно контакта: падающее тело давит на то, на что приземлилось (просьба
// пользователя).
//
// У каждого пикселя твёрдого своя масса (PIXEL_MASS: железо 0.2). Тело —
// связная группа пикселей, падавших вместе (поле fall), — в кадре, когда
// оно встало на опору, давит своей массой на пятно контакта: те свои
// пиксели, под которыми твёрдое. Давление на пиксель пятна — масса тела,
// делённая на площадь пятна. Если оно больше стойкости поверхности (её
// максимальной устойчивости: железо 10, камень 5, дерево 3), от пятна
// контакта, как сигнал, волной во все восемь сторон — и в поверхность, и
// в само тело — расходится стойкость 0 (поле crushed), пока пятно не
// станет приемлемым: пока масса / число продавленных не станет не больше
// стойкости.
//
// Продавленный пиксель стоит с устойчивостью 0 и осыпается, как обломок,
// если ему есть куда: тонкий пол над пустотой проламывается, край тела у
// места удара обсыпается. Толстому полу и зажатым пикселям деваться
// некуда — они остаются на месте. Опору дальше продавленный при этом
// передаёт как обычно (computeStability, zeroCrushedStability): осыпание
// начинается от пятна контакта и им ограничено, а остальное тело и пол
// держатся, как держались. Через CRUSH_FRAMES кадров пятно уже выдержало
// вес, и продавленное возвращается в обычное состояние.
//
// Вещество сохраняется: пиксели ничем не заменяются и не перекрашиваются,
// только на время теряют стойкость и двигаются обычными обменами.
//
// История (все версии — по просьбам пользователя):
// - первая: продавленное не передавало опору, навсегда. Тело, вставшее на
//   него, целиком теряло устойчивость и рассыпалось как песок — начиная с
//   верхних углов, вдали от удара ("ударилась справа, а осыпался левый
//   верхний угол");
// - вторая: тело само вдавливалось во вмятину, продавленное выдавливалось
//   на край валиком — "выглядит странно", откатили;
// - третья: как первая, но с продавленным под телом в площади пятна —
//   куча всё равно рассыпалась от углов, а пол оставался продавленным
//   навсегда. Отсюда нынешние правила: волна идёт и в тело, продавленное
//   передаёт опору и через время снова обычное.
// Продавленный пиксель раньше ещё и темнел — выглядело так, будто в полу
// появилось другое вещество; больше не темнеет.
//
// Пример из просьбы: куб железа 10x10 — 100 пикселей по 0.2, масса 20. На
// ровное дно в 10 пикселей он давит по 2 — меньше стойкости железа 10,
// вмятины нет. Тот же куб с выступающим снизу пикселем давит на один
// пиксель всей массой 20 — больше 10: продавится пятно в 20 / 10 = 2
// пикселя (плюс сам выступ в теле уже 101-й пиксель, масса 20.2 — 3).
//
// Стена и прочие якоря не продавливаются, и волна сквозь них не идёт.
// Сыпучее, жидкость и балка под телом пятном не считаются — давит только
// твёрдое на твёрдое.
//
// Скатывание (просьба пользователя: "когда что-то твёрдое падает на склон,
// пусть оно скатывается"). Раньше тело, коснувшееся склона одним углом,
// получало опору через этот угол и так и застывало, нависнув над склоном.
// Теперь приземлившееся тело, у которого центр масс дальше ROLL_MARGIN за
// краем того, на что оно опирается снизу, съезжает целиком на клетку по
// диагонали вниз, в сторону центра масс, и остаётся падающим (fall): в
// следующем кадре оно снова либо падает, либо приземляется и съезжает
// дальше. Так до ровного места (опора под центром масс) или пока путь
// вниз-вбок не закроется — пологие ступени тело держат, как трение. Тело
// не поворачивается (пиксельное тело без искажений не повернуть) и не
// продавливает склон по пути — пятно контакта считается, когда оно встало.
//
// Методы класса Sim, вынесенные в отдельный файл: класс ниже — только
// контейнер, extendSim переносит его методы в Sim.prototype (см. core.js).

// Масса пикселя твёрдого. Чего нет в таблице — LANDING_DEFAULT_MASS.
const LANDING_DEFAULT_MASS = 0.1;
const PIXEL_MASS = new Float64Array(64).fill(LANDING_DEFAULT_MASS);
PIXEL_MASS[EL.METAL] = 0.2;
PIXEL_MASS[EL.STEEL] = 0.22;
PIXEL_MASS[EL.STONE] = 0.14;
PIXEL_MASS[EL.OXIDE] = 0.12;
PIXEL_MASS[EL.METAL_OXIDE] = 0.16;
PIXEL_MASS[EL.GLASS] = 0.1;
PIXEL_MASS[EL.WOOD] = 0.05;
for (const id of [EL.ICE, EL.ACID_ICE, EL.REAGENT_ICE, EL.DISSOLVER_ICE]) PIXEL_MASS[id] = 0.07;
PIXEL_MASS[EL.WET_EARTH] = 0.1;
PIXEL_MASS[EL.OILFILM] = 0.02;
for (const id of [EL.CAMERA, EL.MONITOR, EL.SOLAR, EL.GENERATOR, EL.AMPLIFIER]) PIXEL_MASS[id] = 0.2;
PIXEL_MASS[EL.LAMP] = PIXEL_MASS[EL.GLASS];
PIXEL_MASS[EL.COPPER] = 0.2;
PIXEL_MASS[EL.COPPER_OXIDE] = 0.16;
PIXEL_MASS[EL.INSULATOR] = 0.04;

// Самое большое тело и самое большое пятно, что обсчитываются за раз.
const LANDING_MAX_BODY = 20000;
const LANDING_MAX_PATCH = 4000;
// Сколько кадров пиксель остаётся продавленным: за это время то, чему есть
// куда, успевает осыпаться (обломок падает на клетку в кадр), дальше пятно
// держит вес, и пиксель снова обычный.
const CRUSH_FRAMES = 30;
// Насколько (в клетках) центр масс должен выйти за край опоры, чтобы тело
// скатилось: на полклетки — ровно над крайним пикселем опоры тело стоит.
const ROLL_MARGIN = 0.5;

class SimLanding {
  // Раз в кадр, сразу после пересчёта устойчивости. Сначала отсчёт
  // продавленных — он идёт каждый кадр. Потом тела, которые падали и
  // теперь стоят (fall и устойчивость больше нуля), давят на пятно
  // контакта; новые устоявшиеся клетки бывают только в кадре, где
  // устойчивость пересчитывалась, — в остальных этот проход не нужен.
  updateLanding() {
    if (this._crushLive) this.tickCrushed();
    if (!this._stabRecomputed) return;
    const type = this.type, fall = this.fall, stab = this.stability, crushed = this.crushed;
    // Клеток с fall единицы (осыпающиеся обломки), поэтому поле читается
    // словами по 4 клетки, сплошь, без разбивки по спящим кускам: так
    // проход в разы дешевле (обход по кускам 16x16 стоил ~0.2 мс в кадр на
    // 576x324). Вид на массив пересоздаётся, только если сменился сам
    // массив (потоки, отмена).
    const n = fall.length;
    let i = 0;
    const fall32 = this.landWords(fall, '_fall32');
    if (fall32 !== null) {
      const words = n >> 2;
      for (let k = 0; k < words; k++) {
        if (fall32[k] === 0) continue;
        for (let j = k << 2, e = j + 4; j < e; j++) if (fall[j] !== 0) this.landCheck(j, type, stab, crushed);
      }
      i = words << 2;
    }
    for (; i < n; i++) if (fall[i] !== 0) this.landCheck(i, type, stab, crushed);
    // Съехавшие тела снова падают. Пометку ставим после прохода: иначе
    // проход дошёл бы до них на новом месте и сдвинул ещё раз в том же кадре.
    const rolled = this._rolled;
    if (rolled && rolled.length) {
      for (let k = 0; k < rolled.length; k++) fall[rolled[k]] = 1;
      rolled.length = 0;
    }
  }

  // Вид Uint32Array на байтовое поле (по 4 клетки в слове) или null, если
  // поле не выровнено. Кэш в this[key], пересоздаётся при смене массива.
  landWords(arr, key) {
    if ((arr.byteOffset & 3) !== 0) return null;
    const src = key + 'Src';
    if (this[src] !== arr) { this[key] = new Uint32Array(arr.buffer, arr.byteOffset, arr.length >> 2); this[src] = arr; }
    return this[key];
  }

  // Отсчёт продавленных: по кадру с каждого; дошёл до нуля — пиксель снова
  // обычный (пересчёт устойчивости заметит это по подписи structureChanged,
  // markDirty будит кусок). _crushLive — сколько продавленных осталось; он
  // же пересчитывается здесь заново (клетку могли стереть кистью или
  // отменой).
  tickCrushed() {
    const crushed = this.crushed, n = crushed.length;
    let live = 0, i = 0;
    const w32 = this.landWords(crushed, '_crushed32');
    if (w32 !== null) {
      const words = n >> 2;
      for (let k = 0; k < words; k++) {
        if (w32[k] === 0) continue;
        for (let j = k << 2, e = j + 4; j < e; j++) if (crushed[j] !== 0) live += this.tickCrushedCell(j);
      }
      i = words << 2;
    }
    for (; i < n; i++) if (crushed[i] !== 0) live += this.tickCrushedCell(i);
    this._crushLive = live;
  }

  tickCrushedCell(i) {
    if (--this.crushed[i] !== 0) return 1;
    // Вернулся в обычное состояние. Пометку падения снимаем: иначе,
    // устояв, он "приземлился" бы и давил на пол своей массой вместе с
    // соседями по пятну.
    this.fall[i] = 0;
    this.markDirty(i);
    return 0;
  }

  // Конец computeStability: продавленные стоят с устойчивостью 0 (опору
  // дальше они уже передали).
  zeroCrushedStability() {
    const crushed = this.crushed, stab = this.stability, n = crushed.length;
    let i = 0;
    const w32 = this.landWords(crushed, '_crushed32');
    if (w32 !== null) {
      const words = n >> 2;
      for (let k = 0; k < words; k++) {
        if (w32[k] === 0) continue;
        for (let j = k << 2, e = j + 4; j < e; j++) if (crushed[j] !== 0) stab[j] = 0;
      }
      i = words << 2;
    }
    for (; i < n; i++) if (crushed[i] !== 0) stab[i] = 0;
  }

  // Клетка с fall: не твёрдое — пометка больше не нужна; ещё падает —
  // ждать; стоит — тело приземлилось.
  landCheck(i, type, stab, crushed) {
    if (IS_STRUCTURAL[type[i]] !== 1) { this.fall[i] = 0; return; }
    if (stab[i] === 0 || crushed[i] !== 0) return;
    this.landBody(i);
  }

  // Тело, в которое входит клетка start, приземлилось: масса, пятно
  // контакта, продавливание.
  landBody(start) {
    const w = this.w, h = this.h, type = this.type, fall = this.fall, stab = this.stability, crushed = this.crushed;
    const n = w * h;
    if (!this._landSeen) {
      this._landSeen = new Int32Array(n); this._landGen = 0; this._landStack = new Int32Array(n); this._landBody = new Int32Array(n);
      // Отметки волны — отдельно от отметок тела: волна идёт и по телу.
      this._landWave = new Int32Array(n); this._landWaveGen = 0;
    }
    const seen = this._landSeen, stack = this._landStack, body = this._landBody;
    const gen = ++this._landGen;
    // Тело: связная (4 соседа) группа падавших и теперь стоящих клеток.
    let sp = 0, nb = 0, mass = 0;
    stack[sp++] = start; seen[start] = gen;
    while (sp > 0 && nb < LANDING_MAX_BODY) {
      const i = stack[--sp];
      body[nb++] = i;
      mass += type[i] === EL.ALLOY ? this.alloyMass(i) : PIXEL_MASS[type[i]];
      fall[i] = 0;
      const x = i % w, y = (i / w) | 0;
      if (x > 0 && this.landPush(i - 1, gen, stack, sp)) sp++;
      if (x < w - 1 && this.landPush(i + 1, gen, stack, sp)) sp++;
      if (y > 0 && this.landPush(i - w, gen, stack, sp)) sp++;
      if (y < h - 1 && this.landPush(i + w, gen, stack, sp)) sp++;
    }
    if (nb < LANDING_MAX_BODY && this.rollBody(nb, gen)) return;
    // Пятно контакта: пиксели тела, под которыми твёрдое (не своё).
    // Якорь держит, но не продавливается; стойкость пятна — средняя по
    // тому, что продавливается. Пары "пиксель тела — пиксель под ним"
    // запоминаются: с них начнётся волна.
    const targets = this._landTargets || (this._landTargets = []);
    targets.length = 0;
    let area = 0, rSum = 0, pairs = 0;
    for (let k = 0; k < nb; k++) {
      const b = body[k] + w;
      if (b >= n || seen[b] === gen) continue;
      const t = type[b];
      if (IS_ANCHOR[t] === 1) { area++; continue; }
      if (IS_STRUCTURAL[t] !== 1) continue;
      if (crushed[b] !== 0) { area++; continue; }   // уже принимает нагрузку
      if (stab[b] === 0) continue;
      area++;
      targets.push(body[k], b);
      pairs++;
      rSum += this.cellStability(b, t);
    }
    if (area === 0 || pairs === 0) return;
    const resist = rSum / pairs;
    if (resist <= 0 || mass / area <= resist) return;
    // Пятно неприемлемо: от пар контакта волной (8 соседей), и по полу, и
    // по телу, стойкость 0, пока масса / пятно не станет не больше
    // стойкости. Волна идёт слоями от места удара — дальше него ничего не
    // продавливается.
    const need = Math.min(LANDING_MAX_PATCH, Math.ceil(mass / resist));
    const wave = this._landWave, wg = ++this._landWaveGen, q = stack;   // стек тела больше не нужен
    let head = 0, tail = 0, crushedCount = 0;
    for (let k = 0; k < targets.length; k++) {
      const c = targets[k];
      if (wave[c] !== wg) { wave[c] = wg; q[tail++] = c; }
    }
    while (head < tail && crushedCount < need) {
      const i = q[head++];
      this.crushPixel(i);
      crushedCount++;
      const x = i % w, y = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if ((dx || dy) === 0 || nx < 0 || nx >= w) continue;
          const j = ny * w + nx;
          if (wave[j] === wg) continue;
          const t = type[j];
          if (IS_STRUCTURAL[t] !== 1 || IS_ANCHOR[t] === 1 || crushed[j] !== 0) continue;
          wave[j] = wg;
          q[tail++] = j;
        }
      }
    }
  }

  // Скатывание (см. шапку): тело из nb клеток _landBody (отметка gen в
  // _landSeen) съезжает на клетку вниз-вбок, если центр масс за краем опоры
  // и путь свободен. true — съехало.
  rollBody(nb, gen) {
    const w = this.w, n = w * this.h, type = this.type, body = this._landBody, seen = this._landSeen;
    let cMin = w, cMax = -1, mx = 0, m = 0;
    for (let k = 0; k < nb; k++) {
      const i = body[k], x = i % w;
      const pm = type[i] === EL.ALLOY ? this.alloyMass(i) : PIXEL_MASS[type[i]];
      mx += x * pm; m += pm;
      const b = i + w;
      if (b >= n || seen[b] === gen || this.rollPassable(b)) continue;
      if (x < cMin) cMin = x;
      if (x > cMax) cMax = x;
    }
    // Снизу не опирается ни на что (держится сбоку) — не скатывается.
    if (cMax < 0 || m <= 0) return false;
    const cx = mx / m;
    const dir = cx > cMax + ROLL_MARGIN ? 1 : cx < cMin - ROLL_MARGIN ? -1 : 0;
    if (dir === 0) return false;
    for (let k = 0; k < nb; k++) {
      const i = body[k], x = i % w + dir, j = i + w + dir;
      if (x < 0 || x >= w || j >= n) return false;
      if (seen[j] !== gen && !this.rollPassable(j)) return false;
    }
    // Каждая клетка уходит на ряд ниже: нижние ряды — первыми, чтобы место
    // для верхних уже освободилось (индекс по убыванию — ряд по убыванию).
    const order = body.subarray(0, nb).sort((a, b) => b - a);
    const stab = this.stability, moved = this.moved;
    const rolled = this._rolled || (this._rolled = []);
    for (let k = 0; k < nb; k++) {
      const i = order[k], j = i + w + dir;
      this.swapFields(i, j);
      // Устойчивость — по месту, а не у частицы: переносим сами, иначе
      // в обходе этого кадра тело на новом месте с нулём рассыпалось бы.
      const t = stab[i]; stab[i] = stab[j]; stab[j] = t;
      moved[j] = 1;
      rolled.push(j);
    }
    return true;
  }

  // Сквозь что тело может съехать: пустота, жидкость, газ, огонь — и не
  // балка (её держит только твёрдое, и сквозь неё оно не проходит).
  rollPassable(j) {
    const t = this.type[j];
    return (t === EL.EMPTY || IS_LIQUID[t] === 1 || IS_GASLIKE[t] === 1 || t === EL.FIRE) && this.beam[j] === 0;
  }

  // Положить соседа j в стек тела, если он того же тела: падал и стоит.
  landPush(j, gen, stack, sp) {
    if (this._landSeen[j] === gen || this.fall[j] === 0) return false;
    if (IS_STRUCTURAL[this.type[j]] !== 1 || this.stability[j] === 0 || this.crushed[j] !== 0) return false;
    this._landSeen[j] = gen;
    stack[sp] = j;
    return true;
  }

  // Продавить пиксель: CRUSH_FRAMES кадров устойчивость 0. Сам пиксель не
  // меняется — ни вид, ни состав, ни оттенок.
  crushPixel(i) {
    if (this.crushed[i] === 0) this._crushLive = (this._crushLive || 0) + 1;
    this.crushed[i] = CRUSH_FRAMES;
    this.stability[i] = 0;
    this.markDirty(i);
  }
}

extendSim(SimLanding);
