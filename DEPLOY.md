# 部署指南

本项目为纯静态站点（无构建步骤），把仓库根目录的全部文件原样上传即完成部署。已内置 PWA（manifest + Service Worker）：HTTPS 环境下手机可"添加到主屏幕"，离线也能打开。

## 推荐组合

- **主线路（国内日常使用）：腾讯云 EdgeOne Pages**——国内 CDN 节点直连快
- **代码托管 + 自动部署源：GitHub 仓库**（即本仓库）
- **备份线路（可选，需自有域名）：Cloudflare Pages**——免费额度最大，但国内直连不稳定
- **作品集正式入口：你自己的服务器**（见文末）

## 方案 A：EdgeOne Pages（推荐主线路）

1. 打开 [pages.edgeone.ai](https://pages.edgeone.ai)，用腾讯云账号登录
2. 选择「导入 Git 仓库」，授权 GitHub，选中本仓库
3. 构建配置全部留空（无构建），输出目录默认根目录，确认部署
4. 部署完成后获得 `xxx.edgeone.app` 地址（自动 HTTPS）
5. （可选）「自定义域名」中绑定自己的域名

此后每次 `git push` 自动重新部署。免费额度：500 次构建/月、Functions 20 万次/月（未来企业微信推送可复用），详见[官方额度说明](https://pages.edgeone.ai/zh/document/limits-and-quotas)。

> 不想连 Git 也可以：控制台「Pages Drop」直接把项目文件夹拖进去即上线。

## 方案 B：Cloudflare Pages（海外线路 / 备份）

1. [dash.cloudflare.com](https://dash.cloudflare.com) → Workers & Pages → Create → Pages → Connect to Git，选中本仓库
2. Framework preset 选 None，Build command 留空，输出目录 `/`
3. 部署后得到 `xxx.pages.dev`
4. **国内直连 `*.pages.dev` 基本不可用**：需在 Custom domains 绑定自有域名（CNAME 指向 `xxx.pages.dev`），且稳定性因地区而异——定位为海外访问线路或灾备

免费额度：静态带宽无限、500 次构建/月、Functions 10 万请求/天。

## 方案 C：自己的服务器

```bash
# 上传（按需替换路径与地址）
scp -r . user@your-server:/var/www/what-to-eat/
```

nginx 示例：

```nginx
server {
    # ... 已有配置 ...
    location /what-to-eat/ {
        alias /var/www/what-to-eat/;
        index index.html;
    }
}
```

## 重要：数据与域名的关系

所有数据（菜单、偏好、历史）保存在**当前浏览器对当前域名**的 localStorage 中：

- **换域名访问 = 一套全新数据**（EdgeOne 默认域名、自定义域名、localhost 各自独立）
- 换设备 / 换域名 / 清理浏览器数据前，先在「设置 → 导出数据」备份，再到新环境「从文件导入」
- 微信内置浏览器可用，但清微信缓存会丢数据，重要改动后建议导出一份

## 发布新版本检查清单

1. 改动提交并 push（EdgeOne / Cloudflare 自动部署）
2. 若改了静态资源清单，把 `sw.js` 里的 `CACHE` 版本号 +1（否则离线缓存最多滞后一次在线访问）
3. 手机端 PWA 重新打开一次即可拿到新版本（网络优先策略）
