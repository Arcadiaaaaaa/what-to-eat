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
  assert.equal(R.vote(r, 'food', 'dislike', NOW), true);
  assert.equal(R.vote(r, 'food', 'dislike', NOW), false);
  assert.equal(R.vote(r, 'food', 'like', NOW), false);
  close(R.weight(w, NOW), 0.4);
  assert.ok(w.dishes.every((d) => d.preference === undefined));
  assert.equal(R.vote(r, 'drink', 'like', NOW), true);
  close(R.weight(data.items[0], NOW), 1.25);
  assert.equal(R.undoVote(r, 'food'), true);
  close(R.weight(w, NOW), 1);
  assert.equal(R.vote(r, 'food', 'like', NOW), true);
  close(R.weight(w, NOW), 1.25);
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
