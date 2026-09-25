'use strict';

// Отмена (snapshot/restore) и сохранение в файл (serialize/deserialize).
// Какие поля входят в оба — задаёт PARTICLE_FIELDS в core.js, а не эти
// функции: новое поле клетки добавляется там один раз.
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

class SimPersistence {
  // temp — часть отменяемого состояния, в отличие от ветра (windVX/VY,
  // см. комментарий в input.js про pressureInc/Dec): ветер — фоновое,
  // самопроизвольно гуляющее состояние, которое ни от чего "не зависит"
  // с точки зрения истории действий. Температура — иначе: она НАПРЯМУЮ
  // определяет, расплавится ли материал (reactMelt), и это необратимое,
  // "случившееся один раз" превращение. Без temp в снимке отмена вернёт
  // камню его type=STONE, но клетка сетки тепла останется такой же
  // горячей — и камень тут же расплавится заново на следующий же кадр,
  // так что отмена выглядела бы так, будто она вообще не сработала.
  snapshot() {
    const snap = {};
    for (const f of PARTICLE_FIELDS) snap[f.name] = this[f.name].slice();
    return snap;
  }

  restore(snap) {
    for (const f of PARTICLE_FIELDS) {
      if (snap[f.name]) this[f.name].set(snap[f.name]);
      else this[f.name].fill(f.empty);
    }
    this.moved.fill(0);
  }

  serialize() {
    const out = { v: 1, w: this.w, h: this.h };
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
    if (!obj || obj.w !== this.w || obj.h !== this.h) return false;
    for (const f of PARTICLE_FIELDS) if (f.required && !obj[f.saveKey || f.name]) return false;
    for (const f of PARTICLE_FIELDS) {
      const data = obj[f.saveKey || f.name];
      const arr = this[f.name];
      if (data) arr.set(new arr.constructor(b64ToBuf(data)));
      else arr.fill(f.empty);
    }
    // Состава могло не быть вовсе (старый файл) или он мог быть старого
    // формата — тогда клетки семейства долей остались бы с нулевым
    // составом, то есть "целиком пустыми", и растворились бы в воздухе на
    // первом же кадре. Восстанавливаем им честный полный состав по типу.
    if (!obj.sol32) {
      for (let i = 0; i < this.type.length; i++) {
        const pure = PURE_COMP_BY_ELEMENT[this.type[i]];
        if (pure) this.sol[i] = pure;
      }
    }
    this.moved.fill(0);
    return true;
  }
}

extendSim(SimPersistence);
