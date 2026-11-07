'use strict';

// Отдельные объекты (просьба пользователя: «когда объект отсоединяется, он
// становится самостоятельным: если уронить куб на поверхность, он не сольётся с
// ней, а будет отдельным объектом; на клавише 4 видны все отдельные объекты»).
//
// Объект — не сущность, а метка клетки: поле obj (PARTICLE_FIELDS, едет с
// частицей), номер объекта, 0 — местность. Метку получает тело, оторвавшееся и
// упавшее целиком (fallBody, sim/body.js: от BODY_MIN клеток); дальше она живёт
// на клетках, пока их не сотрут, не расплавят или не склеят. Объект — связная
// (4 соседа) группа клеток с одним номером: разорвалась на части — каждая часть
// получает свой номер (objScan), то есть «отсоединившееся становится
// самостоятельным» и дальше по цепочке.
//
// Что значит «отдельный»: его можно сдуть, смыть, схватить, склеить.
//  - Ветер (objWind) и течение (objFlow) сносят объект на клетку раз в OBJ_PERIOD
//    кадров, если сила больше порога, растущего с корнем из массы (трение): куб
//    легче длинной балки. Течение — это жидкость, которая двигалась в этом кадре
//    (moved) у боковых граней: стоячая вода не толкает. Сам шаг — как у падающего
//    тела: клетки обмениваются местами снизу вверх по ходу, вытесненная жидкость
//    встаёт на освободившееся место; упёрся в твёрдое — стоит.
//  - Захват шароида (s.grip, клавиша E у игрока шароида): один на шароида, объект
//    не больше GRIP_MAX_CELLS клеток. Схваченный висит в воздухе у шароида — там,
//    куда он целится курсором (иначе по ходу), на расстоянии GRIP_GAP от тела — и
//    идёт за ним, но держится в GRIP_CLEAR клетках от поверхностей: шаг, после
//    которого к твёрдому оказалось бы вплотную больше клеток, чем сейчас, не
//    делается. Пиксели бура (EL.DRILL) в схваченном объекте дробят то, во что их
//    упирают, как протагонист киркой (segMine), пока игрок шароида целится и
//    зажимает ЛКМ; тогда зазор не держится, объект идёт к цели вплотную.
//  - Инструмент «Захват» (TOOL_GRAB, редактор): рука sim._hand — берёт объект под
//    курсором за клетку и тащит её к курсору, HAND_STEPS клеток за кадр.
//  - Клей (TOOL_GLUE, glueBrush): ЛКМ — объекты в области кисти становятся одним
//    (все клетки с их номерами получают общий); ПКМ — твёрдое в области (даже
//    местность) выделяется в новый отдельный объект.
// Схваченное твёрдое не держится на устойчивости: рука/захват каждый кадр метят
// его клетки moved, и падающие тела (updateBodies) и обход его не трогают; отпущено
// — падает как обычное тело.
//
// Всё детерминировано (без Math.random, время — номер кадра): входит в мир
// мультиплеера. Действия игрока — Sim-методы из MP_OPS (net.js).
// Методы класса Sim, вынесенные в отдельный файл: extendSim переносит их в Sim.prototype.

// Ветер и течение смотрятся раз в столько кадров.
const OBJ_PERIOD = 3;
// Объект больше этого не сдувает и не смывает (в клетках).
const OBJ_MAX_CELLS = 4000;
// Габарит (с каймой), больше которого полости объекта не ищутся (objCavity).
const OBJ_CAVITY_AREA = 40000;
// Порог ветра: база + K * корень из числа клеток.
const OBJ_WIND_BASE = 0.9;
const OBJ_WIND_K = 0.12;
// Течение: сколько боковых клеток двигавшейся воды нужно сверх n / OBJ_FLOW_DIV.
const OBJ_FLOW_MIN = 3;
const OBJ_FLOW_DIV = 16;
// Захват шароида: размер объекта, дальность схвата от центра тела, зазор от тела,
// шагов за кадр, зазор от поверхностей, дальность бура от центра тела.
const GRIP_MAX_CELLS = 20;
const GRIP_REACH = 36;
const GRIP_GAP = 4;
const GRIP_STEPS = 2;
const GRIP_CLEAR = 1;
const GRIP_DRILL_REACH = 26;
// Рука редактора: шагов за кадр; объект больше этого не берётся.
const HAND_STEPS = 3;
const HAND_MAX_CELLS = 4000;

class SimObjects {
  initObjects() {
    this._objSeq = 0;
    this._objAny = false;
    this._objList = [];
    this._hand = null;
    this._objMark = null;
    this._objStack = null;
    this._objToken = 0;
  }

  // Сброс при очистке поля, отмене и загрузке: метки читаются заново.
  objReset() {
    this._hand = null;
    this._objAny = true;
    this._objList = [];
  }

  objBuf() {
    if (!this._objMark) {
      this._objMark = new Uint32Array(this.w * this.h);
      this._objStack = new Int32Array(this.w * this.h);
    }
  }

  objNewId() {
    this._objSeq = this._objSeq % 65535 + 1;
    return this._objSeq;
  }

  // Метка новому телу из n клеток list (fallBody): уже помеченное сохраняет номер
  // (склеенное падает целиком), иначе новый отдельный объект.
  objLabel(list, n) {
    const obj = this.obj;
    let id = 0;
    for (let k = 0; k < n; k++) if (obj[list[k]] !== 0) { id = obj[list[k]]; break; }
    if (id === 0) id = this.objNewId();
    for (let k = 0; k < n; k++) obj[list[k]] = id;
    this._objAny = true;
  }

  // Клетки, связанные с seed тем же номером (4 соседа, твёрдые); tok — отметка
  // обхода (общая на весь скан), limit — предел размера: больше — null.
  objFill(seed, tok, limit) {
    const id = this.obj[seed];
    if (id === 0) return null;
    this.objBuf();
    const w = this.w, h = this.h, obj = this.obj, type = this.type, mark = this._objMark, stack = this._objStack;
    const out = [seed];
    mark[seed] = tok;
    let sp = 0;
    stack[sp++] = seed;
    while (sp > 0) {
      const c = stack[--sp], x = c % w;
      for (let q = 0; q < 4; q++) {
        let j;
        if (q === 0) { if (c < w) continue; j = c - w; }
        else if (q === 1) { if (c + w >= w * h) continue; j = c + w; }
        else if (q === 2) { if (x === 0) continue; j = c - 1; }
        else { if (x === w - 1) continue; j = c + 1; }
        if (mark[j] === tok || obj[j] !== id || IS_STRUCTURAL[type[j]] !== 1) continue;
        mark[j] = tok;
        out.push(j);
        if (out.length > limit) return null;
        stack[sp++] = j;
      }
    }
    return out;
  }

  // Клетки объекта одного seed (для захвата и руки) или null, если не вышло.
  objCellsOf(seed, limit) {
    return this.objFill(seed, ++this._objToken, limit);
  }

  // Прочитать поле obj заново: убрать метки с нетвёрдого, разделить объекты,
  // распавшиеся на части, и собрать список {id, cells}.
  objScan() {
    const obj = this.obj, type = this.type, n = this.w * this.h;
    this.objBuf();
    const tok = ++this._objToken, mark = this._objMark, claimed = new Set(), res = [];
    let any = false;
    for (let i = 0; i < n; i++) {
      const id = obj[i];
      if (id === 0) continue;
      if (IS_STRUCTURAL[type[i]] !== 1) { obj[i] = 0; continue; }
      any = true;
      if (mark[i] === tok) continue;
      const cells = this.objFill(i, tok, n);
      let nid = id;
      if (claimed.has(id)) { nid = this.objNewId(); for (let k = 0; k < cells.length; k++) obj[cells[k]] = nid; }
      claimed.add(nid);
      res.push({ id: nid, cells });
    }
    this._objAny = any;
    this._objList = res;
    return res;
  }

  // Держит ли кто-то объект id (захват шароида или рука).
  objHeld(id) {
    if (this._hand && this._hand.id === id) return true;
    for (const s of this.sharoids) if (s.grip && s.grip.id === id) return true;
    return false;
  }

  // Первая клетка, не пускающая объект cells при сдвиге на (dx, dy): индекс
  // клетки-препятствия, -2 — край поля, -1 — путь свободен (пустота, жидкость,
  // газ или он сам).
  objBlocker(cells, dx, dy) {
    const w = this.w, h = this.h, type = this.type, mark = this._objMark, tok = ++this._objToken;
    for (let k = 0; k < cells.length; k++) mark[cells[k]] = tok;
    for (let k = 0; k < cells.length; k++) {
      const c = cells[k], x = c % w + dx, y = ((c / w) | 0) + dy;
      if (x < 0 || x >= w || y < 0 || y >= h) return -2;
      const t = y * w + x;
      if (mark[t] === tok) continue;
      const tt = type[t];
      if (tt === EL.EMPTY || IS_LIQUID[tt] === 1 || IS_GASLIKE[tt] === 1) continue;
      return t;
    }
    return -1;
  }

  // Замкнутые полости объекта: клетки внутри его габарита, не принадлежащие
  // объекту и не достижимые снаружи (4 соседа, по клеткам не объекта). Полый куб
  // сдвигался только своими стенками, и жидкость, вытесненная впереди, вставала
  // на место ушедшей стенки — то есть внутрь корпуса (проверка 45: вода в полом
  // кубе, который смыло течением). Полость едет вместе с объектом, и вытесненное
  // спереди уходит назад, как у сплошного тела. Для разреженных объектов
  // (габарит больше OBJ_CAVITY_AREA клеток) полостей не ищем: их не бывает или не
  // стоит дороговизны.
  objCavity(cells) {
    const n = cells.length;
    if (n < 8) return [];
    const w = this.w;
    let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
    for (let k = 0; k < n; k++) {
      const c = cells[k], x = c % w, y = (c / w) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const bw = x1 - x0 + 3, bh = y1 - y0 + 3;   // габарит с каймой в одну клетку
    if (bw * bh > OBJ_CAVITY_AREA || bw < 5 || bh < 5) return [];
    const own = new Uint8Array(bw * bh), out = new Uint8Array(bw * bh);
    for (let k = 0; k < n; k++) { const c = cells[k]; own[((((c / w) | 0) - y0 + 1) * bw) + (c % w) - x0 + 1] = 1; }
    const stack = [0];
    out[0] = 1;
    while (stack.length) {
      const p = stack.pop(), px = p % bw, py = (p / bw) | 0;
      for (let q = 0; q < 4; q++) {
        const nx = px + (q === 0 ? 1 : q === 1 ? -1 : 0), ny = py + (q === 2 ? 1 : q === 3 ? -1 : 0);
        if (nx < 0 || nx >= bw || ny < 0 || ny >= bh) continue;
        const j = ny * bw + nx;
        if (own[j] || out[j]) continue;
        out[j] = 1;
        stack.push(j);
      }
    }
    const cav = [];
    for (let py = 1; py < bh - 1; py++) for (let px = 1; px < bw - 1; px++) {
      const j = py * bw + px;
      if (!own[j] && !out[j]) cav.push((y0 + py - 1) * w + x0 + px - 1);
    }
    return cav;
  }

  // Сдвинуть объект на (dx, dy) — путь уже проверен objBlocker. Клетки идут
  // впереди по ходу первыми, как у падающего тела; вытесненная жидкость встаёт
  // на освободившееся место. Замкнутые полости едут с телом (objCavity); в
  // cells после сдвига — только клетки самого объекта.
  objShift(cells, dx, dy) {
    const w = this.w, d = dy * w + dx, moved = this.moved;
    const cav = this.objCavity(cells);
    const own = cav.length ? cells.slice() : null;
    const all = cav.length ? cells.concat(cav) : cells;
    all.sort((a, b) => (dx * (b % w) + dy * ((b / w) | 0)) - (dx * (a % w) + dy * ((a / w) | 0)));
    for (let k = 0; k < all.length; k++) {
      const c = all[k], t = c + d;
      this.swapFields(c, t);
      moved[t] = 1;
      all[k] = t;
    }
    if (own) for (let k = 0; k < own.length; k++) cells[k] = own[k] + d;
    this._objAny = true;
  }

  objMove(cells, dx, dy) {
    this.objBuf();
    if (this.objBlocker(cells, dx, dy) !== -1) return false;
    this.objShift(cells, dx, dy);
    return true;
  }

  // Ветер и течение (см. шапку) — раз в OBJ_PERIOD кадров, в конце кадра.
  updateObjects() {
    if (!this._objAny || this.frame % OBJ_PERIOD !== 0) return;
    const list = this.objScan();
    const w = this.w, h = this.h, type = this.type, moved = this.moved;
    for (const o of list) {
      const cells = o.cells, n = cells.length;
      if (n > OBJ_MAX_CELLS || this.objHeld(o.id)) continue;
      // Ветер: среднее по выборке клеток.
      let sw = 0, cnt = 0;
      const stride = Math.max(1, (n / 24) | 0);
      for (let k = 0; k < n; k += stride) { const c = cells[k]; sw += this.getWindVX(c % w, (c / w) | 0); cnt++; }
      const mean = sw / cnt;
      let dx = Math.abs(mean) > OBJ_WIND_BASE + OBJ_WIND_K * Math.sqrt(n) ? (mean > 0 ? 1 : -1) : 0;
      if (dx === 0) {
        // Течение: двигавшаяся вода у боковых граней.
        let push = 0;
        for (let k = 0; k < n; k++) {
          const c = cells[k], x = c % w;
          if (x > 0 && moved[c - 1] === 1 && IS_LIQUID[type[c - 1]] === 1) push++;
          if (x < w - 1 && moved[c + 1] === 1 && IS_LIQUID[type[c + 1]] === 1) push--;
        }
        if (Math.abs(push) >= OBJ_FLOW_MIN + n / OBJ_FLOW_DIV) dx = push > 0 ? 1 : -1;
      }
      if (dx !== 0) this.objMove(cells, dx, 0);
    }
  }

  // ---- захват шароида ----

  // Схватить объект: ближайшая клетка объекта к цели (aim) или к телу. Объект не
  // больше GRIP_MAX_CELLS, чужой захват не отбирается.
  sharGrab(s) {
    const cx = s.x + (SHAR_W >> 1), cy = s.y + (SHAR_H >> 1);
    const inp = s.ctrl >= 0 ? this.playerSlot(s.ctrl).input : null;
    const px = inp && inp.aim ? inp.ax | 0 : cx, py = inp && inp.aim ? inp.ay | 0 : cy;
    const w = this.w, obj = this.obj, type = this.type;
    let best = -1, bd = Infinity;
    const R = inp && inp.aim ? 3 : GRIP_REACH;
    for (let y = Math.max(0, py - R); y <= Math.min(this.h - 1, py + R); y++) {
      for (let x = Math.max(0, px - R); x <= Math.min(w - 1, px + R); x++) {
        const j = y * w + x;
        if (obj[j] === 0 || IS_STRUCTURAL[type[j]] !== 1) continue;
        const fx = x - cx, fy = y - cy;
        if (fx * fx + fy * fy > GRIP_REACH * GRIP_REACH || this.objHeld(obj[j])) continue;
        const d = (x - px) * (x - px) + (y - py) * (y - py);
        if (d < bd) { bd = d; best = j; }
      }
    }
    if (best < 0) return false;
    const cells = this.objCellsOf(best, GRIP_MAX_CELLS);
    if (!cells) return false;
    s.grip = { id: obj[best], cell: best, mineCell: -1, mineHits: 0, mineT: 0, mineShade0: 0 };
    return true;
  }

  // Сколько клеток объекта (сдвинутого на d) стоят вплотную к чужому твёрдому:
  // мерило «держится ли на расстоянии» (GRIP_CLEAR = 1 клетка).
  objTouch(cells, d) {
    const w = this.w, h = this.h, type = this.type, mark = this._objMark, tok = this._objToken;
    let cnt = 0;
    for (let k = 0; k < cells.length; k++) {
      const c = cells[k] + d, x = c % w, y = (c / w) | 0;
      let hit = false;
      for (let dy = -GRIP_CLEAR; dy <= GRIP_CLEAR && !hit; dy++) {
        for (let dx = -GRIP_CLEAR; dx <= GRIP_CLEAR; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) { hit = true; break; }
          const n = ny * w + nx;
          const o = n - d;
          // Свои клетки: те, что объект занимает сейчас (после сдвига они свободны
          // или опять заняты им же), и те, что займёт.
          if (mark[n] === tok || (o >= 0 && o < w * h && mark[o] === tok)) continue;
          const t = type[n];
          if (t !== EL.EMPTY && t !== EL.FIRE && IS_LIQUID[t] !== 1 && IS_GASLIKE[t] !== 1) { hit = true; break; }
        }
      }
      if (hit) cnt++;
    }
    return cnt;
  }

  // Один кадр захвата шароида s (см. шапку).
  gripFollow(s) {
    const g = s.grip;
    const cells = this.objCellsOf(g.cell, GRIP_MAX_CELLS);
    if (!cells) { s.grip = null; return; }
    const w = this.w, type = this.type;
    let minx = 1e9, maxx = -1, miny = 1e9, maxy = -1, drill = false;
    for (let k = 0; k < cells.length; k++) {
      const c = cells[k], x = c % w, y = (c / w) | 0;
      if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
      if (type[c] === EL.DRILL) drill = true;
    }
    const inp = s.ctrl >= 0 ? this.playerSlot(s.ctrl).input : null;
    const cx = s.x + (SHAR_W >> 1), cy = s.y + (SHAR_H >> 1);
    const hw = (maxx - minx + 1) / 2, hh = (maxy - miny + 1) / 2;
    const drilling = drill && !!inp && inp.mine && inp.aim;
    let tx, ty;
    if (drilling) {
      // Бур идёт к цели вплотную, но не дальше GRIP_DRILL_REACH от тела.
      let ex = (inp.ax | 0) - cx, ey = (inp.ay | 0) - cy;
      const ed = Math.sqrt(ex * ex + ey * ey);
      if (ed > GRIP_DRILL_REACH) { ex *= GRIP_DRILL_REACH / ed; ey *= GRIP_DRILL_REACH / ed; }
      tx = cx + ex; ty = cy + ey;
    } else {
      let ux = inp && inp.aim ? (inp.ax | 0) - cx : (s.face || 1), uy = inp && inp.aim ? (inp.ay | 0) - cy : -0.3;
      const ud = Math.sqrt(ux * ux + uy * uy) || 1;
      ux /= ud; uy /= ud;
      const dist = (SHAR_W >> 1) + Math.max(hw, hh) + GRIP_GAP;
      tx = cx + ux * dist; ty = cy + uy * dist;
    }
    let bx = (minx + maxx) / 2, by = (miny + maxy) / 2;
    this.objBuf();
    let mined = false;
    for (let st = 0; st < GRIP_STEPS; st++) {
      const ddx = tx - bx, ddy = ty - by;
      const sx = ddx > 0.5 ? 1 : ddx < -0.5 ? -1 : 0, sy = ddy > 0.5 ? 1 : ddy < -0.5 ? -1 : 0;
      if (sx === 0 && sy === 0) break;
      const tries = Math.abs(ddx) >= Math.abs(ddy) ? [[sx, sy], [sx, 0], [0, sy]] : [[sx, sy], [0, sy], [sx, 0]];
      let done = false;
      for (const [dx, dy] of tries) {
        if (dx === 0 && dy === 0) continue;
        const b = this.objBlocker(cells, dx, dy);
        if (b === -1) {
          // objBlocker оставил отметку своих клеток — по ней objTouch.
          if (drilling || this.objTouch(cells, dy * w + dx) <= this.objTouch(cells, 0)) {
            this.objShift(cells, dx, dy);
            g.cell += dy * w + dx; bx += dx; by += dy;
            done = true;
            break;
          }
        } else if (drilling && b >= 0) {
          // Упёрся: если упирается пиксель бура — дробим то, во что упёрся.
          const c = b - (dy * w + dx);
          if (c >= 0 && c < type.length && type[c] === EL.DRILL && type[b] !== EL.DRILL && type[b] !== EL.SHAROID && this.mineable(type[b])) {
            this.segMine(g, b);
            mined = true;
            done = true;
            break;
          }
        }
      }
      if (!done || mined) break;
    }
    if (!mined) g.mineCell = -1;
    const moved = this.moved;
    for (let k = 0; k < cells.length; k++) moved[cells[k]] = 1;
    // Улетело далеко (шароид прыгнул или упал) — отпускаем.
    const ex = bx - cx, ey = by - cy;
    if (ex * ex + ey * ey > 3 * GRIP_REACH * GRIP_REACH) s.grip = null;
  }

  // Нажатия захвата и кадр захватов и руки (в step перед updateBodies).
  updateGrips() {
    for (const s of this.sharoids) {
      if (s.ctrl >= 0) {
        const inp = this.playerSlot(s.ctrl).input;
        if (inp.grip) {
          inp.grip = false;
          if (s.grip) s.grip = null; else this.sharGrab(s);
        }
      }
      if (s.grip) this.gripFollow(s);
    }
    if (this._hand) this.handFollow();
  }

  // ---- рука редактора ----

  // Взять объект под курсором (x, y) за клетку: тащится к курсору.
  objGrabAt(x, y) {
    this._hand = null;
    const w = this.w, obj = this.obj, type = this.type;
    let best = -1, bd = Infinity;
    for (let yy = Math.max(0, y - 2); yy <= Math.min(this.h - 1, y + 2); yy++) {
      for (let xx = Math.max(0, x - 2); xx <= Math.min(w - 1, x + 2); xx++) {
        const j = yy * w + xx;
        if (obj[j] === 0 || IS_STRUCTURAL[type[j]] !== 1 || this.objHeld(obj[j])) continue;
        const d = (xx - x) * (xx - x) + (yy - y) * (yy - y);
        if (d < bd) { bd = d; best = j; }
      }
    }
    if (best < 0) return false;
    if (!this.objCellsOf(best, HAND_MAX_CELLS)) return false;
    this._hand = { id: obj[best], cell: best, tx: x, ty: y };
    return true;
  }

  objHandTo(x, y) {
    if (this._hand) { this._hand.tx = x; this._hand.ty = y; }
  }

  objHandDrop() { this._hand = null; }

  handFollow() {
    const hd = this._hand, w = this.w;
    const cells = this.objCellsOf(hd.cell, HAND_MAX_CELLS);
    if (!cells) { this._hand = null; return; }
    this.objBuf();
    for (let st = 0; st < HAND_STEPS; st++) {
      const bx = hd.cell % w, by = (hd.cell / w) | 0;
      const ddx = hd.tx - bx, ddy = hd.ty - by;
      const sx = Math.sign(ddx), sy = Math.sign(ddy);
      if (sx === 0 && sy === 0) break;
      const tries = Math.abs(ddx) >= Math.abs(ddy) ? [[sx, sy], [sx, 0], [0, sy]] : [[sx, sy], [0, sy], [sx, 0]];
      let done = false;
      for (const [dx, dy] of tries) {
        if (dx === 0 && dy === 0) continue;
        if (this.objMove(cells, dx, dy)) { hd.cell += dy * w + dx; done = true; break; }
      }
      if (!done) break;
    }
    const moved = this.moved;
    for (let k = 0; k < cells.length; k++) moved[cells[k]] = 1;
  }

  // ---- клей ----

  // Клей в области кисти (см. шапку). cut = false: слить объекты области в один;
  // cut = true: твёрдое области — в новый отдельный объект.
  glueBrush(cx, cy, shape, rx, ry, cut) {
    const obj = this.obj, type = this.type, w = this.w;
    const x0 = Math.max(0, Math.floor(cx - rx)), x1 = Math.min(w - 1, Math.ceil(cx + rx));
    const y0 = Math.max(0, Math.floor(cy - ry)), y1 = Math.min(this.h - 1, Math.ceil(cy + ry));
    const rx2 = Math.max(rx, 0.5), ry2 = Math.max(ry, 0.5);
    const area = [], ids = new Set();
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (shape === 'circle') {
          const dx = (x - cx) / rx2, dy = (y - cy) / ry2;
          if (dx * dx + dy * dy > 1) continue;
        }
        const j = y * w + x;
        if (IS_STRUCTURAL[type[j]] !== 1) continue;
        area.push(j);
        if (obj[j] !== 0) ids.add(obj[j]);
      }
    }
    if (cut) {
      if (area.length === 0) return false;
      const id = this.objNewId();
      for (const j of area) { obj[j] = id; this.markDirty(j); }
      this._objAny = true;
      return true;
    }
    if (ids.size < 2) return false;
    let target = Infinity;
    for (const id of ids) if (id < target) target = id;
    // Все клетки склеиваемых объектов (не только в области) получают общий номер.
    const n = w * this.h;
    for (let i = 0; i < n; i++) if (ids.has(obj[i])) obj[i] = target;
    this._objAny = true;
    return true;
  }

  // Цвет клетки для вида «объекты» (клавиша 4): [r, g, b] или null — местность.
  objViewColor(i) {
    const id = this.obj[i];
    if (id === 0) return null;
    const h = Math.imul(id, 0x9E3779B1) >>> 0;
    const held = this.objHeld(id);
    const r = 90 + (h & 127), g = 90 + ((h >>> 8) & 127), b = 90 + ((h >>> 16) & 127);
    return held ? [255, 255, 255] : [r, g, b];
  }
}

extendSim(SimObjects);
