'use strict';

// Падающее тело как одно целое (идея из Noita, где твёрдое — отдельный
// объект, а не россыпь пикселей; просьба пользователя: "попробуй это
// внедрить").
//
// Проблема. Обломки (твёрдое с устойчивостью 0) падали каждый сам, как песок, в
// обходе клеток снизу вверх. Падающее тело — это много клеток, и пока оно
// падает, в нём на долю кадра возникают щели: пиксель ушёл вниз, соседний над
// ним ещё нет. В щель попадала вода, а у полого куба — и внутрь через неё:
// вода телепортировалась в закрытые участки (жалоба пользователя, дважды —
// заплатки в sim/movement.js закрыли щели по одной), а ветер и вытеснение
// рвали тело на части.
//
// Как сейчас. Перед обходом клеток (step, updateBodies) связные (4 соседа)
// обломки собираются в тела. Тело из BODY_MIN и более клеток падает на клетку
// целиком и разом, в одной операции — или не падает вовсе:
//  - под каждым нижним пикселем должна быть пустота, жидкость, газ или человек
//    (его тело давит так же, как и раньше, crushBody); всё остальное (опора,
//    сыпучее, огонь, продавленный пиксель) — тело стоит или идёт старым путём;
//  - жидкость и газ под телом вытесняются каждый в свою свободную клетку
//    (displaceLiquidThroughBody) до сдвига; не нашлось, куда деть, —
//    тело в этом кадре не падает и по пикселям не рассыпается (moved);
//  - потом все клетки сдвигаются снизу вверх; щелей между ними никто не видит,
//    потому что в это время ничего другого не обходится.
// Тело меньше BODY_MIN (одиночные обломки, крошка) падает по-старому, как песок:
// у него нет полостей, а ветер и скатывание с края ему идут впрок.
//
// Цена: ветер больше не сносит крупные падающие тела вбок (падает прямо) —
// прежняя общая для компоненты вероятность ветра (computeDebrisWindChance)
// касается только мелких. Кроме того, тело по-прежнему падает на клетку в кадр.
//
// Всё считается главным потоком, до обхода клеток и порядком кусков поля, так
// что результат не зависит ни от потоков, ни от вкладок (lockstep).
//
// Методы класса Sim, вынесенные в отдельный файл: класс ниже — только
// контейнер, extendSim переносит его методы в Sim.prototype (см. core.js).

// Тело меньше этого числа клеток падает по-старому. Полость есть уже у кольца
// из восьми клеток.
const BODY_MIN = 8;
// Самое большое тело, что собирается за раз: больше — по-старому.
const BODY_MAX = 20000;

class SimBody {
  initBody() {
    const n = this.w * this.h;
    this._bodySeen = new Int32Array(n);
    this._bodyStamp = 0;
    this._bodyList = new Int32Array(n);
    this._bodyStack = new Int32Array(n);
    this._bodyFluids = [];
    this._bodyHumans = [];
    // Выключатель: тестам нужно сравнить с прежним падением по пикселям.
    this.bodyFallOn = true;
  }

  // Раз в кадр перед обходом клеток.
  updateBodies() {
    if (!this.bodyFallOn) return;
    const w = this.w, h = this.h, type = this.type, stab = this.stability, crushed = this.crushed, moved = this.moved;
    const seen = this._bodySeen, list = this._bodyList, stack = this._bodyStack;
    const active = this._chunkActive, cw = this._chunkW, ch = this._chunkH;
    // Отметки этого кадра больше базы: клетка с отметкой уже разобрана.
    const base = this._bodyBase = this._bodyStamp;
    for (let cy = 0; cy < ch; cy++) {
      const y1 = Math.min(h, (cy + 1) * SLEEP_CHUNK);
      for (let cx = 0; cx < cw; cx++) {
        if (!active[cy * cw + cx]) continue;
        const x1 = Math.min(w, (cx + 1) * SLEEP_CHUNK);
        for (let y = cy * SLEEP_CHUNK; y < y1; y++) {
          for (let x = cx * SLEEP_CHUNK, i = y * w + x; x < x1; x++, i++) {
            if (stab[i] !== 0 || IS_STRUCTURAL[type[i]] !== 1 || seen[i] > base || crushed[i] !== 0 || moved[i]) continue;
            // Тело: связные обломки.
            const id = ++this._bodyStamp;
            let sp = 0, n = 0;
            stack[sp++] = i; seen[i] = id;
            let tooBig = false;
            while (sp > 0) {
              const c = stack[--sp];
              list[n++] = c;
              if (n >= BODY_MAX) { tooBig = true; break; }
              const cx0 = c % w;
              if (cx0 > 0) this.bodyPush(c - 1, id, stack, sp) && sp++;
              if (cx0 < w - 1) this.bodyPush(c + 1, id, stack, sp) && sp++;
              if (c >= w) this.bodyPush(c - w, id, stack, sp) && sp++;
              if (c + w < w * h) this.bodyPush(c + w, id, stack, sp) && sp++;
            }
            if (tooBig || n < BODY_MIN) continue;
            if (this.fallBody(n, id) === 2) for (let k = 0; k < n; k++) moved[list[k]] = 1;
          }
        }
      }
    }
  }

  // Положить соседа j в стек тела, если он обломок и ещё не разобран.
  bodyPush(j, id, stack, sp) {
    if (this._bodySeen[j] > this._bodyBase) return false;
    if (this.stability[j] !== 0 || IS_STRUCTURAL[this.type[j]] !== 1 || this.crushed[j] !== 0 || this.moved[j]) return false;
    this._bodySeen[j] = id;
    stack[sp] = j;
    return true;
  }

  // Тело из n клеток _bodyList (отметка id в _bodySeen) падает на клетку.
  // 0 — не может (стоит или идёт по пикселям), 1 — упало, 2 — не смогло только
  // из-за вытеснения жидкости и не должно рассыпаться по пикселям.
  fallBody(n, id) {
    const w = this.w, h = this.h, type = this.type, seen = this._bodySeen, list = this._bodyList;
    const fluids = this._bodyFluids, humans = this._bodyHumans;
    fluids.length = 0; humans.length = 0;
    for (let k = 0; k < n; k++) {
      const c = list[k];
      if (((c / w) | 0) + 1 >= h) return 0;
      const t = c + w;
      if (seen[t] === id) continue;
      const tt = type[t];
      if (tt === EL.EMPTY) continue;
      if (IS_LIQUID[tt] === 1 || IS_GASLIKE[tt] === 1) fluids.push(t);
      else if (tt === EL.HUMAN || tt === EL.PROTAGONIST) humans.push(t);
      else return 0;
    }
    // Вытеснение: каждая клетка жидкости или газа под телом — в свою
    // свободную клетку. Порядок важен: вытесненная клетка остаётся пустой до
    // сдвига тела, и вода под плоским дном (тонкий слой на полу) оказалась бы
    // разрезана пустыми клетками — оставшиеся не нашли бы пути к краю, и
    // тело зависало бы над последним слоем (так застревали кубы с толстым
    // дном). Поэтому первыми идут клетки, самые далёкие от края своей
    // горизонтальной цепочки (дальше всего от открытой воды сбоку), и по ходу
    // каждая из оставшихся ближе к краю, чем уже вытесненные.
    if (fluids.length > 1) {
      fluids.sort((a, b) => a - b);
      const m = fluids.length;
      const far = this._bodyFar && this._bodyFar.length >= m ? this._bodyFar : (this._bodyFar = new Int32Array(Math.max(64, m * 2)));
      // far[k] — расстояние клетки до ближайшего конца её цепочки (соседние
      // по строке клетки подряд).
      let s = 0;
      for (let k = 0; k < m; k++) {
        if (k === m - 1 || fluids[k + 1] !== fluids[k] + 1 || (fluids[k + 1] % w) === 0) {
          for (let q = s; q <= k; q++) far[q] = Math.min(q - s, k - q);
          s = k + 1;
        }
      }
      const idx = fluids.map((_, k) => k).sort((a, b) => far[b] - far[a] || a - b);
      const sorted = idx.map((k) => fluids[k]);
      for (let k = 0; k < m; k++) fluids[k] = sorted[k];
    }
    for (let k = 0; k < fluids.length; k++) {
      const t = fluids[k], tt = type[t];
      if (tt === EL.EMPTY) continue;
      if (IS_LIQUID[tt] === 1 && !this._liquidEscape[t]) return 2;
      if (!this.displaceLiquidThroughBody(t)) return 2;
      if (type[t] !== EL.EMPTY) return 2;
    }
    for (let k = 0; k < humans.length; k++) this.crushBody(humans[k]);
    // Сдвиг снизу вверх: клетка под каждой уже свободна.
    const order = list.subarray(0, n).sort();
    const fall = this.fall, moved = this.moved;
    for (let k = n - 1; k >= 0; k--) {
      const c = order[k];
      fall[c] = 1;
      this.swap(c, c + w);
      moved[c + w] = 1;
    }
    return 1;
  }
}

extendSim(SimBody);
