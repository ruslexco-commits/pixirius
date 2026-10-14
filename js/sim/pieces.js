'use strict';

// Тело, которое можно разорвать: разъедание клеток, отрыв частей и свободные
// куски (просьба пользователя: "тело не расщепляется от кислоты ... при смерти
// падать как отдельный физичный объект ... его должна быть возможность
// разделить, разорвать, отделить кусок", механика как в Noita — физичный
// объект, переведённый в пиксели, которыми он же и управляется).
//
// Три слоя.
//
// 1. Разъедание (creatureDecay). Клетка тела, на которой язва дошла до
//    ERODE_ACID (или ожог до ERODE_BURN), с шансом ERODE_CHANCE в кадр исчезает:
//    кислота растворяет её (кровью, если она была ранена), огонь обугливает в
//    золу. Главная клетка (низ по центру) не растворяется — она держит логику
//    тела. Исчезнувшая клетка считается в урон как съеденная дотла
//    (LOST_DAMAGE, см. creatureDamage), поэтому время смерти от кислоты прежнее.
//
// 2. Разрыв (creatureBreak). Если оставшиеся клетки больше не связаны (4 соседа),
//    тело разваливается: часть с главной клеткой остаётся телом, остальные
//    куски становятся свободными (см. ниже), а мелочь (меньше PIECE_MIN клеток)
//    осыпается каплями крови. Живой теряет жизнь, если голова (верхние пять
//    рядов) осталась без связи с главной клеткой или почти вся съедена —
//    обезглавленное тело мертво. Мёртвое тело разрывается так же.
//
// 3. Свободный кусок. Клетки куска — те же HUMAN / PROTAGONIST, но life < 0:
//    life = -(1 + владелец + 16 * серия), где владелец 0..15 (номер игрока
//    протагониста, цвет куска; у человека 0), а серия отличает куски друг от
//    друга, чтобы касающиеся не слипались в один. extra по-прежнему несёт номер
//    части k (для рисунка: заливка или бортик, пятна) и бит смерти. Кусок —
//    жёсткое тело: связные клетки с одинаковым life падают, съезжают с края и
//    опрокидываются вместе (pieceStep), как падающее тело в sim/body.js, а не по
//    одной. Положения клеток больше не привязаны к форме тела: кусок можно
//    повернуть (pieceRotate — на 90° вокруг нижнего угла, ровно по сетке, без
//    дыр), поэтому мёртвое тело заваливается набок (creatureTopple), а голова
//    и обломки лежат как есть. Куски разъедаются кислотой и горят так же, как
//    тело, и распадаются на части, если связность потеряна: несвязные клетки с
//    одним life — уже отдельные куски, ничего размечать не надо.
//
// Все перестановки клеток — одной подстановкой (pieceApply) через swapFields:
// куски поля, что кусок занимает и куда уходит, обмениваются циклами, а жидкость
// и газ, что стояли на пути, уходят в освободившиеся клетки (в тот же столбец,
// если можно) — как у tela живых (creatureMove).
//
// Куски считает главный поток: в параллельной полосе updateCell откладывает
// любую их клетку (sim/core.js), а дальше первая же клетка куска, дошедшая до
// pieceStep, двигает его целиком и помечает moved — остальные клетки уже
// пропускаются.
//
// Методы класса Sim, вынесенные в отдельный файл: класс ниже — только
// контейнер, extendSim переносит его методы в Sim.prototype (см. core.js).

// Язва / ожог клетки, с которых она начинает разрушаться, и шанс в кадр.
const ERODE_ACID = 250;
const ERODE_BURN = 255;
const ERODE_CHANCE = 0.06;
// Сколько урона (шкала клеток, как dirt+burn+acid) стоит клетка, которой уже нет.
const LOST_DAMAGE = 255;
// Кусок меньше этого числа клеток осыпается каплями, а не лежит.
const PIECE_MIN = 4;
// Живое тело теряет жизнь, когда в части с главной клеткой голов осталось
// меньше HEAD_KEEP клеток.
const HEAD_KEEP = 4;
// Самый большой кусок, что двигается за раз (тело — 92 клетки).
const PIECE_CAP = 128;
// Мёртвое стоящее тело заваливается набок с шансом в кадр; кусок высотой
// от TOPPLE_RATIO ширины — тоже.
const TOPPLE_CHANCE = 0.08;
const TOPPLE_RATIO = 1.6;
// Кусок, что лежит только на чужой плоти, сдвигается вбок с таким шансом в кадр.
const PIECE_SLIDE_CHANCE = 0.12;
// Кусок тонет в жидкости медленнее: шаг вниз раз в столько кадров.
const PIECE_LIQUID_FRAMES = 3;
// Ожог и язва за кадр на касающуюся клетку куска (как у тела).
const PIECE_BURN = 40;
const PIECE_ACID = 30;

// Часть формы — голова (верхние PERSON_HEAD_ROWS рядов).
const PERSON_IS_HEAD = new Uint8Array(PERSON_N);
for (let k = 0; k < PERSON_N; k++) if (PERSON_DY[k] + PERSON_PIVOT_ROW < PERSON_HEAD_ROWS) PERSON_IS_HEAD[k] = 1;

// Рабочие буферы (одни на контекст: куски считает один поток за раз). Не
// поле Sim — иначе мультиплеер пересылал бы их вместе с миром.
const _pcList = new Int32Array(PIECE_CAP);
const _pcDst = new Int32Array(PIECE_CAP);
const _pcLab = new Int16Array(PIECE_CAP);
const _pcStack = new Int16Array(PIECE_CAP);
// Клетка → её номер в _pcList.
const _pcIdx = new Map();
const _pcSigma = new Map();
let _pcFluid = false;
let _pcPivotQ = -1;

// life куска по владельцу и серии.
function pieceLifeOf(owner, serial) { return -(1 + (owner & 15) + 16 * (serial & 2047)); }
// Владелец куска (номер игрока) по его life.
function pieceOwner(life) { return (-life - 1) & 15; }

class SimPieces {
  initPieces() {
    this._pieceSeq = 0;
    // Выключатель: проверкам нужен мёртвый, что стоит (раздавить плитой,
    // проверить, слушается ли команд), а не лежит.
    this.toppleOn = true;
  }

  // Новый life для куска владельца owner.
  pieceNewLife(owner) {
    this._pieceSeq = (this._pieceSeq + 1) & 2047;
    return pieceLifeOf(owner, this._pieceSeq);
  }

  // ---- разъедание и разрыв тела ----

  // Разъедание клеток тела p, разрыв, если оно развалилось. 0 — цело, 1 —
  // оторвались куски, но тело живо, 2 — тело только что погибло (обезглавлено).
  creatureDecay(p) {
    const cells = this.creatureCells(p), acid = this.acid, burn = this.burn;
    let present = 0;
    for (let k = 0; k < PERSON_N; k++) {
      const c = cells[k];
      if (c < 0) continue;
      if (k !== PERSON_PIVOT && (acid[c] >= ERODE_ACID || burn[c] >= ERODE_BURN) && Math.random() < ERODE_CHANCE) {
        this.erodeCell(c);
        cells[k] = -1;
        continue;
      }
      present++;
    }
    return present < PERSON_N ? this.creatureBreak(p) : 0;
  }

  // Клетка c тела растворилась или сгорела: кровь (если была ранена) или
  // зола, а не пустота — след остаётся.
  erodeCell(c) {
    const burned = this.burn[c] >= ERODE_BURN && this.acid[c] < ERODE_ACID;
    const bleeding = this.dirt[c] > 60;
    this.clearCell(c);
    if (burned) this.spawn(c, EL.ASH, false);
    else if (bleeding) this.spawn(c, EL.BLOOD, false);
  }

  // Загрузить клетки тела p (какие есть) в рабочий список. Возвращает число;
  // pivotQ — место главной клетки в списке или -1.
  pieceLoadBody(p) {
    const cells = this.creatureCells(p);
    _pcIdx.clear();
    let n = 0;
    _pcPivotQ = -1;
    for (let k = 0; k < PERSON_N; k++) {
      const c = cells[k];
      if (c < 0) continue;
      if (k === PERSON_PIVOT) _pcPivotQ = n;
      _pcIdx.set(c, n);
      _pcList[n++] = c;
    }
    return n;
  }

  // Разметка связных кусков в рабочем списке: _pcLab[q] — номер куска.
  // Возвращает число кусков.
  pieceLabel(n) {
    const w = this.w, h = this.h;
    _pcLab.fill(-1, 0, n);
    let nc = 0;
    for (let s = 0; s < n; s++) {
      if (_pcLab[s] >= 0) continue;
      let sp = 0;
      _pcStack[sp++] = s; _pcLab[s] = nc;
      while (sp > 0) {
        const c = _pcList[_pcStack[--sp]], x = c % w;
        for (let d = 0; d < 4; d++) {
          let j;
          if (d === 0) { if (x === 0) continue; j = c - 1; }
          else if (d === 1) { if (x === w - 1) continue; j = c + 1; }
          else if (d === 2) { if (c < w) continue; j = c - w; }
          else { j = c + w; if (j >= w * h) continue; }
          const r = _pcIdx.get(j);
          if (r !== undefined && _pcLab[r] < 0) { _pcLab[r] = nc; _pcStack[sp++] = r; }
        }
      }
      nc++;
    }
    return nc;
  }

  // Отпустить куски: каждый, кроме mainLab (-1 — все), получает свой life
  // (владелец owner) и бит смерти, а мелочь осыпается каплями.
  pieceRelease(n, nc, mainLab, owner) {
    for (let l = 0; l < nc; l++) {
      if (l === mainLab) continue;
      let size = 0;
      for (let q = 0; q < n; q++) if (_pcLab[q] === l) size++;
      const life = size >= PIECE_MIN ? this.pieceNewLife(owner) : 0;
      for (let q = 0; q < n; q++) {
        if (_pcLab[q] !== l) continue;
        const c = _pcList[q];
        if (size < PIECE_MIN) { this.clearCell(c); this.spawn(c, EL.BLOOD, false); continue; }
        this.life[c] = life;
        this.extra[c] |= PERSON_DEAD;
        this.markDirty(c);
      }
    }
  }

  // Тело p потеряло клетки: если оно распалось — оторвавшиеся куски становятся
  // свободными. 0 — цело, 1 — куски оторвались, жив, 2 — погиб (голова).
  creatureBreak(p) {
    const n = this.pieceLoadBody(p), mainQ = _pcPivotQ;
    if (mainQ < 0) return 0;
    const nc = this.pieceLabel(n), mainLab = _pcLab[mainQ];
    let head = 0;
    for (let q = 0; q < n; q++) if (_pcLab[q] === mainLab && PERSON_IS_HEAD[this.extra[_pcList[q]] & 127] === 1) head++;
    const t = this.type[p], id = this.life[p];
    const killed = !this.creatureDeadAt(p) && head < HEAD_KEEP;
    if (nc <= 1 && !killed) return 0;
    if (killed) this.creatureKill(p);
    if (nc > 1) this.pieceRelease(n, nc, mainLab, t === EL.PROTAGONIST ? id : 0);
    return killed ? 2 : 1;
  }

  // Клетка i тела, у которого нет главной клетки (вырвана взрывом, стёрта):
  // остатки не пропадают, а становятся мёртвыми кусками.
  creatureOrphan(i) {
    const w = this.w, h = this.h, type = this.type, life = this.life, extra = this.extra;
    const k0 = extra[i] & 127, t = type[i], id = life[i];
    const ox = (i % w) - PERSON_DX[k0], oy = ((i / w) | 0) - PERSON_DY[k0];
    _pcIdx.clear();
    let n = 0;
    for (let k = 0; k < PERSON_N; k++) {
      const x = ox + PERSON_DX[k], y = oy + PERSON_DY[k];
      if (x < 0 || x >= w || y < 0 || y >= h) continue;
      const c = y * w + x;
      if (type[c] !== t || life[c] !== id || (extra[c] & 127) !== k) continue;
      _pcIdx.set(c, n);
      _pcList[n++] = c;
    }
    if (t === EL.HUMAN && !this._inBand) this._humans.delete(id);
    const nc = this.pieceLabel(n);
    this.pieceRelease(n, nc, -1, t === EL.PROTAGONIST ? id : 0);
  }

  // ---- движение куска ----

  // Собрать в рабочий список кусок, которому принадлежит клетка i. -1 — слишком
  // большой.
  pieceCollect(i) {
    const w = this.w, h = this.h, type = this.type, life = this.life;
    const t = type[i], id = life[i];
    _pcIdx.clear();
    let n = 0;
    _pcList[n] = i; _pcIdx.set(i, n); n++;
    for (let q = 0; q < n; q++) {
      const c = _pcList[q], x = c % w;
      for (let d = 0; d < 4; d++) {
        let j;
        if (d === 0) { if (x === 0) continue; j = c - 1; }
        else if (d === 1) { if (x === w - 1) continue; j = c + 1; }
        else if (d === 2) { if (c < w) continue; j = c - w; }
        else { j = c + w; if (j >= w * h) continue; }
        if (type[j] !== t || life[j] !== id || _pcIdx.has(j)) continue;
        if (n >= PIECE_CAP) return -1;
        _pcIdx.set(j, n);
        _pcList[n++] = j;
      }
    }
    return n;
  }

  // Освободимо ли место, куда уйдёт клетка c (занятая своим же куском, пустая
  // или с жидкостью/газом). Жидкость запоминается в _pcFluid.
  pieceRoom(j) {
    if (_pcIdx.has(j)) return true;
    const t = this.type[j];
    if (t === EL.EMPTY) return true;
    if (IS_LIQUID[t] === 1 || IS_GASLIKE[t] === 1) { _pcFluid = true; return true; }
    return false;
  }

  // Может ли кусок из n клеток сдвинуться на (dx, dy).
  pieceCanMove(n, dx, dy) {
    const w = this.w, h = this.h;
    for (let q = 0; q < n; q++) {
      const c = _pcList[q], x = (c % w) + dx, y = ((c / w) | 0) + dy;
      if (x < 0 || x >= w || y < 0 || y >= h) return false;
      if (!this.pieceRoom(y * w + x)) return false;
    }
    return true;
  }

  // Сдвинуть кусок на (dx, dy) (pieceCanMove уже проверил).
  pieceShift(n, dx, dy) {
    const d = dy * this.w + dx;
    for (let q = 0; q < n; q++) _pcDst[q] = _pcList[q] + d;
    this.pieceApply(n);
  }

  // Подстановка: клетка list[q] уходит в dst[q]. Чужое содержимое целевых
  // клеток (жидкость, газ) уходит в освободившиеся — в тот же столбец, если
  // есть. Всё одним обходом циклов подстановки через swapFields.
  pieceApply(n) {
    const w = this.w, sigma = _pcSigma;
    sigma.clear();
    const dstSet = new Set();
    for (let q = 0; q < n; q++) { sigma.set(_pcList[q], _pcDst[q]); dstSet.add(_pcDst[q]); }
    const dn = [], sn = [];
    for (let q = 0; q < n; q++) {
      if (!_pcIdx.has(_pcDst[q])) dn.push(_pcDst[q]);
      if (!dstSet.has(_pcList[q])) sn.push(_pcList[q]);
    }
    for (const d of dn) {
      let pick = -1;
      for (let s = 0; s < sn.length; s++) {
        if (sn[s] < 0) continue;
        if (sn[s] % w === d % w) { pick = s; break; }
        if (pick < 0) pick = s;
      }
      sigma.set(d, sn[pick]);
      sn[pick] = -1;
    }
    const done = new Set();
    for (const start of sigma.keys()) {
      if (done.has(start)) continue;
      const cyc = [start];
      done.add(start);
      for (let cur = sigma.get(start); cur !== start; cur = sigma.get(cur)) { cyc.push(cur); done.add(cur); }
      for (let j = 1; j < cyc.length; j++) this.swapFields(cyc[0], cyc[j]);
    }
    for (let q = 0; q < n; q++) this.moved[_pcDst[q]] = 1;
  }

  // Повернуть кусок на 90° вокруг нижнего угла: dir = 1 — вправо (по часовой),
  // -1 — влево. Положения сдвигаются точно по сетке, дыр не возникает. false —
  // нет места (dst не заполнен).
  pieceRotate(n, dir) {
    const w = this.w, h = this.h;
    let minX = w, maxX = -1, maxY = -1;
    for (let q = 0; q < n; q++) {
      const c = _pcList[q], x = c % w, y = (c / w) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    const px = dir > 0 ? maxX : minX, py = maxY;
    for (let q = 0; q < n; q++) {
      const c = _pcList[q], rx = (c % w) - px, ry = ((c / w) | 0) - py;
      const x = dir > 0 ? px - ry : px + ry, y = dir > 0 ? py + rx : py - rx;
      if (x < 0 || x >= w || y < 0 || y >= h) return false;
      const j = y * w + x;
      if (!this.pieceRoom(j)) return false;
      _pcDst[q] = j;
    }
    this.pieceApply(n);
    return true;
  }

  // Все клетки куска стоят на месте в этом кадре.
  pieceStay(n) {
    for (let q = 0; q < n; q++) this.moved[_pcList[q]] = 1;
  }

  // Кусок, которому принадлежит клетка i, делает свой ход: гнётся под
  // кислотой, падает, съезжает с края, заваливается. Первая же клетка куска,
  // дошедшая сюда, двигает его целиком.
  pieceStep(i) {
    if (this.moved[i] || IS_CREATURE[this.type[i]] !== 1 || this.life[i] >= 0) return;
    let n = this.pieceCollect(i);
    if (n < 0) { this.moved[i] = 1; return; }
    if (n < PIECE_MIN) {
      for (let q = 0; q < n; q++) { const c = _pcList[q]; this.clearCell(c); this.spawn(c, EL.BLOOD, false); }
      return;
    }
    // Кислота и огонь обгладывают кусок; что отвалилось, то уже не он.
    if (this.pieceDecay(n)) {
      if (IS_CREATURE[this.type[i]] !== 1 || this.life[i] >= 0) return;
      n = this.pieceCollect(i);
      if (n < 0) return;
    }
    const w = this.w, h = this.h, type = this.type;
    _pcFluid = false;
    if (this.pieceCanMove(n, 0, 1)) {
      if (!_pcFluid || this.frame % PIECE_LIQUID_FRAMES === 0) this.pieceShift(n, 0, 1);
      else this.pieceStay(n);
      return;
    }
    this.pieceStay(n);
    // Стоит: габариты, опора и центр масс.
    let minX = w, maxX = -1, minY = h, maxY = -1, sx = 0;
    let supMin = w, supMax = -1, hard = false;
    for (let q = 0; q < n; q++) {
      const c = _pcList[q], x = c % w, y = (c / w) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      sx += x;
      const below = c + w;
      let solid = y + 1 >= h;
      if (solid) hard = true;
      else if (!_pcIdx.has(below)) {
        const tb = type[below];
        solid = tb !== EL.EMPTY && IS_LIQUID[tb] !== 1 && IS_GASLIKE[tb] !== 1;
        // Тело и другие куски — не твёрдая земля: на них не удержаться.
        if (solid && IS_CREATURE[tb] !== 1) hard = true;
      }
      if (solid) { if (x < supMin) supMin = x; if (x > supMax) supMax = x; }
    }
    const cm = sx / n;
    // Кусок лежит только на плоти (голова на туловище, тело на теле) — сползает
    // вбок и валится с края, как только центр масс выйдет за опору.
    if (supMax >= 0 && !hard && Math.random() < PIECE_SLIDE_CHANCE) {
      const dir = Math.random() < 0.5 ? -1 : 1;
      _pcFluid = false;
      if (this.pieceCanMove(n, dir, 0)) { this.pieceShift(n, dir, 0); return; }
    }
    // Центр масс за краем опоры — кусок съезжает по диагонали вниз (как
    // тело-обломок в sim/landing.js).
    if (supMax >= 0 && (cm < supMin - 0.5 || cm > supMax + 0.5)) {
      const dir = cm < supMin ? -1 : 1;
      _pcFluid = false;
      if (this.pieceCanMove(n, dir, 1)) { this.pieceShift(n, dir, 1); return; }
    }
    // Высокий кусок опрокидывается набок.
    const wd = maxX - minX + 1, ht = maxY - minY + 1;
    if (ht >= TOPPLE_RATIO * wd && Math.random() < TOPPLE_CHANCE) {
      const dir = Math.random() < 0.5 ? -1 : 1;
      _pcFluid = false;
      if (!this.pieceRotate(n, dir)) this.pieceRotate(n, -dir);
    }
  }

  // Кислота, огонь и лава на соседях клеток куска: язва и ожог, а дошедшая до
  // предела клетка исчезает. true — клетки пропали (кусок мог распасться).
  pieceDecay(n) {
    const w = this.w, h = this.h, type = this.type, acid = this.acid, burn = this.burn;
    let gone = false;
    for (let q = 0; q < n; q++) {
      const c = _pcList[q], x = c % w, y = (c / w) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = x + DX4[d], ny = y + DY4[d];
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const j = ny * w + nx, nt = type[j];
        if (nt === EL.EMPTY || IS_CREATURE[nt] === 1) continue;
        let isAcid = false;
        if (nt === EL.SOLUTION) { isAcid = solGet(this.comp(j), P_ACID) > 0; if (!isAcid) continue; }
        else if (this.humanDeadly(nt)) isAcid = nt === EL.ACID;
        else continue;
        if (isAcid) { const v = acid[c] + PIECE_ACID; acid[c] = v > 255 ? 255 : v; }
        else { const v = burn[c] + PIECE_BURN; burn[c] = v > 255 ? 255 : v; }
        this.markDirty(c);
      }
      if ((acid[c] >= ERODE_ACID || burn[c] >= ERODE_BURN) && Math.random() < ERODE_CHANCE) {
        this.erodeCell(c);
        gone = true;
      }
    }
    return gone;
  }

  // Мёртвое стоящее тело p заваливается набок и становится свободным куском.
  // true — завалилось (главной клетки у него больше нет).
  creatureTopple(p) {
    if (!this.toppleOn || Math.random() >= TOPPLE_CHANCE) return false;
    const n = this.pieceLoadBody(p);
    const owner = this.type[p] === EL.PROTAGONIST ? this.life[p] : 0;
    const dir = Math.random() < 0.5 ? -1 : 1;
    _pcFluid = false;
    if (!this.pieceRotate(n, dir) && !this.pieceRotate(n, -dir)) return false;
    const life = this.pieceNewLife(owner);
    for (let q = 0; q < n; q++) { this.life[_pcDst[q]] = life; this.markDirty(_pcDst[q]); }
    return true;
  }

  // Раздавлена клетка куска (падающее твёрдое): её нет, остаётся капля крови.
  pieceCrush(i) {
    const bleeding = this.dirt[i] > 0;
    this.clearCell(i);
    if (bleeding || Math.random() < 0.5) this.spawn(i, EL.BLOOD, false);
  }
}

extendSim(SimPieces);
