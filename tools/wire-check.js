'use strict';

// Провод мультиплеера (js/mp-wire.js):  node tools/wire-check.js [кадров]
//
// - двоичный формат (mpPack/mpUnpack) возвращает то же, что получил: числа
//   (и -0, NaN, бесконечности), строки, Map, Set, все виды typed-массивов,
//   общие ссылки (одна и та же вещь в двух местах остаётся одной);
// - мир размером с игровое поле, прогнанный через провод (упаковка, сжатие,
//   нарезка на куски, сборка, распаковка), идёт побайтно как оригинал —
//   так его получает вошедший игрок; печатаются размеры: сырой мир, после
//   упаковки, по проводу;
// - порядок: тики, отправленные после мира, приходят после него, хотя мир
//   сжимается асинхронно; сообщение другому адресату не распаковывается.
//
// Код выхода 1 — если что-то не так.

const fs = require('fs');
const path = require('path');
const H = require('./harness');
const env = H.loadSim({ seed: 7 });
const Sim = env.get('Sim'), PARTICLE_FIELDS = env.get('PARTICLE_FIELDS');
const frames = Number(process.argv[2]) || 200;

// Провод от симуляции не зависит — грузится отдельно, теми же приёмами,
// что стенд (имена верхнего уровня наружу).
const wireSrc = fs.readFileSync(path.join(H.ROOT, 'js/mp-wire.js'), 'utf8');
const wireNames = [...wireSrc.matchAll(/^(?:const|let|class|function)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
const W = new Function(wireSrc + `\nreturn { ${wireNames.join(', ')} };`)();

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) fails++; };

// ---- формат ----
{
  const shared = { a: 1, list: [1, 2] };
  const src = {
    n: [0, 1, -1, 127, 128, -2147483648, 2147483647, 2 ** 40, -(2 ** 33), 0.5, -0, NaN, Infinity, -Infinity, 1e-300],
    s: ['', 'Пиксириус', 'emoji 🙂', 'x'.repeat(300)],
    b: [true, false, null, undefined],
    m: new Map([[1, 'a'], ['k', { z: 2 }], [3, shared]]),
    set: new Set([1, 'two', shared]),
    one: shared, two: shared,
    ta: [new Int8Array([-1, 5]), new Uint8Array([255, 0]), new Uint8ClampedArray([7]), new Int16Array([-30000, 2]), new Uint16Array([65535]),
      new Int32Array([-5, 1 << 30]), new Uint32Array([4294967295]), new Float32Array([1.5, -0.25, NaN]), new Float64Array([Math.PI, -0])],
    ab: new Uint8Array([9, 8, 7]).buffer,
    fn: () => 1,
  };
  const back = W.mpUnpack(W.mpPack(src));
  const same = (x, y) => Object.is(x, y) || (typeof x === 'number' && typeof y === 'number' && x !== x && y !== y);
  let good = back.n.length === src.n.length && back.n.every((v, k) => same(v, src.n[k]));
  good = good && back.s.every((v, k) => v === src.s[k]) && back.b.every((v, k) => v === src.b[k]);
  good = good && back.m.get(1) === 'a' && back.m.get('k').z === 2 && back.set.has('two');
  good = good && back.ta.every((v, k) => v.constructor === src.ta[k].constructor && v.length === src.ta[k].length && v.every((x, i) => same(x, src.ta[k][i])));
  good = good && new Uint8Array(back.ab).join() === '9,8,7' && !('fn' in back && back.fn !== undefined);
  const refs = back.one === back.two && back.m.get(3) === back.one && back.set.has(back.one);
  ok(good && refs, `формат: значения на месте — ${good}, общие ссылки остались общими — ${refs}`);
}

// Пара проводов через память: кадры доходят асинхронно, по порядку.
function wirePair(onA, onB) {
  const pa = { sameBrowser: false, onframe: null, post(f) { setImmediate(() => pb.onframe && pb.onframe(f.slice())); }, close() {} };
  const pb = { sameBrowser: false, onframe: null, post(f) { setImmediate(() => pa.onframe && pa.onframe(f.slice())); }, close() {} };
  const frames = { n: 0, bytes: 0 };
  const post = pa.post;
  pa.post = (f) => { frames.n++; frames.bytes += f.length; post(f); };
  return { a: new W.MpWire(pa, onA), b: new W.MpWire(pb, onB), frames };
}

const diff = (x, y) => {
  for (const f of PARTICLE_FIELDS) {
    const p = x[f.name], q = y[f.name];
    for (let i = 0; i < p.length; i++) if (p[i] !== q[i] && !(p[i] !== p[i] && q[i] !== q[i])) return `${f.name}[${i}]: ${p[i]} против ${q[i]}`;
  }
  if (x._rngState !== y._rngState) return `генератор: ${x._rngState} против ${y._rngState}`;
  return null;
};
const tick = (s, k) => s.withRng(() => { H.poke(env, s, k); s.step(); });

(async () => {
  // ---- мир через провод ----
  const a = H.buildScene(env, 576, 324);
  a.lockstep = true;
  a.rngSeed(4242);
  for (let k = 0; k < frames; k++) tick(a, k);

  const got = [];
  const { a: host, b: client, frames: fr } = wirePair(() => {}, (m) => got.push(m));
  client.setSelf('client-1');
  let zipInfo = null;
  host.onBig = (i) => { if (i.dir === 'out') zipInfo = i; };

  const t0 = Date.now();
  const dump = a.lockstepDump();
  let rawBytes = 0;
  for (const [, arr] of dump.arrays) rawBytes += arr.byteLength;
  const tDump = Date.now() - t0;
  const t1 = Date.now();
  const packed = W.mpPack({ t: 'full', dump }).length;
  const tPack = Date.now() - t1;
  host.send({ t: 'full', world: 'map', to: 'client-1', dump }, 'client-1');
  // Тики сразу за миром — мелкие, уходят бы без очереди, если бы её не было.
  for (let k = 0; k < 5; k++) host.send({ t: 'tick', k }, null);
  // Мир другому адресату — сюда не доходит.
  host.send({ t: 'full', world: 'map', to: 'client-2', dump: { w: 1 } }, 'client-2');
  host.send({ t: 'tick', k: 5 }, null);
  const t2 = Date.now();
  while (got.length < 7 && Date.now() - t2 < 60000) await new Promise((r) => setTimeout(r, 5));
  const tAll = Date.now() - t2;

  const order = got.map((m) => m.t === 'full' ? 'F' : m.k).join(',');
  ok(order === 'F,0,1,2,3,4,5', `порядок и адресат: пришло ${order} (ждали F,0,1,2,3,4,5 — мир другому не пришёл)`);

  const full = got.find((m) => m.t === 'full');
  if (full) {
    const c = new Sim(a.w, a.h);
    c.lockstepLoad(full.dump);
    c.lockstep = true;
    const d0 = diff(a, c);
    let dn = d0;
    if (!d0) for (let k = frames; k < frames + 150 && !dn; k++) { tick(a, k); tick(c, k); dn = diff(a, c); }
    ok(!d0 && !dn && a.lockstepHash() === c.lockstepHash(), `мир через провод: сразу ${d0 || 'совпал'}, через 150 кадров — ${dn || 'побайтно одинаково'}`);
  }
  const mb = (b) => (b / 1048576).toFixed(2) + ' МБ';
  console.log(`  мир ${a.w}x${a.h}: массивы ${mb(rawBytes)}, упакован ${mb(packed)}, по проводу ${zipInfo ? mb(zipInfo.wire) : '?'} (${fr.n} кадров); снимок ${tDump} мс, упаковка ${tPack} мс, сжатие ${zipInfo ? zipInfo.ms : '?'} мс, до приёма ${tAll} мс`);
  ok(zipInfo && zipInfo.wire * 4 < rawBytes, `сжатие: по проводу меньше четверти сырого мира`);

  host.close(); client.close();
  console.log(fails ? `\nПРОВАЛОВ: ${fails}` : '\nOK: провод мультиплеера цел');
  process.exit(fails ? 1 : 0);
})();
