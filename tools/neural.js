'use strict';

// Опыт: может ли маленькая нейросеть заменить шаг симуляции и ускорить
// кадры. Без зависимостей, чистый JS:
//
//   node tools/neural.js            быстрое обучение (секунды) и проверка
//   node tools/neural.js --full     полное обучение (минуты) и проверка
//
// Что ускорять. Замеры (tools/check.js, браузер): шаг симуляции 7–25 мс,
// отрисовка на видеокарте ~3 мс. Отрисовку сеть ускорить не может — она и
// так дешёвая; единственное, что имело бы смысл, — сеть, которая по
// текущему кадру предсказывает следующий ВМЕСТО sim.step() (нейронный
// клеточный автомат).
//
// Архитектура. Следующий тип клетки зависит от её окрестности 3x3 (правила
// игры локальны: каждая клетка видит соседей). Вход — типы 9 клеток
// окрестности (за краем поля — особый тип BORDER). Первый слой — своя
// таблица вложений на каждую из 9 позиций: скрытый вектор = сумма 9 строк
// (это ровно свёртка 3x3 по one-hot типам, только без умножений на нули).
// Дальше ReLU, (в полном режиме — ещё один скрытый слой) и softmax по 64
// типам: вероятность, чем станет клетка.
//
// Данные. Пары "кадр -> следующий кадр" из стенда (tools/harness.js) и
// случайных сцен. Клеток, которые меняются, в кадре единицы процентов —
// выборка намеренно берёт их все, а неизменных — столько же: иначе сеть
// выучила бы "ничего не менять" и на этом успокоилась.
//
// Проверка — честная:
//  1. точность по всем клеткам против "ничего не менять" (копия кадра);
//  2. точность на МЕНЯЮЩИХСЯ клетках — против той же симуляции, запущенной
//     с другим зерном случайности: шаг случаен (песок сыплется то влево,
//     то вправо), и выше этого потолка не угадает никто;
//  3. прогон 100 шагов сетью вместо симуляции: сохраняется ли вещество;
//  4. скорость: мс на кадр 576x324 против sim.step().
//
// ИТОГ (сентябрь 2026, оба режима). Сеть учит локальные правила отлично:
// на меняющихся клетках угадывает 94.8% — на уровне самой симуляции с
// другим зерном (94–95%), быстрый режим — за 4 секунды обучения. Но как
// ЗАМЕНА шага она непригодна:
//  - ошибка в ~2% клеток за шаг накапливается: за 100 шагов камень
//    "испаряется" (1481 клетка -> 8–16), вода то исчезает, то затапливает
//    мир (452 -> 433...3878), с симуляцией расходится 76–91% клеток. Сеть
//    не знает законов сохранения — в симуляции вещество переезжает
//    обменом (swap), и исчезнуть ему неоткуда;
//  - она предсказывает только тип клетки; температура, состав, ветер,
//    устойчивость, балки — ещё столько же сетей, и каждая со своей ошибкой;
//  - на процессоре она в 70–300 раз медленнее sim.step() (1–4 с на кадр;
//    даже пропуская однородные клетки — 36–112 мс против 11 мс); на
//    видеокарте по оценке 0.3–20 мс плюс 1–3 мс на чтение результата, то
//    есть выигрыш возможен только на дискретной видеокарте и ценой
//    разваливающейся физики.
// Поэтому в игру сеть не встроена. Ускорять стоит саму симуляцию (пропуск
// покоящихся участков, параллельный расчёт), а не заменять её.

const H = require('./harness');

const FULL = process.argv.includes('--full');
const CFG = FULL
  ? { name: 'полное', hidden: 96, hidden2: 64, scenes: 24, stepsPerScene: 60, epochs: 4, lr: 0.02 }
  : { name: 'быстрое', hidden: 32, hidden2: 0, scenes: 6, stepsPerScene: 30, epochs: 2, lr: 0.03 };
const NT = 64;           // типов элементов (id < 64)
const BORDER = 63;       // "за краем поля"
const W = 160, HH = 120; // размер сцен для данных и проверки

// Своё зерно — обучение повторяемо.
let seed = 12345;
const rnd = () => { seed = (Math.imul(seed ^ (seed >>> 15), 2246822507) + 0x9e3779b9) >>> 0; return seed / 4294967296; };

// ---- данные ----

function randomScene(env, s) {
  const Sim = env.get('Sim'), EL = env.get('EL'), ORDER = env.get('ELEMENT_ORDER');
  const sim = new Sim(W, HH);
  const box = (x0, y0, x1, y1, id) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) sim.setCell(x, y, id, false); };
  box(0, HH - 4, W - 1, HH - 1, EL.STONE);
  const pool = ORDER.filter((id) => id !== EL.HUMAN && id !== EL.BEAM);
  for (let k = 0; k < 12 + (s % 8); k++) {
    const x = (rnd() * (W - 20)) | 0, y = (rnd() * (HH - 30)) | 0;
    box(x, y, x + 3 + ((rnd() * 16) | 0), y + 3 + ((rnd() * 10) | 0), pool[(rnd() * pool.length) | 0]);
  }
  return sim;
}

function features(type, w, h, x, y, out, o) {
  for (let dy = -1, p = 0; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++, p++) {
      const nx = x + dx, ny = y + dy;
      out[o + p] = (nx < 0 || ny < 0 || nx >= w || ny >= h) ? BORDER : type[ny * w + nx];
    }
  }
}

function collect(nScenes, steps, seedBase) {
  const X = [], Y = [];
  let changedTotal = 0, cellsTotal = 0;
  for (let s = 0; s < nScenes; s++) {
    const env = H.loadSim({ seed: seedBase + s });
    const sim = s % 3 === 0 ? H.buildScene(env, W, HH) : randomScene(env, s);
    for (let k = 0; k < 20; k++) sim.step();
    const f = new Uint8Array(9);
    for (let k = 0; k < steps; k++) {
      const before = sim.type.slice();
      sim.step();
      const after = sim.type;
      for (let i = 0; i < before.length; i++) {
        const changed = before[i] !== after[i];
        cellsTotal++;
        if (changed) changedTotal++;
        // Все меняющиеся клетки; неизменных — столько же в среднем. Пустое
        // небо — реже, но не ноль: сеть, ни разу не видевшая окрестности
        // из одной пустоты, рисовала там воду (первая версия опыта так и
        // затопила мир).
        if (!changed && rnd() > 0.04) continue;
        features(before, W, HH, i % W, (i / W) | 0, f, 0);
        if (!changed && f.every((t) => t === 0) && rnd() > 0.1) continue;
        X.push(f.slice()); Y.push(after[i]);
      }
    }
  }
  return { X, Y, changedShare: changedTotal / cellsTotal };
}

// ---- модель ----

function makeModel(hidden, hidden2) {
  const init = (n, scale) => { const a = new Float32Array(n); for (let k = 0; k < n; k++) a[k] = (rnd() * 2 - 1) * scale; return a; };
  const last = hidden2 || hidden;
  return {
    hidden, hidden2,
    W1: init(9 * NT * hidden, 0.3), b1: new Float32Array(hidden),
    W1b: hidden2 ? init(hidden * hidden2, Math.sqrt(2 / hidden)) : null, b1b: hidden2 ? new Float32Array(hidden2) : null,
    W2: init(last * NT, Math.sqrt(2 / last)), b2: new Float32Array(NT),
  };
}

// Прямой проход; h, g, p — буферы (без выделений в цикле).
function forward(m, f, o, h, g, p) {
  const H1 = m.hidden;
  for (let j = 0; j < H1; j++) h[j] = m.b1[j];
  for (let q = 0; q < 9; q++) {
    const base = (q * NT + f[o + q]) * H1;
    for (let j = 0; j < H1; j++) h[j] += m.W1[base + j];
  }
  for (let j = 0; j < H1; j++) if (h[j] < 0) h[j] = 0;
  let last = h, L = H1;
  if (m.hidden2) {
    const H2 = m.hidden2;
    for (let j = 0; j < H2; j++) {
      let s = m.b1b[j];
      for (let i = 0; i < H1; i++) s += h[i] * m.W1b[i * H2 + j];
      g[j] = s > 0 ? s : 0;
    }
    last = g; L = H2;
  }
  let mx = -Infinity;
  for (let c = 0; c < NT; c++) {
    let s = m.b2[c];
    for (let j = 0; j < L; j++) s += last[j] * m.W2[j * NT + c];
    p[c] = s; if (s > mx) mx = s;
  }
  let sum = 0;
  for (let c = 0; c < NT; c++) { p[c] = Math.exp(p[c] - mx); sum += p[c]; }
  for (let c = 0; c < NT; c++) p[c] /= sum;
}

// Обучение: SGD с моментом, по одному примеру, скорость учения убывает.
function train(m, X, Y, epochs, lr0) {
  const H1 = m.hidden, H2 = m.hidden2, L = H2 || H1;
  const h = new Float32Array(H1), g = new Float32Array(H2 || 1), p = new Float32Array(NT);
  const dh = new Float32Array(H1), dg = new Float32Array(H2 || 1);
  const order = X.map((_, k) => k);
  const f = new Uint8Array(9);
  for (let e = 0; e < epochs; e++) {
    for (let k = order.length - 1; k > 0; k--) { const j = (rnd() * (k + 1)) | 0; const t = order[k]; order[k] = order[j]; order[j] = t; }
    let loss = 0;
    const lr = lr0 / (1 + e);
    for (const idx of order) {
      f.set(X[idx]);
      forward(m, f, 0, h, g, p);
      const y = Y[idx];
      loss -= Math.log(p[y] + 1e-9);
      p[y] -= 1;                                   // d(loss)/d(logits)
      const last = H2 ? g : h;
      dh.fill(0);
      const dl = H2 ? dg : dh;
      if (H2) dg.fill(0);
      for (let j = 0; j < L; j++) {
        let s = 0;
        const row = j * NT;
        for (let c = 0; c < NT; c++) { s += m.W2[row + c] * p[c]; m.W2[row + c] -= lr * last[j] * p[c]; }
        dl[j] = last[j] > 0 ? s : 0;
      }
      for (let c = 0; c < NT; c++) m.b2[c] -= lr * p[c];
      if (H2) {
        for (let i = 0; i < H1; i++) {
          if (h[i] <= 0) continue;
          let s = 0;
          const row = i * H2;
          for (let j = 0; j < H2; j++) { s += m.W1b[row + j] * dg[j]; m.W1b[row + j] -= lr * h[i] * dg[j]; }
          dh[i] = s;
        }
        for (let j = 0; j < H2; j++) m.b1b[j] -= lr * dg[j];
      }
      for (let q = 0; q < 9; q++) {
        const base = (q * NT + f[q]) * H1;
        for (let j = 0; j < H1; j++) m.W1[base + j] -= lr * dh[j];
      }
      for (let j = 0; j < H1; j++) m.b1[j] -= lr * dh[j];
    }
    console.log(`  эпоха ${e + 1}/${epochs}: средняя ошибка ${(loss / order.length).toFixed(3)}`);
  }
}

// Шаг мира сетью: каждой клетке — наиболее вероятный тип (argmax) или
// выборка из вероятностей (sample). Однородная окрестность (все 9 одного
// типа) считается неизменной без сети — самая дешёвая и честная уловка.
function netStep(m, type, w, h, mode, out, skipUniform) {
  const f = new Uint8Array(9), hb = new Float32Array(m.hidden), gb = new Float32Array(m.hidden2 || 1), p = new Float32Array(NT);
  let evaluated = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      features(type, w, h, x, y, f, 0);
      const i = y * w + x;
      if (skipUniform) {
        let uni = true;
        for (let q = 1; q < 9; q++) if (f[q] !== f[4] && f[q] !== BORDER) { uni = false; break; }
        if (uni) { out[i] = type[i]; continue; }
      }
      evaluated++;
      forward(m, f, 0, hb, gb, p);
      let best = 0;
      if (mode === 'sample') {
        let r = rnd();
        for (let c = 0; c < NT; c++) { r -= p[c]; if (r <= 0) { best = c; break; } best = c; }
      } else {
        for (let c = 1; c < NT; c++) if (p[c] > p[best]) best = c;
      }
      out[i] = best === BORDER ? 0 : best;
    }
  }
  return evaluated;
}

// ---- проверка ----

function evaluate(m) {
  const ELEMENTS = H.loadSim({ seed: 1 }).get('ELEMENTS');
  // 1–2: точность одного шага на незнакомых сценах.
  let all = 0, allNet = 0, allCopy = 0, chg = 0, chgNet = 0, chgSim = 0;
  for (let s = 0; s < 4; s++) {
    const envA = H.loadSim({ seed: 900 + s }), envB = H.loadSim({ seed: 1900 + s });
    const simA = s % 2 === 0 ? H.buildScene(envA, W, HH) : randomScene(envA, 50 + s);
    for (let k = 0; k < 30; k++) simA.step();
    // Та же сцена в другом мире с другим зерном — для потолка "сим против сима".
    const simB = new (envB.get('Sim'))(W, HH);
    simB.deserialize(JSON.parse(JSON.stringify(simA.serialize())));
    for (let k = 0; k < 10; k++) {
      const before = simA.type.slice();
      simB.deserialize(JSON.parse(JSON.stringify(simA.serialize())));
      simA.step(); simB.step();
      const pred = new Uint8Array(before.length);
      netStep(m, before, W, HH, 'argmax', pred, false);
      for (let i = 0; i < before.length; i++) {
        const truth = simA.type[i];
        all++;
        if (pred[i] === truth) allNet++;
        if (before[i] === truth) allCopy++;
        if (before[i] !== truth) {
          chg++;
          if (pred[i] === truth) chgNet++;
          if (simB.type[i] === truth) chgSim++;
        }
      }
    }
  }
  console.log('\nТочность одного шага (незнакомые сцены):');
  console.log(`  все клетки:        сеть ${(allNet / all * 100).toFixed(2)}%,  "ничего не менять" ${(allCopy / all * 100).toFixed(2)}%`);
  console.log(`  меняющиеся клетки: сеть ${(chgNet / chg * 100).toFixed(1)}%,  потолок (симуляция с другим зерном) ${(chgSim / chg * 100).toFixed(1)}%,  "ничего не менять" 0%`);

  // 3: прогон 100 шагов сетью вместо симуляции — сохраняется ли вещество.
  const env = H.loadSim({ seed: 4242 });
  const sim = H.buildScene(env, W, HH);
  for (let k = 0; k < 20; k++) sim.step();
  const start = sim.type.slice();
  let net = start.slice(), buf = new Uint8Array(start.length);
  for (let k = 0; k < 100; k++) { netStep(m, net, W, HH, 'sample', buf, true); const t = net; net = buf; buf = t; }
  for (let k = 0; k < 100; k++) sim.step();
  const EL = env.get('EL');
  const count = (arr, id) => { let n = 0; for (let i = 0; i < arr.length; i++) if (arr[i] === id) n++; return n; };
  console.log('\nПрогон 100 шагов (клеток вещества: было -> симуляция / сеть):');
  for (const id of [EL.STONE, EL.WATER, EL.SAND, EL.EARTH, EL.OIL, EL.LAVA, EL.WOOD, EL.METAL]) {
    const c0 = count(start, id), cs = count(sim.type, id), cn = count(net, id);
    if (!c0 && !cs && !cn) continue;
    console.log(`  ${ELEMENTS[id].name.padEnd(8)} ${String(c0).padStart(5)} -> ${String(cs).padStart(5)} / ${String(cn).padStart(5)}`);
  }
  let diff = 0;
  for (let i = 0; i < net.length; i++) if (net[i] !== sim.type[i]) diff++;
  console.log(`  клеток, где сеть и симуляция разошлись: ${(diff / net.length * 100).toFixed(1)}%`);

  // 4: скорость на поле реального размера.
  const big = H.buildScene(H.loadSim({ seed: 77 }), 576, 324);
  for (let k = 0; k < 20; k++) big.step();
  let t0 = process.hrtime.bigint();
  for (let k = 0; k < 10; k++) big.step();
  const simMs = Number(process.hrtime.bigint() - t0) / 1e6 / 10;
  const out = new Uint8Array(big.type.length);
  t0 = process.hrtime.bigint();
  netStep(m, big.type, 576, 324, 'argmax', out, false);
  const netMs = Number(process.hrtime.bigint() - t0) / 1e6;
  t0 = process.hrtime.bigint();
  const evaluated = netStep(m, big.type, 576, 324, 'argmax', out, true);
  const netSkipMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const L = m.hidden2 || m.hidden;
  const flopsCell = 9 * m.hidden + (m.hidden2 ? 2 * m.hidden * m.hidden2 : 0) + 2 * L * NT + 3 * NT;
  console.log('\nСкорость, поле 576x324:');
  console.log(`  sim.step():                         ${simMs.toFixed(1)} мс`);
  console.log(`  сеть на CPU, все клетки:            ${netMs.toFixed(0)} мс`);
  console.log(`  сеть на CPU, без однородных клеток: ${netSkipMs.toFixed(0)} мс (считалось ${(evaluated / out.length * 100).toFixed(0)}% клеток)`);
  console.log(`  операций на клетку: ~${flopsCell}, на кадр: ~${(flopsCell * out.length / 1e6).toFixed(0)} млн`);
  // Оценка для видеокарты: встроенная графика даёт порядка 100–300 GFLOPS на
  // деле, дискретная средняя — 2–5 TFLOPS. Плюс чтение результата обратно
  // (симуляция живёт на CPU) — 1–3 мс само по себе.
  const mflop = flopsCell * out.length / 1e6;
  console.log(`  оценка на видеокарте: встроенная ~${(mflop / 200).toFixed(1)} мс, дискретная ~${(mflop / 3000).toFixed(2)} мс + 1–3 мс на чтение с видеокарты`);
}

function main() {
  console.log(`Обучение: ${CFG.name} (скрытый слой ${CFG.hidden}${CFG.hidden2 ? ' + ' + CFG.hidden2 : ''}, сцен ${CFG.scenes}, эпох ${CFG.epochs})`);
  const t0 = Date.now();
  const { X, Y, changedShare } = collect(CFG.scenes, CFG.stepsPerScene, 100);
  console.log(`  примеров ${X.length}; клеток, меняющихся за шаг, — ${(changedShare * 100).toFixed(2)}% от всех (собрано за ${((Date.now() - t0) / 1000).toFixed(0)} с)`);
  const m = makeModel(CFG.hidden, CFG.hidden2);
  const t1 = Date.now();
  train(m, X, Y, CFG.epochs, CFG.lr);
  console.log(`  обучено за ${((Date.now() - t1) / 1000).toFixed(0)} с`);
  evaluate(m);
}

main();
