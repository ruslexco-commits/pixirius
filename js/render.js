'use strict';

function clamp8(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

// С какой температуры материал начинает светиться от жара (см. heatTint).
const HEAT_GLOW_FROM = 70;

// Непрозрачность почти угасшего заряда (см. drawCharges): свежий — 1.
const CHARGE_MIN_ALPHA = 0.15;

// Вспышка монитора, принявшего снимок (просьба пользователя: "на треть
// секунды становился голубым, плавно"): длительность в миллисекундах
// настоящего времени, цвет и сила на пике.
const MONITOR_GLOW_MS = 333;
const MONITOR_GLOW_RGB = [110, 200, 255];
const MONITOR_GLOW_PEAK = 0.85;

// Темнота и свет (sim.darkness, выбирается лупой на лампочке; просьба
// пользователя). Уровень 1 — света не считаем вовсе, лампочки не светят.
// Уровень 2 — солнце: свет идёт сверху по столбцу до первого непрозрачного
// (его верхняя грань ещё освещена), в жидкости слабеет, и немного
// растекается вбок и вниз в проёмы (LIGHT_SPREAD за клетку); закрытое со
// всех сторон помещение остаётся тёмным. Уровень 3 — солнца нет. Свет
// лампочки расходится от неё волной на LAMP_RADIUS клеток: огибает углы,
// но сквозь непрозрачное не проходит (стена освещена только с лица). В
// воздухе он виден тёплым свечением, а сама горящая лампочка — яркой.
// Темнота — затемнение до LIGHT_AMBIENT: пиксели остаются различимы, но
// плохо. Всё это — слой поверх поля (drawLighting) и та же поправка цвета
// для игры за протагониста и снимков камер (litColor).
const LIGHT_AMBIENT = 0.12;
const LIGHT_SPREAD = 0.88;
const LIGHT_LIQUID_KEEP = 0.93;
// Освещённая корка: внутрь непрозрачного свет заходит на несколько
// пикселей, слабея так за каждый, но из него в воздух за ним не выходит —
// иначе земля под солнцем была бы тёмной целиком, кроме верхнего ряда.
const LIGHT_SOLID_KEEP = 0.6;
const LAMP_RADIUS = 30;
const LIGHT_SKY_PERIOD = 4;
// Плавный свет (sim.lightSmooth, переключатель в лупе на лампочке; просьба
// пользователя — "не попиксельно, а натурально", с возможностью вернуться
// к попиксельному): затемнение растягивается по экрану со сглаживанием,
// свет лампы спадает по настоящему расстоянию до неё (кругом, а не
// восьмиугольником волны), а свечение рисуется отдельным размытым слоем,
// который складывается с картинкой. Размытие свечения — LIGHT_GLOW_BLUR
// клеток, затемнения — LIGHT_DARK_BLUR (мягкие края теней вместо ступенек).
// Куда свет доходит и что его заслоняет — та же волна, что и у
// попиксельного; игра за протагониста рисует свет по клеткам в обоих
// режимах.
const LIGHT_GLOW_BLUR = 4;
const LIGHT_DARK_BLUR = 1;
const LAMP_ON_RGB = [255, 236, 160];
const LAMP_GLOW_RGB = [255, 196, 110];
const LAMP_GLOW_AIR = 0.45;           // сила свечения в воздухе
const LAMP_GLOW_MATTER = 0.12;        // тёплый отсвет на веществе
// Голубое небо (темнота 2; просьба пользователя: верхний свет "аккуратно
// окрашивает фон в полупрозрачно голубые тона"): освещённый солнцем воздух
// (пустота и балка в ней) получает прибавку этого цвета, тем сильнее, чем
// больше там солнца. Складывается со свечением ламп в одном слое.
const SKY_TINT_RGB = [70, 125, 210];
const SKY_TINT_AIR = 0.2;
// Непрозрачное для света: твёрдое и сыпучее, кроме стекла.
const LIGHT_OPAQUE = new Uint8Array(64);
for (let id = 1; id < 64; id++) {
  const el = ELEMENTS[id];
  LIGHT_OPAQUE[id] = el && (el.cat === CAT.SOLID || el.cat === CAT.POWDER) && IS_SEE_THROUGH[id] !== 1 ? 1 : 0;
}

// Хэш числа в 0..1 — для мигания лампочки без Math.random (случайные числа
// симуляции тратить нельзя, см. CLAUDE.md).
function hash01(v) {
  let h = Math.imul(v | 0, 0x9E3779B1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85EBCA6B);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

// Смешивает базовый цвет (rgb) с тоном отладочного режима (tint) в пропорции
// weight (0 = чистый базовый, 1 = чистый tint) — используется, чтобы режимы
// ветра/тепловизора подсвечивали клетку, а не полностью прятали под собой
// то, что там реально стоит (см. cellColor).
function blendColor(r, g, b, tint, weight) {
  return [
    clamp8(Math.round(r + (tint[0] - r) * weight)),
    clamp8(Math.round(g + (tint[1] - g) * weight)),
    clamp8(Math.round(b + (tint[2] - b) * weight)),
  ];
}

// Множитель насыщенности окисла для клетки i (см. Renderer.oxideColor).
// Берётся из индекса клетки, а не из Math.random(): он должен быть у
// клетки постоянным, иначе пиксель мерцал бы каждый кадр. Общий для CPU и
// GPU (render-gl.js заливает его в текстуру один раз) — формула нарочно
// одна: умножение здесь в double, и повторить его в шейдере побитно нельзя.
function oxideSaturation(i) {
  let v = (i * 2654435761) >>> 0;
  v ^= v >>> 15;
  return 0.7 + ((v * 2246822519) >>> 0) / 4294967296 * 0.65;
}

function hsvToRgb(h, s, v) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q; break;
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

// Оттенок балки в клетке i: -15..15, постоянный для клетки (хэш номера с
// перемешиванием битов: простое умножение давало на соседних клетках
// заметные диагональные полосы). Шейдер (render-gl.js) считает то же самое.
function beamShade(i) {
  let h = Math.imul(i, 0x9E3779B1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85EBCA6B);
  h ^= h >>> 13;
  return ((h >>> 24) % 31) - 15;
}

// Цвет крови на клетках вокруг раздавленного (см. поле stain).
const BLOOD_COLOR = [140, 10, 14];
// Отравление реагентом у человека и протагониста (то же поле stain, см.
// sim/human.js): к жёлтому, при 255 — на POISON_TINT_MAX. Тем же цветом
// желтеет ник игрока (NameTags в play.js).
const POISON_COLOR = [232, 214, 40];
const POISON_TINT_MAX = 0.85;
// Грязь на пикселе (поле dirt, sim/mud.js): к цвету грязи, от DIRT_TINT_FULL
// и больше (4 доли) — на DIRT_TINT_MAX. Доля в 1/10 от 255 была едва видна.
const DIRT_COLOR = ELEMENTS[EL.MUD].color;
const DIRT_TINT_MAX = 0.75;
const DIRT_TINT_FULL = 100;
// Урон у живых (то же поле dirt, sim/human.js): к красному, при 255 — на HURT_TINT_MAX.
const HURT_COLOR = [214, 22, 22];
const HURT_TINT_MAX = 0.8;

class Renderer {
  // options.gpu — рисовать поле на видеокарте (render-gl.js), если она
  // доступна; иначе и при false — прежним путём на CPU (buildImage).
  constructor(sim, canvas, zoom, options = {}) {
    this.sim = sim;
    this.zoom = zoom;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = false;

    this.off = document.createElement('canvas');
    this.off.width = sim.w;
    this.off.height = sim.h;
    this.offCtx = this.off.getContext('2d');
    this.imageData = this.offCtx.createImageData(sim.w, sim.h);
    this.gpu = options.gpu === false ? null : GpuCellPainter.create(sim);
    // Канвас w x h с картинкой последнего кадра (GPU или CPU) — из него
    // растягивается основной канвас и берёт увеличение лупа.
    this.frameSource = this.off;

    this.zoomBoxCorner = 'br';
    // Окно лупы — квадрат площадью в четверть площади канваса.
    this.zoomBoxSize = Math.sqrt((canvas.width * canvas.height) / 4);
    this.zoomBoxMargin = 10;

    this.debugStability = false;
    this.debugWind = false;
    this.debugTherm = false;
    // Вспышки мониторов (updateMonitorGlow): номер монитора → { seq, start }
    // и клетки, светящиеся в этом кадре, → сила 0..1.
    this._glowSeen = new Map();
    this.monitorGlow = new Map();
    // Свет (updateLighting): яркость клетки 0..1, свет лампочек 0..1 и
    // слой затемнения поверх поля.
    const n = sim.w * sim.h;
    this.lightOn = false;
    this.sky = new Float32Array(n);
    this._lightOp = new Uint8Array(n);
    this._skyCol = new Float32Array(sim.w);
    this._skyInSolid = new Uint8Array(sim.w);
    this._skyTick = 0;
    this._skyLevel = 0;
    this.lampLight = new Float32Array(n);
    this._lampDist = new Int32Array(n);
    this._lampSrc = new Int32Array(n);     // от какой лампы пришёл свет (плавный режим)
    this._lampD0 = new Float32Array(n);    // начальное расстояние лампы-источника (её сила)
    this._lampStamp = new Int32Array(n);
    this._lampGen = 0;
    this._lampBuckets = [];
    this.lightCanvas = document.createElement('canvas');
    this.lightCanvas.width = sim.w;
    this.lightCanvas.height = sim.h;
    this.lightCtx = this.lightCanvas.getContext('2d');
    this.lightImg = this.lightCtx.createImageData(sim.w, sim.h);
    // Слой свечения для плавного режима (размывается при наложении).
    this.glowCanvas = document.createElement('canvas');
    this.glowCanvas.width = sim.w;
    this.glowCanvas.height = sim.h;
    this.glowCtx = this.glowCanvas.getContext('2d');
    this.glowImg = this.glowCtx.createImageData(sim.w, sim.h);
  }

  // Горит ли лампочка в клетке i: 0..1. Первые LAMP_STEADY кадров срока —
  // ровно, дальше мигает: вспыхивает и гаснет рывками по хэшу срока (у
  // клеток одной лампочки срок одинаковый, и мигают они вместе), и чем
  // ближе конец, тем реже горит.
  lampOn(i) {
    const sim = this.sim;
    if (sim.type[i] !== EL.LAMP) return 0;
    const life = sim.life[i];
    if (life <= 0) return 0;
    const flickFrom = LAMP_CYCLE - LAMP_STEADY;
    if (life > flickFrom) return 1;
    const p = 0.2 + 0.6 * (life / flickFrom);
    return hash01(life >> 2) < p ? 1 : 0.1;
  }

  // Раз в кадр отрисовки: свет на всём поле (см. LIGHT_*). При темноте 1 —
  // ничего не считается. Солнце (sky) меняется медленно и пересчитывается
  // раз в LIGHT_SKY_PERIOD кадров отрисовки (и сразу при смене темноты),
  // лампочки — каждый кадр: они мигают. Первый вариант считал всё каждый
  // кадр, столбцами с шагом в строку, и стоил 5,5 мс; теперь солнце идёт
  // построчно с накопителем на столбец.
  updateLighting() {
    const sim = this.sim, d = sim.darkness | 0;
    this.lightOn = d >= 2;
    if (!this.lightOn) { this._skyLevel = 0; return; }
    if (d !== this._skyLevel || ++this._skyTick >= LIGHT_SKY_PERIOD) {
      this._skyTick = 0;
      this._skyLevel = d;
      if (d === 2) this.computeSky(); else this.sky.fill(0);
    }
    this.lightLamps();
  }

  // Солнце (темнота 2): свет сверху по столбцу, в жидкости слабеет, в
  // непрозрачное заходит коркой (LIGHT_SOLID_KEEP за пиксель), но из него
  // дальше в прозрачное не выходит. Потом растекается вбок по строкам (туда
  // и обратно), вниз и ещё раз вбок — по тому же правилу корки.
  computeSky() {
    const sim = this.sim, w = sim.w, h = sim.h, n = w * h, type = sim.type, L = this.sky;
    const op = this._lightOp, col = this._skyCol, inSolid = this._skyInSolid;
    col.fill(1);
    inSolid.fill(0);
    for (let y = 0, i = 0; y < h; y++) {
      for (let x = 0; x < w; x++, i++) {
        const t = type[i], o = LIGHT_OPAQUE[t];
        op[i] = o;
        let c = col[x];
        if (o === 1) { inSolid[x] = 1; L[i] = c; col[x] = c * LIGHT_SOLID_KEEP; continue; }
        if (inSolid[x]) { c = 0; col[x] = 0; }
        L[i] = c;
        if (c > 0 && IS_LIQUID[t] === 1) col[x] = c * LIGHT_LIQUID_KEEP;
      }
    }
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 0; y < h; y++) {
        const row = y * w;
        let carry = 0, fromSolid = 0;
        for (let i = row, e = row + w; i < e; i++) {
          const o = op[i];
          if (o === 1 || !fromSolid) { const v = carry * (o === 1 ? LIGHT_SOLID_KEEP : LIGHT_SPREAD); if (v > L[i]) L[i] = v; }
          carry = L[i]; fromSolid = o;
        }
        carry = 0; fromSolid = 0;
        for (let i = row + w - 1; i >= row; i--) {
          const o = op[i];
          if (o === 1 || !fromSolid) { const v = carry * (o === 1 ? LIGHT_SOLID_KEEP : LIGHT_SPREAD); if (v > L[i]) L[i] = v; }
          carry = L[i]; fromSolid = o;
        }
      }
      if (pass === 0) {
        for (let i = w; i < n; i++) {
          const o = op[i];
          if (op[i - w] === 1 && o !== 1) continue;
          const v = L[i - w] * (o === 1 ? LIGHT_SOLID_KEEP : LIGHT_SPREAD);
          if (v > L[i]) L[i] = v;
        }
      }
    }
  }

  // Освещённость клетки 0..1: солнце плюс лампочки.
  lightAt(i) {
    const v = this.sky[i] + this.lampLight[i];
    return v > 1 ? 1 : v;
  }

  // Свет лампочек: волна от всех горящих клеток сразу (Дейкстра с целыми
  // шагами: прямо 2, по диагонали 3), до LAMP_RADIUS клеток. Непрозрачное
  // свет принимает, но не пропускает. Сила лампочки p (lampOn) задана
  // начальным расстоянием: тусклая стартует так, будто она уже дальше
  // (maxD * (1 - sqrt p)), и в клетке остаётся свет той лампы, что светит
  // туда ярче всех, — яркость (1 - d/maxD)^2. Раньше каждой клетке
  // доставалась сила ближайшей лампы: мигнувшая (p = 0.1) затемняла свою
  // округу, даже если рядом горела другая, и среди многих ламп при мигании
  // появлялись тёмные пятна (жалоба пользователя).
  lightLamps() {
    const sim = this.sim, w = sim.w, h = sim.h, n = w * h, type = sim.type;
    const G = this.lampLight, dist = this._lampDist, stamp = this._lampStamp;
    const src = this._lampSrc, srcD0 = this._lampD0, smooth = !!sim.lightSmooth;
    G.fill(0);
    const gen = ++this._lampGen, maxD = LAMP_RADIUS * 2;
    const buckets = this._lampBuckets;
    for (let b = 0; b <= maxD; b++) { if (!buckets[b]) buckets[b] = []; buckets[b].length = 0; }
    let any = false;
    for (let i = 0; i < n; i++) {
      if (type[i] !== EL.LAMP) continue;
      const p = this.lampOn(i);
      if (p <= 0) continue;
      any = true;
      const d0 = Math.round(maxD * (1 - Math.sqrt(p)));
      if (d0 >= maxD) continue;
      stamp[i] = gen; dist[i] = d0;
      src[i] = i; srcD0[i] = maxD * (1 - Math.sqrt(p));
      buckets[d0].push(i);
    }
    if (!any) return;
    for (let b = 0; b <= maxD; b++) {
      const list = buckets[b];
      for (let q = 0; q < list.length; q++) {
        const i = list[q];
        if (dist[i] !== b) continue;
        // Плавный режим: яркость по настоящему расстоянию до лампы-источника
        // (в тех же полуклетках, что и волна) плюс её начальное расстояние.
        let f;
        if (smooth) {
          const s = src[i], dx = i % w - s % w, dy = ((i / w) | 0) - ((s / w) | 0);
          f = 1 - (2 * Math.sqrt(dx * dx + dy * dy) + srcD0[s]) / maxD;
        } else f = 1 - b / maxD;
        const v = f > 0 ? f * f : 0;
        if (v > G[i]) G[i] = v;
        // Грань непрозрачного освещена, дальше свет не идёт. Горящая лампочка
        // — источник, от неё свет расходится (погасшая — обычная преграда).
        if (LIGHT_OPAQUE[type[i]] === 1 && !(type[i] === EL.LAMP && this.lampOn(i) > 0)) continue;
        const x = i % w, y = (i / w) | 0;
        for (let k = 0; k < 8; k++) {
          const nx = x + CHARGE_NB_DX[k], ny = y + CHARGE_NB_DY[k];
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const j = ny * w + nx, nd = b + (k < 4 ? 2 : 3);
          if (nd > maxD) continue;
          if (stamp[j] === gen && dist[j] <= nd) continue;
          stamp[j] = gen; dist[j] = nd; src[j] = src[i];
          buckets[nd].push(j);
        }
      }
    }
  }

  // Цвет rgb клетки i с учётом света (для игры и снимков камер).
  litColor(i, rgb) {
    if (!this.lightOn) return rgb;
    const t = this.sim.type[i];
    if (t === EL.LAMP) {
      const p = this.lampOn(i);
      if (p > 0) {
        const a = 0.9 * p;
        return [rgb[0] + (LAMP_ON_RGB[0] - rgb[0]) * a, rgb[1] + (LAMP_ON_RGB[1] - rgb[1]) * a, rgb[2] + (LAMP_ON_RGB[2] - rgb[2]) * a];
      }
    }
    const b = LIGHT_AMBIENT + (1 - LIGHT_AMBIENT) * this.lightAt(i);
    const g = this.lampLight[i] * (t === EL.EMPTY ? LAMP_GLOW_AIR : LAMP_GLOW_MATTER);
    const gs = (this.sim.darkness | 0) === 2 && t === EL.EMPTY ? this.sky[i] * SKY_TINT_AIR : 0;
    return [Math.min(255, rgb[0] * b + LAMP_GLOW_RGB[0] * g + SKY_TINT_RGB[0] * gs), Math.min(255, rgb[1] * b + LAMP_GLOW_RGB[1] * g + SKY_TINT_RGB[1] * gs), Math.min(255, rgb[2] * b + LAMP_GLOW_RGB[2] * g + SKY_TINT_RGB[2] * gs)];
  }

  // Слои света (см. LIGHT_*), картинки w x h: затемнение (чёрный с
  // непрозрачностью 1 - яркость, горящие лампочки — своим цветом) и
  // свечение (тёплый цвет, непрозрачность — свет лампы), которое при
  // наложении складывается с картинкой. Раньше свечение подмешивалось в
  // затемнение как C*a — и там, где лампа освещала клетку полностью (a = 0),
  // его было не к чему прибавить: вокруг лампы шло тёмное кольцо.
  buildLightImage() {
    const sim = this.sim, n = sim.w * sim.h, type = sim.type;
    const skyTint = (sim.darkness | 0) === 2;
    // Пиксель RGBA одним словом (порядок байт в памяти — младший первым).
    const d32 = this._light32 || (this._light32 = new Uint32Array(this.lightImg.data.buffer));
    const g32 = this._glow32 || (this._glow32 = new Uint32Array(this.glowImg.data.buffer));
    const S = this.sky, G = this.lampLight, K = 1 - LIGHT_AMBIENT;
    const glowRGB = LAMP_GLOW_RGB[0] | (LAMP_GLOW_RGB[1] << 8) | (LAMP_GLOW_RGB[2] << 16);
    const lampWord = LAMP_ON_RGB[0] | (LAMP_ON_RGB[1] << 8) | (LAMP_ON_RGB[2] << 16);
    for (let i = 0; i < n; i++) {
      const t = type[i], g0 = G[i], s0 = S[i];
      let l = s0 + g0;
      if (l > 1) l = 1;
      // Голубой тон неба — только воздуху (см. SKY_TINT_*).
      const gs = skyTint && t === EL.EMPTY ? s0 * SKY_TINT_AIR : 0;
      if (g0 === 0) {
        g32[i] = gs === 0 ? 0 : ((SKY_TINT_RGB[0] | (SKY_TINT_RGB[1] << 8) | (SKY_TINT_RGB[2] << 16) | ((gs * 255) << 24)) >>> 0);
        d32[i] = ((K * (1 - l) * 255) << 24) >>> 0;
        continue;
      }
      const gl = g0 * (t === EL.EMPTY ? LAMP_GLOW_AIR : LAMP_GLOW_MATTER);
      if (gs === 0) g32[i] = (glowRGB | ((Math.min(255, gl * 255) | 0) << 24)) >>> 0;
      else {
        // Свечение лампы и небо вместе: цвет — взвешенный, сила — сумма.
        const A = Math.min(1, gl + gs), kl = gl / A, ks = gs / A;
        const r = Math.min(255, LAMP_GLOW_RGB[0] * kl + SKY_TINT_RGB[0] * ks) | 0;
        const g = Math.min(255, LAMP_GLOW_RGB[1] * kl + SKY_TINT_RGB[1] * ks) | 0;
        const b = Math.min(255, LAMP_GLOW_RGB[2] * kl + SKY_TINT_RGB[2] * ks) | 0;
        g32[i] = (r | (g << 8) | (b << 16) | ((A * 255) << 24)) >>> 0;
      }
      if (t === EL.LAMP) {
        const p = this.lampOn(i);
        if (p > 0) { d32[i] = (lampWord | ((230 * p) << 24)) >>> 0; continue; }
      }
      d32[i] = ((K * (1 - l) * 255) << 24) >>> 0;
    }
    this.lightCtx.putImageData(this.lightImg, 0, 0);
    this.glowCtx.putImageData(this.glowImg, 0, 0);
  }

  // Слои света в прямоугольник канваса (dx, dy, dw, dh) из клеток поля
  // (x0..x1, y0..y1), обрезанные этим прямоугольником (размытие иначе
  // вылезало за окно лупы жёлтой полосой). Попиксельно — без сглаживания и
  // размытия; плавно — затемнение сглаженно и чуть размыто (LIGHT_DARK_BLUR),
  // свечение размыто сильнее (LIGHT_GLOW_BLUR). Свечение — сложением.
  paintLight(x0, y0, x1, y1, dx, dy, dw, dh) {
    const ctx = this.ctx, sw = x1 - x0 + 1, sh = y1 - y0 + 1;
    const smooth = !!this.sim.lightSmooth, cell = dw / sw;
    ctx.save();
    ctx.beginPath();
    ctx.rect(dx, dy, dw, dh);
    ctx.clip();
    ctx.imageSmoothingEnabled = smooth;
    if (smooth) {
      ctx.imageSmoothingQuality = 'high';
      ctx.filter = `blur(${(LIGHT_DARK_BLUR * cell).toFixed(1)}px)`;
    }
    ctx.drawImage(this.lightCanvas, x0, y0, sw, sh, dx, dy, dw, dh);
    ctx.globalCompositeOperation = 'lighter';
    ctx.filter = smooth ? `blur(${(LIGHT_GLOW_BLUR * cell).toFixed(1)}px)` : 'none';
    ctx.drawImage(this.glowCanvas, x0, y0, sw, sh, dx, dy, dw, dh);
    ctx.restore();
  }

  // Слой света поверх поля (параметры — как у drawCharges).
  drawLighting(ox = 0, oy = 0, scale = this.zoom, x0 = 0, y0 = 0, x1 = this.sim.w - 1, y1 = this.sim.h - 1) {
    if (!this.lightOn) return;
    this.paintLight(x0, y0, x1, y1, ox, oy, (x1 - x0 + 1) * scale, (y1 - y0 + 1) * scale);
  }

  // Раз в кадр отрисовки: какие мониторы сейчас светятся. Симуляция
  // отмечает приём снимка номером (sim.monitorFlash, sim/charges.js), а
  // время вспышки отмеряется здесь по часам, а не кадрами симуляции:
  // треть секунды остаётся третью секунды при любой скорости времени.
  // Сила — полуволна синуса: плавно загорается и плавно гаснет.
  updateMonitorGlow(now = performance.now()) {
    const glow = this.monitorGlow, seen = this._glowSeen, flashes = this.sim.monitorFlash;
    glow.clear();
    if (!flashes) return;
    for (const [key, f] of flashes) {
      let s = seen.get(key);
      if (!s || s.seq !== f.seq) { s = { seq: f.seq, start: now }; seen.set(key, s); }
      const t = (now - s.start) / MONITOR_GLOW_MS;
      if (t >= 1) continue;
      const k = Math.sin(Math.PI * t);
      for (let n = 0; n < f.cells.length; n++) {
        const c = f.cells[n];
        if (this.sim.type[c] === EL.MONITOR) glow.set(c, k);
      }
    }
    for (const key of seen.keys()) if (!flashes.has(key)) seen.delete(key);
  }

  // Цвет клетки монитора с вспышкой поверх (для игры за протагониста,
  // js/play.js, где поле рисуется без оверлея).
  glowColor(i, rgb) {
    const k = this.monitorGlow.get(i);
    if (!k) return rgb;
    const a = k * MONITOR_GLOW_PEAK;
    return [rgb[0] + (MONITOR_GLOW_RGB[0] - rgb[0]) * a, rgb[1] + (MONITOR_GLOW_RGB[1] - rgb[1]) * a, rgb[2] + (MONITOR_GLOW_RGB[2] - rgb[2]) * a];
  }

  // Точки спавна и респавна игроков (sim/spawns.js) поверх поля: точка
  // спавна — квадратик цвета игрока с его именем, точка респавна — зелёный
  // светящийся пиксель (мерцает). names — имена игроков по номеру (лобби).
  // Параметры — как у drawCharges.
  drawMarks(ox = 0, oy = 0, scale = this.zoom, x0 = 0, y0 = 0, x1 = this.sim.w - 1, y1 = this.sim.h - 1, names = null) {
    const sim = this.sim;
    // hideSpawnMarks — включён случайный спавн (js/lobby.js): точки спавна
    // ни к чему, только мозолят глаза (просьба пользователя).
    const spawns = !this.hideSpawnMarks && sim.spawnMarks && sim.spawnMarks.length;
    if (!spawns && (!sim.respawnMarks || !sim.respawnMarks.length)) return;
    const ctx = this.ctx, k = this.screenScale();
    const pulse = 0.65 + 0.35 * Math.sin(performance.now() / 260);
    ctx.save();
    for (const m of sim.respawnMarks) {
      if (m.x < x0 || m.x > x1 || m.y < y0 || m.y > y1) continue;
      const px = ox + (m.x - x0) * scale, py = oy + (m.y - y0) * scale;
      ctx.shadowColor = 'rgba(80,255,120,0.9)';
      ctx.shadowBlur = 8 * k * pulse;
      ctx.fillStyle = `rgba(90,255,130,${(0.7 + 0.3 * pulse).toFixed(2)})`;
      ctx.fillRect(px, py, scale, scale);
    }
    ctx.shadowBlur = 0;
    ctx.font = `bold ${Math.round(11 * k)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    if (spawns) for (const m of sim.spawnMarks) {
      if (m.x < x0 || m.x > x1 || m.y < y0 || m.y > y1) continue;
      const px = ox + (m.x - x0) * scale, py = oy + (m.y - y0) * scale;
      const c = (sim.playerColors && sim.playerColors[m.n]) || ELEMENTS[EL.PROTAGONIST].color;
      ctx.fillStyle = 'rgba(0,0,0,0.8)';
      ctx.fillRect(px - k, py - k, scale + 2 * k, scale + 2 * k);
      ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      ctx.fillRect(px, py, scale, scale);
      const label = (names && names[m.n]) || ('P' + m.n);
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillText(label, px + scale / 2 + k, py - 2 * k + k);
      ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      ctx.fillText(label, px + scale / 2, py - 2 * k);
    }
    ctx.restore();
  }

  // Вспышки мониторов поверх поля (параметры — как у drawCharges).
  drawMonitorGlow(ox = 0, oy = 0, scale = this.zoom, x0 = 0, y0 = 0, x1 = this.sim.w - 1, y1 = this.sim.h - 1) {
    if (this.monitorGlow.size === 0) return;
    const ctx = this.ctx, w = this.sim.w;
    ctx.save();
    ctx.fillStyle = `rgb(${MONITOR_GLOW_RGB[0]},${MONITOR_GLOW_RGB[1]},${MONITOR_GLOW_RGB[2]})`;
    for (const [c, k] of this.monitorGlow) {
      const x = c % w, y = (c / w) | 0;
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      ctx.globalAlpha = k * MONITOR_GLOW_PEAK;
      ctx.fillRect(ox + (x - x0) * scale, oy + (y - y0) * scale, scale, scale);
    }
    ctx.restore();
  }

  cellColor(i) {
    const sim = this.sim;
    const id = sim.type[i];
    if (this.debugStability && isStructural(id)) return this.stabilityColor(id, sim.stability[i]);
    const x = i % sim.w, y = (i / sim.w) | 0;

    if (id === EL.EMPTY) {
      // Пустая клетка — фону нечего "закрывать", поэтому тон ветра/тепла
      // здесь по-прежнему показывается чисто, как и раньше.
      if (this.debugTherm) { const tc = this.thermalColor(x, y); if (tc) return tc; }
      else if (this.debugWind) { const wc = this.windColor(x, y); if (wc) return wc; }
      // Балка лежит во втором слое и рисуется ЗАДНИМ планом: её видно
      // только там, где перед ней ничего нет. Цвет приглушён до фонового,
      // чтобы она читалась как конструкция позади, а не как материал, по
      // которому что-то ходит или течёт. Цвет — её материала (beamColor).
      if (sim.beam[i]) {
        // Шероховатость балки — своя у каждой клетки, как у материала
        // (светлее, темнее, в том же размахе ±15), а не оттенок пустоты, в
        // которой она стоит: у пустоты он нулевой, и балка выходила ровной
        // заливкой (просьба пользователя). Тот же хэш — в шейдере.
        const bc = this.beamColor(i), sh = beamShade(i);
        return [clamp8(14 + (bc[0] - 14) * 0.42 + sh), clamp8(14 + (bc[1] - 14) * 0.42 + sh), clamp8(18 + (bc[2] - 18) * 0.42 + sh)];
      }
      return [14, 14, 18];
    }

    const el = ELEMENTS[id];
    const s = sim.shade[i];
    const comp = sim.comp(i);
    // Клетка из нескольких веществ (comp >= 1024 — занята вторая ячейка
    // состава), смеси и соль красятся по СОСТАВУ: цвет — среднее цветов
    // долей (partsColor). Кислотный остаток — по уровню, окисел — по
    // стадии; остальное — цветом элемента.
    const base = (comp >= 1024 || id === EL.SOLUTION || id === EL.VAPOR || id === EL.BLACK_SALT || id === EL.MUD) ? this.partsColor(i)
      : id === EL.ACID_RESIDUE ? this.residueColor(i)
      : isOxide(id) ? this.oxideColor(i)
      // Мёртвый человек темнеет — самый заметный признак, что он больше
      // не ходит (extra=1, см. Sim.humanDie).
      : ((id === EL.HUMAN || id === EL.PROTAGONIST) && sim.extra[i]) ? [58, 52, 48]
      // Протагонист игрока мультиплеера — цветом игрока (шейдер — так же).
      : (id === EL.PROTAGONIST && sim.life[i] > 0 && sim.life[i] < 16 && sim.playerColors && sim.playerColors[sim.life[i]]) ? sim.playerColors[sim.life[i]]
      : el.color;
    let r = clamp8(base[0] + s), g = clamp8(base[1] + s), b = clamp8(base[2] + s);
    // Пятно крови (Sim.crushBody) — к красному, тем сильнее, чем гуще.
    // Шейдер повторяет это (render-gl.js).
    // У живых (человек, протагонист) stain — отравление: к жёлтому.
    const stn = sim.stain[i];
    if (stn) {
      const creature = id === EL.HUMAN || id === EL.PROTAGONIST;
      const col = creature ? POISON_COLOR : BLOOD_COLOR;
      const k = stn / 255 * (creature ? POISON_TINT_MAX : 0.75);
      r = clamp8(r + (col[0] - r) * k);
      g = clamp8(g + (col[1] - g) * k);
      b = clamp8(b + (col[2] - b) * k);
    }
    // Грязь на пикселе (sim/mud.js) — к цвету грязи. Шейдер — так же.
    // У живых dirt — урон: к красному.
    const drt = sim.dirt[i];
    if (drt) {
      const hurt = id === EL.HUMAN || id === EL.PROTAGONIST;
      const col = hurt ? HURT_COLOR : DIRT_COLOR;
      const k = hurt ? drt / 255 * HURT_TINT_MAX : Math.min(drt, DIRT_TINT_FULL) / DIRT_TINT_FULL * DIRT_TINT_MAX;
      r = clamp8(r + (col[0] - r) * k);
      g = clamp8(g + (col[1] - g) * k);
      b = clamp8(b + (col[2] - b) * k);
    }
    // Неполная клетка (часть долей — пустота, см. data/composition.js) показывается
    // бледнее, тем ближе к фону, чем меньше в ней вещества. Без этого
    // клетка с одной долей воды выглядела бы ровно как полная, и стягивание
    // жидкости к целым клеткам было бы не разглядеть. Касается любой
    // клетки: пустота — это прозрачность (просьба пользователя).
    if (comp) {
      const v = solGet(comp, P_VOID);
      if (v) {
        const k = 1 - (v / SOL_PARTS) * 0.75;
        r = clamp8(14 + (r - 14) * k);
        g = clamp8(14 + (g - 14) * k);
        b = clamp8(18 + (b - 18) * k);
      }
    }
    if (id === EL.FIRE) {
      const flick = (sim.life[i] * 37 + i * 13) % 46;
      r = clamp8(r + flick);
      g = clamp8(g + (flick >> 1));
    } else if (el.meltPoint && !this.debugTherm) {
      // При включённом тепловизоре ниже и так подмешается тон по той же
      // температуре — не дублируем два разных красных подряд.
      [r, g, b] = this.heatTint(i, r, g, b, el.meltPoint);
    }

    // Занятая клетка — режимы ветра/тепловизора СМЕШИВАЮТ свой тон с
    // цветом материала (а не заменяют его целиком, как было раньше) —
    // иначе, например, стена в сильном потоке воздуха становится
    // невидимой (виден только радужный цвет ветра), и не разобрать, что
    // именно там стоит и перегораживает/направляет поток.
    if (this.debugTherm) {
      const tc = this.thermalColor(x, y);
      if (tc) return blendColor(r, g, b, tc, 0.55);
    } else if (this.debugWind) {
      const wc = this.windColor(x, y);
      if (wc) return blendColor(r, g, b, wc, 0.55);
    }
    return [r, g, b];
  }

  // Цвет материала балки: у окисла — цвет его стадии (без разброса
  // насыщенности, как у настоящего окисла: балка и так приглушена), у
  // остального — цвет элемента. Шейдер повторяет это в beamColor.
  beamColor(i) {
    const sim = this.sim;
    const mat = sim.beam[i];
    const line = OXIDE_LINE[mat];
    if (IS_OXIDE[mat] === 1 && line) {
      const stage = Math.max(0, Math.min(line.maxStage, sim.beamExtra[i] || 1));
      return line.colors[stage];
    }
    return ELEMENTS[mat] ? ELEMENTS[mat].color : ELEMENTS[EL.BEAM].color;
  }

  // Цвет смеси (жидкой, газовой, сыпучих солей) — по составу, см. solColor
  // в data/oxides.js: средневзвешенная смесь цветов вещественных долей
  // (пустота не красит, она делает клетку бледнее — это в cellColor), а
  // чёрные соли поверх тянут её к цвету ржавчины и дальше к чёрному.
  // Раствор 5/5 кислоты и воды — ровно посередине между зелёным и синим.
  partsColor(i) {
    return solColor(this.sim.comp(i));
  }

  // Кислотный остаток — цвета металла: это уже не порода, а осадок
  // продуктов реакции, и дальше он живёт по металлической линейке
  // окисления (реагент переводит его в окисел металла первой стадии).
  // Уровень 1 — светлый металл, уровень 4 — потемневший.
  residueColor(i) {
    const level = Math.max(1, Math.min(4, this.sim.extra[i] || 1));
    const t = (level - 1) / 3;
    const c0 = [166, 168, 178], c1 = [84, 84, 92];
    return [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t];
  }

  // Цвет окисла — по его стадии в СВОЕЙ линейке (камень желтеет в три
  // стадии, металл коричневеет в семь, см. OXIDE_LINE в data/oxides.js), с
  // разбросом от клетки к клетке.
  //
  // Разброс двойной. Яркость даёт обычный shade, общий для всех
  // материалов. Поверх него — разброс НАСЫЩЕННОСТИ: цвет растягивается
  // или стягивается к собственной серой середине, отчего одни клетки
  // выглядят сочнее, другие выцветшими. Без второго окисел смотрелся
  // плоской заливкой: у ржавчины и окалины вся выразительность как раз в
  // том, что соседние пятна разной густоты.
  //
  // Множитель берётся не из Math.random(), а из индекса клетки (см.
  // oxideSaturation).
  oxideColor(i) {
    const sim = this.sim;
    const line = OXIDE_LINE[sim.type[i]];
    if (!line) return ELEMENTS[sim.type[i]].color;
    const stage = Math.max(0, Math.min(line.maxStage, sim.oxideStage(i)));
    const c = line.colors[stage];
    const sat = oxideSaturation(i);
    const mid = (c[0] + c[1] + c[2]) / 3;
    return [mid + (c[0] - mid) * sat, mid + (c[1] - mid) * sat, mid + (c[2] - mid) * sat];
  }

  // Плавящиеся материалы (meltPoint на элементе) постепенно краснеют по
  // мере нагрева — цвет плавно тянется к раскалённому красно-оранжевому
  // (та же логика "чем ближе к порогу плавления, тем сильнее", что и у
  // reactMelt: 0 = обычный цвет материала, 1 = уже на грани, вот-вот
  // расплавится). ratio считается от meltPoint, а не от какого-то общего
  // максимума — у разных материалов разный порог, и на глаз должно быть
  // видно приближение именно к ИХ порогу, а не к абсолютной шкале.
  heatTint(i, r, g, b, meltPoint) {
    const t = this.sim.temp[i];
    // Краснеть материал начинает не от любого тепла, а только перевалив
    // за HEAT_GLOW_FROM. Раньше отсчёт шёл от нуля, и после того как
    // свежая частица стала приносить свои комнатные +20 (см. Sim.spawn),
    // вообще весь камень и металл на карте выглядели чуть подогретыми —
    // хотя ничего не происходило. Ниже порога цвет обычный, выше — тянется
    // к раскалённому тем быстрее, чем ближе к своей точке плавления.
    if (t <= HEAT_GLOW_FROM || meltPoint <= HEAT_GLOW_FROM) return [r, g, b];
    const ratio = Math.min(1, (t - HEAT_GLOW_FROM) / (meltPoint - HEAT_GLOW_FROM));
    return [
      clamp8(r + (255 - r) * ratio),
      clamp8(g + (40 - g) * ratio),
      clamp8(b + (20 - b) * ratio),
    ];
  }

  // Заземлённость клетки как доля от maxStability её материала: 0 (вот-вот
  // осыплется) - красный, 1 (максимум, у самой опоры) - зелёный, посередине
  // - жёлтый. Доля берётся от maxStability, а не от абсолютного значения,
  // чтобы материалы с разным бюджетом (дерево 5, металл 20) сравнивались
  // по одной и той же шкале "насколько близко к пределу", а не по сырым
  // числам.
  stabilityColor(id, stab) {
    const maxS = ELEMENTS[id].maxStability || 1;
    const ratio = Math.max(0, Math.min(1, stab / maxS));
    let r, g;
    if (ratio < 0.5) { r = 255; g = Math.round(255 * (ratio / 0.5)); }
    else { r = Math.round(255 * (1 - (ratio - 0.5) / 0.5)); g = 255; }
    return [r, g, 40];
  }

  // Направление и сила локального ветра как цвет: угол вектора (vx,vy) -
  // оттенок по цветовому кругу (вправо - красный, вверх - жёлто-зелёный,
  // влево - голубой, вниз - сине-фиолетовый), величина - яркость. Совсем
  // слабый ветер (ниже порога) не подсвечивается вовсе (null) — иначе на
  // полностью тихой сцене без единого дуновения весь экран был бы залит
  // одним тусклым цветом вместо обычного вида.
  windColor(x, y) {
    const sim = this.sim;
    const vx = sim.getWindVX(x, y), vy = sim.getWindVY(x, y);
    const mag = Math.sqrt(vx * vx + vy * vy);
    if (mag < 0.02) return null;
    const hue = (Math.atan2(vy, vx) / (2 * Math.PI) + 1) % 1;
    const val = Math.min(1, 0.35 + mag * 0.3);
    return hsvToRgb(hue, 0.85, val);
  }

  // Тепловизор (клавиша 3): температура клетки как цвет — от нейтрального
  // тёмно-серого к раскалённому красно-оранжевому (нагрев, sim.temp>0) или
  // к холодному синему (охлаждение инструментом ниже комнатной, temp<0).
  // Шкалы для жара и холода разные (100 и 50) — ЛКМ/ПКМ инструмента и
  // источники тепла (heatSource~90-100) естественно дают жар в разы
  // сильнее, чем холод обычно уходит от инструмента охлаждения.
  thermalColor(x, y) {
    const t = this.sim.getTemp(x, y);
    if (Math.abs(t) < 1) return null;
    const base = 40;
    if (t > 0) {
      const ratio = Math.min(1, t / 100);
      return [
        Math.round(base + (255 - base) * ratio),
        Math.round(base + (60 - base) * ratio),
        Math.round(base + (20 - base) * ratio),
      ];
    }
    const ratio = Math.min(1, -t / 50);
    return [
      Math.round(base + (20 - base) * ratio),
      Math.round(base + (90 - base) * ratio),
      Math.round(base + (255 - base) * ratio),
    ];
  }

  buildImage() {
    const sim = this.sim;
    const data = this.imageData.data;
    const n = sim.w * sim.h;
    for (let i = 0; i < n; i++) {
      const [r, g, b] = this.cellColor(i);
      const o = i * 4;
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
    }
  }

  debugFlags() {
    return { stability: this.debugStability, wind: this.debugWind, therm: this.debugTherm };
  }

  drawFrame() {
    if (this.gpu && this.gpu.paint(this.debugFlags())) {
      this.frameSource = this.gpu.canvas;
    } else {
      // Нет видеокарты или потерян контекст — рисуем на CPU. Потерянный
      // контекст сам не вернётся, поэтому GPU-путь отключается совсем.
      if (this.gpu) { console.warn('WebGL-контекст потерян, рисуем на CPU'); this.gpu = null; }
      this.buildImage();
      this.offCtx.putImageData(this.imageData, 0, 0);
      this.frameSource = this.off;
    }
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.frameSource, 0, 0, this.sim.w, this.sim.h, 0, 0, this.canvas.width, this.canvas.height);
  }

  // Сверка GPU-отрисовки с CPU-эталоном (cellColor) на текущем кадре и
  // текущих отладочных режимах. Вызывать из консоли браузера:
  // renderer.gpuDiff(). Норма — maxDelta 0 или 1: float в шейдере против
  // double в JS иногда попадает по разные стороны границы округления. В
  // обычном режиме таких пикселей единицы, а в режимах ветра и тепловизора
  // (atan, деление, hsv) — сотни и тысячи, это тоже норма. maxDelta больше
  // 1 — шейдер разошёлся с cellColor.
  gpuDiff() {
    if (!this.gpu) return 'GPU-отрисовка выключена';
    this.gpu.paint(this.debugFlags());
    const gpu = this.gpu.readPixels();
    this.buildImage();
    const cpu = this.imageData.data;
    let differ = 0, maxDelta = 0, first = -1;
    for (let o = 0; o < cpu.length; o += 4) {
      const d = Math.max(Math.abs(cpu[o] - gpu[o]), Math.abs(cpu[o + 1] - gpu[o + 1]), Math.abs(cpu[o + 2] - gpu[o + 2]));
      if (d) { differ++; if (d > maxDelta) maxDelta = d; if (first < 0) first = o / 4; }
    }
    return { differ, maxDelta, first: first < 0 ? null : { x: first % this.sim.w, y: (first / this.sim.w) | 0 } };
  }

  drawBrushOutline(gx, gy, shape, rx, ry) {
    this.drawBrushOutlineAt(gx, gy, shape, rx, ry, 0, 0, this.zoom);
  }

  // То же самое, но в произвольной системе координат (смещение ox,oy и свой
  // масштаб scale вместо this.zoom) — используется для отрисовки наведения
  // кисти внутри окна лупы, в её собственном увеличении.
  drawBrushOutlineAt(gx, gy, shape, rx, ry, ox, oy, scale) {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1;
    this.traceShapeOutline(gx, gy, shape, rx, ry, ox, oy, scale);
    ctx.restore();
  }

  // Контур кисти строго повторяет реально закрашиваемые клетки: для квадрата
  // это просто прямоугольник, а для круга — точная лестничная граница по той
  // же формуле включения, что использует stampBrush (а не гладкий эллипс,
  // который на глаз казался мельче настоящей закрашиваемой области).
  traceShapeOutline(gx, gy, shape, rx, ry, ox = 0, oy = 0, scale = this.zoom) {
    const ctx = this.ctx;
    // Бесконечная клетка (курсор над скрытым полем) — обход от минус
    // бесконечности не кончился бы никогда: так висла страница (input.js,
    // onMouseMove).
    if (!Number.isFinite(gx) || !Number.isFinite(gy) || !Number.isFinite(rx) || !Number.isFinite(ry)) return;
    if (shape !== 'circle') {
      const w = (rx * 2 + 1) * scale, h = (ry * 2 + 1) * scale;
      const cx = ox + (gx + 0.5) * scale, cy = oy + (gy + 0.5) * scale;
      ctx.strokeRect(cx - w / 2, cy - h / 2, w, h);
      return;
    }
    const rx2 = Math.max(rx, 0.5), ry2 = Math.max(ry, 0.5);
    const x0 = Math.floor(gx - rx), x1 = Math.ceil(gx + rx);
    const y0 = Math.floor(gy - ry), y1 = Math.ceil(gy + ry);
    const left = [], right = [];
    for (let y = y0; y <= y1; y++) {
      let xl = null, xr = null;
      for (let x = x0; x <= x1; x++) {
        const dx = (x - gx) / rx2, dy = (y - gy) / ry2;
        if (dx * dx + dy * dy <= 1) { if (xl === null) xl = x; xr = x; }
      }
      if (xl !== null) {
        left.push([ox + xl * scale, oy + y * scale], [ox + xl * scale, oy + (y + 1) * scale]);
        right.push([ox + (xr + 1) * scale, oy + y * scale], [ox + (xr + 1) * scale, oy + (y + 1) * scale]);
      }
    }
    if (!left.length) return;
    ctx.beginPath();
    ctx.moveTo(left[0][0], left[0][1]);
    for (const p of left) ctx.lineTo(p[0], p[1]);
    for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i][0], right[i][1]);
    ctx.closePath();
    ctx.stroke();
  }

  // Заряды (sim/charges.js) поверх поля — только в режиме создания (в игре
  // за протагониста поле рисует js/play.js, и зарядов там не видно).
  // ox, oy, scale и окно (x0..x1, y0..y1) — для лупы.
  drawCharges(ox = 0, oy = 0, scale = this.zoom, x0 = 0, y0 = 0, x1 = this.sim.w - 1, y1 = this.sim.h - 1) {
    const list = this.sim.charges;
    if (!list || !list.length) return;
    const ctx = this.ctx, w = this.sim.w;
    ctx.save();
    // Заряд — волна: рисуется её фронт, зелёным — если заряд несёт снимки
    // камер. Чем меньше у заряда осталось срока, тем он прозрачнее (просьба
    // пользователя: "сигнал становится более прозрачным по мере угасания");
    // совсем не пропадает, чтобы последние шаги ещё было видно.
    for (const c of list) {
      ctx.globalAlpha = Math.max(CHARGE_MIN_ALPHA, 1 - c.count / c.life);
      ctx.fillStyle = c.data ? 'rgb(70,255,110)' : 'rgb(255,232,60)';
      for (const f of c.front) {
        const x = f.i % w, y = (f.i / w) | 0;
        if (x < x0 || x > x1 || y < y0 || y > y1) continue;
        ctx.fillRect(ox + (x - x0) * scale, oy + (y - y0) * scale, scale, scale);
      }
    }
    ctx.restore();
  }

  // Пунктир будущей линии. ox, oy, scale — куда и в каком увеличении:
  // по умолчанию основной канвас, для лупы — её окно. Стирающая линия
  // (ПКМ) — красноватая.
  drawLinePreview(gx0, gy0, gx1, gy1, erase = false, ox = 0, oy = 0, scale = this.zoom) {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = erase ? 'rgba(255,120,110,0.85)' : 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(ox + (gx0 + 0.5) * scale, oy + (gy0 + 0.5) * scale);
    ctx.lineTo(ox + (gx1 + 0.5) * scale, oy + (gy1 + 0.5) * scale);
    ctx.stroke();
    ctx.restore();
  }

  // Картинка прямоугольника поля (для проекции вставки, js/input.js):
  // цвет каждой клетки — как на экране (cellColor), пустота прозрачна
  // (вставка её и не пишет), балка в пустоте видна.
  regionImage(x0, y0, x1, y1) {
    const sim = this.sim, w = x1 - x0 + 1, h = y1 - y0 + 1;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const cx = cv.getContext('2d');
    const img = cx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y0 + y) * sim.w + x0 + x, o = (y * w + x) * 4;
        if (sim.type[i] === EL.EMPTY && !sim.beam[i]) continue;
        const c = this.cellColor(i);
        img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
      }
    }
    cx.putImageData(img, 0, 0);
    return cv;
  }

  // Сколько пикселей канваса приходится на пиксель экрана. Канвас рисуется
  // в полном разрешении поля (576 клеток x 3) и на экране ужимается — у
  // пользователя в 2-4 раза, и линия толщиной в пиксель канваса почти
  // пропадала: рамку выделения для копирования было не видно вовсе (жалоба
  // пользователя). Толщины рамок задаются в пикселях экрана.
  screenScale() {
    const cw = this.canvas.clientWidth;
    return cw > 0 ? Math.max(1, this.canvas.width / cw) : 1;
  }

  // Заметная пунктирная рамка: тёмная подложка и светлый пунктир поверх, в
  // пикселях экрана (screenScale).
  strokeMarquee(x, y, w, h, color) {
    const ctx = this.ctx, k = this.screenScale();
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth = 3 * k;
    ctx.strokeRect(x, y, w, h);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5 * k;
    ctx.setLineDash([6 * k, 4 * k]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
  }

  // Рамка выделения для копирования: пунктир по краю клеток, внутри заливка,
  // у угла — размер в клетках; у вырезания — красноватая. ox, oy, scale и
  // окно (x0, y0) — как у drawCharges (для лупы).
  drawClipSelect(r, cut, ox = 0, oy = 0, scale = this.zoom, x0 = 0, y0 = 0) {
    const ctx = this.ctx, k = this.screenScale();
    const x = ox + (r.x0 - x0) * scale, y = oy + (r.y0 - y0) * scale;
    const w = (r.x1 - r.x0 + 1) * scale, h = (r.y1 - r.y0 + 1) * scale;
    ctx.save();
    ctx.fillStyle = cut ? 'rgba(255,110,100,0.2)' : 'rgba(140,200,255,0.2)';
    ctx.fillRect(x, y, w, h);
    this.strokeMarquee(x, y, w, h, cut ? 'rgb(255,140,130)' : 'rgb(170,215,255)');
    const label = `${r.x1 - r.x0 + 1}×${r.y1 - r.y0 + 1}`;
    ctx.font = `bold ${Math.round(12 * k)}px system-ui, sans-serif`;
    ctx.textBaseline = 'bottom';
    const ty = y - 3 * k > 14 * k ? y - 3 * k : y + h + 15 * k;
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillText(label, x + k, ty + k);
    ctx.fillStyle = cut ? 'rgb(255,160,150)' : 'rgb(190,225,255)';
    ctx.fillText(label, x, ty);
    ctx.restore();
  }

  // Полупрозрачная проекция копии с центром в клетке (gx, gy) — там же,
  // куда её положит вставка (Sim.pasteRegion от левого верхнего угла).
  drawClipPaste(clip, gx, gy, ox = 0, oy = 0, scale = this.zoom, x0 = 0, y0 = 0) {
    const ctx = this.ctx;
    const x = ox + (gx - (clip.w >> 1) - x0) * scale, y = oy + (gy - (clip.h >> 1) - y0) * scale;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = 0.6;
    ctx.drawImage(clip.image, x, y, clip.w * scale, clip.h * scale);
    ctx.globalAlpha = 1;
    this.strokeMarquee(x, y, clip.w * scale, clip.h * scale, 'rgba(255,255,255,0.9)');
    ctx.restore();
  }

  computeZoomBoxRect() {
    const cw = this.canvas.width, ch = this.canvas.height;
    const m = this.zoomBoxMargin, s = this.zoomBoxSize;
    switch (this.zoomBoxCorner) {
      case 'br': return { x: cw - s - m, y: ch - s - m, w: s, h: s };
      case 'bl': return { x: m, y: ch - s - m, w: s, h: s };
      case 'tr': return { x: cw - s - m, y: m, w: s, h: s };
      default: return { x: m, y: m, w: s, h: s };
    }
  }

  static rectsOverlap(a, b) {
    return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
  }

  drawZoomSourceHighlight(gx, gy, capRX, capRY) {
    const ctx = this.ctx, z = this.zoom;
    const x = (gx - capRX) * z, y = (gy - capRY) * z;
    const w = (capRX * 2 + 1) * z, h = (capRY * 2 + 1) * z;
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 200, 40, 0.9)';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  drawZoomLens(gx, gy, capRX, capRY, pinned, brush, linePreview, clip = null) {
    const z = this.zoom;
    const srcRect = {
      x: (gx - capRX) * z, y: (gy - capRY) * z,
      w: (capRX * 2 + 1) * z, h: (capRY * 2 + 1) * z,
    };
    let box = this.computeZoomBoxRect();
    if (Renderer.rectsOverlap(srcRect, box)) {
      const cx = (gx + 0.5) * z, cy = (gy + 0.5) * z;
      const corners = ['tl', 'tr', 'bl', 'br'];
      let best = this.zoomBoxCorner, bestD = -1;
      for (const c of corners) {
        this.zoomBoxCorner = c;
        const r = this.computeZoomBoxRect();
        const rcx = r.x + r.w / 2, rcy = r.y + r.h / 2;
        const d = (rcx - cx) * (rcx - cx) + (rcy - cy) * (rcy - cy);
        if (d > bestD) { bestD = d; best = c; }
      }
      this.zoomBoxCorner = best;
      box = this.computeZoomBoxRect();
    }
    // Запоминаем итоговый прямоугольник и параметры съёмки — по ним input.js
    // определяет наведение мыши прямо на окно лупы и пересчитывает обратно
    // в мировые координаты, чтобы можно было "листать" показываемую область.
    this.lastZoomBoxRect = box;
    this.lastZoomCapture = { gx, gy, capRX, capRY };

    const ctx = this.ctx;
    const capW = capRX * 2 + 1, capH = capRY * 2 + 1;
    const scale = Math.min(box.w / capW, box.h / capH);
    const drawW = capW * scale, drawH = capH * scale;
    const ox = box.x + (box.w - drawW) / 2, oy = box.y + (box.h - drawH) / 2;
    const sim = this.sim;

    ctx.save();
    ctx.fillStyle = '#0a0a0d';
    ctx.fillRect(box.x, box.y, box.w, box.h);

    // Увеличение — кусок уже готовой картинки кадра, растянутый без
    // сглаживания (раньше лупа заново считала цвет каждой клетки и рисовала
    // её отдельным fillRect — до 40 тыс. вызовов за кадр). Клетки за краем
    // поля — чёрные: сперва вся область, поверх — то, что внутри поля.
    ctx.fillStyle = '#000';
    ctx.fillRect(ox, oy, drawW, drawH);
    const sx0 = Math.max(0, gx - capRX), sx1 = Math.min(sim.w - 1, gx + capRX);
    const sy0 = Math.max(0, gy - capRY), sy1 = Math.min(sim.h - 1, gy + capRY);
    if (sx0 <= sx1 && sy0 <= sy1) {
      const cw = sx1 - sx0 + 1, chh = sy1 - sy0 + 1;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.frameSource, sx0, sy0, cw, chh,
        ox + (sx0 - (gx - capRX)) * scale, oy + (sy0 - (gy - capRY)) * scale, cw * scale, chh * scale);
    }

    ctx.strokeStyle = pinned ? 'rgba(255, 200, 40, 0.95)' : 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 2;
    ctx.strokeRect(box.x + 1, box.y + 1, box.w - 2, box.h - 2);
    ctx.strokeStyle = 'rgba(255,60,60,0.95)';
    ctx.lineWidth = 1;
    ctx.strokeRect(ox + capRX * scale, oy + capRY * scale, Math.ceil(scale), Math.ceil(scale));

    // Наведение кисти внутри самой лупы — тем же точным контуром, что и на
    // основном канвасе, но в координатах и увеличении окна лупы, и только
    // если рабочая точка вообще попадает в показываемую лупой область.
    // Заряды — и в лупе.
    if (sx0 <= sx1 && sy0 <= sy1) this.drawLighting(ox + (sx0 - (gx - capRX)) * scale, oy + (sy0 - (gy - capRY)) * scale, scale, sx0, sy0, sx1, sy1);
    if (sx0 <= sx1 && sy0 <= sy1) this.drawMonitorGlow(ox + (sx0 - (gx - capRX)) * scale, oy + (sy0 - (gy - capRY)) * scale, scale, sx0, sy0, sx1, sy1);
    if (sx0 <= sx1 && sy0 <= sy1) this.drawCharges(ox + (sx0 - (gx - capRX)) * scale, oy + (sy0 - (gy - capRY)) * scale, scale, sx0, sy0, sx1, sy1);
    // Точки спавна и респавна — и в лупе (их не было видно под увеличением).
    if (sx0 <= sx1 && sy0 <= sy1) this.drawMarks(ox + (sx0 - (gx - capRX)) * scale, oy + (sy0 - (gy - capRY)) * scale, scale, sx0, sy0, sx1, sy1, this.markNames);
    // Разметка протягиваемой линии — и в лупе (просьба пользователя), в её
    // координатах и увеличении, обрезанная окном лупы.
    // Рамка выделения и проекция вставки — и в лупе (просьба пользователя:
    // "голограмма вставляемого объекта не видна в лупе"), обрезанные её окном.
    if (clip && (clip.clipSelect || clip.clipPaste)) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(ox, oy, drawW, drawH);
      ctx.clip();
      const bx = ox - (gx - capRX) * scale, by = oy - (gy - capRY) * scale;
      if (clip.clipSelect) this.drawClipSelect(clip.clipSelect, clip.clipCut, bx, by, scale);
      if (clip.clipPaste) this.drawClipPaste(clip.clipPaste.clip, clip.clipPaste.gx, clip.clipPaste.gy, bx, by, scale);
      ctx.restore();
    }
    if (linePreview) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(ox, oy, drawW, drawH);
      ctx.clip();
      const bx = ox - (gx - capRX) * scale, by = oy - (gy - capRY) * scale;
      this.drawLinePreview(linePreview.x0, linePreview.y0, linePreview.x1, linePreview.y1, linePreview.erase, bx, by, scale);
      ctx.restore();
    }
    if (brush) {
      const lgx = brush.gx - gx + capRX, lgy = brush.gy - gy + capRY;
      if (Math.abs(brush.gx - gx) <= capRX + brush.rx && Math.abs(brush.gy - gy) <= capRY + brush.ry) {
        this.drawBrushOutlineAt(lgx, lgy, brush.shape, brush.rx, brush.ry, ox, oy, scale);
      }
    }
    ctx.restore();
  }

  render(cursor) {
    this.debugStability = !!cursor.debugStability;
    this.debugWind = !!cursor.debugWind;
    this.debugTherm = !!cursor.debugTherm;
    this.drawFrame();
    this.updateLighting();
    if (this.lightOn) {
      this.buildLightImage();
      // Весь канвас: масштаб по ширине и высоте может различаться.
      this.paintLight(0, 0, this.sim.w - 1, this.sim.h - 1, 0, 0, this.canvas.width, this.canvas.height);
    }
    this.updateMonitorGlow();
    this.drawMonitorGlow();
    this.drawMarks(0, 0, this.zoom, 0, 0, this.sim.w - 1, this.sim.h - 1, this.markNames);
    this.drawCharges();
    if (cursor.clipSelect) this.drawClipSelect(cursor.clipSelect, cursor.clipCut);
    if (cursor.clipPaste) this.drawClipPaste(cursor.clipPaste.clip, cursor.clipPaste.gx, cursor.clipPaste.gy);
    if (cursor.linePreview) {
      const lp = cursor.linePreview;
      this.drawLinePreview(lp.x0, lp.y0, lp.x1, lp.y1, lp.erase);
      this.drawBrushOutline(lp.x1, lp.y1, cursor.brushShape, cursor.brushRX, cursor.brushRY);
    } else if (cursor.showBrush) {
      this.drawBrushOutline(cursor.gx, cursor.gy, cursor.brushShape, cursor.brushRX, cursor.brushRY);
    }
    if (cursor.zoomActive || cursor.zoomPinned) {
      const hovering = cursor.zoomHoverGX !== null && cursor.zoomHoverGX !== undefined;
      // Что именно показывает лупа (центр захвата и подсветка источника на
      // основном канвасе) — это ТОЛЬКО live-слежение за курсором или
      // зафиксированная точка, и НИКОГДА наведение на саму проекцию лупы.
      // Раньше наведение на уже зафиксированную лупу подменяло эту точку на
      // zoomHoverGX/GY, из-за чего показываемая область визуально "ехала"
      // за мышкой прямо внутри собственного окна — притом что "зафиксировано"
      // как раз и должно означать "не двигается". Наведение по-прежнему
      // определяет, КУДА рисовать (см. brush ниже) — просто больше не влияет
      // на то, что лупа показывает.
      const zx = cursor.zoomPinned ? cursor.zoomPinnedGX : cursor.gx;
      const zy = cursor.zoomPinned ? cursor.zoomPinnedGY : cursor.gy;
      this.drawZoomSourceHighlight(zx, zy, cursor.zoomRX, cursor.zoomRY);
      // Рабочая точка кисти для отрисовки внутри лупы: при наведении на саму
      // лупу — та точка, что она сейчас показывает под курсором; иначе, во
      // время протяжки линии — текущий конец линии; иначе — обычная позиция
      // курсора на основном канвасе (для live-лупы она и так совпадает с zx,zy).
      let brush = null;
      if (cursor.showBrush) {
        let bgx, bgy;
        if (hovering) { bgx = cursor.zoomHoverGX; bgy = cursor.zoomHoverGY; }
        else if (cursor.linePreview) { bgx = cursor.linePreview.x1; bgy = cursor.linePreview.y1; }
        else { bgx = cursor.gx; bgy = cursor.gy; }
        brush = { gx: bgx, gy: bgy, shape: cursor.brushShape, rx: cursor.brushRX, ry: cursor.brushRY };
      }
      this.drawZoomLens(zx, zy, cursor.zoomRX, cursor.zoomRY, cursor.zoomPinned, brush, cursor.linePreview, cursor);
    } else {
      this.lastZoomBoxRect = null;
    }

    if (this.debugStability || this.debugWind || this.debugTherm) {
      const hovering = cursor.zoomHoverGX !== null && cursor.zoomHoverGX !== undefined;
      if (hovering) this.drawDebugInfo(cursor.zoomHoverGX, cursor.zoomHoverGY);
      else if (cursor.showBrush) this.drawDebugInfo(cursor.gx, cursor.gy);
    }
  }

  stabilityInfoText(gx, gy) {
    const sim = this.sim;
    const i = sim.idx(gx, gy);
    const id = sim.type[i];
    if (id === EL.EMPTY) return 'Пусто';
    if (!isStructural(id)) return ELEMENTS[id].name;
    const maxS = ELEMENTS[id].maxStability || 0;
    return `${ELEMENTS[id].name}: заземлённость ${sim.stability[i]}/${maxS}`;
  }

  windInfoText(gx, gy) {
    const sim = this.sim;
    const vx = sim.getWindVX(gx, gy), vy = sim.getWindVY(gx, gy);
    const mag = Math.sqrt(vx * vx + vy * vy);
    return `Давление: ${mag.toFixed(2)} (vx ${vx.toFixed(2)}, vy ${vy.toFixed(2)})`;
  }

  tempInfoText(gx, gy) {
    return `Температура: ${this.sim.getTemp(gx, gy).toFixed(1)}`;
  }

  // Значения под курсором для включённых режимов отладки (заземлённость,
  // давление воздуха, температура) - в верхнем левом углу канваса, по
  // строке на режим.
  drawDebugInfo(gx, gy) {
    const sim = this.sim;
    if (!sim.inBounds(gx, gy)) return;
    const lines = [];
    if (this.debugStability) lines.push(this.stabilityInfoText(gx, gy));
    if (this.debugWind) lines.push(this.windInfoText(gx, gy));
    if (this.debugTherm) lines.push(this.tempInfoText(gx, gy));
    if (!lines.length) return;

    const ctx = this.ctx;
    ctx.save();
    ctx.font = '14px monospace';
    const padX = 8, padY = 6, lineH = 18;
    let maxW = 0;
    for (const line of lines) maxW = Math.max(maxW, ctx.measureText(line).width);
    const w = Math.ceil(maxW) + padX * 2;
    const h = lineH * lines.length + padY * 2;
    const x = 8, y = 8;
    ctx.fillStyle = 'rgba(10,10,13,0.85)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.fillStyle = '#e8e8ee';
    ctx.textBaseline = 'middle';
    for (let k = 0; k < lines.length; k++) {
      ctx.fillText(lines[k], x + padX, y + padY + lineH * k + lineH / 2);
    }
    ctx.restore();
  }
}
