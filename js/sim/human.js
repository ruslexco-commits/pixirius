'use strict';

// Человек (EL.HUMAN): ходит, осматривается, боится опасного, помнит
// запретные клетки и гибнет. Память — в this._humans по номеру life[i].
//
// Методы класса Sim, вынесенные в отдельный файл: класс ниже — только
// контейнер, extendSim переносит его методы в Sim.prototype (см. core.js).

// ---- человек (см. Sim.reactHuman) ----
// Радиус, в котором человек замечает опасность. Кислотные тучи — особый
// случай: их он видит прямо над собой на любой высоте, потому что они
// приходят сверху и радиус тут ни при чём.
const HUMAN_SIGHT = 10;
// Осматривается не каждый кадр: полный обзор — это сотни клеток на
// человека, и каждый кадр на каждого это заметно дороже всего остального,
// что он делает. Раз в HUMAN_SCAN_PERIOD кадров достаточно — за это время
// опасность не успевает подойти вплотную. Люди разнесены по разным кадрам
// остатком от своего номера, чтобы не осматриваться всем разом.
const HUMAN_SCAN_PERIOD = 8;
// Сколько кадров подряд над головой должна стоять вода, чтобы человек
// захлебнулся.
const HUMAN_DROWN_FRAMES = 180;
// Шанс шага в кадр при спокойной ходьбе и шанс передумать и пойти в
// другую сторону.
const HUMAN_STEP_CHANCE = 0.25;
const HUMAN_TURN_CHANCE = 0.02;
// Сколько кадров подряд человек убегает после того, как увидел опасность.
// Бежит он КАЖДЫЙ кадр, а не по броску HUMAN_STEP_CHANCE: спокойный шаг
// вчетверо медленнее, чем растекается кислота, и человек, заметив лужу,
// исправно разворачивался — но она его догоняла, и он гиб на месте.
const HUMAN_FLEE_FRAMES = 40;
// Сколько клеток человек помнит как запретные. Память не бесконечная:
// самые старые записи вытесняются, иначе за долгую игру список разрастётся
// и осмотр начнёт упираться в него, а не в мир.
const HUMAN_BAN_LIMIT = 96;
// Насколько высоко человек согласен искать крышу над головой и насколько
// далеко в стороны уходить, спасаясь от кислотной тучи.
const HUMAN_ROOF_HEIGHT = 24;
const HUMAN_SHELTER_RANGE = 30;

class SimHuman {
  // ---- человек ----
  //
  // Живёт на поверхности, ходит влево-вправо, боится опасного и помнит,
  // где опасное видел. Падает он обычной физикой сыпучего (см. updateCell),
  // здесь только голова: осмотреться, испугаться, шагнуть, умереть.
  //
  // Смертельно: коснуться кислоты, реагента, огня, лавы или окисленного
  // камня, а также слишком долго простоять с водой над головой. Мёртвый
  // темнеет (см. render.js) и больше не двигается сам — только падает.

  // Память человека по его личному номеру. Создаётся на лету: клетка
  // могла приехать из сохранения, где Map уже не та.
  humanMind(i) {
    const id = this.life[i];
    let mind = this._humans.get(id);
    if (!mind) {
      mind = { bans: new Set(), banOrder: [], dir: Math.random() < 0.5 ? 1 : -1, wet: 0, flee: 0 };
      this._humans.set(id, mind);
    }
    return mind;
  }

  // Смертельное при прикосновении.
  humanDeadly(t) {
    if (t === EL.FIRE || t === EL.LAVA || t === EL.ACID || t === EL.REAGENT) return true;
    if (t === EL.OXIDE || t === EL.OXIDE_LOOSE) return true;
    if (t === EL.SOLUTION) return true;
    return false;
  }

  // Опасное, что человек старается обходить стороной (шире смертельного:
  // сюда же газы и замёрзшая кислота — соседство с ними добром не
  // кончится, даже если само касание не убивает).
  humanDanger(t) {
    if (this.humanDeadly(t)) return true;
    if (t === EL.ACID_GAS || t === EL.ACID_ICE || t === EL.REAGENT_ICE) return true;
    if (t === EL.VAPOR) return true;
    return false;
  }

  // Непрозрачное для взгляда: сквозь стены и камни человек не видит, а
  // сквозь воздух, газы и жидкости — видит.
  humanBlocksSight(t) {
    const el = ELEMENTS[t];
    return !!el && el.cat === CAT.SOLID;
  }

  // Видит ли человек из (x0,y0) точку (x1,y1): проводим прямую и смотрим,
  // не упирается ли она во что-нибудь непрозрачное. Обычный Брезенхем;
  // сама целевая клетка не проверяется — она и есть то, что он увидел.
  humanCanSee(x0, y0, x1, y1) {
    let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy, x = x0, y = y0;
    for (let guard = 0; guard < 64; guard++) {
      if (x === x1 && y === y1) return true;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
      if (x === x1 && y === y1) return true;
      if (!this.inBounds(x, y)) return false;
      if (this.humanBlocksSight(this.type[this.idx(x, y)])) return false;
    }
    return false;
  }

  // Запомнить клетку как запретную. Память ограничена: самая старая
  // запись вытесняется новой.
  humanBan(mind, ci) {
    if (mind.bans.has(ci)) return;
    mind.bans.add(ci);
    mind.banOrder.push(ci);
    if (mind.banOrder.length > HUMAN_BAN_LIMIT) {
      mind.bans.delete(mind.banOrder.shift());
    }
  }

  // Есть ли над человеком кислотная туча — газ с долей кислоты где угодно
  // выше по его колонке. Радиус обзора тут не действует: туча приходит
  // сверху, и заметить её человек должен на любой высоте.
  humanAcidCloudAbove(x, y) {
    for (let ny = y - 1; ny >= 0; ny--) {
      const t = this.type[this.idx(x, ny)];
      if (t === EL.EMPTY) continue;
      if (isVaporFamily(t)) {
        if (solGet(this.comp(this.idx(x, ny)), P_ACID) > 0) return true;
        continue;
      }
      // Дошли до чего-то плотного — дальше не видно, да и незачем: это
      // уже крыша.
      if (this.humanBlocksSight(t)) return false;
    }
    return false;
  }

  // Есть ли над головой крыша (что-то твёрдое в пределах досягаемости).
  humanHasRoof(x, y) {
    const top = Math.max(0, y - HUMAN_ROOF_HEIGHT);
    for (let ny = y - 1; ny >= top; ny--) {
      if (this.humanBlocksSight(this.type[this.idx(x, ny)])) return true;
    }
    return false;
  }

  // Осмотреться: найти в радиусе HUMAN_SIGHT опасные клетки, которые
  // человек действительно ВИДИТ, занести их в личную карту запретов и
  // вернуть сторону, в которую стоит отбежать (0 — всё спокойно).
  humanLookAround(x, y, mind) {
    let flee = 0, nearest = 1e9;
    const x0 = Math.max(0, x - HUMAN_SIGHT), x1 = Math.min(this.w - 1, x + HUMAN_SIGHT);
    const y0 = Math.max(0, y - HUMAN_SIGHT), y1 = Math.min(this.h - 1, y + HUMAN_SIGHT);
    for (let ny = y0; ny <= y1; ny++) {
      for (let nx = x0; nx <= x1; nx++) {
        const dx = nx - x, dy = ny - y;
        const d2 = dx * dx + dy * dy;
        if (d2 > HUMAN_SIGHT * HUMAN_SIGHT || d2 === 0) continue;
        const ci = ny * this.w + nx;
        if (!this.humanDanger(this.type[ci])) continue;
        if (!this.humanCanSee(x, y, nx, ny)) continue;
        this.humanBan(mind, ci);
        if (d2 < nearest) { nearest = d2; flee = dx === 0 ? (Math.random() < 0.5 ? 1 : -1) : (dx > 0 ? -1 : 1); }
      }
    }
    return flee;
  }

  // Проходима ли клетка для человека: только пустая. Балка в this.type не
  // лежит (это второй слой, this.beam), поэтому клетка с балкой — тоже пустая.
  humanPassable(t) { return t === EL.EMPTY; }

  // Держит ли клетка человека на себе. Балка НЕ держит: он проваливается
  // сквозь неё, как и любое сыпучее. Жидкости и газы тоже не опора — в
  // воде он тонет, а не идёт по ней.
  humanSupports(nx, ny) {
    if (ny >= this.h) return true; // дно мира
    const t = this.type[this.idx(nx, ny)];
    if (this.humanPassable(t)) return false;
    const el = ELEMENTS[t];
    if (!el) return false;
    return el.cat !== CAT.LIQUID && el.cat !== CAT.GAS;
  }

  // Можно ли встать в клетку (nx,ny): она проходима, под ней есть опора,
  // она не опасна и не занесена в личный список запретов.
  //
  // Проверка опоры — то, чего здесь не хватало: без неё человек в панике
  // преспокойно убегал ПО ВОЗДУХУ, потому что шаг в пустоту ничем не
  // отличался от шага по земле, а падал он только в следующем кадре, к
  // началу которого успевал сделать ещё шаг.
  humanCanStand(nx, ny, mind) {
    if (!this.inBounds(nx, ny)) return false;
    const ci = ny * this.w + nx;
    if (!this.humanPassable(this.type[ci])) return false;
    if (mind.bans.has(ci)) return false;
    if (!this.humanSupports(nx, ny + 1)) return false;
    if (ny + 1 < this.h && this.humanDeadly(this.type[ci + this.w])) return false;
    return true;
  }

  // Шаг в сторону dir: прямо, на ступеньку вверх или на ступеньку вниз.
  // Спуск нужен, чтобы человек мог сойти с уступа, а не топтаться на
  // краю: без него требование опоры под ногами заперло бы его на любой
  // площадке, откуда некуда шагнуть по ровному.
  humanStep(x, y, i, dir, mind) {
    if (this.humanCanStand(x + dir, y, mind)) {
      const ni = this.idx(x + dir, y);
      this.swapFields(i, ni); this.moved[ni] = 1; return true;
    }
    if (y - 1 >= 0 && this.humanCanStand(x + dir, y - 1, mind) && this.humanPassable(this.type[this.idx(x, y - 1)])) {
      const ni = this.idx(x + dir, y - 1);
      this.swapFields(i, ni); this.moved[ni] = 1; return true;
    }
    if (y + 1 < this.h && this.humanCanStand(x + dir, y + 1, mind) && this.humanPassable(this.type[this.idx(x + dir, y)])) {
      const ni = this.idx(x + dir, y + 1);
      this.swapFields(i, ni); this.moved[ni] = 1; return true;
    }
    return false;
  }

  reactHuman(x, y, i) {
    if (this.extra[i]) return; // мёртв: только падает
    const mind = this.humanMind(i);

    // 1. Смертельные прикосновения.
    for (let k = 0; k < 4; k++) {
      const nx = x + DX4[k], ny = y + DY4[k];
      if (!this.inBounds(nx, ny)) continue;
      const nt = this.type[this.idx(nx, ny)];
      if (nt === EL.SOLUTION) {
        const c = this.comp(this.idx(nx, ny));
        if (!solGet(c, P_ACID) && !solGet(c, P_REAGENT)) continue;
      }
      if (this.humanDeadly(nt)) { this.humanDie(i); return; }
    }

    // 2. Вода над головой: терпит, пока хватает дыхания.
    const above = y > 0 ? this.type[this.idx(x, y - 1)] : EL.EMPTY;
    if (above === EL.WATER || above === EL.SOLUTION) {
      mind.wet++;
      if (mind.wet >= HUMAN_DROWN_FRAMES) { this.humanDie(i); return; }
    } else if (mind.wet > 0) {
      mind.wet--;
    }

    // 3. Кислотная туча сверху — прячемся под крышу; нет крыши поблизости
    //    — бежим куда попало, лишь бы отсюда.
    if (this.humanAcidCloudAbove(x, y)) {
      if (!this.humanHasRoof(x, y)) {
        let dir = mind.dir;
        for (let step = 1; step <= HUMAN_SHELTER_RANGE; step++) {
          if (this.humanHasRoof(Math.min(this.w - 1, x + step), y)) { dir = 1; break; }
          if (this.humanHasRoof(Math.max(0, x - step), y)) { dir = -1; break; }
        }
        mind.dir = dir;
        if (!this.humanStep(x, y, i, dir, mind)) {
          mind.dir = -dir;
          this.humanStep(x, y, i, -dir, mind);
        }
        return;
      }
      return; // под крышей пережидаем
    }

    // 4. Осмотр окрестностей — не каждый кадр (см. HUMAN_SCAN_PERIOD).
    if ((this.frame + this.life[i]) % HUMAN_SCAN_PERIOD === 0) {
      const flee = this.humanLookAround(x, y, mind);
      if (flee) { mind.dir = flee; mind.flee = HUMAN_FLEE_FRAMES; }
    }

    // 5. Паника: бежим каждый кадр, пока не отпустит. Если в выбранную
    //    сторону хода нет — пробуем противоположную, а не стоим на месте.
    if (mind.flee > 0) {
      mind.flee--;
      if (this.humanStep(x, y, i, mind.dir, mind)) return;
      mind.dir = -mind.dir;
      if (this.humanStep(x, y, i, mind.dir, mind)) return;
      return;
    }

    // 6. Спокойная ходьба.
    if (Math.random() < HUMAN_TURN_CHANCE) mind.dir = -mind.dir;
    if (Math.random() >= HUMAN_STEP_CHANCE) return;
    if (!this.humanStep(x, y, i, mind.dir, mind)) mind.dir = -mind.dir;
  }

  // Смерть: человек темнеет и застывает. Память освобождается — она была
  // нужна живому.
  humanDie(i) {
    this.extra[i] = 1;
    this._humans.delete(this.life[i]);
  }
}

extendSim(SimHuman);
