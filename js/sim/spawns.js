'use strict';

// Точки спавна и респавна игроков мультиплеера (js/net.js, js/lobby.js) и
// поиск безопасного места для протагониста.
//
// Это не клетки поля, а метки поверх него — "на заднем плане, как балка"
// (просьба пользователя): в клетке с меткой может лежать что угодно, игрок
// встаёт в первую свободную клетку на ней или над ней. Метки хранятся в
// файле сохранения (persistence.js) и в отмене не участвуют.
//
// - Точка спавна игрока (spawnMarks: { x, y, n }) — где игрок n появляется
//   в начале игры (если не включён случайный спавн). У игрока одна точка:
//   новая заменяет прежнюю.
// - Точка респавна (respawnMarks: { x, y, players, kinds, physics, acid }) —
//   зелёный светящийся пиксель: погибший игрок возрождается на ней. players
//   — номера игроков, которых она принимает (null — всех), kinds — виды
//   смерти (null — любые, см. DEATH_KINDS), physics — падает ли она, как
//   песок, acid — разъедает ли её кислота. Настраивается лупой (inspect.js).
//   Подходящих точек несколько — выбирается случайная; нет ни одной —
//   безопасное случайное место; нет и такого — игрок остаётся там, где
//   погиб (просьба пользователя).
//
// Методы класса Sim, вынесенные в отдельный файл: класс ниже — только
// контейнер, extendSim переносит его методы в Sim.prototype (см. core.js).

// Виды смерти протагониста (state.deathKind, sim/protagonist.js) и их
// названия для лупы.
const DEATH_KINDS = [
  ['fire', 'огонь'], ['lava', 'лава и расплавы'], ['acid', 'кислота'], ['reagent', 'реагент'],
  ['oxide', 'окисел камня'], ['drown', 'утонул'], ['buried', 'завалило'], ['crushed', 'раздавлен'], ['killed', 'убит игроком'], ['other', 'прочее'],
];
// Сколько кадров погибший ждёт возрождения: почти сразу, четверть секунды
// (просьба пользователя; было 2 секунды). Имя погибшего при этом ещё
// гаснет на месте смерти (NameTags в play.js).
const RESPAWN_DELAY = 15;
// Шанс в кадр, что кислота рядом разъест точку респавна с acid = true.
const RESPAWN_ACID_CHANCE = 0.02;
// Сколько случайных клеток пробовать, прежде чем перебрать всё поле.
const SAFE_SPAWN_TRIES = 3000;

class SimSpawns {
  initSpawns() {
    this.spawnMarks = [];
    this.respawnMarks = [];
  }

  // Метка в клетке (x, y): точка спавна или респавна, иначе null.
  spawnMarkAt(x, y) {
    for (const m of this.spawnMarks) if (m.x === x && m.y === y) return m;
    return null;
  }
  respawnMarkAt(x, y) {
    for (const m of this.respawnMarks) if (m.x === x && m.y === y) return m;
    return null;
  }

  // Поставить точку спавна игрока n (прежняя этого игрока убирается).
  setSpawnMark(x, y, n) {
    this.spawnMarks = this.spawnMarks.filter((m) => m.n !== n && !(m.x === x && m.y === y));
    this.spawnMarks.push({ x, y, n });
  }

  // Поставить точку респавна (настройки — по умолчанию: всех, при любой
  // смерти, неподвижна, кислота не берёт).
  addRespawnMark(x, y) {
    if (this.respawnMarkAt(x, y)) return;
    this.respawnMarks.push({ x, y, players: null, kinds: null, physics: false, acid: false });
  }

  // Поменять настройки точки респавна в (x, y) (лупа, inspect.js): props —
  // любые из players, kinds, physics, acid.
  setRespawnMarkProps(x, y, props) {
    const m = this.respawnMarkAt(x, y);
    if (!m) return;
    for (const k of ['players', 'kinds', 'physics', 'acid']) if (props[k] !== undefined) m[k] = props[k];
  }

  // Убрать метки в пределах (rx, ry) от (x, y).
  removeMarksNear(x, y, rx = 0, ry = 0) {
    const near = (m) => Math.abs(m.x - x) <= rx && Math.abs(m.y - y) <= ry;
    this.spawnMarks = this.spawnMarks.filter((m) => !near(m));
    this.respawnMarks = this.respawnMarks.filter((m) => !near(m));
  }

  // Раз в кадр (после обхода, на главном потоке): точки респавна с physics
  // падают сквозь пустоту, газ и жидкость; с acid — их разъедает кислота
  // рядом. Точек единицы, проход дешёвый.
  updateRespawnMarks() {
    const w = this.w, h = this.h, type = this.type;
    // Точки спавна игроков падают всегда (просьба пользователя: "у точек
    // спавна должна быть физика") — сквозь пустоту, газ и жидкость.
    for (const m of this.spawnMarks) {
      if (m.y + 1 >= h) continue;
      const t = type[(m.y + 1) * w + m.x];
      if (t === EL.EMPTY || IS_GASLIKE[t] === 1 || IS_LIQUID[t] === 1) m.y++;
    }
    if (this.respawnMarks.length === 0) return;
    let gone = false;
    for (const m of this.respawnMarks) {
      if (m.physics && m.y + 1 < h) {
        const t = type[(m.y + 1) * w + m.x];
        if (t === EL.EMPTY || IS_GASLIKE[t] === 1 || IS_LIQUID[t] === 1) m.y++;
      }
      if (m.acid) {
        for (let k = 0; k < 4; k++) {
          const nx = m.x + DX4[k], ny = m.y + DY4[k];
          if (!this.inBounds(nx, ny)) continue;
          const i = ny * w + nx;
          if (solGet(this.comp(i), P_ACID) > 0 && Math.random() < RESPAWN_ACID_CHANCE) { m.dead = true; gone = true; break; }
        }
      }
    }
    if (gone) this.respawnMarks = this.respawnMarks.filter((m) => !m.dead);
  }

  // Безопасно ли встать протагонисту в клетку i: она пустая, под ней
  // опора — не газ, не жидкость, не пустота, — и ни сама опора, ни соседи
  // не смертельны.
  safeSpot(i) {
    const w = this.w, type = this.type;
    if (type[i] !== EL.EMPTY) return false;
    const x = i % w, y = (i / w) | 0;
    if (y + 1 >= this.h) return false;
    const below = type[i + w];
    if (below === EL.EMPTY || IS_GASLIKE[below] === 1 || IS_LIQUID[below] === 1 || below === EL.PROTAGONIST || below === EL.HUMAN) return false;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= this.h) continue;
        if (this.humanDeadly(type[ny * w + nx])) return false;
      }
    }
    return true;
  }

  // Открытое пространство (просьба пользователя: спавниться в микро-щелях,
  // откуда приходится выкапываться, — плохо): клетки пустоты и газа, от
  // которых можно пройти по такой же пустоте и газу до края поля. 1 —
  // открытая. Поиск в ширину от краёв, раз за вызов (точки спавна ищутся
  // редко).
  openAirMask() {
    const w = this.w, h = this.h, n = w * h, type = this.type;
    const open = new Uint8Array(n), q = new Int32Array(n);
    let head = 0, tail = 0;
    const pass = (i) => type[i] === EL.EMPTY || IS_GASLIKE[type[i]] === 1;
    const seed = (i) => { if (!open[i] && pass(i)) { open[i] = 1; q[tail++] = i; } };
    for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
    while (head < tail) {
      const i = q[head++], x = i % w;
      if (x > 0) seed(i - 1);
      if (x < w - 1) seed(i + 1);
      if (i >= w) seed(i - w);
      if (i + w < n) seed(i + w);
    }
    return open;
  }

  // Случайное безопасное место (safeSpot) или -1, если его нет нигде.
  // Сначала — с выходом на открытое пространство (openAirMask), и только
  // если таких нет — любое безопасное. Наугад, потом — перебором всего поля.
  findSafeSpawn() {
    const n = this.w * this.h, open = this.openAirMask();
    for (let k = 0; k < SAFE_SPAWN_TRIES; k++) {
      const i = (Math.random() * n) | 0;
      if (open[i] && this.safeSpot(i)) return i;
    }
    const best = [], any = [];
    for (let i = 0; i < n; i++) {
      if (!this.safeSpot(i)) continue;
      (open[i] ? best : any).push(i);
    }
    const pool = best.length ? best : any;
    return pool.length ? pool[(Math.random() * pool.length) | 0] : -1;
  }

  // Клетка, куда встать на метке (x, y): сама метка или первая свободная
  // над ней (метка "на заднем плане", клетка может быть занята). -1 — некуда.
  spotAtMark(x, y) {
    for (let yy = y; yy >= 0; yy--) {
      const i = yy * this.w + x;
      if (this.type[i] === EL.EMPTY) return i;
    }
    return -1;
  }

  // Куда возродить игрока n, погибшего смертью kind: случайная подходящая
  // точка респавна, иначе безопасное случайное место, иначе -1.
  // Подходящие точки с выходом на открытое (openAirMask) — первыми.
  respawnSpot(n, kind) {
    const fit = this.respawnMarks.filter((m) => (!m.players || m.players.includes(n)) && (!m.kinds || m.kinds.includes(kind || 'other')));
    if (fit.length) {
      const open = this.openAirMask(), shut = [];
      while (fit.length) {
        const k = (Math.random() * fit.length) | 0;
        const i = this.spotAtMark(fit[k].x, fit[k].y);
        fit.splice(k, 1);
        if (i < 0) continue;
        if (open[i]) return i;
        shut.push(i);
      }
      if (shut.length) return shut[(Math.random() * shut.length) | 0];
    }
    return this.findSafeSpawn();
  }

  // Возродить игрока n в клетке i: мёртвое тело убирается, протагонист —
  // новый, живой, с прежним номером.
  respawnPlayer(n, i) {
    const old = this.findProtagonist(n);
    if (old >= 0 && old !== i) this.clearCell(old);
    this.placePlayer(n, i);
  }
}

extendSim(SimSpawns);
