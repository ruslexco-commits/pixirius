'use strict';

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
    this.upCounter = new Int16Array(n);
    this.structVisited = new Uint8Array(n);
    this.structTag = new Int32Array(n);
    this.paused = false;
    this.frame = 0;
  }

  idx(x, y) { return y * this.w + x; }
  inBounds(x, y) { return x >= 0 && x < this.w && y >= 0 && y < this.h; }

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
  }

  swap(i, j) {
    let t = this.type[i]; this.type[i] = this.type[j]; this.type[j] = t;
    t = this.life[i]; this.life[i] = this.life[j]; this.life[j] = t;
    t = this.extra[i]; this.extra[i] = this.extra[j]; this.extra[j] = t;
    t = this.shade[i]; this.shade[i] = this.shade[j]; this.shade[j] = t;
  }

  // ---- игровой цикл ----

  step() {
    if (this.paused) return;
    this.frame++;
    this.moved.fill(0);
    this.updateStructures();
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
    if (el2.cat === CAT.POWDER) this.updatePowder(x, y, i, el2);
    else if (el2.cat === CAT.LIQUID) this.updateLiquid(x, y, i, el2);
    else if (el2.cat === CAT.GAS) this.updateGas(x, y, i, el2);
    else if (id2 === EL.FIRE) this.updateFireMovement(x, y, i);
  }

  // ---- структурная устойчивость твёрдых тел ----

  // У каждого структурного материала своя maxStability (значение, которое
  // получает клетка, касающаяся низа поля или якоря — стена/пустота/клонер)
  // и toughness = X (через сколько клеток пути стабильность падает на 1).
  // Стабильность распространяется соседям, но подъём вверх и шаг вбок/вниз
  // считаются двумя НЕЗАВИСИМЫМИ счётчиками пути: свернув наверх, не успев
  // пройти X клеток вбок, боковой счётчик просто замирает (сохраняется) —
  // и так можно откладывать его сколько угодно раз, переключаясь между
  // направлениями, лишь бы каждый отдельный счётчик не набрал свои X.
  // X берётся из материала ПРИНИМАЮЩЕЙ клетки (не источника).
  computeStability() {
    const w = this.w, h = this.h, n = w * h;
    const stab = this.stability;
    const sideC = this.sideCounter;
    const upC = this.upCounter;
    stab.fill(0);
    sideC.fill(0);
    upC.fill(0);

    const maxLevel = 64;
    const buckets = this._stabBuckets || (this._stabBuckets = Array.from({ length: maxLevel + 1 }, () => []));
    for (let lvl = 0; lvl <= maxLevel; lvl++) buckets[lvl].length = 0;

    const seed = (i, id) => {
      const s = Math.min(ELEMENTS[id].maxStability || 0, maxLevel);
      if (s > stab[i]) { stab[i] = s; sideC[i] = 0; upC[i] = 0; buckets[s].push(i); }
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

    const steps = [[0, -1, true], [1, 0, false], [-1, 0, false], [0, 1, false]];
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
        for (const [dx, dy, isUp] of steps) {
          const nx = x + dx, ny = y + dy;
          if (!this.inBounds(nx, ny)) continue;
          const ni = this.idx(nx, ny);
          const nid = this.type[ni];
          if (!isStructural(nid)) continue;
          if (nid === EL.OILFILM && this.extra[ni] !== oilOppositeDir(oilDirCode(dx, dy))) continue;
          const X = ELEMENTS[nid].toughness || 1;
          let newStab, newSideC, newUpC;
          if (isUp) {
            newSideC = sideC[i];
            newUpC = upC[i] + 1;
            if (newUpC >= X) { newStab = stab[i] - 1; newUpC = 0; } else newStab = stab[i];
          } else {
            newUpC = upC[i];
            newSideC = sideC[i] + 1;
            if (newSideC >= X) { newStab = stab[i] - 1; newSideC = 0; } else newStab = stab[i];
          }
          if (newStab > stab[ni]) {
            stab[ni] = newStab; sideC[ni] = newSideC; upC[ni] = newUpC;
            if (newStab >= 1) buckets[Math.min(newStab, maxLevel)].push(ni);
          }
        }
      }
    }
  }

  // Структурная клетка со stability===0 (никогда не достигнута распространением
  // либо стабильность истощилась до нуля по пути) не держится — такие клетки,
  // связанные друг с другом, падают целиком одной жёсткой структурой, сохраняя
  // форму, пока не упрутся — тогда снова замирают и на следующем кадре
  // переоцениваются заново (уже как часть новой опоры, если легли на неё).
  updateStructures() {
    this.computeStability();
    const w = this.w, h = this.h, n = w * h;
    const stab = this.stability;
    const visited = this.structVisited;
    const compTag = this.structTag;
    const moved = this.moved;
    visited.fill(0);
    // compTag ДОЛЖЕН сбрасываться каждый кадр, как и visited — иначе клетка,
    // отвергнутая при построении текущей компоненты (например restsOnStable),
    // может хранить УСТАРЕВШИЙ tag с прошлого кадра, который случайно совпадёт
    // с tag текущей компоненты (tag каждый кадр заново нумеруется с 1) — тогда
    // compTag[below]===tag ложно сочтёт её "своей" и пропустит проверку
    // блокировки. Именно это вызывало непредсказуемое, будто случайное падение
    // на клетку вниз то там, то тут — старые данные то совпадали, то нет.
    compTag.fill(0);

    // Клетка со stability===0 всё равно физически подпёрта снизу, если прямо
    // под ней лежит СВОЯ (уже стабильная) структура — путевой бюджет исчерпан
    // на передачу опоры ДАЛЬШЕ, но саму себя такая клетка держит сжатием, а
    // не "зависает" в противоречивом состоянии "должна падать, но упасть
    // некуда" (иначе верхушка любой достаточно высокой башни зависала бы
    // навечно, не падая и не становясь стабильной — так и был баг).
    const restsOnStable = (i) => {
      const x = i % w, y = (i / w) | 0;
      if (y + 1 >= h) return false;
      const bi = this.idx(x, y + 1);
      return isStructural(this.type[bi]) && stab[bi] > 0;
    };

    let tag = 0;
    const comp = [];
    for (let i = 0; i < n; i++) {
      if (visited[i] || moved[i]) { visited[i] = 1; continue; }
      if (!isStructural(this.type[i]) || stab[i] !== 0 || restsOnStable(i)) { visited[i] = 1; continue; }
      tag++;
      comp.length = 0;
      comp.push(i);
      visited[i] = 1;
      compTag[i] = tag;
      let head = 0;
      while (head < comp.length) {
        const ci = comp[head++];
        const cx = ci % w, cy = (ci / w) | 0;
        for (let k = 0; k < 4; k++) {
          const nx = cx + DX4[k], ny = cy + DY4[k];
          if (!this.inBounds(nx, ny)) continue;
          const ni = this.idx(nx, ny);
          if (visited[ni] || moved[ni]) continue;
          visited[ni] = 1;
          if (isStructural(this.type[ni]) && stab[ni] === 0 && !restsOnStable(ni)) {
            compTag[ni] = tag;
            comp.push(ni);
          }
        }
      }
      // Заодно с проверкой canFall сразу пробуем вытеснить жидкость/песок под
      // ногами — если совсем некуда (ни рядом, ни где-то в общей массе),
      // считаем клетку заблокированной, и вся структура просто не падает в
      // этот кадр (остаётся на текущем месте, "фиксируется").
      let canFall = true;
      for (let k2 = 0; k2 < comp.length; k2++) {
        const ci = comp[k2];
        const cx = ci % w, cy = (ci / w) | 0;
        if (cy + 1 >= h) { canFall = false; break; }
        const below = this.idx(cx, cy + 1);
        if (compTag[below] === tag) continue;
        const bt = this.type[below];
        if (bt === EL.EMPTY) continue;
        const bEl = ELEMENTS[bt];
        if (bEl && bEl.cat === CAT.GAS) continue; // газ не держит, вытеснять не нужно
        if (bEl && (bEl.cat === CAT.LIQUID || bEl.cat === CAT.POWDER)) {
          if (this.displaceFluid(cx, cy + 1) || this.displaceFluidWide(cx, cy + 1)) continue;
        }
        canFall = false; break;
      }
      if (canFall) {
        comp.sort((a, b) => ((b / w) | 0) - ((a / w) | 0));
        for (let k2 = 0; k2 < comp.length; k2++) {
          const ci = comp[k2];
          const cx = ci % w, cy = (ci / w) | 0;
          const below = this.idx(cx, cy + 1);
          this.swap(ci, below);
          moved[below] = 1;
        }
      }
    }
  }

  // Твёрдое тело, тонущее в жидкости/песке, выталкивает их в сторону — ищем
  // ближайшую свободную клетку в том же ряду, не дальше 5 клеток. Идём
  // "стенкой" в каждую сторону и останавливаемся на первом же твёрдом
  // препятствии — сквозь него нельзя телепортироваться на другую
  // (противоположную) сторону тонущего тела, можно вытесниться только в
  // ближайший реальный просвет у своего края. Через другую жидкость/газ по
  // пути — можно (сливается с соседним водоёмом). Из двух сторон выбираем
  // ту, что ближе. Возвращает true при успехе.
  displaceFluid(x, y) {
    const w = this.w;
    const radius = 5;
    const scan = (dir) => {
      for (let step = 1; step <= radius; step++) {
        const nx = x + dir * step;
        if (nx < 0 || nx >= w) return -1;
        const t = this.type[this.idx(nx, y)];
        if (t === EL.EMPTY) return step;
        const el = ELEMENTS[t];
        if (!el || (el.cat !== CAT.LIQUID && el.cat !== CAT.GAS)) return -1; // упёрлись в твёрдое
      }
      return -1;
    };
    const rDist = scan(1), lDist = scan(-1);
    if (rDist === -1 && lDist === -1) return false;
    const useRight = rDist !== -1 && (lDist === -1 || rDist <= lDist);
    const dist = useRight ? rDist : lDist;
    const nx = x + (useRight ? 1 : -1) * dist;
    this.swap(this.idx(x, y), this.idx(nx, y));
    return true;
  }

  // Если у самой точки контакта вытеснить некуда (в пределах 5 клеток по
  // displaceFluid) — пробуем вытеснить какой-нибудь ДРУГОЙ случайный кусочек
  // той же массы жидкости/песка: случайное блуждание по связным клеткам
  // того же типа (дёшево, без полного заливочного поиска всей области), и
  // если у найденной случайной клетки самой находится просвет — переносим
  // ИСХОДНУЮ клетку на её место (сама она уже вытеснилась в этот просвет).
  displaceFluidWide(x, y) {
    const t = this.type[this.idx(x, y)];
    const attempts = 6;
    // Блуждание не должно уходить дальше maxReach клеток от исходной точки ни
    // по одной оси — иначе по связному пути (например, в обход большого
    // тонущего тела понизу) могло бы вынырнуть на его ПРОТИВОПОЛОЖНОЙ
    // стороне, куда физически попасть не должно вне зависимости от размера
    // объекта.
    const maxReach = 12;
    for (let a = 0; a < attempts; a++) {
      let cx = x, cy = y;
      const walkSteps = 8 + (Math.random() * 24 | 0);
      for (let s = 0; s < walkSteps; s++) {
        const order = [0, 1, 2, 3].sort(() => Math.random() - 0.5);
        let stepped = false;
        for (const k of order) {
          const nx = cx + DX4[k], ny = cy + DY4[k];
          if (!this.inBounds(nx, ny)) continue;
          if (Math.abs(nx - x) > maxReach || Math.abs(ny - y) > maxReach) continue;
          if (this.type[this.idx(nx, ny)] === t) { cx = nx; cy = ny; stepped = true; break; }
        }
        if (!stepped) break;
      }
      if (cx === x && cy === y) continue;
      if (this.displaceFluid(cx, cy)) {
        this.swap(this.idx(x, y), this.idx(cx, cy));
        return true;
      }
    }
    return false;
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

  updatePowder(x, y, i, el) {
    const w = this.w, h = this.h;
    if (y + 1 >= h) return;
    const bi = this.idx(x, y + 1);
    if (this.attemptSwapOrMove(i, bi, el, false)) return;
    const dir = Math.random() < 0.5 ? 1 : -1;
    for (const dx of [dir, -dir]) {
      const nx = x + dx;
      if (nx < 0 || nx >= w) continue;
      const ni = this.idx(nx, y + 1);
      if (this.attemptSwapOrMove(i, ni, el, false)) return;
    }
  }

  updateLiquid(x, y, i, el) {
    const w = this.w, h = this.h;
    if (y + 1 < h) {
      const bi = this.idx(x, y + 1);
      if (this.attemptSwapOrMove(i, bi, el, false)) return;
    }
    if (y - 1 >= 0) {
      const ai = this.idx(x, y - 1);
      if (this.attemptBuoyantRise(i, ai, el)) return;
    }
    const dir = Math.random() < 0.5 ? 1 : -1;
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
    if (y - 1 >= 0) {
      const ai = this.idx(x, y - 1);
      if (this.attemptSwapOrMove(i, ai, el, true)) return;
    }
    const dir = Math.random() < 0.5 ? 1 : -1;
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
