'use strict';

const GRID_W = 576;
const GRID_H = 324;
const ZOOM = 3;

const sim = new Sim(GRID_W, GRID_H);
startSimThreads();
// Рабочие потоки не ответили (упали) — шаг дальше в одном, а причина — в diag.log.
sim.onThreadStall = () => diagError('рабочие потоки не ответили за 2 с, дальше счёт в одном потоке', 'потоки');
let selectedElement = ELEMENT_ORDER[0];
// Мультиплеер (js/net.js, js/lobby.js) — создаются ниже, после экрана игры;
// объявлены здесь, потому что палитра строится раньше и смотрит на них.
let mp = null, lobby = null;

// ---- диагностика зависаний (tools/serve.js пишет её в diag.log) ----
//
// Пользователь трижды сообщал: хост щёлкает превью карты — "поле не
// движется, кнопки не отвечают, вылетает", а здесь это не повторялось. Чтобы
// увидеть, где именно, страница сама сообщает серверу разработки:
// - главный поток отмечает этап кадра (pixDiag) в фоновом рабочем потоке
//   (сторож — тот же, что считает мультиплеер в фоне, см. ниже); если
//   главный молчит дольше DIAG_HANG_MS у видимой вкладки, сторож шлёт
//   "hang" с последним этапом, а когда главный оживёт — "resume" с
//   длительностью;
// - ошибки страницы и рабочих потоков — "error" с текстом и стеком.
// Без tools/serve.js (другой сервер) отчёты просто не доходят. На
// опубликованной странице (GitHub Pages) их и не шлём: принять их там
// некому, а каждый отчёт — лишний запрос к чужому серверу.
const DIAG_HANG_MS = 3000;
const DIAG_ON = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
let diagWorker = null;
const diagSent = new Set();
function diagReport(o) {
  if (!DIAG_ON) return;
  const key = o.kind + ':' + (o.msg || o.phase || '');
  if (o.kind === 'error' && diagSent.has(key)) return;   // одну ошибку каждый кадр — один раз
  diagSent.add(key);
  try {
    navigator.sendBeacon('/__diag', JSON.stringify({ ...o, mp: mp && mp.role, phase: mp && mp.phase, lobby: !!(lobby && lobby.visible), editing: !!(lobby && lobby.editing) }));
  } catch (e) { /* без сервера разработки — молча */ }
}
function pixDiag(phase) {
  if (diagWorker) diagWorker.postMessage({ p: phase, h: document.hidden, r: mp ? mp.role || '' : '' });
}
function diagError(e, where) {
  const msg = String((e && e.message) || e);
  console.error('Пиксириус:', where, e);
  diagReport({ kind: 'error', where, msg, stack: String((e && e.stack) || '').slice(0, 1500) });
  showDiagToast(`Ошибка (${where}): ${msg}`);
}
function showDiagToast(text) {
  let el = document.getElementById('diagToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'diagToast';
    el.style.cssText = 'position:fixed;left:50%;bottom:12px;transform:translateX(-50%);z-index:99;background:#5a1e1e;color:#fff;border:1px solid #c05050;padding:8px 12px;font:13px system-ui,sans-serif;max-width:90vw';
    document.body.appendChild(el);
  }
  el.textContent = text + ' — записано в diag.log';
  clearTimeout(el._t);
  el._t = setTimeout(() => el.remove(), 8000);
}
window.addEventListener('error', (e) => diagError(e.error || e.message, 'страница'));
window.addEventListener('unhandledrejection', (e) => diagError(e.reason, 'обещание'));

// Многопоточная симуляция (sim/threads.js): рабочие потоки считают полосы
// поля вместе с главным над общей памятью. Запускается сразу после
// создания Sim — до рендера и ввода: startThreads заменяет массивы мира
// общими, и все, кто берёт их у sim, должны увидеть уже новые.
//
// Рабочих по умолчанию — ядер минус один. hardwareConcurrency считает
// логические ядра, а у процессоров с гиперпоточностью их вдвое больше
// настоящих; замер на 4 ядрах / 8 потоках: 3 рабочих быстрее 7 — второй
// логический поток ядра почти ничего не добавляет, а ждать в каждой фазе
// приходится самого медленного. ?threads=N — задать число рабочих явно,
// ?threads=0 — один поток.
//
// Общая память есть только на "изолированной" странице (заголовки
// COOP/COEP, их шлёт tools/serve.js). Без неё — тихо один поток.
function startSimThreads() {
  const m = /[?&]threads=(\d+)/.exec(location.search);
  const hc = navigator.hardwareConcurrency || 2;
  const count = m ? Math.min(15, Number(m[1])) : Math.max(1, Math.min(7, Math.floor(hc / 2) - 1));
  if (count <= 0) return;
  if (!self.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined' || !window.PIX_SCRIPTS) {
    console.info('Пиксириус: страница не изолирована (нет COOP/COEP) — симуляция в одном потоке');
    return;
  }
  // Потоку — всё, что грузит страница до рендера: данные и sim/*.js.
  const all = window.PIX_SCRIPTS;
  const scripts = all.slice(0, all.indexOf('js/render.js'))
    .map((f) => new URL(f + '?v=' + window.PIX_V, location.href).href);
  try {
    sim.startThreads(count, (k, init) => {
      const wk = new Worker('js/sim/worker.js?v=' + window.PIX_V);
      wk.onerror = (e) => diagError(e.message || e, `рабочий поток ${k}`);
      wk.postMessage({ scripts, init });
      return wk;
    });
  } catch (e) {
    // Упасть здесь может только создание общей памяти или потоков — тогда
    // мир уже, возможно, в общей памяти, но шаг идёт по-старому: пока все
    // потоки не доложили о готовности, step() считает в одном.
    console.error('Пиксириус: потоки не запустились', e);
  }
}

const canvas = document.getElementById('view');
const stage = document.getElementById('stage');
canvas.width = GRID_W * ZOOM;
canvas.height = GRID_H * ZOOM;

// Полагаться на CSS object-fit для канваса ненадёжно (в некоторых движках
// внутренний буфер не масштабируется как надо, только обрезается) —
// поэтому размер отображения считаем сами и выставляем в px явно.
// Подгоняется и поле комнатки лобби (js/lobby.js), если оно есть.
function fitCanvas() {
  const r = stage.getBoundingClientRect();
  for (const c of [canvas, document.getElementById('lobbyView')]) {
    if (!c) continue;
    const scale = Math.max(0.01, Math.min(r.width / c.width, r.height / c.height));
    c.style.width = Math.floor(c.width * scale) + 'px';
    c.style.height = Math.floor(c.height * scale) + 'px';
  }
}
window.addEventListener('resize', fitCanvas);
fitCanvas();

// ?cpu в адресе — рисовать поле по-старому, на CPU (для сравнения и на
// случай проблем с видеокартой).
const renderer = new Renderer(sim, canvas, ZOOM, { gpu: !/[?&]cpu\b/.test(location.search) });
const input = new InputController(sim, renderer, canvas, () => selectedElement);
// Снимки камер (sim/charges.js) запоминают клетки тем цветом, каким их
// рисует поле.
sim.lookColor = (i) => renderer.litColor(i, renderer.cellColor(i));

// ---- пиксельные SVG-иконки инструментов (только прямоугольники) ----

function pixelSvg(rows, color) {
  const size = rows.length;
  const cell = 100 / size;
  let s = '<svg viewBox="0 0 100 100" preserveAspectRatio="none" shape-rendering="crispEdges">';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      if (rows[y][x] === '1') {
        s += `<rect x="${(x * cell).toFixed(2)}" y="${(y * cell).toFixed(2)}" width="${(cell + 0.6).toFixed(2)}" height="${(cell + 0.6).toFixed(2)}" fill="${color}"/>`;
      }
    }
  }
  s += '</svg>';
  return s;
}

const ICON_COLOR = '#d8d8de';
const ICONS = {
  pause: ['01010', '01010', '01010', '01010', '01010'],
  play:  ['10000', '11000', '11100', '11000', '10000'],
  clear: ['10001', '01010', '00100', '01010', '10001'],
  save:  ['00100', '00100', '10101', '01110', '11111'],
  load:  ['00100', '01110', '10101', '00100', '11111'],
  lobby: ['0100010', '1110111', '0100010', '0000000', '1110111', '1110111', '1010101'],
};

const btnPause = document.getElementById('btnPause');
const btnClear = document.getElementById('btnClear');
const btnSave = document.getElementById('btnSave');
const btnLoad = document.getElementById('btnLoad');
const fileLoad = document.getElementById('fileLoad');

function refreshPauseIcon() {
  btnPause.innerHTML = pixelSvg(sim.paused ? ICONS.play : ICONS.pause, ICON_COLOR);
  btnPause.classList.toggle('active', sim.paused);
}
refreshPauseIcon();
btnClear.innerHTML = pixelSvg(ICONS.clear, ICON_COLOR);
btnSave.innerHTML = pixelSvg(ICONS.save, ICON_COLOR);
btnLoad.innerHTML = pixelSvg(ICONS.load, ICON_COLOR);

function togglePause() { sim.paused = !sim.paused; refreshPauseIcon(); }
btnPause.addEventListener('click', togglePause);
btnClear.addEventListener('click', () => { sim.clear(); });

window.addEventListener('keydown', (e) => {
  // В лобби паузы нет (пробел — прыжок протагониста, js/lobby.js), на
  // стартовом экране — тоже.
  if (lobby && lobby.visible) return;
  if (document.body.classList.contains('start')) return;
  if (e.code === 'Space' && !e.repeat) {
    e.preventDefault();
    togglePause();
  }
});

btnSave.addEventListener('click', () => {
  const data = JSON.stringify(sim.serialize());
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'world.pixsav';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

btnLoad.addEventListener('click', () => fileLoad.click());
fileLoad.addEventListener('change', () => {
  const file = fileLoad.files && fileLoad.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      sim.deserialize(JSON.parse(reader.result));
    } catch (err) {
      // повреждённый файл — молча игнорируем
    }
  };
  reader.readAsText(file);
  fileLoad.value = '';
});

// ---- палитра элементов ----

const paletteTabs = document.getElementById('paletteTabs');
const palette = document.getElementById('palette');
const statusLabel = document.getElementById('statusLabel');
const materialInfo = document.getElementById('materialInfo');

function rgbCss(c) { return `rgb(${c[0]},${c[1]},${c[2]})`; }

function buildMaterialInfoHTML(id) {
  const el = ELEMENTS[id];
  let rows = '';
  if (isStructural(id)) {
    rows += `<div class="mi-row"><span>Макс. стабильность</span><span>${el.maxStability}</span></div>`;
    rows += `<div class="mi-row"><span>Стойкость</span><span>${el.toughness} кл./-1</span></div>`;
  }
  if (typeof el.density === 'number') {
    rows += `<div class="mi-row"><span>Плотность</span><span>${el.density}</span></div>`;
  }
  if (el.flammable) {
    rows += `<div class="mi-row"><span>Горючесть</span><span>${Math.round(el.burnChance * 100)}%</span></div>`;
  }
  if (el.meltChance) {
    rows += `<div class="mi-row"><span>Плавится в</span><span>${ELEMENTS[el.meltsInto].name}</span></div>`;
  }
  if (!rows) rows = `<div class="mi-row"><span>Особых характеристик нет</span></div>`;
  return `<div class="mi-title">${el.name}</div>${rows}`;
}

function showMaterialInfoHTML(clientX, clientY, html) {
  materialInfo.innerHTML = html;
  materialInfo.classList.add('visible');
  const pad = 12;
  const rect = materialInfo.getBoundingClientRect();
  let left = clientX + pad, top = clientY + pad;
  if (left + rect.width > window.innerWidth) left = clientX - rect.width - pad;
  if (top + rect.height > window.innerHeight) top = clientY - rect.height - pad;
  materialInfo.style.left = Math.max(4, left) + 'px';
  materialInfo.style.top = Math.max(4, top) + 'px';
}

function showMaterialInfo(clientX, clientY, id) {
  showMaterialInfoHTML(clientX, clientY, buildMaterialInfoHTML(id));
}

function hideMaterialInfo() { materialInfo.classList.remove('visible'); }

// Справка лупы — большая панель по центру (inspect.js). Щелчок лупой по
// полю её не закрывает, а показывает следующую клетку.
// В панели доли состава меняются щелчком: на выбранное в палитре вещество
// (ЛКМ) или на воздух (ПКМ) — это шаг отмены, как любое рисование.
// Щелчок по палитре панель не закрывает: там выбирают, на что менять долю.
const inspectPanel = new InspectPanel(sim, (e) => ((e.target === canvas || e.target.id === 'lobbyView') && selectedElement === TOOL_INSPECT) || !!e.target.closest('#palette, #paletteTabs'), {
  getSelected: () => selectedElement,
  beforeEdit: () => (lobby && lobby.visible && lobby.roomInput ? lobby.roomInput : input).pushUndo(),
});
input.onInspect = (gx, gy) => inspectPanel.show(gx, gy);

document.addEventListener('click', hideMaterialInfo);
document.addEventListener('scroll', hideMaterialInfo, true);

// Рисованные значки кнопок палитры (img/palette, 32x32, рисовал
// пользователь). У кого значка нет — кнопка залита цветом элемента. Окисел
// камня — линейка из трёх стадий: кнопка "Окисел" ставит стадию 1,
// "Рыхлый окисел" — последнюю, 3.
const PALETTE_TEXTURE = {
  [EL.WATER]: 'img/palette/water.png',
  [EL.ACID]: 'img/palette/acid.png',
  [EL.OXIDE]: 'img/palette/oxide-1.png',
  [EL.OXIDE_LOOSE]: 'img/palette/oxide-3.png',
  [EL.REAGENT]: 'img/palette/reagent.png',
  [EL.ICE]: 'img/palette/ice.png',
  [EL.ACID_ICE]: 'img/palette/acid-ice.png',
  [EL.REAGENT_ICE]: 'img/palette/reagent-ice.png',
  [EL.DISSOLVER]: 'img/palette/dissolver.png',
  [EL.DISSOLVER_ICE]: 'img/palette/dissolver-ice.png',
  [EL.STEAM]: 'img/palette/steam.png',
  [EL.SMOKE]: 'img/palette/smoke.png',
  [EL.ACID_GAS]: 'img/palette/acid-gas.png',
  [EL.REAGENT_GAS]: 'img/palette/reagent-gas.png',
  [EL.OIL_GAS]: 'img/palette/oil-gas.png',
  [EL.DISSOLVER_GAS]: 'img/palette/dissolver-gas.png',
  [EL.BLACK_SALT]: 'img/palette/black-salt.png',
};

// Кнопки, у которых нет своего элемента: тот же элемент, но кисть ставит
// его в другой стадии окисла (sim.paintOxideStage). Во вкладке "Все" должен
// быть каждый особый пиксель (просьба пользователя), а у окисла камня
// вторая стадия — тот же элемент "Окисел", что и первая. Кнопка встаёт
// сразу за кнопкой своего элемента: "Окисел" (1) → стадия 2 → "Рыхлый
// окисел" (3).
const PALETTE_VARIANTS = {
  [EL.OXIDE]: [{ stage: 2, name: 'Окисел (стадия 2)', texture: 'img/palette/oxide-2.png' }],
};
// Стадия выбранной кнопки: 0 — обычная кнопка элемента.
let selectedStage = 0;

function addPaletteButton(id, variant) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'el-btn';
  const name = variant ? variant.name : ELEMENTS[id].name;
  const stage = variant ? variant.stage : 0;
  const texture = variant ? variant.texture : PALETTE_TEXTURE[id];
  btn.style.background = rgbCss(ELEMENTS[id].color);
  // Цвет под картинкой остаётся: пока она грузится (или если не нашлась),
  // кнопка всё равно своего цвета. Размер — в той же строке: инлайновое
  // background сбрасывает размер и повтор из CSS, и значок ложился плиткой.
  if (texture) {
    btn.style.background = `url("${texture}") center / 100% 100% no-repeat, ${rgbCss(ELEMENTS[id].color)}`;
    btn.classList.add('el-textured');
  }
  btn.title = name;
  if (id === selectedElement && stage === selectedStage) btn.classList.add('selected');
  btn.addEventListener('click', () => {
    selectedElement = id;
    selectedStage = stage;
    sim.paintOxideStage = stage;
    for (const b of palette.children) b.classList.remove('selected');
    btn.classList.add('selected');
    statusLabel.textContent = name;
  });
  btn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showMaterialInfo(e.clientX, e.clientY, id);
  });
  btn.addEventListener('mouseleave', hideMaterialInfo);
  palette.appendChild(btn);
  return btn;
}

// "Инструмент" — в отличие от addPaletteButton, ничего не пишет в
// sim.type и не берёт цвет/название из ELEMENTS (там его нет — это не
// материал). При выборе LMB/ПКМ на канвасе делают что-то своё, см.
// InputController.onMouseDown.
function addToolButton(toolValue, name, cssColor, infoHTML) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'el-btn el-tool';
  btn.style.background = cssColor;
  btn.title = name;
  if (toolValue === selectedElement) btn.classList.add('selected');
  btn.addEventListener('click', () => {
    selectedElement = toolValue;
    selectedStage = 0;
    sim.paintOxideStage = 0;
    for (const b of palette.children) b.classList.remove('selected');
    btn.classList.add('selected');
    statusLabel.textContent = name;
  });
  btn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showMaterialInfoHTML(e.clientX, e.clientY, infoHTML);
  });
  btn.addEventListener('mouseleave', hideMaterialInfo);
  palette.appendChild(btn);
  return btn;
}

// Ползунок общей скорости течения времени всей симуляции — падения,
// растекания жидкостей, диффузии тепла и ветра, тика влажности земли и
// т.д. разом (см. loop() ниже: он решает, сколько раз вызвать sim.step()
// на один кадр отрисовки). 100 — обычная скорость (как и sim.timeScale по
// умолчанию в конструкторе), меньше — медленнее, больше — быстрее. Живёт
// во вкладке "Разное", рядом с инструментами давления и температуры, но
// сам не инструмент — не откликается на клики по канвасу, просто правит
// sim.timeScale напрямую.
//
// В подписи рядом с процентом — фактическая скорость, шагов симуляции в
// секунду (measuredStepsPerSec, считает loop). Процент — это шагов на
// кадр отрисовки, и когда машина не успевает посчитать их все, кадров
// становится меньше: 400% дают не вчетверо больше шагов в секунду, а
// сколько вытянет процессор. Раньше этого не было видно, и выглядело так,
// будто ускорение времени не ускоряет, например, коррозию — хотя она, как
// и всё остальное, идёт по шагам и ускоряется ровно во столько, во
// сколько выросло число шагов.
let measuredStepsPerSec = 0;
let refreshTimeScaleLabel = () => {};

function addTimeScaleControl() {
  const wrap = document.createElement('div');
  wrap.className = 'time-scale';
  const label = document.createElement('div');
  label.className = 'time-scale-label';
  const pct = document.createElement('span');
  const rate = document.createElement('span');
  rate.className = 'time-scale-rate';
  rate.title = 'Фактически шагов симуляции в секунду';
  label.append(pct, rate);
  const refreshLabel = () => {
    pct.textContent = `Течение времени: ${sim.timeScale}%`;
    rate.textContent = measuredStepsPerSec ? `${measuredStepsPerSec} шаг/с` : '';
    // Сколько потоков считает мир (sim/threads.js) — чтобы было видно,
    // включилась ли многопоточность.
    const threads = sim.threadsReady() ? sim._threadCount + 1 : 1;
    rate.title = `Фактически шагов симуляции в секунду; потоков: ${threads}`;
    if (measuredStepsPerSec && threads > 1) rate.textContent += ` · потоки: ${threads}`;
  };
  refreshTimeScaleLabel = refreshLabel;
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '10';
  slider.max = '400';
  slider.step = '5';
  slider.value = String(sim.timeScale);
  slider.title = 'Скорость течения времени всей симуляции';
  slider.addEventListener('input', () => {
    sim.timeScale = Number(slider.value);
    refreshLabel();
  });
  refreshLabel();
  wrap.appendChild(label);
  wrap.appendChild(slider);
  palette.appendChild(wrap);
}

// Категории — чисто UI-группировка палитры (не связана с CAT/симуляцией
// напрямую, кроме как через материал -> cat). "Разное" — инструменты, а
// не материалы: давление воздуха и температура (оба по принципу ЛКМ
// добавляет/ПКМ убавляет) и лупа, которая мир не трогает. "Технологии"
// пока пуста — пользователь наполнит её позже, отдельно от "Разное".
const CATEGORIES = [
  // "Все" вместо прежней вкладки "Газ": газов стало достаточно, чтобы они
  // жили среди прочих веществ, а отдельная вкладка со всем сразу нужнее —
  // в ней видно и окислы, и газы, которые по своей категории иначе
  // пришлось бы искать по разным вкладкам.
  { key: 'all', label: 'Все' },
  { key: 'solid', label: 'Тела' },
  { key: 'powder', label: 'Сыпучее' },
  { key: 'liquid', label: 'Жидкости' },
  { key: 'tech', label: 'Технологии' },
  { key: 'misc', label: 'Разное' },
];

function materialCategoryKey(id) {
  // Технологии — не про физическую категорию (у балки та же CAT.SOLID, что
  // и у камня), а про смысл: место среди построек/механизмов, а не сырых
  // материалов, поэтому проверяется до общего сопоставления по cat.
  if (TECH_ELEMENTS.has(id)) return 'tech';
  // Окислы не показываются среди «Тел» и «Сыпучего»: это не сырьё, с
  // которого начинают стройку, а то, во что материалы превращаются сами.
  // Место им во вкладке «Все», где они и видны все разом.
  if (isOxide(id)) return 'all';
  // Расплавленная медь — продукт плавления, не сырьё.
  if (id === EL.MOLTEN_COPPER || id === EL.MOLTEN_METAL || id === EL.MOLTEN_STEEL) return 'all';
  // Льды — замёрзшие жидкости, а не строительный материал: во вкладке
  // "Тела" их нет (просьба пользователя), только во "Всех".
  if (id === EL.ICE || id === EL.ACID_ICE || id === EL.REAGENT_ICE || id === EL.DISSOLVER_ICE) return 'all';
  const cat = ELEMENTS[id].cat;
  if (cat === CAT.GAS) return 'gas';
  if (cat === CAT.LIQUID) return 'liquid';
  if (cat === CAT.POWDER) return 'powder';
  return 'solid';
}

let activeCategory = materialCategoryKey(selectedElement);

function buildPaletteTabs() {
  paletteTabs.innerHTML = '';
  for (const c of CATEGORIES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cat-tab' + (c.key === activeCategory ? ' active' : '');
    btn.textContent = c.label;
    btn.addEventListener('click', () => {
      if (activeCategory === c.key) return;
      activeCategory = c.key;
      buildPaletteTabs();
      buildPaletteGrid();
    });
    paletteTabs.appendChild(btn);
  }
}

function buildPaletteGrid() {
  palette.innerHTML = '';
  if (activeCategory === 'misc') {
    addToolButton(TOOL_PRESSURE, 'Давление', '#e0a030',
      '<div class="mi-title">Давление</div>'
      + '<div class="mi-row"><span>ЛКМ</span><span>усилить поток</span></div>'
      + '<div class="mi-row"><span>ПКМ</span><span>погасить поток</span></div>');
    addToolButton(TOOL_TEMP, 'Температура', '#e03030',
      '<div class="mi-title">Температура</div>'
      + '<div class="mi-row"><span>ЛКМ</span><span>нагреть</span></div>'
      + '<div class="mi-row"><span>ПКМ</span><span>охладить</span></div>');
    addToolButton(TOOL_INSPECT, 'Лупа', '#4a90c8',
      '<div class="mi-title">Лупа</div>'
      + '<div class="mi-row"><span>Щелчок</span><span>справка о клетке</span></div>'
      + '<div class="mi-row"><span>Раствор, газ</span><span>состав по долям</span></div>'
      + '<div class="mi-row"><span>Esc, щелчок мимо</span><span>закрыть</span></div>');
    addTimeScaleControl();
  } else {
    // Хост лобби в редакторе карты: точки спавна игроков и точка респавна
    // (sim/spawns.js) — в "Технологиях", первыми.
    if (activeCategory === 'tech' && mp && mp.role === 'host' && mp.state) {
      addToolButton(TOOL_RESPAWN, 'Точка респавна', '#5aff82',
        '<div class="mi-title">Точка респавна</div>'
        + '<div class="mi-row"><span>ЛКМ</span><span>поставить</span></div>'
        + '<div class="mi-row"><span>ПКМ</span><span>убрать</span></div>'
        + '<div class="mi-row"><span>Лупа</span><span>кого и при какой смерти возрождает</span></div>');
      for (const p of mp.state.players) {
        addToolButton(TOOL_SPAWN_PREFIX + p.n, 'Спавн: ' + (p.name || 'P' + p.n), `rgb(${p.rgb[0]},${p.rgb[1]},${p.rgb[2]})`,
          `<div class="mi-title">Точка спавна: ${p.name || 'P' + p.n}</div><div class="mi-row"><span>ЛКМ</span><span>поставить (одна на игрока)</span></div><div class="mi-row"><span>ПКМ</span><span>убрать</span></div>`);
      }
    }
    // Инструмент "Электрический разряд" — в "Технологиях", первым.
    if (activeCategory === 'tech') {
      addToolButton(TOOL_ZAP, 'Электрический разряд', '#ffe83c',
        '<div class="mi-title">Электрический разряд</div>'
        + `<div class="mi-row"><span>Щелчок</span><span>жёлтый заряд со сроком ${ZAP_LIFE}</span></div>`
        + '<div class="mi-row"><span>Куда</span><span>в проводник под курсором или ближайший в пределах кисти</span></div>');
    }
    for (const id of ELEMENT_ORDER) {
      if (activeCategory === 'all' || materialCategoryKey(id) === activeCategory) {
        addPaletteButton(id);
        if (activeCategory === 'all' && PALETTE_VARIANTS[id]) for (const v of PALETTE_VARIANTS[id]) addPaletteButton(id, v);
      }
    }
  }
}

buildPaletteTabs();
buildPaletteGrid();
statusLabel.textContent = ELEMENTS[ELEMENT_ORDER[0]].name;

// ---- игра за протагониста (js/play.js) ----

// P — войти в игру и выйти из неё. Пока идёт игра, меню создания спрятано
// (body.playing в style.css), поле вместо обычного рендера рисует
// PlayMode: приближённое окно с протагонистом в центре или карта увиденного.
const playMode = new PlayMode({
  sim, renderer, input, canvas, stage,
  saveIconHTML: pixelSvg(ICONS.save, ICON_COLOR),
  setPaused: (p) => { sim.paused = p; refreshPauseIcon(); },
  onEnter: () => { document.body.classList.add('playing'); hideMaterialInfo(); inspectPanel.hide(); fitCanvas(); },
  onExit: () => { document.body.classList.remove('playing'); fitCanvas(); },
});

// ---- мультиплеер (js/net.js, js/lobby.js) ----

// Кнопка мультиплеера в панели: меню "Создать лобби" / "Подключиться" (по
// ID), у хоста в редакторе карты — назад в лобби. Адрес ?join=ID
// подключает к лобби сразу.
mp = new Multiplayer({ sim, makeLobbySim: (w, h) => new Sim(w, h) });
lobby = new Lobby({
  mp, sim, renderer, input, playMode, inspectPanel, stage, mainCanvas: canvas,
  getSelected: () => selectedElement,
  fitCanvas,
  onShow: () => hideMaterialInfo(),
  rebuildPalette: () => buildPaletteGrid(),
});
{
  const btn = document.createElement('button');
  btn.id = 'btnLobby';
  btn.className = 'tool-btn';
  btn.type = 'button';
  btn.title = 'Мультиплеер: создать лобби или подключиться по ID';
  btn.innerHTML = pixelSvg(ICONS.lobby, ICON_COLOR);
  btn.addEventListener('click', () => lobby.openMenu(btn));
  document.getElementById('tools').appendChild(btn);
}

// ---- стартовый экран ----

// При заходе в игру — две кнопки (просьба пользователя): "Выживание"
// (пока ничего не делает) и "Креатив" — знакомый редактор. Подключение по
// ссылке ?join=ID стартовый экран пропускает.
// Пока Выживания нет, экран выключен: игра сразу открывается Креативом
// (просьба пользователя "стартовое меню пока пропускай"). Вернуть — true.
const START_SCREEN = false;
{
  const joinId = (/[?&]join=([A-Za-z0-9]+)/.exec(location.search) || [])[1];
  if (joinId) lobby.startClient(joinId);
  else if (START_SCREEN) {
    const start = document.createElement('div');
    start.id = 'startScreen';
    start.innerHTML = '<div class="st-title">Пиксириус</div>'
      + '<div class="st-buttons"><button type="button" class="st-btn st-survival">Выживание</button>'
      + '<button type="button" class="st-btn st-creative">Креатив</button></div>'
      + '<div class="st-note"></div>';
    document.body.appendChild(start);
    document.body.classList.add('start');
    start.querySelector('.st-survival').addEventListener('click', () => {
      start.querySelector('.st-note').textContent = 'Выживание — скоро';
    });
    start.querySelector('.st-creative').addEventListener('click', () => {
      start.remove();
      document.body.classList.remove('start');
      fitCanvas();
    });
  }
}

// ---- игровой цикл ----

// Отрисовка (и обработка удержанной кисти) всегда идёт ровно раз на кадр
// requestAnimationFrame — это про плавность картинки, к скорости симуляции
// отношения не имеет. А вот sim.step() вызывается переменное число раз за
// тот же кадр — накопитель получает sim.timeScale/100 "шагов" на каждый
// реальный кадр отрисовки и тратит их по целому за раз, перенося остаток
// на следующий кадр. При timeScale=100 это ровно 1 шаг на кадр (как было
// раньше, без изменений в поведении по умолчанию); при 200 — в среднем 2
// шага на кадр (вдвое быстрее весь мир: падение, растекание жидкостей,
// диффузия тепла/ветра, тик влажности земли и т.д. разом, одним общим
// рычагом, а не отдельной подстройкой каждой механики); при 50 — шаг
// происходит в среднем раз в два кадра (вдвое медленнее).
let stepAccumulator = 0;
// Замер фактической скорости (см. addTimeScaleControl): шаги за окно
// в полсекунды.
let rateSteps = 0, rateSince = performance.now();

// Расчёт одного кадра без отрисовки: шаги мира, мультиплеер, лобби.
function simFrame() {
  pixDiag('шаг карты');
  // Подключившаяся вкладка мир не считает (его досылает хост), а хост на
  // экране лобби не крутит карту — идёт только комнатка (mp.hostTick).
  const client = mp.role === 'client';
  const hostInLobby = mp.role === 'host' && lobby.visible;
  if (!client && !hostInLobby) {
    stepAccumulator += sim.timeScale / 100;
    while (stepAccumulator >= 1) {
      if (!sim.paused) rateSteps++;
      // Хост мультиплеера шагает карту через mp: шаг по сиду и тик вкладкам (net.js).
      if (mp.role === 'host') mp.hostStep('map');
      else sim.step();
      stepAccumulator -= 1;
    }
  }
  pixDiag('мультиплеер: комнатка и тики');
  if (mp.role === 'host') mp.hostTick();
  else if (client) mp.clientTick();
  pixDiag('лобби: переходы');
  if (mp.role) lobby.tick();
  const now = performance.now();
  if (now - rateSince >= 500) {
    measuredStepsPerSec = Math.round(rateSteps * 1000 / (now - rateSince));
    rateSteps = 0; rateSince = now;
    refreshTimeScaleLabel();
  }
}

let lastFrameAt = performance.now();

// Ошибка в кадре больше не останавливает игру: раньше исключение где угодно
// в цикле обрывало requestAnimationFrame(loop), и поле вставало насовсем.
// Теперь она показывается и пишется в diag.log, а цикл идёт дальше.
function loop() {
  lastFrameAt = performance.now();
  try {
    simFrame();
    if (lobby.visible) { pixDiag('отрисовка комнатки'); lobby.render(); }
    else if (playMode.active) { pixDiag('экран игры'); playMode.frame(); }
    else {
      pixDiag('отрисовка карты');
      input.tickHold();
      renderer.render(input.getCursorState());
      // Ники игроков и на карте редактора (мультиплеер).
      if (mp.role) lobby.drawMapNames();
    }
    pixDiag('ожидание кадра');
  } catch (e) {
    diagError(e, 'игровой цикл');
  }
  // И в конце: долгий кадр — не простой, фоновый счёт за ним не нужен.
  lastFrameAt = performance.now();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// Мультиплеер в фоне (просьба пользователя: хост переключился на другое
// окно — и у всех всё замерло). У скрытой вкладки браузер останавливает
// requestAnimationFrame, а таймеры главного потока тормозит до раза в
// секунду, через несколько минут — до раза в минуту. Таймер рабочего потока
// так не тормозится: он раз в BG_TICK_MS шлёт сообщение, и у СКРЫТОЙ вкладки
// без кадров (BG_STALL_MS) мир считается без отрисовки.
//
// Только у скрытой и не больше половины времени (после кадра ценой C мс —
// пауза C мс), по кадру за раз. Первая версия считала и у видимой вкладки,
// если кадры шли реже 10 в секунду, и до 4 кадров за раз: на тяжёлой карте
// кадр хоста в редакторе длился больше 100 мс, фоновый счёт добавлял к нему
// ещё кадры, главный поток не успевал рисовать — "всё зависает и вылетает"
// (жалоба пользователя). Вне мультиплеера фон не считается: одиночной игре
// незачем жечь процессор. Заморозить вкладку целиком браузер может и так,
// но вкладку с Web Lock (net.js держит их в лобби) он не замораживает.
const BG_TICK_MS = 16;
const BG_STALL_MS = 100;
const BG_FRAME_MS = 1000 / 60;
let bgDue = 0, bgResumeAt = 0;
try {
  // Он же — сторож зависаний (см. diagReport вверху).
  const src = `
    let phase = '', hidden = false, beat = Date.now(), hungAt = 0, role = '';
    const report = (o) => { try { fetch('${location.origin}/__diag', { method: 'POST', body: JSON.stringify(o) }); } catch (e) {} };
    onmessage = (e) => {
      if (hungAt) { report({ kind: 'resume', phase, role, ms: Date.now() - hungAt }); hungAt = 0; }
      phase = e.data.p; hidden = e.data.h; role = e.data.r; beat = Date.now();
    };
    setInterval(() => postMessage(0), ${BG_TICK_MS});
    setInterval(() => {
      if (!hungAt && phase && !hidden && Date.now() - beat > ${DIAG_HANG_MS}) { hungAt = beat; report({ kind: 'hang', phase, role, ms: Date.now() - beat }); }
    }, 500);`;
  const bg = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  diagWorker = bg;
  let bgLast = performance.now();
  bg.onmessage = () => {
    const now = performance.now();
    const dt = now - bgLast;
    bgLast = now;
    // Хост — только у скрытой вкладки (см. выше). Подключившаяся вкладка —
    // всегда, когда кадров нет: её дело — успевать за тиками хоста, а
    // браузер, бывает, почти не даёт кадров и видимому, но не активному окну
    // (в diag.log — пропуски кадров по 3-40 с у вкладки, не скрытой); тики
    // копились, и у игрока подлагивало.
    if (!mp.role || now - lastFrameAt < BG_STALL_MS || (!document.hidden && mp.role !== 'client')) { bgDue = 0; return; }
    if (now < bgResumeAt) return;
    bgDue = Math.min(1, bgDue + dt / BG_FRAME_MS);
    if (bgDue < 1) return;
    bgDue -= 1;
    try { simFrame(); } catch (e) { diagError(e, 'счёт в фоне'); }
    const end = performance.now();
    bgResumeAt = end + (end - now);
  };
} catch (e) {
  console.warn('Пиксириус: фоновый таймер не запустился — в фоне мультиплеер встанет', e);
}
