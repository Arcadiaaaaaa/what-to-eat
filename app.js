(() => {
  'use strict';

  const STORAGE_KEY = 'what-to-eat-data-v1';
  const K_LABEL = { 2: '双拼', 3: '三拼', 4: '四拼' };

  const MEALS = {
    breakfast: { label: '早餐', icon: '🌅' },
    lunch: { label: '午餐', icon: '☀️' },
    dinner: { label: '晚餐', icon: '🌙' },
  };
  const TYPE_LABEL = { food: '餐品', drink: '饮品' };
  const MODE_LABEL = { combo: '餐品 + 饮品', food: '仅餐品', drink: '仅饮品' };

  const SAMPLE_ITEMS = [
    { name: '豆浆', price: 2.5, type: 'drink', meals: ['breakfast'] },
    { name: '小米粥', price: 3, type: 'drink', meals: ['breakfast'] },
    { name: '油条', price: 2, type: 'food', meals: ['breakfast'] },
    { name: '包子', price: 2.5, type: 'food', meals: ['breakfast'] },
    { name: '煎饼果子', price: 7, type: 'food', meals: ['breakfast'] },
    { name: '米饭套餐', price: 15, type: 'food', meals: ['lunch', 'dinner'] },
    { name: '牛肉面', price: 16, type: 'food', meals: ['lunch', 'dinner'] },
    { name: '麻辣烫', price: 18, type: 'food', meals: ['lunch', 'dinner'] },
    { name: '饺子', price: 14, type: 'food', meals: ['dinner'] },
    { name: '可乐', price: 3, type: 'drink', meals: ['lunch', 'dinner'] },
    { name: '酸梅汤', price: 5, type: 'drink', meals: ['lunch', 'dinner'] },
    { name: '绿豆汤', price: 4, type: 'drink', meals: ['dinner'] },
  ];
  // 双拼一口价 12；三拼未设一口价 → 按菜价合计
  const SAMPLE_WINDOWS = [
    {
      name: '自选快餐窗口', meals: ['lunch', 'dinner'], pickOptions: [2, 3], fixedPrices: { 2: 12 },
      dishes: [
        { name: '红烧排骨', price: 7 },
        { name: '鱼香肉丝', price: 6 },
        { name: '麻婆豆腐', price: 5 },
        { name: '番茄炒蛋', price: 4 },
        { name: '清炒时蔬', price: 3 },
      ],
    },
  ];

  const state = { items: [], windows: [], history: [] };
  let currentMeal = 'breakfast';
  let currentMode = 'combo';
  let last = {}; // 上轮指针，键 "meal:slot"（软防连抽用；随历史一起持久化以支持跨会话续用）
  let currentResult = null; // 当前结果（模块形态，实体级反馈/撤销用）
  let currentRecord = null; // 当前结果（持久化记录形态，微调/菜品反馈用）
  let dishReceipts = {}; // 会话内菜品反馈撤销凭据，键 `${recordId}:${dishId}`
  let pendingSwap = null; // 待执行的微调目标 { slot, dishIndex? }
  let rolling = false;
  let editing = null; // { kind: 'item' | 'window', id } 表单编辑模式
  let editingDishId = null; // 正在行内编辑的菜品
  let pendingDelete = null; // { id, btn, timer }
  let toastTimer = null;

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };
  const uid = () => (window.crypto && window.crypto.randomUUID)
    ? window.crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const fmt = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
  const itemKey = (i) => `${i.name}|${i.type}|${[...i.meals].sort().join(',')}`;
  const windowKey = (w) => `${w.name}|${[...w.meals].sort().join(',')}`;

  // ---------- 数据校验与存取 ----------
  function isValidItem(o) {
    return !!o && typeof o === 'object'
      && typeof o.name === 'string' && o.name.trim().length > 0
      && (o.type === 'food' || o.type === 'drink')
      && Array.isArray(o.meals) && o.meals.length > 0
      && o.meals.every((m) => MEALS[m]);
  }

  function sanitizeItem(o) {
    return {
      id: typeof o.id === 'string' && o.id ? o.id : uid(),
      name: o.name.trim().slice(0, 40),
      price: typeof o.price === 'number' && o.price >= 0 ? Math.round(o.price * 100) / 100 : null,
      type: o.type,
      meals: [...new Set(o.meals)],
      createdAt: typeof o.createdAt === 'number' ? o.createdAt : Date.now(),
      preference: MealRandom.readPreference(o),
    };
  }

  const dishIsValid = (d) => !!d && typeof d === 'object' && typeof d.name === 'string' && d.name.trim().length > 0;
  const sanitizeDish = (d) => ({
    id: typeof d.id === 'string' && d.id ? d.id : uid(),
    name: d.name.trim().slice(0, 40),
    price: typeof d.price === 'number' && d.price >= 0 ? Math.round(d.price * 100) / 100 : null,
    preference: MealRandom.readPreference(d),
  });

  function isValidWindow(o) {
    return !!o && typeof o === 'object'
      && typeof o.name === 'string' && o.name.trim().length > 0
      && Array.isArray(o.meals) && o.meals.length > 0 && o.meals.every((m) => MEALS[m])
      && Array.isArray(o.pickOptions) && o.pickOptions.some((k) => K_LABEL[k])
      && Array.isArray(o.dishes);
  }

  function sanitizeWindow(o) {
    const pickOptions = [...new Set(o.pickOptions.filter((k) => K_LABEL[k]))].sort((a, b) => a - b);
    const fixedPrices = {};
    if (o.fixedPrices && typeof o.fixedPrices === 'object') {
      pickOptions.forEach((k) => {
        const v = o.fixedPrices[k];
        if (typeof v === 'number' && v >= 0) fixedPrices[k] = Math.round(v * 100) / 100;
      });
    }
    return {
      id: typeof o.id === 'string' && o.id ? o.id : uid(),
      name: o.name.trim().slice(0, 40),
      meals: [...new Set(o.meals)],
      pickOptions,
      fixedPrices,
      dishes: o.dishes.filter(dishIsValid).map(sanitizeDish),
      createdAt: typeof o.createdAt === 'number' ? o.createdAt : Date.now(),
      preference: MealRandom.readPreference(o),
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (Array.isArray(data.items)) state.items = data.items.filter(isValidItem).map(sanitizeItem);
      if (Array.isArray(data.windows)) state.windows = data.windows.filter(isValidWindow).map(sanitizeWindow);
      if (Array.isArray(data.history)) {
        state.history = data.history
          .filter((r) => r && typeof r === 'object' && (r.food || r.drink))
          .slice(0, 30);
      }
      if (data.last && typeof data.last === 'object') last = data.last;
    } catch (err) {
      console.warn('本地数据读取失败，已忽略：', err);
    }
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 2,
      items: state.items,
      windows: state.windows,
      history: state.history.slice(0, 30),
      last,
    }));
  }

  // ---------- 导入容错归一化（AI 输出 / 手输均可） ----------
  function parsePriceValue(v) {
    if (typeof v === 'number' && Number.isFinite(v)) return v >= 0 ? Math.round(v * 100) / 100 : null;
    if (typeof v === 'string') {
      const cleaned = v.replace(/[^\d.]/g, '');
      if (!cleaned) return null;
      const n = parseFloat(cleaned);
      return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
    }
    return null;
  }

  const MEAL_ALIASES = [
    ['breakfast', ['breakfast', '早']],
    ['lunch', ['lunch', '午']],
    ['dinner', ['dinner', '晚']],
  ];

  function normalizeMeals(v) {
    const arr = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
    const out = new Set();
    arr.forEach((x) => {
      const s = String(x).trim().toLowerCase();
      if (s === 'all' || s === '全天' || s === '每日' || s === 'daily') {
        out.add('breakfast'); out.add('lunch'); out.add('dinner');
        return;
      }
      MEAL_ALIASES.forEach(([meal, aliases]) => {
        if (aliases.some((a) => s === a.toLowerCase() || s.includes(a))) out.add(meal);
      });
    });
    return [...out];
  }

  function normalizeType(v) {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    if (s === 'drink' || s.includes('饮') || s.includes('drink') || s.includes('饮料')) return 'drink';
    if (s === 'food' || s.includes('餐') || s.includes('食') || s.includes('food')) return 'food';
    return null;
  }

  const K_ALIASES = { 2: 2, 3: 3, 4: 4, '2': 2, '3': 3, '4': 4, 双拼: 2, 三拼: 3, 四拼: 4 };

  function normalizeRawItem(o) {
    if (!o || typeof o !== 'object') return null;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    if (!name) return null;
    return {
      name,
      price: parsePriceValue(o.price),
      type: normalizeType(o.type) || 'food',
      meals: normalizeMeals(o.meals).length ? normalizeMeals(o.meals) : ['breakfast', 'lunch', 'dinner'],
    };
  }

  function normalizeRawWindow(o) {
    if (!o || typeof o !== 'object') return null;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    if (!name) return null;
    const pickOptions = [...new Set((Array.isArray(o.pickOptions) ? o.pickOptions : [])
      .map((k) => K_ALIASES[k]).filter(Boolean))];
    const fixedPrices = {};
    if (o.fixedPrices && typeof o.fixedPrices === 'object') {
      Object.entries(o.fixedPrices).forEach(([k, v]) => {
        const kk = K_ALIASES[k];
        const price = parsePriceValue(v);
        if (kk && price != null) fixedPrices[kk] = price;
      });
    }
    const dishes = (Array.isArray(o.dishes) ? o.dishes : [])
      .map((d) => {
        if (!d || typeof d !== 'object' || typeof d.name !== 'string' || !d.name.trim()) return null;
        return { name: d.name.trim(), price: parsePriceValue(d.price) };
      })
      .filter(Boolean);
    return {
      name,
      meals: normalizeMeals(o.meals).length ? normalizeMeals(o.meals) : ['breakfast', 'lunch', 'dinner'],
      pickOptions: pickOptions.sort((a, b) => a - b),
      fixedPrices,
      dishes,
    };
  }

  // ---------- 随机候选池（模块负责：忌口剔除、每窗口一个候选名额） ----------
  const eligibleDishes = (w) => w.dishes.filter((d) => !MealRandom.readPreference(d).blocked);
  const validKs = (w) => {
    const n = eligibleDishes(w).length;
    return w.pickOptions.filter((k) => K_LABEL[k] && k <= n);
  };

  // 模块按全部菜品判断拼法可行性，这里再按"未忌口菜品数"收紧
  const candidatesFor = (meal, slot) => MealRandom.candidates(state, meal, slot)
    .filter((c) => c.kind !== 'window' || validKs(c.entity).length > 0);

  function foodCandidates(meal) {
    const pool = candidatesFor(meal, 'food');
    return {
      singles: pool.filter((c) => c.kind === 'item').map((c) => c.entity),
      windows: pool.filter((c) => c.kind === 'window').map((c) => c.entity),
    };
  }

  const drinksForMeal = (meal) => candidatesFor(meal, 'drink').map((c) => c.entity);

  // 累计概率抽样已在模块导出（MealRandom.draw），直接使用

  // 窗口内按菜品偏好权重不放回抽 K 道菜（偏好机制与实体级一致）
  function weightedDishes(w, k) {
    const pool = eligibleDishes(w).map((d) => ({ kind: 'dish', key: `dish:${d.id}`, entity: d }));
    const picked = [];
    while (picked.length < k && pool.length) {
      const rows = MealRandom.distribution(pool, {});
      const chosen = MealRandom.draw(rows, Math.random);
      picked.push(chosen.entity);
      pool.splice(pool.findIndex((c) => c.key === chosen.key), 1);
    }
    return picked;
  }

  const blockedCountFor = (meal) =>
    state.items.filter((i) => i.meals.includes(meal) && MealRandom.readPreference(i).blocked).length
    + state.windows.filter((w) => w.meals.includes(meal) && MealRandom.readPreference(w).blocked).length;

  // ---------- 提示 ----------
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
  }

  // ---------- 视图切换 ----------
  function currentView() {
    return location.hash.startsWith('#/settings') ? 'settings' : 'recommend';
  }

  function applyView() {
    const v = currentView();
    $('#viewRecommend').hidden = v !== 'recommend';
    $('#viewSettings').hidden = v !== 'settings';
    document.querySelectorAll('.view-link').forEach((a) => {
      a.classList.toggle('active', a.dataset.view === v);
    });
  }

  // ---------- 餐段切换 ----------
  function switchMeal(meal) {
    if (!MEALS[meal]) return;
    currentMeal = meal;
    editingDishId = null;
    setItemEditMode(null);
    setWindowEditMode(null);
    document.querySelectorAll('.tab[data-meal]').forEach((b) => {
      b.classList.toggle('active', b.dataset.meal === meal);
    });
    document.querySelectorAll('input[name="meal"], input[name="wmeal"]').forEach((c) => {
      c.checked = c.value === meal;
    });
    renderAll();
    if (!currentRecord) setResultPlaceholder();
  }

  // ---------- 渲染 ----------
  function renderAll() {
    resetPendingDelete();
    const meal = MEALS[currentMeal];
    $('#listTitle').textContent = `${meal.icon} ${meal.label}清单`;
    $('#windowListTitle').textContent = `🥘 ${meal.label}拼菜窗口`;
    renderItemList();
    renderWindowList();
    renderPoolSummary();
    renderPrefPanel();
    renderHistory();
    refreshResultIfEmpty();
  }

  function renderItemList() {
    const listEl = $('#itemList');
    listEl.textContent = '';
    const items = state.items.filter((i) => i.meals.includes(currentMeal));
    let count = 0;
    [['food', '餐品'], ['drink', '饮品']].forEach(([type, label]) => {
      const group = items.filter((i) => i.type === type);
      if (!group.length) return;
      listEl.appendChild(el('div', 'list-group-head', `${label} · ${group.length}`));
      group.forEach((item) => {
        listEl.appendChild(renderItemRow(item));
        count += 1;
      });
    });
    $('#emptyState').hidden = count > 0;
  }

  function renderItemRow(item) {
    const li = el('li');
    li.appendChild(el('span', 'name', item.name));
    li.appendChild(el('span', 'meal-chips', item.meals.map((m) => MEALS[m].label[0]).join('/')));
    const flag = entityFlag(item);
    if (flag) li.appendChild(flag);
    li.appendChild(el(
      'span',
      item.price == null ? 'price unknown' : 'price',
      item.price == null ? '未标价' : `¥${fmt(item.price)}`
    ));
    const edit = el('button', 'edit', '编辑');
    edit.type = 'button';
    edit.dataset.id = item.id;
    li.appendChild(edit);
    const del = el('button', 'del', '删除');
    del.type = 'button';
    del.dataset.id = item.id;
    li.appendChild(del);
    return li;
  }

  function renderWindowList() {
    const wrap = $('#windowList');
    wrap.textContent = '';
    const wins = state.windows.filter((w) => w.meals.includes(currentMeal));
    $('#windowEmpty').hidden = wins.length > 0;
    wins.forEach((w) => wrap.appendChild(renderWindowCard(w)));
  }

  function renderWindowCard(w) {
    const card = el('article', 'window-card');

    const head = el('div', 'wc-head');
    head.appendChild(el('span', 'wc-name', w.name));
    const kParts = w.pickOptions.map((k) => {
      const fixed = w.fixedPrices && w.fixedPrices[k];
      return fixed != null ? `${K_LABEL[k]} ¥${fmt(fixed)}` : K_LABEL[k];
    });
    head.appendChild(el('span', 'wc-meta',
      `${w.meals.map((m) => MEALS[m].label[0]).join('/')} · ${kParts.join(' · ')} · ${w.dishes.length} 道菜`));
    const wflag = entityFlag(w);
    if (wflag) head.appendChild(wflag);
    const wedit = el('button', 'edit wedit', '编辑');
    wedit.type = 'button';
    wedit.dataset.wid = w.id;
    head.appendChild(wedit);
    const del = el('button', 'del wdel', '删除');
    del.type = 'button';
    del.dataset.wid = w.id;
    head.appendChild(del);
    card.appendChild(head);

    const ul = el('ul', 'wc-dishes');
    if (!w.dishes.length) {
      ul.appendChild(el('li', 'wc-empty-dish', '还没有菜品，用下方输入框添加几道菜吧'));
    } else if (!validKs(w).length) {
      const need = Math.min(...w.pickOptions);
      ul.appendChild(el('li', 'wc-empty-dish', `菜品数不足（${K_LABEL[need]}至少需要 ${need} 道菜），暂不参与随机`));
    }
    w.dishes.forEach((d) => {
      if (d.id === editingDishId) {
        const li = el('li', 'dish-editing');
        const nameI = el('input');
        nameI.className = 'dish-edit-name';
        nameI.value = d.name;
        nameI.maxLength = 40;
        const priceI = el('input');
        priceI.className = 'dish-edit-price';
        priceI.type = 'number';
        priceI.min = '0';
        priceI.step = 'any';
        priceI.value = d.price == null ? '' : d.price;
        const save = el('button', 'btn dish-add dsave', '保存');
        save.type = 'button';
        save.dataset.wid = w.id;
        save.dataset.did = d.id;
        const cancel = el('button', 'btn ghost small dcancel', '取消');
        cancel.type = 'button';
        li.appendChild(nameI);
        li.appendChild(priceI);
        li.appendChild(save);
        li.appendChild(cancel);
        ul.appendChild(li);
        return;
      }
      const li = el('li');
      li.appendChild(el('span', 'name', d.name));
      li.appendChild(el(
        'span',
        d.price == null ? 'price unknown' : 'price',
        d.price == null ? '未标价' : `¥${fmt(d.price)}`
      ));
      const dflag = entityFlag(d);
      if (dflag) li.appendChild(dflag);
      const dedit = el('button', 'edit dedit', '编辑');
      dedit.type = 'button';
      dedit.dataset.wid = w.id;
      dedit.dataset.did = d.id;
      li.appendChild(dedit);
      const ddel = el('button', 'del ddel', '删除');
      ddel.type = 'button';
      ddel.dataset.wid = w.id;
      ddel.dataset.did = d.id;
      li.appendChild(ddel);
      ul.appendChild(li);
    });
    card.appendChild(ul);

    const form = el('form', 'wc-add-dish');
    form.dataset.wid = w.id;
    const nameInput = el('input');
    nameInput.name = 'dishName';
    nameInput.placeholder = '菜名';
    nameInput.maxLength = 30;
    nameInput.autocomplete = 'off';
    const priceInput = el('input');
    priceInput.name = 'dishPrice';
    priceInput.type = 'number';
    priceInput.min = '0';
    priceInput.step = 'any';
    priceInput.placeholder = '¥ 可留空';
    const addBtn = el('button', 'btn dish-add', '添加菜品');
    addBtn.type = 'submit';
    form.appendChild(nameInput);
    form.appendChild(priceInput);
    form.appendChild(addBtn);
    card.appendChild(form);

    return card;
  }

  function renderPoolSummary() {
    const { singles, windows } = foodCandidates(currentMeal);
    const drinks = drinksForMeal(currentMeal);
    const p = $('#poolSummary');
    if (!singles.length && !windows.length && !drinks.length) {
      p.textContent = '';
      return;
    }
    const parts = [];
    if (singles.length) parts.push(`餐品 ${singles.length}`);
    if (windows.length) parts.push(`拼菜窗口 ${windows.length}`);
    if (drinks.length) parts.push(`饮品 ${drinks.length}`);
    const pf = readPriceFilter();
    if (pf && !pf.invalid) parts.push(`区间 ${boundsLabel(pf)}`);
    const blocked = blockedCountFor(currentMeal);
    if (blocked) parts.push(`忌口 ${blocked}`);
    p.textContent = `本餐段可随机：${parts.join(' · ')}`;
  }

  // ---------- 推荐结果占位 / 空引导 ----------
  function setResultPlaceholder() {
    const result = $('#result');
    result.textContent = '';
    const { singles, windows } = foodCandidates(currentMeal);
    const drinks = drinksForMeal(currentMeal);
    if (!singles.length && !windows.length && !drinks.length) {
      const blocked = blockedCountFor(currentMeal);
      const msg = blocked
        ? `可随机条目都被忌口了（${blocked} 个），去设置-偏好与忌口恢复`
        : '这个餐段还没有可随机的条目';
      result.appendChild(el('p', 'placeholder', msg));
      const btn = el('button', 'btn ghost', '去设置录入 →');
      btn.type = 'button';
      btn.addEventListener('click', () => { location.hash = '#/settings'; });
      result.appendChild(btn);
      result.dataset.empty = '1';
    } else {
      result.appendChild(el('p', 'placeholder', '点击「随机推荐」，帮你拿主意'));
      result.dataset.empty = '0';
    }
  }

  function refreshResultIfEmpty() {
    const result = $('#result');
    if (result.dataset.empty === '1') setResultPlaceholder();
  }

  // ---------- 模式切换 ----------
  function setMode(mode) {
    currentMode = mode;
    document.querySelectorAll('#modeToggle .mode').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
  }

  // ---------- 随机推荐 ----------
  // 价格区间：{ lo, hi } 或 null（未启用）；invalid 表示输入非法
  function readPriceFilter() {
    if (!$('#pfEnabled').checked) return null;
    const loRaw = $('#pfMin').value.trim();
    const hiRaw = $('#pfMax').value.trim();
    const lo = loRaw === '' ? 0 : parseFloat(loRaw);
    const hi = hiRaw === '' ? Infinity : parseFloat(hiRaw);
    if (!Number.isFinite(lo) || lo < 0 || hi < 0 || lo > hi) return { invalid: true };
    return { lo, hi };
  }

  function boundsLabel(pf) {
    return `${pf.lo === 0 ? '¥0' : `¥${fmt(pf.lo)}`}–${pf.hi === Infinity ? '不限' : `¥${fmt(pf.hi)}`}`;
  }

  function roll() {
    if (rolling) return;
    const pfRaw = readPriceFilter();
    if (pfRaw && pfRaw.invalid) {
      toast('价格区间无效：需要 0 ≤ 最低 ≤ 最高');
      return;
    }
    const pf = pfRaw;

    // 过滤（先过滤后加权）、组合约束（精确枚举，有解必出）、窗口落定全部由模块完成
    let r;
    for (let t = 0; t < 5; t += 1) {
      r = MealRandom.recommend(state, {
        meal: currentMeal, mode: currentMode, last, priceRange: pf,
      });
      const badDish = r.food && r.food.dishes
        && r.food.dishes.some((d) => MealRandom.readPreference(d).blocked);
      if (!badDish) break; // 忌口菜混入组合时整次重抽（模块不知晓菜品级忌口）
    }

    // 菜品偏好参与窗口抽菜：模块内部按均匀抽菜，这里在价格仍满足的前提下
    // 用菜品权重重抽；重抽后越界则保留模块的精确解
    if (r.food && r.food.kind === 'window' && r.food.dishes && r.food.entity) {
      const win = r.food.entity;
      const k = r.food.k;
      const elig = eligibleDishes(win);
      const weightsMatter = elig.some((d) => MealRandom.weight(d) !== 1);
      if ((weightsMatter || elig.length !== win.dishes.length) && elig.length >= k) {
        const candidate = weightedDishes(win, k);
        const fixed = win.fixedPrices && win.fixedPrices[k];
        const cprice = typeof fixed === 'number'
          ? fixed
          : (candidate.some((d) => d.price == null)
            ? null
            : Math.round(candidate.reduce((acc, d) => acc + d.price, 0) * 100) / 100);
        let ok = !r.priceRange;
        if (r.priceRange && cprice != null) {
          const total = r.drink && r.drink.price != null ? cprice + r.drink.price : cprice;
          ok = total >= r.priceRange.lo - 1e-9 && total <= r.priceRange.hi + 1e-9;
        }
        if (ok) r.food = { ...r.food, dishes: candidate, price: cprice };
      }
    }

    const slotLabel = (s) => (s === 'food' ? '餐品 / 窗口' : '饮品');
    const rangeLabel = r.priceRange ? ` ${boundsLabel(r.priceRange)}` : '';
    let partialNote = null;
    if (r.status === 'empty' || r.status === 'partial') {
      const notes = r.emptySlots.map((s) => (r.priceBlocked
        ? `价格区间${rangeLabel} 内没有可选的${slotLabel(s)}，试试放宽区间`
        : `该餐段暂无${slotLabel(s)}`));
      if (r.status === 'empty') {
        const blocked = blockedCountFor(currentMeal);
        const msg = !r.priceBlocked && blocked
          ? `可随机条目都被忌口了（${blocked} 个），去设置-偏好与忌口恢复`
          : (notes[0] || '先去设置录入一些条目吧');
        toast(msg);
        const resultEl = $('#result');
        resultEl.textContent = '';
        resultEl.appendChild(el('p', 'placeholder', msg));
        return;
      }
      partialNote = notes.join('，'); // partial：正常出结果，缺失槽位写入备注
    }

    // 写入历史（含上轮指针），页面刷新后可恢复继续微调/反馈
    const record = {
      id: uid(), ts: Date.now(), meal: currentMeal, mode: currentMode, adjusted: false,
      note: partialNote,
      votes: { dishes: {} },
      food: null, drink: null,
    };
    for (const slot of ['food', 'drink']) {
      const pick = r[slot];
      if (!pick) continue;
      const meta = { weight: pick.weight, probability: pick.probability, key: pick.key };
      if (pick.kind === 'window') {
        record.food = {
          kind: 'window', entityId: pick.entity.id, name: pick.entity.name,
          k: pick.k, tag: K_LABEL[pick.k] || '拼',
          dishes: pick.dishes.map((d) => ({ id: d.id, name: d.name, price: d.price })),
          price: pick.price, meta,
        };
      } else {
        record[slot] = {
          kind: 'item', entityId: pick.entity.id, name: pick.entity.name,
          price: pick.price, meta,
        };
      }
    }
    last = r.nextLast; // 结果正式展示，采用新的上轮指针
    state.history.unshift(record);
    state.history = state.history.slice(0, 30);
    save();
    renderHistory();

    // 滚动动画：先出骨架，落定后渲染可微调的结果卡片
    const animateFor = (slot) => {
      const rows = candidatesFor(currentMeal, slot);
      return () => {
        const c = rows[Math.floor(Math.random() * rows.length)];
        if (!c) return '······';
        if (c.kind === 'item') return c.entity.name;
        const ks2 = validKs(c.entity);
        const k2 = ks2[Math.floor(Math.random() * ks2.length)];
        return MealRandom.sampleDishes(eligibleDishes(c.entity), k2).map((d) => d.name).join(' + ');
      };
    };
    const slots = ['food', 'drink'].filter((s) => r[s]);

    const meal = MEALS[currentMeal];
    const result = $('#result');
    result.textContent = '';
    result.dataset.empty = '0';
    const card = el('div', 'result-card');
    card.appendChild(el('div', 'result-meal', `${meal.icon} ${meal.label} · ${MODE_LABEL[currentMode]}`));
    const wrap = el('div', 'result-items');
    const nameEls = [];
    slots.forEach((s) => {
      const row = el('div', 'result-item');
      row.appendChild(el('span', `tag ${r[s].kind === 'window' ? 'window' : s === 'food' ? 'food' : 'drink'}`, record[s].tag));
      const nameEl = el('span', 'name rolling', '······');
      row.appendChild(nameEl);
      wrap.appendChild(row);
      nameEls.push(nameEl);
    });
    card.appendChild(wrap);
    result.appendChild(card);

    rolling = true;
    const rollBtn = $('#rollBtn');
    rollBtn.disabled = true;

    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - startedAt >= 700) {
        clearInterval(timer);
        renderResultCard(record, false);
        rolling = false;
        rollBtn.disabled = false;
        return;
      }
      slots.forEach((s, idx) => { nameEls[idx].textContent = animateFor(s)(); });
    }, 70);
  }

  // ---------- 偏好反馈（👍 / 👎 / 🚫，算法见 meal-random.js） ----------
  const findEntity = (id) => state.items.find((i) => i.id === id) || state.windows.find((w) => w.id === id);

  function entityFlag(e) {
    const p = MealRandom.readPreference(e);
    if (p.blocked) return el('span', 'row-flag block', '🚫 忌口');
    const w = MealRandom.weight(e);
    if (w > 1.01) return el('span', 'row-flag up', `偏爱 ×${w.toFixed(2)}`);
    if (w < 0.99) return el('span', 'row-flag down', `降权 ×${w.toFixed(2)}`);
    return null;
  }

  const metaText = (m) => (m ? `权重 ×${m.weight.toFixed(2)} · 概率 ${(m.probability * 100).toFixed(1)}%` : '手动调整');

  function buildFbGroup(slot, meta) {
    const wrap = el('span', 'fb');
    wrap.dataset.slot = slot;
    wrap.dataset.meta = metaText(meta);
    [['like', '👍', '好吃，以后多推荐'], ['dislike', '👎', '不好吃，以后少推荐'], ['block', '🚫', '忌口，不再推荐']].forEach(([act, icon, title]) => {
      const b = el('button', `fb-btn ${act}`, icon);
      b.type = 'button';
      b.title = title;
      b.dataset.vote = act;
      b.dataset.slot = slot;
      wrap.appendChild(b);
    });
    const undo = el('button', 'fb-btn undo', '↩ 撤销');
    undo.type = 'button';
    undo.title = '撤销本条反馈';
    undo.dataset.undo = slot;
    undo.hidden = true;
    wrap.appendChild(undo);
    wrap.appendChild(el('span', 'fb-state', metaText(meta)));
    return wrap;
  }

  function updateFbUI(slot) {
    const group = document.querySelector(`.fb[data-slot="${slot}"]`);
    if (!group || !currentRecord || !currentRecord[slot]) return;
    const voted = currentRecord.votes[slot];
    const hasReceipt = !!(currentResult && currentResult.votes[slot]);
    group.querySelectorAll('.fb-btn').forEach((b) => {
      if (b.dataset.undo) {
        b.hidden = !(voted && hasReceipt);
        return;
      }
      b.classList.toggle('active', !!voted && b.dataset.vote === voted.action);
    });
    const stateEl = group.querySelector('.fb-state');
    if (!voted) {
      stateEl.textContent = group.dataset.meta;
      return;
    }
    const entity = currentResult && currentResult[slot] ? currentResult[slot].entity : liveEntity(currentRecord[slot].entityId);
    stateEl.textContent = voted.action === 'block'
      ? '已忌口 🚫'
      : `${voted.action === 'like' ? '👍' : '👎'} 权重 ×${entity ? MealRandom.weight(entity).toFixed(2) : '?'}`;
  }

  const liveEntity = (id) => {
    const item = state.items.find((x) => x.id === id);
    if (item) return item;
    const win = state.windows.find((x) => x.id === id);
    if (win) return win;
    for (const w of state.windows) {
      const d = w.dishes.find((x) => x.id === id);
      if (d) return d;
    }
    return null;
  };

  function recordComboText(record) {
    const parts = [];
    if (record.food) {
      parts.push(record.food.kind === 'window'
        ? record.food.dishes.map((d) => d.name).join('+')
        : record.food.name);
    }
    if (record.drink) parts.push(record.drink.name);
    return parts.join(' ＋ ');
  }

  const voteMark = (a) => (a === 'like' ? '👍' : a === 'dislike' ? '👎' : a === 'block' ? '🚫' : '');

  function renderHistory() {
    const box = $('#historyBox');
    const list = $('#historyList');
    if (!box || !list) return;
    list.textContent = '';
    const rest = state.history.slice(1);
    box.hidden = rest.length === 0;
    rest.slice(0, 12).forEach((r) => {
      const marks = [
        r.votes.food && voteMark(r.votes.food.action),
        r.votes.drink && voteMark(r.votes.drink.action),
        ...Object.values(r.votes.dishes || {}).map((v) => voteMark(v.action)),
      ].filter(Boolean).join('');
      const t = new Date(r.ts);
      const li = el('li');
      li.appendChild(el('span', 'h-time',
        `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`));
      li.appendChild(el('span', 'h-meal', MEALS[r.meal] ? MEALS[r.meal].label : '?'));
      li.appendChild(el('span', 'h-combo', recordComboText(r) + (r.adjusted ? ' ✎' : '')));
      if (marks) li.appendChild(el('span', 'h-marks', marks));
      list.appendChild(li);
    });
  }

  // 渲染可微调的结果卡片（roll 落定、刷新恢复、微调后重渲共用）
  function renderResultCard(record, keepVotes) {
    currentRecord = record;
    const preserved = keepVotes && currentResult ? currentResult.votes : {};
    currentResult = { food: null, drink: null, votes: preserved };
    const result = $('#result');
    result.textContent = '';
    result.dataset.empty = '0';
    const card = el('div', 'result-card');
    const meal = MEALS[record.meal] || MEALS[currentMeal];
    card.appendChild(el('div', 'result-meal',
      `${meal.icon} ${meal.label} · ${MODE_LABEL[record.mode] || ''}${record.adjusted ? ' · 已微调 ✎' : ''}`));

    const renderSlot = (slot) => {
      const rec = record[slot];
      if (!rec) return;
      const row = el('div', 'result-item');
      if (slot === 'food' && rec.kind === 'window') {
        row.appendChild(el('span', 'tag window', rec.tag));
        const nameWrap = el('span', 'name-wrap');
        const chips = el('span', 'dish-chips');
        rec.dishes.forEach((d, idx) => {
          const chip = el('span', 'dish-chip');
          chip.appendChild(el('span', 'dish-name', d.name));
          const sw = el('button', 'chip-btn', '⇄');
          sw.type = 'button';
          sw.title = '换这道菜';
          sw.dataset.swapDish = '1';
          sw.dataset.index = idx;
          chip.appendChild(sw);
          [['like', '👍', '这道菜好吃'], ['dislike', '👎', '这道菜不好吃']].forEach(([act, icon, title]) => {
            const b = el('button', `chip-btn dv-${act}`, icon);
            b.type = 'button';
            b.title = title;
            b.dataset.dishAct = act;
            b.dataset.dishId = d.id;
            chip.appendChild(b);
          });
          const voted = (record.votes.dishes || {})[d.id];
          if (voted) {
            chip.classList.add('voted');
            const btn = chip.querySelector(voted.action === 'like' ? '.dv-like' : '.dv-dislike');
            if (btn) btn.classList.add('active');
            if (dishReceipts[`${record.id}:${d.id}`]) {
              const undo = el('button', 'chip-btn', '↩');
              undo.type = 'button';
              undo.title = '撤销';
              undo.dataset.dishUndo = d.id;
              chip.appendChild(undo);
            }
          }
          chips.appendChild(chip);
        });
        nameWrap.appendChild(chips);
        nameWrap.appendChild(el('span', 'sub', `${rec.name} · ${metaText(rec.meta)}`));
        row.appendChild(nameWrap);
      } else {
        row.appendChild(el('span', `tag ${slot === 'food' ? 'food' : 'drink'}`,
          slot === 'food' ? TYPE_LABEL.food : TYPE_LABEL.drink));
        const nameWrap = el('span', 'name-wrap');
        nameWrap.appendChild(el('span', 'name', rec.name));
        nameWrap.appendChild(el('span', 'sub', metaText(rec.meta)));
        row.appendChild(nameWrap);
        const sw = el('button', 'chip-btn swap-slot-btn', '⇄ 换');
        sw.type = 'button';
        sw.title = '换一个';
        sw.dataset.swapSlot = slot;
        row.appendChild(sw);
      }
      row.appendChild(el('span', 'price', rec.price == null ? '价格未知' : `¥${fmt(rec.price)}`));
      const entity = liveEntity(rec.entityId);
      if (entity) {
        // key 供模块 vote/undoVote 在 state 中定位实体
        currentResult[slot] = {
          entity, price: rec.price,
          key: `${rec.kind === 'window' ? 'window' : 'item'}:${rec.entityId}`,
        };
        row.appendChild(buildFbGroup(slot, rec.meta));
      }
      card.appendChild(row);
      const menu = el('div', 'swap-menu');
      menu.dataset.forSlot = slot;
      menu.hidden = true;
      card.appendChild(menu);
    };
    renderSlot('food');
    renderSlot('drink');

    const picks = ['food', 'drink'].map((s) => record[s]).filter(Boolean);
    if (picks.length > 1) {
      const priced = picks.filter((p) => p.price != null);
      const sum = priced.reduce((a, p) => a + p.price, 0);
      card.appendChild(el('div', 'result-total',
        priced.length < picks.length ? `合计 ¥${fmt(sum)}（含未标价项）` : `合计 ¥${fmt(sum)}`));
    }
    if (record.note) card.appendChild(el('div', 'result-note', record.note));
    result.appendChild(card);
    ['food', 'drink'].forEach((s) => { if (record.votes[s]) updateFbUI(s); });
  }

  function openSwapMenu(slot) {
    const menu = document.querySelector(`#result .swap-menu[data-for-slot="${slot}"]`);
    if (!menu || !currentRecord || !currentRecord[slot]) return;
    const wasOpen = !menu.hidden;
    document.querySelectorAll('#result .swap-menu').forEach((m) => { m.hidden = true; m.textContent = ''; });
    if (wasOpen) return;
    const rec = currentRecord[slot];
    let options = [];
    if (slot === 'food' && rec.kind === 'window') {
      const win = liveEntity(rec.entityId);
      const inCombo = new Set(rec.dishes.map((d) => d.id));
      options = win ? eligibleDishes(win).filter((d) => !inCombo.has(d.id))
        .map((d) => ({ kind: 'dish', id: d.id, label: `${d.name}${d.price != null ? ` ¥${fmt(d.price)}` : ''}` })) : [];
    } else if (slot === 'drink') {
      options = candidatesFor(currentRecord.meal, 'drink')
        .filter((c) => c.entity.id !== rec.entityId)
        .map((c) => ({ kind: 'entity', id: c.entity.id, label: `${c.entity.name}${c.entity.price != null ? ` ¥${fmt(c.entity.price)}` : ''}` }));
    } else {
      options = candidatesFor(currentRecord.meal, 'food')
        .filter((c) => c.kind === 'item' && c.entity.id !== rec.entityId)
        .map((c) => ({ kind: 'entity', id: c.entity.id, label: `${c.entity.name}${c.entity.price != null ? ` ¥${fmt(c.entity.price)}` : ''}` }));
    }
    if (!options.length) {
      toast(slot === 'food' && rec.kind === 'window' ? '窗口里没有别的菜可换，去设置添加' : '没有可换的选项，去设置添加');
      return;
    }
    options.slice(0, 8).forEach((opt) => {
      const b = el('button', 'swap-opt', opt.label);
      b.type = 'button';
      b.dataset.optKind = opt.kind;
      b.dataset.optId = opt.id;
      menu.appendChild(b);
    });
    menu.hidden = false;
  }

  function doSwap(optKind, optId) {
    const record = currentRecord;
    if (!record || !pendingSwap) return;
    const slot = pendingSwap.slot;
    const rec = record[slot];
    if (!rec) return;
    if (optKind === 'dish' && slot === 'food' && rec.kind === 'window') {
      const idx = pendingSwap.dishIndex;
      const old = rec.dishes[idx];
      const win = liveEntity(rec.entityId);
      const dish = win && eligibleDishes(win).find((d) => d.id === optId);
      if (!dish || old == null) return;
      rec.dishes[idx] = { id: dish.id, name: dish.name, price: dish.price };
      if (record.votes.dishes && record.votes.dishes[old.id]) delete record.votes.dishes[old.id];
      const fixed = win && win.fixedPrices && win.fixedPrices[rec.k];
      if (typeof fixed !== 'number') {
        rec.price = rec.dishes.some((d) => d.price == null)
          ? null
          : Math.round(rec.dishes.reduce((a, d) => a + d.price, 0) * 100) / 100;
      }
      record.adjusted = true;
      save();
      renderResultCard(record, true);
      renderAll();
      toast(`已换成「${dish.name}」`);
      return;
    }
    if (optKind === 'entity') {
      const entity = liveEntity(optId);
      if (!entity) return;
      record[slot] = { kind: 'item', entityId: entity.id, name: entity.name, price: entity.price, meta: null };
      if (record.votes[slot]) delete record.votes[slot];
      record.adjusted = true;
      save();
      renderResultCard(record, true);
      renderAll();
      toast(`已换成「${entity.name}」`);
    }
  }

  function renderPrefPanel() {
    const list = $('#prefList');
    list.textContent = '';
    const affected = [
      ...state.items.map((x) => ({ x, kind: TYPE_LABEL[x.type], via: null })),
      ...state.windows.map((x) => ({ x, kind: '窗口', via: null })),
      ...state.windows.flatMap((w) => w.dishes.map((d) => ({ x: d, kind: '菜品', via: w.name }))),
    ].filter(({ x }) => {
      const p = MealRandom.readPreference(x);
      return p.blocked || p.updatedAt != null || p.weight !== 1;
    });
    $('#prefEmpty').hidden = affected.length > 0;
    affected.forEach(({ x, kind, via }) => {
      const p = MealRandom.readPreference(x);
      const w = MealRandom.weight(x);
      const stateText = p.blocked
        ? '已忌口 🚫'
        : (w > 0.99 && w < 1.01 ? `已随时间恢复中性（记录 ×${p.weight.toFixed(2)}）` : `反馈 ×${p.weight.toFixed(2)} · 当前 ×${w.toFixed(2)}`);
      const li = el('li');
      li.appendChild(el('span', 'name', via ? `${via} · ${x.name}` : x.name));
      li.appendChild(el('span', 'kind', kind));
      li.appendChild(el('span', 'state', stateText));
      const btn = el('button', 'btn ghost small', '恢复默认');
      btn.type = 'button';
      btn.dataset.rid = x.id;
      li.appendChild(btn);
      list.appendChild(li);
    });
  }

  // ---------- 录入 / 编辑：普通条目 ----------
  function showFormError(msg) {
    const e = $('#formError');
    e.textContent = msg;
    e.hidden = false;
  }

  function setItemEditMode(item) {
    editing = item ? { kind: 'item', id: item.id } : null;
    const form = $('#addItemForm');
    if (item) {
      $('#itemFormTitle').textContent = `✏️ 编辑：${item.name}`;
      $('#itemName').value = item.name;
      $('#itemPrice').value = item.price == null ? '' : item.price;
      form.querySelector(`input[name="itemType"][value="${item.type}"]`).checked = true;
      form.querySelectorAll('input[name="meal"]').forEach((c) => { c.checked = item.meals.includes(c.value); });
      $('#itemSubmitBtn').textContent = '保存修改';
      $('#itemEditCancel').hidden = false;
      $('#itemName').focus();
    } else {
      $('#itemFormTitle').textContent = '录入餐品 / 饮品';
      $('#itemName').value = '';
      $('#itemPrice').value = '';
      form.querySelector('input[name="itemType"][value="food"]').checked = true;
      form.querySelectorAll('input[name="meal"]').forEach((c) => { c.checked = c.value === currentMeal; });
      $('#itemSubmitBtn').textContent = '＋ 添加到清单';
      $('#itemEditCancel').hidden = true;
    }
    $('#formError').hidden = true;
  }

  function submitItem(form) {
    const name = $('#itemName').value.trim();
    const priceRaw = $('#itemPrice').value.trim();
    const typeInput = form.querySelector('input[name="itemType"]:checked');
    const type = typeInput ? typeInput.value : 'food';
    const meals = [...form.querySelectorAll('input[name="meal"]:checked')].map((c) => c.value);

    if (!name) return showFormError('请填写名称');
    if (!meals.length) return showFormError('请至少勾选一个适用的餐段');
    let price = null;
    if (priceRaw !== '') {
      price = Math.round(parseFloat(priceRaw) * 100) / 100;
      if (!Number.isFinite(price) || price < 0) return showFormError('价格需为不小于 0 的数字');
    }
    $('#formError').hidden = true;

    if (editing && editing.kind === 'item') {
      const target = state.items.find((i) => i.id === editing.id);
      if (target) {
        target.name = name.slice(0, 40);
        target.price = price;
        target.type = type;
        target.meals = meals;
      }
      save();
      setItemEditMode(null);
      renderAll();
      toast(`已更新「${name}」`);
      return;
    }

    state.items.push({ id: uid(), name: name.slice(0, 40), price, type, meals, createdAt: Date.now() });
    save();
    $('#itemName').value = '';
    $('#itemPrice').value = '';
    $('#itemName').focus();
    renderAll();
    toast(meals.includes(currentMeal)
      ? `已添加「${name}」`
      : `已添加「${name}」· ${meals.map((m) => MEALS[m].label).join('、')}`);
  }

  // ---------- 录入 / 编辑：拼菜窗口 ----------
  function syncFixedPriceRows(form) {
    form.querySelectorAll('.fixed-price-row').forEach((row) => {
      const k = row.dataset.k;
      const checked = form.querySelector(`input[name="pickK"][value="${k}"]`).checked;
      row.hidden = !checked;
    });
  }

  function setWindowEditMode(win) {
    editing = win ? { kind: 'window', id: win.id } : null;
    const form = $('#addWindowForm');
    if (win) {
      $('#windowFormTitle').textContent = `✏️ 编辑窗口：${win.name}`;
      $('#windowName').value = win.name;
      form.querySelectorAll('input[name="wmeal"]').forEach((c) => { c.checked = win.meals.includes(c.value); });
      form.querySelectorAll('input[name="pickK"]').forEach((c) => {
        c.checked = win.pickOptions.includes(Number(c.value));
      });
      form.querySelectorAll('.fixed-price-row input').forEach((i) => { i.value = ''; });
      Object.entries(win.fixedPrices || {}).forEach(([k, v]) => {
        const input = form.querySelector(`.fixed-price-row[data-k="${k}"] input`);
        if (input) input.value = v;
      });
      $('#windowSubmitBtn').textContent = '保存修改';
      $('#windowEditCancel').hidden = false;
      $('#windowName').focus();
    } else {
      $('#windowFormTitle').textContent = '录入拼菜窗口';
      $('#windowName').value = '';
      form.querySelectorAll('input[name="wmeal"]').forEach((c) => { c.checked = c.value === currentMeal; });
      form.querySelectorAll('input[name="pickK"]').forEach((c) => { c.checked = false; });
      form.querySelectorAll('.fixed-price-row input').forEach((i) => { i.value = ''; });
      $('#windowSubmitBtn').textContent = '＋ 创建窗口';
      $('#windowEditCancel').hidden = true;
    }
    syncFixedPriceRows(form);
    $('#windowFormError').hidden = true;
  }

  function readWindowForm(form) {
    const name = $('#windowName').value.trim();
    const meals = [...form.querySelectorAll('input[name="wmeal"]:checked')].map((c) => c.value);
    const ks = [...form.querySelectorAll('input[name="pickK"]:checked')]
      .map((c) => Number(c.value)).sort((a, b) => a - b);
    const errEl = $('#windowFormError');
    const fail = (msg) => { errEl.textContent = msg; errEl.hidden = false; };

    if (!name) return fail('请填写窗口名称');
    if (!meals.length) return fail('请至少勾选一个适用的餐段');
    if (!ks.length) return fail('请至少选择一种拼法');

    const fixedPrices = {};
    for (const k of ks) {
      const raw = form.querySelector(`.fixed-price-row[data-k="${k}"] input`).value.trim();
      if (raw === '') continue;
      const v = Math.round(parseFloat(raw) * 100) / 100;
      if (!Number.isFinite(v) || v < 0) return fail(`${K_LABEL[k]}一口价需为不小于 0 的数字`);
      fixedPrices[k] = v;
    }
    errEl.hidden = true;
    return { name: name.slice(0, 40), meals, pickOptions: ks, fixedPrices };
  }

  function submitWindow(form) {
    const parsed = readWindowForm(form);
    if (!parsed) return;

    if (editing && editing.kind === 'window') {
      const target = state.windows.find((w) => w.id === editing.id);
      if (target) {
        target.name = parsed.name;
        target.meals = parsed.meals;
        target.pickOptions = parsed.pickOptions;
        target.fixedPrices = parsed.fixedPrices;
      }
      save();
      setWindowEditMode(null);
      renderAll();
      toast(`已更新窗口「${parsed.name}」`);
      return;
    }

    state.windows.push({
      id: uid(), name: parsed.name, meals: parsed.meals,
      pickOptions: parsed.pickOptions, fixedPrices: parsed.fixedPrices,
      dishes: [], createdAt: Date.now(),
    });
    save();
    setWindowEditMode(null);
    renderAll();
    toast(`已创建窗口「${parsed.name}」，接下来添加菜品`);
  }

  function submitDish(form) {
    const wid = form.dataset.wid;
    const win = state.windows.find((w) => w.id === wid);
    if (!win) return;
    const nameInput = form.querySelector('input[name="dishName"]');
    const priceInput = form.querySelector('input[name="dishPrice"]');
    const name = nameInput.value.trim();
    if (!name) { toast('请填写菜名'); return; }
    let price = null;
    const raw = priceInput.value.trim();
    if (raw !== '') {
      price = Math.round(parseFloat(raw) * 100) / 100;
      if (!Number.isFinite(price) || price < 0) { toast('价格需为不小于 0 的数字'); return; }
    }
    win.dishes.push({ id: uid(), name: name.slice(0, 40), price });
    save();
    renderAll();
    const newInput = document.querySelector(`.wc-add-dish[data-wid="${wid}"] input[name="dishName"]`);
    if (newInput) newInput.focus();
    toast(`已添加「${name}」`);
  }

  // ---------- 删除（点两次确认） ----------
  function resetPendingDelete() {
    if (!pendingDelete) return;
    clearTimeout(pendingDelete.timer);
    if (pendingDelete.btn && pendingDelete.btn.isConnected) {
      pendingDelete.btn.classList.remove('confirm');
      pendingDelete.btn.textContent = '删除';
    }
    pendingDelete = null;
  }

  function requestDelete(id, btn, fn) {
    if (pendingDelete && pendingDelete.id === id) {
      fn();
      resetPendingDelete();
      save();
      renderAll();
      toast('已删除');
      return;
    }
    resetPendingDelete();
    pendingDelete = {
      id,
      btn,
      timer: setTimeout(resetPendingDelete, 2600),
    };
    btn.classList.add('confirm');
    btn.textContent = '确认删除？';
  }

  // ---------- 示例 / 导入 / 导出 ----------
  function loadSample() {
    let added = 0;
    const itemKeys = new Set(state.items.map(itemKey));
    SAMPLE_ITEMS.forEach((s) => {
      const item = sanitizeItem({ ...s, createdAt: Date.now() });
      const key = itemKey(item);
      if (itemKeys.has(key)) return;
      itemKeys.add(key);
      state.items.push(item);
      added += 1;
    });
    const winKeys = new Set(state.windows.map(windowKey));
    SAMPLE_WINDOWS.forEach((sw) => {
      const w = sanitizeWindow({ ...sw, createdAt: Date.now() });
      const key = windowKey(w);
      if (winKeys.has(key)) return;
      winKeys.add(key);
      state.windows.push(w);
      added += 1;
    });
    save();
    renderAll();
    toast(added ? `已加载 ${added} 条示例数据` : '示例数据都已存在');
  }

  function exportData() {
    if (!state.items.length && !state.windows.length) {
      toast('还没有数据可导出');
      return;
    }
    const payload = JSON.stringify(
      {
        version: 2,
        exportedAt: new Date().toISOString(),
        items: state.items,
        windows: state.windows,
      },
      null,
      2
    );
    const blob = new Blob([payload], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `what-to-eat-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  }

  // 解析一段文本为数据并合并导入；容忍代码围栏、中文餐段/拼法、带单位的价格等写法
  function importFromText(text) {
    let data;
    try {
      let t = String(text).trim();
      const fence = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
      if (fence) t = fence[1].trim();
      try {
        data = JSON.parse(t);
      } catch (err) {
        const starts = [t.indexOf('{'), t.indexOf('[')].filter((i) => i >= 0);
        const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
        if (!starts.length || end < 0) throw err;
        const start = Math.min(...starts);
        if (start >= end) throw err;
        data = JSON.parse(t.slice(start, end + 1));
      }
    } catch (err) {
      toast('导入失败：不是有效的 JSON');
      return false;
    }

    const inItems = Array.isArray(data) ? data : data.items;
    const inWindows = !Array.isArray(data) && Array.isArray(data.windows) ? data.windows : [];
    const validItems = (Array.isArray(inItems) ? inItems : [])
      .map(normalizeRawItem).filter(Boolean).filter(isValidItem).map(sanitizeItem);
    const validWindows = inWindows
      .map(normalizeRawWindow).filter(Boolean).filter(isValidWindow).map(sanitizeWindow);
    if (!validItems.length && !validWindows.length) {
      toast('内容里没有可用的数据');
      return;
    }

    const itemKeys = new Set(state.items.map(itemKey));
    let addedItems = 0;
    validItems.forEach((item) => {
      const key = itemKey(item);
      if (itemKeys.has(key)) return;
      itemKeys.add(key);
      state.items.push(item);
      addedItems += 1;
    });
    const winKeys = new Set(state.windows.map(windowKey));
    let addedWindows = 0;
    validWindows.forEach((w) => {
      const key = windowKey(w);
      if (winKeys.has(key)) return;
      winKeys.add(key);
      state.windows.push(w);
      addedWindows += 1;
    });
    save();
    renderAll();

    const parts = [];
    if (addedItems) parts.push(`条目 ${addedItems}`);
    if (addedWindows) parts.push(`窗口 ${addedWindows}`);
    const skipped = (validItems.length + validWindows.length) - (addedItems + addedWindows);
    if (!parts.length) { toast('导入的数据都已存在'); return false; }
    toast(`已导入 ${parts.join('、')}${skipped ? `，跳过重复 ${skipped} 条` : ''}`);
    return true;
  }

  function importFile(file) {
    const reader = new FileReader();
    reader.onload = () => { importFromText(reader.result); };
    reader.onerror = () => toast('导入失败：文件读取错误');
    reader.readAsText(file);
  }

  async function copyText(t) {
    try {
      await navigator.clipboard.writeText(t);
      return true;
    } catch (err) {
      const ta = document.createElement('textarea');
      ta.value = t;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      return ok;
    }
  }

  // ---------- 事件绑定 ----------
  function bindEvents() {
    document.addEventListener('click', (e) => {
      const tabBtn = e.target.closest('.tab[data-meal]');
      if (tabBtn) switchMeal(tabBtn.dataset.meal);
    });
    $('#modeToggle').addEventListener('click', (e) => {
      const btn = e.target.closest('.mode');
      if (btn) setMode(btn.dataset.mode);
    });
    $('#rollBtn').addEventListener('click', roll);

    $('#pfEnabled').addEventListener('change', () => {
      $('#pfInputs').hidden = !$('#pfEnabled').checked;
      renderPoolSummary();
    });
    $('#pfMin').addEventListener('input', renderPoolSummary);
    $('#pfMax').addEventListener('input', renderPoolSummary);

    // 结果卡片：实体反馈 / 菜品反馈 / 微调换菜换饮品
    $('#result').addEventListener('click', (e) => {
      // 实体反馈撤销
      const undoBtn = e.target.closest('.fb-btn[data-undo]');
      if (undoBtn) {
        const slot = undoBtn.dataset.undo;
        if (currentResult && currentResult.votes[slot] && MealRandom.undoVote(state, currentResult, slot)) {
          if (currentRecord) delete currentRecord.votes[slot];
          save();
          toast('已撤销该条反馈');
          updateFbUI(slot);
          renderAll();
        } else if (currentRecord && currentRecord.votes[slot]) {
          toast('这条反馈是之前页面记录的，无法撤销；可在设置-偏好与忌口恢复默认');
        } else {
          toast('该反馈已被后续操作覆盖，无法撤销');
        }
        return;
      }
      // 菜品反馈撤销
      const dishUndoBtn = e.target.closest('.chip-btn[data-dish-undo]');
      if (dishUndoBtn && currentRecord) {
        const key = `${currentRecord.id}:${dishUndoBtn.dataset.dishUndo}`;
        if (dishReceipts[key] && MealRandom.undoFeedback(dishReceipts[key])) {
          delete currentRecord.votes.dishes[dishUndoBtn.dataset.dishUndo];
          delete dishReceipts[key];
          save();
          renderResultCard(currentRecord, true);
          renderAll();
          toast('已撤销该菜反馈');
        } else {
          toast('无法撤销（已过期或被后续操作覆盖）');
        }
        return;
      }
      // 菜品反馈（每条记录每道菜一次）
      const dishBtn = e.target.closest('.chip-btn[data-dish-act]');
      if (dishBtn && currentRecord) {
        const dishId = dishBtn.dataset.dishId;
        const action = dishBtn.dataset.dishAct;
        if (currentRecord.votes.dishes[dishId]) {
          toast('这道菜已反馈过（本条记录），刷新前的记录不可撤销');
          return;
        }
        const dish = liveEntity(dishId);
        if (!dish) { toast('该菜品已被删除'); return; }
        try {
          dishReceipts[`${currentRecord.id}:${dishId}`] = MealRandom.applyFeedback(dish, action);
          currentRecord.votes.dishes[dishId] = { action };
          save();
          renderResultCard(currentRecord, true);
          renderAll();
          toast(`${action === 'like' ? '已记录：以后多给' : '已记录：以后少给'}「${dish.name}」`);
        } catch (err) {
          toast(String(err.message || err));
        }
        return;
      }
      // 打开换菜菜单
      const swapDishBtn = e.target.closest('.chip-btn[data-swap-dish]');
      if (swapDishBtn) {
        pendingSwap = { slot: 'food', dishIndex: Number(swapDishBtn.dataset.index) };
        openSwapMenu('food');
        return;
      }
      // 打开换饮品 / 换单点菜单
      const swapSlotBtn = e.target.closest('.chip-btn[data-swap-slot]');
      if (swapSlotBtn) {
        pendingSwap = { slot: swapSlotBtn.dataset.swapSlot };
        openSwapMenu(swapSlotBtn.dataset.swapSlot);
        return;
      }
      // 选中替换项
      const optBtn = e.target.closest('.swap-opt');
      if (optBtn && currentRecord) {
        doSwap(optBtn.dataset.optKind, optBtn.dataset.optId);
        return;
      }
      // 实体反馈（每条记录每槽一次，改选先撤销）
      const voteBtn = e.target.closest('.fb-btn[data-vote]');
      if (!voteBtn || !currentResult || !currentRecord) return;
      const slot = voteBtn.dataset.slot;
      const action = voteBtn.dataset.vote;
      if ((currentResult.votes && currentResult.votes[slot]) || currentRecord.votes[slot]) {
        toast('本条结果已反馈过，先点撤销可改选');
        return;
      }
      const entity = liveEntity(currentRecord[slot].entityId);
      const blockedEntity = !!(entity && MealRandom.readPreference(entity).blocked && action !== 'block');
      let ok = false;
      try {
        ok = MealRandom.vote(state, currentResult, slot, action);
      } catch (err) {
        toast(String(err.message || err));
      }
      if (!ok) {
        if (blockedEntity) toast(`「${entity.name}」已忌口，先在设置-偏好与忌口恢复默认`);
        else toast('反馈失败：该条目可能已被删除');
        return;
      }
      currentResult.votes[slot].action = action;
      currentRecord.votes[slot] = { action };
      save();
      const votedEntity = currentResult[slot].entity;
      const msgs = {
        like: '已记录：以后多推荐',
        dislike: '已记录：以后少推荐',
        block: '已加入忌口（设置-偏好与忌口可恢复）',
      };
      toast(`${msgs[action]}「${votedEntity.name}」`);
      updateFbUI(slot);
      renderAll();
    });

    $('#prefList').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-rid]');
      if (!btn) return;
      const entity = findEntity(btn.dataset.rid);
      if (!entity) return;
      MealRandom.resetPreference(entity);
      save();
      renderAll();
      toast(`已恢复「${entity.name}」默认偏好`);
    });

    $('#addItemForm').addEventListener('submit', (e) => {
      e.preventDefault();
      submitItem(e.target);
    });
    $('#itemEditCancel').addEventListener('click', () => setItemEditMode(null));
    $('#itemList').addEventListener('click', (e) => {
      const editBtn = e.target.closest('.edit');
      if (editBtn) {
        const item = state.items.find((i) => i.id === editBtn.dataset.id);
        if (item) {
          setItemEditMode(item);
          $('#addItemForm').scrollIntoView({ block: 'nearest' });
        }
        return;
      }
      const delBtn = e.target.closest('.del');
      if (!delBtn) return;
      const id = delBtn.dataset.id;
      requestDelete(id, delBtn, () => {
        state.items = state.items.filter((i) => i.id !== id);
        if (editing && editing.kind === 'item' && editing.id === id) setItemEditMode(null);
      });
    });

    $('#addWindowForm').addEventListener('change', (e) => {
      if (e.target.name === 'pickK') syncFixedPriceRows(e.currentTarget);
    });
    $('#addWindowForm').addEventListener('submit', (e) => {
      e.preventDefault();
      submitWindow(e.target);
    });
    $('#windowEditCancel').addEventListener('click', () => setWindowEditMode(null));

    $('#windowList').addEventListener('click', (e) => {
      const weditBtn = e.target.closest('.wedit');
      if (weditBtn) {
        const win = state.windows.find((w) => w.id === weditBtn.dataset.wid);
        if (win) {
          setWindowEditMode(win);
          $('#addWindowForm').scrollIntoView({ block: 'nearest' });
        }
        return;
      }
      const deditBtn = e.target.closest('.dedit');
      if (deditBtn) {
        editingDishId = deditBtn.dataset.did;
        renderWindowList();
        return;
      }
      const dsaveBtn = e.target.closest('.dsave');
      if (dsaveBtn) {
        const li = dsaveBtn.closest('li');
        const name = li.querySelector('.dish-edit-name').value.trim();
        const priceRaw = li.querySelector('.dish-edit-price').value.trim();
        if (!name) { toast('请填写菜名'); return; }
        let price = null;
        if (priceRaw !== '') {
          price = Math.round(parseFloat(priceRaw) * 100) / 100;
          if (!Number.isFinite(price) || price < 0) { toast('价格需为不小于 0 的数字'); return; }
        }
        const win = state.windows.find((w) => w.id === dsaveBtn.dataset.wid);
        const dish = win && win.dishes.find((d) => d.id === dsaveBtn.dataset.did);
        if (!dish) { editingDishId = null; renderAll(); return; }
        dish.name = name.slice(0, 40);
        dish.price = price;
        editingDishId = null;
        save();
        renderAll();
        toast(`已更新「${name}」`);
        return;
      }
      const dcancelBtn = e.target.closest('.dcancel');
      if (dcancelBtn) {
        editingDishId = null;
        renderWindowList();
        return;
      }
      const delBtn = e.target.closest('.del');
      if (!delBtn) return;
      if (delBtn.classList.contains('wdel')) {
        const wid = delBtn.dataset.wid;
        requestDelete(wid, delBtn, () => {
          const win = state.windows.find((w) => w.id === wid);
          if (win && win.dishes.some((d) => d.id === editingDishId)) editingDishId = null;
          state.windows = state.windows.filter((w) => w.id !== wid);
          if (editing && editing.kind === 'window' && editing.id === wid) setWindowEditMode(null);
        });
      } else if (delBtn.classList.contains('ddel')) {
        const { wid, did } = delBtn.dataset;
        const win = state.windows.find((w) => w.id === wid);
        requestDelete(`${wid}:${did}`, delBtn, () => {
          if (editingDishId === did) editingDishId = null;
          if (win) win.dishes = win.dishes.filter((d) => d.id !== did);
        });
      }
    });
    $('#windowList').addEventListener('submit', (e) => {
      const form = e.target.closest('.wc-add-dish');
      if (!form) return;
      e.preventDefault();
      submitDish(form);
    });

    $('#loadSample').addEventListener('click', loadSample);
    $('#exportBtn').addEventListener('click', exportData);
    $('#importBtn').addEventListener('click', () => $('#importFile').click());
    $('#importFile').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) importFile(file);
      e.target.value = '';
    });

    $('#copyPromptBtn').addEventListener('click', async () => {
      const ok = await copyText($('#aiPrompt').textContent);
      if (ok) {
        toast('提示词已复制，发给 AI 时连同菜单照片一起粘贴');
        return;
      }
      // 剪贴板不可用（如 file:// 或部分 webview）：全选文本，用户按一次复制键即可
      const range = document.createRange();
      range.selectNodeContents($('#aiPrompt'));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      toast('已全选提示词，按 Ctrl/Cmd + C 复制');
    });
    $('#importPasteBtn').addEventListener('click', () => {
      const ta = $('#pasteJson');
      if (!ta.value.trim()) { toast('请先粘贴 JSON 内容'); return; }
      const ok = importFromText(ta.value);
      if (ok !== false) ta.value = '';
    });

    window.addEventListener('hashchange', applyView);
  }

  // ---------- 启动 ----------
  load();
  bindEvents();
  applyView();
  switchMeal('breakfast');
  if (state.history.length) renderResultCard(state.history[0], false);
  else setResultPlaceholder();
})();
