'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('./meal-random.js');
const NOW = Date.UTC(2026, 9, 25, 4);
const DAY = 86400000;
const close = (actual, expected) => assert.ok(
  Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`,
);

test('一次差评降低权重；跨三次结果累积后到达下界', () => {
  const e = {};
  R.applyFeedback(e, 'dislike', NOW);
  close(R.weight(e, NOW), 0.4);
  R.applyFeedback(e, 'dislike', NOW);
  close(R.weight(e, NOW), 0.16);
  R.applyFeedback(e, 'dislike', NOW);
  close(R.weight(e, NOW), 0.1);
});

test('好评累积但不会无限垄断概率', () => {
  const e = {};
  for (let i = 0; i < 3; i++) R.applyFeedback(e, 'like', NOW);
  close(R.weight(e, NOW), 1.953125);
  for (let i = 0; i < 20; i++) R.applyFeedback(e, 'like', NOW);
  close(R.weight(e, NOW), 3);
});

test('按日历时间衰减；抽样读取不得反复刷新衰减锚点', () => {
  const e = {};
  R.applyFeedback(e, 'dislike', NOW);
  const stored = JSON.stringify(e);
  close(R.weight(e, NOW + 30 * DAY), 0.7);
  close(R.weight(e, NOW + 60 * DAY), 0.85);
  close(R.weight(e, NOW + 180 * DAY), 1);
  assert.equal(JSON.stringify(e), stored);
});

test('新反馈叠加到衰减后的权重，时钟回退不放大旧反馈', () => {
  const e = {};
  R.applyFeedback(e, 'dislike', NOW);
  close(R.weight(e, NOW - DAY), 0.4);
  R.applyFeedback(e, 'like', NOW + 30 * DAY);
  close(R.weight(e, NOW + 30 * DAY), 0.875);
});

test('忌口永不自动恢复，设置恢复默认后变为中性', () => {
  const e = {};
  R.applyFeedback(e, 'block', NOW);
  close(R.weight(e, NOW + 10000 * DAY), 0);
  R.resetPreference(e);
  close(R.weight(e, NOW), 1);
});

test('撤销恢复完整旧状态；较旧撤销不能覆盖后来的反馈或重置', () => {
  const e = {};
  const a = R.applyFeedback(e, 'dislike', NOW);
  assert.equal(R.undoFeedback(a), true);
  close(R.weight(e, NOW), 1);
  const b = R.applyFeedback(e, 'dislike', NOW);
  R.applyFeedback(e, 'like', NOW);
  assert.equal(R.undoFeedback(b), false);
  close(R.weight(e, NOW), 0.5);
  const c = R.applyFeedback(e, 'block', NOW);
  R.resetPreference(e);
  assert.equal(R.undoFeedback(c), false);
  close(R.weight(e, NOW), 1);
});

const item = (id, type = 'food', price = 10, meals = ['lunch']) => ({
  id, name: id, type, price, meals,
});
const win = (id = 'w1') => ({
  id, name: id, meals: ['lunch'], pickOptions: [2, 3, 4], fixedPrices: { 2: 12 },
  dishes: [
    { id: 'd1', name: '菜1', price: 7 },
    { id: 'd2', name: '菜2', price: 6 },
    { id: 'd3', name: '菜3', price: 5 },
  ],
});

test('按餐段、槽位、忌口和可行拼数过滤；不按窗口菜品数量扩张实体池', () => {
  const blocked = item('blocked');
  R.applyFeedback(blocked, 'block', NOW);
  const invalid = { ...win('invalid'), pickOptions: [4] };
  const data = { version: 2, items: [
    item('f1'), item('d1', 'drink'), item('breakfast', 'food', 2, ['breakfast']), blocked,
  ], windows: [win(), invalid] };
  assert.deepEqual(R.candidates(data, 'lunch', 'food').map((e) => e.key), ['item:f1', 'window:w1']);
  assert.deepEqual(R.candidates(data, 'lunch', 'drink').map((e) => e.key), ['item:d1']);
});

test('无反馈时各实体等概率；有十个候选时差评明确降低概率', () => {
  const data = { items: Array.from({ length: 10 }, (_, i) => item(`f${i}`)), windows: [] };
  const pool = R.candidates(data, 'lunch', 'food');
  assert.equal(pool.length, 10);
  R.distribution(pool, { now: NOW }).forEach((r) => close(r.probability, 0.1));
  R.applyFeedback(data.items[0], 'dislike', NOW);
  const rows = R.distribution(pool, { now: NOW });
  close(rows[0].probability, 0.04829787234042553);
  close(rows.reduce((s, r) => s + r.probability, 0), 1);
});

test('两个候选时软防连抽保留反馈作用，不会变成强制轮流', () => {
  const data = { items: [item('a'), item('b')], windows: [] };
  const pool = R.candidates(data, 'lunch', 'food');
  const rows = R.distribution(pool, { lastKey: 'item:a', now: NOW });
  assert.equal(rows.length, 2);
  close(rows[0].probability, 0.35);
  close(rows[1].probability, 0.65);
  R.applyFeedback(data.items[0], 'dislike', NOW);
  const lowered = R.distribution(pool, { lastKey: 'item:a', now: NOW });
  close(lowered[0].probability, 0.2);
});

test('探索下限只覆盖合格实体，不能复活忌口；单候选概率为一', () => {
  const a = item('a');
  const b = item('b');
  R.applyFeedback(b, 'block', NOW);
  const pool = [
    { kind: 'item', key: 'item:a', entity: a },
    { kind: 'item', key: 'item:b', entity: b },
  ];
  const rows = R.distribution(pool, { lastKey: 'item:a', now: NOW });
  assert.equal(rows.length, 1);
  close(rows[0].probability, 1);
  close(rows[0].repeatFactor, 1);
});

test('Fisher–Yates 对三道菜能到达全部六种排列且不修改原数组', () => {
  const dishes = win().dishes;
  const original = JSON.stringify(dishes);
  const seen = new Set();
  for (let a = 0; a < 3; a++) {
    for (let b = 0; b < 2; b++) {
      const values = [(a + 0.5) / 3, (b + 0.5) / 2];
      const sampled = R.sampleDishes(dishes, 3, () => values.shift());
      assert.equal(new Set(sampled.map((d) => d.id)).size, 3);
      seen.add(sampled.map((d) => d.id).join(','));
    }
  }
  assert.equal(seen.size, 6);
  assert.equal(JSON.stringify(dishes), original);
});

test('可注入随机源落在概率边界时选后一候选，接近一时选末项', () => {
  const data = { items: [item('a'), item('b')], windows: [] };
  const options = { meal: 'lunch', mode: 'food', now: NOW };
  assert.equal(R.recommend(data, { ...options, rng: () => 0 }).food?.key, 'item:a');
  assert.equal(R.recommend(data, { ...options, rng: () => 0.5 }).food?.key, 'item:b');
  assert.equal(R.recommend(data, { ...options, rng: () => 0.999999999 }).food?.key, 'item:b');
});

test('窗口只选择可行的 K，固定价优先，否则按所选菜价求和', () => {
  const w = win();
  const data = { items: [], windows: [w] };
  const base = { meal: 'lunch', mode: 'food', now: NOW };
  const a = R.recommend(data, { ...base, rng: () => 0 });
  assert.equal(a.food?.k, 2);
  assert.equal(new Set(a.food.dishes.map((d) => d.id)).size, 2);
  assert.equal(a.food.price, 12);
  const b = R.recommend(data, { ...base, rng: () => 0.999999999 });
  assert.equal(b.food?.k, 3);
  assert.equal(b.food.price, 18);
  w.fixedPrices[3] = 0;
  assert.equal(R.recommend(data, { ...base, rng: () => 0.9 }).food.price, 0);
});

test('兼容旧 v2 字符串拼数；数值和字符串同义拼数合并后再均匀选 K', () => {
  const w = win();
  w.pickOptions = ['2'];
  const data = { items: [], windows: [w] };
  const base = { meal: 'lunch', mode: 'food', now: NOW };
  assert.equal(R.candidates(data, 'lunch', 'food').length, 1);
  assert.equal(R.recommend(data, { ...base, rng: () => 0 }).food?.k, 2);
  w.pickOptions = ['2', 2, '3', 4];
  assert.equal(R.recommend(data, { ...base, rng: () => 0.5 }).food?.k, 3);
});

test('组合两槽独立落定；读抽样不写偏好，只有成功槽位推进 nextLast', () => {
  const data = { items: [item('f'), item('d', 'drink', 2.5)], windows: [] };
  const last = { 'breakfast:food': 'item:old', 'lunch:drink': 'item:oldDrink' };
  const before = JSON.stringify(data);
  const result = R.recommend(data, { meal: 'lunch', mode: 'combo', last, now: NOW, rng: () => 0 });
  assert.equal(result.food?.key, 'item:f');
  assert.equal(result.drink?.key, 'item:d');
  assert.equal(result.totalPrice, 12.5);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.nextLast, {
    'breakfast:food': 'item:old', 'lunch:food': 'item:f', 'lunch:drink': 'item:d',
  });
  assert.equal(last['lunch:drink'], 'item:oldDrink');
  assert.equal(JSON.stringify(data), before);
  const foodOnly = R.recommend(data, { meal: 'lunch', mode: 'food', last, now: NOW, rng: () => 0 });
  assert.equal(foodOnly.nextLast['lunch:drink'], 'item:oldDrink');
});

test('空池与部分结果返回明确状态，不绕过忌口；未知价格不能当零元总价', () => {
  const blocked = item('b');
  R.applyFeedback(blocked, 'block', NOW);
  const options = { meal: 'lunch', mode: 'combo', now: NOW, rng: () => 0 };
  const empty = R.recommend({ items: [blocked], windows: [] }, options);
  assert.equal(empty.status, 'empty');
  assert.deepEqual(empty.emptySlots, ['food', 'drink']);
  assert.equal(empty.totalPrice, null);
  const partial = R.recommend({ items: [item('f')], windows: [] }, options);
  assert.equal(partial.status, 'partial');
  assert.equal(partial.totalPrice, null);
  assert.equal(partial.knownSubtotal, 10);
  const unknown = R.recommend({ items: [item('f', 'food', null), item('d', 'drink', 2)], windows: [] }, options);
  assert.equal(unknown.status, 'ok');
  assert.equal(unknown.totalPrice, null);
  assert.equal(unknown.knownSubtotal, 2);
});

test('结果反馈每槽只计一次，撤销后可重选；窗口反馈不连带菜品', () => {
  const w = win();
  const data = { items: [item('d', 'drink', 2)], windows: [w] };
  const r = R.recommend(data, { meal: 'lunch', mode: 'combo', now: NOW, rng: () => 0 });
  assert.equal(R.vote(data, r, 'food', 'dislike', NOW), true);
  assert.equal(R.vote(data, r, 'food', 'dislike', NOW), false);
  assert.equal(R.vote(data, r, 'food', 'like', NOW), false);
  close(R.weight(w, NOW), 0.4);
  assert.ok(w.dishes.every((d) => d.preference === undefined));
  assert.equal(R.vote(data, r, 'drink', 'like', NOW), true);
  close(R.weight(data.items[0], NOW), 1.25);
  assert.equal(R.undoVote(data, r, 'food'), true);
  close(R.weight(w, NOW), 1);
  assert.equal(R.vote(data, r, 'food', 'like', NOW), true);
  close(R.weight(w, NOW), 1.25);
});

test('反馈按 key 写回当前菜单中的实体；菜单对象被替换或删除后不写进孤儿对象', () => {
  const data = { items: [item('a')], windows: [] };
  const r = R.recommend(data, { meal: 'lunch', mode: 'food', now: NOW, rng: () => 0 });
  data.items = data.items.map((o) => ({ ...o })); // 模拟重新载入 / 清洗
  assert.equal(R.vote(data, r, 'food', 'dislike', NOW), true);
  close(R.weight(data.items[0], NOW), 0.4);
  data.items = data.items.map((o) => ({ ...o, preference: { ...o.preference } }));
  assert.equal(R.undoVote(data, r, 'food'), false); // 凭据指向旧对象，不能假装撤销成功
  close(R.weight(data.items[0], NOW), 0.4);
  const r2 = R.recommend(data, { meal: 'lunch', mode: 'food', now: NOW, rng: () => 0 });
  data.items = [];
  assert.equal(R.vote(data, r2, 'food', 'like', NOW), false);
});

test('结果展示后实体在设置中被忌口：赞/踩返回 false 而非抛错，忌口仍可提交', () => {
  const data = { items: [item('a')], windows: [] };
  const r = R.recommend(data, { meal: 'lunch', mode: 'food', now: NOW, rng: () => 0 });
  R.applyFeedback(data.items[0], 'block', NOW);
  assert.equal(R.vote(data, r, 'food', 'dislike', NOW), false);
  assert.equal(R.vote(data, r, 'food', 'block', NOW), true);
  close(R.weight(data.items[0], NOW), 0);
});

test('没有任何已知价格时 knownSubtotal 为 null，而不是 ¥0', () => {
  const options = { meal: 'lunch', mode: 'combo', now: NOW, rng: () => 0 };
  assert.equal(R.recommend({ items: [], windows: [] }, options).knownSubtotal, null);
  const r = R.recommend({ items: [item('f', 'food', null)], windows: [] }, options);
  assert.equal(r.status, 'partial');
  assert.equal(r.knownSubtotal, null);
});

// ---------- 价格区间 ----------
// 确定性伪随机源，用于频率检验。
const lcg = (seed = 1) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

test('单槽区间按单价过滤；未知价格不参与；无合格项时 priceBlocked', () => {
  const data = { items: [item('a', 'food', 8), item('b', 'food', 15), item('u', 'food', null)], windows: [] };
  const base = { meal: 'lunch', mode: 'food', now: NOW };
  for (const u of [0, 0.5, 0.999]) {
    const r = R.recommend(data, { ...base, rng: () => u, priceRange: { lo: 10, hi: 20 } });
    assert.equal(r.food.key, 'item:b');
    close(r.food.probability, 1);
  }
  const none = R.recommend(data, { ...base, rng: () => 0, priceRange: { lo: 30, hi: 40 } });
  assert.equal(none.status, 'empty');
  assert.equal(none.priceBlocked, true);
  const noMenu = R.recommend({ items: [], windows: [] }, { ...base, priceRange: { lo: 0, hi: 5 } });
  assert.equal(noMenu.priceBlocked, false);
});

test('区间内窗口只拼出可行的 K 与菜品子集；一口价按 K 判定', () => {
  const w = win(); // 菜价 7/6/5，双拼一口价 12，三拼按合计 18
  const data = { items: [], windows: [w] };
  const base = { meal: 'lunch', mode: 'food', now: NOW };
  for (const u of [0, 0.3, 0.7, 0.999]) {
    const r = R.recommend(data, { ...base, rng: () => u, priceRange: { lo: 0, hi: 12 } });
    assert.equal(r.food.k, 2);
    assert.equal(r.food.price, 12);
    assert.equal(new Set(r.food.dishes.map((d) => d.id)).size, 2);
    assert.equal(R.recommend(data, { ...base, rng: () => u, priceRange: { lo: 13, hi: 20 } }).food.price, 18);
  }
  delete w.fixedPrices[2]; // 双拼按菜价：13 / 12 / 11，只有 6 + 5 = 11 合格
  const r = R.recommend(data, { ...base, rng: () => 0.5, priceRange: { lo: 0, hi: 11 } });
  assert.deepEqual(r.food.dishes.map((d) => d.id).sort(), ['d2', 'd3']);
  assert.equal(r.food.price, 11);
});

test('稀有可行组合也一定能抽到（v0.4 拒绝采样 40 次可能误报凑不出）', () => {
  const dishes = Array.from({ length: 12 }, (_, i) => ({ id: `d${i}`, name: `菜${i}`, price: i < 2 ? 1 : 10 }));
  const w = { id: 'w', name: 'w', meals: ['lunch'], pickOptions: [2], fixedPrices: {}, dishes };
  const rng = lcg(7);
  for (let i = 0; i < 50; i++) {
    const r = R.recommend({ items: [], windows: [w] }, {
      meal: 'lunch', mode: 'food', now: NOW, rng, priceRange: { lo: 0, hi: 2 },
    });
    assert.deepEqual(r.food.dishes.map((d) => d.id).sort(), ['d0', 'd1']);
  }
});

test('组合区间按合计取条件分布：概率精确且与抽样频率一致', () => {
  // 可行组合：10+2、10+6、15+2；15+6=21 超出。中性权重下三者各 1/3。
  const data = {
    items: [item('f10', 'food', 10), item('f15', 'food', 15), item('d2', 'drink', 2), item('d6', 'drink', 6)],
    windows: [],
  };
  const options = { meal: 'lunch', mode: 'combo', now: NOW, priceRange: { lo: 12, hi: 17 } };
  const first = R.recommend(data, { ...options, rng: () => 0 });
  assert.equal(first.status, 'ok');
  close(first.food.probability, 2 / 3);
  close(first.drink.probability, 2 / 3);
  const rng = lcg(42);
  const seen = {};
  const n = 30000;
  for (let i = 0; i < n; i++) {
    const r = R.recommend(data, { ...options, rng });
    const t = r.totalPrice;
    assert.ok(t >= 12 && t <= 17);
    const pair = `${r.food.key}+${r.drink.key}`;
    seen[pair] = (seen[pair] || 0) + 1;
  }
  assert.equal(Object.keys(seen).length, 3);
  Object.values(seen).forEach((c) => assert.ok(Math.abs(c / n - 1 / 3) < 0.015, `${c / n}`));
});

test('组合区间：两槽都有候选但凑不出时为空；某槽本就无候选时另一槽按单价约束', () => {
  const data = { items: [item('f', 'food', 10), item('d', 'drink', 5)], windows: [] };
  const options = { meal: 'lunch', mode: 'combo', now: NOW, rng: () => 0 };
  const none = R.recommend(data, { ...options, priceRange: { lo: 0, hi: 12 } });
  assert.equal(none.status, 'empty');
  assert.equal(none.priceBlocked, true);
  assert.deepEqual(none.nextLast, {});
  const foodOnly = { items: [item('f', 'food', 10), item('g', 'food', 20)], windows: [] };
  const r = R.recommend(foodOnly, { ...options, priceRange: { lo: 15, hi: 25 } });
  assert.equal(r.status, 'partial');
  assert.equal(r.food.key, 'item:g');
  assert.equal(r.priceBlocked, false);
});

test('区间边界以分比较；非法区间明确报错', () => {
  const data = { items: [item('f', 'food', 0.1), item('d', 'drink', 0.2)], windows: [] };
  const r = R.recommend(data, {
    meal: 'lunch', mode: 'combo', now: NOW, rng: () => 0, priceRange: { lo: 0.3, hi: 0.3 },
  });
  assert.equal(r.totalPrice, 0.3);
  for (const bad of [{ lo: 5, hi: 1 }, { lo: -1, hi: 3 }, { lo: NaN }]) {
    assert.throws(() => R.recommend(data, { meal: 'lunch', now: NOW, priceRange: bad }), RangeError);
  }
});

test('非法随机源、非法 K 和非法调用参数明确报错', () => {
  const data = { items: [item('a')], windows: [] };
  for (const bad of [-0.1, 1, NaN, Infinity]) {
    assert.throws(() => R.recommend(data, { meal: 'lunch', mode: 'food', now: NOW, rng: () => bad }), RangeError);
  }
  assert.throws(() => R.sampleDishes(win().dishes, 4), RangeError);
  assert.throws(() => R.recommend(data, { meal: 'invalid', mode: 'food' }), TypeError);
  assert.throws(() => R.recommend(data, { meal: 'lunch', mode: 'invalid' }), TypeError);
});

test('导出 draw 供页面自行抽样；vote 拒绝缺少 key 的手拼结果', () => {
  const rows = R.distribution(R.candidates({ items: [item('a'), item('b')], windows: [] }, 'lunch', 'food'), { now: NOW });
  assert.equal(R.draw(rows, () => 0.5).key, 'item:b');
  const data = { items: [item('a')], windows: [] };
  assert.throws(() => R.vote(data, { food: { entity: data.items[0] }, votes: {} }, 'food', 'like', NOW), TypeError);
});
