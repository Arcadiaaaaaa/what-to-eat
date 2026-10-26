/* 今天吃什么 · 云同步（Pages Function，与站点同源 /api/sync）
   协议：
   - GET  /api/sync  （请求头 X-Sync-Code）→ 200 {revision, data, updatedAt} | 404 尚无云端数据
   - PUT  /api/sync  （请求头 X-Sync-Code，body {base, data}）
       base 与云端 revision 一致（或云端为空）→ 覆盖，revision+1 → 200 {revision, updatedAt}
       否则 → 409 {revision, updatedAt}（客户端拉取后自行决定采用云端或强制覆盖）
   - 强制覆盖：body {base: "force", data}，绕过冲突检测（客户端在用户明确选择后调用）
   同步码即唯一凭据（随机 15 位），KV 键 sync:<code>。
   KV 绑定 SYNC 在 wrangler.toml（pages 模式）声明，wrangler pages deploy 时应用。 */

const json = (obj, status = 200) => Response.json(obj, { status });

function checkCode(request) {
  const code = String(request.headers.get('X-Sync-Code') || '').trim();
  if (!/^WTE-[A-Z0-9]{15}$/.test(code)) return null;
  return code;
}

export async function onRequestGet({ request, env }) {
  const code = checkCode(request);
  if (!code) return json({ error: 'bad code' }, 400);
  const raw = await env.SYNC.get(`sync:${code}`);
  if (!raw) return json({ error: 'empty' }, 404);
  const stored = JSON.parse(raw);
  return json({ revision: stored.revision, data: stored.data, updatedAt: stored.updatedAt });
}

export async function onRequestPut({ request, env }) {
  const code = checkCode(request);
  if (!code) return json({ error: 'bad code' }, 400);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  const data = body && body.data;
  if (!data || typeof data !== 'object' || !Array.isArray(data.items) || !Array.isArray(data.windows)) {
    return json({ error: 'bad data' }, 400);
  }
  // 载荷上限 1MB（个人菜单远小于此，防御异常体）
  if (JSON.stringify(data).length > 1024 * 1024) return json({ error: 'too large' }, 413);

  const raw = await env.SYNC.get(`sync:${code}`);
  const stored = raw ? JSON.parse(raw) : null;
  const serverRev = stored ? stored.revision : 0;
  const base = body.base;

  if (base !== 'force' && Number(base) !== serverRev) {
    return json({ error: 'conflict', revision: serverRev, updatedAt: stored ? stored.updatedAt : null }, 409);
  }

  const revision = serverRev + 1;
  const updatedAt = Date.now();
  await env.SYNC.put(`sync:${code}`, JSON.stringify({ revision, data, updatedAt }));
  return json({ revision, updatedAt });
}
