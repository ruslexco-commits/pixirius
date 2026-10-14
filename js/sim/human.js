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
const HUMAN_SIGHT = 20;
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
const HUMAN_BAN_CELL = 8;
const HUMAN_BAN_LIMIT = 96;
// Сходит с уступа, только если падать не выше HUMAN_MAX_DROP пикселей
// (просьба пользователя: избегать падений больше чем с 3 пикселей), и
// запрыгивает на уступ до HUMAN_JUMP пикселей: препятствие в 2 пикселя
// перепрыгивает, а если впереди и снизу проход, и сверху уступ на 2
// пикселя — с шансом HUMAN_JUMP_UP_CHANCE за шаг выбирает верхний.
const HUMAN_MAX_DROP = 6;
const HUMAN_JUMP = 4;
// Ступенька, на которую шагает не прыгая (тело в 16 клеток); из воды на
// берег — выше: пловец с головой у поверхности упирается в берег на глубине
// тела и вылезает на него, упираясь руками.
const HUMAN_STEP_UP = 2;
const HUMAN_WADE_UP = 6;
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
const HUMAN_NEAR_SIGHT = 10;
// Насколько высоко человек согласен искать крышу над головой и насколько
// далеко в стороны уходить, спасаясь от кислотной тучи.
const HUMAN_ROOF_HEIGHT = 40;
const HUMAN_SHELTER_RANGE = 30;
// Плавание (humanSwim и протагонист): запас сил в кадрах плавания,
// восстановление за кадр на сухой опоре, ход вплавь — раз в столько кадров.
const SWIM_STAMINA = 300;
const SWIM_REGEN = 3;
const SWIM_FRAMES = 3;
// Как часто пловец ищет ближайший берег и как далеко вдоль ряда смотрит.
const SWIM_LOOK = 12;
const SWIM_SHORE_RANGE = 80;
// Радиус пятна крови вокруг раздавленного (crushBody) и сколько капель крови
// (EL.BLOOD) выливается при этом; удар — HIT_BLOOD_DROPS капель.
const CRUSH_RADIUS = 2;
const CRUSH_BLOOD = 9;
const HIT_BLOOD_DROPS = 2;
// Капля от удара падает на свободную клетку не дальше стольких от раны (тело
// занимает клетки вокруг, поэтому дальше, чем при раздавливании).
const HIT_BLOOD_RADIUS = 5;

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
    // Смотрит из головы: x, y — главная клетка тела (низ), глаза выше.
    y = Math.max(0, y + PERSON_EYE_DY);
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
    // Ближний взгляд — от середины тела.
    y = Math.max(0, y + PERSON_MID_DY);
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

  // Держит ли что-нибудь тело с главной клеткой (x, y): хоть под одной клеткой
  // низа твёрдое (стоять можно и на краю уступа).
  // self — главная клетка самого тела: его собственные клетки опорой не
  // считаются (при проверке соседнего положения клетки низа вчера были бы
  // под ногами сегодня: ступенька вверх "держалась" бы на самом человеке).
  humanSupportsBody(x, y, self = -1) {
    for (let dx = -PERSON_PIVOT_COL; dx < PERSON_COLS - PERSON_PIVOT_COL; dx++) {
      const nx = x + dx;
      if (nx < 0 || nx >= this.w) continue;
      if (self >= 0 && y + 1 < this.h && this.creaturePivot((y + 1) * this.w + nx) === self) continue;
      if (this.humanSupports(nx, y + 1)) return true;
    }
    return false;
  }

  // Можно ли встать так, чтобы главная клетка пришла из p в (смещение dx, dy):
  // все клетки тела там проходимы (creatureFree), под низом есть опора, место
  // не в опасном участке личной карты (кроме бегства — mind.running, см.
  // HUMAN_BAN_CELL) и не под открытым небом в газовом месте, и под ногами не
  // смертельное.
  //
  // Проверка опоры — то, чего здесь не хватало: без неё человек в панике
  // преспокойно убегал ПО ВОЗДУХУ, потому что шаг в пустоту ничем не
  // отличался от шага по земле, а падал он только в следующем кадре, к
  // началу которого успевал сделать ещё шаг.
  humanCanStand(p, dx, dy, mind, fluid = false) {
    const w = this.w, nx = (p % w) + dx, ny = ((p / w) | 0) + dy;
    if (nx < 0 || nx >= w || ny < 0 || ny >= this.h) return false;
    if (!this.creatureFree(p, dx, dy, fluid)) return false;
    if (!mind.running && this.humanBanned(mind, nx, ny)) return false;
    if (!this.humanSupportsBody(nx, ny, p)) return false;
    // В запомненном газовом месте — только под крышей.
    if (!mind.running && this.humanInGasZone(mind, nx) && !this.humanHasRoof(nx, ny - PERSON_HEIGHT + 1)) return false;
    if (ny + 1 < this.h) {
      for (let k = -PERSON_PIVOT_COL; k < PERSON_COLS - PERSON_PIVOT_COL; k++) {
        const x = nx + k;
        if (x >= 0 && x < w && this.humanDeadly(this.type[(ny + 1) * w + x])) return false;
      }
    }
    return true;
  }

  // Сдвинуть тело p на (dx, dy) (поштучно: сначала по вертикали, потом вбок —
  // чтобы не срезать угол) — уже проверено, что оно встаёт. Возвращает новую
  // главную клетку.
  humanGo(p, dx, dy) {
    let q = p;
    const sy = dy < 0 ? -1 : 1;
    // Вверх — сперва вверх, потом вбок; вниз — сперва вбок (с уступа), потом вниз.
    if (dy > 0 && dx) q = this.creatureMove(q, dx, 0);
    for (let k = 0; k < Math.abs(dy); k++) q = this.creatureMove(q, 0, sy);
    if (dy <= 0 && dx) q = this.creatureMove(q, dx, 0);
    return q;
  }

  // Шаг в сторону dir: прямо, на ступеньку вверх (до HUMAN_STEP_UP клеток) или
  // на ступеньку вниз. Спуск нужен, чтобы человек мог сойти с уступа, а не
  // топтаться на краю: без него требование опоры под ногами заперло бы его на
  // любой площадке, откуда некуда шагнуть по ровному. Возвращает true, если
  // шагнул.
  humanStep(x, y, i, dir, mind) {
    // Стоит у воды (бок или низ в воде) — идёт и по мелководью: иначе вышедший
    // на кромку берега пловец упирался бы в воду вокруг своего тела.
    const fl = this.bodyInWater(i);
    if (this.humanCanStand(i, dir, 0, mind, fl)) { this.humanGo(i, dir, 0); return true; }
    for (let k = 1; k <= HUMAN_STEP_UP; k++) {
      if (this.humanCanStand(i, dir, -k, mind, fl) && this.creatureFree(i, 0, -k, fl)) { this.humanGo(i, dir, -k); return true; }
    }
    // Препятствие повыше — перепрыгнуть (см. HUMAN_JUMP).
    if (this.humanJumpUp(x, y, i, dir, mind, fl)) return true;
    // Спуск: вперёд и вниз на d клеток, но не больше HUMAN_MAX_DROP: на
    // клетку — ступенька вниз, глубже — шаг в пустоту над местом
    // приземления, дальше человек падает сам (selfDrop — это не провал).
    if (this.creatureFree(i, dir, 0, fl) && (mind.running || !this.humanBanned(mind, x + dir, y))) {
      for (let d = 1; d <= HUMAN_MAX_DROP; d++) {
        if (!this.creatureFree(i, dir, d, fl)) break;
        if (!this.humanCanStand(i, dir, d, mind, fl)) continue;
        if (d === 1) this.humanGo(i, dir, 1);
        else { this.humanGo(i, dir, 0); mind.selfDrop = true; }
        return true;
      }
    }
    return false;
  }

  // Запрыгнуть на уступ в HUMAN_JUMP клеток впереди: там можно встать, а над
  // головой свободно на всю высоту прыжка.
  humanJumpUp(x, y, i, dir, mind, fluid = false) {
    const h = HUMAN_JUMP;
    if (y - h - PERSON_HEIGHT < 0) return false;
    if (!this.creatureFree(i, 0, -h, fluid)) return false;
    if (!this.humanCanStand(i, dir, -h, mind, fluid)) return false;
    this.humanGo(i, dir, -h);
    return true;
  }

  // Упасть на клетку, если низ свободен (тело целиком); падает и мёртвый, и
  // живой без опоры. В жидкость погружается (она вытесняется).
  creatureFall(p) {
    if (!this.creatureFree(p, 0, 1, true)) return p;
    return this.creatureMove(p, 0, 1);
  }

  reactHuman(x, y, i) {
    // Мёртвый — только падает.
    if (this.creatureDeadAt(i)) {
      // Мёртвое тело ещё разъедает кислота и жжёт огонь (оно может развалиться
      // на куски, sim/pieces.js); потом падает и заваливается набок.
      this.creatureContact(i); this.creatureSpread(i);
      this.creatureDecay(i);
      if (this.creatureFall(i) === i) this.creatureTopple(i);
      return;
    }
    const mind = this.humanMind(i);

    // 1. Касания по клеткам тела (creatureContact): огонь, лава, кислота
    //    жгут и разъедают ту клетку, что касаются; яд травит. Смерть — когда
    //    сумма ран, ожогов и язв дошла до порога, от яда — отравление.
    const con = this.creatureContact(i);
    if (this.creaturePoison(i) >= 1) {
      this._humans.delete(this.life[i]);
      this.poisonDeathBody(i);
      return;
    }
    // Разъеденная шея — голова отваливается, и он мёртв (sim/pieces.js).
    if (this.creatureDecay(i) === 2) return;
    if (this.creatureDamage(i) >= DEATH_DAMAGE) { this.humanDie(i); return; }
    this.creatureHeal(i);
    this.creatureSpread(i);
    this.creatureBleed(i);
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
    const hy = y - PERSON_HEIGHT;
    const above = hy >= 0 ? this.type[hy * this.w + x] : EL.EMPTY;
    if (above === EL.WATER || above === EL.SOLUTION || above === EL.BLOOD || this.creatureWalledIn(i)) {
      mind.wet++;
      if (mind.wet >= HUMAN_DROWN_FRAMES) { this.humanDie(i); return; }
    } else if (mind.wet > 0) {
      mind.wet--;
    }

    // 2б. В воде — плывёт (humanSwim); выбился из сил — тонет.
    if (this.humanSwim(x, y, i, mind)) return;

    // 2в. Под ногами пусто — падает, в воздухе не шагает: иначе, сойдя с
    //     уступа, он шёл бы по воздуху дальше. Опора ушла, а сам он вниз не
    //     шагал — провалился: место опасное (HUMAN_NEAR_SIGHT).
    const grounded = this.humanSupportsBody(x, y);
    if (!grounded) {
      if (mind.grounded && !mind.selfDrop) {
        for (let dx = -HUMAN_BAN_CELL; dx <= HUMAN_BAN_CELL; dx += HUMAN_BAN_CELL) {
          const bx = Math.min(this.w - 1, Math.max(0, x + dx));
          this.humanBan(mind, y * this.w + bx);
          if (y + 1 < this.h) this.humanBan(mind, (y + 1) * this.w + bx);
        }
      }
      mind.grounded = false;
      this.creatureFall(i);
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
    const top = y - PERSON_HEIGHT + 1;
    const gi = this.humanAcidCloudAbove(x, top), cloud = gi >= 0;
    if (cloud) this.humanGasMarkCloud(mind, gi);
    if (cloud || (this.humanInGasZone(mind, x) && !this.humanHasRoof(x, top))) {
      mind.running = true;
      if (!this.humanHasRoof(x, top)) {
        let dir = mind.dir;
        for (let step = 1; step <= HUMAN_SHELTER_RANGE; step++) {
          if (this.humanHasRoof(Math.min(this.w - 1, x + step), top)) { dir = 1; break; }
          if (this.humanHasRoof(Math.max(0, x - step), top)) { dir = -1; break; }
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
  // плывёт, пока не выберется на сухое, и тонет. true — этот кадр он плыл,
  // дальше ничего делать не надо. Вода у тела — bodyInWater, над головой —
  // bodyHeadUnder (sim/protagonist.js), уровень — bodyLevelOk.
  humanSwim(x, y, i, mind) {
    const w = this.w;
    if (mind.stamina === undefined) { mind.stamina = SWIM_STAMINA; mind.exhausted = false; }
    const liqA = this.bodyHeadUnder(i);
    const liqB = this.bodyInWater(i);
    if (!liqA && !liqB) {
      // Отдыхает только на сухом: ни рядом, ни над головой не вода.
      if (this.humanSupportsBody(x, y)) {
        mind.exhausted = false;
        mind.stamina = Math.min(SWIM_STAMINA, mind.stamina + SWIM_REGEN);
      }
      return false;
    }
    if (mind.exhausted) return false;
    if (--mind.stamina <= 0) { mind.exhausted = true; return false; }
    // Под водой — вверх, пока выше тоже вода и там уровень воды.
    if (liqA && this.bodyLevelOk(i, -1)) {
      if (this.frame % SWIM_FRAMES === 0 && this.creatureFree(i, 0, -1, true)) this.creatureMove(i, 0, -1);
      return true;
    }
    // На уровне воды: держится и плывёт к ближайшему берегу (раз в
    // SWIM_LOOK кадров оглядывается, где он). Наугад, от стенки к стенке,
    // он выбивался из сил в бассейне, где берег был в десятке клеток.
    if (liqB && this.bodyLevelOk(i, 0)) {
      if ((this.frame + this.life[i]) % SWIM_LOOK === 0) {
        const shore = this.humanShoreDir(x, y, i, mind);
        if (shore) mind.dir = shore;
      }
      if (this.frame % SWIM_FRAMES !== 0) return true;
      const dir = mind.dir, nx = x + dir;
      if (nx < 0 || nx >= w) { mind.dir = -dir; return true; }
      if (this.creatureFree(i, dir, 0, true)) { this.creatureMove(i, dir, 0); return true; }
      // Берег на ступеньку выше — выбраться на него.
      for (let k = 1; k <= HUMAN_WADE_UP; k++) {
        if (this.creatureFree(i, 0, -k, true) && this.creatureFree(i, dir, -k, true)) {
          let q = i;
          for (let s = 0; s < k; s++) q = this.creatureMove(q, 0, -1);
          this.creatureMove(q, dir, 0);
          return true;
        }
      }
      mind.dir = -dir;
      return true;
    }
    return false;   // сбоку пустота — над водой не удержаться, уходит глубже
  }

  // Можно ли пловцу выйти так, чтобы главная клетка пришла из p в смещение
  // (dx, dy): как humanCanStand, но и в мелкую воду — жидкость, под которой
  // твёрдая опора (creatureFree с fluid). Неполный верхний слой бассейна
  // растекается плёнкой и по берегу, и "только в пустоту" оставляло пловца без
  // выхода: берег был затоплен на клетку, и он тонул у самой кромки.
  humanCanWade(p, dx, dy, mind) {
    const w = this.w, nx = (p % w) + dx, ny = ((p / w) | 0) + dy;
    if (nx < 0 || nx >= w || ny < 0 || ny >= this.h) return false;
    if (!this.creatureFree(p, dx, dy, true)) return false;
    if (this.humanBanned(mind, nx, ny)) return false;
    if (!this.humanSupportsBody(nx, ny, p)) return false;
    if (ny + 1 < this.h) {
      for (let k = -PERSON_PIVOT_COL; k < PERSON_COLS - PERSON_PIVOT_COL; k++) {
        const x = nx + k;
        if (x >= 0 && x < w && this.humanDeadly(this.type[(ny + 1) * w + x])) return false;
      }
    }
    return true;
  }

  // В какую сторону ближайший берег от пловца: место в том же ряду или
  // ступенькой выше, где можно встать. 0 — в пределах SWIM_SHORE_RANGE не видно.
  humanShoreDir(x, y, p, mind) {
    for (let d = 1; d <= SWIM_SHORE_RANGE; d++) {
      for (let side = 0; side < 2; side++) {
        const dir = side === 0 ? mind.dir : -mind.dir;
        const nx = x + dir * d;
        if (nx < 0 || nx >= this.w) continue;
        // Берег — там, где встанешь в том же ряду или поднявшись на ступеньку
        // (до HUMAN_WADE_UP: пловец с головой у воды вылезает на мелкое).
        for (let k = 0; k <= HUMAN_WADE_UP; k++) if (this.humanCanWade(p, dir * d, -k, mind)) return dir;
      }
    }
    return 0;
  }

  // Раздавлен падающим твёрдым (см. attemptSwapOrMove): тело исчезает целиком,
  // и из него выливается кровь (EL.BLOOD) — каплями по трём высотам тела —
  // а занятые клетки вокруг покрываются кровью (поле stain), гуще ближе к
  // месту. vi — любая клетка тела. Память человека живёт на главном потоке,
  // поэтому при параллельном обходе она просто остаётся лишней записью в Map.
  crushBody(vi) {
    if (this.life[vi] < 0) { this.pieceCrush(vi); return; }   // кусок: давится по клетке
    const p = this.creaturePivot(vi);
    if (p < 0) { this.clearCell(vi); return; }   // осиротевшая клетка
    const w = this.w, h = this.h, x0 = p % w, y0 = (p / w) | 0;
    // Причину смерти протагониста пишет только главный поток: у рабочего
    // своя копия playerState. Для раздавленного в полосе потока причину
    // угадывает js/play.js — по крови на месте, где он пропал.
    if (this.type[p] === EL.PROTAGONIST && !this._inBand) {
      const st = this.playerSlot(this.life[p]).state;
      st.death = 'Раздавлен упавшим телом';
      st.deathKind = 'crushed';
    }
    this.removeCreature(p);
    const R = CRUSH_RADIUS;
    for (const dy of [-12, -6, 0]) {
      const cy = y0 + dy;
      this.spillBlood(x0, cy, CRUSH_BLOOD);
      for (let ddy = -R; ddy <= R; ddy++) {
        const y = cy + ddy;
        if (y < 0 || y >= h) continue;
        for (let dx = -R; dx <= R; dx++) {
          const x = x0 + dx, d2 = dx * dx + ddy * ddy;
          if (x < 0 || x >= w || d2 > R * R + 1) continue;
          const k = y * w + x;
          // У живых stain — отравление, кровью не пачкаются.
          if (this.type[k] === EL.EMPTY || IS_CREATURE[this.type[k]] === 1) continue;
          const v = 255 - d2 * 40;
          if (v > this.stain[k]) { this.stain[k] = v; this.markDirty(k); }
        }
      }
    }
  }

  // Капли крови (EL.BLOOD): n штук на случайных свободных клетках в радиусе
  // CRUSH_RADIUS от (x0, y0). Мало места — меньше капель.
  spillBlood(x0, y0, n, R = CRUSH_RADIUS) {
    const w = this.w, h = this.h;
    for (let k = 0; k < n * 3 && n > 0; k++) {
      const x = x0 + ((Math.random() * (2 * R + 1)) | 0) - R, y = y0 + ((Math.random() * (2 * R + 1)) | 0) - R;
      if (x < 0 || x >= w || y < 0 || y >= h) continue;
      const j = y * w + x;
      if (this.type[j] !== EL.EMPTY) continue;
      this.spawn(j, EL.BLOOD);
      n--;
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

  // Удар живому, одна из клеток которого — j, от протагониста с главной
  // клеткой by: рана на клетках тела вокруг места удара (creatureWound).
  // true — убит (сумма ран дошла до порога): разлетается кровью, как
  // раздавленный.
  hitCreature(j, by) {
    const p = this.creaturePivot(j);
    if (p < 0) return false;
    const t = this.type[p];
    this.creatureWound(p, j, HIT_DAMAGE * DAMAGE_SCALE);
    if (this.creatureDamage(p) >= DEATH_DAMAGE) {
      const st = t === EL.PROTAGONIST ? this.playerSlot(this.life[p]).state : null;
      this.crushBody(p);
      if (st) { st.death = 'Убит другим игроком'; st.deathKind = 'killed'; }
      return true;
    }
    this.spillBlood(j % this.w, (j / this.w) | 0, HIT_BLOOD_DROPS, HIT_BLOOD_RADIUS);
    // Лужица крови под ним (клетки ниже, не живые).
    const w = this.w, x = p % w, y = (p / w) | 0;
    if (y + 1 < this.h) {
      for (let dx = -PERSON_PIVOT_COL; dx < PERSON_COLS - PERSON_PIVOT_COL; dx++) {
        const nx = x + dx;
        if (nx < 0 || nx >= w) continue;
        const k = (y + 1) * w + nx, tk = this.type[k];
        if (tk === EL.EMPTY || IS_CREATURE[tk] === 1) continue;
        if (this.stain[k] < HIT_BLOOD) { this.stain[k] = HIT_BLOOD; this.markDirty(k); }
      }
    }
    if (t === EL.HUMAN) {
      const mind = this.humanMind(p);
      mind.fearOf = this.life[by];
      mind.fearT = HUMAN_FEAR_FRAMES;
      mind.dir = (p % w) >= (by % w) ? 1 : -1;
      mind.flee = HUMAN_FLEE_FRAMES;
    }
    return false;
  }

  // Смерть: человек темнеет и застывает (тело целиком — creatureKill). Память
  // освобождается — она была нужна живому.
  humanDie(i) {
    this.creatureKill(i);
  }

  // Поставить человека с низом по центру в (x, y): личный номер и память.
  // Не поместился — ищет место выше (до высоты тела). Возвращает главную клетку
  // или -1.
  placeHuman(x, y) {
    const id = ++this._humanSeq;
    let p = -1;
    for (let up = 0; p < 0 && up <= PERSON_HEIGHT; up++) p = this.placeCreature(x, y - up, EL.HUMAN, id, false);
    if (p < 0) return -1;
    this._humans.set(id, { bans: new Set(), banOrder: [], gas: new Set(), gasOrder: [], dir: Math.random() < 0.5 ? 1 : -1, wet: 0, flee: 0 });
    return p;
  }
}

extendSim(SimHuman);
