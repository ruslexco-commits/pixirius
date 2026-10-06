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

// Круговая диаграмма состава (просьба пользователя): по центру, от
// каждого сектора — ломаная выноска с названием вещества (вверх у верхних
// секторов, вниз у нижних), под ней — 10 тонких полос, по одной на каждую
// долю клетки, её цветом. Сектора и полосы помечены data-k (вид доли, 0 —
// пустота) и data-slot (номер доли, у полос): наведение, щелчок и замену
// разбирает InspectPanel. parts — [{ k, n, color }], в сумме SOL_PARTS.
// Сектора начинаются сверху и идут по часовой стрелке.
const PIE_W = 400, PIE_H = 230, PIE_R = 72, PIE_POP = 8;
function compositionPieSVG(parts) {
  const cx = PIE_W / 2, cy = PIE_H / 2, r = PIE_R;
  let sectors = '', callouts = '';
  let a0 = -Math.PI / 2;
  parts.forEach((p, idx) => {
    const a1 = a0 + (p.n / SOL_PARTS) * Math.PI * 2, mid = (a0 + a1) / 2;
    const cos = Math.cos(mid), sin = Math.sin(mid);
    const dx = (cos * PIE_POP).toFixed(2), dy = (sin * PIE_POP).toFixed(2);
    const fill = cssRgb(p.color);
    let d;
    if (p.n >= SOL_PARTS) {
      d = `M${cx - r},${cy} A${r},${r} 0 1 1 ${cx + r},${cy} A${r},${r} 0 1 1 ${cx - r},${cy} Z`;
    } else {
      const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
      const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
      const large = a1 - a0 > Math.PI ? 1 : 0;
      d = `M${cx},${cy} L${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)} Z`;
    }
    sectors += `<path class="ip-sector" data-k="${p.k}" data-dx="${dx}" data-dy="${dy}" d="${d}" fill="${fill}"/>`;
    // Выноска: от края сектора наружу и вверх (вниз), затем полка вбок; над
    // полкой — название. Соседним секторам — разная высота, чтобы надписи
    // не наезжали.
    const up = sin < 0 ? -1 : 1, side = cos >= 0 ? 1 : -1;
    const lift = 12 + (idx % 2) * 12;
    const px = cx + r * cos, py = cy + r * sin;
    const qx = cx + (r + 14) * cos, qy = cy + (r + 14) * sin + up * lift;
    const ex = qx + side * 70;
    callouts += `<polyline class="ip-callout" data-k="${p.k}" points="${px.toFixed(1)},${py.toFixed(1)} ${qx.toFixed(1)},${qy.toFixed(1)} ${ex.toFixed(1)},${qy.toFixed(1)}"/>`
      + `<text class="ip-callout-text" x="${(qx + side * 3).toFixed(1)}" y="${(qy - 4).toFixed(1)}" text-anchor="${side > 0 ? 'start' : 'end'}">${PART_NAME[p.k]}</text>`;
    a0 = a1;
  });
  return `<svg class="ip-pie" width="${PIE_W}" height="${PIE_H}" viewBox="0 0 ${PIE_W} ${PIE_H}">${callouts}${sectors}</svg>`;
}

// Десять полос — десять долей клетки по порядку ячеек состава, пустота в
// конце. Полоса пустоты — штриховкой, без цвета.
function compositionCells(parts) {
  let out = '', slot = 0;
  for (const p of parts) {
    for (let j = 0; j < p.n; j++, slot++) {
      const bg = p.k === P_VOID ? '' : ` style="background:${cssRgb(p.color)}"`;
      out += `<div class="ip-cell${p.k === P_VOID ? ' ip-cell-void' : ''}" data-k="${p.k}" data-slot="${slot}"${bg}></div>`;
    }
  }
  return `<div class="ip-cells">${out}</div>`;
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
// Переключатель уровня 1..3 (видимость карты у протагониста, темнота у
// лампочки): кнопки с data-setting и data-level, щелчок — InspectPanel.
// labels — подпись к каждому уровню, текущий подсвечен.
function ipLevels(setting, current, labels) {
  let out = '<div class="ip-levels">';
  for (let v = 1; v <= 3; v++) {
    out += `<button type="button" class="ip-level${v === current ? ' ip-level-on' : ''}" data-setting="${setting}" data-level="${v}" title="${labels[v - 1]}">${v}</button>`;
  }
  return out + `<span class="ip-level-text">${labels[current - 1]}</span></div>`;
}
function ipSection(title, body) { return body ? `<div class="ip-section"><h3>${title}</h3>${body}</div>` : ''; }

// Состав клетки: доли по ячейкам и пустота последней.
function compositionParts(comp) {
  const parts = [];
  for (let s = 0; s < SOL_SLOTS; s++) {
    const slot = solSlot(comp, s);
    if (!slot) break;
    parts.push({ k: slotId(slot), n: slotCount(slot), color: PART_COLOR[slotId(slot)] });
  }
  const v = solGet(comp, P_VOID);
  if (v) parts.push({ k: P_VOID, n: v, color: INSPECT_VOID_COLOR });
  return parts;
}

function compositionSection(comp) {
  const parts = compositionParts(comp);
  return `<div class="ip-comp">${compositionPieSVG(parts)}${compositionCells(parts)}</div>`;
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
  // У сплава точка плавления — средняя по долям (раздел "Сплав").
  if (el.meltPoint !== undefined && id !== EL.ALLOY && id !== EL.ALLOY_RUST) {
    let into = elName(el.meltsInto);
    if (id === EL.OXIDE || id === EL.OXIDE_LOOSE) {
      const stage = sim.oxideStage(i);
      into += `, выделяя газ: ${PART_NAME[P_REAGENT].toLowerCase()} ${stage} из ${SOL_PARTS} долей`;
    }
    out += ipRow('Плавление', `${deg(el.meltPoint)} → ${into}`);
  }
  if (id === EL.LAVA) out += ipRow('Застывание', `ниже ${deg(LAVA_SOLIDIFY_TEMP)} → ${elName(EL.STONE)}; с расплавами металлов смешивается в сплав`);
  if (el.heatSource) out += ipRow('Источник тепла', deg(el.heatSource));
  if (el.flammable && el.burnChance) {
    out += ipRow('Воспламенение', `от огня и лавы, ${Math.round(el.burnChance * 100)}% в кадр`);
    if (id === EL.WOOD) out += ipNote('Сгорая, оставляет золу');
  }
  return out;
}

// Пятно контакта (sim/landing.js): масса пикселя и давление, которое
// поверхность из этого материала выдерживает от упавшего тела.
function landingRows(sim, i, id) {
  return ipRow('Масса пикселя', id === EL.ALLOY ? +sim.alloyMass(i).toFixed(3) + ' (средняя по долям)' : PIXEL_MASS[id])
    + ipNote(`Упавшее тело давит на пятно контакта: масса тела / число касающихся пикселей. Больше ${sim.cellStability(i, id)} на пиксель — от касания волной, и в поверхность, и в само тело, расходится стойкость 0, пока пятно не станет достаточным. Продавленное осыпается, если есть куда (тонкий пол над пустотой проламывается, край тела у удара обсыпается), остальное держится как держалось; через 30 кадров всё снова обычное`);
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
  else if (line && line.solid === EL.EARTH_OXIDE) gas = 'газ из масла, воды и кислоты, в случайной пропорции';
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

// Описание каждого вещества для лупы: что делает и с чем взаимодействует
// (просьба пользователя: отдельная графа "Описание"). Коротко и словами;
// подробные числа — в разделах ниже.
const DESCRIPTION = {
  [EL.EMPTY]: 'Воздух. Сквозь него всё падает, течёт и поднимается, по нему дует ветер. Остывает быстрее вещества; при темноте 2 освещённый солнцем воздух чуть голубеет.',
  [EL.SAND]: 'Сыпучий: падает и ссыпается горкой, в воде тонет. Рядом с огнём или лавой понемногу спекается в стекло.',
  [EL.WATER]: 'Растекается, при 100° кипит в пар, при 0° замерзает в лёд. Гасит огонь, ржавит металл (не сталь), растворяет изолятор в чёрные соли, смешивается с кислотой, реагентом и растворами по долям. Лава и расплав рядом превращают её в пар. Проводит заряд, но стирает с него снимки камер.',
  [EL.STONE]: 'Твёрдое: держится за опору, вбок от опоры — до ~20 клеток. Плавится в лаву. Кислота его растворяет (кислотный остаток и газы), реагент окисляет по стадиям.',
  [EL.WOOD]: 'Горит: от огня и лавы загорается, сгорая, оставляет золу и дым; реагент его поджигает. Вбок от опоры держится лишь на ~6 клеток.',
  [EL.OIL]: 'Лёгкая жидкость: всплывает на воде, горит быстро и жарко. Коснувшись твёрдого, застывает плёнкой. Генератор работает, только стоя на масле.',
  [EL.LAVA]: 'Расплавленный камень, очень горячий. Поджигает горючее, плавит камень и металлы, воду превращает в пар. Остыв почти до холода, застывает камнем. Смертельна для людей.',
  [EL.ACID]: 'Разъедает соседей — камень, металл, землю, дерево: доля кислоты тратится, остаётся кислотный остаток, выходят газы; металл чаще окисляет, чем растворяет. Стену, стекло и окисел камня не берёт. Кипит в кислотный газ, замерзает в кислотный лёд. Смертельна для людей.',
  [EL.ICE]: 'Замёрзшая вода: падает, выше 0° тает, у огня и лавы тает сразу, соседнюю воду понемногу намораживает.',
  [EL.STEAM]: 'Пар: поднимается и, остыв, конденсируется обратно в воду — так идёт дождь.',
  [EL.SMOKE]: 'Дым от огня: поднимается и за секунду-другую рассеивается.',
  [EL.FIRE]: 'Огонь: живёт доли секунды, тянется вверх, поджигает горючее рядом, даёт дым и жар. Вода его гасит. Смертелен для людей.',
  [EL.GUNP]: 'Порох: от огня вспыхивает весь разом.',
  [EL.METAL]: 'Проводит заряд. Вода ржавит его по стадиям до рыхлой ржавчины, кислота растворяет и окисляет. Не пропускает ветер. Вбок от опоры держится до ~50 клеток.',
  [EL.GLASS]: 'Прозрачное: сквозь него видят люди, камеры и протагонист, проходит свет и солнце для панелей. Кислота и реагент не берут; плавится вдвое раньше камня. Песок у огня спекается в стекло.',
  [EL.WALL]: 'Неподвижная опора: не падает, не плавится, не горит, не пропускает тепло и ветер, кислота её не берёт.',
  [EL.SALT]: 'Соль: растворяется в воде.',
  [EL.ASH]: 'Зола — то, что остаётся от сгоревшего дерева.',
  [EL.VOID]: 'Поглотитель: стирает всё, что его касается, кроме стены.',
  [EL.CLONE]: 'Клонер: запоминает первое коснувшееся его вещество и размножает его вокруг себя.',
  [EL.OILFILM]: 'Застывшее масло: держится одной связью за то, к чему пристыло, горит. Генератор считает его маслом.',
  [EL.EARTH]: 'Сыпучая земля: впитывает воду и становится мокрой; кислота разъедает её в окисел земли.',
  [EL.WET_EARTH]: 'Мокрая земля: держит форму, отдаёт влагу сухой земле рядом, от жара высыхает.',
  [EL.BEAM]: 'Балка — второй слой позади вещества: держит только твёрдое, всё остальное проходит сквозь неё. Материал — от клетки, с которой начали вести. Проводит заряд как односторонний провод.',
  [EL.COLONIST]: 'Колонист — старый житель, носит грузы; остался только ради старых сохранений.',
  [EL.SOLUTION]: 'Раствор — смесь жидкостей по долям. Ведёт себя по своим долям: кислота в нём разъедает, реагент окисляет, вода ржавит.',
  [EL.REAGENT]: 'Окисляет камень и металл по стадиям, дерево поджигает; с водой нагревается. Смертелен для людей.',
  [EL.ACID_RESIDUE]: 'Осадок от растворения кислотой. Копится уровнями, с пятого становится реагентом; реагент превращает его в ржавчину. Плавится в лаву.',
  [EL.ACID_GAS]: 'Кислотный газ: поднимается тучей и выпадает кислотным дождём. Люди, заметив тучу над собой, прячутся под крышу.',
  [EL.VAPOR]: 'Смешанный газ — несколько газов в одной клетке; остывая, выпадает долями.',
  [EL.OXIDE]: 'Окисел камня — камень, окисленный реагентом. Стадии 1–3, со второй хрупкий; делится стадией с соседями, кислота его не берёт. Плавится в лаву, отдавая газ реагента. Смертелен для людей.',
  [EL.OXIDE_LOOSE]: 'Последняя стадия окисла камня — рассыпался.',
  [EL.METAL_OXIDE]: 'Ржавчина металла. Стадии 1–7, с пятой хрупкая; с четвёртой отслаивается в окисляющую жидкость и ржавит соседей, кислота её уже не берёт. Стирает снимки с зарядов. Плавится в расплавленный металл.',
  [EL.METAL_OXIDE_LOOSE]: 'Последняя стадия ржавчины — рассыпалась.',
  [EL.EARTH_OXIDE]: 'Земля, разъеденная кислотой; сыпучая.',
  [EL.ACID_ICE]: 'Замёрзшая кислота: падает, оттаивает; замёрзшая не разъедает.',
  [EL.REAGENT_ICE]: 'Замёрзший реагент: падает, оттаивает; замёрзший не окисляет.',
  [EL.DISSOLVER_ICE]: 'Замёрзший растворитель: падает, оттаивает; замёрзший ни с чем не смешивается.',
  [EL.HUMAN]: 'Ходит, осматривается и записывает опасные места в свою карту — туда больше не ходит. Сходит с уступа не выше 3 пикселей, перепрыгивает препятствие в 2. Плавает, пока хватает сил. Гибнет от огня, лавы, кислоты, реагента, окисла камня и расплавов, тонет, если долго под водой, давится падающим твёрдым.',
  [EL.STEEL]: 'Прочнее металла (вбок от опоры до ~98 клеток), чистая вода её не ржавит, а вода с чёрными солями — ржавит. Плавится позже металла.',
  [EL.BLACK_SALT]: 'Получаются, когда вода ржавит металл и когда растворяется изолятор. Сухие от огня, лавы или сильного жара взрываются — воронка, жар и трещины; мокрые не взрываются.',
  [EL.REAGENT_GAS]: 'Газ реагента: поднимается и, остыв, выпадает реагентом.',
  [EL.OIL_GAS]: 'Масляный газ: поднимается и через время выпадает маслом.',
  [EL.DISSOLVER]: 'Растворитель: обменивается долями с соседями — твёрдое становится смесью, часть растворителя уходит в реагент. Кипит при 50°.',
  [EL.DISSOLVER_GAS]: 'Газ растворителя: поднимается и, остыв, выпадает растворителем.',
  [EL.MUD]: 'Сыпучая. Растворяется в воде, как чёрные соли: вода мутнеет, где грязи не меньше воды — снова сыпучая грязь. Мутная вода откладывает грязь на твёрдые и сыпучие пиксели, которых касается (они буреют), и с тем же успехом вода забирает её обратно — чистая отмывает. Грязь при этом не пропадает и не берётся из ниоткуда. Вода в мокрой грязи кипит и мёрзнет.',
  [EL.PROTAGONIST]: 'За него играют (P). На поле всегда один. Видит только то, что в прямой видимости, и помнит увиденное; мониторы в поле зрения дают ему знание камер. Зажатая ЛКМ — ломать: твёрдый или сыпучий пиксель вплотную на линии к курсору, ударов — по стойкости (сыпучее — 2), от каждого пиксель темнеет; стену не сломать. В мультиплеере кисть протагониста ставит точку спавна хоста, а стоящий на другом игроке едет с ним (и прыгает с его прыжка — так берётся уступ в 4 клетки). Гибнет как человек.',
  [EL.CAMERA]: 'Жёлтый заряд, проходя камеру, становится зелёным и уносит её снимок; от камеры сигнал ещё и отражается назад.',
  [EL.MONITOR]: 'Принимает снимки от зелёного заряда и на миг вспыхивает голубым. Протагонист, видя монитор, видит то, что видели камеры; изображение гаснет через несколько секунд без новых снимков.',
  [EL.SOLAR]: 'Видя небо, время от времени выпускает жёлтый заряд — тем чаще и сильнее, чем больше панелей в группе.',
  [EL.COPPER]: 'Лучший проводник: заряд идёт по ней быстрее всего и затухает в десять раз медленнее. На воздухе сама зеленеет патиной.',
  [EL.INSULATOR]: 'Не проводит заряд и не даёт его перепрыгнуть. Горит, растворяется в воде в чёрные соли.',
  [EL.COPPER_OXIDE]: 'Патина — окисленная медь. Проводит медленнее меди, но заряд затухает в ней так же медленно и снимки не теряет.',
  [EL.COPPER_OXIDE_LOOSE]: 'Последняя стадия патины — рассыпалась.',
  [EL.MOLTEN_COPPER]: 'Расплавленная медь: жжёт, остыв, застывает медью; с другими расплавами смешивается в сплав.',
  [EL.MOLTEN_METAL]: 'Расплавленный металл: жжёт, остыв, застывает металлом; с другими расплавами смешивается в сплав.',
  [EL.MOLTEN_STEEL]: 'Расплавленная сталь: жжёт, остыв, застывает сталью; с другими расплавами смешивается в сплав.',
  [EL.MOLTEN_ALLOY]: 'Смесь расплавов: остыв, застывает сплавом.',
  [EL.ALLOY]: 'Сплав нескольких металлов: прочность, плавление, проводимость и ржавчина — средние по его долям.',
  [EL.ALLOY_RUST]: 'Сплав, проржавевший насквозь, — рассыпался.',
  [EL.GENERATOR]: 'Стоя на масле, раз в полсекунды выпускает жёлтый заряд и клуб дыма над собой.',
  [EL.AMPLIFIER]: 'Медь, которая прибавляет проходящему заряду срок.',
  [EL.LAMP]: 'Жёлтый заряд её зажигает: горит, потом мигает и гаснет. Светит, когда темнота мира 2 или 3.',
};

// Карта в голове человека или протагониста (просьба пользователя: в лупе
// вместо состава — их внутренняя карта). Картинка: canvas → data URL.
function mapImageHTML(w, h, paint) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const cx = cv.getContext('2d'), img = cx.createImageData(w, h);
  paint(img.data);
  cx.putImageData(img, 0, 0);
  return `<img class="ip-map" src="${cv.toDataURL()}" alt="">`;
}

// Человек: окрестность и участки, где он видел опасное (красным) — туда он
// не ходит (sim/human.js, HUMAN_BAN_CELL).
function humanMapSection(sim, i) {
  const mind = sim._humans && sim._humans.get(sim.life[i]);
  if (sim.extra[i] || !mind) return ipNote('Погиб — карта в голове стёрлась');
  // Окрестность — не меньше 97x57 вокруг человека и так, чтобы попали все
  // его опасные участки (он мог уйти от них далеко).
  const W = sim.w, x0c = i % W, y0c = (i / W) | 0;
  const bw = Math.ceil(W / HUMAN_BAN_CELL);
  let minX = x0c - 48, maxX = x0c + 48, minY = y0c - 28, maxY = y0c + 28;
  for (const key of mind.bans) {
    const bx = (key % bw) * HUMAN_BAN_CELL, by = ((key / bw) | 0) * HUMAN_BAN_CELL;
    minX = Math.min(minX, bx - 8); maxX = Math.max(maxX, bx + HUMAN_BAN_CELL + 8);
    minY = Math.min(minY, by - 8); maxY = Math.max(maxY, by + HUMAN_BAN_CELL + 8);
  }
  minX = Math.max(0, minX); minY = Math.max(0, minY); maxX = Math.min(W - 1, maxX); maxY = Math.min(sim.h - 1, maxY);
  const ox = minX, oy = minY, w = maxX - minX + 1, h = maxY - minY + 1;
  const html = mapImageHTML(w, h, (d) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const gx = ox + x, gy = oy + y, o = (y * w + x) * 4;
      let r = 8, g = 8, b = 12;
      if (gx >= 0 && gx < W && gy >= 0 && gy < sim.h) {
        const t = sim.type[gy * W + gx];
        if (t !== EL.EMPTY) { const c = ELEMENTS[t].color; r = c[0] * 0.7; g = c[1] * 0.7; b = c[2] * 0.7; }
        else { r = 22; g = 22; b = 30; }
        const key = ((gy / HUMAN_BAN_CELL) | 0) * bw + ((gx / HUMAN_BAN_CELL) | 0);
        if (mind.bans.has(key)) { r = r * 0.25 + 235 * 0.75; g = g * 0.25 + 50 * 0.75; b = b * 0.25 + 45 * 0.75; }
      }
      if (gx === x0c && gy === y0c) { r = 255; g = 255; b = 255; }
      d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
    }
  });
  return html + ipRow('Опасных участков в памяти', `${mind.bans.size} из ${HUMAN_BAN_LIMIT}`)
    + ipNote(`Красное — участки ${HUMAN_BAN_CELL}×${HUMAN_BAN_CELL}, где он видел опасное: туда и в соседние он больше не ходит, только если убегает`)
    + ipNote('Белая точка — сам человек');
}

// Протагонист: всё, что он видел и помнит в игре (js/play.js), — по всему полю.
function protagonistMapSection(sim, i) {
  const pm = typeof playMode !== 'undefined' ? playMode : null;
  const own = pm && pm.playerId === sim.life[i] && pm.memSerial === sim.playerSlot(sim.life[i]).serial;
  const W = sim.w, H = sim.h, px = i % W, py = (i / W) | 0;
  let seen = 0;
  const html = mapImageHTML(W, H, (d) => {
    for (let k = 0, o = 0; k < W * H; k++, o += 4) {
      if (own && pm.memSeen[k]) {
        const c = pm.memColor[k];
        d[o] = c >> 16; d[o + 1] = (c >> 8) & 255; d[o + 2] = c & 255; seen++;
      } else { d[o] = 5; d[o + 1] = 5; d[o + 2] = 7; }
      d[o + 3] = 255;
    }
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const x = px + dx, y = py + dy;
      if (x < 0 || x >= W || y < 0 || y >= H) continue;
      const o = (y * W + x) * 4;
      d[o] = 255; d[o + 1] = 196; d[o + 2] = 36;
    }
  });
  const vision = ['всё видно, как в редакторе', 'вся карта известна с начала игры', 'прямой взгляд и память'][sim.playerVision - 1];
  return html + ipRow('Увидено', `${Math.round(seen / (W * H) * 100)}% карты`)
    + ipNote(`Видимость в игре: ${vision}. Жёлтое — сам протагонист`);
}

// Точка спавна или респавна в клетке (мультиплеер, sim/spawns.js). Точку
// респавна настраивают здесь: каких игроков она принимает, при каких
// смертях, падает ли она и разъедает ли её кислота. Кнопки — data-mark
// (обработчик в InspectPanel), меняет sim.setRespawnMarkProps (у
// подключившейся вкладки уходит хосту).
function marksSection(sim, gx, gy) {
  let out = '';
  const sm = sim.spawnMarkAt(gx, gy);
  if (sm) {
    const nm = typeof mp !== 'undefined' && mp && mp.player(sm.n) ? mp.player(sm.n).name : 'P' + sm.n;
    out += ipSection('Точка спавна', ipRow('Игрок', nm) + ipNote('Здесь игрок появляется в начале игры, если не включён рандомный спавн'));
  }
  const rm = sim.respawnMarkAt(gx, gy);
  if (rm) {
    const players = typeof mp !== 'undefined' && mp && mp.state ? mp.state.players : [];
    const btn = (prop, val, on, label) => `<button type="button" class="ip-level ip-level-wide${on ? ' ip-level-on' : ''}" data-mark="${prop}" data-val="${val}">${label}</button>`;
    let b = ipNote('Погибший игрок возрождается здесь (в первой свободной клетке на точке или над ней). Подходящих точек несколько — выбирается случайная, нет ни одной — случайное безопасное место');
    b += '<div class="ip-mark-label">Кого принимает</div><div class="ip-levels">' + btn('players', 'all', !rm.players, 'всех');
    for (const p of players) b += btn('players', p.n, !!rm.players && rm.players.includes(p.n), htmlEsc(p.name || 'P' + p.n));
    b += '</div><div class="ip-mark-label">При какой смерти</div><div class="ip-levels">' + btn('kinds', 'all', !rm.kinds, 'любой');
    for (const [k, label] of DEATH_KINDS) b += btn('kinds', k, !!rm.kinds && rm.kinds.includes(k), label);
    b += '</div><div class="ip-levels" style="margin-top:6px">' + btn('physics', rm.physics ? 0 : 1, rm.physics, 'Падает, как песок')
      + btn('acid', rm.acid ? 0 : 1, rm.acid, 'Разъедает кислота') + '</div>';
    out += ipSection('Точка респавна', b);
  }
  return out;
}
function htmlEsc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

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
  // У окисла под названием — стадия из скольких (просьба пользователя).
  const sub = `клетка ${gx}, ${gy}` + (el ? ` · ${CAT_NAME[el.cat] || ''}` : '')
    + (stage > 0 && OXIDE_LINE[id] ? ` · стадия ${stage} из ${OXIDE_LINE[id].maxStage}` : '');
  let html = `<div class="ip-head"><span class="ip-title-sw" style="background:${cssRgb(swatch)}"></span>`
    + `<div><div class="ip-title">${title}</div><div class="ip-sub">${sub}</div></div>`
    + `<button type="button" class="ip-close" title="Закрыть (Esc)">×</button></div>`;

  html += marksSection(sim, gx, gy);

  // Что делает и с чем взаимодействует — словами (DESCRIPTION).
  const descId = id === EL.EMPTY && beamMat ? EL.BEAM : id;
  if (DESCRIPTION[descId]) html += ipSection('Описание', `<div class="ip-desc">${DESCRIPTION[descId]}</div>`);

  // Состав есть у каждой клетки (data/composition.js) — показывается всегда,
  // кроме людей: у них вместо состава — карта в голове.
  if (id === EL.HUMAN) html += ipSection('Карта в голове', humanMapSection(sim, i));
  else if (id === EL.PROTAGONIST) html += ipSection('Карта в голове', protagonistMapSection(sim, i));
  else if (id !== EL.EMPTY) html += ipSection('Состав', compositionSection(sim.comp(i)));

  let now = ipRow('Температура', `${sim.temp[i].toFixed(1)}°`);
  if (stage > 0) now += ipRow('Стадия окисла', `${stage} из ${OXIDE_LINE[id].maxStage}`);
  if (id === EL.ACID_RESIDUE) now += ipRow('Уровень', `${Math.max(1, sim.extra[i])} из 4`);
  if (isStructural(id)) now += ipRow('Устойчивость сейчас', sim.crushed[i] ? `продавлено — осыпается, если есть куда (ещё ${sim.crushed[i]} кадр.)` : (sim.stability[i] || 'нет опоры — падает'));
  if (el && typeof el.density === 'number' && id !== EL.EMPTY) now += ipRow('Плотность', el.density);
  if (sim.dirt[i]) now += ipRow('На пикселе грязи', `${(sim.dirt[i] / MUD_DIRT_PER_PART).toFixed(1)} доли — вода заберёт`);
  html += ipSection('Сейчас', now);

  if (id !== EL.EMPTY) {
    html += ipSection('Температуры', temperaturesSection(sim, i, id));
    const alloy = alloySection(sim, i, id);
    if (alloy) html += ipSection(IS_MOLTEN[id] === 1 ? 'Расплав' : 'Сплав', alloy);
    if (isStructural(id) && id !== EL.ALLOY) html += ipSection('Прочность', strengthRows(el.maxStability, el.toughness, sim.oxideFrail(i)) + landingRows(sim, i, id));
    else if (id === EL.ALLOY) html += ipSection('Прочность', landingRows(sim, i, id));
    if (id !== EL.ALLOY && id !== EL.ALLOY_RUST && IS_MOLTEN[id] !== 1) {
      html += ipSection('Кислота', acidSection(id, stage));
      html += ipSection('Вода, реагент, коррозия', corrosionSection(id, stage));
    }
    if (id === EL.GLASS) {
      html += ipSection('Прозрачность', ipNote('Сквозь стекло видят камеры, люди и протагонист; солнечная панель под стеклом видит небо')
        + ipNote('Плавится вдвое раньше камня; кислота и реагент его не берут'));
    }
  }

  // Техника и заряды — правила словами из sim/charges.js.
  const tech = techNotes(sim, i, id);
  if (tech) html += ipSection('Техника', tech);
  // Темнота мира — настройка всего поля, выбирается на любой лампочке.
  if (id === EL.LAMP) {
    html += ipSection('Темнота мира', ipLevels('darkness', sim.darkness, [
      'Всё видно, лампочки не светят',
      'Светло там, куда достаёт солнце; в закрытых помещениях темно',
      'Темно везде, светят только лампочки',
    ]) + '<div class="ip-levels" style="margin-top:6px">'
      + `<button type="button" class="ip-level ip-level-wide${sim.lightSmooth ? ' ip-level-on' : ''}" data-setting="lightSmooth" data-level="1">Плавный свет</button>`
      + `<button type="button" class="ip-level ip-level-wide${sim.lightSmooth ? '' : ' ip-level-on'}" data-setting="lightSmooth" data-level="0">Попиксельный</button>`
      + '</div>');
  }

  // Протагонист — правила словами из sim/protagonist.js и js/play.js.
  if (id === EL.PROTAGONIST) {
    let p = ipRow('Состояние', sim.extra[i] ? 'погиб' : 'жив');
    p += ipNote('На поле всегда один: новый заменяет прежнего');
    p += ipNote('P — играть за него: A/D — идти, W или пробел — прыжок на 2 клетки, в воде зажатый пробел или W — всплывать и держаться на уровне воды (пока хватает выносливости — жёлтая полоса; кончилась — плыть нельзя до сухой опоры), S — нырнуть, Tab — карта увиденного; снова P — вернуть карту к сохранению');
    p += ipNote(`Видит на ${PLAY_SIGHT} клеток — только то, до чего прямой взгляд не упирается в твёрдое или сыпучее; увиденное помнит`);
    p += ipNote(`Гибнет как человек: огонь, лава, кислота, реагент, окисел камня; под водой захлёбывается за ${HUMAN_DROWN_FRAMES} кадров`);
    p += ipNote('Погиб — карта в игре открывается целиком, и на экране написано, от чего');
    html += ipSection('Протагонист', p);
    html += ipSection('Видимость карты в игре', ipLevels('vision', sim.playerVision, [
      'Всё видно, как в редакторе',
      'Вся карта известна сразу, изменения видны только вблизи',
      'Только прямой взгляд и память (обычная)',
    ]) + '<div class="ip-levels" style="margin-top:6px">'
      + `<button type="button" class="ip-level ip-level-wide${sim.playerRays ? ' ip-level-on' : ''}" data-setting="playerRays" data-level="1">Лучевое зрение: вкл</button>`
      + `<button type="button" class="ip-level ip-level-wide${sim.playerRays ? '' : ' ip-level-on'}" data-setting="playerRays" data-level="0">выкл</button>`
      + '</div>' + ipNote(`Лучевое зрение: из протагониста, как из камеры, расходятся ${PLAY_RAYS} лучей на ${PLAY_RAY_RANGE} клеток — каждый до первого непрозрачного; что на них, видно и запоминается`));
  }

  if (beamMat) {
    const bel = ELEMENTS[beamMat];
    const bStage = sim.beamStage(i);
    let b = ipRow('Материал', bel.name + (bStage > 0 ? `, стадия ${bStage}` : ''));
    if (!isStructural(id)) b += ipRow('Устойчивость сейчас', sim.stability[i] || 'нет опоры — осыпется');
    b += strengthRows(bel.maxStability, bel.toughness, sim.beamFrail(i));
    if (bel.meltPoint !== undefined) b += ipRow('Плавление', `${deg(bel.meltPoint)} → ${elName(bel.meltsInto)}`);
    const bStep = CHARGE_STEP[beamMat];
    if (bStep) {
      b += ipRow('Заряд', `проводит по материалу: клетка за ${bStep} ${bStep === 1 ? 'кадр' : 'кадра'}`);
      b += ipNote(`Односторонний проводник: отдаёт (касанием и через пропуск в пиксель) только своему веществу — ${bel.name.toLowerCase()}, — такой же балке, монитору и камере`);
      b += ipNote(`Принимает только касанием и от тех же (${bel.name.toLowerCase()}, такая же балка, монитор, камера); через пропуск на балку сигнал не передаётся — так делаются провода в одну сторону: ${bel.name.toLowerCase()} → балка → пропуск → ${bel.name.toLowerCase()} проводит, обратно — нет`);
    }
    b += ipNote('Всё, кроме твёрдого, проходит сквозь балку; жидкость в её клетке действует на неё как на её материал');
    const acid = acidSection(beamMat, bStage, true), corr = corrosionSection(beamMat, bStage);
    html += ipSection('Балка во втором слое', b + acid + corr);
  }
  return html;
}

// Сплав и расплав (sim/alloys.js): свойства по долям — правила словами и
// числа для этой клетки.
function alloySection(sim, i, id) {
  const comp = sim.comp(i);
  let out = '';
  if (IS_MOLTEN[id] === 1) {
    out += ipRow('Застывание', `ниже ${deg(Math.round(sim.moltenSolidifyTemp(i)))} → по долям`);
    out += ipNote('Меняется долями с соседними расплавами (лава, металл, сталь, медь) — так и получается сплав; застывает по средней точке своих долей, каждая — в свой металл (лава — в камень)');
    out += ipNote('Жжёт как лава: вода вскипает и гасит расплав, дерево и масло загораются');
    return out;
  }
  if (id !== EL.ALLOY && id !== EL.ALLOY_RUST) return '';
  out += ipRow('Плавление', `${deg(Math.round(sim.alloyAvg(comp, PART_MELT, true)))} → расплав (средняя по долям)`);
  if (id === EL.ALLOY) {
    out += ipRow('Устойчивость / стойкость', `${sim.alloyStability(i)} / ${sim.alloyToughness(i)} — средние по долям`);
    const step = sim.alloyChargeStep(i);
    out += ipRow('Ток', step ? `клетка за ${step} ${step === 1 ? 'кадр' : 'кадра'} — среднее по металлам` : `не проводит (${ALLOY_STONE_INSULATES} и больше долей камня)`);
    out += ipRow('Кислота', `растворяет с шансом ${(sim.alloyAcidChance(i) * 100).toFixed(1)}% в кадр — средним по долям; в ${Math.round(ACID_OXIDISE_METAL * 100)}% случаев окисляет одну металлическую долю`);
    out += ipNote('Газ при растворении — газ случайной доли: бросок от 1 до 10, какая доля выпала, та и выделяет свой');
    out += ipNote(solGet(comp, EL.STEEL) ? 'Есть сталь — чистая вода не берёт; вода с чёрными солями — берёт' : 'Ржавеет от воды: по одной доле железа или меди');
    if (solGet(comp, EL.COPPER) >= ALLOY_COPPER_AIR_FROM && !solGet(comp, EL.STEEL)) out += ipNote(`Больше пяти долей меди и нет стали — зеленеет от воздуха, пока меди не станет меньше ${ALLOY_COPPER_AIR_FROM}`);
    out += ipNote(`Ржавеет по долям: железо и сталь — в ржавчину, медь — в патину, камень под реагентом — в окисел; от ${ALLOY_CRUMBLE_AT} долей ржавчины рассыпается`);
  } else {
    out += ipNote('Смесь ржавчин рассыпавшегося сплава — в пропорции того, что в нём проржавело');
  }
  return out;
}

// Техника: проводимость и особые правила приборов (sim/charges.js).
function techNotes(sim, i, id) {
  let out = '';
  const step = id === EL.ALLOY ? 0 : CHARGE_STEP[id];
  if (step) out += ipRow('Заряд', `проводит: клетка за ${step} ${step === 1 ? 'кадр' : 'кадра'}`);
  const metalLike = ipNote('По физике — металл: ржавеет обычной ржавчиной, под растворителем становится металлом');
  if (id === EL.CAMERA) {
    out += ipNote(`Жёлтый заряд, проходя через камеру, становится зелёным и уносит снимок того, что она видит: прямой видимостью на ${CAMERA_SIGHT} клеток и лучами вдаль до первого препятствия (дальнее — лишь частично)`);
    out += ipNote('Отражает сигнал: волна идёт дальше, а от камеры обратно по пройденному пути уходит отражённая — со снимком и тем же остатком срока');
    out += ipNote('В жару плавится в металл') + metalLike;
  } else if (id === EL.MONITOR) {
    const map = sim.monitorMaps.get(sim.monitorKey(i));
    out += ipRow('В памяти монитора', `${map ? map.size : 0} клеток`);
    out += ipNote('Зелёный заряд отдаёт монитору снимок камеры — карта монитора дополняется и обновляется, а сам монитор на миг вспыхивает голубым');
    out += ipNote(`Без новых снимков изображение темнеет и через ${MONITOR_FADE_FRAMES / 60} с стирается совсем`);
    out += ipNote('Протагонист, пока видит монитор, видит на своей карте то, что знает монитор (временно — синеватым)');
    out += ipNote('В жару плавится в металл') + metalLike;
  } else if (id === EL.SOLAR) {
    out += ipNote(`Видя небо (прямо вверх ничего непрозрачного), раз в 2 секунды выпускает жёлтый заряд: шанс ${Math.round(SOLAR_CHANCE * 100)}% и ещё ${Math.round(SOLAR_CHANCE_PER * 100)}% за каждую следующую панель группы, видящую небо; срок заряда — ${SOLAR_LIFE_PER} клеток за каждую такую панель`);
    out += ipNote('Плавится как металл') + metalLike;
  } else if (id === EL.GENERATOR) {
    const w = sim.w, onOil = i + w < sim.type.length && (sim.type[i + w] === EL.OIL || sim.type[i + w] === EL.OILFILM);
    out += ipNote(`Работает на масле: если под генератором (хоть под одной клеткой связной группы) есть масло, раз в ${GENERATOR_PERIOD / 60} секунды выпускает жёлтый заряд со сроком ${GENERATOR_LIFE} клеток и клуб дыма над собой; масло не тратится; связная группа — один заряд`);
    out += ipRow('Масло под этой клеткой', onOil ? 'есть' : 'нет');
    out += ipNote('В жару плавится в металл') + metalLike;
  } else if (id === EL.LAMP) {
    const life = sim.life[i], steady = LAMP_CYCLE - LAMP_STEADY;
    const state = sim.darkness === 1 ? 'не светит: темнота 1'
      : life > steady ? `горит, ещё ${((life - steady) / 60).toFixed(1)} с ровно`
      : life > 0 ? `мигает, погаснет через ${(life / 60).toFixed(1)} с` : 'погашена';
    out += ipRow('Сейчас', state);
    out += ipNote(`Жёлтый заряд зажигает её: ${LAMP_STEADY / 60} с горит ровно, до ${LAMP_CYCLE / 60}-й секунды мигает, потом гаснет; зелёный проходит, не зажигая`);
    out += ipNote(`Светит на ${LAMP_RADIUS} клеток; свет огибает углы, но не проходит сквозь твёрдое и сыпучее (кроме стекла); сквозь саму лампочку не видно`);
    out += ipNote('Прочность и химия — как у стекла: плавится вдвое раньше камня, кислота и реагент не берут');
  } else if (id === EL.AMPLIFIER) {
    out += ipNote(`Заряд, войдя в усилитель, получает ещё ${AMPLIFIER_BOOST} клеток срока — один раз от одного усилителя (связной группы)`);
    out += ipNote('Во всём остальном — медь: проводит быстрее всего, плавится в расплавленную медь, ржавеет патиной (и перестаёт усиливать); на воздухе сам не зеленеет');
  } else if (id === EL.COPPER || id === EL.COPPER_OXIDE) {
    out += ipNote('Проводит заряд быстрее всего, и сигнал в ней затухает в десять раз медленнее: клетка меди — 0,1 срока заряда вместо 1');
    out += ipNote(`На воздухе (рядом пустота) сама окисляется до ${COPPER_AIR_MAX_STAGE}-й стадии — зеленеет; дальше — как металл: вода, кислота, реагент`);
  } else if (id === EL.INSULATOR) {
    out += ipNote('Не пропускает заряд и не даёт перескочить через себя');
    out += ipNote('Горит; кислоте поддаётся как земля');
    out += ipNote(`Растворяется в воде: клетка воды рядом с шансом ${(INSULATOR_WATER_CHANCE * 100).toFixed(1)}% в кадр превращает клетку изолятора в чёрные соли`);
  }
  if (step) {
    out += ipNote('Заряд разливается волной сразу во все соседние проводники, и по диагонали: каждая новая клетка под зарядом — единица из его срока');
    out += ipNote('Волна разошлась на несвязные куски — это уже отдельные заряды, остаток срока делится поровну; два заряда, коснувшись, сливаются в один и складывают срок (зелёный с жёлтым дают жёлтый)');
    out += ipNote(`Пропуск в одну клетку (не изолятор) волна перескакивает ценой ${CHARGE_JUMP_COST}; коснувшись воды, заряд теряет снимки камер, ржавчины металла — с шансом ${Math.round(CHARGE_RUST_LOSS * 100)}% за стадию (медная патина не мешает)`);
  }
  return out;
}

// Панель по центру экрана. Закрывается крестиком, Esc и щелчком мимо —
// кроме щелчка лупой по полю: он показывает следующую клетку.
// Состав, где n долей вида k (P_VOID — пустоты) стали видом to (P_VOID —
// пустотой), с сохранением порядка ячеек: новое вещество встаёт на место
// заменённого, а не в конец. Порядок ячеек — это порядок секторов и полос
// в лупе; через solMove/solWith новое вещество дописывалось последним, и
// после замены сектор уезжал по кругу (просьба пользователя). before —
// при частичной замене поставить новое перед оставшимся k, а не после
// (щёлкнули первую полосу группы). Не помещается шестое вещество — состав
// прежний.
function compReplace(comp, k, to, n, before) {
  const list = [];
  for (let s = 0; s < SOL_SLOTS; s++) {
    const slot = solSlot(comp, s);
    if (!slot) break;
    list.push([slotId(slot), slotCount(slot)]);
  }
  let pos = list.length;
  if (k !== P_VOID) {
    pos = list.findIndex((e) => e[0] === k);
    if (pos < 0) return comp;
    list[pos][1] -= n;
    if (list[pos][1] > 0 && !before) pos++;
  }
  if (to !== P_VOID) {
    const at = list.findIndex((e) => e[0] === to);
    if (at >= 0) list[at][1] += n;
    else list.splice(pos, 0, [to, n]);
  }
  const out = list.filter((e) => e[1] > 0);
  if (out.length > SOL_SLOTS) return comp;
  let c = 0;
  for (const [id, m] of out) c = solWith(c, id, m);
  return c;
}

class InspectPanel {
  // opts.getSelected — что выбрано в палитре (id элемента или инструмент);
  // opts.beforeEdit — перед заменой доли (шаг отмены).
  constructor(sim, isInspectClick, opts = {}) {
    this.sim = sim;
    this.opts = opts;
    this.gx = 0;
    this.gy = 0;
    this.el = document.createElement('div');
    this.el.id = 'inspectPanel';
    document.body.appendChild(this.el);
    // Подсказка на месте курсора: картинка, название и доля вещества под
    // наведённым сектором или полосой.
    this.tip = document.createElement('div');
    this.tip.className = 'ip-tip';
    document.body.appendChild(this.tip);
    this.el.addEventListener('click', (e) => {
      if (e.target.classList.contains('ip-close')) { this.hide(); return; }
      // Настройки точки респавна (marksSection).
      const mk = e.target.closest('[data-mark]');
      if (mk) { this.onMarkClick(mk.dataset.mark, mk.dataset.val); return; }
      // Уровень видимости карты или темноты (ipLevels).
      const b = e.target.closest('[data-setting]');
      if (!b) return;
      const v = +b.dataset.level;
      if (b.dataset.setting === 'vision') this.sim.playerVision = v;
      else if (b.dataset.setting === 'darkness') this.sim.darkness = v;
      else if (b.dataset.setting === 'lightSmooth') this.sim.lightSmooth = v === 1;
      else if (b.dataset.setting === 'playerRays') this.sim.playerRays = v === 1;
      this.show(this.gx, this.gy);
    });
    this.el.addEventListener('mousemove', (e) => this.onHover(e));
    this.el.addEventListener('mouseleave', () => this.clearHover());
    this.el.addEventListener('mousedown', (e) => this.onPartClick(e));
    this.el.addEventListener('contextmenu', (e) => { if (e.target.closest('[data-k]')) e.preventDefault(); });
    document.addEventListener('keydown', (e) => { if (e.code === 'Escape') this.hide(); });
    // Путь события, а не e.target: щелчок по доле перерисовывает панель, и к
    // этому обработчику щёлкнутый элемент уже вынут из неё — по e.target
    // панель закрывалась сама после каждой замены доли.
    document.addEventListener('mousedown', (e) => {
      if (!this.visible() || e.composedPath().includes(this.el) || isInspectClick(e)) return;
      this.hide();
    });
  }

  visible() { return this.el.classList.contains('visible'); }

  // Кнопка настроек точки респавна (marksSection): "всех"/"любой" — null,
  // номер или вид смерти — переключить в списке.
  onMarkClick(prop, val) {
    const sim = this.sim, m = sim.respawnMarkAt(this.gx, this.gy);
    if (!m) return;
    let v;
    if (prop === 'physics' || prop === 'acid') v = val === '1';
    else if (val === 'all') v = null;
    else {
      const item = prop === 'players' ? Number(val) : val;
      const list = (m[prop] || []).slice();
      const k = list.indexOf(item);
      if (k >= 0) list.splice(k, 1); else list.push(item);
      v = list.length ? list : null;
    }
    sim.setRespawnMarkProps(this.gx, this.gy, { [prop]: v });
    // У подключившейся вкладки точка поменяется у хоста — пока показать как будет.
    if (m[prop] !== v) m[prop] = v;
    this.show(this.gx, this.gy);
  }

  show(gx, gy) {
    // Устойчивость считается в начале шага, а между шагами (и на паузе)
    // мир могли перерисовать — без пересчёта только что проведённая балка
    // значилась бы "без опоры". Пересчёт безопасен: computeStability не
    // тратит случайных чисел и зависит только от скелета мира, поэтому
    // следующий шаг получит ровно то же (и сам пересчёт просто пропустит).
    this.sim.computeStability();
    const html = buildInspectHTML(this.sim, gx, gy);
    if (!html) return;
    this.gx = gx;
    this.gy = gy;
    // Прокрутка панели переживает перерисовку после замены доли.
    const scroll = this.el.scrollTop;
    this.el.innerHTML = html;
    this.el.scrollTop = scroll;
    this.el.classList.add('visible');
  }

  hide() { this.el.classList.remove('visible'); this.clearHover(); }

  // ---- наведение на сектор или полосу ----

  // Наведённый вид доли: его сектор отлетает от центра и мигает лаймовым
  // контуром (полосы этого вида — тоже, наведённая полоса — ярче), а на
  // месте курсора — подсказка крупным шрифтом.
  onHover(e) {
    const t = e.target.closest('[data-k]');
    if (!t || !this.el.contains(t)) { this.clearHover(); return; }
    const k = +t.dataset.k;
    const slot = t.dataset.slot !== undefined ? +t.dataset.slot : -1;
    if (this.hotK !== k || this.hotSlot !== slot) {
      this.clearHover(true);
      this.hotK = k;
      this.hotSlot = slot;
      for (const el of this.el.querySelectorAll(`[data-k="${k}"]`)) {
        el.classList.add('ip-hot');
        if (el.classList.contains('ip-sector')) el.style.transform = `translate(${el.dataset.dx}px, ${el.dataset.dy}px)`;
        if (el.classList.contains('ip-cell') && +el.dataset.slot === slot) el.classList.add('ip-hot-cell');
      }
      const n = solGet(this.sim.comp(this.sim.idx(this.gx, this.gy)), k);
      const tex = typeof PALETTE_TEXTURE !== 'undefined' ? PALETTE_TEXTURE[k] : null;
      const color = k === P_VOID ? INSPECT_VOID_COLOR : PART_COLOR[k];
      const pic = tex ? `<img src="${tex}" alt="">` : `<span class="ip-tip-sw" style="background:${cssRgb(color)}"></span>`;
      const what = slot >= 0 ? `доля ${slot + 1} из ${SOL_PARTS}` : `${n} из ${SOL_PARTS}`;
      this.tip.innerHTML = `${pic}<div class="ip-tip-name">${PART_NAME[k]}</div><div class="ip-tip-pct">${n * 100 / SOL_PARTS}%</div><div class="ip-tip-sub">${what}</div>`;
      this.tip.classList.add('visible');
    }
    this.tip.style.left = `${e.clientX}px`;
    this.tip.style.top = `${e.clientY}px`;
  }

  clearHover(keepTip) {
    for (const el of this.el.querySelectorAll('.ip-hot')) {
      el.classList.remove('ip-hot', 'ip-hot-cell');
      if (el.classList.contains('ip-sector')) el.style.transform = '';
    }
    this.hotK = undefined;
    this.hotSlot = undefined;
    if (!keepTip) this.tip.classList.remove('visible');
  }

  // ---- замена долей ----

  // ЛКМ по сектору — все доли этого вида становятся выбранным в палитре
  // веществом, по полосе — одна доля; ПКМ — то же, но воздухом (пустотой).
  // Состав пишется через setComposition: тип клетки выводится заново, как
  // после любой другой смены состава.
  onPartClick(e) {
    const t = e.target.closest('[data-k]');
    if (!t || !this.el.contains(t) || (e.button !== 0 && e.button !== 2)) return;
    const sim = this.sim, i = sim.idx(this.gx, this.gy);
    const cur = sim.type[i];
    if (cur === EL.EMPTY || cur === EL.HUMAN || cur === EL.PROTAGONIST || cur === EL.COLONIST) return;
    const k = +t.dataset.k;
    const whole = t.classList.contains('ip-sector') || t.classList.contains('ip-callout');
    let to;
    if (e.button === 2) to = P_VOID;
    else {
      to = this.partFor(this.opts.getSelected ? this.opts.getSelected() : null);
      if (to < 0) return;
    }
    if (to === k) return;
    const comp = sim.comp(i);
    let next;
    if (whole) next = compReplace(comp, k, to, solGet(comp, k), false);
    else {
      // Первая полоса своей группы — новое вещество встаёт перед группой.
      const first = this.el.querySelector(`.ip-cell[data-k="${k}"]`);
      next = compReplace(comp, k, to, 1, first === t);
    }
    if (next === comp) return;
    if (this.opts.beforeEdit) this.opts.beforeEdit();
    if (solMatter(next) === 0) sim.clearCell(i);
    else sim.setComposition(i, next);
    e.preventDefault();
    this.clearHover();
    this.show(this.gx, this.gy);
  }

  // Какой долей станет выбранное в палитре: вещество с фазой, которое
  // может быть долей (как у растворителя — не стена, не огонь, не живое);
  // "раствор" и "смешанный газ" — вода и пар. -1 — выбрано не вещество.
  partFor(sel) {
    if (typeof sel !== 'number') return -1;
    const id = sel === EL.SOLUTION ? EL.WATER : sel === EL.VAPOR ? EL.STEAM : sel;
    if (id === EL.ALLOY || id === EL.MOLTEN_ALLOY || id === EL.ALLOY_RUST || id === EL.BEAM) return -1;
    return DISSOLVER_MIXABLE[id] === 1 ? id : -1;
  }
}
