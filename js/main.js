'use strict';

const GRID_W = 576;
const GRID_H = 324;
const ZOOM = 3;

const sim = new Sim(GRID_W, GRID_H);
let selectedElement = EL.SAND;

const canvas = document.getElementById('view');
canvas.width = GRID_W * ZOOM;
canvas.height = GRID_H * ZOOM;
canvas.style.aspectRatio = `${GRID_W} / ${GRID_H}`;

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

btnPause.addEventListener('click', () => { sim.paused = !sim.paused; refreshPauseIcon(); });
btnClear.addEventListener('click', () => { sim.clear(); });

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

const palette = document.getElementById('palette');
const statusLabel = document.getElementById('statusLabel');

function rgbCss(c) { return `rgb(${c[0]},${c[1]},${c[2]})`; }

function addPaletteButton(id, isEraser) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'el-btn' + (isEraser ? ' el-eraser' : '');
  const name = isEraser ? 'Ластик' : ELEMENTS[id].name;
  if (!isEraser) {
    btn.style.background = rgbCss(ELEMENTS[id].color);
  }
  btn.title = name;
  btn.addEventListener('click', () => {
    selectedElement = id;
    for (const b of palette.children) b.classList.remove('selected');
    btn.classList.add('selected');
    statusLabel.textContent = name;
  });
  palette.appendChild(btn);
  return btn;
}

addPaletteButton(EL.EMPTY, true);
for (const id of ELEMENT_ORDER) addPaletteButton(id, false);
palette.children[1].classList.add('selected');
statusLabel.textContent = ELEMENTS[EL.SAND].name;

// ---- игровой цикл ----

function loop() {
  sim.step();
  input.tickHold();
  renderer.render(input.getCursorState());
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
