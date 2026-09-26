'use strict';

// Параллельный обход клеток: поле режется на вертикальные полосы по
// THREAD_STRIPE столбцов, и полосы считаются сразу несколькими потоками
// (Web Workers в браузере, worker_threads в Node) над общей памятью
// (SharedArrayBuffer). Общие проходы кадра (устойчивость, ветер, тепло,
// выходы луж, сон) остаются на главном потоке — они связаны через всё поле.
//
// Почему полосы вертикальные. Сначала они были горизонтальными (по 20, потом
// по 12 строк), и это ломало главное правило обхода — строки снизу вверх.
// Соседние полосы нельзя считать одновременно, поэтому считаются в две фазы
// (чётные, потом нечётные), и у половины границ верхняя полоса шла РАНЬШЕ
// нижней. Падающая струя упиралась там в ещё не сдвинувшуюся нижнюю часть
// и брызгала вбок; путь вытеснения жидкости тонущим телом, ограниченный
// полосой, не доставал до поверхности глубокого озера; мокрой земли
// выходило вдвое больше. Вертикальная полоса проходит свои столбцы целиком
// снизу вверх — сила тяжести и всё вертикальное считаются точно как без
// потоков. Шов остаётся только по горизонтали, где и без потоков порядка
// нет: строка идёт то слева направо, то справа налево через кадр. Проверено
// (tools/threads-check.js): расхождение с однопоточным прогоном того же
// порядка, что и от случайного направления каждой строки в одном потоке.
//
// Две фазы: сначала все потоки разбирают чётные полосы, потом нечётные —
// между двумя одновременно считаемыми полосами всегда лежит незанятая.
// Каждый кадр сетка полос сдвигается на 0 или 16 столбцов и фазы меняются
// порядком, чтобы шов не стоял на одних и тех же столбцах.
//
// Что не помещается в полосу, откладывается и досчитывается главным
// потоком после обеих фаз (defer / processDeferred):
//  - люди и колонисты — их память живёт в Map главного потока;
//  - подрыв пороха и взрыв сухих солей — заливка всей связной массы и
//    воронка радиусом до 40 клеток;
// а два дела с дальним горизонтальным обзором ограничены столбцами полосы
// с запасом THREAD_REACH (_colMin/_colMax): путь вытеснения жидкости тонущим
// телом (не нашёлся — прежний простой обмен) и сдвиг ветром цепочки клеток
// (shiftChain). Растекание жидкости — до 6 клеток вбок, в запас входит.
//
// Главный поток тоже берёт полосы, а потом ждёт остальных активным циклом:
// заснуть на ожидании (Atomics.wait) ему браузер не даёт. Зато step()
// остаётся обычным синхронным вызовом, и игровой цикл, ввод, отмена и
// сохранение о потоках не знают.
//
// Что меняется в поведении: порядок клеток внутри строки (кусками по
// полосам), случайные числа у каждого потока свои, отложенное досчитывается
// в конце шага. Правила игры те же; побайтно с однопоточным прогоном мир
// не совпадает (tools/compare.js сравнивает однопоточный путь).
//
// Кроме клеток, потокам раздаётся диффузия тепла (tempRows, heat.js): она
// читает прошлый кадр температуры и пишет только свою строку нового, так
// что делится по строкам в одну фазу и даёт побитно тот же результат.
//
// Когда потоки не нужны. Разбудить рабочих и дождаться их — заметная доля
// миллисекунды на кадр. В спокойном мире, где почти всё спит, это дороже
// самого обхода, поэтому при малом числе бодрствующих кусков
// (THREAD_MIN_ACTIVE) шаг идёт в одном потоке.
//
// Методы класса Sim, вынесенные в отдельный файл: класс ниже — только
// контейнер, extendSim переносит его методы в Sim.prototype (см. core.js).

// Полоса — два куска сна (SLEEP_CHUNK=16), так пропуск спящих кусков в
// updateCols работает целыми кусками. На поле 576 столбцов — 18 полос, по 9
// на фазу. Запас: две одновременно считаемые полосы разделены одной, и
// дальние дела обеих (по THREAD_REACH столбцов) плюс обычный ход клетки
// (1 столбец) не должны в ней встретиться: 2*THREAD_REACH + 2 < THREAD_STRIPE.
const THREAD_STRIPE = 32;
const THREAD_REACH = 12;       // на сколько столбцов за свою полосу заглядывают дальние дела
const THREAD_MIN_ACTIVE = 250; // бодрствующих кусков 16x16 (~2.5 мс обхода), ниже которых шаг идёт в одном потоке
const THREAD_SPIN = 20000;     // сколько раз рабочий проверяет фазу, прежде чем уснуть
const THREAD_TEMP_ROWS = 12;   // строк тепла в одной порции
const THREAD_TEMP_MIN = 48;    // горячих строк, ниже которых тепло считается в одном потоке
const TASK_CELLS = 0, TASK_TEMP = 1;
const DEFER_UPDATE = 0, DEFER_GUNPOWDER = 1, DEFER_SALT = 2;
const DEFER_CAP = 65536;

// Ячейки общего управляющего массива.
const TC_PHASE = 0, TC_DONE = 1, TC_NEXT = 2, TC_COUNT = 3, TC_READY = 4, TC_STOP = 5,
  TC_FRAME = 6, TC_TEMPFLIP = 7, TC_WINDFLIP = 8, TC_DEFER = 9, TC_QUIET = 10, TC_TASK = 11;
const TC_SIZE = 16;

// Поля Sim, которые видят все потоки. temp/_temp2 и windVX/_windVX2 —
// пары буферов, которые updateTemp и updateWind меняют местами каждый кадр:
// какой из них сейчас "текущий", главный поток сообщает флагом.
const THREAD_SHARED_FIELDS = [
  'type', 'life', 'extra', 'shade', 'temp', '_temp2', 'moisture', 'sol', 'sol2', 'beam', 'beamExtra',
  'colonistHomeX', 'colonistHomeY', 'moved', 'stability', '_liquidEscape', '_debrisWindVX',
  'windVXFrame', 'windVYFrame', 'windVX', 'windVY', '_windVX2', '_windVY2', '_chunkActive', '_chunkDirty', '_tempRowHot',
];

// Забирать порции текущей фазы, пока они есть (и рабочий, и главный
// поток): полосы клеток или строки тепла.
function runStripesShared(sim, ctrl, stripes) {
  const count = Atomics.load(ctrl, TC_COUNT);
  const task = Atomics.load(ctrl, TC_TASK);
  for (;;) {
    const b = Atomics.add(ctrl, TC_NEXT, 1);
    if (b >= count) return;
    const a0 = stripes[2 * b], a1 = stripes[2 * b + 1];
    if (task === TASK_TEMP) { sim.tempRows(a0, a1); continue; }
    sim._colMin = Math.max(0, a0 - THREAD_REACH);
    sim._colMax = Math.min(sim.w - 1, a1 - 1 + THREAD_REACH);
    sim.updateCols(a0, a1);
  }
}

// Рабочий поток: подменить массивы своего Sim общими. Тип массива
// приходит вместе с буфером: часть полей (_windVX2) у свежего Sim ещё не
// создана, и взять конструктор у своего массива не выйдет.
function attachSharedArrays(sim, shared) {
  for (const name of THREAD_SHARED_FIELDS) sim[name] = new globalThis[shared.kinds[name]](shared.buffers[name]);
  sim._tctrl = new Int32Array(shared.ctrl);
  sim._tstripes = new Int32Array(shared.stripes);
  sim._tparams = new Float64Array(shared.params);
  sim._deferQ = new Int32Array(shared.defer);
  sim._inBand = true;
}

// Рабочий поток: вечный цикл "ждать фазу — посчитать полосы — отчитаться".
function threadWorkerLoop(sim) {
  const ctrl = sim._tctrl, stripes = sim._tstripes, params = sim._tparams;
  const tempA = sim.temp, tempB = sim._temp2;
  const wxA = sim.windVX, wxB = sim._windVX2, wyA = sim.windVY, wyB = sim._windVY2;
  Atomics.add(ctrl, TC_READY, 1);
  let seen = Atomics.load(ctrl, TC_PHASE);
  for (;;) {
    // Вторая фаза начинается сразу за первой: короткое активное ожидание
    // ловит её без пробуждения из сна, которое на Windows стоит заметных
    // долей миллисекунды. Между кадрами — обычный сон.
    for (let s = 0; s < THREAD_SPIN && Atomics.load(ctrl, TC_PHASE) === seen; s++) { /* ждём */ }
    Atomics.wait(ctrl, TC_PHASE, seen);
    seen = Atomics.load(ctrl, TC_PHASE);
    if (Atomics.load(ctrl, TC_STOP)) return;
    sim.frame = ctrl[TC_FRAME];
    sim._windRoll = params[0];
    sim._windPushQuiet = ctrl[TC_QUIET] === 1;
    const tf = ctrl[TC_TEMPFLIP], wf = ctrl[TC_WINDFLIP];
    sim.temp = tf ? tempB : tempA; sim._temp2 = tf ? tempA : tempB;
    sim.windVX = wf ? wxB : wxA; sim._windVX2 = wf ? wxA : wxB;
    sim.windVY = wf ? wyB : wyA; sim._windVY2 = wf ? wyA : wyB;
    runStripesShared(sim, ctrl, stripes);
    Atomics.add(ctrl, TC_DONE, 1);
  }
}

class SimThreads {
  // Перевести массивы мира в общую память и запустить count рабочих
  // потоков. spawn(k, init) создаёт поток и передаёт ему init (своё для
  // браузера и для Node); поток должен подгрузить скрипты симуляции,
  // создать Sim(init.w, init.h), вызвать attachSharedArrays и
  // threadWorkerLoop. Пока все потоки не доложат о готовности, шаг идёт
  // по-старому, в одном потоке.
  startThreads(count, spawn) {
    // Поля, которые обычно заводятся лениво, — завести сразу: общими
    // должны стать все.
    if (!this._windVX2) { this._windVX2 = new Float32Array(this.windVX.length); this._windVY2 = new Float32Array(this.windVY.length); }
    if (!this._tempRowHot) this._tempRowHot = new Uint8Array(this.h);
    const buffers = {}, kinds = {};
    for (const name of THREAD_SHARED_FIELDS) {
      const arr = this[name];
      kinds[name] = arr.constructor.name;
      const sab = new SharedArrayBuffer(arr.byteLength);
      const view = new arr.constructor(sab);
      view.set(arr);
      this[name] = view;
      buffers[name] = sab;
    }
    this._tempA = this.temp; this._windXA = this.windVX;
    const ctrl = new SharedArrayBuffer(TC_SIZE * 4);
    const stripes = new SharedArrayBuffer((Math.max(Math.ceil(this.w / THREAD_STRIPE), Math.ceil(this.h / THREAD_TEMP_ROWS)) + 2) * 2 * 4);
    const params = new SharedArrayBuffer(8 * 4);
    const defer = new SharedArrayBuffer(DEFER_CAP * 2 * 4);
    this._tctrl = new Int32Array(ctrl);
    this._tstripes = new Int32Array(stripes);
    this._tparams = new Float64Array(params);
    this._deferQ = new Int32Array(defer);
    this._threadCount = count;
    this._threadHandles = [];
    const init = { w: this.w, h: this.h, buffers, kinds, ctrl, stripes, params, defer };
    for (let k = 0; k < count; k++) this._threadHandles.push(spawn(k, init));
  }

  threadsReady() {
    return !!this._tctrl && this._threadCount > 0 && Atomics.load(this._tctrl, TC_READY) === this._threadCount;
  }

  stopThreads() {
    if (!this._tctrl) return;
    Atomics.store(this._tctrl, TC_STOP, 1);
    Atomics.add(this._tctrl, TC_PHASE, 1);
    Atomics.notify(this._tctrl, TC_PHASE);
    this._threadCount = 0;
  }

  // Раздать потокам count порций задачи task (порции уже в _tstripes) и
  // посчитать их вместе с ними. Флаги буферов тепла и ветра — на момент
  // вызова: тепло раздаётся ДО того, как updateTemp поменяет буферы местами.
  runPhase(task, count) {
    const ctrl = this._tctrl;
    ctrl[TC_TEMPFLIP] = this.temp === this._tempA ? 0 : 1;
    ctrl[TC_WINDFLIP] = this.windVX === this._windXA ? 0 : 1;
    Atomics.store(ctrl, TC_TASK, task);
    Atomics.store(ctrl, TC_COUNT, count);
    Atomics.store(ctrl, TC_NEXT, 0);
    Atomics.store(ctrl, TC_DONE, 0);
    Atomics.add(ctrl, TC_PHASE, 1);
    Atomics.notify(ctrl, TC_PHASE);
    runStripesShared(this, ctrl, this._tstripes);
    // Ждать остальных: активно, Atomics.wait на главном потоке нельзя.
    while (Atomics.load(ctrl, TC_DONE) < this._threadCount) { /* ждём */ }
  }

  // Тепло строками по потокам (см. updateTemp). false — потоков нет или
  // горячих строк мало, считать в одном потоке.
  runTempParallel(hotRows) {
    if (!(this._threadCount > 0) || hotRows < THREAD_TEMP_MIN || !this.threadsReady()) return false;
    const stripes = this._tstripes, h = this.h;
    let k = 0;
    for (let y = 0; y < h; y += THREAD_TEMP_ROWS) {
      stripes[2 * k] = y; stripes[2 * k + 1] = Math.min(h, y + THREAD_TEMP_ROWS); k++;
    }
    this.runPhase(TASK_TEMP, k);
    return true;
  }

  // Обход клеток всеми потоками: одна фаза полос, другая, потом отложенное.
  updateParallel() {
    const ctrl = this._tctrl, stripes = this._tstripes, w = this.w;
    const active = this._chunkActive;
    let awake = 0;
    for (let c = 0; c < active.length && awake < THREAD_MIN_ACTIVE; c++) awake += active[c];
    if (awake < THREAD_MIN_ACTIVE) { this.updateRows(0, this.h); return; }
    ctrl[TC_FRAME] = this.frame;
    this._tparams[0] = this._windRoll;
    ctrl[TC_QUIET] = this._windPushQuiet ? 1 : 0;
    Atomics.store(ctrl, TC_DEFER, 0);
    this._inBand = true;
    // Сдвиг сетки и порядок фаз — свои на каждый кадр (см. шапку). Левая
    // полоса при сдвиге уже, правая может быть уже из-за ширины поля; обе
    // крайние и никогда не разделяют две одновременно считаемые полосы.
    const off = Math.random() < 0.5 ? 0 : SLEEP_CHUNK;
    const first = Math.random() < 0.5 ? 0 : 1;
    const count = (off > 0 ? 1 : 0) + Math.ceil((w - off) / THREAD_STRIPE);
    for (let phase = 0; phase < 2; phase++) {
      const parity = phase ^ first;
      let k = 0;
      for (let b = parity; b < count; b += 2) {
        const g = off > 0 ? b - 1 : b;  // номер полосы полной сетки; -1 — левый обрезок
        stripes[2 * k] = g < 0 ? 0 : off + g * THREAD_STRIPE;
        stripes[2 * k + 1] = g < 0 ? off : Math.min(w, off + (g + 1) * THREAD_STRIPE);
        k++;
      }
      this.runPhase(TASK_CELLS, k);
    }
    this._inBand = false;
    this._colMin = 0;
    this._colMax = w - 1;
    this.processDeferred();
  }

  // Отложить действие, которое не помещается в полосу (см. шапку файла).
  defer(kind, i) {
    const n = Atomics.add(this._tctrl, TC_DEFER, 1);
    if (n < DEFER_CAP) { this._deferQ[2 * n] = kind; this._deferQ[2 * n + 1] = i; }
  }

  // Досчитать отложенное — главным потоком, когда рабочие уже стоят.
  processDeferred() {
    const q = this._deferQ, w = this.w;
    const count = Math.min(DEFER_CAP, Atomics.load(this._tctrl, TC_DEFER));
    for (let n = 0; n < count; n++) {
      const kind = q[2 * n], i = q[2 * n + 1];
      const x = i % w, y = (i / w) | 0;
      if (kind === DEFER_UPDATE) this.updateCell(x, y);
      else if (kind === DEFER_GUNPOWDER) { if (this.type[i] === EL.GUNP) this.detonateGunpowder(x, y); }
      else if (kind === DEFER_SALT) { if (this.type[i] === EL.BLACK_SALT && this.isDrySalt(i)) this.detonateSalt(x, y); }
    }
  }
}

extendSim(SimThreads);
