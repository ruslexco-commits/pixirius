'use strict';

// Мир по сиду — основа мультиплеера (js/net.js).
//
// Просьба пользователя: "переписать рандомайзер так, чтобы он был не до
// конца рандомным, а генерировался по сиду: тогда достаточно передать сид и
// действия хоста, а не всю обстановку в реальном времени". Раньше хост
// досылал вкладкам изменившиеся куски мира раз в три кадра — у
// подключившихся всё подлагивало, а часть состояния (влажность, падение,
// температура с допуском) не доходила вовсе.
//
// Теперь каждая вкладка считает мир сама. Шаг детерминирован, если у всех
// одинаковы: состояние мира, случайные числа и действия между шагами. Для
// этого:
// - случайные числа шага — свой генератор у мира (mulberry32, состояние
//   _rngState — часть мира): на время шага и действий Math.random
//   подменяется им (withRng). Сама симуляция по-прежнему зовёт Math.random —
//   одиночная игра и tools/compare.js ничего не заметили;
// - обход полосами, одинаковый при любом числе потоков (lockstep →
//   updateBands, sim/threads.js): у каждой полосы свои случайные числа,
//   отложенное — в порядке полос, общая фаза — главным потоком;
// - мир целиком (при входе вкладки, старте игры, отмене у хоста) —
//   lockstepDump/lockstepLoad: ВСЕ поля Sim, а не только PARTICLE_FIELDS,
//   потому что на ход влияют и сон кусков, и кэши устойчивости, и память
//   людей, и заряды. Перечислять их руками — забыть новое при первой же
//   механике; копируется всё, кроме LOCKSTEP_SKIP и функций;
// - расхождение ловит lockstepHash: хост шлёт его раз в MP_HASH_PERIOD
//   кадров, вкладка сверяет со своим и при несовпадении просит мир целиком.
//   Так чинится и то, что поменяли в обход действий (лупа, загрузка файла).
//
// Проверка: node tools/lockstep-check.js — две копии мира идут побайтно
// одинаково, в том числе копия, снятая на середине.
//
// Методы класса Sim, вынесенные в отдельный файл: класс ниже — только
// контейнер, extendSim переносит его методы в Sim.prototype (см. core.js).

// Поля Sim, которые у каждой вкладки свои: пауза и скорость — управление
// вкладки, а не мир; потоки — свои рабочие у каждой вкладки (и в
// мультиплеере не работают); замер "обход тяжёлый" — по часам вкладки;
// состояние кисти (стадия окисла, материал балки) — у каждого игрока своё,
// с действием оно идёт отдельно (net.js, MP_PAINT_CTX).
const LOCKSTEP_SKIP = new Set(['paused', 'timeScale', 'lockstep', '_rngFn', 'paintOxideStage', 'beamPaintMaterial', 'beamPaintExtra',
  '_tctrl', '_tstripes', '_tparams', '_deferQ', '_threadCount', '_threadHandles', '_rowsHeavy']);

class SimLockstep {
  rngSeed(seed) { this._rngState = seed >>> 0; }

  // Выполнить fn со случайными числами мира (см. шапку). Вложенные вызовы
  // (действие внутри действия) — тот же генератор.
  withRng(fn) {
    if (!this._rngFn) {
      if (this._rngState === undefined) this._rngState = 1;
      this._rngFn = () => {
        const a = this._rngState = (this._rngState + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    const prev = Math.random;
    Math.random = this._rngFn;
    try { return fn(); } finally { Math.random = prev; }
  }

  // Мир целиком (см. шапку). Typed-массивы копируются (их могут разделять
  // потоки — общую память в BroadcastChannel не отправить). Один массив под
  // несколькими именами (двойные буферы тепла и ветра: temp — это _tempA
  // или _tempB) — копируется раз, имена записываются в alias. Вид другого
  // типа на буфер поля (кэши "словами по 4 клетки": _fall32 над fall) не
  // копируется — dropped, он пересоздаётся сам. Остальное (Map памяти
  // людей, заряды, игроки) — одним structuredClone: так сохраняются ссылки
  // между полями (playerInput — это players[0].input).
  lockstepDump() {
    const arrays = [], alias = {}, dropped = [], rest = {};
    const seen = new Map(), buffers = new Set();
    for (const k of Object.keys(this)) {
      if (LOCKSTEP_SKIP.has(k)) continue;
      const v = this[k];
      if (typeof v === 'function') continue;
      if (ArrayBuffer.isView(v)) {
        if (seen.has(v)) { alias[k] = seen.get(v); continue; }
        if (buffers.has(v.buffer)) { dropped.push(k); continue; }
        seen.set(v, k);
        buffers.add(v.buffer);
        arrays.push([k, new v.constructor(v)]);
        continue;
      }
      rest[k] = v;
    }
    // Ключ "<кэш>Src" — сам массив поля (см. landWords): у сброшенного
    // кэша сбрасывается и он, иначе кэш не пересоздастся.
    for (const k of dropped) if (alias[k + 'Src'] !== undefined) { delete alias[k + 'Src']; dropped.push(k + 'Src'); }
    let copy;
    try {
      copy = structuredClone(rest);
    } catch (e) {
      // Что-то не копируется (функция внутри объекта) — без него.
      for (const k of Object.keys(rest)) { try { structuredClone(rest[k]); } catch (e2) { delete rest[k]; } }
      copy = structuredClone(rest);
    }
    return { w: this.w, h: this.h, arrays, alias, dropped, rest: copy };
  }

  // Принять мир целиком. Свои массивы остаются теми же объектами (общая
  // память потоков, текстуры рендера держат их) — в них копируются данные,
  // а имена раскладываются по группам, как у хоста.
  lockstepLoad(d) {
    if (d.w !== this.w || d.h !== this.h) throw new Error(`размер мира ${d.w}x${d.h}, а здесь ${this.w}x${this.h}`);
    const groups = {};
    for (const [k] of d.arrays) groups[k] = [k];
    for (const k in d.alias) groups[d.alias[k]].push(k);
    // Чей массив какими именами сейчас назван — свободный массив можно
    // взять, только если все его имена уже разложены.
    const namesOf = new Map();
    for (const k of Object.keys(this)) {
      const v = this[k];
      if (!ArrayBuffer.isView(v)) continue;
      if (!namesOf.has(v)) namesOf.set(v, []);
      namesOf.get(v).push(k);
    }
    const used = new Set(), placed = new Set();
    const fits = (v, data) => v && ArrayBuffer.isView(v) && !used.has(v) && v.constructor === data.constructor && v.length === data.length;
    for (const [k, data] of d.arrays) {
      const keys = groups[k];
      let target = null;
      for (const kk of keys) if (fits(this[kk], data)) { target = this[kk]; break; }
      if (!target) {
        for (const [v, names] of namesOf) if (fits(v, data) && names.every((n) => placed.has(n) || keys.includes(n))) { target = v; break; }
      }
      if (target) target.set(data); else target = data;
      used.add(target);
      for (const kk of keys) { this[kk] = target; placed.add(kk); }
    }
    for (const k of d.dropped) this[k] = null;
    for (const k in d.rest) this[k] = d.rest[k];
    this.paused = false;
  }

  // Отпечаток мира для сверки вкладок (см. шапку): генератор, кадр и поля,
  // которые видно глазом. Раз в MP_HASH_PERIOD кадров, не каждый. Слова
  // полей — через три на четвёртое, со сдвигом от кадра к кадру (за четыре
  // сверки — все): полный проход стоил заметную долю кадра раз в секунду, а
  // почти любое расхождение и так меняет счёт случайных чисел (_rngState),
  // а за ним — всё поле.
  lockstepHash() {
    let h = (this._rngState ^ Math.imul(this.frame, 0x9E3779B1)) >>> 0;
    const start = (Math.imul(this.frame, 2654435761) >>> 13) & 3;
    for (const a of [this.type, this.life, this.extra, this.sol, this.sol2, this.temp, this.beam]) {
      const words = (a.byteOffset & 3) === 0 && (a.byteLength & 3) === 0 ? new Uint32Array(a.buffer, a.byteOffset, a.byteLength >> 2) : null;
      if (words) for (let i = start; i < words.length; i += 4) h = Math.imul(h ^ words[i], 16777619);
      else for (let i = start; i < a.length; i += 4) h = Math.imul(h ^ a[i], 16777619);
    }
    h = Math.imul(h ^ this.respawnMarks.length, 16777619);
    for (const m of this.respawnMarks) h = Math.imul(h ^ (m.y * this.w + m.x), 16777619);
    return h >>> 0;
  }
}

extendSim(SimLockstep);
