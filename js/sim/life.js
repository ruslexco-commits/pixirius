'use strict';

// Живая клетка (EL.CELL): первое живое на фундаменте простых веществ
// (data/chem.js, sim/chem.js).
//
// Просьба пользователя: живые клетки должны есть всё вокруг, но вещество при
// этом сохраняется — они не должны за какое-то время съесть всю воду и
// исчезнуть сами. Поэтому клетка не «съедает» вещество в никуда, а переносит
// его: тело клетки — доли дерева (органика CH2O, по долям C, H, O), и каждый
// укус забирает из соседа ровно те простые вещества, из которых сложена одна
// доля тела (chemTake: из соседа они уходят, остаток соседа пересобирается в
// соединения), а чего в соседе нет — берётся из воздуха (chemAirHas: пока в
// воздухе хватает). Строгое (кремний, железо, медь, натрий, хлор) клетка не
// берёт: сосед с таким остатком, который некуда пересобрать, не съедобен
// (камень, песок, металл, соль). Умерла — стала деревом с теми же долями, то
// есть едой для следующих: круговорот, а не сток. Всё остальное сводит учёт
// sim/chem.js (клетки + воздух сохраняются на каждом кадре сами) —
// tools/chem-check.js гоняет колонию на воде, дереве и земле.
//
// Тело — доли дерева в составе клетки (1..SOL_PARTS), силы — в life (ходов
// без еды). Ход — по броску CELL_ACT_CHANCE на кадр: клетка ест не каждый
// кадр, колония растёт неторопливо.
//
// Методы класса Sim, вынесенные в отдельный файл: класс ниже — только
// контейнер, extendSim переносит его методы в Sim.prototype (см. core.js).

// Сил на старте и потолок; укус даёт CELL_BITE_ENERGY, каждый ход стоит один.
const CELL_ENERGY_START = 100;
const CELL_ENERGY_MAX = 255;
const CELL_BITE_ENERGY = 20;
// Шанс хода в кадр. 0.04 — ход раз в ~25 кадров, сотня ходов — около сорока секунд.
const CELL_ACT_CHANCE = 0.04;
// Делится, когда тело полное; ребёнок получает столько долей, родитель остаётся с тем же.
const CELL_CHILD_PARTS = SOL_PARTS / 2;
// Одна доля тела (дерево) — столько простых веществ нужно на укус.
const CELL_PART_COMP = solPure(EL.WOOD, 1);
// Как далеко ищется пустота для ребёнка, если вокруг одна жидкость (клеток).
const CELL_ROOM_REACH = 24;
const CELL_NEED_ORDER = [CHEM.H, CHEM.O, CHEM.C];

class SimLife {
  reactCell(x, y, i) {
    if (Math.random() >= CELL_ACT_CHANCE) return;
    // Голод: без сил клетка умирает деревом с теми же долями.
    if (this.life[i] <= 1) { this.cellDie(i); return; }
    this.life[i]--;
    const k = (Math.random() * 4) | 0;
    const nx = x + DX4[k], ny = y + DY4[k];
    if (!this.inBounds(nx, ny)) return;
    const j = this.idx(nx, ny);
    if (this.type[j] === EL.CELL || !this.chemEdible(j)) return;
    const comp = this.comp(i);
    const body = solGet(comp, EL.WOOD);
    // Тело полное — укус нужен только ради деления, и место для ребёнка должно быть.
    let child = -1;
    if (body >= SOL_PARTS) {
      child = this.cellRoom(x, y);
      if (child < 0) return;
    }
    // Недостающее берётся из воздуха — только если его хватает (на худший случай, весь укус).
    if (!this.chemAirHas(CELL_PART_COMP)) return;
    let got = 0;
    for (let q = 0; q < CELL_NEED_ORDER.length; q++) {
      const a = CELL_NEED_ORDER[q];
      const need = CHEM_FORMULA[EL.WOOD * CHEM_N + a];
      if (need > 0) got += this.chemTake(j, a, need);
    }
    // Сосед ничего не отдал (в нём нет органики или остаток строгого некуда сложить) — не съедобен.
    if (got === 0) return;
    this.life[i] = Math.min(CELL_ENERGY_MAX, this.life[i] + CELL_BITE_ENERGY);
    if (child < 0) {
      this.setComposition(i, solWith(comp, EL.WOOD, body + 1));
      return;
    }
    // Деление: тело пополам, ребёнок — в свободную соседнюю клетку.
    this.setComposition(i, solPure(EL.WOOD, SOL_PARTS - CELL_CHILD_PARTS));
    this.spawn(child, EL.CELL);
    this.setComposition(child, solPure(EL.WOOD, CELL_CHILD_PARTS));
    this.moved[child] = 1;
  }

  // Место для ребёнка рядом с клеткой (x, y): свободная соседняя клетка, а в
  // воде, где свободных нет, — клетка, освобождённая сдвигом столба жидкости:
  // от клетки по прямой (вверх, вбок, вниз) до первой пустоты идут только
  // жидкость и газ, и они сдвигаются на клетку к пустоте, как вода при
  // вытеснении телом (иначе колония на дне озера не могла бы делиться: вокруг
  // одна вода). Вещество при этом только переезжает (swapFields), ничего не
  // теряется. Возвращает освобождённую клетку или -1; сдвиг в полосе — только в
  // своих столбцах (_colMin/_colMax), как у прочих дальних поисков.
  cellRoom(x, y) {
    const free = this.freeNeighbour(x, y, false);
    if (free >= 0) return free;
    const w = this.w, h = this.h, type = this.type;
    // Вверх, вбок (в случайную сторону первой), вниз.
    const side = Math.random() < 0.5 ? 1 : -1;
    for (let d = 0; d < 4; d++) {
      const dx = d === 1 ? side : d === 2 ? -side : 0, dy = d === 0 ? -1 : d === 3 ? 1 : 0;
      let cx = x, cy = y, len = 0, end = -1;
      for (; len < CELL_ROOM_REACH; len++) {
        cx += dx; cy += dy;
        if (cx < this._colMin || cx > this._colMax || cy < 0 || cy >= h) break;
        const t = type[cy * w + cx];
        if (t === EL.EMPTY) { end = len; break; }
        if (IS_LIQUID[t] !== 1 && IS_GASLIKE[t] !== 1) break;
      }
      if (end < 0) continue;
      // Клетки пути p0..p(end): сдвиг к пустоте, снизу по ходу.
      const step = dy * w + dx, p0 = (y + dy) * w + (x + dx);
      for (let m = end; m >= 1; m--) {
        const a = p0 + m * step, b = a - step;
        this.swapFields(a, b);
        this.moved[a] = 1;
      }
      return p0;
    }
    return -1;
  }

  // Смерть: клетка становится деревом с теми же долями (типом напрямую, как
  // setOxideStage: температуру и оттенок сохраняем). Сил нет, срок жизни не нужен.
  cellDie(i) {
    this.type[i] = EL.WOOD;
    this.life[i] = 0;
    this.extra[i] = 0;
    this.markDirty(i);
  }
}

extendSim(SimLife);
