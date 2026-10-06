'use strict';

// Отмена (snapshot/restore) и сохранение в файл (serialize/deserialize).
// Какие поля клетки входят в оба — задаёт PARTICLE_FIELDS в core.js, а не
// эти функции: новое поле клетки добавляется там один раз. Отмена сверх
// того откатывает сетку ветра (UNDO_WIND_FIELDS ниже).
//
// Методы класса Sim, вынесенные в отдельный файл: класс ниже — только
// контейнер, extendSim переносит его методы в Sim.prototype (см. core.js).

function bufToB64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function b64ToBuf(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// Поля сетки ветра, которые входят в снимок отмены (но не в сохранение).
const UNDO_WIND_FIELDS = ['windVX', 'windVY'];

class SimPersistence {
  // temp — часть отменяемого состояния: она НАПРЯМУЮ определяет,
  // расплавится ли материал (reactMelt), и это необратимое, "случившееся
  // один раз" превращение. Без temp в снимке отмена вернёт камню его
  // type=STONE, но клетка останется такой же горячей — и камень тут же
  // расплавится заново на следующий же кадр, так что отмена выглядела бы
  // так, будто она вообще не сработала.
  //
  // Ветер (windVX/VY) тоже откатывается. Раньше он считался фоновым
  // состоянием, которое "ни от чего не зависит", и в снимок не входил, —
  // но он зависит: падающее тело и текущая вода сами гонят воздух (см.
  // disturbWind). Пользователь отменял падение предмета, предмет
  // возвращался на место, а поток воздуха, поднятый его падением,
  // оставался — ветер от тела, которого уже не было. В файл сохранения
  // ветер по-прежнему не пишется: загруженный мир начинает в штиле.
  snapshot() {
    const snap = {};
    for (const f of PARTICLE_FIELDS) snap[f.name] = this[f.name].slice();
    for (const name of UNDO_WIND_FIELDS) snap[name] = this[name].slice();
    return snap;
  }

  restore(snap) {
    this.resetCharges();   // заряды — импульсы, в снимок не входят
    for (const f of PARTICLE_FIELDS) {
      if (snap[f.name]) this[f.name].set(snap[f.name]);
      else this[f.name].fill(f.empty);
    }
    for (const name of UNDO_WIND_FIELDS) {
      if (snap[name]) this[name].set(snap[name]);
      else this[name].fill(0);
    }
    // Снимок ветра на кадр (его показывает отладочный режим 2) — тот же,
    // что и откатанный ветер, а не ветер отменённого будущего.
    this.windVXFrame.set(this.windVX);
    this.windVYFrame.set(this.windVY);
    this.moved.fill(0);
    // Мир переписан целиком в обход обычных записей — будим все куски.
    this.wakeAll();
  }

  serialize() {
    // Версия 2: в beam материал балки, а не маска опор. Версия 3: состав у
    // каждой клетки, доли — элементы (solLo/solHi). См. deserialize.
    // Настройки мира из лупы: темнота и видимость карты протагонистом.
    const out = { v: 3, w: this.w, h: this.h, darkness: this.darkness, vision: this.playerVision, lightSmooth: this.lightSmooth, rays: this.playerRays,
      // Точки спавна и респавна игроков (sim/spawns.js).
      spawnMarks: this.spawnMarks, respawnMarks: this.respawnMarks };
    for (const f of PARTICLE_FIELDS) out[f.saveKey || f.name] = bufToB64(this[f.name].buffer);
    return out;
  }

  // Поля, которых нет в файле (он сохранён до их появления), явно
  // сбрасываются к empty, а НЕ остаются как есть: "как есть" — это
  // состояние ТЕКУЩЕЙ, ещё не выгруженной сессии, а не сохранённого мира.
  // Без явного сброса что-нибудь горячее/мокрое, над чем шёл эксперимент
  // до нажатия "Загрузить", утекало бы в свежезагруженный мир.
  //
  // Файл без обязательных полей (required) не читается вовсе — и мир при
  // этом не трогается: проверка идёт до первой записи.
  deserialize(obj) {
    this.resetCharges();
    // Карта сменилась: экраны игроков забывают увиденное (js/play.js).
    this.mapEpoch = (this.mapEpoch || 0) + 1;
    if (!obj || obj.w !== this.w || obj.h !== this.h) return false;
    for (const f of PARTICLE_FIELDS) if (f.required && !obj[f.saveKey || f.name]) return false;
    for (const f of PARTICLE_FIELDS) {
      const data = obj[f.saveKey || f.name];
      const arr = this[f.name];
      if (data) arr.set(new arr.constructor(b64ToBuf(data)));
      else arr.fill(f.empty);
    }
    // Файл до версии 3: состав был только у жидкостей и газов и хранился
    // иначе (sol32 — семь фиксированных видов по 4 бита), а у остального
    // его не было вовсе. Без перевода клетки остались бы с нулевым
    // составом, то есть "целиком пустыми". Каждой клетке — честный состав
    // по её типу, а жидкостям и газам — их прежние доли, переведённые в
    // элементы (в газе — газовые: вода -> пар, кислота -> кислотный газ).
    if (!obj.solLo) {
      const old = obj.sol32 ? new Uint32Array(b64ToBuf(obj.sol32)) : null;
      const LIQUID_KIND = [0, EL.WATER, EL.ACID, EL.REAGENT, EL.OIL, EL.STONE, EL.BLACK_SALT];
      const GAS_KIND = [0, EL.STEAM, EL.ACID_GAS, EL.REAGENT_GAS, EL.OIL_GAS, EL.STONE, EL.BLACK_SALT];
      for (let i = 0; i < this.type.length; i++) {
        const t = this.type[i];
        if (old && hasComposition(t) && old[i]) {
          const kinds = isVaporFamily(t) ? GAS_KIND : LIQUID_KIND;
          let comp = 0;
          for (let k = 1; k < LIQUID_KIND.length; k++) {
            const n = (old[i] >>> (k * 4)) & 15;
            if (n) comp = solWith(comp, kinds[k], n);
          }
          this.setComposition(i, comp);
        } else {
          this.setComp(i, pureCompFor(t));
        }
      }
    }
    // До версии 2 в beam лежала маска направлений на опору (числа 1..15),
    // а не материал; прочитанная как id элемента, она дала бы балки из
    // случайных веществ. Балки тогда были только каменные.
    if (!(obj.v >= 2)) {
      for (let i = 0; i < this.beam.length; i++) {
        if (this.beam[i]) { this.beam[i] = EL.STONE; this.beamExtra[i] = 0; }
      }
    }
    // Файл без настроек (сохранён до них) — значения по умолчанию.
    this.darkness = obj.darkness >= 1 && obj.darkness <= 3 ? obj.darkness : 1;
    this.playerVision = obj.vision >= 1 && obj.vision <= 3 ? obj.vision : 3;
    this.lightSmooth = obj.lightSmooth !== false;
    this.playerRays = obj.rays === true;
    this.spawnMarks = Array.isArray(obj.spawnMarks) ? obj.spawnMarks.map((m) => ({ x: m.x | 0, y: m.y | 0, n: m.n | 0 })) : [];
    this.respawnMarks = Array.isArray(obj.respawnMarks) ? obj.respawnMarks.map((m) => ({ x: m.x | 0, y: m.y | 0, players: m.players || null, kinds: m.kinds || null, physics: !!m.physics, acid: !!m.acid })) : [];
    this.moved.fill(0);
    this.wakeAll();
    return true;
  }
}

extendSim(SimPersistence);
