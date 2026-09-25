'use strict';

// Отрисовка поля на видеокарте (WebGL2). Цвет каждой клетки считает
// фрагментный шейдер — по одному пикселю на клетку, в отдельный канвас
// размером w x h, который Renderer затем растягивает на основной канвас
// так же, как раньше растягивал CPU-картинку.
//
// Зачем: на CPU Renderer.buildImage обходил все ~187 тыс. клеток каждый
// кадр, собирая цвет каждой из массива (замер: ~12 мс на кадр — почти
// столько же, сколько сам шаг симуляции). Здесь JS только отдаёт видеокарте
// поля мира: texSubImage2D прямо из typed-массивов Sim, без переупаковки.
//
// ВАЖНО: шейдер — точная копия Renderer.cellColor (render.js), которая
// остаётся запасным путём (нет WebGL2, контекст потерян, страница открыта
// с ?cpu). Правя цвет клетки, правь ОБА места и сверяй их в консоли
// браузера: renderer.gpuDiff() — число пикселей, где GPU и CPU разошлись.
// Все формулы в шейдере повторяют CPU-версию строка в строку, с тем же
// округлением (Math.round -> floor(x + 0.5), итоговая запись в
// Uint8ClampedArray -> roundEven).

const GPU_VERTEX_SRC = `#version 300 es
void main() {
  // Один треугольник на весь экран, без буферов вершин.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const GPU_FRAGMENT_SRC = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
precision highp isampler2D;

uniform usampler2D uType;
uniform usampler2D uExtra;
uniform usampler2D uBeam;
uniform usampler2D uSol;
uniform isampler2D uShade;
uniform isampler2D uLife;
uniform isampler2D uStab;
uniform sampler2D uTemp;
uniform sampler2D uWindX;
uniform sampler2D uWindY;
uniform sampler2D uSat;
// Таблица свойств элементов, столбец = id элемента (см. buildElementTable):
//   строка 0: базовый цвет rgb, вид раскраски (KIND_*)
//   строка 1: meltPoint (0 = не плавится), структурный 0/1,
//             maxStability (или 1), есть состав долей 0/1
//   строка 2: последняя стадия окисла, стадия задана типом 0/1
//   строка 3+s: цвет стадии окисла s
uniform sampler2D uElem;

uniform ivec2 uSize;
uniform int uAirCell;
uniform ivec2 uAirSize;
uniform bool uDebugStab;
uniform bool uDebugTherm;
uniform bool uDebugWind;
uniform vec3 uPartColor[6];
uniform vec3 uBeamColor;

out vec4 outColor;

const vec3 BG = vec3(14.0, 14.0, 18.0);
const int KIND_PARTS = 1;
const int KIND_RESIDUE = 2;
const int KIND_OXIDE = 3;
const int KIND_HUMAN = 4;
const int KIND_FIRE = 5;

vec3 clamp8(vec3 c) { return clamp(c, 0.0, 255.0); }
vec3 jsRound(vec3 c) { return floor(c + 0.5); }
float jsRound(float c) { return floor(c + 0.5); }

vec3 hsvToRgb(float h, float s, float v) {
  float fi = floor(h * 6.0);
  float f = h * 6.0 - fi;
  float p = v * (1.0 - s);
  float q = v * (1.0 - f * s);
  float t = v * (1.0 - (1.0 - f) * s);
  int i = int(fi) % 6;
  vec3 c;
  if (i == 0) c = vec3(v, t, p);
  else if (i == 1) c = vec3(q, v, p);
  else if (i == 2) c = vec3(p, v, t);
  else if (i == 3) c = vec3(p, q, v);
  else if (i == 4) c = vec3(t, p, v);
  else c = vec3(v, p, q);
  return jsRound(c * 255.0);
}

// Renderer.windColor; false — ветер слабее порога, подсветки нет.
bool windColor(ivec2 p, out vec3 col) {
  ivec2 a = min(uAirSize - 1, p / uAirCell);
  float vx = texelFetch(uWindX, a, 0).r;
  float vy = texelFetch(uWindY, a, 0).r;
  float mag = sqrt(vx * vx + vy * vy);
  if (mag < 0.02) return false;
  float hue = mod(atan(vy, vx) / (2.0 * 3.141592653589793) + 1.0, 1.0);
  float val = min(1.0, 0.35 + mag * 0.3);
  col = hsvToRgb(hue, 0.85, val);
  return true;
}

// Renderer.thermalColor.
bool thermalColor(float t, out vec3 col) {
  if (abs(t) < 1.0) return false;
  float base = 40.0;
  if (t > 0.0) {
    float ratio = min(1.0, t / 100.0);
    col = jsRound(vec3(base) + (vec3(255.0, 60.0, 20.0) - base) * ratio);
  } else {
    float ratio = min(1.0, -t / 50.0);
    col = jsRound(vec3(base) + (vec3(20.0, 90.0, 255.0) - base) * ratio);
  }
  return true;
}

// Renderer.stabilityColor.
vec3 stabilityColor(float stab, float maxS) {
  float ratio = clamp(stab / maxS, 0.0, 1.0);
  float r, g;
  if (ratio < 0.5) { r = 255.0; g = jsRound(255.0 * (ratio / 0.5)); }
  else { r = jsRound(255.0 * (1.0 - (ratio - 0.5) / 0.5)); g = 255.0; }
  return vec3(r, g, 40.0);
}

// Renderer.blendColor.
vec3 blendColor(vec3 c, vec3 tint, float weight) {
  return clamp8(jsRound(c + (tint - c) * weight));
}

// Renderer.partsColor.
vec3 partsColor(uint comp) {
  float matter = 10.0 - float(comp & 15u);
  if (matter <= 0.0) return BG;
  vec3 acc = vec3(0.0);
  for (int k = 1; k < 6; k++) acc += uPartColor[k] * float((comp >> uint(4 * k)) & 15u);
  return acc / matter;
}

// Renderer.residueColor.
vec3 residueColor(uint extra) {
  float level = clamp(extra == 0u ? 1.0 : float(extra), 1.0, 4.0);
  float t = (level - 1.0) / 3.0;
  vec3 c0 = vec3(166.0, 168.0, 178.0), c1 = vec3(84.0, 84.0, 92.0);
  return c0 + (c1 - c0) * t;
}

// Renderer.oxideColor (стадия — как в Sim.oxideStage).
vec3 oxideColor(int id, uint extra, ivec2 p) {
  vec4 e2 = texelFetch(uElem, ivec2(id, 2), 0);
  int maxStage = int(e2.x + 0.5);
  int stage = e2.y > 0.5 ? maxStage : (extra == 0u ? 1 : int(extra));
  stage = clamp(stage, 0, maxStage);
  vec3 c = texelFetch(uElem, ivec2(id, 3 + stage), 0).rgb;
  float sat = texelFetch(uSat, p, 0).r;
  float mid = (c.r + c.g + c.b) / 3.0;
  return mid + (c - mid) * sat;
}

void emit(vec3 c) { outColor = vec4(roundEven(clamp8(c)) / 255.0, 1.0); }

void main() {
  ivec2 p = ivec2(int(gl_FragCoord.x), uSize.y - 1 - int(gl_FragCoord.y));
  int i = p.y * uSize.x + p.x;
  int id = int(texelFetch(uType, p, 0).r);
  vec4 e0 = texelFetch(uElem, ivec2(id, 0), 0);
  vec4 e1 = texelFetch(uElem, ivec2(id, 1), 0);

  if (uDebugStab && e1.y > 0.5) {
    emit(stabilityColor(float(texelFetch(uStab, p, 0).r), e1.z));
    return;
  }

  vec3 tint;
  if (id == 0) {
    if (uDebugTherm) { if (thermalColor(texelFetch(uTemp, p, 0).r, tint)) { emit(tint); return; } }
    else if (uDebugWind) { if (windColor(p, tint)) { emit(tint); return; } }
    if (texelFetch(uBeam, p, 0).r != 0u) {
      float sh = float(texelFetch(uShade, p, 0).r);
      emit(clamp8(BG + (uBeamColor - BG) * 0.42 + sh));
    } else {
      emit(BG);
    }
    return;
  }

  int kind = int(e0.w + 0.5);
  uint extra = texelFetch(uExtra, p, 0).r;
  vec3 base;
  if (kind == KIND_PARTS) base = partsColor(texelFetch(uSol, p, 0).r);
  else if (kind == KIND_RESIDUE) base = residueColor(extra);
  else if (kind == KIND_OXIDE) base = oxideColor(id, extra, p);
  else if (kind == KIND_HUMAN && extra != 0u) base = vec3(58.0, 52.0, 48.0);
  else base = e0.rgb;
  vec3 c = clamp8(base + float(texelFetch(uShade, p, 0).r));

  if (e1.w > 0.5) {
    uint v = texelFetch(uSol, p, 0).r & 15u;
    if (v != 0u) {
      float k = 1.0 - (float(v) / 10.0) * 0.75;
      c = clamp8(BG + (c - BG) * k);
    }
  }

  float temp = texelFetch(uTemp, p, 0).r;
  if (kind == KIND_FIRE) {
    int flick = (texelFetch(uLife, p, 0).r * 37 + i * 13) % 46;
    c.r = clamp(c.r + float(flick), 0.0, 255.0);
    c.g = clamp(c.g + float(flick >> 1), 0.0, 255.0);
  } else if (e1.x > 0.0 && !uDebugTherm) {
    // Renderer.heatTint
    float meltPoint = e1.x;
    if (temp > ${HEAT_GLOW_FROM.toFixed(1)} && meltPoint > ${HEAT_GLOW_FROM.toFixed(1)}) {
      float ratio = min(1.0, (temp - ${HEAT_GLOW_FROM.toFixed(1)}) / (meltPoint - ${HEAT_GLOW_FROM.toFixed(1)}));
      c = clamp8(c + (vec3(255.0, 40.0, 20.0) - c) * ratio);
    }
  }

  if (uDebugTherm) { if (thermalColor(temp, tint)) c = blendColor(c, tint, 0.55); }
  else if (uDebugWind) { if (windColor(p, tint)) c = blendColor(c, tint, 0.55); }
  emit(c);
}`;

class GpuCellPainter {
  // null — WebGL2 недоступен или шейдер не собрался; тогда Renderer
  // рисует по-старому, на CPU.
  static create(sim) {
    try {
      return new GpuCellPainter(sim);
    } catch (err) {
      console.warn('Отрисовка на GPU недоступна, рисуем на CPU:', err.message);
      return null;
    }
  }

  constructor(sim) {
    this.sim = sim;
    this.canvas = document.createElement('canvas');
    this.canvas.width = sim.w;
    this.canvas.height = sim.h;
    // preserveDrawingBuffer: картинку читают после отрисовки (drawImage на
    // основной канвас, лупа, gpuDiff) — буфер не должен очищаться раньше.
    const gl = this.canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false, alpha: false });
    if (!gl) throw new Error('нет WebGL2');
    this.gl = gl;
    this.lost = false;
    this.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });

    this.program = this.buildProgram(GPU_VERTEX_SRC, GPU_FRAGMENT_SRC);
    gl.useProgram(this.program);
    gl.bindVertexArray(gl.createVertexArray());
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.viewport(0, 0, sim.w, sim.h);

    const w = sim.w, h = sim.h;
    const I = gl;
    // Поля мира: [uniform, внутренний формат, формат, тип, ширина, высота].
    // Каждая текстура закреплена за своим текстурным блоком навсегда —
    // кадр только перезаливает данные.
    this.tex = {};
    const spec = {
      uType: [I.R8UI, I.RED_INTEGER, I.UNSIGNED_BYTE, w, h],
      uExtra: [I.R8UI, I.RED_INTEGER, I.UNSIGNED_BYTE, w, h],
      uBeam: [I.R8UI, I.RED_INTEGER, I.UNSIGNED_BYTE, w, h],
      uSol: [I.R32UI, I.RED_INTEGER, I.UNSIGNED_INT, w, h],
      uShade: [I.R8I, I.RED_INTEGER, I.BYTE, w, h],
      uLife: [I.R16I, I.RED_INTEGER, I.SHORT, w, h],
      uStab: [I.R16I, I.RED_INTEGER, I.SHORT, w, h],
      uTemp: [I.R32F, I.RED, I.FLOAT, w, h],
      uWindX: [I.R32F, I.RED, I.FLOAT, sim.airW, sim.airH],
      uWindY: [I.R32F, I.RED, I.FLOAT, sim.airW, sim.airH],
      uSat: [I.R32F, I.RED, I.FLOAT, w, h],
      uElem: [I.RGBA32F, I.RGBA, I.FLOAT, 64, ELEM_TABLE_ROWS],
    };
    let unit = 0;
    for (const [name, [internal, format, type, tw, th]] of Object.entries(spec)) {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texStorage2D(gl.TEXTURE_2D, 1, internal, tw, th);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform1i(gl.getUniformLocation(this.program, name), unit);
      this.tex[name] = { unit, format, type, w: tw, h: th };
      unit++;
    }

    // Неизменное за всю игру заливается один раз.
    this.upload('uElem', buildElementTable());
    this.upload('uSat', oxideSaturationField(w, h));

    const u = (name) => gl.getUniformLocation(this.program, name);
    gl.uniform2i(u('uSize'), w, h);
    gl.uniform1i(u('uAirCell'), sim.airCell);
    gl.uniform2i(u('uAirSize'), sim.airW, sim.airH);
    gl.uniform3fv(u('uPartColor'), new Float32Array(PART_COLOR.flat()));
    gl.uniform3fv(u('uBeamColor'), new Float32Array(ELEMENTS[EL.BEAM].color));
    this.uDebugStab = u('uDebugStab');
    this.uDebugTherm = u('uDebugTherm');
    this.uDebugWind = u('uDebugWind');
  }

  buildProgram(vsSrc, fsSrc) {
    const gl = this.gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('шейдер: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('программа: ' + gl.getProgramInfoLog(p));
    return p;
  }

  upload(name, data) {
    const gl = this.gl, t = this.tex[name];
    gl.activeTexture(gl.TEXTURE0 + t.unit);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, t.w, t.h, t.format, t.type, data);
  }

  // Рисует текущее состояние мира в this.canvas. false — контекст потерян,
  // и кадр надо рисовать на CPU.
  paint(debug) {
    if (this.lost || this.gl.isContextLost()) return false;
    const gl = this.gl, sim = this.sim;
    this.upload('uType', sim.type);
    this.upload('uExtra', sim.extra);
    this.upload('uBeam', sim.beam);
    this.upload('uSol', sim.sol);
    this.upload('uShade', sim.shade);
    this.upload('uLife', sim.life);
    // sim.temp каждый кадр меняется местами с буфером (см. updateTemp) —
    // поэтому берётся заново, а не запоминается.
    this.upload('uTemp', sim.temp);
    // Эти поля нужны только отладочным режимам — без них не заливаются.
    if (debug.stability) this.upload('uStab', sim.stability);
    if (debug.wind && !debug.therm) {
      this.upload('uWindX', sim.windVXFrame);
      this.upload('uWindY', sim.windVYFrame);
    }
    gl.uniform1i(this.uDebugStab, debug.stability ? 1 : 0);
    gl.uniform1i(this.uDebugTherm, debug.therm ? 1 : 0);
    gl.uniform1i(this.uDebugWind, debug.wind ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return true;
  }

  // Пиксели последнего кадра, RGBA, строки сверху вниз (как у ImageData).
  readPixels() {
    const gl = this.gl, w = this.sim.w, h = this.sim.h;
    const raw = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    const out = new Uint8Array(raw.length);
    const row = w * 4;
    for (let y = 0; y < h; y++) out.set(raw.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    return out;
  }
}

// Строки таблицы uElem: 3 служебные + по строке на стадию окисла (самая
// длинная линейка — у земли, 10 стадий, то есть 11 цветов).
const ELEM_TABLE_ROWS = 3 + 11;
const KIND_PARTS = 1, KIND_RESIDUE = 2, KIND_OXIDE = 3, KIND_HUMAN = 4, KIND_FIRE = 5;

// oxideSaturation (render.js) для всех клеток — считается в JS один раз,
// чтобы GPU брал ровно те же множители, что и CPU.
function oxideSaturationField(w, h) {
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = oxideSaturation(i);
  return out;
}

function buildElementTable() {
  const data = new Float32Array(64 * ELEM_TABLE_ROWS * 4);
  const set = (id, row, a, b, c, d) => { const o = (row * 64 + id) * 4; data[o] = a; data[o + 1] = b; data[o + 2] = c; data[o + 3] = d; };
  for (let id = 1; id < 64; id++) {
    const el = ELEMENTS[id];
    if (!el) continue;
    let kind = 0;
    if (id === EL.SOLUTION || id === EL.VAPOR) kind = KIND_PARTS;
    else if (id === EL.ACID_RESIDUE) kind = KIND_RESIDUE;
    else if (isOxide(id) && OXIDE_LINE[id]) kind = KIND_OXIDE;
    else if (id === EL.HUMAN) kind = KIND_HUMAN;
    else if (id === EL.FIRE) kind = KIND_FIRE;
    set(id, 0, el.color[0], el.color[1], el.color[2], kind);
    set(id, 1, el.meltPoint || 0, isStructural(id) ? 1 : 0, el.maxStability || 1, hasComposition(id) ? 1 : 0);
    const line = OXIDE_LINE[id];
    if (kind === KIND_OXIDE) {
      // Как в Sim.oxideStage: у рыхлой стадии (кроме линеек, сыпучих
      // целиком) стадия задана самим типом, у остальных лежит в extra.
      const fixed = id === line.loose && !line.allLoose;
      set(id, 2, line.maxStage, fixed ? 1 : 0, 0, 0);
      for (let s = 0; s <= line.maxStage; s++) set(id, 3 + s, line.colors[s][0], line.colors[s][1], line.colors[s][2], 0);
    }
  }
  return data;
}
