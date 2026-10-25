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

  // ---------- 价格区间（硬过滤，未知价格不合格） ----------
  function checkRange(r) {
    if (r == null) return null;
    const lo = r.lo ?? 0;
    const hi = r.hi ?? Infinity;
    if (!Number.isFinite(lo) || lo < 0 || Number.isNaN(hi) || hi < lo) {
      throw new RangeError('priceRange 需满足 0 ≤ lo ≤ hi');
    }
    return { lo, hi };
  }

  // 以分比较，避免 0.1 + 0.2 之类的尾差把边界上的价格判出区间。
  const cents = (x) => Math.round(x * 100);
  const inRange = (p, r) => p !== null && cents(p) >= cents(r.lo) && cents(p) <= cents(r.hi);

  function combinations(arr, k, start = 0, acc = [], out = []) {
    if (acc.length === k) { out.push(acc.slice()); return out; }
    for (let i = start; i <= arr.length - (k - acc.length); i++) {
      acc.push(arr[i]);
      combinations(arr, k, i + 1, acc, out);
      acc.pop();
    }
    return out;
  }

  // 候选的全部具体配置，按 K 分组。一口价的 K 只占一项，抽中后再洗牌选菜；
  // 否则枚举该 K 的菜品子集。组内均匀、组间均匀，与无区间时的分层抽样一致。
  function expand(c) {
    const e = c.entity;
    if (c.kind === 'item') {
      return { ...c, groups: [{ k: null, options: [{ price: sumMoney([e.price]), dishes: null }] }] };
    }
    return {
      ...c,
      groups: validKs(e).map((k) => {
        const fixed = e.fixedPrices?.[k];
        if (knownPrice(fixed)) return { k, options: [{ price: sumMoney([fixed]), dishes: null }] };
        return {
          k,
          options: combinations(e.dishes, k)
            .map((dishes) => ({ price: sumMoney(dishes.map((d) => d.price)), dishes })),
        };
      }),
    };
  }

  // 只保留满足 keep 的配置；一个可行配置都没有的实体退出候选池（先过滤，后加权）。
  const narrow = (expanded, keep) => expanded
    .map((c) => ({
      ...c,
      groups: c.groups.map((g) => ({ ...g, options: g.options.filter(keep) }))
        .filter((g) => g.options.length),
    }))
    .filter((c) => c.groups.length);

  const pick = (arr, rng) => arr[Math.floor(unit(rng) * arr.length)];

  function finish(row, group, option, rng, probability = row.probability) {
    const { groups, ...out } = row;
    if (row.kind === 'item') return { ...out, probability, price: option.price };
    const dishes = option.dishes || sampleDishes(row.entity.dishes, group.k, rng);
    return { ...out, probability, k: group.k, dishes, price: option.price };
  }

  // 单槽：按单价过滤后加权抽实体，再在其可行配置里均匀选 K、均匀选菜品子集。
  function drawInRange(pool, opts, range, rng) {
    const rows = distribution(narrow(pool.map(expand), (o) => inRange(o.price, range)), opts);
    const chosen = draw(rows, rng);
    if (!chosen) return null;
    const group = pick(chosen.groups, rng);
    return finish(chosen, group, pick(group.options, rng), rng);
  }

  // 组合：按合计过滤。P(f, d | 可行) ∝ P_F(f) × P_D(d) × 1[合计在区间内]，
  // P_F 含实体概率与实体内配置概率。精确枚举，不用拒绝采样，有解就一定抽得到。
  function drawPair(foodPool, drinkPool, foodOpts, drinkOpts, range, rng) {
    const sum = (a, b) => sumMoney([a, b]);
    const foodAll = narrow(foodPool.map(expand), (o) => o.price !== null);
    const drinkAll = narrow(drinkPool.map(expand), (o) => o.price !== null);
    const priceList = (xs) => xs.flatMap((c) => c.groups.flatMap((g) => g.options.map((o) => o.price)));
    const foodPrices = priceList(foodAll);
    const drinkPrices = priceList(drinkAll);
    const foodRows = distribution(
      narrow(foodAll, (o) => drinkPrices.some((p) => inRange(sum(o.price, p), range))), foodOpts);
    const drinkRows = distribution(
      narrow(drinkAll, (o) => foodPrices.some((p) => inRange(sum(o.price, p), range))), drinkOpts);
    if (!foodRows.length || !drinkRows.length) return null;

    const configs = [];
    const drinkMass = new Map();
    let total = 0;
    for (const row of foodRows) {
      for (const group of row.groups) {
        for (const option of group.options) {
          const pF = row.probability / row.groups.length / group.options.length;
          let mass = 0;
          for (const d of drinkRows) {
            if (!inRange(sum(option.price, d.groups[0].options[0].price), range)) continue;
            mass += pF * d.probability;
            drinkMass.set(d, (drinkMass.get(d) || 0) + pF * d.probability);
          }
          configs.push({ row, group, option, mass });
          total += mass;
        }
      }
    }
    // 先按边际抽食物配置，再按条件分布抽饮品，等价于直接抽可行组合。
    const u = unit(rng) * total;
    let acc = 0;
    let f = configs[configs.length - 1];
    for (const c of configs) {
      acc += c.mass;
      if (u < acc) { f = c; break; }
    }
    const fits = drinkRows.filter((d) => inRange(sum(f.option.price, d.groups[0].options[0].price), range));
    const dTotal = fits.reduce((s, d) => s + d.probability, 0);
    const v = unit(rng) * dTotal;
    acc = 0;
    let d = fits[fits.length - 1];
    for (const x of fits) {
      acc += x.probability;
      if (v < acc) { d = x; break; }
    }
    const foodProb = configs.filter((c) => c.row === f.row).reduce((s, c) => s + c.mass, 0) / total;
    return {
      food: finish(f.row, f.group, f.option, rng, foodProb),
      drink: finish(d, d.groups[0], d.groups[0].options[0], rng, drinkMass.get(d) / total),
    };
  }

  // 纯抽样：不写偏好、不修改 last。结果正式展示后，调用方采用 nextLast。
  // priceRange 为 { lo, hi } 或 null：仅餐品/仅饮品按单价，组合按餐品 + 饮品合计；
  // 组合中某槽本就无候选时，另一槽按单价约束。
  function recommend(data, {
    meal, mode = 'combo', last = {}, now = Date.now(), rng = Math.random, priceRange = null,
  } = {}) {
    if (!['breakfast', 'lunch', 'dinner'].includes(meal)) throw new TypeError('未知餐段');
    if (!['combo', 'food', 'drink'].includes(mode)) throw new TypeError('未知推荐模式');
    checkTime(now);
    const range = checkRange(priceRange);
    const slots = mode === 'combo' ? ['food', 'drink'] : [mode];
    const result = { food: null, drink: null, nextLast: { ...last }, votes: {}, priceRange: range };
    const pools = Object.fromEntries(slots.map((s) => [s, candidates(data, meal, s)]));
    const opts = (slot) => ({ lastKey: last[`${meal}:${slot}`], now });
    const picks = {};
    if (!range) {
      for (const slot of slots) {
        const chosen = draw(distribution(pools[slot], opts(slot)), rng);
        if (chosen) picks[slot] = materialize(chosen, rng);
      }
    } else if (slots.length === 2 && pools.food.length && pools.drink.length) {
      Object.assign(picks, drawPair(pools.food, pools.drink, opts('food'), opts('drink'), range, rng));
    } else {
      for (const slot of slots) {
        const chosen = drawInRange(pools[slot], opts(slot), range, rng);
        if (chosen) picks[slot] = chosen;
      }
    }
    for (const slot of slots) {
      if (!picks[slot]) continue;
      result[slot] = picks[slot];
      result.nextLast[`${meal}:${slot}`] = picks[slot].key;
    }
    const chosen = slots.map((s) => result[s]).filter(Boolean);
    const known = chosen.filter((p) => p.price !== null);
    result.emptySlots = slots.filter((s) => !result[s]);
    result.status = !chosen.length ? 'empty' : result.emptySlots.length ? 'partial' : 'ok';
    // 有候选却因区间落空：提示放宽区间，而不是去录入。
    result.priceBlocked = range !== null && result.emptySlots.some((s) => pools[s].length > 0);
    result.knownSubtotal = known.length ? sumMoney(known.map((p) => p.price)) : null;
    result.totalPrice = result.status === 'ok' ? sumMoney(chosen.map((p) => p.price)) : null;
    return result;
  }

  // 按 key 回到当前菜单找实体：结果卡片可能比菜单活得久（编辑、删除、重新载入）。
  function findEntity(data, key) {
    const i = key.indexOf(':');
    const list = key.slice(0, i) === 'window' ? data.windows : data.items;
    return (list || []).find((e) => e.id === key.slice(i + 1)) || null;
  }

  // 一次结果的每个实体最多反馈一次；想改选，先撤销。
  // 实体已删除，或已在别处设为忌口（再赞/踩无意义）时返回 false，不抛错。
  function vote(data, result, slot, action, now = Date.now()) {
    if (!['food', 'drink'].includes(slot)) throw new TypeError('未知槽位');
    if (!result[slot] || result.votes[slot]) return false;
    const entity = findEntity(data, result[slot].key);
    if (!entity) return false;
    if (readPreference(entity).blocked && action !== 'block') return false;
    result.votes[slot] = applyFeedback(entity, action, now);
    return true;
  }

  function undoVote(data, result, slot) {
    if (!['food', 'drink'].includes(slot)) throw new TypeError('未知槽位');
    const receipt = result.votes[slot];
    if (!receipt || findEntity(data, result[slot].key) !== receipt.entity) return false;
    if (!undoFeedback(receipt)) return false;
    delete result.votes[slot];
    return true;
  }

  return {
    CFG, readPreference, weight, applyFeedback, resetPreference, undoFeedback,
    candidates, distribution, sampleDishes, recommend, vote, undoVote,
  };
})();

if (typeof module !== 'undefined') module.exports = MealRandom;
