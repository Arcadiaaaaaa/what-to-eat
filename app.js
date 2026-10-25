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

  const state = { items: [], windows: [] };
  let currentMeal = 'breakfast';
  let currentMode = 'combo';
  let lastPick = { food: null, drink: null };
  let rolling = false;
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
    };
  }

  const dishIsValid = (d) => !!d && typeof d === 'object' && typeof d.name === 'string' && d.name.trim().length > 0;
  const sanitizeDish = (d) => ({
    id: typeof d.id === 'string' && d.id ? d.id : uid(),
    name: d.name.trim().slice(0, 40),
    price: typeof d.price === 'number' && d.price >= 0 ? Math.round(d.price * 100) / 100 : null,
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
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (Array.isArray(data.items)) state.items = data.items.filter(isValidItem).map(sanitizeItem);
      if (Array.isArray(data.windows)) state.windows = data.windows.filter(isValidWindow).map(sanitizeWindow);
    } catch (err) {
      console.warn('本地数据读取失败，已忽略：', err);
    }
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, items: state.items, windows: state.windows }));
  }

  // ---------- 随机候选池 ----------
  const drinksForMeal = (meal) => state.items.filter((i) => i.type === 'drink' && i.meals.includes(meal));
  const validKs = (w) => w.pickOptions.filter((k) => K_LABEL[k] && k <= w.dishes.length);

  function foodCandidates(meal) {
    const singles = state.items.filter((i) => i.type === 'food' && i.meals.includes(meal));
    const windows = state.windows.filter((w) => w.meals.includes(meal) && validKs(w).length > 0);
    return { singles, windows };
  }

  function sampleDishes(dishes, k) {
    const arr = dishes.slice();
    for (let i = arr.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr.slice(0, k);
  }

  // 一口价优先；否则按菜价合计（任一菜未标价则视为未知）
  function windowPrice(w, k, dishes) {
    const fixed = w.fixedPrices && w.fixedPrices[k];
    if (typeof fixed === 'number') return fixed;
    if (dishes.some((d) => d.price == null)) return null;
    return Math.round(dishes.reduce((acc, d) => acc + d.price, 0) * 100) / 100;
  }

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
    document.querySelectorAll('.tab[data-meal]').forEach((b) => {
      b.classList.toggle('active', b.dataset.meal === meal);
    });
    document.querySelectorAll('input[name="meal"], input[name="wmeal"]').forEach((c) => {
      c.checked = c.value === meal;
    });
    renderAll();
    setResultPlaceholder();
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
    li.appendChild(el(
      'span',
      item.price == null ? 'price unknown' : 'price',
      item.price == null ? '未标价' : `¥${fmt(item.price)}`
    ));
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
      const li = el('li');
      li.appendChild(el('span', 'name', d.name));
      li.appendChild(el(
        'span',
        d.price == null ? 'price unknown' : 'price',
        d.price == null ? '未标价' : `¥${fmt(d.price)}`
      ));
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
    p.textContent = `本餐段可随机：${parts.join(' · ')}`;
  }

  // ---------- 推荐结果占位 / 空引导 ----------
  function setResultPlaceholder() {
    const result = $('#result');
    result.textContent = '';
    const { singles, windows } = foodCandidates(currentMeal);
    const drinks = drinksForMeal(currentMeal);
    if (!singles.length && !windows.length && !drinks.length) {
      result.appendChild(el('p', 'placeholder', '这个餐段还没有可随机的条目'));
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
  function roll() {
    if (rolling) return;
    const { singles, windows } = foodCandidates(currentMeal);
    const drinks = drinksForMeal(currentMeal);
    const wantFood = currentMode !== 'drink';
    const wantDrink = currentMode !== 'food';

    const notes = [];
    const slots = [];
    let foodEntityId = null;
    let drinkPick = null;

    if (wantFood) {
      const pool = [
        ...singles.map((it) => ({ kind: 'single', id: it.id, item: it })),
        ...windows.map((w) => ({ kind: 'window', id: w.id, win: w })),
      ];
      const candidates = (pool.length > 1 && lastPick.food)
        ? pool.filter((p) => p.id !== lastPick.food)
        : pool;
      if (candidates.length) {
        const chosen = candidates[Math.floor(Math.random() * candidates.length)];
        foodEntityId = chosen.id;
        if (chosen.kind === 'single') {
          slots.push({
            tag: TYPE_LABEL.food,
            tagClass: 'food',
            finalName: chosen.item.name,
            price: chosen.item.price,
            animate: () => singles[Math.floor(Math.random() * singles.length)].name,
          });
        } else {
          const w = chosen.win;
          const ks = validKs(w);
          const k = ks[Math.floor(Math.random() * ks.length)];
          const dishes = sampleDishes(w.dishes, k);
          slots.push({
            tag: K_LABEL[k],
            tagClass: 'window',
            finalName: dishes.map((d) => d.name).join(' + '),
            sub: w.name,
            price: windowPrice(w, k, dishes),
            animate: () => {
              const rw = windows[Math.floor(Math.random() * windows.length)];
              const rk = validKs(rw)[Math.floor(Math.random() * validKs(rw).length)];
              return sampleDishes(rw.dishes, rk).map((d) => d.name).join(' + ');
            },
          });
        }
      } else {
        notes.push(currentMode === 'food' ? '该餐段还没有可随机的餐品 / 窗口' : '该餐段暂无餐品 / 窗口');
      }
    }

    if (wantDrink) {
      const dp = (drinks.length > 1 && lastPick.drink)
        ? drinks.filter((i) => i.id !== lastPick.drink)
        : drinks;
      if (dp.length) {
        drinkPick = dp[Math.floor(Math.random() * dp.length)];
        slots.push({
          tag: TYPE_LABEL.drink,
          tagClass: 'drink',
          finalName: drinkPick.name,
          price: drinkPick.price,
          animate: () => drinks[Math.floor(Math.random() * drinks.length)].name,
        });
      } else {
        notes.push(currentMode === 'drink' ? '该餐段还没有录入饮品' : '该餐段暂无饮品');
      }
    }

    if (!slots.length) {
      toast(notes[0] || '先去设置录入一些条目吧');
      return;
    }

    // 同一实体避免与上一次连续重复（候选 > 1 时）
    lastPick.food = foodEntityId;
    lastPick.drink = drinkPick ? drinkPick.id : null;

    const meal = MEALS[currentMeal];
    const result = $('#result');
    result.textContent = '';
    result.dataset.empty = '0';
    const card = el('div', 'result-card');
    card.appendChild(el('div', 'result-meal', `${meal.icon} ${meal.label} · ${MODE_LABEL[currentMode]}`));

    const wrap = el('div', 'result-items');
    const rowEls = [];
    slots.forEach((s) => {
      const row = el('div', 'result-item');
      row.appendChild(el('span', `tag ${s.tagClass}`, s.tag));
      const nameWrap = el('span', 'name-wrap');
      s.nameEl = el('span', 'name rolling', '······');
      nameWrap.appendChild(s.nameEl);
      row.appendChild(nameWrap);
      wrap.appendChild(row);
      rowEls.push(row);
    });
    card.appendChild(wrap);

    const totalEl = el('div', 'result-total', '');
    card.appendChild(totalEl);
    if (notes.length) card.appendChild(el('div', 'result-note', notes.join('，')));
    result.appendChild(card);

    rolling = true;
    const rollBtn = $('#rollBtn');
    rollBtn.disabled = true;

    // 滚动效果：名字快速轮换后落定
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - startedAt >= 700) {
        clearInterval(timer);
        slots.forEach((s, idx) => {
          s.nameEl.textContent = s.finalName;
          s.nameEl.classList.remove('rolling');
          if (s.sub) s.nameEl.after(el('span', 'sub', s.sub));
          rowEls[idx].appendChild(el('span', 'price', s.price == null ? '价格未知' : `¥${fmt(s.price)}`));
        });
        if (slots.length > 1) {
          const priced = slots.filter((s) => s.price != null);
          const sum = priced.reduce((acc, s) => acc + s.price, 0);
          totalEl.textContent = priced.length < slots.length
            ? `合计 ¥${fmt(sum)}（含未标价项）`
            : `合计 ¥${fmt(sum)}`;
        }
        rolling = false;
        rollBtn.disabled = false;
        return;
      }
      slots.forEach((s) => { s.nameEl.textContent = s.animate(); });
    }, 70);
  }

  // ---------- 录入：普通条目 ----------
  function showFormError(msg) {
    const e = $('#formError');
    e.textContent = msg;
    e.hidden = false;
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

  // ---------- 录入：拼菜窗口 ----------
  function syncFixedPriceRows(form) {
    form.querySelectorAll('.fixed-price-row').forEach((row) => {
      const k = row.dataset.k;
      const checked = form.querySelector(`input[name="pickK"][value="${k}"]`).checked;
      row.hidden = !checked;
    });
  }

  function submitWindow(form) {
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

    state.windows.push({
      id: uid(), name: name.slice(0, 40), meals,
      pickOptions: ks, fixedPrices, dishes: [], createdAt: Date.now(),
    });
    save();
    $('#windowName').value = '';
    form.querySelectorAll('input[name="pickK"]').forEach((c) => { c.checked = false; });
    form.querySelectorAll('.fixed-price-row input').forEach((i) => { i.value = ''; });
    syncFixedPriceRows(form);
    form.querySelectorAll('input[name="wmeal"]').forEach((c) => { c.checked = c.value === currentMeal; });
    renderAll();
    toast(`已创建窗口「${name}」，接下来添加菜品`);
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

  function importFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        const inItems = Array.isArray(data) ? data : data.items;
        const inWindows = !Array.isArray(data) && Array.isArray(data.windows) ? data.windows : [];
        const validItems = Array.isArray(inItems) ? inItems.filter(isValidItem).map(sanitizeItem) : [];
        const validWindows = inWindows.filter(isValidWindow).map(sanitizeWindow);
        if (!validItems.length && !validWindows.length) {
          toast('文件里没有可用的数据');
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
        if (!parts.length) { toast('导入的数据都已存在'); return; }
        toast(`已导入 ${parts.join('、')}${skipped ? `，跳过重复 ${skipped} 条` : ''}`);
      } catch (err) {
        toast('导入失败：不是有效的数据文件');
      }
    };
    reader.onerror = () => toast('导入失败：文件读取错误');
    reader.readAsText(file);
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

    $('#addItemForm').addEventListener('submit', (e) => {
      e.preventDefault();
      submitItem(e.target);
    });
    $('#itemList').addEventListener('click', (e) => {
      const btn = e.target.closest('.del');
      if (!btn) return;
      const id = btn.dataset.id;
      requestDelete(id, btn, () => { state.items = state.items.filter((i) => i.id !== id); });
    });

    $('#addWindowForm').addEventListener('change', (e) => {
      if (e.target.name === 'pickK') syncFixedPriceRows(e.currentTarget);
    });
    $('#addWindowForm').addEventListener('submit', (e) => {
      e.preventDefault();
      submitWindow(e.target);
    });
    $('#windowList').addEventListener('click', (e) => {
      const btn = e.target.closest('.del');
      if (!btn) return;
      if (btn.classList.contains('wdel')) {
        const wid = btn.dataset.wid;
        requestDelete(wid, btn, () => { state.windows = state.windows.filter((w) => w.id !== wid); });
      } else if (btn.classList.contains('ddel')) {
        const { wid, did } = btn.dataset;
        const win = state.windows.find((w) => w.id === wid);
        requestDelete(`${wid}:${did}`, btn, () => {
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

    window.addEventListener('hashchange', applyView);
  }

  // ---------- 启动 ----------
  load();
  bindEvents();
  applyView();
  switchMeal('breakfast');
})();
