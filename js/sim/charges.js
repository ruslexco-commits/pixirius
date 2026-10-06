'use strict';

// Заряды: жёлтый (просто электрический) и зелёный (несёт картинку с
// камеры). Это не клетки поля, а отдельные сущности поверх него: у каждого
// свой номер (ip), счётчик пройденных пикселей, срок жизни (просьба
// пользователя: "у каждого заряда есть собственный ip, где-нибудь храним ip
// и параметры каждого заряда"). Живут в this.charges; в отмену и
// сохранение не входят — это мгновенные импульсы, а не вещество
// (restore/deserialize/clear их гасят).
//
// Заряд — волна. Он разливается сразу во все соседние проводящие пиксели,
// включая диагонали: вокруг восемь пикселей металла — теперь все восемь
// под зарядом, и в счётчике +8 (просьба пользователя; первой версией заряд
// был точкой и брёл по проводу наугад, отчего до монитора почти не
// доходил). Фронт волны — клетки, где заряд сейчас; раз в CHARGE_STEP[тип
// клетки] кадров клетка фронта отдаёт заряд всем своим ещё не пройденным
// этим зарядом соседям-проводникам и сама становится хвостом. Медь
// проводит быстрее всех, металл, сталь и приборы — медленнее, вода и
// окислы — медленнее всего. Изолятор не проводит вовсе. Клетка фронта без
// единого соседа-проводника перескакивает пропуск в одну клетку (не
// изолятор) ценой CHARGE_JUMP_COST. Счётчик дошёл до срока — заряд
// рассеялся весь.
//
// Хвост: клетку, пройденную зарядом, другой заряд CHARGE_TAIL_FRAMES
// кадров не занимает — второй заряд не может идти вплотную за первым.
//
// Данные — у заряда целиком (это его параметр, как и срок): волна
// коснулась камеры — весь заряд зелёный и несёт её снимок (несколько камер
// на пути — несколько снимков), коснулась воды — снова жёлтый, ржавчины
// металла — с шансом CHARGE_RUST_LOSS за стадию (медная патина данные не
// гасит, см. chargeData). Зелёный заряд, дойдя до монитора,
// отдаёт ему снимки (карта монитора дополняется и обновляется). Сначала
// данные были у каждой ветви свои — и волна, обогнув камеру по диагонали,
// приходила к монитору жёлтой: ветвь со снимком упиралась в уже пройденное.
//
// Камера — зеркало (просьба пользователя: "сигнал пришёл в камеру, и от
// неё отразился и пошёл обратно"). Волна, впервые коснувшись камеры, идёт
// дальше, как шла, и вдобавок от камеры выходит отражённая волна
// (reflectCharge): тот же срок и счётчик, те же снимки (с только что
// снятым), и ходить она может только по клеткам, которые исходная волна
// уже прошла (back), — то есть назад по пути, к источнику. Хвост
// исходной волны её не держит, иначе она упиралась бы в него сразу за
// камерой. Камеры, уже снятые исходной волной, отражённую не отражают
// (scans копируются), так что эхо не множится без конца.
//
// Усилитель (медь во всём остальном): волна, войдя в него, получает ещё
// AMPLIFIER_BOOST клеток срока (просьба: "добавляющий ко времени жизни
// сигнала доп 50 клеток"). Один усилитель — связная группа его клеток —
// прибавляет одному заряду один раз: иначе волна, разлившаяся по
// нарисованному кистью пятну усилителя, получала бы +50 за каждую клетку.
// Отражённая от камеры волна — новая, её тот же усилитель усилит снова.
//
// Лампочка (reactLamp): проводит заряд, как металл, а жёлтый (без
// снимков) её ещё и зажигает — срок свечения LAMP_CYCLE кадров в life:
// первые LAMP_STEADY горит ровно, остальное мигает (как именно — решает
// рендер, Renderer.lampOn), потом гаснет. Зелёный проходит, не зажигая.
//
// Заряд делится (splitCharge, просьба пользователя): если светящиеся
// клетки фронта распались на несвязные куски (провод разветвился, волна
// пошла в обе стороны; связь считается и через свежий хвост, см.
// splitCharge), каждый кусок — уже отдельный заряд со своим
// номером, своими снимками и остатком срока, поделённым между кусками
// поровну. Тогда один кусок, дойдя до камеры, становится зелёным, а
// другой — нет. Связность — по восьми соседям: в толстом проводнике фронт
// волны остаётся одной полосой и заряд не дробится на каждом шаге.
// Пройденные клетки (seen) куски делят одним Set: назад, в пройденное
// родителем, никто из них не пойдёт.
//
// Заряды и сливаются (mergeCharges, просьба пользователя): коснулись
// светящимися клетками (фронты рядом, по восьми соседям) — теперь один
// заряд, остатки срока складываются. Снимки остаются, только если оба были
// зелёными; зелёный с жёлтым дают жёлтый. Отражённая волна со своей
// исходной не сливается: она и рождается в клетке её фронта.
//
// Балка — односторонний проводник (chargeLinkOK, просьба пользователя:
// "чтобы можно было сварганить односторонние провода"). Проводит по своему
// материалу. Отдаёт — касанием и через пропуск в пиксель — только своему
// веществу, такой же балке, монитору и камере. Принимает только касанием
// и от тех же: своего вещества, такой же балки, монитора, камеры. Через
// пропуск на балку сигнал не передаётся ("по воздуху с металла на балку
// не может, с балки на металл может"). Металл 11111 → металлическая балка 2
// → пропуск 0 → металл 11111: вправо сигнал идёт, влево — нет (справа
// некому перепрыгнуть пропуск на балку). Медь, проложенная сквозь балку,
// на неё не перекидывается. История: балка сперва проводила во всё, потом
// только в своё вещество в обе стороны, потом не проводила вовсе, потом
// ошибочно не принимала от своего вещества и касанием — тогда в балку
// из металла сигнал не входил вовсе.
//
// Генератор (sim.emitGeneratorCharges): раз в GENERATOR_PERIOD кадров
// (полсекунды) каждая связная группа генераторов, под которой есть масло
// (хоть под одной её клеткой прямо снизу — масло или застывшее масло: масло,
// коснувшись твёрдого, застывает плёнкой), выпускает жёлтый заряд
// со сроком GENERATOR_LIFE и дым над собой — в первую свободную клетку над
// группой. Без масла молчит. Масло не тратится. Заряд начинается в
// наименьшей клетке группы (занята фронтом — в этот раз группа молчит).
// Просьба пользователя; прежде генератор работал сам по себе раз в 2 с со
// сроком 200.
//
// Источник — солнечная панель (sim.emitSolarCharges): раз в SOLAR_PERIOD
// кадров каждая связная группа панелей, видящих небо (прямо вверх до края
// поля ничего непрозрачного), с шансом SOLAR_CHANCE + SOLAR_CHANCE_PER за
// каждую следующую такую панель выпускает жёлтый заряд со сроком
// SOLAR_LIFE_PER за каждую.
//
// Видны заряды только в режиме создания (Renderer рисует фронт волны
// поверх поля), в игре за протагониста — нет.
//
// Методы класса Sim, вынесенные в отдельный файл: класс ниже — только
// контейнер, extendSim переносит его методы в Sim.prototype (см. core.js).

const CHARGE_YELLOW = 0, CHARGE_GREEN = 1;
const CHARGE_MAX = 400;               // больше зарядов разом не бывает
const CHARGE_TAIL_FRAMES = 6;         // сколько кадров клетка за зарядом закрыта для других
const CHARGE_JUMP_COST = 5;           // перескок через пропуск в клетку
const CHARGE_RUST_LOSS = 0.1;         // шанс потерять данные в окисле — за каждую стадию
const SOLAR_PERIOD = 120;             // раз в 2 секунды (60 кадров в секунду)
const SOLAR_CHANCE = 0.10;
const SOLAR_CHANCE_PER = 0.05;
const SOLAR_LIFE_PER = 50;
const GENERATOR_PERIOD = 30;          // раз в полсекунды
const GENERATOR_LIFE = 500;
const AMPLIFIER_BOOST = 50;
const ZAP_LIFE = 200;                 // срок заряда от инструмента "Электрический разряд"
const LAMP_CYCLE = 420;               // 7 секунд свечения после заряда
const LAMP_STEADY = 180;              // из них первые 3 — ровно, дальше мигает
// Обзор камеры: прямая видимость в радиусе CAMERA_SIGHT (как у
// протагониста) и CAMERA_RAYS лучей вдаль на CAMERA_RAY_RANGE клеток —
// до первого непрозрачного: дальние предметы видны, но лишь частично.
const CAMERA_SIGHT = 38;
const CAMERA_RAYS = 240;
const CAMERA_RAY_RANGE = 400;
// Пустота в снимке — отдельной пометкой, а не цветом: как её рисовать,
// решает интерфейс (js/play.js).
const LOOK_AIR = 0x1000000;
// Карта монитора забывает (просьба пользователя: "через некоторое время
// полученная информация стирается"): у каждой клетки карты — кадр, когда
// она пришла. Свежая ярко вспыхивает на карте и темнеет, через
// MONITOR_FADE_FRAMES кадров (6 секунд) клетка стирается совсем. Кадр и
// вид лежат в одном числе карты: вид + кадр * MONITOR_LOOK_SPAN (вид
// занимает 25 бит, кадр целиком помещается в оставшиеся биты double) —
// так карта остаётся Map число → число, без объекта на клетку.
// Было 1800 (30 секунд) — пользователь попросил, чтобы изображение от
// замолчавшей камеры пропадало в пять раз быстрее.
const MONITOR_FADE_FRAMES = 360;
const MONITOR_LOOK_SPAN = 0x2000000;
const MONITOR_PRUNE_PERIOD = 60;      // раз в секунду стирать отжившее
function monitorLook(v) { return v % MONITOR_LOOK_SPAN; }
function monitorAt(v) { return Math.floor(v / MONITOR_LOOK_SPAN); }

// Сколько кадров заряд проводит в клетке этого типа; 0 — не проводит. У
// сплава — по его долям (chargeStepAt / alloyChargeStep, sim/alloys.js).
const CHARGE_STEP = new Uint8Array(64);
CHARGE_STEP[EL.COPPER] = 1;
CHARGE_STEP[EL.AMPLIFIER] = 1;

// Сколько срока заряда стоит клетка этого вещества (по умолчанию 1). В меди
// сигнал затухает в десять раз медленнее (просьба пользователя); медь на
// воздухе сама зеленеет патиной, и без неё здесь провод через пару минут
// переставал бы быть "медным", поэтому патина (твёрдая) и усилитель — тоже.
const CHARGE_COST = new Float32Array(64).fill(1);
CHARGE_COST[EL.COPPER] = 0.1;
CHARGE_COST[EL.COPPER_OXIDE] = 0.1;
CHARGE_COST[EL.AMPLIFIER] = 0.1;
for (const id of [EL.METAL, EL.STEEL, EL.CAMERA, EL.MONITOR, EL.SOLAR, EL.GENERATOR, EL.LAMP]) CHARGE_STEP[id] = 2;
for (const id of [EL.METAL_OXIDE, EL.METAL_OXIDE_LOOSE, EL.COPPER_OXIDE, EL.COPPER_OXIDE_LOOSE,
  EL.WATER, EL.SOLUTION, EL.ACID, EL.REAGENT]) CHARGE_STEP[id] = 3;

// С балкой любого материала связаны монитор и камера (просьба
// пользователя: ограничение "только своё вещество" на них не действует).
const BEAM_LINK_ANY = new Uint8Array(64);
BEAM_LINK_ANY[EL.MONITOR] = 1;
BEAM_LINK_ANY[EL.CAMERA] = 1;

// Восемь соседей (dx, dy) — волна идёт и по диагоналям.
const CHARGE_NB_DX = [1, -1, 0, 0, 1, 1, -1, -1];
const CHARGE_NB_DY = [0, 0, 1, -1, 1, -1, 1, -1];

class SimCharges {
  initCharges() {
    const n = this.w * this.h;
    this.charges = [];
    this._chargeSeq = 0;
    this._snapSeq = 0;
    this._chargeOcc = new Int32Array(n);       // чей фронт в клетке, 0 — ничей
    this._chargeTail = new Uint32Array(n);     // до какого кадра клетка — чей-то хвост
    this._chargeTailOwner = new Int32Array(n);
    // Карты мониторов: номер монитора (наименьшая клетка его связной
    // группы) → Map клетка → вид (цвет или LOOK_AIR).
    this.monitorMaps = new Map();
    // Последний приём снимка каждым монитором: номер монитора →
    // { seq, frame, cells } — для вспышки (Renderer.updateMonitorGlow).
    this.monitorFlash = new Map();
    // Темнота мира (выбирается лупой на лампочке; рисует её рендер,
    // Renderer.updateLighting): 1 — всё видно, лампочки не светят; 2 —
    // светло там, куда достаёт солнце сверху, в закрытых помещениях темно;
    // 3 — темно везде, светят только лампочки.
    this.darkness = 1;
    // Свет плавный (true) или попиксельный (false): только вид, см.
    // LIGHT_GLOW_BLUR в render.js. Выбирается там же, в лупе на лампочке.
    this.lightSmooth = true;
    this._monitorFlashSeq = 0;
    // Цвет клетки для снимков камер. Интерфейс подставляет сюда цвет
    // рендера (main.js); без него — цвет элемента.
    this.lookColor = null;
  }

  // Погасить все заряды (отмена, загрузка, очистка — заряды не хранятся).
  resetCharges() {
    this.charges.length = 0;
    this._chargeOcc.fill(0);
    this._chargeTail.fill(0);
  }

  // Новый заряд в клетке i: фронт из одной клетки. kind — CHARGE_GREEN с
  // данными data (снимок камеры) или CHARGE_YELLOW. false — клетка занята
  // или зарядов слишком много.
  addCharge(i, kind, life, data = null) {
    if (this.charges.length >= CHARGE_MAX || this._chargeOcc[i]) return false;
    const c = {
      id: ++this._chargeSeq, life, count: 1,
      front: [{ i, wait: this.chargeStepAt(i) || 1 }],
      // Снимки камер, которые несёт заряд; null — жёлтый.
      data: kind === CHARGE_GREEN && data ? [data] : null,
      seen: new Set([i]),
      scans: new Map(),       // камера → снимок (одна камера снимается зарядом один раз)
      delivered: new Set(),   // "монитор:снимок" — чтобы не отдавать одно и то же много раз
      amped: null,            // клетки усилителей, уже прибавивших этому заряду срок
      back: null,             // у отражённой волны — клетки пути, по которым ей можно назад
      parent: 0,              // у отражённой волны — номер волны, от которой она отразилась
    };
    this.charges.push(c);
    this._chargeOcc[i] = c.id;
    return true;
  }

  // Раз в кадр, после обхода клеток, на главном потоке.
  updateCharges() {
    if (this.frame % SOLAR_PERIOD === 0) this.emitSolarCharges();
    if (this.frame % GENERATOR_PERIOD === 0) this.emitGeneratorCharges();
    if (this.frame % MONITOR_PRUNE_PERIOD === 0) this.pruneMonitorMaps();
    const list = this.charges;
    if (list.length === 0) return;
    // Куски, отделившиеся в этом кадре, встают в список после обхода:
    // иначе они сделали бы второй шаг в том же кадре.
    const born = this._chargeBorn || (this._chargeBorn = []);
    born.length = 0;
    let k = 0;
    for (let n = 0; n < list.length; n++) {
      const c = list[n];
      if (this.stepCharge(c)) { list[k++] = c; this.splitCharge(c, born); }
      else this.dropChargeFront(c);
    }
    list.length = k;
    for (const b of born) list.push(b);
    if (list.length > 1) this.mergeCharges();
  }

  // Слияние зарядов, коснувшихся фронтами (см. шапку). Номер остаётся у
  // того, что раньше в списке; остальные в него вливаются.
  mergeCharges() {
    const list = this.charges, occ = this._chargeOcc, w = this.w, h = this.h;
    const byId = new Map();
    for (const c of list) byId.set(c.id, c);
    let merged = false;
    for (let n = 0; n < list.length; n++) {
      const a = list[n];
      if (a.dead) continue;
      let found = null;
      for (let q = 0; q < a.front.length && !found; q++) {
        const i = a.front[q].i, x = i % w, y = (i / w) | 0;
        for (let d = 0; d < 8; d++) {
          const nx = x + CHARGE_NB_DX[d], ny = y + CHARGE_NB_DY[d];
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const id = occ[ny * w + nx];
          if (!id || id === a.id) continue;
          const b = byId.get(id);
          if (!b || b.dead || b.parent === a.id || a.parent === b.id) continue;
          found = b;
          break;
        }
      }
      if (!found) continue;
      this.absorbCharge(a, found);
      merged = true;
      n--;   // слитый заряд мог коснуться ещё кого-то — проверить снова
    }
    if (merged) {
      let k = 0;
      for (const c of list) if (!c.dead) list[k++] = c;
      list.length = k;
    }
  }

  // Заряд b вливается в a: фронт, пройденное, остаток срока, снимки.
  absorbCharge(a, b) {
    const rest = (a.life - a.count) + (b.life - b.count);
    a.life = a.count + rest;
    for (const f of b.front) { if (this._chargeOcc[f.i] === b.id) this._chargeOcc[f.i] = a.id; a.front.push(f); }
    if (b.seen !== a.seen) {
      if (b.seen.size > a.seen.size) { for (const j of a.seen) b.seen.add(j); a.seen = b.seen; }
      else for (const j of b.seen) a.seen.add(j);
    }
    // Зелёный с жёлтым — жёлтый; два зелёных — все снимки обоих.
    if (a.data && b.data) {
      const have = new Set(a.data.map((d) => d.id));
      for (const d of b.data) if (!have.has(d.id)) a.data.push(d);
    } else a.data = null;
    for (const [k, v] of b.scans) if (!a.scans.has(k)) a.scans.set(k, v);
    for (const t of b.delivered) a.delivered.add(t);
    if (b.amped) { if (!a.amped) a.amped = new Set(); for (const j of b.amped) a.amped.add(j); }
    // Отражённая волна ходит только по пути назад; слившись с обычной, она
    // становится обычной.
    if (!b.back) a.back = null;
    b.front = [];
    b.dead = true;
  }


  // Фронт заряда c распался на несвязные куски — все, кроме первого,
  // становятся новыми зарядами (см. шапку). Остаток срока делится поровну.
  splitCharge(c, born) {
    const front = c.front, nf = front.length;
    if (nf < 2) return;
    // Связность — по фронту и свежему хвосту этой же волны (клетки, которые
    // она прошла за последние CHARGE_TAIL_FRAMES кадров). По одному фронту
    // нельзя: в медленном проводнике (генератор, металл) клетки фронта ждут
    // дольше, чем уже ушедшая вперёд медь, и между ними на кадр остаётся
    // пройденная клетка — фронт формально рвался, и тупиковый остаток в
    // генераторе забирал половину срока. Через хвост куски связаны, пока
    // действительно не разойдутся.
    const w = this.w, tail = this._chargeTail, owner = this._chargeTailOwner, frame = this.frame;
    const at = new Map();
    for (let n = 0; n < nf; n++) at.set(front[n].i, n);
    const group = new Int32Array(nf).fill(-1);
    const visited = new Set();
    let groups = 0;
    const stack = [];
    for (let n = 0; n < nf; n++) {
      if (group[n] >= 0) continue;
      group[n] = groups;
      stack.push(front[n].i);
      visited.add(front[n].i);
      while (stack.length) {
        const i = stack.pop(), x = i % w;
        for (let d = 0; d < 8; d++) {
          const dx = CHARGE_NB_DX[d];
          if ((dx < 0 && x === 0) || (dx > 0 && x === w - 1)) continue;
          const j = i + CHARGE_NB_DY[d] * w + dx;
          if (j < 0 || j >= tail.length || visited.has(j)) continue;
          const o = at.get(j);
          if (o !== undefined) { visited.add(j); group[o] = groups; stack.push(j); }
          else if (tail[j] > frame && owner[j] === c.id) { visited.add(j); stack.push(j); }
        }
      }
      groups++;
    }
    if (groups < 2) return;
    const room = CHARGE_MAX - this.charges.length - born.length;
    if (room < groups - 1) return;   // зарядов слишком много — остаётся одним
    const share = (c.life - c.count) / groups;
    c.life = c.count + share;
    const parts = [];
    for (let g = 0; g < groups; g++) parts.push([]);
    for (let n = 0; n < nf; n++) parts[group[n]].push(front[n]);
    c.front = parts[0];
    for (let g = 1; g < groups; g++) {
      const p = {
        id: ++this._chargeSeq, life: c.count + share, count: c.count,
        front: parts[g],
        data: c.data ? c.data.slice() : null,
        seen: c.seen,
        scans: new Map(c.scans),
        delivered: new Set(c.delivered),
        amped: c.amped ? new Set(c.amped) : null,
        back: c.back, parent: c.parent,
      };
      for (const f of p.front) if (this._chargeOcc[f.i] === c.id) this._chargeOcc[f.i] = p.id;
      born.push(p);
    }
  }

  // Лампочка: плавится как стекло и отсчитывает срок свечения (см. шапку).
  reactLamp(x, y, i) {
    this.reactMelt(x, y, i, EL.LAMP);
    if (this.type[i] === EL.LAMP && this.life[i] > 0) { this.life[i]--; this.markDirty(i); }
  }

  // Заряд погас: его фронт больше не занимает клеток.
  dropChargeFront(c) {
    for (const f of c.front) if (this._chargeOcc[f.i] === c.id) this._chargeOcc[f.i] = 0;
    c.front.length = 0;
  }

  // Может ли заряд c войти в клетку j: он там ещё не был, и это не фронт и
  // не свежий хвост другого заряда.
  // Отражённая волна — только назад по пройденному (back), и хвост волны,
  // от которой она отразилась, ей не помеха.
  chargeFree(c, j) {
    if (c.seen.has(j)) return false;
    if (c.back && !c.back.has(j)) return false;
    const occ = this._chargeOcc[j];
    if (occ && occ !== c.id) return false;
    if (this._chargeTail[j] <= this.frame) return true;
    const owner = this._chargeTailOwner[j];
    return owner === c.id || (c.parent !== 0 && owner === c.parent);
  }

  // Отражение от камеры в клетке j (см. шапку): новая волна из клетки j
  // назад по пути волны c. Клетка j остаётся фронтом c, отражённая в ней
  // лишь начинается (её _chargeOcc не занимает).
  reflectCharge(c, j) {
    if (this.charges.length >= CHARGE_MAX || c.count >= c.life) return;
    const cam = this.componentOf(j, EL.CAMERA).cells;
    const back = new Set(c.seen);
    for (const k of cam) back.delete(k);
    this.charges.push({
      id: ++this._chargeSeq, life: c.life, count: c.count,
      front: [{ i: j, wait: this.chargeStepAt(j) || 1 }],
      data: c.data ? c.data.slice() : null,
      seen: new Set(cam),
      scans: new Map(c.scans),
      delivered: new Set(c.delivered),
      amped: null,
      back, parent: c.id,
    });
  }

  // Шаг волны. false — заряд рассеялся (срок вышел или идти некуда).
  stepCharge(c) {
    const type = this.type, w = this.w, h = this.h;
    const next = [];
    for (const f of c.front) {
      if (this.chargeStepAt(f.i) === 0) {           // проводник под ветвью исчез
        if (this._chargeOcc[f.i] === c.id) this._chargeOcc[f.i] = 0;
        continue;
      }
      if (--f.wait > 0) { next.push(f); continue; }
      const x = f.i % w, y = (f.i / w) | 0;
      let spread = 0;
      for (let d = 0; d < 8 && c.count < c.life; d++) {
        const nx = x + CHARGE_NB_DX[d], ny = y + CHARGE_NB_DY[d];
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const j = ny * w + nx;
        if (this.chargeStepAt(j) === 0 || !this.chargeFree(c, j) || !this.chargeLinkOK(f.i, j, false)) continue;
        this.chargeInto(c, f, j, this.chargeCostAt(j), next);
        spread++;
      }
      // Ни одного соседа-проводника — перескок через пропуск в клетку. Но
      // только у настоящего кончика волны: если рядом клетка этой же волны
      // (фронт или только что занятая), идти некуда потому, что соседей уже
      // заняли свои, — это середина волны, а не разрыв провода. Раньше
      // такие клетки в толстом проводнике (генераторе) прыгали по
      // диагонали через пустоту, и после введения деления заряда каждый
      // такой прыжок отщеплял кусок, забиравший половину срока.
      if (spread === 0 && !this.chargeHasOwnNeighbour(c, x, y)) {
        for (let d = 0; d < 8 && c.count + CHARGE_JUMP_COST < c.life; d++) {
          const fx = x + 2 * CHARGE_NB_DX[d], fy = y + 2 * CHARGE_NB_DY[d];
          if (fx < 0 || fx >= w || fy < 0 || fy >= h) continue;
          const mid = (y + CHARGE_NB_DY[d]) * w + x + CHARGE_NB_DX[d], far = fy * w + fx;
          if (this.chargeStepAt(mid) !== 0 || type[mid] === EL.INSULATOR) continue;
          if (this.chargeStepAt(far) === 0 || !this.chargeFree(c, far) || !this.chargeLinkOK(f.i, far, true)) continue;
          this.chargeInto(c, f, far, this.chargeCostAt(far) + CHARGE_JUMP_COST, next);
        }
      }
      // Упёрлась в чужой фронт — не гаснет, а ждёт: в конце кадра заряды
      // сольются (mergeCharges). Иначе из двух встречных волн одна, которой
      // соседка заняла последнюю клетку, гасла раньше слияния, и её срок
      // пропадал.
      if (spread === 0 && this.chargeTouchesOther(c, x, y)) { f.wait = 1; next.push(f); continue; }
      // Клетка отдала заряд — теперь она хвост.
      if (this._chargeOcc[f.i] === c.id) this._chargeOcc[f.i] = 0;
      this._chargeTail[f.i] = this.frame + CHARGE_TAIL_FRAMES;
      this._chargeTailOwner[f.i] = c.id;
    }
    c.front = next;
    return next.length > 0 && c.count < c.life;
  }

  // Может ли заряд перейти из клетки a в клетку b (jump — через пропуск в
  // пиксель), см. шапку про балку. Где заряд идёт только по балке (своё
  // вещество клетки не проводит), действует правило балки.
  chargeLinkOK(a, b, jump) {
    const type = this.type, ba = this.beam[a], bb = this.beam[b];
    const beamA = ba !== 0 && !this.chargeTypeConducts(a);
    const beamB = bb !== 0 && !this.chargeTypeConducts(b);
    if (beamB) {
      if (jump) return false;               // через воздух балка не принимает
      if (beamA) return ba === bb;          // с балки на такую же балку — можно
      // Касанием балку питает только своё вещество (и монитор с камерой);
      // медь, проложенная сквозь металлическую балку, на неё не переходит.
      return type[a] === bb || BEAM_LINK_ANY[type[a]] === 1;
    }
    if (beamA) return type[b] === ba || BEAM_LINK_ANY[type[b]] === 1;
    return true;
  }

  // Проводит ли заряд само вещество клетки (без балки).
  chargeTypeConducts(i) {
    const t = this.type[i];
    return t === EL.ALLOY ? this.alloyChargeStep(i) > 0 : CHARGE_STEP[t] > 0;
  }

  // Есть ли среди восьми соседей (x, y) фронт другого заряда, с которым
  // заряд c может слиться (не своя отражённая волна и не исходная).
  chargeTouchesOther(c, x, y) {
    const w = this.w, h = this.h, occ = this._chargeOcc;
    for (let d = 0; d < 8; d++) {
      const nx = x + CHARGE_NB_DX[d], ny = y + CHARGE_NB_DY[d];
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const id = occ[ny * w + nx];
      if (id && id !== c.id && id !== c.parent) return true;
    }
    return false;
  }

  // Есть ли среди восьми соседей (x, y) клетка, занятая волной заряда c.
  chargeHasOwnNeighbour(c, x, y) {
    const w = this.w, h = this.h, occ = this._chargeOcc;
    for (let d = 0; d < 8; d++) {
      const nx = x + CHARGE_NB_DX[d], ny = y + CHARGE_NB_DY[d];
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      if (occ[ny * w + nx] === c.id) return true;
    }
    return false;
  }

  // Ветвь f заряда c входит в клетку j (cost — сколько это стоит счётчику).
  // Цена клетки j для срока заряда (CHARGE_COST): по веществу клетки, а
  // если проводит только балка — по её материалу.
  chargeCostAt(j) {
    const t = this.type[j];
    if (this.beam[j] && !this.chargeTypeConducts(j)) return CHARGE_COST[this.beam[j]];
    return CHARGE_COST[t];
  }

  chargeInto(c, f, j, cost, next) {
    c.seen.add(j);
    c.count += cost;
    this.chargeData(c, j);
    this._chargeOcc[j] = c.id;
    next.push({ i: j, wait: this.chargeStepAt(j) });
  }

  // Что станет с данными заряда, когда волна входит в клетку j: камера
  // снимает (каждая — один раз на заряд), монитор принимает снимки, вода и
  // окисел гасят.
  chargeData(c, j) {
    const t = this.type[j];
    if (t === EL.AMPLIFIER) { this.amplifyCharge(c, j); return; }
    // Жёлтый заряд зажигает лампочку заново на полный срок.
    if (t === EL.LAMP) { if (!c.data) { this.life[j] = LAMP_CYCLE; this.markDirty(j); } return; }
    if (t === EL.CAMERA) {
      const key = this.componentOf(j, EL.CAMERA).key;
      if (c.scans.has(key)) return;
      const snap = this.cameraScan(j);
      snap.id = ++this._snapSeq;
      c.scans.set(key, snap);
      if (!c.data) c.data = [];
      c.data.push(snap);
      this.reflectCharge(c, j);
      return;
    }
    if (!c.data) return;
    if (t === EL.MONITOR) {
      const key = this.componentOf(j, EL.MONITOR).key;
      for (const snap of c.data) {
        const tag = key + ':' + snap.id;
        if (!c.delivered.has(tag)) { c.delivered.add(tag); this.monitorReceive(j, snap); }
      }
      return;
    }
    if (IS_LIQUID[t] === 1) { c.data = null; return; }
    // Данные гасит ржавчина металла (просьба: "окисленный металл"), но не
    // медная патина: медь окисляется сама, от одного воздуха, и иначе
    // любой медный провод через минуту переставал бы носить снимки — на
    // каждом пикселе патины 4-й стадии данные терялись бы с шансом 40%, и
    // мониторы ничего не получали.
    if (t === EL.METAL_OXIDE || t === EL.METAL_OXIDE_LOOSE) {
      const stage = this.oxideStage(j);
      if (stage > 0 && Math.random() < CHARGE_RUST_LOSS * stage) c.data = null;
    } else if (this.beam[j] === EL.METAL_OXIDE && CHARGE_STEP[t] === 0) {
      // Заряд идёт по ржавой балке (в клетке нет другого проводника) —
      // данные теряются так же, как в ржавчине, по стадии балки.
      const stage = this.beamExtra[j] || 1;
      if (Math.random() < CHARGE_RUST_LOSS * stage) c.data = null;
    }
  }

  // Волна заряда c вошла в усилитель (клетка j): +AMPLIFIER_BOOST к сроку,
  // если этот усилитель заряду ещё не прибавлял (см. шапку).
  amplifyCharge(c, j) {
    if (c.amped && c.amped.has(j)) return;
    if (!c.amped) c.amped = new Set();
    for (const k of this.componentOf(j, EL.AMPLIFIER).cells) c.amped.add(k);
    c.life += AMPLIFIER_BOOST;
  }

  // Связная группа клеток типа id с клеткой i: { key — наименьшая клетка,
  // cells }. Камера и монитор могут быть больше пикселя.
  componentOf(i, id) {
    const type = this.type, w = this.w, h = this.h;
    const stack = [i], seen = new Set([i]);
    let min = i;
    while (stack.length && seen.size < 4096) {
      const c = stack.pop();
      if (c < min) min = c;
      const x = c % w, y = (c / w) | 0;
      if (x > 0 && type[c - 1] === id && !seen.has(c - 1)) { seen.add(c - 1); stack.push(c - 1); }
      if (x < w - 1 && type[c + 1] === id && !seen.has(c + 1)) { seen.add(c + 1); stack.push(c + 1); }
      if (y > 0 && type[c - w] === id && !seen.has(c - w)) { seen.add(c - w); stack.push(c - w); }
      if (y < h - 1 && type[c + w] === id && !seen.has(c + w)) { seen.add(c + w); stack.push(c + w); }
    }
    return { key: min, cells: seen };
  }

  // ---- солнечные панели ----

  // Видит ли клетка небо: прямо вверх до края поля ничего непрозрачного.
  seesSky(i) {
    const w = this.w;
    for (let j = i - w; j >= 0; j -= w) if (this.lookOpaque(j)) return false;
    return true;
  }

  emitSolarCharges() {
    const type = this.type, n = type.length, w = this.w, h = this.h;
    const seen = this._solarSeen || (this._solarSeen = new Uint8Array(n));
    seen.fill(0);
    const stack = [], sky = [];
    for (let i = 0; i < n; i++) {
      if (type[i] !== EL.SOLAR || seen[i]) continue;
      // Связная группа панелей и те из них, что видят небо.
      stack.length = 0; sky.length = 0;
      stack.push(i); seen[i] = 1;
      while (stack.length) {
        const c = stack.pop();
        if (this.seesSky(c)) sky.push(c);
        const x = c % w, y = (c / w) | 0;
        if (x > 0 && type[c - 1] === EL.SOLAR && !seen[c - 1]) { seen[c - 1] = 1; stack.push(c - 1); }
        if (x < w - 1 && type[c + 1] === EL.SOLAR && !seen[c + 1]) { seen[c + 1] = 1; stack.push(c + 1); }
        if (y > 0 && type[c - w] === EL.SOLAR && !seen[c - w]) { seen[c - w] = 1; stack.push(c - w); }
        if (y < h - 1 && type[c + w] === EL.SOLAR && !seen[c + w]) { seen[c + w] = 1; stack.push(c + w); }
      }
      const N = sky.length;
      if (N === 0) continue;
      const p = Math.min(1, SOLAR_CHANCE + SOLAR_CHANCE_PER * (N - 1));
      if (Math.random() >= p) continue;
      this.addCharge(sky[(Math.random() * N) | 0], CHARGE_YELLOW, SOLAR_LIFE_PER * N);
    }
  }

  // Инструмент "Электрический разряд": жёлтый заряд со сроком ZAP_LIFE в
  // клетку (gx, gy), а если она не проводит — в ближайшую проводящую в
  // пределах кисти (rx, ry). true — заряд пущен.
  zapAt(gx, gy, rx = 0, ry = 0) {
    let best = -1, bestD = Infinity;
    for (let dy = -ry; dy <= ry; dy++) {
      for (let dx = -rx; dx <= rx; dx++) {
        const x = gx + dx, y = gy + dy;
        if (!this.inBounds(x, y)) continue;
        const i = this.idx(x, y), d = dx * dx + dy * dy;
        if (d < bestD && this.chargeStepAt(i) > 0 && !this._chargeOcc[i]) { best = i; bestD = d; }
      }
    }
    return best >= 0 && this.addCharge(best, CHARGE_YELLOW, ZAP_LIFE);
  }

  // Генераторы: раз в GENERATOR_PERIOD кадров по заряду и клубу дыма от
  // каждой связной группы, стоящей на масле (см. шапку).
  emitGeneratorCharges() {
    const type = this.type, n = type.length, w = this.w, h = this.h;
    const seen = this._genSeen || (this._genSeen = new Uint8Array(n));
    seen.fill(0);
    const stack = [];
    for (let i = 0; i < n; i++) {
      if (type[i] !== EL.GENERATOR || seen[i]) continue;
      // Обход с наименьшей клетки группы: i и есть она.
      stack.length = 0;
      stack.push(i); seen[i] = 1;
      let oil = false, smokeAt = -1;
      while (stack.length) {
        const c = stack.pop();
        const x = c % w, y = (c / w) | 0;
        if (y < h - 1 && (type[c + w] === EL.OIL || type[c + w] === EL.OILFILM)) oil = true;
        if (y > 0 && type[c - w] === EL.EMPTY && (smokeAt < 0 || c < smokeAt)) smokeAt = c - w;
        if (x > 0 && type[c - 1] === EL.GENERATOR && !seen[c - 1]) { seen[c - 1] = 1; stack.push(c - 1); }
        if (x < w - 1 && type[c + 1] === EL.GENERATOR && !seen[c + 1]) { seen[c + 1] = 1; stack.push(c + 1); }
        if (y > 0 && type[c - w] === EL.GENERATOR && !seen[c - w]) { seen[c - w] = 1; stack.push(c - w); }
        if (y < h - 1 && type[c + w] === EL.GENERATOR && !seen[c + w]) { seen[c + w] = 1; stack.push(c + w); }
      }
      if (!oil) continue;
      this.addCharge(i, CHARGE_YELLOW, GENERATOR_LIFE);
      if (smokeAt >= 0) this.spawn(smokeAt, EL.SMOKE);
    }
  }

  // ---- камера и монитор ----

  // Непрозрачное для взгляда камеры и протагониста: твёрдое и сыпучее
  // (js/play.js — то же правило). Балка прозрачна: сквозь неё видно (просьба
  // пользователя) — она лишь тёмный полупрозрачный задний план.
  lookOpaque(i) {
    const t = this.type[i];
    if (t === EL.EMPTY || IS_SEE_THROUGH[t] === 1) return false;
    const el = ELEMENTS[t];
    return !!el && (el.cat === CAT.SOLID || el.cat === CAT.POWDER);
  }

  lookOf(i) {
    if (this.type[i] === EL.EMPTY && !this.beam[i]) return LOOK_AIR;
    if (this.lookColor) { const c = this.lookColor(i); return (c[0] << 16) | (c[1] << 8) | c[2]; }
    const col = ELEMENTS[this.type[i]].color;
    return (col[0] << 16) | (col[1] << 8) | col[2];
  }

  // Прямая от (x0,y0) до (x1,y1) не упирается ни во что непрозрачное; сама
  // камера (и соседние клетки камеры — она может быть больше пикселя)
  // взгляду не мешает.
  cameraLine(x0, y0, x1, y1) {
    const w = this.w;
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy, x = x0, y = y0;
    for (;;) {
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
      if (x === x1 && y === y1) return true;
      const j = y * w + x;
      if (this.type[j] !== EL.CAMERA && this.lookOpaque(j)) return false;
    }
  }

  // Снимок камеры в клетке ci: { cells, looks } — что видно прямой
  // видимостью в радиусе CAMERA_SIGHT плюс по лучам вдаль до первого
  // непрозрачного (его самого тоже видно).
  cameraScan(ci) {
    const w = this.w, h = this.h, x0 = ci % w, y0 = (ci / w) | 0, R = CAMERA_SIGHT;
    const got = new Map();
    for (let dy = -R; dy <= R; dy++) {
      const y = y0 + dy;
      if (y < 0 || y >= h) continue;
      for (let dx = -R; dx <= R; dx++) {
        const x = x0 + dx;
        if (x < 0 || x >= w || dx * dx + dy * dy > R * R) continue;
        if ((dx || dy) && !this.cameraLine(x0, y0, x, y)) continue;
        const j = y * w + x;
        got.set(j, this.lookOf(j));
      }
    }
    for (let r = 0; r < CAMERA_RAYS; r++) {
      const a = (r / CAMERA_RAYS) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      let last = -1;
      for (let s = 1; s <= CAMERA_RAY_RANGE; s++) {
        const x = Math.round(x0 + ca * s), y = Math.round(y0 + sa * s);
        if (x < 0 || x >= w || y < 0 || y >= h) break;
        const j = y * w + x;
        if (j === last) continue;
        last = j;
        if (this.type[j] === EL.CAMERA) continue;
        got.set(j, this.lookOf(j));
        if (this.lookOpaque(j)) break;
      }
    }
    const cells = new Int32Array(got.size), looks = new Int32Array(got.size);
    let k = 0;
    for (const [j, v] of got) { cells[k] = j; looks[k] = v; k++; }
    return { cells, looks };
  }

  // Номер монитора — наименьшая клетка его связной группы (монитор может
  // быть больше пикселя). Разбит на части — это уже другие мониторы.
  monitorKey(i) { return this.componentOf(i, EL.MONITOR).key; }
  monitorComponent(i) { return this.componentOf(i, EL.MONITOR); }

  // Монитор принимает снимок: его карта дополняется и обновляется свежим.
  // Каждая клетка снимка — с кадром получения (см. MONITOR_FADE_FRAMES).
  // Приём отмечается вспышкой монитора (monitorFlash): рендер на треть
  // секунды плавно красит его клетки голубым (Renderer.updateMonitorGlow).
  monitorReceive(i, data) {
    if (!data) return;
    const comp = this.monitorComponent(i), key = comp.key;
    let map = this.monitorMaps.get(key);
    if (!map) { map = new Map(); this.monitorMaps.set(key, map); }
    const stamp = this.frame * MONITOR_LOOK_SPAN;
    for (let k = 0; k < data.cells.length; k++) map.set(data.cells[k], data.looks[k] + stamp);
    this.monitorFlash.set(key, { seq: ++this._monitorFlashSeq, frame: this.frame, cells: Int32Array.from(comp.cells) });
  }

  // Раз в MONITOR_PRUNE_PERIOD кадров: стереть из карт мониторов клетки
  // старше MONITOR_FADE_FRAMES и старые вспышки (рендеру они уже не нужны).
  pruneMonitorMaps() {
    const oldest = (this.frame - MONITOR_FADE_FRAMES) * MONITOR_LOOK_SPAN;
    for (const [key, map] of this.monitorMaps) {
      for (const [j, v] of map) if (v < oldest) map.delete(j);
      if (map.size === 0) this.monitorMaps.delete(key);
    }
    for (const [key, f] of this.monitorFlash) if (this.frame - f.frame > MONITOR_PRUNE_PERIOD) this.monitorFlash.delete(key);
  }
}

extendSim(SimCharges);
