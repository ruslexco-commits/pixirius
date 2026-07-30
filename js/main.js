'use strict';

const GRID_W = 576;
const GRID_H = 324;
const ZOOM = 3;

const sim = new Sim(GRID_W, GRID_H);
let selectedElement = ELEMENT_ORDER[0];

const canvas = document.getElementById('view');
const stage = document.getElementById('stage');
canvas.width = GRID_W * ZOOM;
canvas.height = GRID_H * ZOOM;

// Полагаться на CSS object-fit для канваса ненадёжно (в некоторых движках
// внутренний буфер не масштабируется как надо, только обрезается) —
// поэтому размер отображения считаем сами и выставляем в px явно.
function fitCanvas() {
  const r = stage.getBoundingClientRect();
  const scale = Math.max(0.01, Math.min(r.width / canvas.width, r.height / canvas.height));
  canvas.style.width = Math.floor(canvas.width * scale) + 'px';
  canvas.style.height = Math.floor(canvas.height * scale) + 'px';
}
window.addEventListener('resize', fitCanvas);
fitCanvas();

const renderer = new Renderer(sim, canvas, ZOOM);
const input = new InputController(sim, renderer, canvas, () => selectedElement);

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

document.addEventListener('click', hideMaterialInfo);
document.addEventListener('scroll', hideMaterialInfo, true);

function addPaletteButton(id) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'el-btn';
  const name = ELEMENTS[id].name;
  btn.style.background = rgbCss(ELEMENTS[id].color);
  btn.title = name;
  if (id === selectedElement) btn.classList.add('selected');
  btn.addEventListener('click', () => {
    selectedElement = id;
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

// Ползунок общей скорости процессов, привязанных к "секундам" (пока что —
// только впитывание/выравнивание влажности земли, см. Sim.moistureTickPeriod),
// а не самой физики движения/падения. 100 — обычная скорость (как и
// sim.timeScale по умолчанию в конструкторе), меньше — медленнее, больше —
// быстрее. Живёт во вкладке "Разное", рядом с инструментами давления и
// температуры, но сам не инструмент — не откликается на клики по канвасу,
// просто правит sim.timeScale напрямую.
function addTimeScaleControl() {
  const wrap = document.createElement('div');
  wrap.className = 'time-scale';
  const label = document.createElement('div');
  label.className = 'time-scale-label';
  const refreshLabel = () => { label.textContent = `Течение времени: ${sim.timeScale}%`; };
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '10';
  slider.max = '400';
  slider.step = '5';
  slider.value = String(sim.timeScale);
  slider.title = 'Скорость процессов вроде впитывания влаги землёй';
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
// напрямую, кроме как через материал -> cat). "Разное" — инструменты
// воздействия на мир (не материалы: давление воздуха, температура — оба
// по одному и тому же принципу ЛКМ добавляет/ПКМ убавляет). "Технологии"
// пока пуста — пользователь наполнит её позже, отдельно от "Разное".
const CATEGORIES = [
  { key: 'gas', label: 'Газ' },
  { key: 'solid', label: 'Тела' },
  { key: 'powder', label: 'Сыпучее' },
  { key: 'liquid', label: 'Жидкости' },
  { key: 'tech', label: 'Технологии' },
  { key: 'misc', label: 'Разное' },
];

function materialCategoryKey(id) {
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
    addTimeScaleControl();
  } else if (activeCategory === 'tech') {
    // Пусто — пользователь наполнит позже.
  } else {
    for (const id of ELEMENT_ORDER) {
      if (materialCategoryKey(id) === activeCategory) addPaletteButton(id);
    }
  }
}

buildPaletteTabs();
buildPaletteGrid();
statusLabel.textContent = ELEMENTS[ELEMENT_ORDER[0]].name;

// ---- игровой цикл ----

function loop() {
  sim.step();
  input.tickHold();
  renderer.render(input.getCursorState());
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
