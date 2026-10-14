'use strict';

// Лобби мультиплеера (связь и логика — js/net.js).
//
// Вход: кнопка мультиплеера в панели — "Создать" (эта вкладка — хост,
// у лобби случайный ID) или "Подключиться" (ввести ID). Адрес ?join=ID
// подключает сразу.
//
// Комнатка с игроками — тот же редактор, что и карта (просьба
// пользователя: "по механикам идентична комнате самой игры"): своё поле
// (mp.lobbySim, MP_LOBBY_SCALE от карты) на месте основного, та же палитра,
// кисть с обводкой, линии, заливка, копирование и вставка, лупа — свой
// InputController на поле комнатки. Только паузы нет. Протагонисты игроков
// их цветов ходят там (A/D, W или пробел), над ними имена. У подключившейся
// вкладки действия кисти уходят хосту (net.js, MP_OPS).
//
// Слева от поля — колонка лобби: ID, у хоста большая кнопка "НАЧАТЬ",
// квадратики игроков по 4 в ряд, превью будущей карты (у хоста щелчок —
// в редактор карты), у хоста переключатели "Возрождение", "Игроки видят
// карту", "Рандомный спавн". Щелчок по своему квадратику — имя, цвет,
// насыщенность, яркость: наглядные полосы (радуга, от серого к цвету, от
// тёмного к светлому), которые тянутся мышью; хост, щёлкнув по любому, ещё
// и настраивает ему возрождение и роль (игрок или автор: автор по P выходит
// из протагониста в редактор, а игра идёт дальше).
//
// Начатая игра идёт на карте (sim): у каждой вкладки — экран игры за своего
// протагониста (js/play.js, playerId = свой номер). Хосту поверх игры —
// кнопка "Закончить игру" (назад в лобби).

// Точки спавна и респавна в редакторе карты хоста (палитра "Технологии").
const TOOL_RESPAWN = 'tool:respawn';
const TOOL_SPAWN_PREFIX = 'tool:spawn:';
// Сообщение в журнале чата видно столько мс (пока чат закрыт).
const CHAT_FADE_MS = 15000;

class Lobby {
  // opts: mp, sim, renderer, input, playMode, inspectPanel, stage, mainCanvas,
  //       getSelected(), fitCanvas(), rebuildPalette(), onShow()
  constructor(opts) {
    Object.assign(this, opts);
    this.visible = false;
    this.editing = false;
    this.authorEditing = false;
    this.roomCanvas = null;
    this.roomRenderer = null;
    this.roomInput = null;
    // Колонка лобби слева от поля.
    this.side = document.createElement('div');
    this.side.id = 'lobbySide';
    document.getElementById('app').insertBefore(this.side, this.stage);
    // Окно игрока (цвет, роль), меню мультиплеера, сообщения, кнопки поверх игры.
    this.pop = document.createElement('div');
    this.pop.className = 'lb-pop';
    document.body.appendChild(this.pop);
    this.menu = document.createElement('div');
    this.menu.className = 'lb-menu';
    document.body.appendChild(this.menu);
    this.msg = document.createElement('div');
    this.msg.id = 'lobbyMsg';
    document.body.appendChild(this.msg);
    this.bar = document.createElement('div');
    this.bar.id = 'mpBar';
    document.body.appendChild(this.bar);
    this.binding = {
      inputObj: null,
      canExit: () => {
        const me = this.mp.myPlayer();
        if (me && me.role === 'author') { this.authorEditing = true; return true; }
        return false;
      },
      canEnter: () => {
        if (this.mp.phase !== 'game') return false;
        this.authorEditing = false;
        return true;
      },
      // Для экрана игры (js/play.js): выбыл ли насовсем, сколько жизней,
      // часы игры для таймера (кадр начала и выбывания), включён ли таймер.
      isOut: () => !!this.mp.out && this.mp.out[this.mp.me] !== undefined,
      livesLeft: () => this.mp.livesLeft(this.mp.me),
      gameClock: () => ({ start: this.mp.state ? this.mp.state.startFrame : undefined, out: this.mp.out ? this.mp.out[this.mp.me] : undefined }),
      timerOn: () => this.timerOn,
      openChat: () => this.openChat(),
      sayOf: (k) => this.mp.sayOf(k),
    };
    // Чат (T): журнал и поле ввода поверх всего (просьба пользователя).
    this.chat = document.createElement('div');
    this.chat.id = 'mpChat';
    this.chat.innerHTML = '<div class="ch-log"></div><input type="text" class="ch-in" maxlength="160" spellcheck="false" placeholder="Сообщение… (Enter — отправить, Esc — закрыть)">';
    document.body.appendChild(this.chat);
    this.chatIn = this.chat.querySelector('.ch-in');
    this.chatIn.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { this.mp.say(this.chatIn.value); this.closeChat(); }
      else if (e.key === 'Escape') this.closeChat();
    });
    this.chatIn.addEventListener('blur', () => this.closeChat());
    // Таймер — настройка вкладки, не лобби (просьба пользователя: "у
    // каждого своя"): помнится в браузере.
    this.timerOn = false;
    try { this.timerOn = localStorage.getItem('pix-timer') === '1'; } catch (e) { /* без хранилища — выключен */ }
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    document.addEventListener('mousedown', (e) => {
      if (this.pop.classList.contains('visible') && !this.pop.contains(e.target) && !e.target.closest('.lb-sq')) this.pop.classList.remove('visible');
      if (this.menu.classList.contains('visible') && !this.menu.contains(e.target) && !e.target.closest('#btnLobby')) this.menu.classList.remove('visible');
    });
  }

  get isHost() { return this.mp.role === 'host'; }

  // ---- меню мультиплеера ----

  // Кнопка мультиплеера: вне лобби — "Создать" и "Подключиться", у хоста в
  // редакторе карты — назад в лобби.
  openMenu(anchor) {
    if (this.mp.role === 'host' && this.mp.phase === 'lobby') { this.backToLobby(); return; }
    if (this.mp.role) return;
    this.menu.innerHTML = `<div class="lb-menu-title">Мультиплеер</div>
      <button type="button" class="lb-menu-btn" data-a="create">Создать лобби</button>
      <div class="lb-menu-join"><input type="text" class="lb-id-input" maxlength="${MP_ID_LEN}" placeholder="ID лобби" spellcheck="false">
      <button type="button" class="lb-menu-btn" data-a="join">Подключиться</button></div>
      <div class="lb-menu-hint">Лобби работает между вкладками одного браузера: создайте его в одной вкладке, а в другой введите его ID.</div>`;
    const r = anchor.getBoundingClientRect();
    this.menu.style.top = (r.bottom + 6) + 'px';
    this.menu.style.left = Math.max(8, Math.min(window.innerWidth - 300, r.right - 280)) + 'px';
    this.menu.classList.add('visible');
    const idIn = this.menu.querySelector('.lb-id-input');
    this.menu.querySelector('[data-a=create]').addEventListener('click', () => { this.menu.classList.remove('visible'); this.startHost(); });
    const join = () => {
      const id = idIn.value.trim().toUpperCase();
      if (id.length !== MP_ID_LEN) { idIn.classList.add('bad'); idIn.focus(); return; }
      this.menu.classList.remove('visible');
      this.startClient(id);
    };
    this.menu.querySelector('[data-a=join]').addEventListener('click', join);
    idIn.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.code === 'Enter') join(); });
    idIn.focus();
  }

  // ---- вход ----

  startHost() {
    this.mp.ui = this;
    this.mp.host();
    this.buildSide();
    this.ensureRoom();
    this.show();
  }

  startClient(id) {
    this.mp.ui = this;
    this.mp.join(id);
    this.binding.inputObj = this.mp.gameInput;
    this.input.maxUndoSteps = 0;   // отмена откатила бы только свою копию мира
    document.body.classList.add('mp-client');
    this.buildSide();
    this.show();
    this.waitTimer = setTimeout(() => { if (!this.mp.me) this.message(`Лобби ${this.mp.id} не найдено. Проверьте ID: хост должен держать вкладку с лобби открытой.`); }, 4000);
  }

  // Поле комнатки: свой канвас на месте основного, свой рендер и ввод.
  ensureRoom() {
    const s = this.mp.lobbySim;
    if (!s || (this.roomRenderer && this.roomRenderer.sim === s)) return;
    const zoom = Math.max(1, Math.floor(this.mainCanvas.width / s.w));
    this.roomCanvas = document.createElement('canvas');
    this.roomCanvas.id = 'lobbyView';
    this.roomCanvas.width = s.w * zoom;
    this.roomCanvas.height = s.h * zoom;
    this.stage.appendChild(this.roomCanvas);
    this.roomRenderer = new Renderer(s, this.roomCanvas, zoom, { gpu: true });
    this.roomInput = new InputController(s, this.roomRenderer, this.roomCanvas, this.getSelected);
    this.roomInput.onInspect = (gx, gy) => this.inspectPanel.show(gx, gy);
    if (!this.isHost) this.roomInput.maxUndoSteps = 0;
    this.roomInput.enabled = this.visible;
    s.lookColor = (i) => this.roomRenderer.litColor(i, this.roomRenderer.cellColor(i));
    this.fitCanvas();
  }

  // Экран лобби: колонка слева и поле комнатки вместо карты.
  show() {
    this.visible = true;
    document.body.classList.add('in-lobby');
    this.input.enabled = false;
    // Поле карты скрывается — мышь больше не над ним (ухода мыши браузер не
    // пришлёт, см. onMouseMove в input.js).
    this.input.inCanvas = false;
    this.input.drag = null;
    if (this.roomInput) this.roomInput.enabled = true;
    if (this.mp.lobbySim) this.inspectPanel.sim = this.mp.lobbySim;
    this.inspectPanel.hide();
    if (this.onShow) this.onShow();
    this.fitCanvas();
  }

  hide() {
    this.visible = false;
    document.body.classList.remove('in-lobby');
    this.input.enabled = !this.playMode.active;
    if (this.roomInput) { this.roomInput.enabled = false; this.roomInput.inCanvas = false; this.roomInput.drag = null; }
    this.inspectPanel.sim = this.sim;
    this.inspectPanel.hide();
    this.pop.classList.remove('visible');
    this.fitCanvas();
  }

  // ---- колонка лобби ----

  buildSide() {
    const host = this.isHost;
    const preview = `<div class="lb-preview" title="${host ? 'Редактировать или загрузить карту' : 'Будущая карта'}"><canvas class="lb-preview-canvas"></canvas><span class="lb-preview-label">(карта)</span></div>`;
    this.side.innerHTML = `<div class="lb-id">Лобби <b>${this.mp.id}</b> <button type="button" class="lb-copy" title="Скопировать ID">копировать</button></div>`
      + (host ? '<button type="button" class="lb-start">НАЧАТЬ</button>' : '<div class="lb-wait">Подключаемся…</div>')
      + '<div class="lb-players"></div>'
      + preview
      + (host ? `<div class="lb-toggles">${this.toggleHTML('mapVisible', 'Игроки видят карту')}${this.toggleHTML('randomSpawn', 'Рандомный спавн')}${this.toggleHTML('friendlyFire', 'Огонь по своим')}<div class="lb-toggle-row"><span>Жизни (0 — без счёта)</span><input type="text" inputmode="numeric" class="lb-num lb-lives" maxlength="2" value="0"></div><div class="lb-toggle-row"><span>Скорость копания (10 — обычная)</span><input type="text" inputmode="numeric" class="lb-num lb-dig" maxlength="3" value="10"></div></div>` : '')
      // Таймер — у каждого свой (и у хоста, и у подключившихся).
      + `<div class="lb-toggles"><div class="lb-toggle-row"><span>Таймер в игре</span><button type="button" class="lb-toggle lb-timer${this.timerOn ? ' on' : ''}"><i></i></button></div></div>`
      + '<div class="lb-hint">Протагонист: A/D — ходить, W или пробел — прыжок. Кисть, линии, заливка, копирование и лупа — как в редакторе.</div>'
      + '<button type="button" class="lb-statbtn">Статистика</button>'
      + `<button type="button" class="lb-leave">${host ? 'Закрыть лобби' : 'Выйти'}</button>`;
    this.side.querySelector('.lb-copy').addEventListener('click', () => {
      try { navigator.clipboard.writeText(this.mp.id); } catch (e) { /* без буфера обмена — ID и так виден */ }
    });
    if (host) {
      this.side.querySelector('.lb-start').addEventListener('click', () => this.mp.startGame());
      this.side.querySelector('.lb-preview').addEventListener('click', () => this.editMap());
      for (const t of this.side.querySelectorAll('.lb-toggle[data-key]')) {
        t.addEventListener('click', () => this.mp.setSetting(t.dataset.key, !this.mp.state.settings[t.dataset.key]));
      }
      // Числа — полем без стрелок (просьба пользователя: ими никто не пользуется).
      const num = (cls, key, max) => {
        const el = this.side.querySelector(cls);
        el.addEventListener('keydown', (e) => e.stopPropagation());
        el.addEventListener('change', () => this.mp.setSetting(key, Math.max(0, Math.min(max, parseInt(el.value, 10) || 0))));
      };
      num('.lb-lives', 'lives', 99);
      num('.lb-dig', 'digSpeed', 100);
    }
    const timer = this.side.querySelector('.lb-timer');
    timer.addEventListener('click', () => {
      this.timerOn = !this.timerOn;
      timer.classList.toggle('on', this.timerOn);
      try { localStorage.setItem('pix-timer', this.timerOn ? '1' : '0'); } catch (e) { /* не запомнится — не беда */ }
    });
    this.side.querySelector('.lb-leave').addEventListener('click', () => this.leave());
    const statBtn = this.side.querySelector('.lb-statbtn');
    statBtn.addEventListener('click', () => this.openStats(statBtn));
    this.previewCanvas = this.side.querySelector('.lb-preview-canvas');
    if (this.mp.state) this.onState(this.mp.state);
  }

  toggleHTML(key, label) {
    return `<div class="lb-toggle-row"><span>${label}</span><button type="button" class="lb-toggle" data-key="${key}"><i></i></button></div>`;
  }

  esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // ---- состояние ----

  onState(st) {
    if (this.waitTimer && this.mp.me) { clearTimeout(this.waitTimer); this.waitTimer = null; }
    this.ensureRoom();
    if (this.visible && this.mp.lobbySim) this.inspectPanel.sim = this.mp.lobbySim;
    const wait = this.side.querySelector('.lb-wait');
    if (wait) wait.style.display = this.mp.me ? 'none' : '';
    const box = this.side.querySelector('.lb-players');
    if (box) {
      box.innerHTML = '';
      for (const p of st.players) {
        const sq = document.createElement('div');
        sq.className = 'lb-sq' + (p.n === this.mp.me ? ' me' : '');
        sq.style.background = `rgb(${p.rgb[0]},${p.rgb[1]},${p.rgb[2]})`;
        sq.innerHTML = `<span style="color:${p.l > 55 ? '#111' : '#fff'}">${this.esc(p.name || 'P' + p.n)}</span>`
          + (p.role === 'author' ? '<em title="Автор">А</em>' : '')
          + (!p.respawn ? '<em class="norespawn" title="Не возрождается">✕</em>' : '');
        sq.addEventListener('click', (e) => this.openPlayer(p.n, e));
        box.appendChild(sq);
      }
    }
    for (const t of this.side.querySelectorAll('.lb-toggle[data-key]')) t.classList.toggle('on', !!st.settings[t.dataset.key]);
    const livesIn = this.side.querySelector('.lb-lives');
    if (livesIn && document.activeElement !== livesIn) livesIn.value = st.settings.lives | 0;
    const digIn = this.side.querySelector('.lb-dig');
    if (digIn && document.activeElement !== digIn) digIn.value = st.settings.digSpeed;
    // Случайный спавн — точки спавна ни к чему, и на карте их не видно.
    this.renderer.hideSpawnMarks = !!st.settings.randomSpawn;
    const pv = this.side.querySelector('.lb-preview');
    if (pv && !this.isHost) pv.style.display = st.settings.mapVisible ? '' : 'none';
    this.playMode.names = this.mp.names;
    this.renderer.markNames = this.mp.names;
    if (this.roomRenderer) this.roomRenderer.markNames = this.mp.names;
    if (this.rebuildPalette) this.rebuildPalette();
    // Открытое окно: своё не пересобирается (иначе ползунок под мышью
    // пропадал на каждом шаге), у хоста обновляется часть с настройками.
    if (this.pop.classList.contains('visible') && this.popFor) this.refreshPlayerPop();
  }

  // ---- окно игрока ----

  openPlayer(n, e) {
    const mine = n === this.mp.me;
    if (!mine && !this.isHost) return;
    const p = this.mp.player(n);
    if (!p) return;
    this.popFor = n;
    this.popColor = { h: p.h, s: p.s, l: p.l };
    let html = `<div class="lb-pop-head"><span class="lb-pop-sw"></span><span class="lb-pop-title">${this.esc(p.name || 'P' + n)}</span></div>`;
    if (mine) {
      html += `<label class="lb-field">Имя<input type="text" class="lb-name" maxlength="16" value="${this.esc(p.name || '')}" spellcheck="false"></label>`
        + '<div class="lb-field">Цвет<div class="lb-slider" data-k="h"><i></i></div></div>'
        + '<div class="lb-field">Насыщенность<div class="lb-slider" data-k="s"><i></i></div></div>'
        + '<div class="lb-field">Яркость<div class="lb-slider" data-k="l"><i></i></div></div>';
    }
    if (this.isHost) html += '<div class="lb-pop-host"></div>';
    this.pop.innerHTML = html;
    this.pop.classList.remove('wide');
    if (mine) {
      const name = this.pop.querySelector('.lb-name');
      name.addEventListener('keydown', (ev) => ev.stopPropagation());
      name.addEventListener('change', () => this.mp.setMe({ name: name.value.trim() || ('P' + n) }));
      for (const sl of this.pop.querySelectorAll('.lb-slider')) this.bindSlider(sl);
    }
    this.refreshPlayerPop();
    const r = e.currentTarget.getBoundingClientRect();
    // Сначала показать, потом мерить: в низком окне окно игрока не должно
    // уходить верхом за край (заголовок с цветом пропадал).
    this.pop.classList.add('visible');
    const pw = this.pop.offsetWidth, ph = this.pop.offsetHeight;
    this.pop.style.left = Math.max(8, Math.min(window.innerWidth - pw - 8, r.left)) + 'px';
    this.pop.style.top = Math.max(8, Math.min(window.innerHeight - ph - 8, r.bottom + 8)) + 'px';
  }

  // Пределы ползунков: цвет 0..359, насыщенность 0..100, яркость 10..90.
  sliderRange(k) { return k === 'h' ? [0, 359] : k === 's' ? [0, 100] : [10, 90]; }

  // Ползунок тянется мышью: нажал на полосе — значение под курсором, и
  // дальше следует за ним, пока кнопка зажата (pointer capture).
  bindSlider(sl) {
    const k = sl.dataset.k;
    const set = (ev) => {
      const r = sl.getBoundingClientRect(), [a, b] = this.sliderRange(k);
      const t = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      this.popColor[k] = Math.round(a + (b - a) * t);
      this.paintSliders();
      this.mp.setMe({ h: this.popColor.h, s: this.popColor.s, l: this.popColor.l });
    };
    sl.addEventListener('pointerdown', (ev) => { sl.setPointerCapture(ev.pointerId); set(ev); ev.preventDefault(); });
    sl.addEventListener('pointermove', (ev) => { if (sl.hasPointerCapture(ev.pointerId)) set(ev); });
  }

  // Полосы показывают, что меняют: цвет — радуга, насыщенность — от
  // серого к цвету, яркость — от тёмного через цвет к светлому.
  paintSliders() {
    const { h, s, l } = this.popColor;
    const grad = {
      h: `linear-gradient(to right, ${[0, 60, 120, 180, 240, 300, 360].map((x) => `hsl(${x},${s}%,${l}%)`).join(',')})`,
      s: `linear-gradient(to right, hsl(${h},0%,${l}%), hsl(${h},100%,${l}%))`,
      l: `linear-gradient(to right, hsl(${h},${s}%,10%), hsl(${h},${s}%,50%), hsl(${h},${s}%,90%))`,
    };
    for (const sl of this.pop.querySelectorAll('.lb-slider')) {
      const k = sl.dataset.k, [a, b] = this.sliderRange(k);
      sl.style.background = grad[k];
      sl.querySelector('i').style.left = ((this.popColor[k] - a) / (b - a) * 100) + '%';
    }
    const sw = this.pop.querySelector('.lb-pop-sw');
    if (sw) sw.style.background = `hsl(${h},${s}%,${l}%)`;
  }

  // Обновить окно по состоянию лобби: свой цвет — из popColor (его
  // меняет ползунок), чужой — из состояния; у хоста — возрождение и роль.
  refreshPlayerPop() {
    const n = this.popFor, p = this.mp.player(n);
    if (!p) { this.pop.classList.remove('visible'); return; }
    if (n !== this.mp.me) this.popColor = { h: p.h, s: p.s, l: p.l };
    this.paintSliders();
    const hostBox = this.pop.querySelector('.lb-pop-host');
    if (!hostBox) return;
    hostBox.innerHTML = `<div class="lb-pop-row"><span>Возрождается</span><button type="button" class="lb-toggle lb-p-respawn${p.respawn ? ' on' : ''}"><i></i></button></div>`
      + `<div class="lb-pop-row"><span>Роль</span><span class="lb-roles">`
      + `<button type="button" class="lb-role${p.role === 'player' ? ' on' : ''}" data-role="player" title="Привязан к своему протагонисту">Игрок</button>`
      + `<button type="button" class="lb-role${p.role === 'author' ? ' on' : ''}" data-role="author" title="Может по P выйти в редактор карты, игра идёт дальше">Автор</button>`
      + '</span></div>';
    hostBox.querySelector('.lb-p-respawn').addEventListener('click', () => this.mp.setPlayerProp(n, 'respawn', !p.respawn));
    for (const b of hostBox.querySelectorAll('.lb-role')) b.addEventListener('click', () => this.mp.setPlayerProp(n, 'role', b.dataset.role));
  }

  // ---- протагонист в комнатке ----

  onKey(e, down) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    // T — чат (в лобби и в редакторе; в игре его ловит js/play.js).
    if (e.code === 'KeyT' && this.mp.role && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (down && !e.repeat) this.openChat();
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (!this.visible || !this.mp.lobbySim || !this.mp.me) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;   // Ctrl+C/V/Z — редактору комнатки
    const inp = this.isHost ? this.mp.lobbySim.playerSlot(this.mp.me).input : this.mp.lobbyInput;
    let used = true;
    switch (e.code) {
      case 'KeyA': case 'ArrowLeft': inp.left = down; break;
      case 'KeyD': case 'ArrowRight': inp.right = down; break;
      case 'KeyW': case 'ArrowUp': case 'Space': inp.up = down; if (down && !e.repeat) inp.jump = true; break;
      case 'KeyS': case 'ArrowDown': inp.down = down; break;
      default: used = false;
    }
    if (used) { e.preventDefault(); e.stopImmediatePropagation(); }
  }

  // ---- превью карты ----

  mapPreviewData() { return this.previewImage || null; }

  drawHostPreview() {
    const cv = this.previewCanvas, sim = this.sim;
    if (!cv) return;
    const w = 192, h = Math.round(192 * sim.h / sim.w);
    if (cv.width !== w) { cv.width = w; cv.height = h; }
    this.renderer.drawFrame();
    const cx = cv.getContext('2d');
    cx.imageSmoothingEnabled = true;
    cx.drawImage(this.renderer.frameSource, 0, 0, sim.w, sim.h, 0, 0, w, h);
    this.previewImage = cx.getImageData(0, 0, w, h);
    this.side.querySelector('.lb-preview-label').style.display = 'none';
  }

  showPreview(m) {
    const cv = this.previewCanvas;
    if (!cv) return;
    if (cv.width !== m.w) { cv.width = m.w; cv.height = m.h; }
    cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(m.data), m.w, m.h), 0, 0);
    this.side.querySelector('.lb-preview-label').style.display = 'none';
  }

  // Хост: в редактор карты (точки спавна и респавна — в "Технологиях").
  editMap() {
    if (typeof pixDiag === 'function') pixDiag('щелчок по превью: в редактор');
    this.editing = true;
    this.hide();
    this.updateBar();
  }

  backToLobby() {
    this.editing = false;
    this.show();
    this.updateBar();
  }

  // Кнопки поверх редактора и игры у хоста.
  updateBar() {
    const host = this.isHost, st = this.mp.state;
    let html = '';
    if (host && st && st.phase === 'lobby' && this.editing) html = '<button type="button" data-a="lobby">← В лобби</button><span>Точки спавна и респавна — в «Технологиях»</span>';
    else if (host && st && st.phase === 'game') html = '<button type="button" data-a="end">Закончить игру</button>';
    if (html === this.barHTML) return;
    this.barHTML = html;
    this.bar.innerHTML = html;
    this.bar.classList.toggle('visible', !!html);
    const b = this.bar.querySelector('button');
    if (b) b.addEventListener('click', () => (b.dataset.a === 'lobby' ? this.backToLobby() : this.mp.endGame()));
  }

  // ---- кадр ----

  // Раз в кадр: переходы между лобби и игрой, экран игры за своего игрока.
  tick() {
    const mp = this.mp, st = mp.state, pm = this.playMode;
    if (!mp.role) return;
    // Журнал чата: старые сообщения гаснут — раз в секунду перерисовать.
    if (this.chat.classList.contains('visible') && performance.now() - (this.chatShown || 0) > 1000) this.renderChat();
    this.updateBar();
    if (!st) return;
    this.ensureRoom();
    if (st.phase === 'game') {
      if (this.visible) this.hide();
      pm.mpStatus = mp.status[mp.me] || '';
      if (!pm.active && !this.authorEditing && (this.isHost || mp.gotWorld.map)) {
        pm.playerId = mp.me;
        pm.mp = this.binding;
        pm.names = mp.names;
        pm.enter();
      }
    } else {
      if (pm.active) pm.exit();
      this.authorEditing = false;
      mp.gotWorld.map = false;
      if (!this.visible && !this.editing) this.show();
    }
  }

  // Поле комнатки (вместо карты), имена над протагонистами, превью у хоста.
  render() {
    const s = this.mp.lobbySim;
    if (s && this.roomRenderer) {
      this.roomInput.tickHold();
      this.roomRenderer.render(this.roomInput.getCursorState());
      const ctx = this.roomRenderer.ctx, names = this.mp.names || [], z = this.roomRenderer.zoom;
      ctx.save();
      ctx.font = `bold ${Math.round(z * 2.2)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      if (!this.nameTags || this.nameTags.sim !== s) { this.nameTags = new NameTags(); this.nameTags.sim = s; }
      this.nameTags.update(s);
      this.nameTags.draw(ctx, s, names, (j) => [(j % s.w + 0.5) * z, ((j / s.w) | 0) * z - z * 0.6, true], (k) => this.mp.sayOf(k));
      ctx.restore();
    }
    if (this.isHost && (!this.previewTick || ++this.previewTick > 60)) { this.previewTick = 1; this.drawHostPreview(); }
  }

  // Ники над игроками и на карте в редакторе (автор вышел из протагониста,
  // хост правит карту; просьба пользователя: "на общей карте в режиме
  // создателя тоже видны ники"). Зовёт игровой цикл после отрисовки поля.
  drawMapNames() {
    const s = this.sim, names = this.mp.names;
    if (!names || !s.players || s.players.length < 2) return;
    const ctx = this.renderer.ctx, z = this.renderer.zoom;
    if (!this.mapTags) this.mapTags = new NameTags();
    ctx.save();
    ctx.font = `bold ${Math.round(z * 3.2)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    this.mapTags.update(s);
    this.mapTags.draw(ctx, s, names, (j) => [(j % s.w + 0.5) * z, ((j / s.w) | 0) * z - z * 0.6, true], (k) => this.mp.sayOf(k));
    ctx.restore();
  }

  // ---- чат ----

  openChat() {
    if (!this.mp.role) return;
    this.chat.classList.add('open');
    this.chatIn.value = '';
    this.chatIn.focus();
    this.renderChat();
  }

  closeChat() {
    this.chat.classList.remove('open');
    if (document.activeElement === this.chatIn) this.chatIn.blur();
    this.renderChat();
  }

  onChat() { this.renderChat(); }

  // Журнал: последние сообщения; старые (CHAT_FADE_MS) гаснут, пока чат
  // закрыт. Имя — цветом игрока, сообщения игры — серым курсивом.
  renderChat() {
    const log = this.chat.querySelector('.ch-log'), now = performance.now(), open = this.chat.classList.contains('open');
    const players = (this.mp.state && this.mp.state.players) || [];
    const rows = this.mp.chatLog.slice(open ? -14 : -6).filter((m) => open || now - m.at < CHAT_FADE_MS);
    log.innerHTML = rows.map((m) => {
      if (!m.n) return `<div class="ch-sys${m.kind === 'death' ? ' ch-death' : ''}">${this.esc(m.text)}</div>`;
      const p = players.find((q) => q.n === m.n);
      const c = p && p.rgb ? `rgb(${p.rgb[0]},${p.rgb[1]},${p.rgb[2]})` : '#ccc';
      return `<div><b style="color:${c}">${this.esc(p ? p.name || 'P' + p.n : 'P' + m.n)}:</b> ${this.esc(m.text)}</div>`;
    }).join('');
    this.chat.classList.toggle('visible', !!this.mp.role && (open || rows.length > 0));
    this.chatShown = now;
  }

  // ---- статистика прошлого раунда ----

  openStats(anchor) {
    const rows = (this.mp.state && this.mp.state.lastStats) || null;
    let html = '<div class="lb-pop-head"><span class="lb-pop-title">Статистика прошлого раунда</span></div>';
    if (!rows || !rows.length) html += '<div class="lb-hint">Ещё не сыграно ни одного раунда.</div>';
    else {
      const clock = (s) => mpClock(s);
      html += '<table class="lb-stats-t"><tr><th>Игрок</th><th>Смертей</th><th>Прожил</th><th>В воде</th><th>Отравлен</th><th>Сломал пикс.</th></tr>'
        + rows.map((r) => `<tr><td style="color:rgb(${(r.rgb || [220, 220, 220]).join(',')})">${this.esc(r.name)}</td><td>${r.deaths}</td><td>${clock(r.alive)}</td><td>${clock(r.water)}</td><td>${clock(r.tox)}</td><td>${r.broken}</td></tr>`).join('')
        + '</table>';
    }
    this.pop.innerHTML = html;
    this.popFor = null;
    this.pop.classList.add('visible', 'wide');
    const r = anchor.getBoundingClientRect(), pw = this.pop.offsetWidth, ph = this.pop.offsetHeight;
    this.pop.style.left = Math.max(8, Math.min(window.innerWidth - pw - 8, r.left)) + 'px';
    this.pop.style.top = Math.max(8, Math.min(window.innerHeight - ph - 8, r.bottom + 8)) + 'px';
  }

  // ---- выход ----

  leave() {
    if (this.isHost) {
      this.mp.send({ t: 'bye' });
      // Протагонисты игроков с карты убираются, редактор — как был.
      const sim = this.sim;
      for (let i = 0; i < sim.type.length; i++) if (sim.type[i] === EL.PROTAGONIST && sim.life[i] > 0) sim.clearCell(i);
      if (this.playMode.active) this.playMode.exit();
      this.playMode.mp = null; this.playMode.playerId = 0; this.playMode.names = null;
      this.mp.close();
      this.mp.role = null; this.mp.state = null;
      this.editing = false;
      this.hide();
      this.updateBar();
      this.bar.classList.remove('visible');
      if (this.roomCanvas) { this.roomCanvas.remove(); this.roomCanvas = null; this.roomRenderer = null; this.roomInput = null; }
      this.mp.lobbySim = null;
      if (this.rebuildPalette) this.rebuildPalette();
    } else {
      this.mp.send({ t: 'leave', cid: this.mp.cid });
      location.href = location.pathname;
    }
  }

  hostLost() { this.message('Хост закрыл лобби'); }
  kicked() { this.message('Вы больше не в лобби'); }

  message(text) {
    this.msg.innerHTML = `<div>${this.esc(text)}</div><button type="button">В редактор</button>`;
    this.msg.classList.add('visible');
    this.msg.querySelector('button').addEventListener('click', () => { location.href = location.pathname; });
  }
}
