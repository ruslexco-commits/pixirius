'use strict';

// Мультиплеер: лобби и игра на нескольких вкладках одного браузера
// (просьба пользователя: "пока возможность играть с одного браузера, но в
// случае чего переоборудуем под более удобные варианты").
//
// Вкладки говорят через провод (js/mp-wire.js): сообщения упаковываются в
// байты, большие (мир целиком) сжимаются и режутся на куски, и идут по
// трубе — сейчас это BroadcastChannel (MP_CHANNEL + ID лобби: хост создаёт
// лобби со случайным ID, вкладка подключается, введя его). Одна — хост: у неё
// вся логика (возрождение, старт, настройки). Миры — комнатка лобби
// (lobbySim, MP_LOBBY_SCALE от поля) и карта игры (sim) — считает каждая
// вкладка сама, по сиду (sim/lockstep.js; просьба пользователя: "достаточно
// передать сид и действия хоста, а не всю обстановку"). Раньше хост досылал
// изменившиеся куски мира раз в три кадра — у подключившихся всё
// подлагивало.
//
// Как это идёт:
// - вкладка входит — хост шлёт ей мир целиком (full: lockstepDump, вместе с
//   состоянием генератора случайных чисел);
// - каждый свой шаг хост шлёт тик (tick): действия с прошлого тика (кисть
//   любого игрока, появление и возрождение игроков — имя метода Sim и
//   аргументы, с номером q), нажатия всех игроков, настройки света и
//   обзора. Вкладка повторяет у себя: действия, нажатия, шаг — со
//   случайными числами мира (withRng), и у неё выходит тот же мир побайтно;
// - действия кисти вкладки идут хосту (op), он выполняет их у себя и
//   рассылает в тике — у всех они случаются между теми же двумя шагами;
// - раз в MP_HASH_PERIOD кадров в тике отпечаток мира: не сошёлся у
//   вкладки (лупа или что-то ещё, что меняет мир в обход действий) — она
//   просит мир целиком (resync). Отмену, загрузку и очистку хост замечает
//   сам и шлёт мир всем сразу.
// Цена: каждая вкладка считает мир сама (на одной машине — вдвое больше
// работы). Потоки работают и здесь — обход полосами, одинаковый при любом
// их числе (updateBands, sim/threads.js).
//
// Чтобы перейти на сеть, достаточно добавить сетевую трубу в mpOpenPipe
// (js/mp-wire.js): всё здесь уже ходит байтами и не знает, чем их возят.
// Web Locks (закрытие вкладки) — только когда труба внутри одного браузера
// (useLocks); по сети участника теряют по пингам (MP_TIMEOUT_MS).
//
// Игроки — номера с 1 (0 — одиночная игра, sim/protagonist.js). Хост —
// игрок 1. Номер игрока лежит в life клетки его протагониста, цвет — в
// sim.playerColors (рендер и шейдер).
//
// Сообщения (поле t):
//   хост → все:  lobby (состояние лобби), full (мир целиком; to — кому),
//                tick (действия, нажатия, шаг), preview (картинка будущей
//                карты), hping (хост жив), bye (хост ушёл)
//   вкладка → хост: find (ищу лобби), join, input, op, me (имя и цвет),
//                resync (мир разошёлся — пришли целиком), ping (жива), leave

const MP_CHANNEL = 'pixilius-mp-';
// ID лобби: без похожих друг на друга букв и цифр (0/O, 1/I).
const MP_ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MP_ID_LEN = 5;
function mpNewId() { let id = ''; for (let k = 0; k < MP_ID_LEN; k++) id += MP_ID_CHARS[(Math.random() * MP_ID_CHARS.length) | 0]; return id; }
// Отпечаток мира для сверки вкладок — раз в столько кадров (sim/lockstep.js).
const MP_HASH_PERIOD = 60;
// Вкладка отстала от хоста: сколько его шагов она догоняет за кадр (видимая
// и скрытая, см. drainWorlds).
const MP_CATCHUP_MAX = 3;
const MP_CATCHUP_HIDDEN = 8;
// Хост не уходит вперёд вкладки больше чем на столько кадров (ack): иначе
// вкладка, не поспевающая за ним, копила очередь шагов и догоняла рывками —
// у неё подлагивало, а у хоста нет (жалоба пользователя). Вкладку, которая
// молчит дольше MP_ACK_STALE_MS (закрыта, заморожена), не ждём.
// Чат (просьба пользователя): сообщение — не длиннее MP_CHAT_MAX символов,
// над персонажем держится MP_SAY_MS мс; в журнале — последние MP_CHAT_KEEP.
const MP_CHAT_MAX = 160;
const MP_SAY_MS = 6000;
const MP_CHAT_KEEP = 60;
// Время m:ss по секундам (чат о смерти, статистика).
function mpClock(sec) { sec = Math.max(0, Math.floor(sec)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; }

const MP_MAX_LEAD = 8;
const MP_ACK_STALE_MS = 2000;
// Скрытую вкладку (свернули окно) хост не ждёт — иначе игра у всех шла бы
// с её фоновой скоростью. Накопила больше MP_BACKLOG_FULL тиков — просит
// мир целиком: это дешевле, чем считать сотни шагов подряд.
const MP_BACKLOG_FULL = 180;
// В diag.log — сообщения не меньше этого (мир целиком; превью карты раз в
// две секунды лог бы засорило).
const MP_DIAG_BIG = 1 << 20;
const MP_PING_MS = 1000;
const MP_TIMEOUT_MS = 6000;
// Закрытие вкладки замечается по Web Locks: хост и каждая вкладка держат
// свою блокировку, пока открыты, а другая сторона стоит в очереди за ней и
// получает её, только когда держатель закрылся. Пинги по времени для этого
// не годятся: вкладку в фоне браузер тормозит, и после нескольких минут
// таймер в ней срабатывает раз в минуту — живого игрока выкидывало из лобби
// просто за то, что его окно (или окно хоста) было не на виду. Без
// navigator.locks остаётся прежний таймаут MP_TIMEOUT_MS.
const MP_LOCK = 'pixilius-mp-lock-';
const MP_HAS_LOCKS = typeof navigator !== 'undefined' && !!navigator.locks;
// Комнатка лобби — 10% площади поля (просьба пользователя).
const MP_LOBBY_SCALE = Math.sqrt(0.1);
// Методы Sim — действия игроков (рисование кистью, инструменты, точки
// спавна): у вкладки они уходят хосту, у хоста выполняются и рассылаются в
// тике (см. шапку). Выбор материала балки (pickBeamMaterial) — не действие:
// он мира не меняет, только запоминает материал кисти, и едет с каждым
// действием в MP_PAINT_CTX.
const MP_OPS = ['stampBrush', 'stampLine', 'floodFill', 'applyPressureBrush', 'applyTempBrush', 'zapAt', 'clearRegion', 'pasteRegion',
  'setSpawnMark', 'addRespawnMark', 'removeMarksNear', 'setRespawnMarkProps'];
// Действия самого хоста, которые вкладки повторяют: игрок появился,
// возродился, ушёл. Место хост выбирает сам (случайно, своими числами), во
// вкладки идёт уже выбранная клетка.
const MP_HOST_ACTS = ['placePlayer', 'respawnPlayer', 'clearCell'];
// Состояние кисти, от которого зависит действие: стадия окисла, материал
// балки — у каждого игрока своё.
const MP_PAINT_CTX = ['paintOxideStage', 'beamPaintMaterial', 'beamPaintExtra'];
// Настройки мира, которые хост меняет лупой (темнота, обзор): идут с каждым
// тиком — от темноты зависят лампочки.
// "Огонь по своим" (настройка хоста) — тоже: от него зависит, бьёт ли
// протагонист другого игрока (sim/protagonist.js, hittable).
// И скорость копания (множитель хоста, sim/protagonist.js, MINE_SPEED_NORMAL).
const MP_CFG = ['darkness', 'lightSmooth', 'playerVision', 'playerRays', 'friendlyFire', 'digSpeed'];
// Методы, которыми хост меняет мир целиком: после них мир идёт вкладкам
// заново.
const MP_WORLD_RESETS = ['restore', 'deserialize', 'clear'];

// Сид мира: случайный, у хоста; вкладки получают генератор вместе с миром.
function mpSeed() { return (Math.random() * 4294967296) >>> 0; }

function mpRandomColor() {
  return { h: Math.floor(Math.random() * 360), s: 45 + Math.floor(Math.random() * 50), l: 35 + Math.floor(Math.random() * 30) };
}

// HSL (0..360, 0..100, 0..100) → [r, g, b].
function mpHslToRgb(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

class Multiplayer {
  // opts: sim (карта), makeLobbySim(w, h), ui — объект Lobby (js/lobby.js)
  constructor(opts) {
    Object.assign(this, opts);
    this.role = null;               // null | 'host' | 'client'
    this.cid = Math.random().toString(36).slice(2, 10);
    this.me = 0;                    // мой номер игрока
    this.state = null;              // состояние лобби
    this.lobbySim = null;
    this.wire = null;               // провод (js/mp-wire.js)
    this.useLocks = false;          // закрытие замечаем по Web Locks (один браузер)
    this.frameNo = 0;
    this.lastSeen = new Map();      // хост: cid → когда пинговал
    this.hostSeen = 0;              // вкладка: когда хост пинговал
    this.deadSince = {};            // хост: номер игрока → кадр смерти
    this.gotWorld = { lobby: false, map: false };   // вкладка: мир получен и идёт
    this.pending = { lobby: [], map: [] };          // хост: действия с прошлого тика
    this.actSeq = { lobby: 0, map: 0 };             // хост: номер последнего действия
    this.needFull = { lobby: false, map: false };   // хост: мир сменился целиком — разослать
    this.lastQ = { lobby: 0, map: 0 };              // вкладка: последнее выполненное действие
    this.worldQ = { lobby: [], map: [] };           // вкладка: пришедшие full и tick, по порядку
    this.acks = { lobby: new Map(), map: new Map() }; // хост: cid → { f, at } — до какого кадра досчитала вкладка
    this.ackSent = { lobby: -1, map: -1 };            // вкладка: о каком кадре уже сообщила
    this.lobbyInput = { left: false, right: false, up: false, down: false, jump: false };
    this.gameInput = { left: false, right: false, up: false, down: false, jump: false, mine: false, ax: 0, ay: 0 };
    this.sentInput = { lobby: '', map: '' };
    this.status = {};               // номер → строка о возрождении (для экрана игры)
    this.deaths = {};               // номер → сколько раз погиб за игру
    this.memSeq = 0;                // хост: номер снимка отмены (память игроков)
    this.chatLog = [];              // { n, text, at } — n: игрок, 0 — сама игра
    this.says = {};                 // номер → { text, at } — над персонажем
    this.mapSave = null;            // хост: карта до начала игры (вернётся после)
    this.out = {};                  // номер → кадр, когда выбыл насовсем (жизни кончились, возрождения нет)
    this.releaseLock = null;        // отпустить свою блокировку (см. MP_LOCK)
  }

  // Держать блокировку name, пока вкладка открыта (или до close()); then —
  // когда она взята.
  holdLock(name, then) {
    navigator.locks.request(name, () => {
      if (then) then();
      return new Promise((res) => { this.releaseLock = res; });
    });
  }

  // Ждать, пока держатель блокировки name закроется.
  watchLock(name, gone) {
    navigator.locks.request(name, () => { gone(); });
  }

  close() {
    for (const s of [this.sim, this.lobbySim]) if (s) { this.unwrapWorld(s); s.lockstep = false; s.protagonistAsSpawn = 0; }
    if (this.wire) { this.wire.close(); this.wire = null; }
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.releaseLock) { this.releaseLock(); this.releaseLock = null; }
  }

  get phase() { return this.state ? this.state.phase : null; }
  world(name) { return name === 'lobby' ? this.lobbySim : this.sim; }
  // Какие миры идут вкладкам: комнатка — всегда, карта — пока идёт игра.
  tracked(world) { return world === 'lobby' || this.phase === 'game'; }
  player(n) { return this.state ? this.state.players.find((p) => p.n === n) : null; }
  myPlayer() { return this.player(this.me); }

  open(id) {
    if (this.wire) return;
    this.id = id;
    const pipe = mpOpenPipe(MP_CHANNEL + id);
    this.useLocks = MP_HAS_LOCKS && pipe.sameBrowser;
    this.wire = new MpWire(pipe, (m) => this.onMessage(m));
    // Мир целиком другой вкладке эта не распаковывает (адрес — cid).
    this.wire.setSelf(this.cid);
    // В diag.log (js/main.js): сколько весит мир по проводу и сколько
    // сжимался (MP_DIAG_BIG) — по этим числам настраивать сетевую игру.
    this.wire.onBig = (info) => { if (info.raw >= MP_DIAG_BIG && typeof diagReport === 'function') diagReport({ kind: 'mp-big', ...info }); };
    // Пинги — таймером, а не по кадрам: у вкладки в фоне браузер почти
    // останавливает кадры (requestAnimationFrame), и пинг раз в 60 кадров
    // приходил раз в минуту — хост считал игрока отвалившимся и выкидывал.
    this.pingTimer = setInterval(() => {
      if (this.role === 'host') this.send({ t: 'hping' });
      else if (this.role === 'client') this.send({ t: 'ping', cid: this.cid });
    }, MP_PING_MS);
    window.addEventListener('beforeunload', () => {
      if (this.role === 'host') this.send({ t: 'bye' });
      else if (this.role === 'client') this.send({ t: 'leave', cid: this.cid });
    });
  }

  // Мир целиком (full) — только своему адресату (to), остальное — всем.
  send(msg) { if (this.wire) this.wire.send(msg, msg.to || null); }

  // ---- хост ----

  host() {
    this.open(mpNewId());
    if (this.useLocks) this.holdLock(MP_LOCK + 'host-' + this.id);
    this.role = 'host';
    this.me = 1;
    const lw = Math.round(this.sim.w * MP_LOBBY_SCALE), lh = Math.round(this.sim.h * MP_LOBBY_SCALE);
    this.lobbySim = this.makeLobbySim(lw, lh);
    this.buildLobbyRoom(this.lobbySim);
    this.wrapWorld(this.lobbySim, 'lobby', mpSeed());
    this.wrapWorld(this.sim, 'map', mpSeed());
    // Протагонист одиночной игры на карте — это хост: в мультиплеере он
    // становится точкой спавна хоста, и кисть протагониста дальше ставит её
    // же (просьба пользователя; painting.js, protagonistAsSpawn).
    this.protagonistToSpawn(this.sim);
    // Карта идёт вкладкам только в игре: до старта хост правит её в
    // редакторе со всеми потоками, как в одиночной игре (в одном потоке
    // тяжёлая карта тормозила редактор до зависания).
    this.sim.lockstep = false;
    const c = mpRandomColor();
    this.state = {
      phase: 'lobby',
      lobby: { w: lw, h: lh },
      players: [{ n: 1, cid: this.cid, name: 'P1', ...c, role: 'author', respawn: true }],
      // lives — сколько смертей до выбывания (0 — без счёта), friendlyFire —
      // игроки бьют друг друга (просьба пользователя).
      // Возрождение теперь задаётся жизнями (lives: 0 — без счёта), отдельного
      // переключателя нет (просьба пользователя). digSpeed — скорость
      // копания, 10 — обычная, 0 — копать нельзя.
      settings: { randomSpawn: false, mapVisible: true, lives: 0, friendlyFire: false, digSpeed: MINE_SPEED_NORMAL },
    };
    this.applyState();
    this.spawnInLobby(1);
    this.broadcastState();
  }

  // Протагонисты одиночной игры (номер 0) на карте s — в точку спавна хоста.
  protagonistToSpawn(s) {
    s.protagonistAsSpawn = this.me;
    for (let i = 0; i < s.type.length; i++) {
      if (s.type[i] !== EL.PROTAGONIST || s.life[i] !== 0) continue;
      s.setSpawnMark(i % s.w, (i / s.w) | 0, this.me);
      s.clearCell(i);
    }
  }

  // Пустая комнатка: только пол. Стен по краям нет (просьба пользователя
  // их убрать) — край поля и так никого не выпускает.
  buildLobbyRoom(ls) {
    const w = ls.w, h = ls.h;
    for (let x = 0; x < w; x++) for (let y = h - 4; y < h; y++) ls.setCell(x, y, EL.WALL, false);
  }

  // Номер для нового игрока: наименьший свободный.
  freeNumber() {
    let n = 1;
    while (this.state.players.some((p) => p.n === n)) n++;
    return n;
  }

  spawnInLobby(n) {
    const i = this.lobbySim.findSafeSpawn();
    if (i >= 0) this.act('lobby', 'placePlayer', [n, i]);
  }

  broadcastState() {
    if (this.role !== 'host') return;
    this.send({ t: 'lobby', state: this.state });
    this.applyState();
  }

  // Цвета и имена игроков — в оба мира, экран игры и рендер.
  applyState() {
    const st = this.state;
    if (!st) return;
    const colors = [], names = [];
    for (const p of st.players) { p.rgb = mpHslToRgb(p.h, p.s, p.l); colors[p.n] = p.rgb; names[p.n] = p.name || ('P' + p.n); }
    this.sim.playerColors = colors;
    if (this.lobbySim) this.lobbySim.playerColors = colors;
    this.names = names;
    if (this.ui) this.ui.onState(st);
  }

  // Меняет настройки лобби и игроков только хост.
  setSetting(key, value) {
    this.state.settings[key] = value;
    if (key === 'friendlyFire') this.sim.friendlyFire = !!value;
    if (key === 'digSpeed') this.sim.digSpeed = value;
    this.broadcastState();
  }

  // Сколько жизней осталось у игрока n (null — без счёта).
  livesLeft(n) {
    const lives = this.state ? this.state.settings.lives | 0 : 0;
    if (lives <= 0) return null;
    return Math.max(0, lives - (this.deaths[n] || 0));
  }
  setPlayerProp(n, key, value) { const p = this.player(n); if (!p) return; p[key] = value; this.broadcastState(); }

  // Игрок меняет свой вид (имя, цвет): хост — сразу, вкладка — просит хоста.
  setMe(props) {
    if (this.role === 'host') { Object.assign(this.player(this.me), props); this.broadcastState(); }
    else this.send({ t: 'me', cid: this.cid, props });
  }

  // Начать игру: игроки — на точки спавна или в случайные безопасные места
  // (randomSpawn или нет своей точки); некуда — игрок не появляется.
  startGame() {
    if (this.role !== 'host') return;
    const sim = this.sim, st = this.state;
    // Протагонист одиночной игры, как бы он ни вернулся на карту, — точка
    // спавна хоста (просьба пользователя: "протагонист берётся как спавн хоста").
    this.protagonistToSpawn(sim);
    // Карта, какой она была до игры: после игры вернётся (endGame; просьба
    // пользователя — "карта сбрасывается до момента, когда ещё никто не играл").
    this.mapSave = { snap: sim.snapshot(), spawn: JSON.parse(JSON.stringify(sim.spawnMarks)), respawn: JSON.parse(JSON.stringify(sim.respawnMarks)) };
    // Протагонисты игроков с прошлой игры убираются. Карта вкладкам ещё не
    // шла — правки прямо, а потом она уходит целиком.
    sim.withRng(() => {
      for (let i = 0; i < sim.type.length; i++) if (sim.type[i] === EL.PROTAGONIST && sim.life[i] > 0) sim.clearCell(i);
    });
    for (const p of st.players) {
      let i = -1;
      if (!st.settings.randomSpawn) {
        const m = sim.spawnMarks.find((mk) => mk.n === p.n);
        if (m) i = sim.spotAtMark(m.x, m.y);
      }
      if (i < 0) i = sim.findSafeSpawn();
      if (i >= 0) sim.withRng(() => sim.placePlayer(p.n, i));
    }
    this.deadSince = {};
    this.deaths = {};
    this.out = {};
    st.startFrame = sim.frame;
    // Статистика раунда (sim/protagonist.js считает, endGame собирает).
    for (const p of st.players) sim.playerSlot(p.n).stats = { alive: 0, water: 0, tox: 0, broken: 0 };
    sim.friendlyFire = !!st.settings.friendlyFire;
    sim.digSpeed = st.settings.digSpeed;
    this.pending.map = [];
    sim.lockstep = true;
    st.phase = 'game';
    this.broadcastState();
    this.sendFull('map', null);
  }

  endGame() {
    if (this.role !== 'host') return;
    const sim = this.sim, st = this.state;
    // Статистика раунда — кнопка "Статистика" в лобби (js/lobby.js).
    st.lastStats = st.players.map((p) => {
      const s = sim.playerSlot(p.n).stats || {};
      return { name: p.name || 'P' + p.n, rgb: p.rgb, deaths: this.deaths[p.n] || 0,
        alive: (s.alive || 0) / 60, water: (s.water || 0) / 60, tox: (s.tox || 0) / 60, broken: s.broken || 0 };
    });
    sim.lockstep = false;
    // Карта — как до игры.
    if (this.mapSave) {
      sim.restore(this.mapSave.snap);
      sim.spawnMarks = this.mapSave.spawn;
      sim.respawnMarks = this.mapSave.respawn;
      this.mapSave = null;
    }
    this.state.phase = 'lobby';
    this.broadcastState();
  }

  // ---- действия (см. шапку) ----

  // Мир этой вкладки идёт по сиду: методы-действия перехвачены (op), смена
  // мира целиком у хоста замечается (needFull). seed — только у хоста:
  // вкладка получает генератор вместе с миром.
  wrapWorld(s, world, seed) {
    s.lockstep = true;
    if (seed !== undefined) s.rngSeed(seed);
    for (const name of MP_OPS) {
      if (typeof s[name] !== 'function' || s['__mp_' + name]) continue;
      s['__mp_' + name] = s[name];
      s[name] = (...args) => this.op(world, name, args);
    }
    // Отмена на карте у хоста: снимок (pushUndo) и откат (restore) несут
    // номер — экраны игроков запоминают и возвращают свою память к нему
    // (js/play.js, memSnap/memRestore; просьба пользователя).
    if (world === 'map' && (this.role === 'host' || seed !== undefined) && !s.__mp_snapshot) {
      const snap = s.snapshot;
      s.__mp_snapshot = snap;
      s.snapshot = (...args) => {
        const r = snap.apply(s, args);
        if (this.role === 'host' && this.phase === 'game') {
          r._mid = ++this.memSeq;
          this.memSnapAll(r._mid);
        }
        return r;
      };
    }
    if (this.role === 'host' || seed !== undefined) {
      for (const name of MP_WORLD_RESETS) {
        if (s['__mp_' + name]) continue;
        const orig = s[name];
        s['__mp_' + name] = orig;
        s[name] = (...args) => {
          const r = orig.apply(s, args);
          if (this.role === 'host') {
            this.needFull[world] = true;
            if (name === 'restore' && args[0] && args[0]._mid) this.memRestoreAll(args[0]._mid);
            // Отмена, загрузка файла или откат игры к точке сохранения могли
            // вернуть на карту протагониста одиночной игры — снова в точку
            // спавна хоста.
            if (world === 'map') this.protagonistToSpawn(s);
          }
          return r;
        };
      }
    }
  }

  // Снимок и откат памяти игроков (см. wrapWorld): себе и всем вкладкам.
  memSnapAll(id) {
    if (this.ui && this.ui.playMode) this.ui.playMode.memSnap(id);
    this.send({ t: 'memsnap', id });
  }
  memRestoreAll(id) {
    if (this.ui && this.ui.playMode) this.ui.playMode.memRestore(id);
    this.send({ t: 'memrestore', id });
  }

  // Вернуть миру обычные методы (лобби закрыто).
  unwrapWorld(s) {
    for (const name of MP_OPS.concat(MP_WORLD_RESETS, ['snapshot'])) {
      if (!s['__mp_' + name]) continue;
      s[name] = s['__mp_' + name];
      delete s['__mp_' + name];
    }
  }

  paintCtx(s) { const c = {}; for (const k of MP_PAINT_CTX) c[k] = s[k]; return c; }

  // Действие игрока этой вкладки: у хоста — выполнить и записать, у
  // вкладки — хосту (сама она выполнит его, когда оно придёт в тике).
  op(world, name, args) {
    const s = this.world(world);
    if (!this.role) return s['__mp_' + name].apply(s, args);
    // Копия для вставки несёт картинку для проекции (canvas) — её между
    // вкладками не переслать, нужны только поля клеток.
    if (name === 'pasteRegion' && args[0]) args = [{ w: args[0].w, h: args[0].h, fields: args[0].fields }, args[1], args[2]];
    const ctx = this.paintCtx(s);
    if (this.role === 'host') this.act(world, name, args, ctx);
    else this.send({ t: 'op', cid: this.cid, world, op: name, args, ctx });
  }

  // Хост: выполнить действие в мире и записать его для ближайшего тика.
  act(world, name, args, ctx = null) {
    const s = this.world(world);
    if (!s) return;
    this.applyAct(s, name, args, ctx);
    this.pending[world].push({ q: ++this.actSeq[world], name, args, ctx });
  }

  // Выполнить действие так же, как у хоста: случайные числа — мира,
  // состояние кисти — того, кто действовал (своё потом возвращается).
  applyAct(s, name, args, ctx) {
    if (MP_OPS.indexOf(name) < 0 && MP_HOST_ACTS.indexOf(name) < 0) return;
    const fn = s['__mp_' + name] || s[name];
    if (typeof fn !== 'function') return;
    const own = ctx ? this.paintCtx(s) : null;
    if (ctx) Object.assign(s, ctx);
    try { s.withRng(() => fn.apply(s, args)); } catch (e) { console.warn('Пиксириус: действие игрока не выполнено', name, e); }
    if (own) Object.assign(s, own);
  }

  cfgOf(s) { const c = {}; for (const k of MP_CFG) c[k] = s[k]; return c; }

  // Нажатия всех игроков в мире s: [номер, влево, вправо, вверх, вниз,
  // прыжок, ломает, клетка прицела x, y] (ломание — sim/protagonist.js).
  inputsOf(s) {
    const out = [];
    for (const p of this.state.players) {
      const inp = s.playerSlot(p.n).input;
      out.push([p.n, +inp.left, +inp.right, +inp.up, +inp.down, +inp.jump, +inp.mine, inp.ax | 0, inp.ay | 0]);
    }
    return out;
  }

  setInputs(s, list) {
    for (const [n, l, r, u, d, j, m, ax, ay] of list) {
      const inp = s.playerSlot(n).input;
      inp.left = !!l; inp.right = !!r; inp.up = !!u; inp.down = !!d; inp.jump = !!j;
      inp.mine = !!m; inp.ax = ax | 0; inp.ay = ay | 0;
    }
  }

  // Хост: шаг мира world и тик вкладкам (см. шапку). Нажатия и настройки —
  // какими они были перед шагом (прыжок шаг гасит сам).
  hostStep(world, doStep = true) {
    const s = this.world(world);
    // Отстающую вкладку подождать (см. MP_MAX_LEAD): шаг пропускается, мир у
    // всех идёт с её скоростью, а не рывками у неё одной.
    if (doStep && this.tracked(world) && s.frame - this.slowestAck(world) > MP_MAX_LEAD) doStep = false;
    const inputs = this.inputsOf(s), cfg = this.cfgOf(s);
    const f0 = s.frame;
    if (doStep) s.withRng(() => s.step());
    const stepped = s.frame !== f0;
    const acts = this.pending[world];
    if (!stepped && !acts.length) return;
    this.pending[world] = [];
    if (!this.tracked(world) || this.lastSeen.size === 0) return;
    const msg = { t: 'tick', world, f: s.frame, step: stepped, acts, inputs, cfg };
    if (world === 'map') { msg.status = this.status; msg.out = this.out; msg.deaths = this.deaths; }
    if (stepped && s.frame % MP_HASH_PERIOD === 0) msg.hash = s.lockstepHash();
    this.send(msg);
  }

  // Мир целиком: to — одной вкладке (cid) или всем (null). q — последнее
  // действие, которое в нём уже есть: из ближайшего тика его не повторять.
  sendFull(world, to) {
    const s = this.world(world);
    if (!s) return;
    this.send({ t: 'full', world, to, q: this.actSeq[world], status: this.status, out: this.out, deaths: this.deaths, dump: s.lockstepDump() });
  }

  // Раз в кадр у хоста: комнатка лобби, возрождение, досылка миров.
  hostTick() {
    const st = this.state;
    this.frameNo++;
    const now = performance.now();
    // Отвалившиеся вкладки (с Web Locks их убирает watchLock в 'join').
    if (!this.useLocks) for (const [cid, t] of this.lastSeen) {
      if (now - t > MP_TIMEOUT_MS) { this.lastSeen.delete(cid); this.dropPlayer(cid); }
    }
    // Карту шагает игровой цикл (main.js, тоже через hostStep). Комнатка во
    // время игры стоит: её никто не видит, а считали её все вкладки каждый
    // кадр (действия в неё всё равно доходят).
    this.hostStep('lobby', st.phase !== 'game');
    this.respawnTick(this.lobbySim, true);
    if (st.phase === 'game') this.respawnTick(this.sim, false);
    for (const w of ['lobby', 'map']) {
      if (!this.needFull[w]) continue;
      this.needFull[w] = false;
      if (this.tracked(w) && this.lastSeen.size > 0) this.sendFull(w, null);
    }
    if (this.lastSeen.size === 0) return;   // смотреть некому
    if (st.phase === 'lobby' && st.settings.mapVisible && this.frameNo % 120 === 1 && this.ui) {
      const img = this.ui.mapPreviewData();
      if (img) this.send({ t: 'preview', w: img.width, h: img.height, data: img.data });
    }
  }

  // Погибшие возрождаются через RESPAWN_DELAY кадров: в комнатке —
  // всегда, в игре — если возрождение включено в лобби и у игрока, на
  // подходящей точке респавна или в безопасном месте (sim/spawns.js).
  respawnTick(s, lobby) {
    const st = this.state;
    for (const p of st.players) {
      const i = s.findProtagonist(p.n);
      const dead = i < 0 || s.extra[i] === 1;
      const key = (lobby ? 'l' : 'g') + p.n;
      if (!dead) { delete this.deadSince[key]; if (!lobby) this.status[p.n] = ''; continue; }
      if (this.deadSince[key] === undefined) {
        this.deadSince[key] = s.frame;
        if (!lobby) {
          this.deaths[p.n] = (this.deaths[p.n] || 0) + 1;
          // В чат — кто, от чего, какая смерть по счёту и сколько прожил
          // (у всех, включён таймер или нет; просьба пользователя).
          const pl = s.playerSlot(p.n), born = pl.bornAt !== undefined ? pl.bornAt : st.startFrame;
          const cause = (pl.state.death || 'пропал с поля').toLowerCase();
          this.chat(0, `${p.name || 'P' + p.n} погиб: ${cause} — смерть №${this.deaths[p.n]}, прожил ${mpClock((s.frame - born) / 60)}`, 'death');
        }
      }
      // Жизни (настройка хоста): погиб столько раз — выбыл насовсем и
      // наблюдает за другими (js/play.js).
      const lives = st.settings.lives | 0, spent = lives > 0 && (this.deaths[p.n] || 0) >= lives;
      const allowed = lobby || (p.respawn && !spent);
      if (!lobby && !allowed) {
        if (this.out[p.n] === undefined) this.out[p.n] = s.frame;
        this.status[p.n] = spent ? 'Жизни кончились — вы наблюдаете за другими' : 'Возрождения нет — вы наблюдаете за другими';
        continue;
      }
      const left = RESPAWN_DELAY - (s.frame - this.deadSince[key]);
      if (left > 0) { if (!lobby) this.status[p.n] = `Возрождение через ${Math.ceil(left / 60)} с`; continue; }
      const spot = lobby ? s.findSafeSpawn() : s.respawnSpot(p.n, s.playerSlot(p.n).state.deathKind);
      if (spot < 0) { if (!lobby) this.status[p.n] = 'Некуда возродиться — ждите'; continue; }
      this.act(lobby ? 'lobby' : 'map', 'respawnPlayer', [p.n, spot]);
      delete this.deadSince[key];
      if (!lobby) this.status[p.n] = '';
    }
  }

  // ---- чат ----

  // Сказать от себя: хост — сразу всем, вкладка — через хоста.
  say(text) {
    text = String(text || '').trim().slice(0, MP_CHAT_MAX);
    if (!text || !this.role) return;
    if (this.role === 'host') this.chat(this.me, text);
    else this.send({ t: 'say', cid: this.cid, text });
  }

  // Хост: сообщение всем (n — игрок, 0 — сама игра; kind 'death' — о смерти,
  // журнал показывает красным).
  chat(n, text, kind = '') {
    this.send({ t: 'chat', n, text, kind });
    this.onChat(n, text, kind);
  }

  onChat(n, text, kind = '') {
    const at = performance.now();
    this.chatLog.push({ n, text, kind, at });
    if (this.chatLog.length > MP_CHAT_KEEP) this.chatLog.shift();
    if (n > 0) this.says[n] = { text, at };
    if (this.ui) this.ui.onChat();
  }

  // Что игрок n сейчас говорит (над персонажем) или null.
  sayOf(n) {
    const s = this.says[n];
    return s && performance.now() - s.at < MP_SAY_MS ? s.text : null;
  }

  // Самый отстающий кадр среди вкладок, что недавно отчитывались о мире
  // world (Infinity — ждать некого).
  slowestAck(world) {
    const now = performance.now();
    let min = Infinity;
    for (const a of this.acks[world].values()) if (!a.h && now - a.at < MP_ACK_STALE_MS && a.f < min) min = a.f;
    return min;
  }

  dropPlayer(cid) {
    for (const w of ['lobby', 'map']) this.acks[w].delete(cid);
    const st = this.state, p = st.players.find((q) => q.cid === cid);
    if (!p) return;
    st.players = st.players.filter((q) => q !== p);
    for (const w of ['lobby', 'map']) {
      const i = this.world(w).findProtagonist(p.n);
      if (i >= 0) this.act(w, 'clearCell', [i]);
    }
    this.broadcastState();
  }

  // ---- вкладка ----

  join(id) {
    this.open(String(id || '').trim().toUpperCase());
    this.role = 'client';
    this.hostSeen = performance.now();
    // Свою блокировку — до первого сообщения: хост, узнав cid, сразу встаёт
    // за ней в очередь и не должен получить её раньше, чем вкладка закроется.
    if (this.useLocks) this.holdLock(MP_LOCK + 'c-' + this.cid, () => this.send({ t: 'find', cid: this.cid }));
    else this.send({ t: 'find', cid: this.cid });
    // Действия на карте — хосту (см. MP_OPS); мир — по сиду.
    this.wrapWorld(this.sim, 'map');
  }

  // Мир разошёлся с хостом (или пропущен тик) — попросить целиком и
  // до него тики не считать.
  askFull(world) {
    this.gotWorld[world] = false;
    this.send({ t: 'resync', cid: this.cid, world });
    // В diag.log (js/main.js): частые запросы — признак, что миры расходятся.
    const s = this.world(world);
    if (typeof diagReport === 'function') diagReport({ kind: 'resync', world, frame: s ? s.frame : -1 });
  }

  // Шаги хоста — по кадрам, ровно: раньше каждый тик считался сразу по
  // приходе, и между двумя отрисовками выходило то ни одного шага, то два-три
  // подряд — рывками (жалоба: "подлагивает у обоих"). Теперь за кадр — шаг,
  // а накопилось (хост быстрее, вкладка тормознула) — половина очереди, чтобы
  // догнать плавно. Скрытая вкладка — больше за раз (фоновый счёт, main.js).
  drainWorlds() {
    for (const world of ['lobby', 'map']) {
      const q = this.worldQ[world];
      if (!q.length) continue;
      if (q.length > MP_BACKLOG_FULL && this.gotWorld[world]) { q.length = 0; this.askFull(world); continue; }
      // Но не больше MP_CATCHUP_MAX шагов за кадр (скрытой — MP_CATCHUP_HIDDEN):
      // на тяжёлой карте десятки шагов подряд — то же зависание.
      let n = document.hidden ? Math.min(MP_CATCHUP_HIDDEN, q.length) : Math.min(MP_CATCHUP_MAX, Math.max(1, Math.ceil(q.length / 2)));
      // В счёт идут только тики с шагом: мир целиком и тики одних действий
      // (хост на паузе) — сразу.
      while (n > 0 && q.length) {
        const m = q.shift();
        if (m.t === 'full') this.applyFull(m);
        else { this.applyTick(m); if (m.step) n--; }
      }
      // Хосту — до какого кадра досчитала (он не уйдёт дальше MP_MAX_LEAD).
      const s = this.world(world);
      if (s && this.gotWorld[world] && s.frame !== this.ackSent[world]) {
        this.ackSent[world] = s.frame;
        this.send({ t: 'ack', cid: this.cid, world, f: s.frame, h: document.hidden });
      }
    }
  }

  // Мир целиком от хоста (см. шапку).
  applyFull(m) {
    const s = this.world(m.world);
    if (!s) return;
    try { s.lockstepLoad(m.dump); } catch (e) { console.warn('Пиксириус: мир от хоста не принят', e); return; }
    s.lockstep = true;
    this.lastQ[m.world] = m.q;
    if (m.status) this.status = m.status;
    if (m.out) this.out = m.out;
    if (m.deaths) this.deaths = m.deaths;
    this.gotWorld[m.world] = true;
  }

  // Тик хоста: действия, нажатия, шаг, сверка. true — посчитан.
  applyTick(m) {
    const s = this.world(m.world);
    if (!s || !this.gotWorld[m.world]) return false;
    // Пропущенный тик — мир уже не тот: целиком заново.
    if (m.step && m.f !== s.frame + 1) { this.askFull(m.world); return false; }
    for (const a of m.acts) {
      if (a.q <= this.lastQ[m.world]) continue;
      this.applyAct(s, a.name, a.args, a.ctx);
      this.lastQ[m.world] = a.q;
    }
    this.setInputs(s, m.inputs);
    Object.assign(s, m.cfg);
    if (m.status) this.status = m.status;
    if (m.out) this.out = m.out;
    if (m.deaths) this.deaths = m.deaths;
    if (m.step) s.withRng(() => s.step());
    if (m.hash !== undefined && s.lockstepHash() !== m.hash) this.askFull(m.world);
    return true;
  }

  clientTick() {
    this.frameNo++;
    this.drainWorlds();
    const now = performance.now();
    if (!this.useLocks && this.state && now - this.hostSeen > MP_TIMEOUT_MS && this.ui) { this.ui.hostLost(); this.state = null; }
    // Нажатия — хосту, когда поменялись (прыжок — разовый: после отправки гаснет).
    this.flushInput('lobby', this.lobbyInput);
    this.flushInput('map', this.gameInput);
  }

  flushInput(world, inp) {
    // Прицел ломания — только пока ломает: иначе каждое движение мыши
    // слало бы хосту сообщение.
    const key = `${+inp.left}${+inp.right}${+inp.up}${+inp.down}${+inp.jump}${inp.mine ? `m${inp.ax},${inp.ay}` : ''}`;
    if (key === this.sentInput[world] && !inp.jump) return;
    this.sentInput[world] = key;
    this.send({ t: 'input', cid: this.cid, world, inp: { ...inp } });
    inp.jump = false;
  }

  // ---- сообщения ----

  onMessage(m) {
    if (!m || !m.t) return;
    if (this.role === 'host') this.onHostMessage(m);
    else if (this.role === 'client') this.onClientMessage(m);
  }

  onHostMessage(m) {
    const st = this.state;
    if (m.cid) this.lastSeen.set(m.cid, performance.now());
    switch (m.t) {
      case 'find':
        this.send({ t: 'lobby', state: st });
        break;
      case 'join': {
        let p = st.players.find((q) => q.cid === m.cid);
        if (!p) {
          const n = this.freeNumber();
          p = { n, cid: m.cid, name: 'P' + n, ...mpRandomColor(), role: 'player', respawn: true };
          st.players.push(p);
          st.players.sort((a, b) => a.n - b.n);
          this.spawnInLobby(n);
          if (st.phase === 'game') { const i = this.sim.findSafeSpawn(); if (i >= 0) this.act('map', 'placePlayer', [n, i]); }
          if (this.useLocks) {
            const cid = m.cid;
            this.watchLock(MP_LOCK + 'c-' + cid, () => {
              if (this.role !== 'host' || !this.state) return;
              this.lastSeen.delete(cid);
              this.dropPlayer(cid);
            });
          }
        }
        // Новой вкладке — миры целиком (после состояния лобби: из него она
        // узнаёт размер комнатки).
        this.broadcastState();
        this.sendFull('lobby', m.cid);
        if (st.phase === 'game') this.sendFull('map', m.cid);
        break;
      }
      case 'input': {
        const p = st.players.find((q) => q.cid === m.cid);
        if (!p) break;
        const s = m.world === 'lobby' ? this.lobbySim : this.sim;
        const inp = s.playerSlot(p.n).input;
        inp.left = !!m.inp.left; inp.right = !!m.inp.right; inp.up = !!m.inp.up; inp.down = !!m.inp.down;
        if (m.inp.jump) inp.jump = true;
        inp.mine = !!m.inp.mine; inp.ax = m.inp.ax | 0; inp.ay = m.inp.ay | 0;
        break;
      }
      case 'op': {
        const p = st.players.find((q) => q.cid === m.cid);
        if (!p) break;
        // Карту в игре правит только автор; комнатку — все.
        if (m.world === 'map' && p.role !== 'author') break;
        if (MP_OPS.indexOf(m.op) < 0) break;
        this.act(m.world, m.op, m.args, m.ctx || null);
        break;
      }
      case 'me': {
        const p = st.players.find((q) => q.cid === m.cid);
        if (!p) break;
        for (const k of ['name', 'h', 's', 'l']) if (m.props[k] !== undefined) p[k] = m.props[k];
        this.broadcastState();
        break;
      }
      case 'say': {
        const p = st.players.find((q) => q.cid === m.cid);
        if (p) this.chat(p.n, String(m.text || '').slice(0, MP_CHAT_MAX));
        break;
      }
      case 'resync':
        this.acks[m.world].delete(m.cid);   // пока мир идёт к ней — не ждать
        if (this.tracked(m.world)) this.sendFull(m.world, m.cid);
        break;
      case 'ack':
        if (this.acks[m.world]) this.acks[m.world].set(m.cid, { f: m.f, h: !!m.h, at: performance.now() });
        break;
      case 'leave':
        this.lastSeen.delete(m.cid);
        this.dropPlayer(m.cid);
        break;
    }
  }

  onClientMessage(m) {
    switch (m.t) {
      case 'lobby': {
        this.hostSeen = performance.now();
        const wasIn = this.state && this.me;
        this.state = m.state;
        const mine = m.state.players.find((p) => p.cid === this.cid);
        if (!mine) {
          if (!wasIn) this.send({ t: 'join', cid: this.cid });
          else if (this.ui) { this.ui.kicked(); this.state = null; return; }
        } else this.me = mine.n;
        if (this.useLocks && !this.watchingHost) {
          this.watchingHost = true;
          const id = this.id;
          this.watchLock(MP_LOCK + 'host-' + id, () => {
            if (this.role !== 'client' || this.id !== id || !this.state) return;
            if (this.ui) this.ui.hostLost();
            this.state = null;
          });
        }
        if (!this.lobbySim) {
          this.lobbySim = this.makeLobbySim(m.state.lobby.w, m.state.lobby.h);
          this.wrapWorld(this.lobbySim, 'lobby');
        }
        // Игра кончилась — карта больше не идёт, к следующей придёт заново.
        if (m.state.phase !== 'game') this.gotWorld.map = false;
        this.applyState();
        break;
      }
      case 'hping':
        this.hostSeen = performance.now();
        break;
      // Миры — в очередь, по порядку (drainWorlds).
      case 'full':
        if (m.to && m.to !== this.cid) break;
        if (this.world(m.world)) this.worldQ[m.world].push(m);
        break;
      case 'tick':
        this.hostSeen = performance.now();
        if (this.world(m.world)) this.worldQ[m.world].push(m);
        break;
      case 'preview':
        if (this.ui) this.ui.showPreview(m);
        break;
      case 'chat':
        this.onChat(m.n, m.text, m.kind || '');
        break;
      case 'memsnap':
        if (this.ui && this.ui.playMode) this.ui.playMode.memSnap(m.id);
        break;
      case 'memrestore':
        if (this.ui && this.ui.playMode) this.ui.playMode.memRestore(m.id);
        break;
      case 'bye':
        if (this.ui) this.ui.hostLost();
        this.state = null;
        break;
    }
  }
}
