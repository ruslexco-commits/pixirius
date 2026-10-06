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
// Личная карта опасных мест: увидел опасное (кислоту, огонь...) — участок
// HUMAN_BAN_CELL x HUMAN_BAN_CELL клеток, где оно было, заносится в карту, и
// спокойно человек туда больше не пойдёт — ни в сам участок, ни в соседние
// (просьба пользователя: "увидел кислоту и больше туда ни ногой"). Раньше
// запоминались только сами опасные клетки, и человек подходил к луже
// вплотную, а она растекалась. Убегая (паника, туча), он запреты не
// соблюдает: бежит он и так прочь от опасного, а участки вокруг могли
// запереть его на месте. Карта не бесконечная: самые старые участки
// вытесняются, иначе за долгую игру она разрастётся.
const HUMAN_BAN_CELL = 4;
const HUMAN_BAN_LIMIT = 96;
// Сходит с уступа, только если падать не выше HUMAN_MAX_DROP пикселей
// (просьба пользователя: избегать падений больше чем с 3 пикселей), и
// запрыгивает на уступ до HUMAN_JUMP пикселей: препятствие в 2 пикселя
// перепрыгивает, а если впереди и снизу проход, и сверху уступ на 2
// пикселя — с шансом HUMAN_JUMP_UP_CHANCE за шаг выбирает верхний.
const HUMAN_MAX_DROP = 3;
const HUMAN_JUMP = 2;
const HUMAN_JUMP_UP_CHANCE = 0.3;
// Газы кислоты и реагента (просьба пользователя): увидев такой газ, человек
// запоминает столбец участков, где он был (mind.gas, по HUMAN_BAN_CELL), и
// там — в нём и в соседних столбцах — не стоит без крыши над головой:
// спокойно туда без крыши не ступает, а оказавшись там под открытым небом,
// ищет крышу, как от тучи над головой. Газ поднимается, поэтому помнится
// столбец, а не высота. Память — до HUMAN_GAS_LIMIT столбцов.
const HUMAN_GAS_LIMIT = 48;
// Обвалы и окисел камня — сразу (жалоба пользователя: люди не боялись
// осыпающегося). Полный осмотр идёт раз в HUMAN_SCAN_PERIOD кадров, и
// падающее тело успевало упасть и встать между осмотрами. Поэтому каждый
// кадр человек ближним взглядом, на HUMAN_NEAR_SIGHT клеток, ищет падающее
// (fall), продавленное (crushed) и окисел камня — и сразу отмечает участок
// опасным и убегает. А если опора ушла у него из-под ног, когда он сам вниз
// не шагал (провалился), опасным становится участок вокруг места, где он
// стоял, и соседние по сторонам.
const HUMAN_NEAR_SIGHT = 6;
// Насколько высоко человек согласен искать крышу над головой и насколько
// далеко в стороны уходить, спасаясь от кислотной тучи.
const HUMAN_ROOF_HEIGHT = 24;
const HUMAN_SHELTER_RANGE = 30;
// Плавание (humanSwim и протагонист): запас сил в кадрах плавания,
// восстановление за кадр на сухой опоре, ход вплавь — раз в столько кадров.
const SWIM_STAMINA = 300;
const SWIM_REGEN = 3;
const SWIM_FRAMES = 3;
// Как часто пловец ищет ближайший берег и как далеко вдоль ряда смотрит.
const SWIM_LOOK = 12;
const SWIM_SHORE_RANGE = 80;
// Радиус пятна крови вокруг раздавленного (crushBody).
const CRUSH_RADIUS = 2;

// Отравление (просьба пользователя): реагент и окисел камня не убивают
// касанием сразу. Пока живой (человек или протагонист) касается яда, он
// желтеет — отравление растёт тем быстрее, чем ядовитее то, чего он
// касается (poisonRate: чистый реагент — смертельная доза за полторы
// секунды, POISON_REAGENT_RATE; раствор — по доле реагента; окисел камня —
// POISON_OXIDE_RATE на стадию); отошёл — желтеть перестаёт и очень
// медленно приходит в себя (минус 1 раз в POISON_RECOVER_PERIOD кадров —
// в 30 раз медленнее первой версии). Дошло до 255 — погиб и рассыпался сыпучим окислом камня.
// (Первая версия травила необратимо: раз коснулся — желтеешь до смерти;
// пользователь поправил.) Отравление — в поле stain самой клетки (у живых
// крови не бывает, а поле едет с частицей и уже рисуется: у людей и
// протагониста — жёлтым, см. Renderer.cellColor и шейдер). Ник игрока
// желтеет так же (NameTags, js/play.js), по краям экрана — жёлтая пелена.
const POISON_REAGENT_RATE = 255 / 90;
const POISON_OXIDE_RATE = 0.15;
const POISON_RECOVER_PERIOD = 60;

// Удары (просьба пользователя): протагонист бьёт людей (а с "огнём по
// своим" у хоста — и других игроков, sim.friendlyFire) так же, как ломает
// пиксели (playerMine): три удара — смерть. Урон — в поле dirt живого
// (грязь к живым не липнет, см. dirtable): +HIT_DAMAGE за удар, рисуется
// красным; со временем заживает (минус 1 раз в HEAL_PERIOD кадров). Убитый
// разлетается кровью, как раздавленный (crushBody). Ударенный человек
// HUMAN_FEAR_FRAMES кадров убегает от ударившего, если тот ближе
// HUMAN_FEAR_RANGE клеток.
const HIT_DAMAGE = 90;   // три подряд — 270: с запасом на заживление между ударами
const HEAL_PERIOD = 3;
const HUMAN_FEAR_FRAMES = 900;
const HUMAN_FEAR_RANGE = 40;
// Лужица крови под ударенным (stain клеток под ним, просьба пользователя).
const HIT_BLOOD = 150;
// Человек, который столько попыток подряд не может шагнуть ни в одну
// сторону (зажат запретами своей карты опасностей — в мультиплеере, где все
// копают, "обвалов" много), пугается и уходит, не глядя на запреты
// (running). Раньше стоял "как вкопанный", пока его не ударят (жалоба
// пользователя).
const HUMAN_STUCK_LIMIT = 40;

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
      mind = { bans: new Set(), banOrder: [], gas: new Set(), gasOrder: [], dir: Math.random() < 0.5 ? 1 : -1, wet: 0, flee: 0 };
      this._humans.set(id, mind);
    }
    return mind;
  }

  // Смертельное при прикосновении.
  humanDeadly(t) {
    if (t === EL.FIRE || t === EL.LAVA || t === EL.ACID || t === EL.REAGENT) return true;
    if (t === EL.OXIDE || t === EL.OXIDE_LOOSE) return true;
    if (t === EL.SOLUTION) return true;
    if (IS_MOLTEN[t] === 1) return true;   // расплавы металлов жгут, как лава
    return false;
  }

  // Опасное, что человек старается обходить стороной (шире смертельного:
  // сюда же газы и замёрзшая кислота — соседство с ними добром не
  // кончится, даже если само касание не убивает).
  humanDanger(t) {
    if (this.humanDeadly(t)) return true;
    if (t === EL.ACID_GAS || t === EL.REAGENT_GAS || t === EL.ACID_ICE || t === EL.REAGENT_ICE) return true;
    if (t === EL.VAPOR) return true;
    return false;
  }

  // Ядовитый газ в клетке i: газ кислоты или реагента, либо смешанный газ
  // с их долями (см. HUMAN_GAS_LIMIT).
  humanToxicGas(i) {
    const t = this.type[i];
    if (t === EL.ACID_GAS || t === EL.REAGENT_GAS) return true;
    if (!isVaporFamily(t)) return false;
    const c = this.comp(i);
    return solGet(c, P_ACID) > 0 || solGet(c, P_REAGENT) > 0;
  }

  // Запомнить столбец участков, где был ядовитый газ.
  humanGasMark(mind, x) {
    if (!mind.gas) { mind.gas = new Set(); mind.gasOrder = []; }   // память из старой версии
    const bx = (x / HUMAN_BAN_CELL) | 0;
    if (mind.gas.has(bx)) return;
    mind.gas.add(bx);
    mind.gasOrder.push(bx);
    if (mind.gasOrder.length > HUMAN_GAS_LIMIT) mind.gas.delete(mind.gasOrder.shift());
  }

  // Столбец x — в запомненном газовом месте или рядом с ним.
  humanInGasZone(mind, x) {
    if (!mind.gas || mind.gas.size === 0) return false;
    const bx = (x / HUMAN_BAN_CELL) | 0;
    return mind.gas.has(bx) || mind.gas.has(bx - 1) || mind.gas.has(bx + 1);
  }

  // Непрозрачное для взгляда: сквозь стены и камни человек не видит, а
  // сквозь воздух, газы и жидкости — видит.
  humanBlocksSight(t) {
    if (IS_SEE_THROUGH[t] === 1) return false;   // стекло, люди
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

  // Номер участка карты опасных мест (см. HUMAN_BAN_CELL) для клетки (x, y).
  humanBanKey(x, y) {
    const bw = Math.ceil(this.w / HUMAN_BAN_CELL);
    return ((y / HUMAN_BAN_CELL) | 0) * bw + ((x / HUMAN_BAN_CELL) | 0);
  }

  // Занести в карту участок, где опасная клетка ci. Карта ограничена:
  // самый старый участок вытесняется новым.
  humanBan(mind, ci) {
    const key = this.humanBanKey(ci % this.w, (ci / this.w) | 0);
    if (mind.bans.has(key)) return;
    mind.bans.add(key);
    mind.banOrder.push(key);
    if (mind.banOrder.length > HUMAN_BAN_LIMIT) {
      mind.bans.delete(mind.banOrder.shift());
    }
  }

  // Клетка (x, y) в опасном участке карты или рядом с ним.
  humanBanned(mind, x, y) {
    if (mind.bans.size === 0) return false;
    const bw = Math.ceil(this.w / HUMAN_BAN_CELL);
    const bx = (x / HUMAN_BAN_CELL) | 0, by = (y / HUMAN_BAN_CELL) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (bx + dx < 0 || bx + dx >= bw) continue;
        if (mind.bans.has((by + dy) * bw + bx + dx)) return true;
      }
    }
    return false;
  }

  // Ядовитая туча над человеком — газ кислоты или реагента где угодно выше
  // по его колонке: клетка газа или -1. Радиус обзора тут не действует: туча
  // приходит сверху, и заметить её человек должен на любой высоте.
  humanAcidCloudAbove(x, y) {
    for (let ny = y - 1; ny >= 0; ny--) {
      const i = this.idx(x, ny), t = this.type[i];
      if (t === EL.EMPTY) continue;
      if (isVaporFamily(t) || t === EL.REAGENT_GAS) {
        if (this.humanToxicGas(i)) return i;
        continue;
      }
      // Дошли до чего-то плотного — дальше не видно, да и незачем: это
      // уже крыша.
      if (this.humanBlocksSight(t)) return -1;
    }
    return -1;
  }

  // Запомнить тучу целиком: все столбцы, вдоль которых в ряду клетки gi
  // тянется ядовитый газ (не дальше HUMAN_SHELTER_RANGE в каждую сторону).
  // Помнить только столбец над головой мало: туча шире, и в соседних её
  // столбцах он выходил бы под открытое небо.
  humanGasMarkCloud(mind, gi) {
    const w = this.w, gx = gi % w, row = gi - gx;
    this.humanGasMark(mind, gx);
    for (let d = 1; d <= HUMAN_SHELTER_RANGE && gx + d < w && this.humanToxicGas(row + gx + d); d++) this.humanGasMark(mind, gx + d);
    for (let d = 1; d <= HUMAN_SHELTER_RANGE && gx - d >= 0 && this.humanToxicGas(row + gx - d); d++) this.humanGasMark(mind, gx - d);
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
        // Обвал — падающее тело (fall стоит, пока оно летит, см.
        // sim/landing.js) — тоже опасное место (просьба пользователя).
        const collapse = this.fall[ci] === 1;
        if (!collapse && !this.humanDanger(this.type[ci])) continue;
        if (!this.humanCanSee(x, y, nx, ny)) continue;
        this.humanBan(mind, ci);
        if (!collapse && this.humanToxicGas(ci)) this.humanGasMark(mind, nx);
        if (d2 < nearest) { nearest = d2; flee = dx === 0 ? (Math.random() < 0.5 ? 1 : -1) : (dx > 0 ? -1 : 1); }
      }
    }
    return flee;
  }

  // Ближний взгляд (см. HUMAN_NEAR_SIGHT): падающее, продавленное и окисел
  // камня в прямой видимости — участок в карту; сторона, куда отбежать,
  // или 0. Не тратит случайных чисел, если ничего не нашёл.
  humanLookNear(x, y, mind) {
    const R = HUMAN_NEAR_SIGHT, w = this.w, type = this.type, fall = this.fall, crushed = this.crushed;
    let flee = 0, nearest = 1e9;
    const x0 = Math.max(0, x - R), x1 = Math.min(w - 1, x + R), y0 = Math.max(0, y - R), y1 = Math.min(this.h - 1, y + R);
    for (let ny = y0; ny <= y1; ny++) {
      for (let nx = x0, ci = ny * w + x0; nx <= x1; nx++, ci++) {
        const t = type[ci];
        if (fall[ci] !== 1 && crushed[ci] === 0 && t !== EL.OXIDE && t !== EL.OXIDE_LOOSE) continue;
        const dx = nx - x, dy = ny - y, d2 = dx * dx + dy * dy;
        if (d2 === 0 || d2 > R * R || !this.humanCanSee(x, y, nx, ny)) continue;
        this.humanBan(mind, ci);
        if (d2 < nearest) { nearest = d2; flee = dx > 0 ? -1 : dx < 0 ? 1 : -mind.dir; }
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
  // она не опасна и не в опасном участке личной карты (кроме бегства —
  // mind.running, см. HUMAN_BAN_CELL).
  //
  // Проверка опоры — то, чего здесь не хватало: без неё человек в панике
  // преспокойно убегал ПО ВОЗДУХУ, потому что шаг в пустоту ничем не
  // отличался от шага по земле, а падал он только в следующем кадре, к
  // началу которого успевал сделать ещё шаг.
  humanCanStand(nx, ny, mind) {
    if (!this.inBounds(nx, ny)) return false;
    const ci = ny * this.w + nx;
    if (!this.humanPassable(this.type[ci])) return false;
    if (!mind.running && this.humanBanned(mind, nx, ny)) return false;
    if (!this.humanSupports(nx, ny + 1)) return false;
    // В запомненном газовом месте — только под крышей.
    if (!mind.running && this.humanInGasZone(mind, nx) && !this.humanHasRoof(nx, ny)) return false;
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
    // Препятствие в 2 пикселя — перепрыгнуть (см. HUMAN_JUMP).
    if (this.humanJumpUp(x, y, i, dir, mind)) return true;
    // Уступ вниз глубже ступеньки — сойти, если падать не выше
    // HUMAN_MAX_DROP: шагнуть в пустоту над местом приземления, дальше
    // человек падает обычной физикой.
    const fx = x + dir;
    if (fx >= 0 && fx < this.w && this.humanPassable(this.type[this.idx(fx, y)]) && (mind.running || !this.humanBanned(mind, fx, y))) {
      let d = 0;
      while (d < HUMAN_MAX_DROP && y + 1 + d < this.h && this.humanPassable(this.type[this.idx(fx, y + 1 + d)])) d++;
      if (d >= 2 && this.humanCanStand(fx, y + d, mind)) {
        const ni = this.idx(fx, y);
        this.swapFields(i, ni); this.moved[ni] = 1;
        mind.selfDrop = true;   // спрыгнул сам — это не провал
        return true;
      }
    }
    return false;
  }

  // Запрыгнуть на уступ в HUMAN_JUMP пикселей впереди (x + dir, y - h): там
  // можно встать, а над головой свободно на всю высоту прыжка.
  humanJumpUp(x, y, i, dir, mind) {
    const fx = x + dir, h = HUMAN_JUMP;
    if (fx < 0 || fx >= this.w || y - h < 0) return false;
    for (let k = 1; k <= h; k++) if (!this.humanPassable(this.type[this.idx(x, y - k)])) return false;
    if (!this.humanCanStand(fx, y - h, mind)) return false;
    const ni = this.idx(fx, y - h);
    this.swapFields(i, ni); this.moved[ni] = 1;
    return true;
  }

  reactHuman(x, y, i) {
    if (this.extra[i]) return; // мёртв: только падает
    const mind = this.humanMind(i);

    // 1. Смертельные прикосновения; яд (реагент, окисел камня) — травит.
    let poisoned = 0;
    for (let k = 0; k < 4; k++) {
      const nx = x + DX4[k], ny = y + DY4[k];
      if (!this.inBounds(nx, ny)) continue;
      const ni = this.idx(nx, ny), nt = this.type[ni];
      if (this.poisoner(nt, ni)) { poisoned = Math.max(poisoned, this.poisonRate(nt, ni)); continue; }
      if (nt === EL.SOLUTION) {
        const c = this.comp(ni);
        if (!solGet(c, P_ACID)) continue;
      }
      if (this.humanDeadly(nt)) { this.humanDie(i); return; }
    }
    if (this.poisonTick(i, poisoned)) {
      this._humans.delete(this.life[i]);
      this.poisonDeath(i);
      return;
    }
    this.healTick(i);
    // Ударил игрок — бежит от него, пока страх не пройдёт (см. HIT_DAMAGE).
    if (mind.fearT > 0) {
      mind.fearT--;
      const a = this.playerSlot(mind.fearOf).idx;
      if (a >= 0 && this.type[a] === EL.PROTAGONIST && Math.abs((a % this.w) - x) < HUMAN_FEAR_RANGE && Math.abs(((a / this.w) | 0) - y) < HUMAN_FEAR_RANGE) {
        mind.dir = x >= a % this.w ? 1 : -1;
        if (mind.flee < 2) mind.flee = 2;
      }
    }

    // 2. Вода над головой или завален со всех сторон: терпит, пока хватает
    //    дыхания.
    const above = y > 0 ? this.type[this.idx(x, y - 1)] : EL.EMPTY;
    if (above === EL.WATER || above === EL.SOLUTION || this.walledIn(x, y)) {
      mind.wet++;
      if (mind.wet >= HUMAN_DROWN_FRAMES) { this.humanDie(i); return; }
    } else if (mind.wet > 0) {
      mind.wet--;
    }

    // 2б. В воде — плывёт (humanSwim); выбился из сил — тонет.
    if (this.humanSwim(x, y, i, mind)) return;

    // 2в. Под ногами пусто — падает (физика сыпучего), в воздухе не шагает:
    //     иначе, сойдя с уступа, он шёл бы по воздуху дальше. Опора ушла, а
    //     сам он вниз не шагал — провалился: место опасное (HUMAN_NEAR_SIGHT).
    const grounded = this.humanSupports(x, y + 1);
    if (!grounded) {
      if (mind.grounded && !mind.selfDrop) {
        for (let dx = -HUMAN_BAN_CELL; dx <= HUMAN_BAN_CELL; dx += HUMAN_BAN_CELL) {
          const bx = Math.min(this.w - 1, Math.max(0, x + dx));
          this.humanBan(mind, y * this.w + bx);
          if (y + 1 < this.h) this.humanBan(mind, (y + 1) * this.w + bx);
        }
      }
      mind.grounded = false;
      return;
    }
    mind.grounded = true;
    mind.selfDrop = false;

    // 2г. Ближний взгляд каждый кадр: обвал, продавленное, окисел камня.
    const nearFlee = this.humanLookNear(x, y, mind);
    if (nearFlee) { mind.dir = nearFlee; mind.flee = HUMAN_FLEE_FRAMES; }

    // 3. Кислотная туча сверху — прячемся под крышу; нет крыши поблизости
    //    — бежим куда попало, лишь бы отсюда.
    // Туча над головой — или под открытым небом в месте, где он видел
    // ядовитый газ (см. HUMAN_GAS_LIMIT).
    const gi = this.humanAcidCloudAbove(x, y), cloud = gi >= 0;
    if (cloud) this.humanGasMarkCloud(mind, gi);
    if (cloud || (this.humanInGasZone(mind, x) && !this.humanHasRoof(x, y))) {
      mind.running = true;
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
        mind.running = false;
        return;
      }
      mind.running = false;
      if (cloud) return; // под крышей пережидаем тучу
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
      mind.running = true;
      if (!this.humanStep(x, y, i, mind.dir, mind)) {
        mind.dir = -mind.dir;
        this.humanStep(x, y, i, mind.dir, mind);
      }
      mind.running = false;
      return;
    }

    // 6. Спокойная ходьба. Впереди и снизу проход, и сверху уступ на
    //    HUMAN_JUMP — иногда выбирает верхний.
    if (Math.random() < HUMAN_TURN_CHANCE) mind.dir = -mind.dir;
    if (Math.random() >= HUMAN_STEP_CHANCE) return;
    if (Math.random() < HUMAN_JUMP_UP_CHANCE && this.humanJumpUp(x, y, i, mind.dir, mind)) { mind.stuck = 0; return; }
    if (this.humanStep(x, y, i, mind.dir, mind)) { mind.stuck = 0; return; }
    mind.dir = -mind.dir;
    // Зажат запретами — уйти, не глядя на них (см. HUMAN_STUCK_LIMIT).
    if ((mind.stuck = (mind.stuck || 0) + 1) >= HUMAN_STUCK_LIMIT) { mind.stuck = 0; mind.flee = HUMAN_FLEE_FRAMES; }
  }

  // Нет ни одного свободного (пустого) пикселя вокруг, считая углы:
  // завален — задыхается так же, как под водой (просьба пользователя).
  walledIn(x, y) {
    const w = this.w, h = this.h, type = this.type;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        if ((dx || dy) && nx >= 0 && nx < w && type[ny * w + nx] === EL.EMPTY) return false;
      }
    }
    return true;
  }

  // Слева и справа от клетки (x, y) нет пустоты: пловец здесь "на уровне
  // воды". Пустота сбоку значит, что он торчит над водой, — тогда он
  // уходит глубже, иначе по воде можно было бы ходить (просьба
  // пользователя). Край поля и стенка сбоку пустотой не считаются.
  //
  // Пустота сбоку, под которой твёрдое, — это воздух над берегом, а не над
  // водой: у самого берега в верхнем слое воды сбоку всегда такая, и без
  // этой оговорки пловец не мог подняться в верхний слой у берега, а только
  // оттуда можно выйти на сушу, — он бился о берег снизу, пока не выбивался
  // из сил, и тонул.
  swimLevelOk(x, y) {
    return this.swimSideOk(x - 1, y) && this.swimSideOk(x + 1, y);
  }

  swimSideOk(x, y) {
    if (x < 0 || x >= this.w) return true;
    const i = y * this.w + x;
    if (this.type[i] !== EL.EMPTY) return true;
    if (y + 1 >= this.h) return true;
    const below = this.type[i + this.w];
    return below !== EL.EMPTY && IS_LIQUID[below] !== 1;
  }

  // Человек в воде: всплывает до уровня воды, держится на нём и плывёт к
  // берегу, пока хватает сил (mind.stamina). Выбился из сил — больше не
  // плывёт, пока не выберется на сухое, и тонет (физика сыпучего). true —
  // этот кадр он плыл, дальше ничего делать не надо.
  humanSwim(x, y, i, mind) {
    const w = this.w, h = this.h, type = this.type;
    if (mind.stamina === undefined) { mind.stamina = SWIM_STAMINA; mind.exhausted = false; }
    const liqA = y > 0 && IS_LIQUID[type[i - w]] === 1;
    const liqB = y + 1 < h && IS_LIQUID[type[i + w]] === 1;
    if (!liqA && !liqB) {
      // Отдыхает только на сухом: ни над, ни под ним не вода.
      if (this.humanSupports(x, y + 1)) {
        mind.exhausted = false;
        mind.stamina = Math.min(SWIM_STAMINA, mind.stamina + SWIM_REGEN);
      }
      return false;
    }
    if (mind.exhausted) return false;
    if (--mind.stamina <= 0) { mind.exhausted = true; return false; }
    // Под водой — вверх, пока выше тоже вода и там уровень воды.
    if (liqA && this.swimLevelOk(x, y - 1)) {
      if (this.frame % SWIM_FRAMES === 0) { this.swapFields(i, i - w); this.moved[i - w] = 1; }
      else this.moved[i] = 1;
      return true;
    }
    // На уровне воды: держится и плывёт к ближайшему берегу (раз в
    // SWIM_LOOK кадров оглядывается, где он). Наугад, от стенки к стенке,
    // он выбивался из сил в бассейне, где берег был в десятке клеток.
    if (liqB && this.swimLevelOk(x, y)) {
      this.moved[i] = 1;
      if ((this.frame + this.life[i]) % SWIM_LOOK === 0) {
        const shore = this.humanShoreDir(x, y, mind);
        if (shore) mind.dir = shore;
      }
      if (this.frame % SWIM_FRAMES !== 0) return true;
      const dir = mind.dir, nx = x + dir;
      if (nx < 0 || nx >= w) { mind.dir = -dir; return true; }
      const t = type[i + dir];
      if (IS_LIQUID[t] === 1) { this.swapFields(i, i + dir); this.moved[i + dir] = 1; return true; }
      if (this.humanCanWade(nx, y, mind)) { this.swapFields(i, i + dir); this.moved[i + dir] = 1; return true; }
      // Берег на ступеньку выше — выбраться на него. Над головой может
      // плескаться вода: неполный верхний слой бассейна гуляет, и требование
      // пустоты над головой не выпускало пловца на берег.
      if (y > 0 && (type[i - w] === EL.EMPTY || IS_LIQUID[type[i - w]] === 1) && this.humanCanWade(nx, y - 1, mind)) {
        this.swapFields(i, i - w + dir); this.moved[i - w + dir] = 1; return true;
      }
      mind.dir = -dir;
      return true;
    }
    return false;   // сбоку пустота — над водой не удержаться, уходит глубже
  }

  // Можно ли пловцу выйти в клетку (nx, ny): как humanCanStand, но и в
  // мелкую воду — жидкость, под которой твёрдая опора. Неполный верхний
  // слой бассейна растекается плёнкой и по берегу, и "только в пустоту"
  // оставляло пловца без выхода: берег был затоплен на клетку, и он тонул у
  // самой кромки.
  humanCanWade(nx, ny, mind) {
    if (!this.inBounds(nx, ny)) return false;
    const ci = ny * this.w + nx, t = this.type[ci];
    if (t !== EL.EMPTY && IS_LIQUID[t] !== 1) return false;
    if (t !== EL.EMPTY && this.humanDeadly(t)) return false;
    if (this.humanBanned(mind, nx, ny)) return false;
    if (!this.humanSupports(nx, ny + 1)) return false;
    if (ny + 1 < this.h && this.humanDeadly(this.type[ci + this.w])) return false;
    return true;
  }

  // В какую сторону ближайший берег от пловца в (x, y): место в том же ряду
  // или ступенькой выше, где можно встать. 0 — в пределах
  // SWIM_SHORE_RANGE не видно.
  humanShoreDir(x, y, mind) {
    for (let d = 1; d <= SWIM_SHORE_RANGE; d++) {
      for (let side = 0; side < 2; side++) {
        const dir = side === 0 ? mind.dir : -mind.dir;
        const nx = x + dir * d;
        if (nx < 0 || nx >= this.w) continue;
        if (this.humanCanWade(nx, y, mind) || (y > 0 && this.humanCanWade(nx, y - 1, mind))) return dir;
      }
    }
    return 0;
  }

  // Раздавлен падающим твёрдым (см. attemptSwapOrMove): тело исчезает,
  // занятые клетки вокруг покрываются кровью (поле stain) — гуще ближе к
  // месту. Память человека живёт на главном потоке, поэтому при
  // параллельном обходе она просто остаётся лишней записью в Map.
  crushBody(vi) {
    const w = this.w, h = this.h, x0 = vi % w, y0 = (vi / w) | 0;
    if (this.type[vi] === EL.HUMAN && !this._inBand) this._humans.delete(this.life[vi]);
    // Причину смерти протагониста пишет только главный поток: у рабочего
    // своя копия playerState. Для раздавленного в полосе потока причину
    // угадывает js/play.js — по крови на месте, где он пропал.
    if (this.type[vi] === EL.PROTAGONIST && !this._inBand) {
      const st = this.playerSlot(this.life[vi]).state;
      st.death = 'Раздавлен упавшим телом';
      st.deathKind = 'crushed';
    }
    this.clearCell(vi);
    const R = CRUSH_RADIUS;
    for (let dy = -R; dy <= R; dy++) {
      const y = y0 + dy;
      if (y < 0 || y >= h) continue;
      for (let dx = -R; dx <= R; dx++) {
        const x = x0 + dx, d2 = dx * dx + dy * dy;
        if (x < 0 || x >= w || d2 > R * R + 1) continue;
        const k = y * w + x;
        // У живых stain — отравление (см. POISON_STEP), кровью не пачкаются.
        if (this.type[k] === EL.EMPTY || this.type[k] === EL.HUMAN || this.type[k] === EL.PROTAGONIST) continue;
        const v = 255 - d2 * 40;
        if (v > this.stain[k]) { this.stain[k] = v; this.markDirty(k); }
      }
    }
  }

  // Яд для живого (см. POISON_STEP): реагент, окисел камня, раствор с
  // реагентом без кислоты (кислота убивает сразу).
  poisoner(t, j) {
    if (t === EL.REAGENT || t === EL.OXIDE || t === EL.OXIDE_LOOSE) return true;
    if (t === EL.SOLUTION) { const c = this.comp(j); return solGet(c, P_REAGENT) > 0 && solGet(c, P_ACID) === 0; }
    return false;
  }

  // Насколько травит касание яда t в клетке j (в кадр, см. POISON_*).
  poisonRate(t, j) {
    if (t === EL.REAGENT) return POISON_REAGENT_RATE;
    if (t === EL.SOLUTION) return POISON_REAGENT_RATE * solGet(this.comp(j), P_REAGENT) / SOL_PARTS;
    if (t === EL.OXIDE || t === EL.OXIDE_LOOSE) return POISON_OXIDE_RATE * Math.max(1, this.oxideStage(j));
    return 0;
  }

  // Отравление клетки i за кадр (rate — сколько добавляет касание яда,
  // 0 — не касается; дробная часть — броском). true — умер.
  poisonTick(i, rate) {
    let p = this.stain[i];
    if (rate > 0) {
      const whole = Math.floor(rate);
      p += whole + (Math.random() < rate - whole ? 1 : 0);
      if (p >= 255) return true;
    } else if (p > 0 && this.frame % POISON_RECOVER_PERIOD === 0) p--;
    else return false;
    this.stain[i] = p;
    this.markDirty(i);
    return false;
  }

  // Урон живого (dirt, см. HIT_DAMAGE) понемногу заживает.
  healTick(i) {
    if (this.dirt[i] === 0 || this.frame % HEAL_PERIOD !== 0) return;
    this.dirt[i]--;
    this.markDirty(i);
  }

  // Удар живому в клетке j от протагониста в клетке by. true — убит.
  hitCreature(j, by) {
    const t = this.type[j], d = Math.min(255, this.dirt[j] + HIT_DAMAGE);
    if (d >= 255) {
      const st = t === EL.PROTAGONIST ? this.playerSlot(this.life[j]).state : null;
      this.crushBody(j);
      if (st) { st.death = 'Убит другим игроком'; st.deathKind = 'killed'; }
      return true;
    }
    this.dirt[j] = d;
    this.markDirty(j);
    // Лужица крови под ним (клетки ниже, не живые).
    const w = this.w, x = j % w, y = (j / w) | 0;
    if (y + 1 < this.h) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        if (nx < 0 || nx >= w) continue;
        const k = (y + 1) * w + nx, tk = this.type[k];
        if (tk === EL.EMPTY || tk === EL.HUMAN || tk === EL.PROTAGONIST) continue;
        if (this.stain[k] < HIT_BLOOD) { this.stain[k] = HIT_BLOOD; this.markDirty(k); }
      }
    }
    if (t === EL.HUMAN) {
      const mind = this.humanMind(j);
      mind.fearOf = this.life[by];
      mind.fearT = HUMAN_FEAR_FRAMES;
      mind.dir = (j % this.w) >= (by % this.w) ? 1 : -1;
      mind.flee = HUMAN_FLEE_FRAMES;
    }
    return false;
  }

  // Умер от яда — рассыпался сыпучим окислом камня.
  poisonDeath(i) {
    this.spawn(i, EL.OXIDE_LOOSE, false);
  }

  // Смерть: человек темнеет и застывает. Память освобождается — она была
  // нужна живому.
  humanDie(i) {
    this.extra[i] = 1;
    this._humans.delete(this.life[i]);
  }
}

extendSim(SimHuman);
