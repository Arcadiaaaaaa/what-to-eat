'use strict';

const MealRandom = (() => {
  const CFG = Object.freeze({
    like: 1.25, dislike: 0.4, minWeight: 0.1, maxWeight: 3,
    halfLifeDays: 30, neutralGap: 0.01, epsilon: 0.1, repeatFactor: 0.5,
  });
  const DAY = 86400000;
  const clamp = (x) => Math.max(CFG.minWeight, Math.min(CFG.maxWeight, x));

  function checkTime(now) {
    if (!Number.isFinite(now) || now < 0) throw new RangeError('now 应为非负毫秒时间戳');
  }

  // 只读归一化：旧版实体缺少 preference 时自动视为中性。
  function readPreference(entity) {
    const p = entity.preference;
    const valid = Number.isFinite(p?.weight)
      && Number.isFinite(p?.updatedAt) && p.updatedAt >= 0;
    return {
      weight: valid ? clamp(p.weight) : 1,
      updatedAt: valid ? p.updatedAt : null,
      blocked: p?.blocked === true,
    };
  }

  function weight(entity, now = Date.now()) {
    checkTime(now);
    const p = readPreference(entity);
    if (p.blocked) return 0;
    const days = p.updatedAt === null ? 0 : Math.max(0, now - p.updatedAt) / DAY;
    const w = 1 + (p.weight - 1) * 2 ** (-days / CFG.halfLifeDays);
    return Math.abs(w - 1) <= CFG.neutralGap ? 1 : w;
  }

  function resetPreference(entity) {
    // 新对象也使旧的撤销凭据失效。
    entity.preference = { weight: 1, updatedAt: null, blocked: false };
  }

  function applyFeedback(entity, action, now = Date.now()) {
    checkTime(now);
    if (!['like', 'dislike', 'block'].includes(action)) throw new TypeError('未知反馈');
    const before = entity.preference;
    const p = readPreference(entity);
    if (p.blocked && action !== 'block') throw new Error('请先在设置中恢复默认');
    const after = action === 'block'
      ? { ...p, blocked: true }
      : { weight: clamp(weight(entity, now) * CFG[action]), updatedAt: now, blocked: false };
    entity.preference = after;
    return { entity, before, after }; // 会话内撤销凭据，不写入 localStorage。
  }

  function undoFeedback(receipt) {
    if (!receipt || receipt.entity.preference !== receipt.after) return false;
    if (receipt.before === undefined) delete receipt.entity.preference;
    else receipt.entity.preference = receipt.before;
    return true;
  }

  // 旧版 v2 也可能保存字符串拼数；先转数值再去重，避免重复拼法取得额外概率。
  const validKs = (w) => [...new Set(w.pickOptions.map(Number))]
    .filter((k) => [2, 3, 4].includes(k) && k <= w.dishes.length);

  function candidate(kind, entity) {
    if (typeof entity.id !== 'string' || !entity.id) throw new TypeError('实体需要稳定 id');
    return { kind, key: `${kind}:${entity.id}`, entity };
  }

  // 输入已通过项目原有菜单校验；每个窗口只占一个实体候选名额。
  function candidates(data, meal, slot) {
    const matches = (e) => e.meals.includes(meal) && !readPreference(e).blocked;
    const pool = (data.items || [])
      .filter((e) => e.type === slot && matches(e)).map((e) => candidate('item', e));
    if (slot === 'food') {
      pool.push(...(data.windows || [])
        .filter((w) => matches(w) && validKs(w).length > 0).map((w) => candidate('window', w)));
    }
    return pool;
  }

  function distribution(pool, { lastKey = null, now = Date.now() } = {}) {
    checkTime(now);
    const eligible = pool.filter((c) => !readPreference(c.entity).blocked);
    const n = eligible.length;
    if (!n) return [];
    const rows = eligible.map((c) => ({
      ...c,
      weight: weight(c.entity, now),
      repeatFactor: n > 1 && c.key === lastKey ? CFG.repeatFactor : 1,
    }));
    const sum = rows.reduce((s, r) => s + r.weight * r.repeatFactor, 0);
    return rows.map((r) => ({
      ...r, poolSize: n,
      probability: CFG.epsilon / n
        + (1 - CFG.epsilon) * r.weight * r.repeatFactor / sum,
    }));
  }

  function unit(rng) {
    const u = rng();
    if (!Number.isFinite(u) || u < 0 || u >= 1) throw new RangeError('rng 必须返回 [0, 1)');
    return u;
  }

  function draw(rows, rng) {
    if (!rows.length) return null;
    const u = unit(rng);
    let cumulative = 0;
    for (const row of rows) {
      cumulative += row.probability;
      if (u < cumulative) return row;
    }
    return rows[rows.length - 1]; // 仅处理浮点累加尾差。
  }

  function sampleDishes(dishes, k, rng = Math.random) {
    if (!Number.isInteger(k) || k < 0 || k > dishes.length) throw new RangeError('无效拼数');
    const arr = dishes.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(unit(rng) * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr.slice(0, k);
  }

  const knownPrice = (p) => Number.isFinite(p) && p >= 0;
  // 以分求和；未知价格不能按零元处理。
  const sumMoney = (prices) => prices.every(knownPrice)
    ? prices.reduce((s, p) => s + Math.round(p * 100), 0) / 100 : null;

  function materialize(chosen, rng) {
    const e = chosen.entity;
    if (chosen.kind === 'item') return { ...chosen, price: sumMoney([e.price]) };
    const ks = validKs(e);
    const k = ks[Math.floor(unit(rng) * ks.length)];
    const dishes = sampleDishes(e.dishes, k, rng);
    const fixed = e.fixedPrices?.[k];
    const price = knownPrice(fixed) ? sumMoney([fixed]) : sumMoney(dishes.map((d) => d.price));
    return { ...chosen, k, dishes, price };
  }

  // 纯抽样：不写偏好、不修改 last。结果正式展示后，调用方采用 nextLast。
  function recommend(data, {
    meal, mode = 'combo', last = {}, now = Date.now(), rng = Math.random,
  } = {}) {
    if (!['breakfast', 'lunch', 'dinner'].includes(meal)) throw new TypeError('未知餐段');
    if (!['combo', 'food', 'drink'].includes(mode)) throw new TypeError('未知推荐模式');
    checkTime(now);
    const slots = mode === 'combo' ? ['food', 'drink'] : [mode];
    const result = { food: null, drink: null, nextLast: { ...last }, votes: {} };
    for (const slot of slots) {
      const scope = `${meal}:${slot}`;
      const rows = distribution(candidates(data, meal, slot), { lastKey: last[scope], now });
      const chosen = draw(rows, rng);
      if (!chosen) continue;
      result[slot] = materialize(chosen, rng);
      result.nextLast[scope] = chosen.key;
    }
    const picks = slots.map((s) => result[s]).filter(Boolean);
    result.emptySlots = slots.filter((s) => !result[s]);
    result.status = !picks.length ? 'empty' : result.emptySlots.length ? 'partial' : 'ok';
    result.knownSubtotal = sumMoney(picks.filter((p) => p.price !== null).map((p) => p.price));
    result.totalPrice = result.status === 'ok' ? sumMoney(picks.map((p) => p.price)) : null;
    return result;
  }

  // 一次结果的每个实体最多反馈一次；想改选，先撤销。
  function vote(result, slot, action, now = Date.now()) {
    if (!['food', 'drink'].includes(slot)) throw new TypeError('未知槽位');
    if (!result[slot] || result.votes[slot]) return false;
    result.votes[slot] = applyFeedback(result[slot].entity, action, now);
    return true;
  }

  function undoVote(result, slot) {
    if (!['food', 'drink'].includes(slot)) throw new TypeError('未知槽位');
    if (!undoFeedback(result.votes[slot])) return false;
    delete result.votes[slot];
    return true;
  }

  return {
    CFG, readPreference, weight, applyFeedback, resetPreference, undoFeedback,
    candidates, distribution, sampleDishes, recommend, vote, undoVote,
  };
})();

if (typeof module !== 'undefined') module.exports = MealRandom;
