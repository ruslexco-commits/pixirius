'use strict';

// Режим игры за протагониста (EL.PROTAGONIST, физика — sim/protagonist.js).
//
// P — войти и выйти. При входе карта запоминается целиком (точка
// сохранения), при выходе откатывается к ней: всё, что случилось за игру,
// исчезает. Кнопка "сохранить" в левом нижнем углу переносит точку
// сохранения на текущее состояние — тогда выход вернёт уже туда. Пауза на
// время игры снимается, а после выхода возвращается как была. Меню
// создания в игре спрятано, рисование выключено.
//
// Управление: A/D (и стрелки) — идти, W/пробел — прыгнуть на 2 клетки,
// в жидкости W или зажатый пробел — всплывать и держаться на плаву,
// S — нырять, Tab — карта. Подсказок управления на экране нет (просьба
// пользователя) — они в справке лупы о протагонисте.
//
// Камера в игре держит протагониста ровно в центре экрана и приближена так,
// что по высоте видно только круг его зрения — 15 клеток в каждую сторону
// с небольшим запасом (PLAY_VIEW_H), по ширине — сколько войдёт при том же
// размере клетки. У края поля за картой — темнота: протагонист всё равно
// в центре (просьба пользователя). История: сначала окно было шире (96x54
// клеток), потом камеру ненадолго убрали вовсе и показывали всё поле — это
// оказалось не тем, чего хотели.
//
// Видно только то, что в радиусе PLAY_SIGHT клеток и к чему от протагониста
// можно провести прямую, не упёршись в другой пиксель. Непрозрачны твёрдое
// (кроме стекла, IS_SEE_THROUGH) и сыпучее: сквозь воздух, воду, газ,
// стекло и балку он видит — иначе под водой и
// в дыму он не видел бы вовсе ничего, кроме соседних клеток, а балка —
// лишь тёмный полупрозрачный задний план (просьба пользователя).
// Увиденное запоминается: вышедшее из поля зрения остаётся на экране
// полупрозрачным — таким, каким было в последний раз, когда он его видел.
// Память — часть точки сохранения: сохранился в игре — после выхода карта
// увиденного останется той, что была при сохранении. Новый протагонист
// (поставленный туда, где его не было) начинает с чистой памяти.
//
// Мониторы (sim/charges.js): пока протагонист видит монитор, на его карте
// появляется то, что знает монитор (снимки камер), — "временное"
// знание, с синеватым оттенком: подошёл к монитору, отдалил камеру
// колесом или открыл карту (Tab) — видно то, что видели камеры. Монитор
// скрылся из виду — временное исчезает, и на месте снова то, что он помнит
// сам: память камерами не переписывается, знакомые места остаются такими,
// какими он их видел (просьба пользователя). У карты, таким образом, три
// состояния клетки: видно сейчас, временное с монитора, видел сам и помнит.
// Сначала временное показывалось только там, где он ничего не помнил, —
// и на уже знакомых местах камеры будто не работали.
//
// Знание монитора стареет (sim/charges.js, MONITOR_FADE_FRAMES): только что
// пришедшая территория ярко вспыхивает голубым (PLAY_TEMP_FRESH кадров),
// потом темнеет и к концу срока пропадает совсем (просьба пользователя).
//
// Видимость карты (sim.playerVision, выбирается лупой на протагонисте):
// 3 — как описано выше; 2 — при входе в игру вся карта сразу ложится в
// память такой, какая она сейчас, а изменения видны, только когда до них
// достаёт взгляд; 1 — видно всё, как в редакторе. Погиб — карта
// открывается целиком и без темноты, чтобы было видно, что случилось, и
// на экране пишется, от чего он погиб (state.death его игрока).
//
// Темнота (sim.darkness, Renderer.updateLighting) действует и здесь: цвет
// увиденного — уже с освещением, и в память ложится таким же тёмным.
//
// Мультиплеер (js/net.js, js/lobby.js): playerId — номер игрока, за
// которого играет эта вкладка (0 — одиночная игра), mp — связь с лобби.
// В мультиплеере нет точки сохранения и отката: выход по P — только у
// автора (mp.canExit), игра при этом идёт дальше, а протагонист просто
// остаётся без управления. У подключившейся вкладки мир — копия мира хоста,
// и нажатия идут не в sim, а в mp.inputObj, который net.js шлёт хосту.
// Над чужими протагонистами в поле зрения — имена игроков (names).
//
// Tab — карта всего увиденного целиком, текущее местоположение в центре
// экрана; её можно двигать мышью и приближать колесом.

// Радиус обзора. Было 15 — пользователь попросил в 2,5 раза больше.
const PLAY_SIGHT = 38;
// Высота окна обзора в клетках: круг зрения (2*PLAY_SIGHT+1) и по клетке запаса
// сверху и снизу. Нечётная — чтобы протагонист стоял точно посередине.
const PLAY_VIEW_H = 2 * PLAY_SIGHT + 3;
// Пределы масштаба камеры колесом (высота окна в клетках): от совсем
// близко до всего поля по высоте с запасом.
const PLAY_VIEW_MIN = 11, PLAY_VIEW_MAX = 401;
// Камера догоняет протагониста плавно (просьба пользователя: "чуть более
// плавной"): отставание убывает в e раз за PLAY_CAM_TAU секунд, картинка
// сдвигается на доли клетки. Раньше окно стояло клетка в клетку на нём и
// дёргалось на каждом шаге. Дальше PLAY_CAM_SNAP клеток (откат к
// сохранению, новый протагонист) — переносится сразу.
const PLAY_CAM_TAU = 0.12;
// Лучевое зрение (sim.playerRays, переключается лупой; просьба
// пользователя): из протагониста, как из камеры (sim/charges.js
// cameraScan), расходятся PLAY_RAYS лучей на PLAY_RAY_RANGE клеток, каждый —
// до первого непрозрачного (его тоже видно). Лучи пересчитываются раз в
// PLAY_RAY_PERIOD кадров отрисовки (это до 70 тыс. шагов), а между ними
// видно то же, что на последних лучах.
const PLAY_RAYS = 180;
const PLAY_RAY_RANGE = 400;
const PLAY_RAY_PERIOD = 4;
const PLAY_CAM_SNAP = 40;
// Насколько видна память о клетке, которую сейчас не видно.
const PLAY_MEMORY_ALPHA = 0.35;
const PLAY_UNSEEN = [5, 5, 7];        // не виденное никогда
const PLAY_AIR_SEEN = [34, 34, 44];   // увиденная пустота — светлее не виденного
// Временное знание с монитора: оттенок и прозрачность.
const PLAY_TEMP_TINT = [70, 130, 230];
const PLAY_TEMP_ALPHA = 0.5;
// Вспышка свежего знания с монитора: сколько кадров и к какому цвету.
const PLAY_TEMP_FRESH = 60;
const PLAY_TEMP_FLASH = [150, 215, 255];
// Клетка проступает из темноты и растворяется в ней за столько мс — по
// времени, а не градиентом по краю (просьба пользователя).
const PLAY_FADE_MS = 100;   // втрое быстрее первой версии (просьба пользователя)
// Сколько снимков памяти для отмены (Ctrl+Z хоста, см. memSnap) хранить.
const PLAY_MEM_SNAPS = 40;
// С какой доли пути к смерти пелена ещё и заливает весь экран сплошь.
const PLAY_VIGNETTE_SOLID = 0.55;

// Имена над протагонистами мультиплеера (экран игры и комнатка лобби). У
// живого — его цветом. Погибший оставляет имя у тела, и оно за NAME_FADE_MS
// плавно сереет и гаснет (просьба пользователя): возрождение почти сразу
// (RESPAWN_DELAY), тело при нём убирается, а имя ещё догорает там, где
// игрок погиб. Первые NAME_GREY_PART времени — к серому, потом — в прозрачность.
const NAME_FADE_MS = 1600;
const NAME_GREY_PART = 0.45;
const NAME_GREY = [150, 150, 150];
// Ушёл из поля зрения — ник за столько мс плавно становится прозрачным
// (вернулся — так же проявляется; просьба пользователя).
const NAME_VIS_MS = 450;

class NameTags {
  constructor() {
    this.alive = [];    // номер игрока → клетка живого протагониста, -1 — нет
    this.ghosts = [];   // { k, idx, t0 } — гаснущие имена погибших
    this.vis = [];      // номер → видимость ника 0..1 (плавно, NAME_VIS_MS)
    this.lastDraw = 0;
  }

  // Раз в кадр по миру sim: кто жив, кто только что погиб.
  update(sim) {
    const now = performance.now(), n = sim.type.length;
    for (let k = 1; k < sim.players.length; k++) {
      const pl = sim.players[k], j = pl ? pl.idx : -1;
      const here = j >= 0 && j < n && sim.type[j] === EL.PROTAGONIST && sim.life[j] === k;
      const alive = here && sim.extra[j] !== 1;
      const was = this.alive[k];
      if (!alive && was !== undefined && was >= 0) this.ghosts.push({ k, idx: here ? j : was, t0: now });
      this.alive[k] = alive ? j : -1;
    }
    // Имя едет за падающим телом, пока оно есть (тело — клетка, в кадр
    // сдвигается на одну вниз, вбок-вниз или вбок).
    const w = sim.w;
    this.ghosts = this.ghosts.filter((g) => now - g.t0 < NAME_FADE_MS);
    for (const g of this.ghosts) {
      if (this.deadBody(sim, g.idx, g.k)) continue;
      for (const d of [w, w - 1, w + 1, -1, 1]) {
        if (this.deadBody(sim, g.idx + d, g.k)) { g.idx += d; break; }
      }
    }
  }

  deadBody(sim, j, k) { return j >= 0 && j < sim.type.length && sim.type[j] === EL.PROTAGONIST && sim.life[j] === k && sim.extra[j] === 1; }

  // place(клетка) → [x, y, видно] низа подписи на экране или null (вне
  // экрана). Невидимый ник плавно гаснет (vis), видимый — проявляется.
  // Отравленный (stain у живого, sim/human.js) желтеет, как сам протагонист.
  // say(k) — что игрок k сейчас говорит (чат, js/net.js) или null: над ником.
  draw(ctx, sim, names, place, say = null) {
    const now = performance.now();
    const dt = this.lastDraw ? Math.min(200, now - this.lastDraw) : 0;
    this.lastDraw = now;
    for (let k = 1; k < this.alive.length; k++) {
      const j = this.alive[k];
      if (j === undefined || j < 0 || !names[k]) { this.vis[k] = 0; continue; }
      const p = place(j);
      if (!p) continue;
      const target = p[2] === false ? 0 : 1;
      let a = this.vis[k] === undefined ? target : this.vis[k];
      a += (target - a) * Math.min(1, dt / NAME_VIS_MS);
      if (Math.abs(target - a) < 0.01) a = target;
      this.vis[k] = a;
      if (a <= 0) continue;
      const c = (sim.playerColors && sim.playerColors[k]) || [255, 255, 255];
      const pz = sim.stain[j] / 255;
      const col = pz > 0 ? [0, 1, 2].map((q) => Math.round(c[q] + (POISON_COLOR[q] - c[q]) * pz)) : c;
      this.text(ctx, names[k], p[0], p[1], col, a);
      const said = say && say(k);
      if (said) this.bubble(ctx, said, p[0], p[1] - parseInt(ctx.font.match(/(\d+)px/)[1], 10) * 1.25, a);
    }
    for (const g of this.ghosts) {
      if (!names[g.k]) continue;
      const p = place(g.idx);
      if (!p || p[2] === false) continue;
      const t = Math.min(1, (now - g.t0) / NAME_FADE_MS);
      const m = Math.min(1, t / NAME_GREY_PART);
      const a = t <= NAME_GREY_PART ? 1 : 1 - (t - NAME_GREY_PART) / (1 - NAME_GREY_PART);
      const c = (sim.playerColors && sim.playerColors[g.k]) || [255, 255, 255];
      const col = [0, 1, 2].map((q) => Math.round(c[q] + (NAME_GREY[q] - c[q]) * m));
      this.text(ctx, names[g.k], p[0], p[1], col, a);
    }
  }

  // Реплика над ником: тёмная плашка, белый текст (любые языки — шрифт
  // системный).
  bubble(ctx, s, x, y, a) {
    const wtxt = ctx.measureText(s).width, h = parseInt(ctx.font.match(/(\d+)px/)[1], 10) * 1.2;
    ctx.globalAlpha = a;
    ctx.fillStyle = 'rgba(10,10,14,0.78)';
    ctx.fillRect(x - wtxt / 2 - 6, y - h, wtxt + 12, h + 2);
    ctx.fillStyle = '#f2f2f6';
    ctx.fillText(s, x, y);
    ctx.globalAlpha = 1;
  }

  text(ctx, s, x, y, c, a) {
    ctx.globalAlpha = a;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillText(s, x + 1, y + 1);
    ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
    ctx.fillText(s, x, y);
    ctx.globalAlpha = 1;
  }
}

class PlayMode {
  // opts: sim, renderer, input, canvas, stage, saveIconHTML,
  //       setPaused(bool), onEnter(), onExit()
  constructor(opts) {
    Object.assign(this, opts);
    const n = this.sim.w * this.sim.h;
    this.active = false;
    this.mapOpen = false;
    this.playerId = 0;
    this.mp = null;
    this.names = null;
    this.nameTags = new NameTags();
    this.mpStatus = '';
    this.memSeen = new Uint8Array(n);
    this.memColor = new Uint32Array(n);
    // Видимость клетки на экране 0..1 — плавно (PLAY_FADE_MS).
    this.visA = new Float32Array(n);
    this.fadeK = 1;
    this.lastViewAt = 0;
    // Где в памяти записан каждый другой игрок: увидел его в другом месте —
    // прежнее стирается (просьба пользователя: карта не захламляется).
    this.memPlayer = [];
    // Снимки памяти по номерам снимков отмены хоста (js/net.js, memsnap).
    this.memSnaps = new Map();
    this.memEpoch = this.sim.mapEpoch || 0;
    this.memSerial = this.sim.playerSlot(0).serial;
    // Видимые в этом кадре клетки: номер кадра обзора, чтобы не чистить
    // массив каждый раз.
    this.visGen = new Uint32Array(n);
    this.gen = 0;
    // Временное с мониторов: номер кадра обзора и вид клетки (LOOK_AIR —
    // пустота, иначе цвет).
    this.tempGen = new Uint32Array(n);
    this.tempLook = new Int32Array(n);
    this.tempAge = new Uint16Array(n);   // сколько кадров назад монитор получил клетку
    this.tempCount = 0;
    this.savePoint = null;
    this.wasPaused = false;
    this.lastX = this.sim.w >> 1;
    this.lastY = this.sim.h >> 1;
    // Плавная камера (см. PLAY_CAM_TAU): где она сейчас, в клетках.
    this.camX = this.lastX;
    this.camY = this.lastY;
    this.camT = 0;
    this.toast = '';
    this.toastUntil = 0;
    this.mapPanX = 0;
    this.mapPanY = 0;
    this.mapZoom = 1;
    this.mapDrag = null;

    this.overlay = document.createElement('canvas');
    this.overlay.id = 'playView';
    this.overlay.width = this.canvas.width;
    this.overlay.height = this.canvas.height;
    this.stage.appendChild(this.overlay);
    this.ctx = this.overlay.getContext('2d');
    this.viewCanvas = document.createElement('canvas');
    this.viewCtx = this.viewCanvas.getContext('2d');
    this.setViewHeight(PLAY_VIEW_H);
    this.mapCanvas = document.createElement('canvas');
    this.mapCanvas.width = this.sim.w; this.mapCanvas.height = this.sim.h;
    this.mapCtx = this.mapCanvas.getContext('2d');
    this.mapImg = this.mapCtx.createImageData(this.sim.w, this.sim.h);

    this.saveBtn = document.createElement('button');
    this.saveBtn.id = 'playSave';
    this.saveBtn.type = 'button';
    this.saveBtn.title = 'Сохранить: выход из игры (P) вернёт сюда';
    this.saveBtn.innerHTML = this.saveIconHTML;
    this.saveBtn.addEventListener('click', () => this.save());
    this.stage.appendChild(this.saveBtn);

    // Перехват в фазе захвата: в игре пробел — прыжок, а не пауза
    // (main.js), Tab — карта, а не форма кисти (input.js), Ctrl+Z не
    // откатывает мир. Поэтому, пока идёт игра, клавиши дальше не идут.
    window.addEventListener('keydown', (e) => this.onKey(e, true), true);
    window.addEventListener('keyup', (e) => this.onKey(e, false), true);
    window.addEventListener('blur', () => this.releaseKeys());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.mining = false; });
    // ЛКМ в обзоре — ломать (sim/protagonist.js, playerMine): пока зажата,
    // прицел — клетка под курсором (считается в drawView: камера едет, и
    // клетка под неподвижной мышью меняется).
    this.mining = false;
    this.mouseX = this.mouseY = null;
    this.overlay.addEventListener('mousedown', (e) => {
      this.mouseX = e.clientX; this.mouseY = e.clientY;
      if (this.mapOpen) this.mapDrag = { x: e.clientX, y: e.clientY, px: this.mapPanX, py: this.mapPanY };
      else if (e.button === 0) e.preventDefault();
    });
    // Ломание — по событиям указателя с захватом: отпускание кнопки приходит
    // сюда, где бы мышь ни была (вне окна, над другим элементом). Раньше
    // ловилось только отпускание над окном, и ЛКМ "залипала": протагонист
    // копал дальше и после отпускания, и после возрождения (жалоба
    // пользователя).
    this.overlay.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.active || this.mapOpen) return;
      this.mining = true;
      try { this.overlay.setPointerCapture(e.pointerId); } catch (err) { /* без захвата — отпустят над окном */ }
    });
    const stopMining = () => { this.mining = false; };
    this.overlay.addEventListener('pointerup', stopMining);
    this.overlay.addEventListener('pointercancel', stopMining);
    this.overlay.addEventListener('lostpointercapture', stopMining);
    window.addEventListener('mousemove', (e) => {
      this.mouseX = e.clientX; this.mouseY = e.clientY;
      // Кнопку отпустили, а отпускание не дошло (вне окна, при смене окна) —
      // ЛКМ "залипала", и протагонист копал дальше (жалоба пользователя).
      if (this.mining && !(e.buttons & 1)) this.mining = false;
      if (!this.mapDrag) return;
      const k = this.overlay.width / this.overlay.getBoundingClientRect().width;
      this.mapPanX = this.mapDrag.px + (e.clientX - this.mapDrag.x) * k;
      this.mapPanY = this.mapDrag.py + (e.clientY - this.mapDrag.y) * k;
    });
    window.addEventListener('mouseup', (e) => { this.mapDrag = null; if (e.button === 0) this.mining = false; });
    this.overlay.addEventListener('contextmenu', (e) => e.preventDefault());
    // Колесо на карте — приблизить или отдалить, не сдвигая местоположение
    // из центра (сдвиг мышью масштабируется вместе с картой).
    this.overlay.addEventListener('wheel', (e) => {
      if (!this.active) return;
      e.preventDefault();
      // В обзоре колесо приближает и отдаляет камеру (протагонист остаётся
      // в центре), на карте — масштаб карты.
      if (!this.mapOpen) {
        this.setViewHeight(Math.round(this.viewH * (e.deltaY < 0 ? 0.8 : 1.25)));
        return;
      }
      const k = e.deltaY < 0 ? 1.25 : 0.8;
      const z = Math.max(1, Math.min(8, this.mapZoom * k));
      this.mapPanX *= z / this.mapZoom; this.mapPanY *= z / this.mapZoom;
      this.mapZoom = z;
    }, { passive: false });
  }

  // Высота окна обзора в клетках (нечётная — протагонист точно в центре),
  // ширина — по пропорциям поля, тоже нечётная.
  setViewHeight(vh) {
    vh = Math.max(PLAY_VIEW_MIN, Math.min(PLAY_VIEW_MAX, vh | 0));
    if (vh % 2 === 0) vh++;
    this.viewH = vh;
    this.viewW = 2 * Math.round((vh * this.canvas.width / this.canvas.height - 1) / 2) + 1;
    // С запасом в клетку с каждой стороны: плавная камера сдвигает окно на
    // доли клетки, и край не должен оголяться.
    this.viewCanvas.width = this.viewW + 2; this.viewCanvas.height = this.viewH + 2;
    this.viewImg = this.viewCtx.createImageData(this.viewW + 2, this.viewH + 2);
  }

  // Нажатия игрока: в sim (одиночная игра, хост) или в mp.inputObj (см. шапку).
  inp() { return this.mp && this.mp.inputObj ? this.mp.inputObj : this.sim.playerSlot(this.playerId).input; }
  // Состояние протагониста игрока (дыхание, силы, смерть).
  pst() { return this.sim.playerSlot(this.playerId).state; }

  onKey(e, down) {
    // Печатают в поле (чат) — клавиши ему, не игре.
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    // T — чат (мультиплеер).
    if (e.code === 'KeyT' && this.active && this.mp && this.mp.openChat) {
      if (down && !e.repeat) { this.releaseKeys(); this.mp.openChat(); }
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (e.code === 'KeyP') {
      // В мультиплеере P решает лобби: выйти может только автор (mp.canExit),
      // войти — пока идёт игра (mp.canEnter).
      if (down && !e.repeat) {
        if (!this.mp) this.active ? this.exit() : this.enter();
        else if (this.active && this.mp.canExit()) this.exit();
        else if (!this.active && this.mp.canEnter()) this.enter();
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (!this.active) return;
    if (/^F\d+$/.test(e.code)) return;   // F5, F12 и прочие — браузеру
    // Выбыл и наблюдает: A/D — за другим игроком.
    if (this.watching >= 0 && down && !e.repeat) {
      if (e.code === 'KeyA' || e.code === 'ArrowLeft') this.watchStep = -1;
      if (e.code === 'KeyD' || e.code === 'ArrowRight') this.watchStep = 1;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    const inp = this.inp();
    switch (e.code) {
      case 'KeyA': case 'ArrowLeft': inp.left = down; break;
      case 'KeyD': case 'ArrowRight': inp.right = down; break;
      // W и пробел оба и прыгают (нажатие), и держат вверх в воде
      // (зажатие): "вверх" — пока зажата хоть одна из клавиш.
      case 'KeyW': case 'ArrowUp':
        this.upW = down;
        inp.up = this.upW || this.upSpace;
        if (down && !e.repeat) inp.jump = true;
        break;
      case 'KeyS': case 'ArrowDown': inp.down = down; break;
      case 'Space':
        this.upSpace = down;
        inp.up = this.upW || this.upSpace;
        if (down && !e.repeat) inp.jump = true;
        break;
      case 'Tab':
        if (down && !e.repeat) { this.mapOpen = !this.mapOpen; this.mapPanX = 0; this.mapPanY = 0; this.mapZoom = 1; }
        break;
    }
  }

  releaseKeys() {
    const inp = this.inp();
    inp.left = inp.right = inp.up = inp.down = inp.jump = false;
    inp.mine = false;
    this.mining = false;
    this.upW = this.upSpace = false;
  }

  // Точка сохранения: мир (тот же снимок, что у отмены) и память.
  capture() {
    return {
      snap: this.sim.snapshot(),
      seen: this.memSeen.slice(),
      color: this.memColor.slice(),
      wet: this.pst().wet,
    };
  }

  enter() {
    const sim = this.sim;
    if (sim.findProtagonist(this.playerId) < 0) {
      if (!this.mp) this.flashOutside('Сначала поставьте протагониста — вкладка «Технологии»');
      return;
    }
    // Новый протагонист — новая память.
    const serial = sim.playerSlot(this.playerId).serial;
    if (serial !== this.memSerial) {
      this.memSeen.fill(0);
      this.memColor.fill(0);
      this.memSerial = serial;
    }
    // Видимость 2: вся карта сразу в памяти — такой, какая она сейчас.
    if (sim.playerVision === 2) {
      this.renderer.updateLighting();
      for (let i = 0; i < this.memSeen.length; i++) {
        const c = this.cellRGB(i);
        this.memSeen[i] = 1;
        this.memColor[i] = (c[0] << 16) | (c[1] << 8) | c[2];
      }
    }
    this.revealed = false;
    this.camT = 0;   // камера — сразу на протагонисте
    // В мультиплеере точки сохранения нет (см. шапку).
    this.savePoint = this.mp ? null : this.capture();
    this.wasPaused = sim.paused;
    if (!this.mp) this.setPaused(false);
    this.releaseKeys();
    this.input.drag = null;
    this.input.enabled = false;
    this.active = true;
    this.mapOpen = false;
    this.onEnter();
    this.overlay.classList.add('visible');
    if (!this.mp) this.saveBtn.classList.add('visible');
  }

  exit() {
    const sim = this.sim, sp = this.savePoint;
    this.active = false;
    this.mapOpen = false;
    this.releaseKeys();
    if (sp && !this.mp) {
      sim.restore(sp.snap);
      this.memSeen.set(sp.seen);
      this.memColor.set(sp.color);
      this.pst().wet = sp.wet;
      sim.playerSlot(this.playerId).idx = -1;
    }
    this.overlay.classList.remove('visible');
    this.saveBtn.classList.remove('visible');
    this.input.enabled = true;
    if (!this.mp) this.setPaused(this.wasPaused);
    this.onExit();
  }

  save() {
    if (!this.active) return;
    this.savePoint = this.capture();
    this.showToast('Сохранено');
  }

  showToast(text) { this.toast = text; this.toastUntil = performance.now() + 1800; }

  // Подсказка вне игры (протагониста нет) — поверх обычного поля.
  flashOutside(text) {
    let el = document.getElementById('playFlash');
    if (!el) { el = document.createElement('div'); el.id = 'playFlash'; this.stage.appendChild(el); }
    el.textContent = text;
    el.classList.add('visible');
    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => el.classList.remove('visible'), 2200);
  }

  // Непрозрачна ли клетка для взгляда (см. шапку файла). Балка прозрачна.
  opaque(i) {
    const t = this.sim.type[i];
    if (t === EL.EMPTY || IS_SEE_THROUGH[t] === 1) return false;
    const el = ELEMENTS[t];
    return !!el && (el.cat === CAT.SOLID || el.cat === CAT.POWDER);
  }

  // Прямая от (x0,y0) до (x1,y1) не упирается ни во что непрозрачное
  // (сама целевая клетка не в счёт — её и видно).
  lineOfSight(x0, y0, x1, y1) {
    const w = this.sim.w;
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy, x = x0, y = y0;
    for (;;) {
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
      if (x === x1 && y === y1) return true;
      if (this.opaque(y * w + x)) return false;
    }
  }

  // Цвет клетки для экрана игры: с освещением (темнота), монитор — со
  // вспышкой приёма. lit=false — без темноты (открытая карта погибшего).
  cellRGB(i, lit = true) {
    const t = this.sim.type[i], r = this.renderer;
    let c;
    if (t === EL.EMPTY && !this.sim.beam[i]) c = PLAY_AIR_SEEN;
    else if (t === EL.MONITOR) c = r.glowColor(i, r.cellColor(i));
    else c = r.cellColor(i);
    return lit ? r.litColor(i, c) : c;
  }

  // Видно ли всё поле сразу: видимость 1 или протагонист погиб.
  seeAll() { return this.revealed || this.sim.playerVision === 1; }

  // Клетка открытой карты — как есть сейчас (погиб — без темноты).
  putLive(data, o, i) {
    const c = this.cellRGB(i, !this.revealed);
    data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255;
  }

  // Отмена у хоста (js/net.js): перед действием — снимок памяти под номером
  // id, при отмене — память возвращается к нему (просьба пользователя:
  // "при Ctrl+Z карта каждого игрока откатится на момент до действия").
  memSnap(id) {
    this.memSnaps.set(id, { seen: this.memSeen.slice(), color: this.memColor.slice() });
    while (this.memSnaps.size > PLAY_MEM_SNAPS) this.memSnaps.delete(this.memSnaps.keys().next().value);
  }

  memRestore(id) {
    const m = this.memSnaps.get(id);
    if (!m) return;
    this.memSeen.set(m.seen);
    this.memColor.set(m.color);
    this.memPlayer = [];
  }

  // Карта сменилась (загрузка, очистка — sim.mapEpoch): увиденное забыто.
  memForget() {
    this.memSeen.fill(0);
    this.memColor.fill(0);
    this.visA.fill(0);
    this.memPlayer = [];
    this.memSnaps.clear();
  }

  // Другие игроки, увиденные в этом кадре (клетки): прежнее место каждого в
  // памяти стирается — там запоминается пустота.
  forgetOldPlayers(seen, gen) {
    const air = (PLAY_AIR_SEEN[0] << 16) | (PLAY_AIR_SEEN[1] << 8) | PLAY_AIR_SEEN[2];
    for (const j of seen) {
      const k = this.sim.life[j], old = this.memPlayer[k];
      if (old !== undefined && old !== j && this.visGen[old] !== gen) this.memColor[old] = air;
      this.memPlayer[k] = j;
    }
  }

  // Что видно в этом кадре: отметить видимое и обновить им память.
  look(px, py) {
    const sim = this.sim, w = sim.w, h = sim.h, R = PLAY_SIGHT;
    const gen = ++this.gen;
    const monitors = [], players = [];
    for (let dy = -R; dy <= R; dy++) {
      const y = py + dy;
      if (y < 0 || y >= h) continue;
      for (let dx = -R; dx <= R; dx++) {
        const x = px + dx;
        if (x < 0 || x >= w || dx * dx + dy * dy > R * R) continue;
        if ((dx || dy) && !this.lineOfSight(px, py, x, y)) continue;
        const i = y * w + x;
        this.visGen[i] = gen;
        if (sim.type[i] === EL.MONITOR) monitors.push(i);
        else if (sim.type[i] === EL.PROTAGONIST && sim.life[i] !== this.playerId) players.push(i);
        const c = this.cellRGB(i);
        this.memSeen[i] = 1;
        this.memColor[i] = (c[0] << 16) | (c[1] << 8) | c[2];
      }
    }
    if (sim.playerRays) this.lookRays(px, py, gen, monitors, players);
    this.lookMonitors(monitors);
    if (players.length) this.forgetOldPlayers(players, gen);
  }

  // Лучевое зрение (см. PLAY_RAYS): клетки на лучах — видимые в этом кадре.
  lookRays(px, py, gen, monitors, players) {
    const sim = this.sim, w = sim.w, h = sim.h;
    if (!this.rayCells || this.rayFrom !== py * w + px || ++this.rayTick >= PLAY_RAY_PERIOD) {
      this.rayTick = 0;
      this.rayFrom = py * w + px;
      const cells = [];
      for (let r = 0; r < PLAY_RAYS; r++) {
        const a = (r / PLAY_RAYS) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
        let last = -1;
        for (let s = 1; s <= PLAY_RAY_RANGE; s++) {
          const x = Math.round(px + ca * s), y = Math.round(py + sa * s);
          if (x < 0 || x >= w || y < 0 || y >= h) break;
          const j = y * w + x;
          if (j === last) continue;
          last = j;
          cells.push(j);
          if (this.opaque(j)) break;
        }
      }
      this.rayCells = cells;
    }
    for (const j of this.rayCells) {
      if (this.visGen[j] === gen) continue;
      this.visGen[j] = gen;
      if (sim.type[j] === EL.MONITOR) monitors.push(j);
      else if (sim.type[j] === EL.PROTAGONIST && sim.life[j] !== this.playerId) players.push(j);
      const c = this.cellRGB(j);
      this.memSeen[j] = 1;
      this.memColor[j] = (c[0] << 16) | (c[1] << 8) | c[2];
    }
  }

  // Временное знание с видимых мониторов (см. шапку): их карты — туда, где
  // протагонист не видит сейчас. Видно несколько мониторов с одной
  // клеткой — берётся самая свежая.
  lookMonitors(cells) {
    const sim = this.sim, gen = this.gen;
    this.tempCount = 0;
    if (!cells.length || !sim.monitorMaps.size) return;
    const done = new Set();
    for (const c of cells) {
      if (done.has(c)) continue;
      const comp = sim.monitorComponent(c);
      for (const j of comp.cells) done.add(j);
      const map = sim.monitorMaps.get(comp.key);
      if (!map) continue;
      for (const [j, v] of map) {
        if (this.visGen[j] === gen) continue;
        const age = Math.min(MONITOR_FADE_FRAMES, Math.max(0, sim.frame - monitorAt(v)));
        if (this.tempGen[j] === gen && this.tempAge[j] <= age) continue;
        if (this.tempGen[j] !== gen) this.tempCount++;
        this.tempGen[j] = gen;
        this.tempLook[j] = monitorLook(v);
        this.tempAge[j] = age;
      }
    }
  }

  // Цвет временной клетки (с монитора) поверх того, что уже записано в
  // data[o] (память или темнота): оттенок и прозрачность PLAY_TEMP_*.
  // alpha — насколько проступает свежая; с возрастом age (кадров) она
  // гаснет до нуля к MONITOR_FADE_FRAMES, и из-под неё снова видна
  // собственная память протагониста, а первые PLAY_TEMP_FRESH кадров
  // клетка ещё и вспыхивает голубым.
  putTemp(data, o, look, alpha, age) {
    let r, g, b;
    if (look & LOOK_AIR) { r = PLAY_AIR_SEEN[0]; g = PLAY_AIR_SEEN[1]; b = PLAY_AIR_SEEN[2]; }
    else { r = (look >> 16) & 255; g = (look >> 8) & 255; b = look & 255; }
    r += (PLAY_TEMP_TINT[0] - r) * 0.3; g += (PLAY_TEMP_TINT[1] - g) * 0.3; b += (PLAY_TEMP_TINT[2] - b) * 0.3;
    alpha *= 1 - age / MONITOR_FADE_FRAMES;
    if (age < PLAY_TEMP_FRESH) {
      const f = 1 - age / PLAY_TEMP_FRESH;
      r += (PLAY_TEMP_FLASH[0] - r) * 0.6 * f; g += (PLAY_TEMP_FLASH[1] - g) * 0.6 * f; b += (PLAY_TEMP_FLASH[2] - b) * 0.6 * f;
      alpha += (1 - alpha) * f;
    }
    data[o] += (r - data[o]) * alpha;
    data[o + 1] += (g - data[o + 1]) * alpha;
    data[o + 2] += (b - data[o + 2]) * alpha;
    data[o + 3] = 255;
  }

  // Цвет клетки для экрана игры: видимая — как есть, запомненная —
  // полупрозрачной поверх темноты, не виденная — темнота.
  // Видимость клетки (visA) идёт к 1 или 0 плавно, по времени (fadeK —
  // доля пути за этот кадр, см. drawView): видимая проступает из темноты
  // или из памяти, ушедшая из вида — растворяется в памяти.
  put(data, o, i) {
    if (this.seeAll()) { this.putLive(data, o, i); return; }
    const vis = this.visGen[i] === this.gen;
    let a = this.visA[i];
    a += ((vis ? 1 : 0) - a) * this.fadeK;
    if (a < 0.004) a = 0; else if (a > 0.996) a = 1;
    this.visA[i] = a;
    const c = this.memColor[i];
    let r, g, b;
    if (this.memSeen[i]) {
      const m = PLAY_MEMORY_ALPHA;
      r = PLAY_UNSEEN[0] + ((c >> 16) - PLAY_UNSEEN[0]) * m;
      g = PLAY_UNSEEN[1] + (((c >> 8) & 255) - PLAY_UNSEEN[1]) * m;
      b = PLAY_UNSEEN[2] + ((c & 255) - PLAY_UNSEEN[2]) * m;
    } else {
      r = PLAY_UNSEEN[0]; g = PLAY_UNSEEN[1]; b = PLAY_UNSEEN[2];
    }
    if (a > 0) {
      r += ((c >> 16) - r) * a; g += (((c >> 8) & 255) - g) * a; b += ((c & 255) - b) * a;
    }
    data[o] = r; data[o + 1] = g; data[o + 2] = b;
    data[o + 3] = 255;
    if (vis) return;
    if (this.tempGen[i] === this.gen) this.putTemp(data, o, this.tempLook[i], PLAY_TEMP_ALPHA, this.tempAge[i]);
  }

  // За кем наблюдать выбывшему: номер живого игрока (не себя) или -1.
  // Прежний, пока жив; watchStep (A/D) — следующий или предыдущий.
  watchTarget() {
    const sim = this.sim, alive = [];
    for (let k = 1; k < sim.players.length; k++) {
      if (k === this.playerId || !sim.players[k]) continue;
      const j = sim.findProtagonist(k);
      if (j >= 0 && !sim.extra[j]) alive.push(k);
    }
    if (!alive.length) return -1;
    if (!alive.includes(this.watchK)) this.watchK = alive[0];
    if (this.watchStep) {
      const n = alive.indexOf(this.watchK);
      this.watchK = alive[(n + this.watchStep + alive.length) % alive.length];
      this.watchStep = 0;
    }
    return this.watchK;
  }

  // Пелена по краям экрана: rgb, прозрачность у края a; wave — переливается
  // (отравление). Отравление — жёлтая, утопание — тёмно-синяя, раны —
  // красная (просьба пользователя).
  // level 0..1 — насколько близко к смерти: пелена сужается к центру и при
  // 1 закрывает весь экран вместе с протагонистом (просьба пользователя).
  vignette(ctx, W, H, rgb, a, wave, level = 0) {
    if (a <= 0.01) return;
    const t = performance.now() / 1000;
    const close = 1 - Math.min(1, level);
    const R = Math.hypot(W, H) / 2;
    const inner = Math.max(0, Math.min(W, H) * (0.3 + (wave ? 0.06 * Math.sin(t * 2.3) : 0)) * close * close);
    const outer = inner + 2 + (R - inner) * close;
    const g = ctx.createRadialGradient(W / 2, H / 2, inner, W / 2, H / 2, outer);
    const aa = Math.min(1, wave ? a * (0.8 + 0.2 * Math.sin(t * 4.1)) : a);
    const c = wave ? [rgb[0], Math.round(rgb[1] + 25 * Math.sin(t * 1.7)), Math.round(rgb[2] + 30 * Math.sin(t * 2.9 + 1))] : rgb;
    g.addColorStop(0, `rgba(${c[0]},${c[1]},${c[2]},0)`);
    g.addColorStop(1, `rgba(${c[0]},${c[1]},${c[2]},${aa.toFixed(3)})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // На последних стадиях — ещё и сплошной слой поверх всего: к смерти
    // экран закрыт полностью (просьба пользователя: "слишком прозрачный").
    if (level > PLAY_VIGNETTE_SOLID) {
      const k = Math.pow((level - PLAY_VIGNETTE_SOLID) / (1 - PLAY_VIGNETTE_SOLID), 1.3);
      ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${Math.min(1, k).toFixed(3)})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  // Раз в кадр отрисовки вместо обычного рендера поля.
  frame() {
    const sim = this.sim;
    this.placeOverlay();
    this.renderer.updateMonitorGlow();
    this.renderer.updateLighting();
    if ((sim.mapEpoch || 0) !== this.memEpoch) { this.memEpoch = sim.mapEpoch || 0; this.memForget(); }
    let p = sim.findProtagonist(this.playerId);
    // Погиб — ломание кончилось: после возрождения — только новым нажатием.
    if (p < 0 || sim.extra[p]) this.mining = false;
    // Выбыл насовсем (жизни кончились, возрождения нет; мультиплеер) —
    // наблюдает за другим живым игроком: его глазами и его камерой
    // (просьба пользователя). A/D — сменить, за кем.
    this.watching = -1;
    if (this.mp && this.mp.isOut && this.mp.isOut()) {
      const k = this.watchTarget();
      if (k >= 0) { this.watching = k; p = sim.findProtagonist(k); }
    }
    // Погиб (или пропал с поля) — карта открывается целиком.
    this.revealed = p < 0 || !!sim.extra[p];
    if (p >= 0) {
      this.lastX = p % sim.w;
      this.lastY = (p / sim.w) | 0;
      this.look(this.lastX, this.lastY);
      this.followCamera();
    } else {
      this.gen++;   // протагониста нет — ничего не видно
    }
    if (this.mapOpen) { this.inp().mine = false; this.drawMap(); } else this.drawView();
    this.drawHud(p);
  }

  // Окно вокруг протагониста (он в центре): видимое — как есть,
  // запомненное — полупрозрачным, остальное и всё за краем поля — темнота.
  // Клетки квадратные: размер клетки берётся по высоте, а окно по ширине
  // центрируется (обрезка по краям — доли клетки).
  // Камера — к протагонисту (lastX, lastY), плавно (см. PLAY_CAM_TAU).
  followCamera() {
    const now = performance.now();
    const far = Math.abs(this.lastX - this.camX) + Math.abs(this.lastY - this.camY) > PLAY_CAM_SNAP;
    if (!this.camT || far) { this.camX = this.lastX; this.camY = this.lastY; }
    else {
      const dt = Math.min(0.1, (now - this.camT) / 1000);
      const k = 1 - Math.exp(-dt / PLAY_CAM_TAU);
      this.camX += (this.lastX - this.camX) * k;
      this.camY += (this.lastY - this.camY) * k;
    }
    this.camT = now;
  }

  // Окно вокруг камеры: клетки с запасом в одну с каждой стороны, а
  // картинка сдвинута так, чтобы центр экрана пришёлся на центр камеры
  // (camX + 0.5) — с долями клетки.
  drawView() {
    const sim = this.sim, w = sim.w, h = sim.h, VW = this.viewW + 2, VH = this.viewH + 2;
    const now = performance.now();
    this.fadeK = this.lastViewAt ? Math.min(1, (now - this.lastViewAt) / PLAY_FADE_MS) : 1;
    this.lastViewAt = now;
    const ox = Math.floor(this.camX) - (this.viewW >> 1) - 1, oy = Math.floor(this.camY) - (this.viewH >> 1) - 1;
    const data = this.viewImg.data;
    for (let vy = 0; vy < VH; vy++) {
      const y = oy + vy;
      for (let vx = 0; vx < VW; vx++) {
        const x = ox + vx, o = (vy * VW + vx) * 4;
        if (x < 0 || x >= w || y < 0 || y >= h) { data[o] = 0; data[o + 1] = 0; data[o + 2] = 0; data[o + 3] = 255; continue; }
        this.put(data, o, y * w + x);
      }
    }
    this.viewCtx.putImageData(this.viewImg, 0, 0);
    const ctx = this.ctx, W = this.overlay.width, H = this.overlay.height;
    const cell = H / this.viewH;
    const dx = W / 2 - (this.camX + 0.5 - ox) * cell, dy = H / 2 - (this.camY + 0.5 - oy) * cell;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.viewCanvas, dx, dy, VW * cell, VH * cell);
    this.drawToxicSight(ctx, W, H, dx, dy, VW * cell, VH * cell);
    this.drawMining(ctx, W, H, dx, dy, cell, ox, oy);
    // Имена игроков над протагонистами в поле зрения (мультиплеер; у
    // погибших — гаснут, см. NameTags).
    if (this.names) {
      ctx.font = `bold ${Math.max(12, Math.round(cell * 1.6))}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      this.nameTags.update(sim);
      const all = this.seeAll();
      this.nameTags.draw(ctx, sim, this.names, (j) => [dx + (j % w - ox + 0.5) * cell, dy + (((j / w) | 0) - oy) * cell - 4, all || this.visGen[j] === this.gen], this.mp && this.mp.sayOf);
      ctx.textAlign = 'left';
    }
  }

  // Отравление в глазах (просьба пользователя): увиденное двоится — две
  // жёлто-рыжая и зеленовато-жёлтая копии разъезжаются, дрожа, — и всё
  // желтеет; тем сильнее, чем сильнее отравление. Отравление — stain своего
  // протагониста (sim/human.js).
  drawToxicSight(ctx, W, H, dx, dy, vw, vh) {
    const p = this.watching >= 0 ? -1 : this.sim.findProtagonist(this.playerId);
    if (p < 0 || this.sim.extra[p]) return;
    const tox = this.sim.stain[p] / 255;
    if (tox < 0.02) return;
    const t = performance.now() / 1000;
    const off = vh / this.viewH * (0.3 + 2.5 * tox) * (0.65 + 0.35 * Math.sin(t * 2.1));
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.3 * tox;
    ctx.filter = 'sepia(1) saturate(5) hue-rotate(-20deg)';
    ctx.drawImage(this.viewCanvas, dx + off, dy + off * 0.25 * Math.sin(t * 1.3), vw, vh);
    ctx.filter = 'sepia(1) saturate(5) hue-rotate(30deg)';
    ctx.drawImage(this.viewCanvas, dx - off, dy - off * 0.25 * Math.cos(t * 1.7), vw, vh);
    ctx.restore();
    ctx.save();
    ctx.globalCompositeOperation = 'color';
    ctx.globalAlpha = Math.min(0.85, 0.9 * tox);
    ctx.fillStyle = 'rgb(236,214,40)';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  // Ломание: прицел — клетка мира под курсором, пока зажата ЛКМ; цель —
  // рамкой, ярче с каждым ударом. Линию от протагониста к курсору не
  // рисуем (просьба пользователя) — она только считается (sim/protagonist.js).
  drawMining(ctx, W, H, dx, dy, cell, ox, oy) {
    const inp = this.inp(), sim = this.sim;
    const alive = !this.revealed;
    if (!this.mining || !alive || this.mouseX === null) { inp.mine = false; return; }
    const r = this.overlay.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) { inp.mine = false; return; }
    const px = (this.mouseX - r.left) * W / r.width, py = (this.mouseY - r.top) * H / r.height;
    inp.mine = true;
    inp.ax = Math.floor((px - dx) / cell) + ox;
    inp.ay = Math.floor((py - dy) / cell) + oy;
    ctx.save();
    const st = this.pst(), j = st.mineCell;
    if (j >= 0 && j < sim.type.length && sim.type[j] !== EL.EMPTY) {
      const need = sim.mineHitsNeeded(j), k = Math.min(1, st.mineHits / need);
      const tx = dx + (j % sim.w - ox) * cell, ty = dy + (((j / sim.w) | 0) - oy) * cell;
      ctx.strokeStyle = `rgba(255,220,120,${(0.5 + 0.5 * k).toFixed(2)})`;
      ctx.lineWidth = Math.max(1, cell * 0.15);
      ctx.strokeRect(tx, ty, cell, cell);
    }
    ctx.restore();
  }

  // Карта всего увиденного (Tab): местоположение — в центре экрана.
  drawMap() {
    const sim = this.sim, n = sim.w * sim.h, data = this.mapImg.data;
    const all = this.seeAll();
    for (let i = 0, o = 0; i < n; i++, o += 4) {
      if (all) { this.putLive(data, o, i); continue; }
      if (this.memSeen[i]) {
        const c = this.memColor[i];
        data[o] = c >> 16; data[o + 1] = (c >> 8) & 255; data[o + 2] = c & 255;
      } else { data[o] = PLAY_UNSEEN[0]; data[o + 1] = PLAY_UNSEEN[1]; data[o + 2] = PLAY_UNSEEN[2]; }
      data[o + 3] = 255;
      if (this.tempGen[i] === this.gen && this.visGen[i] !== this.gen) this.putTemp(data, o, this.tempLook[i], 0.85, this.tempAge[i]);
    }
    this.mapCtx.putImageData(this.mapImg, 0, 0);
    const ctx = this.ctx, W = this.overlay.width, H = this.overlay.height;
    const scale = W / sim.w * this.mapZoom;
    const dx = W / 2 - (this.lastX + 0.5) * scale + this.mapPanX;
    const dy = H / 2 - (this.lastY + 0.5) * scale + this.mapPanY;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.mapCanvas, dx, dy, sim.w * scale, sim.h * scale);
    // Рамка поля и мигающая метка "вы здесь".
    ctx.strokeStyle = 'rgba(160,160,180,0.35)';
    ctx.lineWidth = 2;
    ctx.strokeRect(dx, dy, sim.w * scale, sim.h * scale);
    const mx = dx + (this.lastX + 0.5) * scale, my = dy + (this.lastY + 0.5) * scale;
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 180);
    ctx.strokeStyle = `rgba(255,196,36,${0.4 + 0.6 * pulse})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(mx, my, 10 + 4 * pulse, 0, Math.PI * 2);
    ctx.stroke();
  }

  drawHud(p) {
    const ctx = this.ctx, W = this.overlay.width, H = this.overlay.height, sim = this.sim;
    ctx.textBaseline = 'top';
    // Таймер (настройка вкладки, мультиплеер): сколько идёт игра — у
    // выбывшего замирает на миг выбывания. Жёлтый, справа вверху. Под ним —
    // оставшиеся жизни, если они считаются.
    // Сколько прожил в этой жизни (с появления — bornAt); погиб — красный и
    // мигает на времени смерти (просьба пользователя).
    const own = sim.findProtagonist(this.playerId), ownAlive = own >= 0 && !sim.extra[own];
    if (ownAlive) this.diedAt = null;
    else if (this.diedAt === null || this.diedAt === undefined) this.diedAt = sim.frame;
    if (this.mp && this.mp.timerOn && this.mp.timerOn()) {
      const clock = this.mp.gameClock(), slot = sim.playerSlot(this.playerId);
      const born = slot.bornAt !== undefined ? slot.bornAt : clock.start;
      if (born !== undefined) {
        const sec = Math.max(0, ((ownAlive ? sim.frame : this.diedAt) - born) / 60);
        const t = `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
        const blinkOff = !ownAlive && Math.floor(performance.now() / 420) % 2 === 1;
        if (!blinkOff) {
          ctx.font = 'bold 34px system-ui, sans-serif';
          ctx.textAlign = 'right';
          ctx.fillStyle = 'rgba(0,0,0,0.6)';
          ctx.fillText(t, W - 18, 18);
          ctx.fillStyle = ownAlive ? '#ffd23a' : '#ff4a3a';
          ctx.fillText(t, W - 20, 16);
          ctx.textAlign = 'left';
        }
      }
    }
    const lives = this.mp && this.mp.livesLeft ? this.mp.livesLeft() : null;
    if (lives !== null) {
      ctx.font = 'bold 24px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillStyle = '#ff8a7a';
      ctx.fillText('Жизни: ' + lives, W - 20, 58);
      ctx.textAlign = 'left';
    }
    // Наблюдение за другим игроком (выбыл): своё — не показываем.
    if (this.watching >= 0) {
      const name = (this.names && this.names[this.watching]) || ('P' + this.watching);
      ctx.font = 'bold 26px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(W / 2 - 330, 12, 660, 40);
      ctx.fillStyle = '#e8e0d8';
      ctx.fillText(`Вы выбыли · наблюдаете за ${name} · A/D — другой игрок`, W / 2, 18);
      ctx.textAlign = 'left';
      return;
    }
    // Пелена по краям: отравление (жёлтая, переливается), утопание (почти
    // чёрная синева), усталость вплавь и при копании (чёрная), раны
    // (красная). Ближе к смерти — сужается к центру (level).
    if (p >= 0 && !sim.extra[p]) {
      const st = this.pst();
      const poison = sim.stain[p] / 255, wetK = Math.min(1, st.wet / HUMAN_DROWN_FRAMES), hurt = sim.dirt[p] / 255;
      const tired = Math.max(0, 1 - st.stamina / SWIM_STAMINA);
      this.vignette(ctx, W, H, [0, 0, 0], 0.75 * tired, false);
      this.vignette(ctx, W, H, [235, 215, 40], poison > 0 ? 0.25 + 0.75 * poison : 0, true, poison);
      this.vignette(ctx, W, H, [3, 8, 24], wetK > 0 ? 0.3 + 0.7 * wetK : 0, true, wetK);
      this.vignette(ctx, W, H, [200, 16, 16], 0.75 * hurt, false, hurt);
    }
    // Дыхание под водой — столько же, сколько у человека.
    const wet = this.pst().wet;
    if (p >= 0 && wet > 0 && !sim.extra[p]) {
      const k = Math.max(0, 1 - wet / HUMAN_DROWN_FRAMES);
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(20, 20, 204, 16);
      ctx.fillStyle = k > 0.3 ? '#5ab4ff' : '#ff5a4a';
      ctx.fillRect(22, 22, 200 * k, 12);
    }
    // Выносливость — жёлтая полоса под дыханием: тратится вплавь.
    const stam = this.pst().stamina;
    if (p >= 0 && !sim.extra[p] && stam < SWIM_STAMINA) {
      const k = Math.max(0, stam / SWIM_STAMINA);
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(20, 42, 204, 16);
      ctx.fillStyle = this.pst().exhausted ? '#8a7a3a' : '#ffd23a';
      ctx.fillRect(22, 44, 200 * k, 12);
    }
    // Погиб: от чего (state.death). Пропал с поля без записанной
    // причины — раздавлен в полосе рабочего потока (кровь на месте, см.
    // Sim.crushBody) или стёрт.
    if (p < 0 || sim.extra[p]) {
      let cause = this.pst().death;
      if (!cause && p < 0) {
        let blood = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const x = this.lastX + dx, y = this.lastY + dy;
          if (sim.inBounds(x, y)) blood = Math.max(blood, sim.stain[sim.idx(x, y)]);
        }
        cause = blood > 0 ? 'Раздавлен упавшим телом' : 'Пропал с поля';
      }
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(0, H / 2 - 60, W, 120);
      ctx.font = 'bold 40px system-ui, sans-serif';
      ctx.fillStyle = '#ff7a6a';
      ctx.fillText('Протагонист погиб: ' + (cause || 'неизвестно отчего').toLowerCase(), W / 2, H / 2 - 44);
      ctx.font = '24px system-ui, sans-serif';
      ctx.fillStyle = '#d8c8c4';
      ctx.fillText(this.mp ? (this.mpStatus || 'Ждите') : 'Карта открыта · P — вернуться к сохранению', W / 2, H / 2 + 12);
      ctx.textAlign = 'left';
    }
    if (this.toast && performance.now() < this.toastUntil) {
      ctx.font = 'bold 30px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(255,220,120,0.9)';
      ctx.fillText(this.toast, W - 20, 16);
      ctx.textAlign = 'left';
    }
  }

  // Слой игры лежит ровно поверх канваса поля (тот же размер на экране).
  placeOverlay() {
    const r = this.canvas.getBoundingClientRect(), s = this.stage.getBoundingClientRect();
    const st = this.overlay.style;
    st.left = (r.left - s.left) + 'px';
    st.top = (r.top - s.top) + 'px';
    st.width = r.width + 'px';
    st.height = r.height + 'px';
    // Кнопка сохранения — в левом нижнем углу поля.
    const b = this.saveBtn.style, size = this.saveBtn.offsetHeight || 48;
    b.left = (r.left - s.left + 14) + 'px';
    b.top = (r.bottom - s.top - size - 14) + 'px';
  }
}
