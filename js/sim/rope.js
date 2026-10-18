'use strict';

// Трос (инструмент "Трос" во вкладке "Технологии", TOOL_ROPE; просьба
// пользователя): щелчок по одной точке, потом по второй — между ними
// протягивается трос. Он не клетка, а сущность поверх поля (sim.ropes), как
// ноги шароида; рисует его Renderer.drawRopes.
//
// Длина троса — в ROPE_SLACK раза больше проведённой: пока концы ближе, трос
// провисает и ничего не держит; натянулся — не даёт концам разойтись дальше.
// Конец троса крепится к тому, что под щелчком (ropeEndAt):
//  - пустота, жидкость, газ, сыпучее, огонь — неподвижный крюк в этой точке;
//  - твёрдое — за клетку. Пока оно держится (устойчивость, якорь, стена) —
//    крюк. Оторвалось (обломок с устойчивостью 0) — висит на тросе целиком
//    (ropeMoveBody): связное тело падает с разгоном, натянутый трос
//    поворачивает его скорость вбок, и тело раскачивается маятником, пока не
//    успокоится под точкой крепления (ROPE_DAMP). Сдвигается тело на клетку
//    целиком, вытесняя жидкость и газ назад, упирается в твёрдое. Пока тело
//    на тросе, падение обломков (sim/body.js) и сыпучего его не трогает
//    (moved);
//  - шароид (sim/sharoid.js) — за клетку тела: на натянутом тросе он не
//    уходит дальше (ropeAllowsSharoid), а в воздухе раскачивается
//    (ropeSwingSharoid);
//  - человек и протагонист — за него самого: ушёл дальше длины троса —
//    подтягивается обратно (updateRopeLive), падая, повисает.
// Пропал тот, к чему трос крепился (клетку разъело, шароид разрушен, живого
// не стало), — трос рвётся.
//
// Входит в отмену, файл сохранения и мир мультиплеера (простые объекты на
// Sim); добавляет и убирает трос действие игрока (addRope, removeRopesNear —
// MP_OPS в net.js). Считается главным потоком: тела — перед падением тел
// (updateRopes), живые — после обхода клеток (updateRopeLive).
//
// Методы класса Sim, вынесенные в отдельный файл: класс ниже — только
// контейнер, extendSim переносит его методы в Sim.prototype (см. core.js).

// Во сколько раз трос длиннее проведённого (просьба: "примерно в полтора
// раза"); короче ROPE_MIN_LEN не бывает.
const ROPE_SLACK = 1.5;
const ROPE_MIN_LEN = 2;
// Тело на тросе: разгон падения за кадр, затухание скорости за кадр (чем
// меньше, тем быстрее успокаивается маятник), предел скорости.
const ROPE_GRAVITY = 0.09;
const ROPE_DAMP = 0.992;
const ROPE_V_MAX = 1.5;
// Тело больше этого числа клеток на тросе не качается — держится как есть.
const ROPE_BODY_MAX = 4000;
// Живой на тросе подтягивается за кадр не больше чем на столько клеток.
const ROPE_LIVE_PULL = 2;
// Цвет троса (Renderer.drawRopes).
const ROPE_COLOR = [156, 112, 64];

class SimRope {
  initRopes() {
    this.ropes = [];
    this._ropeSeq = 0;
    this._ropeStamp = 0;
  }

  // Конец троса в клетке (x, y) — по тому, что в ней (см. шапку).
  ropeEndAt(x, y) {
    const i = y * this.w + x, t = this.type[i];
    if (t === EL.SHAROID) {
      const s = this.sharoidAt(i);
      if (s) return { k: 'shar', id: s.id, dx: x - s.x, dy: y - s.y };
    }
    if (t === EL.HUMAN || t === EL.PROTAGONIST) return { k: 'live', t, n: this.life[i], x, y };
    if (t !== EL.EMPTY && ELEMENTS[t] && ELEMENTS[t].cat === CAT.SOLID) return { k: 'cell', x, y, vx: 0, vy: 0, fx: 0, fy: 0 };
    return { k: 'pt', x, y };
  }

  // Протянуть трос из (x0, y0) в (x1, y1) (просьба: два щелчка).
  addRope(x0, y0, x1, y1) {
    if (!this.inBounds(x0, y0) || !this.inBounds(x1, y1) || (x0 === x1 && y0 === y1)) return false;
    const len = Math.max(ROPE_MIN_LEN, ROPE_SLACK * Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0)));
    this.ropes.push({ id: ++this._ropeSeq, a: this.ropeEndAt(x0, y0), b: this.ropeEndAt(x1, y1), len });
    return true;
  }

  // Убрать тросы, проходящие ближе r клеток от (x, y) (ПКМ инструментом).
  removeRopesNear(x, y, r = 1) {
    const before = this.ropes.length;
    this.ropes = this.ropes.filter((rope) => {
      const a = this.ropeEndPos(rope.a), b = this.ropeEndPos(rope.b);
      if (!a || !b) return false;
      const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2)) : 0;
      const ex = a[0] + dx * t - x, ey = a[1] + dy * t - y;
      return ex * ex + ey * ey > (r + 0.5) * (r + 0.5);
    });
    return this.ropes.length !== before;
  }

  // Где сейчас конец троса: [x, y] или null (того, к чему крепился, нет).
  ropeEndPos(e) {
    if (e.k === 'shar') {
      const s = this.sharoidById(e.id);
      return s ? [s.x + e.dx, s.y + e.dy] : null;
    }
    return [e.x, e.y];
  }

  // Цел ли конец троса (см. шапку: пропало то, к чему крепился, — рвётся).
  ropeEndAlive(e) {
    if (e.k === 'pt') return true;
    if (e.k === 'shar') {
      const s = this.sharoidById(e.id);
      if (!s) return false;
      const x = s.x + e.dx, y = s.y + e.dy;
      return this.inBounds(x, y) && this.type[y * this.w + x] === EL.SHAROID && this.life[y * this.w + x] === s.id;
    }
    if (e.k === 'live') return this.ropeTrackLive(e);
    const t = this.type[e.y * this.w + e.x];
    return t !== EL.EMPTY && !!ELEMENTS[t] && ELEMENTS[t].cat === CAT.SOLID && t !== EL.SHAROID;
  }

  // Найти живого конца e рядом с прежним местом (он ходит сам); true — нашёлся.
  ropeTrackLive(e) {
    const w = this.w;
    for (let r = 0; r <= 3; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = e.x + dx, y = e.y + dy;
          if (!this.inBounds(x, y)) continue;
          const i = y * w + x;
          if (this.type[i] === e.t && this.life[i] === e.n) { e.x = x; e.y = y; return true; }
        }
      }
    }
    return false;
  }

  // Раз в кадр перед падением тел (главным потоком): порванные тросы убрать,
  // оторвавшиеся тела на тросах — качать.
  updateRopes() {
    if (this.ropes.length === 0) return;
    let gone = false;
    for (const r of this.ropes) {
      if (!this.ropeEndAlive(r.a) || !this.ropeEndAlive(r.b)) { r.dead = true; gone = true; }
    }
    if (gone) this.ropes = this.ropes.filter((r) => !r.dead);
    for (const r of this.ropes) {
      if (r.a.k === 'cell') this.ropeMoveBody(r, r.a, r.b);
      if (r.b.k === 'cell') this.ropeMoveBody(r, r.b, r.a);
    }
  }

  // Тело (связные обломки с устойчивостью 0, как в sim/body.js) с клеткой
  // (x, y): число клеток в _ropeList, 0 — клетка держится (крюк) или тело
  // слишком велико.
  ropeCollectBody(x, y) {
    const w = this.w, n = this.type.length, i0 = y * w + x;
    if (IS_STRUCTURAL[this.type[i0]] !== 1 || this.stability[i0] !== 0) return 0;
    if (!this._ropeSeen || this._ropeSeen.length !== n) { this._ropeSeen = new Int32Array(n); this._ropeList = new Int32Array(ROPE_BODY_MAX); }
    const seen = this._ropeSeen, list = this._ropeList, stamp = ++this._ropeStamp;
    let head = 0, tail = 0;
    seen[i0] = stamp; list[tail++] = i0;
    while (head < tail) {
      const c = list[head++], cx = c % w;
      const near = [cx > 0 ? c - 1 : -1, cx < w - 1 ? c + 1 : -1, c - w, c + w];
      for (const j of near) {
        if (j < 0 || j >= n || seen[j] === stamp) continue;
        if (IS_STRUCTURAL[this.type[j]] !== 1 || this.stability[j] !== 0) continue;
        if (tail >= ROPE_BODY_MAX) return 0;
        seen[j] = stamp; list[tail++] = j;
      }
    }
    return tail;
  }

  // Тело на тросе за конец e (другой конец — other): разгон, натянутый
  // трос поворачивает скорость вбок (маятник), сдвиг на целые клетки.
  ropeMoveBody(r, e, other) {
    const m = this.ropeCollectBody(e.x, e.y);
    if (m === 0) { e.vx = 0; e.vy = 0; e.fx = 0; e.fy = 0; return; }
    const q = this.ropeEndPos(other);
    e.vy += ROPE_GRAVITY;
    e.vx *= ROPE_DAMP; e.vy *= ROPE_DAMP;
    const px = e.x + e.fx, py = e.y + e.fy;
    let nx = px + e.vx, ny = py + e.vy;
    const dx = nx - q[0], dy = ny - q[1], d = Math.sqrt(dx * dx + dy * dy);
    if (d > r.len) { nx = q[0] + dx * r.len / d; ny = q[1] + dy * r.len / d; }
    e.vx = Math.max(-ROPE_V_MAX, Math.min(ROPE_V_MAX, nx - px));
    e.vy = Math.max(-ROPE_V_MAX, Math.min(ROPE_V_MAX, ny - py));
    e.fx += e.vx; e.fy += e.vy;
    // Концы других тросов на этом же теле едут вместе с ним.
    const seen = this._ropeSeen, stamp = this._ropeStamp, w = this.w, riders = [];
    for (const o of this.ropes) for (const oe of [o.a, o.b]) if (oe !== e && oe.k === 'cell' && seen[oe.y * w + oe.x] === stamp) riders.push(oe);
    let moved = 0;
    while (Math.abs(e.fx) >= 1 || Math.abs(e.fy) >= 1) {
      const horiz = Math.abs(e.fx) >= Math.abs(e.fy);
      const sx = horiz ? (e.fx > 0 ? 1 : -1) : 0, sy = horiz ? 0 : (e.fy > 0 ? 1 : -1);
      if (this.ropeShiftBody(m, sx, sy)) {
        e.x += sx; e.y += sy; e.fx -= sx; e.fy -= sy;
        for (const oe of riders) { oe.x += sx; oe.y += sy; }
        if (++moved > 4) break;
      } else if (horiz) { e.vx = 0; e.fx = 0; } else { e.vy = 0; e.fy = 0; }
    }
    // Пока тело на тросе, падение тел и обход клеток его не двигают.
    const list = this._ropeList, moveMark = this.moved;
    for (let k = 0; k < m; k++) moveMark[list[k]] = 1;
  }

  // Сдвинуть m клеток _ropeList на (sx, sy) целиком (как moveSharoid):
  // перед телом — только пустота, жидкость, газ, огонь или само тело.
  ropeShiftBody(m, sx, sy) {
    const w = this.w, h = this.h, list = this._ropeList, seen = this._ropeSeen, stamp = this._ropeStamp, d = sy * w + sx;
    for (let k = 0; k < m; k++) {
      const c = list[k], x = c % w + sx, y = ((c / w) | 0) + sy;
      if (x < 0 || x >= w || y < 0 || y >= h) return false;
      const j = c + d;
      if (seen[j] === stamp) continue;
      if (!this.sharPassable(this.type[j])) return false;
    }
    // От передних клеток к задним: каждая меняется с клеткой перед собой.
    const order = Array.from(list.subarray(0, m)).sort((a, b) => ((b % w) * sx + ((b / w) | 0) * sy) - ((a % w) * sx + ((a / w) | 0) * sy) || a - b);
    for (let k = 0; k < m; k++) this.swapFields(order[k], order[k] + d);
    for (let k = 0; k < m; k++) { seen[order[k]] = 0; list[k] = order[k] + d; }
    for (let k = 0; k < m; k++) seen[list[k]] = stamp;
    return true;
  }

  // Шароид s может сдвинуться на (dx, dy): натянутый трос, привязанный к
  // нему, не даёт уйти дальше длины.
  ropeAllowsSharoid(s, dx, dy) {
    for (const r of this.ropes) {
      for (const [e, o] of [[r.a, r.b], [r.b, r.a]]) {
        if (e.k !== 'shar' || e.id !== s.id || (o.k === 'shar' && o.id === s.id)) continue;
        const q = this.ropeEndPos(o);
        if (!q) continue;
        const px = s.x + e.dx - q[0], py = s.y + e.dy - q[1];
        const d0 = px * px + py * py, d1 = (px + dx) * (px + dx) + (py + dy) * (py + dy);
        if (d1 > r.len * r.len && d1 > d0) return false;
      }
    }
    return true;
  }

  // Шароид в воздухе на натянутом тросе: скорость поворачивается вбок, как у
  // маятника (см. ropeMoveBody).
  ropeSwingSharoid(s) {
    for (const r of this.ropes) {
      for (const [e, o] of [[r.a, r.b], [r.b, r.a]]) {
        if (e.k !== 'shar' || e.id !== s.id || (o.k === 'shar' && o.id === s.id)) continue;
        const q = this.ropeEndPos(o);
        if (!q) continue;
        const px = s.x + e.dx + s.fx, py = s.y + e.dy + s.fy;
        let nx = px + s.vx, ny = py + s.vy;
        const dx = nx - q[0], dy = ny - q[1], d = Math.sqrt(dx * dx + dy * dy);
        if (d <= r.len) continue;
        nx = q[0] + dx * r.len / d; ny = q[1] + dy * r.len / d;
        s.vx = (nx - px) * ROPE_DAMP; s.vy = (ny - py) * ROPE_DAMP;
      }
    }
  }

  // Раз в кадр после обхода клеток: живой, ушедший дальше длины троса,
  // подтягивается к другому концу (не больше ROPE_LIVE_PULL клеток).
  updateRopeLive() {
    for (const r of this.ropes) {
      for (const [e, o] of [[r.a, r.b], [r.b, r.a]]) {
        if (e.k !== 'live' || !this.ropeTrackLive(e)) continue;
        const q = this.ropeEndPos(o);
        if (!q) continue;
        for (let k = 0; k < ROPE_LIVE_PULL; k++) {
          const dx = q[0] - e.x, dy = q[1] - e.y;
          if (dx * dx + dy * dy <= r.len * r.len) break;
          const horiz = Math.abs(dx) >= Math.abs(dy);
          const sx = horiz ? Math.sign(dx) : 0, sy = horiz ? 0 : Math.sign(dy);
          const tx = e.x + sx, ty = e.y + sy;
          if (!this.inBounds(tx, ty) || !this.sharPassable(this.type[ty * this.w + tx])) break;
          const i = e.y * this.w + e.x, j = ty * this.w + tx;
          this.swapFields(i, j);
          this.moved[j] = 1;
          if (e.t === EL.PROTAGONIST) this.playerSlot(this.life[j]).idx = j;
          e.x = tx; e.y = ty;
        }
      }
    }
  }

  // Снимок тросов для отмены и файла (простые объекты, глубокая копия).
  ropesDump() { return JSON.parse(JSON.stringify(this.ropes)); }

  ropesLoad(list) {
    this.ropes = Array.isArray(list) ? JSON.parse(JSON.stringify(list)) : [];
    for (const r of this.ropes) if (r.id > this._ropeSeq) this._ropeSeq = r.id;
  }
}

extendSim(SimRope);
