'use strict';

// Многоклеточные живые: протагонист (EL.PROTAGONIST) и человек (EL.HUMAN) —
// тело из нескольких десятков клеток, а не один пиксель (просьба
// пользователя: "пусть протагонист и человек будут занимать больше одной
// клетки: не будут квадратными", с картинкой 16x16; "физическое тело в
// сетке"). Здесь — всё, что общее для обоих: форма тела, постановка, сдвиг
// целиком, сборка клеток, урон по клеткам. Поведение — в sim/protagonist.js и
// sim/human.js, рисунок — в js/render.js (drawCreatures).
//
// Форма — PERSON_SPRITE: голова 4x4 в бортике, под ней перемычка шеи, тело
// 4x9 в бортике, ровно как на картинке (16 в высоту, 6 в ширину, углы шеи и
// макушки пусты). 92 клетки: 52 заливки (цвет игрока или кожи) и 40 бортика
// (тот же цвет, но темнее).
//
// Тело в сетке. Каждая клетка тела — обычная клетка поля с типом живого и
// такими полями:
//   life  — номер живого (номер игрока протагониста, личный номер человека);
//   extra — PERSON_DEAD (128), если мёртв, плюс номер части (0..91) — какая
//           это клетка формы. Прежняя схема (extra 0 — жив, 1 — мёртв) была
//           у одного пикселя; файлы до версии 4 переводит deserialize
//           (expandLegacyCreatures);
//   dirt  — кровь на этой клетке (рана), burn — ожог, acid — кислотная
//           язва, stain — отравление (все 0..255 и едут вместе с клеткой).
// Главная клетка (pivot) — низ тела по центру (ряд 15, столбец 2): "где он
// стоит", её же возвращает findProtagonist, и в ней живёт вся логика
// (reactProtagonist, reactHuman); прочие клетки только проверяют, что они не
// осиротели (reactCreature). Движение — сдвиг всех клеток разом (creatureMove):
// поле в этот миг больше никто не обходит, и щелей в теле нет.
//
// Здоровье не хранится числом: оно — сумма ран, ожогов и язв по клеткам
// (creatureDamage), поэтому отмена возвращает его вместе с миром, а рисунок
// всегда честен. Смерть — когда сумма дошла до порога (DEATH_DAMAGE).
//
// Методы класса Sim, вынесенные в отдельный файл: класс ниже — только
// контейнер, extendSim переносит его методы в Sim.prototype (см. core.js).

// Форма: '.' — пусто, 'e' — бортик, 'f' — заливка.
const PERSON_SPRITE = [
  '.eeee.',
  'effffe',
  'effffe',
  'effffe',
  'effffe',
  '.eeee.',
  'effffe', 'effffe', 'effffe', 'effffe', 'effffe', 'effffe', 'effffe', 'effffe', 'effffe',
  'eeeeee',
];
const PERSON_ROWS = PERSON_SPRITE.length;
const PERSON_COLS = 6;
// Главная клетка — низ по центру.
const PERSON_PIVOT_COL = 2;
const PERSON_PIVOT_ROW = PERSON_ROWS - 1;
// Бит мёртвого в extra клетки тела.
const PERSON_DEAD = 128;

// Таблицы формы: часть k — смещение (DX, DY) от главной клетки, бортик ли.
const PERSON_DX = [];
const PERSON_DY = [];
const PERSON_EDGE = [];
// Номер части по смещению (DX + 2, DY + 15), -1 — клетки формы там нет.
const PERSON_REL = new Int16Array(PERSON_COLS * PERSON_ROWS).fill(-1);
let PERSON_PIVOT = 0;
for (let r = 0; r < PERSON_ROWS; r++) {
  for (let c = 0; c < PERSON_COLS; c++) {
    const ch = PERSON_SPRITE[r][c];
    if (ch === '.') continue;
    const k = PERSON_DX.length;
    PERSON_DX.push(c - PERSON_PIVOT_COL);
    PERSON_DY.push(r - PERSON_PIVOT_ROW);
    PERSON_EDGE.push(ch === 'e' ? 1 : 0);
    PERSON_REL[r * PERSON_COLS + c] = k;
    if (r === PERSON_PIVOT_ROW && c === PERSON_PIVOT_COL) PERSON_PIVOT = k;
  }
}
const PERSON_N = PERSON_DX.length;
// Соседи по телу (четыре стороны): номера частей. По ним ожог, язва и яд
// расползаются по телу (creatureSpread).
const PERSON_NEIGH = [];
for (let k = 0; k < PERSON_N; k++) {
  const list = [];
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const r = PERSON_REL[(PERSON_DY[k] + dy + PERSON_PIVOT_ROW) * PERSON_COLS + PERSON_DX[k] + dx + PERSON_PIVOT_COL];
    if (PERSON_DX[k] + dx + PERSON_PIVOT_COL >= 0 && PERSON_DX[k] + dx + PERSON_PIVOT_COL < PERSON_COLS
        && PERSON_DY[k] + dy + PERSON_PIVOT_ROW >= 0 && PERSON_DY[k] + dy + PERSON_PIVOT_ROW < PERSON_ROWS && r >= 0) list.push(r);
  }
  PERSON_NEIGH.push(list);
}
// Часть формы по смещению от главной клетки (-1 — нет).
function personRel(dx, dy) {
  const c = dx + PERSON_PIVOT_COL, r = dy + PERSON_PIVOT_ROW;
  return c < 0 || c >= PERSON_COLS || r < 0 || r >= PERSON_ROWS ? -1 : PERSON_REL[r * PERSON_COLS + c];
}
// Порядок переноса клеток при сдвиге на (dx, dy): сначала самые передние —
// тогда клетка впереди уже свободна (там осталась жидкость или пустота, она
// и едет назад по цепочке обменов в хвост). По восьми сторонам и стоянию.
const PERSON_ORDER = [];
for (let dy = -1; dy <= 1; dy++) {
  for (let dx = -1; dx <= 1; dx++) {
    const idx = Array.from({ length: PERSON_N }, (_, k) => k);
    idx.sort((a, b) => (PERSON_DX[b] * dx + PERSON_DY[b] * dy) - (PERSON_DX[a] * dx + PERSON_DY[a] * dy) || a - b);
    PERSON_ORDER[(dy + 1) * 3 + (dx + 1)] = Int16Array.from(idx);
  }
}
// Клетки головы (верхние пять рядов формы) — для дыхания и взгляда.
const PERSON_HEAD_ROWS = 5;
// Высота тела и ряд, откуда он смотрит (середина головы), в клетках от главной.
const PERSON_HEIGHT = PERSON_ROWS;
const PERSON_EYE_DY = -(PERSON_ROWS - 3);
// Середина тела по высоте (камера игры и поиск цели).
const PERSON_MID_DY = -((PERSON_ROWS / 2) | 0);

// Порог смерти: сумма ран/ожогов/язв всех клеток, делённая на DAMAGE_SCALE,
// доходит до DEATH_DAMAGE. Удар (HIT_DAMAGE 90) — три и смерть, как у одного
// пикселя; DAMAGE_SCALE — во сколько раз сумма по клеткам крупнее.
const DAMAGE_SCALE = 10;
const DEATH_DAMAGE = 255;
// Отравление — то же с другим масштабом: смерть при сумме stain по клеткам
// POISON_DEATH_SUM (двадцать клеток дотла).
const POISON_DEATH_SUM = 3000;

const IS_CREATURE = idTable([EL.HUMAN, EL.PROTAGONIST]);

class SimCreature {
  initCreature() {
    this._ccBuf = new Int32Array(PERSON_N);
  }

  // Часть формы клетки i и "мёртв ли" — по extra.
  partOf(i) { return this.extra[i] & 127; }
  creatureDeadAt(i) { return (this.extra[i] & PERSON_DEAD) !== 0; }

  // Клетка у живого: сама клетка и главная должны сходиться по типу, номеру и
  // части. Возвращает главную клетку живого, которому принадлежит i, или -1
  // (не живое, осиротевшая часть).
  creaturePivot(i) {
    const t = this.type[i];
    if (IS_CREATURE[t] !== 1) return -1;
    const k = this.extra[i] & 127;
    if (k >= PERSON_N) return -1;
    const w = this.w, x = (i % w) - PERSON_DX[k], y = ((i / w) | 0) - PERSON_DY[k];
    if (x < 0 || x >= w || y < 0 || y >= this.h) return -1;
    const p = y * w + x;
    if (this.type[p] !== t || this.life[p] !== this.life[i] || (this.extra[p] & 127) !== PERSON_PIVOT) return -1;
    return p;
  }

  // Клетки тела с главной p: буфер, где по номеру части лежит индекс клетки
  // или -1 (части нет: вырвана взрывом, стёрта). Буфер общий — не вкладывать
  // вызовы.
  creatureCells(p) {
    const w = this.w, h = this.h, type = this.type, life = this.life, extra = this.extra;
    const buf = this._ccBuf, t = type[p], id = life[p], x0 = p % w, y0 = (p / w) | 0;
    for (let k = 0; k < PERSON_N; k++) {
      const x = x0 + PERSON_DX[k], y = y0 + PERSON_DY[k];
      if (x < 0 || x >= w || y < 0 || y >= h) { buf[k] = -1; continue; }
      const j = y * w + x;
      buf[k] = (type[j] === t && life[j] === id && (extra[j] & 127) === k) ? j : -1;
    }
    return buf;
  }

  // Клетка t для живого проходима: пустота, а с fluid — ещё жидкость и газ
  // (он их раздвигает, как тонущее тело).
  creatureEnterable(t, fluid) {
    return t === EL.EMPTY || (fluid && (IS_LIQUID[t] === 1 || IS_GASLIKE[t] === 1));
  }

  // Поместилось бы тело с главной клеткой p после сдвига на (dx, dy): все
  // клетки формы в поле и проходимы (свои — тоже: они уйдут).
  // skipP — главная клетка другого тела, которое уйдёт с дороги (стоящий на
  // голове поднимется раньше нижнего): его клетки считаются свободными.
  creatureFree(p, dx, dy, fluid, skipP = -1) {
    const w = this.w, h = this.h, type = this.type;
    const x0 = p % w, y0 = (p / w) | 0;
    for (let k = 0; k < PERSON_N; k++) {
      const rx = PERSON_DX[k] + dx, ry = PERSON_DY[k] + dy;
      if (personRel(rx, ry) >= 0) continue;
      const x = x0 + rx, y = y0 + ry;
      if (x < 0 || x >= w || y < 0 || y >= h) return false;
      const j = y * w + x;
      if (!this.creatureEnterable(type[j], fluid) && !(skipP >= 0 && this.creaturePivot(j) === skipP)) return false;
    }
    return true;
  }

  // Сдвиг тела целиком на (dx, dy) — по клетке по каждой оси, creatureFree уже
  // проверено. Вернуть новую главную клетку. Жидкость и газ впереди тела
  // уходят назад цепочкой обменов (как раньше уходили у одного пикселя), из
  // клеток, которых тело ещё не коснулось, поэтому внутрь они не попадают.
  creatureMove(p, dx, dy) {
    const w = this.w, type = this.type, life = this.life, extra = this.extra, moved = this.moved;
    const x0 = p % w, y0 = (p / w) | 0, t = type[p], id = life[p];
    const order = PERSON_ORDER[(dy + 1) * 3 + (dx + 1)], d = dy * w + dx;
    for (let n = 0; n < PERSON_N; n++) {
      const k = order[n], c = (y0 + PERSON_DY[k]) * w + x0 + PERSON_DX[k];
      if (type[c] !== t || life[c] !== id || (extra[c] & 127) !== k) continue;   // части нет
      this.swapFields(c, c + d);
      moved[c + d] = 1;
    }
    const np = p + d;
    this.disturbWind(p, np);
    return np;
  }

  // Поставить живого типа t с номером id: главная клетка (x, y). -1 — не
  // поместилось (поле, твёрдое, другое живое). Содержимое клеток формы
  // (жидкость, газ) затирается.
  placeCreature(x, y, t, id, dead) {
    const w = this.w, h = this.h;
    if (x < 0 || x >= w || y < 0 || y >= h) return -1;
    const p = y * w + x;
    for (let k = 0; k < PERSON_N; k++) {
      const cx = x + PERSON_DX[k], cy = y + PERSON_DY[k];
      if (cx < 0 || cx >= w || cy < 0 || cy >= h) return -1;
      if (!this.creatureEnterable(this.type[cy * w + cx], true)) return -1;
    }
    for (let k = 0; k < PERSON_N; k++) {
      const c = (y + PERSON_DY[k]) * w + x + PERSON_DX[k];
      this.clearCell(c);
      this.spawnRaw(c, t);
      this.life[c] = id;
      this.extra[c] = k | (dead ? PERSON_DEAD : 0);
    }
    return p;
  }

  // Новая клетка типа t без побочных дел spawn() для живых (номер, память):
  // тип, оттенок нет, состав, температура места — как у обычной клетки.
  spawnRaw(i, t) {
    this.type[i] = t;
    this.shade[i] = 0;
    this.extra[i] = 0;
    this.life[i] = 0;
    this.stain[i] = 0; this.dirt[i] = 0; this.burn[i] = 0; this.acid[i] = 0;
    this.fall[i] = 0; this.crushed[i] = 0;
    this.setComp(i, pureCompFor(t));
    if (this.temp[i] < DEFAULT_BASE_TEMP) this.temp[i] = DEFAULT_BASE_TEMP;
    this.markDirty(i);
  }

  // Тело с главной клеткой (x, y) целиком помещается в пустоту (спавн, возрождение).
  creatureFitsEmpty(x, y) {
    const w = this.w, h = this.h, type = this.type;
    for (let k = 0; k < PERSON_N; k++) {
      const cx = x + PERSON_DX[k], cy = y + PERSON_DY[k];
      if (cx < 0 || cx >= w || cy < 0 || cy >= h || type[cy * w + cx] !== EL.EMPTY) return false;
    }
    return true;
  }

  // Убрать тело без следа (стёрто кистью, перенос, возрождение). Память
  // человека освобождается.
  removeCreature(p) {
    const t = this.type[p], id = this.life[p];
    const cells = this.creatureCells(p);
    for (let k = 0; k < PERSON_N; k++) if (cells[k] >= 0) this.clearCell(cells[k]);
    if (t === EL.HUMAN && !this._inBand) this._humans.delete(id);
  }

  // Умерло: бит на всех частях.
  creatureKill(p) {
    const cells = this.creatureCells(p), id = this.life[p];
    for (let k = 0; k < PERSON_N; k++) {
      const c = cells[k];
      if (c >= 0) { this.extra[c] |= PERSON_DEAD; this.markDirty(c); }
    }
    if (this.type[p] === EL.HUMAN && !this._inBand) this._humans.delete(id);
  }

  // Сумма ран, ожогов и язв по клеткам: масштаб "урона" (0..255 — смерть).
  // Клетка, которой уже нет (растворилась, оторвана), считается съеденной
  // дотла (LOST_DAMAGE, sim/pieces.js): иначе тело теряло бы урон вместе с
  // растворённым.
  creatureDamage(p) {
    const cells = this.creatureCells(p), dirt = this.dirt, burn = this.burn, acid = this.acid;
    let s = 0;
    for (let k = 0; k < PERSON_N; k++) {
      const c = cells[k];
      if (c >= 0) s += dirt[c] + burn[c] + acid[c]; else s += LOST_DAMAGE;
    }
    return s / DAMAGE_SCALE;
  }

  // Отравление тела 0..1 (сумма stain к смертельной).
  creaturePoison(p) {
    const cells = this.creatureCells(p), stain = this.stain;
    let s = 0;
    for (let k = 0; k < PERSON_N; k++) if (cells[k] >= 0) s += stain[cells[k]];
    return Math.min(1, s / POISON_DEATH_SUM);
  }

  // Рана: points очков (кровь, dirt) на клетки тела вокруг клетки c (радиус 2):
  // кусками по WOUND_CHUNK на случайные из них, пока не раздали или клетки не
  // насытились (255). Сумма по телу и есть урон (creatureDamage).
  creatureWound(p, c, points) {
    const w = this.w, x0 = c % w, y0 = (c / w) | 0, t = this.type[p], id = this.life[p];
    const pool = this._woundPool || (this._woundPool = []);
    pool.length = 0;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = x0 + dx, y = y0 + dy;
        if (x < 0 || x >= w || y < 0 || y >= this.h) continue;
        const j = y * w + x;
        if (this.type[j] === t && this.life[j] === id) pool.push(j);
      }
    }
    for (let n = 0; n < 64 && points > 0 && pool.length; n++) {
      const q = (Math.random() * pool.length) | 0, j = pool[q];
      const add = Math.min(WOUND_CHUNK, 255 - this.dirt[j], points);
      if (add <= 0) { pool.splice(q, 1); continue; }
      this.dirt[j] += add;
      points -= add;
      this.markDirty(j);
    }
  }

  // Все клетки соседей тела, где что-то опасное: счёт по клеткам формы.
  // Вызывается раз в кадр живым: для каждой клетки бортика смотрит четыре
  // стороны (внутренние клетки не касаются мира) и пишет в неё ожог (огонь,
  // лава, расплав), язву (кислота), отравление (яд). Возвращает, чем
  // коснулось: { burned, acid, poison } — сколько клеток.
  creatureContact(p) {
    const w = this.w, h = this.h, type = this.type;
    const cells = this.creatureCells(p), x0 = p % w, y0 = (p / w) | 0;
    let burned = 0, acid = 0, poison = 0, lastDeadly = 0, poisonType = 0;
    const burnA = this.burn, acidA = this.acid, stainA = this.stain;
    for (let k = 0; k < PERSON_N; k++) {
      const c = cells[k];
      if (c < 0) continue;
      // Бортик касается мира всегда, заливка — только там, где соседней клетки
      // тела уже нет (срез после разрыва или язвы).
      if (PERSON_EDGE[k] !== 1) {
        const nb = PERSON_NEIGH[k];
        let open = false;
        for (let q = 0; q < nb.length && !open; q++) open = cells[nb[q]] < 0;
        if (!open) continue;
      }
      const cx = x0 + PERSON_DX[k], cy = y0 + PERSON_DY[k];
      for (let d = 0; d < 4; d++) {
        const nx = cx + DX4[d], ny = cy + DY4[d];
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const j = ny * w + nx, nt = type[j];
        if (nt === EL.EMPTY || IS_CREATURE[nt] === 1) continue;
        if (this.poisoner(nt, j)) {
          // Дробная часть скорости — броском (поле целое: прибавка 0.15 иначе
          // терялась бы).
          const r = this.poisonRate(nt, j), whole = Math.floor(r);
          const v = stainA[c] + whole + (Math.random() < r - whole ? 1 : 0);
          stainA[c] = v > 255 ? 255 : v;
          poison++; poisonType = nt;
          this.markDirty(c);
          continue;
        }
        let deadly = false, isAcid = false;
        if (nt === EL.SOLUTION) { isAcid = solGet(this.comp(j), P_ACID) > 0; deadly = isAcid; }
        else if (this.humanDeadly(nt)) { deadly = true; isAcid = nt === EL.ACID; }
        if (!deadly) continue;
        lastDeadly = nt;
        if (isAcid) { const v = acidA[c] + CONTACT_ACID; acidA[c] = v > 255 ? 255 : v; acid++; }
        else { const v = burnA[c] + CONTACT_BURN; burnA[c] = v > 255 ? 255 : v; burned++; }
        this.markDirty(c);
      }
    }
    return { burned, acid, poison, lastDeadly, poisonType };
  }

  // Расползание: сильно обожжённая, изъязвлённая или отравленная клетка (от
  // SPREAD_FROM) раз в SPREAD_PERIOD кадров передаёт соседям по телу по
  // SPREAD_STEP, пока у них заметно меньше. Так жар, кислота и яд охватывают
  // тело, а не остаются точкой — и касание краем может, в конце концов, убить.
  creatureSpread(p) {
    if (this.frame % SPREAD_PERIOD !== 0) return;
    const cells = this.creatureCells(p), burn = this.burn, acid = this.acid, stain = this.stain;
    for (let k = 0; k < PERSON_N; k++) {
      const c = cells[k];
      if (c < 0) continue;
      const b = burn[c], a = acid[c], s = stain[c];
      if (b < SPREAD_FROM && a < SPREAD_FROM && s < SPREAD_FROM) continue;
      const nb = PERSON_NEIGH[k];
      for (let q = 0; q < nb.length; q++) {
        const c2 = cells[nb[q]];
        if (c2 < 0) continue;
        if (b >= SPREAD_FROM && burn[c2] + SPREAD_GAP < b) burn[c2] = Math.min(255, burn[c2] + SPREAD_STEP);
        if (a >= SPREAD_FROM && acid[c2] + SPREAD_GAP < a) acid[c2] = Math.min(255, acid[c2] + SPREAD_STEP);
        if (s >= SPREAD_FROM && stain[c2] + SPREAD_GAP < s) stain[c2] = Math.min(255, stain[c2] + SPREAD_STEP);
        this.markDirty(c2);
      }
    }
  }

  // Заживление (если включена регенерация, sim.regenOn): раз в HEAL_PERIOD
  // кадров кровь стекает с клеток тела на HEAL_BLOOD суммарно, ожоги и язвы —
  // в HEAL_SCAR раз медленнее (шрамы). Отравление отходит на 1 раз в
  // POISON_RECOVER_PERIOD кадров с каждой клетки.
  creatureHeal(p) {
    const cells = this.creatureCells(p), dirt = this.dirt, burn = this.burn, acid = this.acid, stain = this.stain;
    if (this.regenOn && this.frame % HEAL_PERIOD === 0) {
      let left = HEAL_BLOOD;
      for (let k = 0; k < PERSON_N && left > 0; k++) {
        const c = cells[k];
        if (c < 0 || dirt[c] === 0) continue;
        const d = Math.min(dirt[c], left);
        dirt[c] -= d; left -= d;
        this.markDirty(c);
      }
      if (this.frame % (HEAL_PERIOD * HEAL_SCAR) === 0) {
        let sc = HEAL_BLOOD;
        for (let k = 0; k < PERSON_N && sc > 0; k++) {
          const c = cells[k];
          if (c < 0) continue;
          if (burn[c] > 0) { const d = Math.min(burn[c], sc); burn[c] -= d; sc -= d; this.markDirty(c); }
          if (acid[c] > 0 && sc > 0) { const d = Math.min(acid[c], sc); acid[c] -= d; sc -= d; this.markDirty(c); }
        }
      }
    }
    if (this.frame % POISON_RECOVER_PERIOD === 0) {
      for (let k = 0; k < PERSON_N; k++) { const c = cells[k]; if (c >= 0 && stain[c] > 0) { stain[c]--; this.markDirty(c); } }
    }
  }

  // Завален со всех сторон: вокруг головы (пять рядов формы и шея) нет ни
  // одной пустой клетки (старое правило walledIn, но для головы тела).
  creatureWalledIn(p) {
    const w = this.w, h = this.h, type = this.type, x0 = p % w, y0 = (p / w) | 0;
    const top = y0 - (PERSON_ROWS - 1) - 1, bottom = y0 - (PERSON_ROWS - 1) + PERSON_HEAD_ROWS;
    for (let y = top; y <= bottom; y++) {
      if (y < 0 || y >= h) continue;
      for (let dx = -PERSON_PIVOT_COL - 1; dx <= PERSON_COLS - PERSON_PIVOT_COL; dx++) {
        const x = x0 + dx;
        if (x < 0 || x >= w) continue;
        const inside = y >= y0 - (PERSON_ROWS - 1) && y < y0 - (PERSON_ROWS - 1) + PERSON_HEAD_ROWS && dx >= -PERSON_PIVOT_COL && dx < PERSON_COLS - PERSON_PIVOT_COL;
        if (inside) continue;
        if (type[y * w + x] === EL.EMPTY) return false;
      }
    }
    return true;
  }

  // Кровоточит: клетка с большой раной иногда роняет каплю крови (EL.BLOOD) в
  // свободную клетку рядом и снизу. Раз в BLEED_PERIOD кадров выбирается одна
  // клетка (по кадру и номеру живого), чтобы не обходить все.
  creatureBleed(p) {
    if (this.frame % BLEED_PERIOD !== 0) return;
    const w = this.w, cells = this.creatureCells(p);
    const k = (((this.frame / BLEED_PERIOD) | 0) * 7 + this.life[p]) % PERSON_N;
    const c = cells[k];
    if (c < 0 || this.dirt[c] < BLEED_FROM || Math.random() >= this.dirt[c] / 255) return;
    for (const d of [w, w - 1, w + 1, -1, 1]) {
      const j = c + d;
      if (j < 0 || j >= this.type.length) continue;
      if (Math.abs((j % w) - (c % w)) > 1) continue;
      if (this.type[j] === EL.EMPTY) { this.spawn(j, EL.BLOOD); return; }
    }
  }

  // Погиб от яда — рассыпался сыпучим окислом камня (прежнее правило одного
  // пикселя): все клетки тела становятся рыхлым окислом.
  poisonDeathBody(p) {
    const cells = this.creatureCells(p), id = this.life[p], t = this.type[p];
    for (let k = 0; k < PERSON_N; k++) if (cells[k] >= 0) this.spawn(cells[k], EL.OXIDE_LOOSE, false);
    if (t === EL.HUMAN && !this._inBand) this._humans.delete(id);
  }

  // Клетка тела, не имеющая главной (вырвана из тела: взрыв, кисть), — убирается;
  // у главной — вся логика живого. Вызывается из react для каждой клетки.
  reactCreature(x, y, i, t) {
    // Свободный кусок (life < 0, sim/pieces.js) ходит сам, без главной клетки.
    if (this.life[i] < 0) { this.pieceStep(i); return; }
    const k = this.extra[i] & 127;
    if (k === PERSON_PIVOT) {
      if (t === EL.HUMAN) this.reactHuman(x, y, i); else this.reactProtagonist(x, y, i);
      return;
    }
    // Клетка без главной (вырвана взрывом, стёрта): остатки не пропадают, а
    // становятся мёртвыми кусками (sim/pieces.js). Номер серии кусков и память
    // людей — общее состояние: в параллельной полосе это откладывается главному потоку.
    if (this.creaturePivot(i) < 0) {
      if (this._inBand) { this.defer(DEFER_UPDATE, i); return; }
      this.creatureOrphan(i);
    }
  }

  // Файл до версии 4: у живого была одна клетка (extra 0 — жив, 1 — мёртв).
  // Каждая такая клетка — стопы нового тела: тело ставится так, чтобы старая
  // клетка пришлась на главную; не вмещается — живого нет (протагониста
  // восстановит респавн, человека кисть).
  expandLegacyCreatures() {
    const n = this.w * this.h, w = this.w, found = [];
    for (let i = 0; i < n; i++) {
      const t = this.type[i];
      if (IS_CREATURE[t] === 1) found.push(i);
    }
    for (const i of found) {
      const t = this.type[i], id = this.life[i], dead = this.extra[i] === 1;
      const x = i % w, y = (i / w) | 0;
      this.clearCell(i);
      const old = this._humans ? this._humans.get(id) : null;
      let p = this.placeCreature(x, y, t, id, dead);
      for (let up = 1; p < 0 && up <= PERSON_HEIGHT; up++) p = this.placeCreature(x, y - up, t, id, dead);
      if (p < 0 && t === EL.HUMAN && old) this._humans.delete(id);
    }
  }
}

// Ожог и язва за кадр на касающуюся клетку (0..255), заживление: кровь на
// HEAL_BLOOD раз в HEAL_PERIOD кадров (то же, что один пиксель терял по 1 из
// 255 — тело больше в DAMAGE_SCALE раз), шрамы — раз в HEAL_SCAR реже.
// Кровоточит раз в BLEED_PERIOD кадров, если рана клетки не меньше BLEED_FROM.
const BLEED_PERIOD = 6;
const BLEED_FROM = 90;
// Расползание ожога, язвы и яда по телу (creatureSpread).
const SPREAD_PERIOD = 3;
const SPREAD_FROM = 128;
const SPREAD_STEP = 6;
const SPREAD_GAP = 40;
// Кусок раны за раз (очков крови на клетку).
const WOUND_CHUNK = 60;
const CONTACT_BURN = 40;
const CONTACT_ACID = 30;
const HEAL_BLOOD = 10;
const HEAL_SCAR = 5;

extendSim(SimCreature);
