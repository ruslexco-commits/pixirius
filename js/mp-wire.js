'use strict';

// Провод мультиплеера: как сообщения js/net.js превращаются в байты и обратно
// и как байты ходят между участниками (просьба пользователя: "добавь сжатие
// мира при входе и в принципе подготовь к более мультиплеерному
// мультиплееру").
//
// Раньше вкладки слали друг другу объекты прямо в BroadcastChannel: браузер
// сам копировал их (structured clone), а мир при входе уходил сырыми
// массивами — десятки мегабайт. Между вкладками одного браузера это
// терпимо, по сети — нет: сеть возит только байты, и чем их меньше, тем
// быстрее игрок войдёт. Теперь всё идёт одним путём, и между вкладками, и
// (дальше) по сети:
//   сообщение → mpPack (свой двоичный формат) → большое — сжать (deflate)
//   → длинное — нарезать на куски MP_CHUNK → труба (pipe)
// и обратно в том же порядке. Порядок сообщений сохраняется: сжатие
// асинхронное, но всё, что отправлено после большого сообщения, ждёт его
// в очереди (тики после мира целиком нельзя применять раньше него).
//
// Труба — то, что возит байты: post(bytes), onframe(bytes), close() и
// sameBrowser (участники в одном браузере — тогда закрытие вкладки
// замечается по Web Locks, иначе только по пингам). Сейчас она одна —
// MpChannelPipe (BroadcastChannel, вкладки одного браузера). Для игры по
// сети добавляется ещё одна (WebRTC через PeerJS или сокет к серверу-
// ретранслятору) с теми же четырьмя членами и выбирается в mpOpenPipe;
// js/net.js и всё, что выше, менять не придётся.

// Сообщение длиннее стольких байт сжимается (короче — сжатие дороже
// выигрыша: тики и нажатия — десятки байт).
const MP_ZIP_MIN = 2048;
// Кусок кадра: длинное сообщение режется на такие. 16 КБ — размер, который
// каналы данных WebRTC всех браузеров пропускают одним сообщением; у
// BroadcastChannel ограничения нет, но путь пусть будет тот же.
const MP_CHUNK = 16000;
// Недособранных длинных сообщений держим не больше стольких (кусок
// потерялся — сборка бросается, а мир вкладка попросит заново по отпечатку).
const MP_PARTS_KEEP = 16;

// Метки значений в mpPack.
const MPT_UNDEF = 0, MPT_NULL = 1, MPT_FALSE = 2, MPT_TRUE = 3, MPT_INT = 4, MPT_F64 = 5, MPT_STR = 6,
  MPT_ARR = 7, MPT_OBJ = 8, MPT_MAP = 9, MPT_SET = 10, MPT_TA = 11, MPT_AB = 12, MPT_REF = 13;
// Виды typed-массивов (номер — индекс).
const MP_TA_KINDS = [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array];
// Кадры трубы (первый байт).
const MPF_WHOLE = 1, MPF_CHUNK = 2;
const MPF_ZIP = 1;   // флаг: тело сжато

const mpTextEnc = new TextEncoder();
const mpTextDec = new TextDecoder();

// Хэш строки (FNV-1a, 32 бита): адресат кадра — по нему вкладка отбрасывает
// чужой мир ещё до распаковки.
function mpHash32(s) {
  let h = 0x811c9dc5;
  for (let k = 0; k < s.length; k++) h = Math.imul(h ^ s.charCodeAt(k), 16777619);
  return (h >>> 0) || 1;
}

// ---- двоичный формат ----
//
// Понимает всё, что лежит в сообщениях и в мире (lockstepDump): числа,
// строки, массивы, простые объекты, Map, Set, typed-массивы, ArrayBuffer.
// Ссылки сохраняются, как у structured clone: объект, встреченный второй
// раз, пишется номером (playerInput мира — это players[0].input, и после
// приёма должен остаться им). Функции и символы пропускаются. Экземпляр
// класса становится простым объектом — как и при structured clone.
//
// Typed-массивы с элементом больше байта пишутся по "плоскостям": сначала
// младшие байты всех элементов, потом следующие. Соседние клетки поля
// похожи, и старшие байты (температура, состав) почти одинаковы — сжатию
// так в разы легче.

class MpWriter {
  constructor() { this.buf = new Uint8Array(1 << 16); this.pos = 0; this.refs = new Map(); }
  need(n) {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const b = new Uint8Array(size); b.set(this.buf.subarray(0, this.pos)); this.buf = b;
  }
  u8(v) { this.need(1); this.buf[this.pos++] = v; }
  // Беззнаковое целое до 2^53 по 7 бит.
  varu(v) {
    this.need(8);
    while (v >= 128) { this.buf[this.pos++] = (v % 128) | 128; v = Math.floor(v / 128); }
    this.buf[this.pos++] = v;
  }
  f64(v) { this.need(8); new DataView(this.buf.buffer).setFloat64(this.pos, v, true); this.pos += 8; }
  bytes(b) { this.need(b.length); this.buf.set(b, this.pos); this.pos += b.length; }
  str(s) { const b = mpTextEnc.encode(s); this.varu(b.length); this.bytes(b); }
  // Ссылка на уже записанный объект — номером; новый — запомнить.
  ref(v) {
    const k = this.refs.get(v);
    if (k !== undefined) { this.u8(MPT_REF); this.varu(k); return true; }
    this.refs.set(v, this.refs.size);
    return false;
  }
  value(v) {
    if (v === undefined || typeof v === 'function' || typeof v === 'symbol') { this.u8(MPT_UNDEF); return; }
    if (v === null) { this.u8(MPT_NULL); return; }
    if (v === false) { this.u8(MPT_FALSE); return; }
    if (v === true) { this.u8(MPT_TRUE); return; }
    if (typeof v === 'number') {
      if (Number.isInteger(v) && v >= -2147483648 && v <= 2147483647 && !Object.is(v, -0)) {
        this.u8(MPT_INT); this.varu(((v << 1) ^ (v >> 31)) >>> 0);
      } else { this.u8(MPT_F64); this.f64(v); }
      return;
    }
    if (typeof v === 'string') { this.u8(MPT_STR); this.str(v); return; }
    if (typeof v === 'bigint') { this.u8(MPT_F64); this.f64(Number(v)); return; }
    if (this.ref(v)) return;
    if (ArrayBuffer.isView(v)) { this.typed(v); return; }
    if (v instanceof ArrayBuffer) { this.u8(MPT_AB); this.varu(v.byteLength); this.bytes(new Uint8Array(v)); return; }
    if (Array.isArray(v)) {
      this.u8(MPT_ARR); this.varu(v.length);
      for (let k = 0; k < v.length; k++) this.value(v[k]);
      return;
    }
    if (v instanceof Map) {
      this.u8(MPT_MAP); this.varu(v.size);
      for (const [k, x] of v) { this.value(k); this.value(x); }
      return;
    }
    if (v instanceof Set) {
      this.u8(MPT_SET); this.varu(v.size);
      for (const x of v) this.value(x);
      return;
    }
    const keys = Object.keys(v);
    this.u8(MPT_OBJ); this.varu(keys.length);
    for (const k of keys) { this.str(k); this.value(v[k]); }
  }
  typed(v) {
    let kind = MP_TA_KINDS.indexOf(v.constructor);
    // DataView и прочие виды — байтами.
    if (kind < 0) { kind = 1; v = new Uint8Array(v.buffer, v.byteOffset, v.byteLength); }
    this.u8(MPT_TA); this.u8(kind); this.varu(v.length);
    const size = v.BYTES_PER_ELEMENT;
    const src = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    this.need(src.length);
    const out = this.buf;
    if (size === 1) { out.set(src, this.pos); this.pos += src.length; return; }
    let o = this.pos;
    for (let p = 0; p < size; p++) for (let i = p; i < src.length; i += size) out[o++] = src[i];
    this.pos = o;
  }
  result() { return this.buf.slice(0, this.pos); }
}

class MpReader {
  constructor(bytes) { this.b = bytes; this.pos = 0; this.refs = []; this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
  u8() { return this.b[this.pos++]; }
  varu() {
    let v = 0, mul = 1, c;
    do { c = this.b[this.pos++]; v += (c & 127) * mul; mul *= 128; } while (c & 128);
    return v;
  }
  str() { const n = this.varu(); const s = mpTextDec.decode(this.b.subarray(this.pos, this.pos + n)); this.pos += n; return s; }
  value() {
    const tag = this.u8();
    switch (tag) {
      case MPT_UNDEF: return undefined;
      case MPT_NULL: return null;
      case MPT_FALSE: return false;
      case MPT_TRUE: return true;
      case MPT_INT: { const z = this.varu(); return (z >>> 1) ^ -(z & 1); }
      case MPT_F64: { const v = this.dv.getFloat64(this.pos, true); this.pos += 8; return v; }
      case MPT_STR: return this.str();
      case MPT_REF: return this.refs[this.varu()];
      case MPT_AB: {
        const n = this.varu(); const ab = this.b.slice(this.pos, this.pos + n).buffer; this.pos += n;
        this.refs.push(ab); return ab;
      }
      case MPT_TA: return this.typed();
      case MPT_ARR: {
        const n = this.varu(), a = new Array(n);
        this.refs.push(a);
        for (let k = 0; k < n; k++) a[k] = this.value();
        return a;
      }
      case MPT_MAP: {
        const n = this.varu(), m = new Map();
        this.refs.push(m);
        for (let k = 0; k < n; k++) { const key = this.value(); m.set(key, this.value()); }
        return m;
      }
      case MPT_SET: {
        const n = this.varu(), s = new Set();
        this.refs.push(s);
        for (let k = 0; k < n; k++) s.add(this.value());
        return s;
      }
      case MPT_OBJ: {
        const n = this.varu(), o = {};
        this.refs.push(o);
        for (let k = 0; k < n; k++) { const key = this.str(); o[key] = this.value(); }
        return o;
      }
    }
    throw new Error('mpUnpack: неизвестная метка ' + tag);
  }
  typed() {
    const Kind = MP_TA_KINDS[this.u8()], n = this.varu();
    const v = new Kind(n);
    this.refs.push(v);
    const size = v.BYTES_PER_ELEMENT, len = n * size;
    const dst = new Uint8Array(v.buffer), src = this.b;
    let o = this.pos;
    if (size === 1) dst.set(src.subarray(o, o + len));
    else for (let p = 0; p < size; p++) for (let i = p; i < len; i += size) dst[i] = src[o++];
    this.pos += len;
    return v;
  }
}

function mpPack(msg) { const w = new MpWriter(); w.value(msg); return w.result(); }
function mpUnpack(bytes) { return new MpReader(bytes).value(); }

// Сжатие встроенным в браузер deflate (CompressionStream: Chrome 80+,
// Firefox 113+, Safari 16.4+; в Node 18+ тоже есть). Без него — как есть.
const MP_HAS_ZIP = typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
async function mpStreamBytes(bytes, stream) {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}
function mpDeflate(bytes) { return mpStreamBytes(bytes, new CompressionStream('deflate-raw')); }
function mpInflate(bytes) { return mpStreamBytes(bytes, new DecompressionStream('deflate-raw')); }

// ---- кадры и очередь ----

class MpWire {
  // pipe — труба (см. шапку), onMsg(msg) — пришло сообщение.
  constructor(pipe, onMsg) {
    this.pipe = pipe;
    this.onMsg = onMsg;
    this.sender = ((Math.random() * 4294967295) >>> 0) || 1;   // свой номер для кусков
    this.seq = 0;
    this.selfHash = 0;          // хэш своего адреса (cid): кадры другим не распаковываем
    this.outQ = [];             // отправка: обещания [тело, флаги, кому], по порядку
    this.inQ = [];              // приём: обещания тел, по порядку
    this.parts = new Map();     // недособранные длинные: "отправитель:номер" → { parts, got }
    // Учёт для диагностики (diag.log): последнее большое сообщение.
    this.onBig = null;          // (сведения) — отправлено/принято большое сообщение
    pipe.onframe = (f) => this.accept(f);
  }

  setSelf(addr) { this.selfHash = addr ? mpHash32(addr) : 0; }

  // Отправить сообщение; to — адрес получателя (cid) или null — всем.
  send(msg, to) {
    const body = mpPack(msg), toHash = to ? mpHash32(to) : 0;
    const big = MP_HAS_ZIP && body.length >= MP_ZIP_MIN;
    // Мелкое при пустой очереди — сразу (и beforeunload успевает уйти).
    if (!big && !this.outQ.length) { this.emit(body, 0, toHash); return; }
    const t0 = Date.now();
    const job = big
      ? mpDeflate(body).then((z) => {
        if (this.onBig) this.onBig({ dir: 'out', t: msg.t, raw: body.length, wire: Math.min(z.length, body.length), ms: Date.now() - t0 });
        return z.length < body.length ? [z, MPF_ZIP, toHash] : [body, 0, toHash];
      }, () => [body, 0, toHash])
      : Promise.resolve([body, 0, toHash]);
    this.outQ.push(job);
    if (this.outQ.length === 1) this.drainOut();
  }

  async drainOut() {
    while (this.outQ.length) {
      const [body, flags, toHash] = await this.outQ[0];
      this.outQ.shift();
      if (this.pipe) this.emit(body, flags, toHash);
    }
  }

  // Тело — в кадры трубы: целиком или кусками по MP_CHUNK.
  emit(body, flags, toHash) {
    if (!this.pipe) return;
    if (body.length <= MP_CHUNK) {
      const f = new Uint8Array(6 + body.length);
      f[0] = MPF_WHOLE; f[1] = flags;
      new DataView(f.buffer).setUint32(2, toHash, true);
      f.set(body, 6);
      this.pipe.post(f);
      return;
    }
    const id = this.seq = (this.seq + 1) >>> 0, count = Math.ceil(body.length / MP_CHUNK);
    for (let k = 0; k < count; k++) {
      const part = body.subarray(k * MP_CHUNK, Math.min(body.length, (k + 1) * MP_CHUNK));
      const f = new Uint8Array(18 + part.length), dv = new DataView(f.buffer);
      f[0] = MPF_CHUNK; f[1] = flags;
      dv.setUint32(2, toHash, true); dv.setUint32(6, this.sender, true); dv.setUint32(10, id, true);
      dv.setUint16(14, k, true); dv.setUint16(16, count, true);
      f.set(part, 18);
      this.pipe.post(f);
    }
  }

  // Кадр из трубы.
  accept(f) {
    if (!(f instanceof Uint8Array) || f.length < 6) return;
    const dv = new DataView(f.buffer, f.byteOffset, f.byteLength);
    const toHash = dv.getUint32(2, true);
    if (toHash && toHash !== this.selfHash) return;   // не нам
    const flags = f[1];
    if (f[0] === MPF_WHOLE) { this.take(f.subarray(6), flags); return; }
    if (f[0] !== MPF_CHUNK || f.length < 18) return;
    const key = dv.getUint32(6, true) + ':' + dv.getUint32(10, true);
    const k = dv.getUint16(14, true), count = dv.getUint16(16, true);
    let e = this.parts.get(key);
    if (!e) {
      e = { parts: new Array(count), got: 0, size: 0 };
      this.parts.set(key, e);
      if (this.parts.size > MP_PARTS_KEEP) this.parts.delete(this.parts.keys().next().value);
    }
    if (e.parts[k]) return;
    e.parts[k] = f.slice(18); e.got++; e.size += f.length - 18;
    if (e.got < count) return;
    this.parts.delete(key);
    const body = new Uint8Array(e.size);
    let o = 0;
    for (const p of e.parts) { body.set(p, o); o += p.length; }
    this.take(body, flags);
  }

  // Тело сообщения: распаковать (если сжато) и отдать — по порядку прихода.
  take(body, flags) {
    if (!(flags & MPF_ZIP) && !this.inQ.length) { this.deliver(body); return; }
    const t0 = Date.now();
    const job = flags & MPF_ZIP
      ? mpInflate(body).then((raw) => {
        if (this.onBig) this.onBig({ dir: 'in', raw: raw.length, wire: body.length, ms: Date.now() - t0 });
        return raw;
      }, (e) => { console.warn('Пиксириус: не распаковалось сообщение', e); return null; })
      : Promise.resolve(body);
    this.inQ.push(job);
    if (this.inQ.length === 1) this.drainIn();
  }

  async drainIn() {
    while (this.inQ.length) {
      const body = await this.inQ[0];
      this.inQ.shift();
      if (body) this.deliver(body);
    }
  }

  deliver(body) {
    let msg;
    try { msg = mpUnpack(body); } catch (e) { console.warn('Пиксириус: битое сообщение', e); return; }
    if (this.pipe) this.onMsg(msg);
  }

  // Ещё что-то не ушло (большое сообщение сжимается).
  get busy() { return this.outQ.length > 0; }

  close() {
    if (this.pipe) { this.pipe.onframe = null; this.pipe.close(); }
    this.pipe = null;
    this.outQ.length = 0; this.inQ.length = 0; this.parts.clear();
  }
}

// ---- трубы ----

// Вкладки одного браузера: BroadcastChannel по имени лобби. Кадр копируется
// браузером — отдельный массив на каждый, не вид на общий буфер (иначе
// копировался бы весь буфер).
class MpChannelPipe {
  constructor(name) {
    this.sameBrowser = true;
    this.onframe = null;
    this.chan = new BroadcastChannel(name);
    this.chan.onmessage = (e) => { if (this.onframe) this.onframe(e.data); };
  }
  post(bytes) { if (this.chan) this.chan.postMessage(bytes); }
  close() { if (this.chan) { this.chan.close(); this.chan = null; } }
}

// Труба для лобби с этим именем канала. Здесь же появится выбор сетевой
// (см. шапку).
function mpOpenPipe(name) { return new MpChannelPipe(name); }
