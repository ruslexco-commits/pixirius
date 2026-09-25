'use strict';

// Реакции обычных материалов: горение, лава, лёд, песок, соль, вода,
// пустота, клонер, влажность земли. Химия системы долей — в chemistry.js.
//
// Методы класса Sim, вынесенные в отдельный файл: класс ниже — только
// контейнер, extendSim переносит его методы в Sim.prototype (см. core.js).

class SimReactions {
  reactFlammable(x, y, i, id) {
    const el = ELEMENTS[id];
    for (let k = 0; k < 4; k++) {
      const nx = x + DX4[k], ny = y + DY4[k];
      if (!this.inBounds(nx, ny)) continue;
      const nt = this.type[this.idx(nx, ny)];
      if (nt === EL.FIRE || nt === EL.LAVA) {
        if (id === EL.GUNP) {
          this.detonateGunpowder(x, y);
          return;
        }
        if (Math.random() < el.burnChance) {
          this.spawn(i, EL.FIRE);
          this.life[i] = el.burnLife + (Math.random() * 10 | 0);
          this.extra[i] = (id === EL.WOOD) ? 1 : 0;
        }
        return;
      }
    }
  }

  // Масло застывает при касании твёрдого тела или якоря (не при касании
  // другого масла — иначе слой мог бы бесконтрольно нарастать) — становится
  // OILFILM с запомненным направлением ЕДИНСТВЕННОЙ связи (см. computeStability:
  // застывшее масло держится только за эту связь и никогда не передаёт
  // устойчивость дальше, поэтому не может склеить два разных объекта).
  // Горение по-прежнему в приоритете: если рядом ещё и огонь/лава — масло
  // просто вспыхивает, а не застывает.
  reactOil(x, y, i) {
    const el = ELEMENTS[EL.OIL];
    let solidifyDir = -1;
    for (let k = 0; k < 4; k++) {
      const nx = x + DX4[k], ny = y + DY4[k];
      if (!this.inBounds(nx, ny)) continue;
      const nt = this.type[this.idx(nx, ny)];
      if (nt === EL.FIRE || nt === EL.LAVA) {
        if (Math.random() < el.burnChance) {
          this.spawn(i, EL.FIRE);
          this.life[i] = el.burnLife + (Math.random() * 10 | 0);
        }
        return;
      }
      // OILFILM намеренно исключено: иначе слой мог бы бесконтрольно расти,
      // застывая каждый раз заново от уже застывшего масла рядом (OILFILM
      // входит в isStructural() ради физики падения/устойчивости, но это
      // отдельный вопрос от того, что именно триггерит застывание).
      if (solidifyDir === -1 && nt !== EL.OILFILM && (isStructural(nt) || isAnchor(nt))) {
        solidifyDir = oilDirCode(DX4[k], DY4[k]);
      }
    }
    if (solidifyDir !== -1) {
      this.spawn(i, EL.OILFILM);
      this.extra[i] = solidifyDir;
    }
  }

  // Порох детонирует мгновенно и целиком: обычная покадровая передача огня
  // (как у дерева) не успевает пройти по всей связной массе за короткое время
  // жизни огня, и часть пороха гаснет непровзорвавшейся. Взрывчатке нужен
  // надёжный мгновенный подрыв всего связного куска, а не вероятностная волна.
  detonateGunpowder(x0, y0) {
    const w = this.w, h = this.h;
    const startI = this.idx(x0, y0);
    if (this.type[startI] !== EL.GUNP) return;
    const burnLife = ELEMENTS[EL.GUNP].burnLife;
    const stack = [startI];
    const visited = new Uint8Array(w * h);
    visited[startI] = 1;
    while (stack.length) {
      const i = stack.pop();
      this.spawn(i, EL.FIRE);
      this.life[i] = burnLife + (Math.random() * 10 | 0);
      this.moved[i] = 1;
      const x = i % w, y = (i / w) | 0;
      if (x > 0) { const ni = i - 1; if (!visited[ni]) { visited[ni] = 1; if (this.type[ni] === EL.GUNP) stack.push(ni); } }
      if (x < w - 1) { const ni = i + 1; if (!visited[ni]) { visited[ni] = 1; if (this.type[ni] === EL.GUNP) stack.push(ni); } }
      if (y > 0) { const ni = i - w; if (!visited[ni]) { visited[ni] = 1; if (this.type[ni] === EL.GUNP) stack.push(ni); } }
      if (y < h - 1) { const ni = i + w; if (!visited[ni]) { visited[ni] = 1; if (this.type[ni] === EL.GUNP) stack.push(ni); } }
    }
  }

  reactFire(x, y, i) {
    this.life[i]--;
    if (this.life[i] <= 0) {
      const fromWood = this.extra[i] === 1;
      const r = Math.random();
      if (fromWood && r < 0.3) this.spawn(i, EL.ASH);
      else if (r < 0.5) this.spawn(i, EL.SMOKE);
      else this.clearCell(i);
      return;
    }
    if (Math.random() < 0.06) {
      const ny = y - 1;
      if (this.inBounds(x, ny)) {
        const ni = this.idx(x, ny);
        if (this.type[ni] === EL.EMPTY) { this.spawn(ni, EL.SMOKE); this.moved[ni] = 1; }
      }
    }
  }

  // Порог застывания заметно ниже meltPoint камня (55), а не тот же самый —
  // иначе клетка на самой границе колебалась бы между лавой и камнем каждый
  // кадр от мельчайших шумовых колебаний температуры около одного и того же
  // числа (гистерезис: плавится при 55+, застывает только при 30-, между
  // ними остаётся тем, чем уже является).
  reactLava(x, y, i) {
    if (this.temp[i] < 30) { this.spawn(i, EL.STONE); return; }
    for (let k = 0; k < 4; k++) {
      const nx = x + DX4[k], ny = y + DY4[k];
      if (!this.inBounds(nx, ny)) continue;
      const ni = this.idx(nx, ny);
      const nt = this.type[ni];
      if (nt === EL.WATER) {
        if (Math.random() < 0.6) this.spawn(ni, EL.STEAM);
        if (Math.random() < 0.5) { this.spawn(i, EL.STONE); return; }
      } else if (nt === EL.ICE) {
        if (Math.random() < 0.4) this.spawn(ni, EL.WATER);
      } else if (nt === EL.GUNP) {
        this.detonateGunpowder(nx, ny);
      } else if (nt === EL.WOOD || nt === EL.OIL) {
        const el = ELEMENTS[nt];
        if (Math.random() < el.burnChance) {
          this.spawn(ni, EL.FIRE);
          this.life[ni] = el.burnLife + (Math.random() * 10 | 0);
          this.extra[ni] = (nt === EL.WOOD) ? 1 : 0;
        }
      }
    }
  }

  reactIce(x, y, i) {
    for (let k = 0; k < 4; k++) {
      const nx = x + DX4[k], ny = y + DY4[k];
      if (!this.inBounds(nx, ny)) continue;
      const ni = this.idx(nx, ny);
      const nt = this.type[ni];
      if (nt === EL.FIRE || nt === EL.LAVA) {
        if (Math.random() < 0.5) { this.spawn(i, EL.WATER); return; }
      } else if (nt === EL.WATER) {
        if (Math.random() < 0.015) this.spawn(ni, EL.ICE);
      }
    }
  }

  reactSmoke(x, y, i) {
    this.life[i]--;
    if (this.life[i] <= 0) this.clearCell(i);
  }

  reactSand(x, y, i) {
    for (let k = 0; k < 4; k++) {
      const nx = x + DX4[k], ny = y + DY4[k];
      if (!this.inBounds(nx, ny)) continue;
      const nt = this.type[this.idx(nx, ny)];
      if (nt === EL.LAVA || nt === EL.FIRE) {
        if (Math.random() < 0.01) this.spawn(i, EL.GLASS);
        return;
      }
    }
  }

  // Твёрдые материалы плавятся в лаву, если ЛОКАЛЬНАЯ температура (см.
  // updateTemp/getTemp) достигла их meltPoint — не по факту касания
  // огня/лавы напрямую, а через тепло, которое от них диффундирует
  // (см. updateTemp): тело рядом, но не впритык, тоже постепенно
  // нагреется и в итоге расплавится, просто медленнее. meltChance —
  // шанс В КАДР собственно перехода, если условие по температуре уже
  // выполнено (не "успеет ли расплавиться вообще", а "именно в этот
  // кадр" — чтобы разные клетки одного блока не плавились все разом в
  // ту же миллисекунду, когда переваливают порог). Дерево/масло(-плёнка)/
  // порох сюда не входят — у них своя реакция горения (reactFlammable);
  // лёд тоже не входит — у него уже есть reactIce (топится в воду, а не
  // в лаву, плюс попутно замораживает воду рядом — отдельный, не сводимый
  // к простому "плавлению" механизм).
  reactMelt(x, y, i, id) {
    const el = ELEMENTS[id];
    if (this.temp[i] >= el.meltPoint && Math.random() < el.meltChance) {
      // seedHeat=false — см. комментарий у spawn(): расплав сохраняет
      // свою уже-достаточную-для-плавления температуру, а не подскакивает
      // до полного heatSource лавы (иначе цепная реакция плавления не
      // затухает).
      this.spawn(i, el.meltsInto, false);
    }
  }

  reactSalt(x, y, i) {
    for (let k = 0; k < 4; k++) {
      const nx = x + DX4[k], ny = y + DY4[k];
      if (!this.inBounds(nx, ny)) continue;
      if (this.type[this.idx(nx, ny)] === EL.WATER) {
        if (Math.random() < 0.03) this.clearCell(i);
        return;
      }
    }
  }

  // Вода тушит огонь. Кипение — не здесь: оно общее для всех жидкостей
  // системы долей и живёт в tickComposition/tickPhase, где у каждого
  // вещества своя точка кипения (у воды — ровно 100).
  reactWater(x, y, i) {
    this.tickComposition(x, y, i);
    if (!this.hasParts(i)) return;
    // Чистая вода идёт своей веткой, мимо reactSolutionLike, поэтому
    // ржавление металла вызывается здесь отдельно — иначе лужа обычной
    // воды на металле не делала бы ровным счётом ничего.
    if (Math.random() < RUST_TICK_CHANCE && solGet(this.sol[i], P_WATER) > 0) this.rustNeighbours(x, y, i);
    if (this.type[i] !== EL.WATER) return;
    for (let k = 0; k < 4; k++) {
      const nx = x + DX4[k], ny = y + DY4[k];
      if (!this.inBounds(nx, ny)) continue;
      const ni = this.idx(nx, ny);
      if (this.type[ni] === EL.FIRE) {
        if (Math.random() < 0.5) this.clearCell(ni);
      }
    }
  }

  reactVoid(x, y, i) {
    for (let k = 0; k < 4; k++) {
      const nx = x + DX4[k], ny = y + DY4[k];
      if (!this.inBounds(nx, ny)) continue;
      const ni = this.idx(nx, ny);
      const nt = this.type[ni];
      if (nt !== EL.EMPTY && nt !== EL.WALL && nt !== EL.VOID) {
        if (Math.random() < 0.9) this.clearCell(ni);
      }
    }
  }

  reactClone(x, y, i) {
    if (this.extra[i] === 0) {
      for (let k = 0; k < 8; k++) {
        const nx = x + DX8[k], ny = y + DY8[k];
        if (!this.inBounds(nx, ny)) continue;
        const nt = this.type[this.idx(nx, ny)];
        if (nt !== EL.EMPTY && nt !== EL.CLONE && nt !== EL.WALL) { this.extra[i] = nt; break; }
      }
    }
    if (this.extra[i] !== 0) {
      for (let k = 0; k < 8; k++) {
        const nx = x + DX8[k], ny = y + DY8[k];
        if (!this.inBounds(nx, ny)) continue;
        const ni = this.idx(nx, ny);
        if (this.type[ni] === EL.EMPTY && Math.random() < 0.25) {
          const remembered = this.extra[i];
          this.spawn(ni, remembered);
          this.moved[ni] = 1;
        }
      }
    }
  }

  // Раз в тик влажности (фиксировано, TICK_FRAMES кадров симуляции). Общая
  // скорость времени (sim.timeScale) теперь регулируется ОДНИМ способом
  // сразу для всех процессов — см. main.js: она правит тем, СКОЛЬКО РАЗ
  // step() вызывается на кадр отрисовки, а не отдельными порогами внутри
  // конкретных механик. Этот счётчик поэтому специально НЕ завязан на
  // timeScale напрямую — при двойной завязке (и тут, и там) земля мокла бы
  // не линейно, а квадратично быстрее при ускорении времени.
  //
  // Земля/мокрая земля по очереди: (1) впитывает соседний пиксель воды,
  // если есть запас ёмкости (MAX_MOISTURE) — именно от этого земля впервые
  // становится мокрой землёй; (2) отдаёт ровно 1 единицу влажности САМОМУ
  // СУХОМУ соседу своего же семейства (земля/мокрая земля), если у него
  // меньше — простая диффузия влажности, которая может домочить соседнюю
  // сухую землю; (3) — только мокрая земля, только в покое (stability>0 —
  // уже не собирается падать в этот кадр) и только если внизу есть куда
  // упасть воде — капает, теряя 1 единицу влажности. Каждый из этих шагов —
  // строго атомарная пара "убрать у источника / добавить получателю"
  // (никогда одно без другого), чтобы вода не дублировалась и не терялась
  // в никуда. Высохшая до 0 мокрая земля возвращается в обычную землю.
  tickMoisture(x, y, i, id) {
    const TICK_FRAMES = 60;
    this.life[i]++;
    if (this.life[i] < TICK_FRAMES) return;
    this.life[i] = 0;

    const w = this.w, h = this.h;
    const MAX_MOISTURE = 3;
    let moisture = this.moisture[i];
    let curId = id;

    if (moisture < MAX_MOISTURE) {
      for (let k = 0; k < 4; k++) {
        const nx = x + DX4[k], ny = y + DY4[k];
        if (!this.inBounds(nx, ny)) continue;
        const ni = this.idx(nx, ny);
        if (this.type[ni] === EL.WATER) {
          this.clearCell(ni);
          moisture++;
          if (curId === EL.EARTH) { this.spawn(i, EL.WET_EARTH); curId = EL.WET_EARTH; }
          break;
        }
      }
    }

    if (moisture > 0) {
      let targetNi = -1, targetMoisture = moisture;
      for (let k = 0; k < 4; k++) {
        const nx = x + DX4[k], ny = y + DY4[k];
        if (!this.inBounds(nx, ny)) continue;
        const ni = this.idx(nx, ny);
        const nt = this.type[ni];
        if (nt !== EL.EARTH && nt !== EL.WET_EARTH) continue;
        const nm = this.moisture[ni];
        if (nm < targetMoisture) { targetMoisture = nm; targetNi = ni; }
      }
      if (targetNi !== -1) {
        if (this.type[targetNi] === EL.EARTH) this.spawn(targetNi, EL.WET_EARTH);
        this.moisture[targetNi]++;
        moisture--;
      }
    }

    if (curId === EL.WET_EARTH && moisture > 0 && this.stability[i] > 0) {
      const slots = [];
      if (y + 1 < h) {
        const bi = this.idx(x, y + 1);
        if (this.type[bi] === EL.EMPTY) slots.push(bi);
        if (x > 0) { const bli = this.idx(x - 1, y + 1); if (this.type[bli] === EL.EMPTY) slots.push(bli); }
        if (x < w - 1) { const bri = this.idx(x + 1, y + 1); if (this.type[bri] === EL.EMPTY) slots.push(bri); }
      }
      if (slots.length > 0) {
        const drip = slots[(Math.random() * slots.length) | 0];
        this.spawn(drip, EL.WATER);
        moisture--;
      }
    }

    this.moisture[i] = moisture;
    if (curId === EL.WET_EARTH && moisture === 0) this.spawn(i, EL.EARTH);
  }

  // Каждый кадр (как обычное плавление reactMelt, а не по тику влажности) —
  // если клетку нагрело до точки кипения воды (ELEMENTS[EL.WATER].boilPoint),
  // есть небольшой шанс, что часть влаги просочится наружу паром через
  // любую соседнюю пустую клетку (по возможности вверх — пар поднимается).
  tryEvaporateMoisture(x, y, i) {
    if (this.moisture[i] <= 0) return;
    const boilPoint = ELEMENTS[EL.WATER].boilPoint;
    if (this.temp[i] < boilPoint) return;
    const EVAP_CHANCE = 0.05;
    if (Math.random() >= EVAP_CHANCE) return;
    const w = this.w, h = this.h;
    let target = -1;
    if (y - 1 >= 0) {
      const ni = this.idx(x, y - 1);
      if (this.type[ni] === EL.EMPTY) target = ni;
    }
    if (target === -1) {
      const opts = [];
      if (x > 0) { const ni = this.idx(x - 1, y); if (this.type[ni] === EL.EMPTY) opts.push(ni); }
      if (x < w - 1) { const ni = this.idx(x + 1, y); if (this.type[ni] === EL.EMPTY) opts.push(ni); }
      if (y + 1 < h) { const ni = this.idx(x, y + 1); if (this.type[ni] === EL.EMPTY) opts.push(ni); }
      if (opts.length) target = opts[(Math.random() * opts.length) | 0];
    }
    if (target === -1) return;
    this.spawn(target, EL.STEAM);
    this.moisture[i]--;
    if (this.moisture[i] === 0) this.spawn(i, EL.EARTH);
  }
}

extendSim(SimReactions);
