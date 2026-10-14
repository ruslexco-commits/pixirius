'use strict';

// Рисунок живых (протагонист и человек — тела из многих клеток, см.
// sim/creature.js). Тело рисуется не полем (видеокарта и CPU-путь красят клетки
// живых как пустоту), а спрайтом поверх него: так оно движется плавно, долями
// клетки (просьба пользователя: "плавно перемещаться"), и каждая клетка тела
// может менять рисунок сама — кровавую, обгоревшую и разъеденную кислотой
// (просьба пользователя: "попиксельно менял текстуру на кровавую, обгоревшую
// и/или разжиженную кислотой").
//
// Цвет клетки: заливка — цвет игрока (протагонист игрока мультиплеера — его
// цветом, одиночный — жёлтым) или кожи (человек), бортик — тот же, но темнее.
// Затем по клетке накладываются её поля: отравление (stain) — к жёлтому, рана
// (dirt) — к тёмно-красному пятнами, ожог (burn) — к обугленному с тлеющим
// краем, кислотная язва (acid) — к ядовито-зелёному, и чем больше, тем
// прозрачнее клетка (растворяется). Пятна у клеток не одинаковы: у каждой
// клетки своя "случайность" (creatureNoise), по ней уровень поля решает,
// проступит ли пятно, — так рисунок рваный, а не ровная заливка. Мёртвое тело —
// серо-коричневое.

const PERSON_SKIN = [236, 226, 210];
const PERSON_DEAD_COLOR = [64, 58, 54];
const PERSON_EDGE_DARK = 0.38;
const WOUND_COLOR = [150, 8, 14];
const SCORCH_COLOR = [34, 28, 24];
const EMBER_COLOR = [190, 80, 16];
const ACID_SKIN_COLOR = [98, 196, 52];
const POISON_SKIN_COLOR = [232, 214, 40];
// За сколько мс осядет 63% расстояния до настоящего места (плавность
// движения тела); дальше CREATURE_SNAP клеток — сразу.
const CREATURE_SMOOTH_MS = 55;
const CREATURE_SNAP = 8;

// Детерминированная "случайность" клетки 0..1: по номеру части и номеру
// живого (не Math.random — рисунок не должен мерцать от кадра к кадру).
function creatureNoise(k, id, salt) {
  let h = Math.imul(k * 73856093 ^ id * 19349663 ^ salt * 83492791, 0x9E3779B1);
  h ^= h >>> 15; h = Math.imul(h, 0x85EBCA6B); h ^= h >>> 13;
  return ((h >>> 8) & 1023) / 1023;
}

// Плавное положение главных клеток живых: ключ (тип и номер) → { x, y } в
// клетках, дробные.
class CreatureAnim {
  constructor() { this.pos = new Map(); this.last = 0; this.dt = 0; this.seen = new Set(); }

  begin(now) {
    this.dt = this.last ? Math.min(100, now - this.last) : 0;
    this.last = now;
    this.seen.clear();
  }

  at(key, x, y) {
    let s = this.pos.get(key);
    if (!s || Math.abs(x - s.x) > CREATURE_SNAP || Math.abs(y - s.y) > CREATURE_SNAP) {
      s = { x, y };
      this.pos.set(key, s);
    } else if (this.dt > 0) {
      const k = 1 - Math.exp(-this.dt / CREATURE_SMOOTH_MS);
      s.x += (x - s.x) * k;
      s.y += (y - s.y) * k;
    }
    this.seen.add(key);
    return s;
  }

  end() {
    if (this.pos.size === this.seen.size) return;
    for (const key of this.pos.keys()) if (!this.seen.has(key)) this.pos.delete(key);
  }
}

// Базовый цвет заливки живого типа t с номером id.
function creatureBaseColor(sim, t, id) {
  if (t === EL.HUMAN) return PERSON_SKIN;
  if (id > 0 && id < 16 && sim.playerColors && sim.playerColors[id]) return sim.playerColors[id];
  return ELEMENTS[EL.PROTAGONIST].color;
}

// Главные клетки всех живых на поле (по полю, раз в кадр).
function creaturePivots(sim) {
  const out = [], type = sim.type, extra = sim.extra, n = type.length;
  for (let i = 0; i < n; i++) {
    const t = type[i];
    if ((t === EL.HUMAN || t === EL.PROTAGONIST) && (extra[i] & 127) === PERSON_PIVOT) out.push(i);
  }
  return out;
}

const _cc = [0, 0, 0, 1];

// Цвет клетки тела (часть k, клетка поля c) в _cc = [r, g, b, alpha].
function creaturePartColor(sim, base, k, c, id, dead) {
  const edge = PERSON_EDGE[k] === 1;
  let r = base[0], g = base[1], b = base[2];
  if (dead) {
    r = r * 0.25 + PERSON_DEAD_COLOR[0] * 0.75; g = g * 0.25 + PERSON_DEAD_COLOR[1] * 0.75; b = b * 0.25 + PERSON_DEAD_COLOR[2] * 0.75;
  }
  // Лёгкая неровность оттенка, как у вещества.
  const sh = (creatureNoise(k, id, 1) - 0.5) * 14;
  r += sh; g += sh; b += sh;
  if (edge) { r *= PERSON_EDGE_DARK; g *= PERSON_EDGE_DARK; b *= PERSON_EDGE_DARK; }
  let alpha = 1;
  const stain = sim.stain[c];
  if (stain) {
    const t = stain / 255 * 0.7;
    r += (POISON_SKIN_COLOR[0] - r) * t; g += (POISON_SKIN_COLOR[1] - g) * t; b += (POISON_SKIN_COLOR[2] - b) * t;
  }
  const dirt = sim.dirt[c];
  if (dirt) {
    // Рана: пятно проступает там, где её уровень выше "случайности" клетки.
    const t = Math.max(0, Math.min(1, (dirt / 255 - creatureNoise(k, id, 2) * 0.55) * 2.2)) * 0.92;
    r += (WOUND_COLOR[0] - r) * t; g += (WOUND_COLOR[1] - g) * t; b += (WOUND_COLOR[2] - b) * t;
  }
  const burn = sim.burn[c];
  if (burn) {
    const level = burn / 255, n = creatureNoise(k, id, 3);
    const t = Math.max(0, Math.min(1, (level - n * 0.45) * 2));
    // Обугленное; у края пятна, пока жар ещё не ушёл, — тлеющий оттенок.
    r += (SCORCH_COLOR[0] - r) * t; g += (SCORCH_COLOR[1] - g) * t; b += (SCORCH_COLOR[2] - b) * t;
    const ember = t > 0 && t < 0.85 ? (1 - Math.abs(t - 0.4) / 0.45) * 0.5 : 0;
    if (ember > 0) { r += (EMBER_COLOR[0] - r) * ember; g += (EMBER_COLOR[1] - g) * ember; b += (EMBER_COLOR[2] - b) * ember; }
  }
  const acid = sim.acid[c];
  if (acid) {
    const level = acid / 255, n = creatureNoise(k, id, 4);
    const t = Math.max(0, Math.min(1, (level - n * 0.35) * 1.8));
    r += (ACID_SKIN_COLOR[0] - r) * t * 0.85; g += (ACID_SKIN_COLOR[1] - g) * t * 0.85; b += (ACID_SKIN_COLOR[2] - b) * t * 0.85;
    // Разжижается: клетка становится прозрачной.
    alpha = 1 - 0.55 * t * t;
  }
  _cc[0] = r < 0 ? 0 : r > 255 ? 255 : r;
  _cc[1] = g < 0 ? 0 : g > 255 ? 255 : g;
  _cc[2] = b < 0 ? 0 : b > 255 ? 255 : b;
  _cc[3] = alpha;
  return _cc;
}

// Нарисовать тело с главной клеткой p в ctx: (px, py) — левый верх главной
// клетки на экране (дробные), cell — размер клетки на экране. visible(c) —
// рисовать ли клетку c (null — все). Края клеток округляются так, чтобы
// между соседними не было щелей.
function drawCreatureSprite(ctx, sim, p, px, py, cell, visible) {
  const cells = sim.creatureCells(p);
  const t = sim.type[p], id = sim.life[p], dead = sim.creatureDeadAt(p);
  const base = creatureBaseColor(sim, t, id);
  for (let k = 0; k < PERSON_N; k++) {
    const c = cells[k];
    if (c < 0 || (visible && !visible(c))) continue;
    const col = creaturePartColor(sim, base, k, c, id, dead);
    const x0 = Math.round(px + PERSON_DX[k] * cell), x1 = Math.round(px + (PERSON_DX[k] + 1) * cell);
    const y0 = Math.round(py + PERSON_DY[k] * cell), y1 = Math.round(py + (PERSON_DY[k] + 1) * cell);
    ctx.globalAlpha = col[3];
    ctx.fillStyle = `rgb(${col[0] | 0},${col[1] | 0},${col[2] | 0})`;
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  }
  ctx.globalAlpha = 1;
}
