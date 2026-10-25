(() => {
  'use strict';

  const STORAGE_KEY = 'what-to-eat-data-v1';

  const MEALS = {
    breakfast: { label: '早餐', icon: '🌅' },
    lunch: { label: '午餐', icon: '☀️' },
    dinner: { label: '晚餐', icon: '🌙' },
  };
  const TYPE_LABEL = { food: '餐品', drink: '饮品' };
  const MODE_LABEL = { combo: '餐品 + 饮品', food: '仅餐品', drink: '仅饮品' };

  const SAMPLE = [
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

  const state = { items: [] };
  let currentMeal = 'breakfast';
  let currentMode = 'combo';
  let lastPick = { food: null, drink: null };
  let rolling = false;
  let pendingDeleteId = null;
  let pendingDeleteBtn = null;
  let pendingDeleteTimer = null;
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

  // ---------- 数据存取 ----------
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

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (Array.isArray(data.items)) state.items = data.items.filter(isValidItem).map(sanitizeItem);
    } catch (err) {
      console.warn('本地数据读取失败，已忽略：', err);
    }
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, items: state.items }));
  }

  const itemsForMeal = (meal) => state.items.filter((i) => i.meals.includes(meal));

  // ---------- 提示 ----------
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
  }

  // ---------- 清单渲染 ----------
  function resetPendingDelete() {
    clearTimeout(pendingDeleteTimer);
    if (pendingDeleteBtn && pendingDeleteBtn.isConnected) {
      pendingDeleteBtn.classList.remove('confirm');
      pendingDeleteBtn.textContent = '删除';
    }
    pendingDeleteId = null;
    pendingDeleteBtn = null;
  }

  function renderAll() {
    const meal = MEALS[currentMeal];
    $('#listTitle').textContent = `${meal.icon} ${meal.label}清单`;
    renderList();
  }

  function renderList() {
    resetPendingDelete();
    const listEl = $('#itemList');
    listEl.textContent = '';
    const items = itemsForMeal(currentMeal);
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

  // ---------- 餐段 / 模式切换 ----------
  function switchMeal(meal) {
    if (!MEALS[meal]) return;
    currentMeal = meal;
    document.querySelectorAll('#mealTabs .tab').forEach((b) => {
      b.classList.toggle('active', b.dataset.meal === meal);
    });
    document.querySelectorAll('input[name="meal"]').forEach((c) => {
      c.checked = c.value === meal;
    });
    renderAll();
  }

  function setMode(mode) {
    currentMode = mode;
    document.querySelectorAll('#modeToggle .mode').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
  }

  // ---------- 随机推荐 ----------
  function pickFrom(pool, excludeId) {
    const candidates = (pool.length > 1 && excludeId)
      ? pool.filter((i) => i.id !== excludeId)
      : pool;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  function roll() {
    if (rolling) return;
    const items = itemsForMeal(currentMeal);
    const foods = items.filter((i) => i.type === 'food');
    const drinks = items.filter((i) => i.type === 'drink');
    const wantFood = currentMode !== 'drink';
    const wantDrink = currentMode !== 'food';

    const notes = [];
    const picks = [];
    let foodPick = null;
    let drinkPick = null;

    if (wantFood) {
      if (foods.length) {
        foodPick = pickFrom(foods, lastPick.food);
        picks.push(foodPick);
      } else {
        notes.push(currentMode === 'food' ? '该餐段还没有录入餐品' : '该餐段暂无餐品');
      }
    }
    if (wantDrink) {
      if (drinks.length) {
        drinkPick = pickFrom(drinks, lastPick.drink);
        picks.push(drinkPick);
      } else {
        notes.push(currentMode === 'drink' ? '该餐段还没有录入饮品' : '该餐段暂无饮品');
      }
    }
    if (!picks.length) {
      toast(notes[0] || '先录入一些餐品或饮品吧');
      return;
    }

    // 同一槽位避免与上一次连续重复（多于 1 个候选时）
    lastPick.food = foodPick ? foodPick.id : null;
    lastPick.drink = drinkPick ? drinkPick.id : null;

    const meal = MEALS[currentMeal];
    const result = $('#result');
    result.textContent = '';
    const card = el('div', 'result-card');
    card.appendChild(el('div', 'result-meal', `${meal.icon} ${meal.label} · ${MODE_LABEL[currentMode]}`));

    const wrap = el('div', 'result-items');
    const slots = [];
    if (foodPick) slots.push({ type: 'food', item: foodPick, pool: foods });
    if (drinkPick) slots.push({ type: 'drink', item: drinkPick, pool: drinks });
    slots.forEach((s) => {
      const row = el('div', 'result-item');
      row.appendChild(el('span', `tag ${s.type}`, TYPE_LABEL[s.type]));
      s.nameEl = el('span', 'name rolling', '······');
      row.appendChild(s.nameEl);
      wrap.appendChild(row);
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
      if (Date.now() - startedAt >= 650) {
        clearInterval(timer);
        slots.forEach((s) => {
          s.nameEl.textContent = s.item.name;
          s.nameEl.classList.remove('rolling');
          s.nameEl.parentElement.appendChild(el(
            'span',
            'price',
            s.item.price == null ? '价格未知' : `¥${fmt(s.item.price)}`
          ));
        });
        if (picks.length > 1) {
          const priced = picks.filter((p) => p.price != null);
          const sum = priced.reduce((acc, p) => acc + p.price, 0);
          totalEl.textContent = priced.length < picks.length
            ? `合计 ¥${fmt(sum)}（含未标价项）`
            : `合计 ¥${fmt(sum)}`;
        }
        rolling = false;
        rollBtn.disabled = false;
        return;
      }
      slots.forEach((s) => {
        s.nameEl.textContent = s.pool[Math.floor(Math.random() * s.pool.length)].name;
      });
    }, 70);
  }

  // ---------- 录入 ----------
  function showFormError(msg) {
    const e = $('#formError');
    e.textContent = msg;
    e.hidden = false;
  }

  function hideFormError() {
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
    hideFormError();

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

  // ---------- 删除（点两次确认） ----------
  function requestDelete(id, btn) {
    if (pendingDeleteId === id) {
      state.items = state.items.filter((i) => i.id !== id);
      save();
      renderList();
      toast('已删除');
      return;
    }
    resetPendingDelete();
    pendingDeleteId = id;
    pendingDeleteBtn = btn;
    btn.classList.add('confirm');
    btn.textContent = '确认删除？';
    pendingDeleteTimer = setTimeout(resetPendingDelete, 2600);
  }

  // ---------- 示例 / 导入 / 导出 ----------
  function loadSample() {
    const existing = new Set(state.items.map(itemKey));
    let added = 0;
    SAMPLE.forEach((s) => {
      const item = sanitizeItem({ ...s, createdAt: Date.now() });
      const key = itemKey(item);
      if (existing.has(key)) return;
      existing.add(key);
      state.items.push(item);
      added += 1;
    });
    save();
    renderAll();
    toast(added ? `已加载 ${added} 条示例数据` : '示例数据都已存在');
  }

  function exportData() {
    if (!state.items.length) {
      toast('还没有数据可导出');
      return;
    }
    const payload = JSON.stringify(
      { version: 1, exportedAt: new Date().toISOString(), items: state.items },
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
        const incoming = Array.isArray(data) ? data : data.items;
        if (!Array.isArray(incoming)) throw new Error('bad format');
        const valid = incoming.filter(isValidItem).map(sanitizeItem);
        if (!valid.length) {
          toast('文件里没有可用的数据');
          return;
        }
        const existing = new Set(state.items.map(itemKey));
        let added = 0;
        valid.forEach((item) => {
          const key = itemKey(item);
          if (existing.has(key)) return;
          existing.add(key);
          state.items.push(item);
          added += 1;
        });
        save();
        renderAll();
        toast(added === valid.length
          ? `已导入 ${added} 条`
          : `已导入 ${added} 条，跳过重复 ${valid.length - added} 条`);
      } catch (err) {
        toast('导入失败：不是有效的数据文件');
      }
    };
    reader.onerror = () => toast('导入失败：文件读取错误');
    reader.readAsText(file);
  }

  // ---------- 事件绑定 ----------
  function bindEvents() {
    $('#mealTabs').addEventListener('click', (e) => {
      const btn = e.target.closest('.tab');
      if (btn) switchMeal(btn.dataset.meal);
    });
    $('#modeToggle').addEventListener('click', (e) => {
      const btn = e.target.closest('.mode');
      if (btn) setMode(btn.dataset.mode);
    });
    $('#addItemForm').addEventListener('submit', (e) => {
      e.preventDefault();
      submitItem(e.target);
    });
    $('#itemList').addEventListener('click', (e) => {
      const btn = e.target.closest('.del');
      if (btn) requestDelete(btn.dataset.id, btn);
    });
    $('#rollBtn').addEventListener('click', roll);
    $('#loadSample').addEventListener('click', loadSample);
    $('#exportBtn').addEventListener('click', exportData);
    $('#importBtn').addEventListener('click', () => $('#importFile').click());
    $('#importFile').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) importFile(file);
      e.target.value = '';
    });
  }

  // ---------- 启动 ----------
  load();
  bindEvents();
  switchMeal('breakfast');
})();
