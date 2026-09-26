'use strict';

// Справка лупы: щелчок лупой (инструмент во вкладке "Разное") по клетке
// открывает по центру экрана большую панель о том, что в этой клетке, —
// просьба пользователя: название, состав круговой диаграммой цветами
// долей, температуры переходов (кипение, конденсация, замерзание,
// плавление), стойкость, отношение к кислоте с выделяемыми газами и к
// воде.
//
// Все числа берутся из тех же таблиц и констант, по которым работает
// симуляция (ELEMENTS, BOIL_POINT/FREEZE_POINT, OXIDE_LINE, RUST_*,
// OXIDISE_SLOWER...), а не пишутся здесь заново: правка механики сразу
// видна и в справке. Правила же, записанные словами (какой газ даёт
// растворение, что делает ржавчина по стадиям), повторяют код в
// sim/chemistry.js и sim/oxides.js — меняя там поведение, поправь и текст
// здесь.

// Пустота на диаграмме: у неё нет своего цвета (клетка с пустотой просто
// бледнее), поэтому — нейтральный серый, отличимый от фона.
const INSPECT_VOID_COLOR = [70, 70, 80];

const CAT_NAME = {
  [CAT.POWDER]: 'сыпучее',
  [CAT.LIQUID]: 'жидкость',
  [CAT.GAS]: 'газ',
  [CAT.SOLID]: 'твёрдое',
  [CAT.SPECIAL]: 'особое',
};

function cssRgb(c) { return `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`; }
function elName(id) { return ELEMENTS[id] ? ELEMENTS[id].name : '—'; }
function deg(t) { return `${t}°`; }

// Круговая диаграмма состава: parts — [{ n, color }], в сумме SOL_PARTS.
// Сектора начинаются сверху и идут по часовой стрелке.
function compositionPieSVG(parts, size) {
  const r = size / 2 - 2, c = size / 2;
  let svg = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`;
  const nonEmpty = parts.filter((p) => p.n > 0);
  if (nonEmpty.length === 1) {
    svg += `<circle cx="${c}" cy="${c}" r="${r}" fill="${cssRgb(nonEmpty[0].color)}" stroke="#101014" stroke-width="1.5"/>`;
  } else {
    let a0 = -Math.PI / 2;
    for (const p of nonEmpty) {
      const a1 = a0 + (p.n / SOL_PARTS) * Math.PI * 2;
      const x0 = c + r * Math.cos(a0), y0 = c + r * Math.sin(a0);
      const x1 = c + r * Math.cos(a1), y1 = c + r * Math.sin(a1);
      const large = a1 - a0 > Math.PI ? 1 : 0;
      svg += `<path d="M${c},${c} L${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)} Z" fill="${cssRgb(p.color)}" stroke="#101014" stroke-width="1.5"/>`;
      a0 = a1;
    }
  }
  return svg + '</svg>';
}

// Цвет клетки по составу — тот же, что рисуется (solColor). Для образца
// в заголовке: у раствора цвет из таблицы элементов ничего не говорит о
// том, что в нём.
function compositionColor(comp, fallback) {
  return solMatter(comp) > 0 ? solColor(comp) : fallback;
}

// Строка "название — значение" и пункт заметки.
function ipRow(a, b) { return `<div class="ip-row"><span>${a}</span><span>${b}</span></div>`; }
function ipNote(text) { return `<div class="ip-note">${text}</div>`; }
function ipSection(title, body) { return body ? `<div class="ip-section"><h3>${title}</h3>${body}</div>` : ''; }

// Состав клетки: диаграмма и легенда (вещества, пустота — последней).
// Фаза доли — рядом с названием: вода и пар — разные доли одного вещества.
const STATE_NAME = ['', 'газ', 'жидкость', 'твёрдое'];
function compositionSection(comp) {
  const parts = [];
  for (let s = 0; s < SOL_SLOTS; s++) {
    const slot = solSlot(comp, s);
    if (!slot) break;
    parts.push({ k: slotId(slot), n: slotCount(slot), color: PART_COLOR[slotId(slot)] });
  }
  const v = solGet(comp, P_VOID);
  if (v) parts.push({ k: P_VOID, n: v, color: INSPECT_VOID_COLOR });
  let legend = '';
  for (const p of parts) {
    legend += `<div class="ip-legend-row"><span class="ip-sw" style="background:${cssRgb(p.color)}"></span>`
      + `<span class="ip-legend-name">${PART_NAME[p.k]}${p.k ? ` <span class="ip-state">${STATE_NAME[PART_STATE[p.k]]}</span>` : ''}</span>`
      + `<span>${p.n} из ${SOL_PARTS} · ${p.n * 100 / SOL_PARTS}%</span></div>`;
  }
  return `<div class="ip-comp"><div class="ip-pie">${compositionPieSVG(parts, 132)}</div><div class="ip-legend">${legend}</div></div>`;
}

// Температуры переходов: всё, что с этой клеткой случится от нагрева или
// охлаждения.
function temperaturesSection(sim, i, id) {
  const el = ELEMENTS[id];
  let out = '';
  // Переходы каждой доли состава: жидкая кипит и замерзает, газ
  // конденсируется, твёрдая форма жидкости тает (см. PHASE_LINKS).
  const comp = sim.comp(i);
  for (let s = 0; s < SOL_SLOTS; s++) {
    const slot = solSlot(comp, s);
    if (!slot) break;
    const k = slotId(slot);
    const name = PART_NAME[k];
    if (k === EL.OIL_GAS) {
      out += ipNote(`${name} выпадает маслом не по температуре, а по сроку: через ${OIL_GAS_LIFE_MIN / 3600}–${OIL_GAS_LIFE_MAX / 3600} мин`);
      continue;
    }
    if (BOIL_TO[k]) {
      if (BOIL_POINT[k] !== Infinity) out += ipRow(`${name}: кипение → ${elName(BOIL_TO[k])}`, deg(BOIL_POINT[k]));
      else out += ipNote(`${name} по температуре не кипит`);
    }
    if (FREEZE_TO[k]) out += ipRow(`${name}: замерзание → ${elName(FREEZE_TO[k])}`, `ниже ${deg(FREEZE_POINT[k])}`);
    if (CONDENSE_TO[k]) out += ipRow(`${name}: конденсация → ${elName(CONDENSE_TO[k])}`, `ниже ${deg(BOIL_POINT[CONDENSE_TO[k]])}`);
    if (THAW_TO[k]) out += ipRow(`${name}: таяние → ${elName(THAW_TO[k])}`, `выше ${deg(FREEZE_POINT[THAW_TO[k]])}`);
    if (k === P_SALT) out += ipNote(`${name} не испаряются, не замерзают и не плавятся`);
  }
  if (el.meltPoint !== undefined) {
    let into = elName(el.meltsInto);
    if (id === EL.OXIDE || id === EL.OXIDE_LOOSE) {
      const stage = sim.oxideStage(i);
      into += `, выделяя газ: ${PART_NAME[P_REAGENT].toLowerCase()} ${stage} из ${SOL_PARTS} долей`;
    }
    out += ipRow('Плавление', `${deg(el.meltPoint)} → ${into}`);
  }
  if (id === EL.LAVA) out += ipRow('Застывание', `ниже ${deg(LAVA_SOLIDIFY_TEMP)} → ${elName(EL.STONE)}`);
  if (el.heatSource) out += ipRow('Источник тепла', deg(el.heatSource));
  if (el.flammable && el.burnChance) {
    out += ipRow('Воспламенение', `от огня и лавы, ${Math.round(el.burnChance * 100)}% в кадр`);
    if (id === EL.WOOD) out += ipNote('Сгорая, оставляет золу');
  }
  return out;
}

// Прочность твёрдого: устойчивость и стойкость (на сколько клеток его
// можно вывести в сторону от опоры). Хрупкий окисел держит не по своим
// числам, а по "деревянным" (см. cellStability) — они и показываются.
// Вылет: устойчивость убывает на 1 каждые toughness клеток вбок и на
// нуле клетка падает, отсюда maxStab * toughness - 1 (без углов).
function strengthRows(maxStab, toughness, frail) {
  if (frail) { maxStab = OXIDE_FRAIL_STABILITY; toughness = OXIDE_FRAIL_TOUGHNESS; }
  const reach = maxStab * toughness - 1;
  let out = ipRow('Макс. устойчивость', maxStab)
    + ipRow('Стойкость', `${toughness} (вбок от опоры до ~${reach} кл.)`);
  if (frail) out += ipNote('Окисел хрупкий: держит как дерево');
  return out;
}

// Кислота: берёт ли, как, и какой газ выделяется при растворении (см.
// dissolveNeighbours и ventGas в sim/chemistry.js; для балки —
// reactLiquidOnBeam: остатка она не оставляет, лечь ему некуда).
function acidSection(id, stage, forBeam) {
  const el = ELEMENTS[id];
  if (id === EL.EMPTY || isSolutionMedium(id) || isVaporFamily(id) || IS_GASLIKE[id] === 1 || el.cat === CAT.SPECIAL) return '';
  if (id === EL.ACID_RESIDUE) {
    return ipNote('Кислота не берёт; всплывает на кислоте и пропускает её вниз')
      + ipNote('Два остатка друг на друге сливаются; с пятого уровня — реагент');
  }
  if (el.acidImmune) return ipNote('Кислота не берёт');
  const line = OXIDE_LINE[id];
  let out = '';
  if (line && line.acidProofStage > 0) {
    if (stage >= line.acidProofStage) return ipNote(`Кислота не берёт: окисел ${stage}-й стадии плотный (защищает с ${line.acidProofStage}-й)`);
    out += ipNote(`С ${line.acidProofStage}-й стадии окисления кислота перестаёт брать`);
  }
  if (isRustLine(line)) out += ipNote(`В ${Math.round(ACID_OXIDISE_METAL * 100)}% случаев кислота не растворяет, а окисляет (ржавчина)`);
  out += ipNote(el.acidSlow ? 'Растворяется кислотой медленно, в 4 раза' : 'Растворяется кислотой');
  let gas;
  if (isRustLine(line)) gas = 'кислотный газ';
  else if (id === EL.WOOD) gas = 'газ из масла и воды, в случайной пропорции';
  else if (line && line.base === EL.EARTH) gas = 'газ из масла, воды и кислоты, в случайной пропорции';
  else gas = 'кислотный газ (½), горячий газ реагента (¼) или масла (¼)';
  out += ipNote(`При растворении (шанс 20%) выделяется ${gas}`);
  out += ipNote(forBeam
    ? 'Растворённая балка уходит в кислоту растворённым веществом, остатка не оставляет'
    : 'Растворённая клетка уходит в кислоту растворённым веществом, следующие — оставляют кислотный остаток');
  return out;
}

// Вода, реагент и ржавчина: коррозия и окисление.
function corrosionSection(id, stage) {
  const line = OXIDE_LINE[id];
  let out = '';
  if (line) {
    if (line.waterRusts) out += ipNote('Ржавеет от воды: медленно, каждая удача превращает долю воды в чёрные соли — вода чернеет');
    else if (isRustLine(line)) out += ipNote('Чистая вода не берёт; ржавеет от воды с чёрными солями, кислоты, реагента и соседней ржавчины (4-й стадии и выше)');
    if (stage < line.maxStage) out += ipNote(`Реагент окисляет по стадиям: всего ${line.maxStage}, последняя рассыпается`);
    if (line.spreads && stage >= 2) out += ipNote('Окисел делится стадией с соседями и прорастает вглубь');
  } else if (id === EL.WOOD) {
    out += ipNote('Реагент поджигает');
  }
  if (id === EL.METAL_OXIDE || id === EL.METAL_OXIDE_LOOSE) {
    if (stage < RUST_SPREAD_FROM) out += ipNote(`Стадии 1–${RUST_SPREAD_FROM - 1}: соседей не окисляет`);
    else if (stage <= RUST_LIMITED_UP_TO) out += ipNote(`Стадии ${RUST_SPREAD_FROM}–${RUST_LIMITED_UP_TO}: отдаёт стадию соседям ниже ${RUST_LIMITED_TARGET}-й, пока сама не опустится ниже ${RUST_SPREAD_FROM}-й`);
    else out += ipNote(`Стадии ${RUST_LIMITED_UP_TO + 1}–${line.maxStage}: окисляет соседей, как окисел камня`);
    out += ipNote(`Поднятая жидкостью до ${RUST_FLAKE_FROM}-й стадии и выше, с шансом ${Math.round(RUST_FLAKE_CHANCE * 100)}% отслаивается в неё`);
  }
  return out;
}

// Вся справка о клетке (gx, gy). null — вне поля.
function buildInspectHTML(sim, gx, gy) {
  if (!sim.inBounds(gx, gy)) return null;
  const i = sim.idx(gx, gy);
  const id = sim.type[i];
  const el = ELEMENTS[id];
  const beamMat = sim.beam[i];
  const stage = sim.oxideStage(i);

  const title = id === EL.EMPTY ? (beamMat ? ELEMENTS[EL.BEAM].name : 'Пусто') : el.name;
  const swatch = id === EL.EMPTY ? (beamMat ? ELEMENTS[beamMat].color : [14, 14, 18])
    : (hasComposition(id) || sim.comp(i) >= 1024) ? compositionColor(sim.comp(i), el.color) : el.color;
  const sub = `клетка ${gx}, ${gy}` + (el ? ` · ${CAT_NAME[el.cat] || ''}` : '');
  let html = `<div class="ip-head"><span class="ip-title-sw" style="background:${cssRgb(swatch)}"></span>`
    + `<div><div class="ip-title">${title}</div><div class="ip-sub">${sub}</div></div>`
    + `<button type="button" class="ip-close" title="Закрыть (Esc)">×</button></div>`;

  // Состав есть у каждой клетки (data/composition.js) — показывается всегда.
  if (id !== EL.EMPTY) {
    let comp = compositionSection(sim.comp(i));
    comp += ipNote('Твёрдых долей не меньше, чем жидких, — клетка твёрдая (поровну — тоже); газ выходит рядом отдельным пикселем');
    // Растворитель (жидкий или пар) действует по своей доле; замёрзший —
    // безопасен (см. dissolverMix, reactVapor).
    const d = solGet(sim.comp(i), P_DISSOLVER) + solGet(sim.comp(i), P_DISSOLVER_GAS);
    if (d && hasComposition(id)) {
      const rate = d === SOL_PARTS ? '' : ` — по своей доле, в ${+(SOL_PARTS / d).toFixed(1)} раза реже чистого`;
      comp += ipNote(`Растворитель (${d} из ${SOL_PARTS}) меняется долями с чем угодно, кроме стен, огня и живых${rate}`);
      comp += ipNote(`Его доля, ушедшая в твёрдое (и сыпучее), с шансом ${Math.round(DISSOLVER_TO_REAGENT * 100)}% становится реагентом; с жидкостями и газами — нет`);
    }
    if (solGet(sim.comp(i), EL.DISSOLVER_ICE) && !hasComposition(id)) {
      comp += ipNote('Замёрзший растворитель безопасен: ни с чем не смешивается, только тает');
    }
    if (isSolutionMedium(id)) {
      if (id === EL.BLACK_SALT) {
        comp += ipNote('Растворяется в воде, кислоте и реагенте, меняясь с ними долями');
        comp += sim.isDrySalt(i)
          ? ipNote(`Сухая — взрывоопасна: рвётся от огня, лавы и нагрева до ${deg(SALT_IGNITE_TEMP)}, оставляя воронку и трещины в камне вокруг`)
          : ipNote('Мокрая — не взрывается; высохнув (без жидкости внутри), станет взрывоопасной');
      }
    }
    html += ipSection('Состав', comp);
  }

  let now = ipRow('Температура', `${sim.temp[i].toFixed(1)}°`);
  if (stage > 0) now += ipRow('Стадия окисла', `${stage} из ${OXIDE_LINE[id].maxStage}`);
  if (id === EL.ACID_RESIDUE) now += ipRow('Уровень', `${Math.max(1, sim.extra[i])} из 4`);
  if (isStructural(id)) now += ipRow('Устойчивость сейчас', sim.stability[i] || 'нет опоры — падает');
  if (el && typeof el.density === 'number' && id !== EL.EMPTY) now += ipRow('Плотность', el.density);
  html += ipSection('Сейчас', now);

  if (id !== EL.EMPTY) {
    html += ipSection('Температуры', temperaturesSection(sim, i, id));
    if (isStructural(id)) html += ipSection('Прочность', strengthRows(el.maxStability, el.toughness, sim.oxideFrail(i)));
    html += ipSection('Кислота', acidSection(id, stage));
    html += ipSection('Вода, реагент, коррозия', corrosionSection(id, stage));
  }

  if (beamMat) {
    const bel = ELEMENTS[beamMat];
    const bStage = sim.beamStage(i);
    let b = ipRow('Материал', bel.name + (bStage > 0 ? `, стадия ${bStage}` : ''));
    if (!isStructural(id)) b += ipRow('Устойчивость сейчас', sim.stability[i] || 'нет опоры — осыпется');
    b += strengthRows(bel.maxStability, bel.toughness, sim.beamFrail(i));
    if (bel.meltPoint !== undefined) b += ipRow('Плавление', `${deg(bel.meltPoint)} → ${elName(bel.meltsInto)}`);
    b += ipNote('Всё, кроме твёрдого, проходит сквозь балку; жидкость в её клетке действует на неё как на её материал');
    const acid = acidSection(beamMat, bStage, true), corr = corrosionSection(beamMat, bStage);
    html += ipSection('Балка во втором слое', b + acid + corr);
  }
  return html;
}

// Панель по центру экрана. Закрывается крестиком, Esc и щелчком мимо —
// кроме щелчка лупой по полю: он показывает следующую клетку.
class InspectPanel {
  constructor(sim, isInspectClick) {
    this.sim = sim;
    this.el = document.createElement('div');
    this.el.id = 'inspectPanel';
    document.body.appendChild(this.el);
    this.el.addEventListener('click', (e) => { if (e.target.classList.contains('ip-close')) this.hide(); });
    document.addEventListener('keydown', (e) => { if (e.code === 'Escape') this.hide(); });
    document.addEventListener('mousedown', (e) => {
      if (!this.visible() || this.el.contains(e.target) || isInspectClick(e)) return;
      this.hide();
    });
  }

  visible() { return this.el.classList.contains('visible'); }

  show(gx, gy) {
    // Устойчивость считается в начале шага, а между шагами (и на паузе)
    // мир могли перерисовать — без пересчёта только что проведённая балка
    // значилась бы "без опоры". Пересчёт безопасен: computeStability не
    // тратит случайных чисел и зависит только от скелета мира, поэтому
    // следующий шаг получит ровно то же (и сам пересчёт просто пропустит).
    this.sim.computeStability();
    const html = buildInspectHTML(this.sim, gx, gy);
    if (!html) return;
    this.el.innerHTML = html;
    this.el.classList.add('visible');
  }

  hide() { this.el.classList.remove('visible'); }
}
