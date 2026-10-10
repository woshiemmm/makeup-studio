# 部署到 Cloudflare Pages（公网 + 可被搜索到）

按下面的顺序做一遍，你会得到一个 `https://xxx.pages.dev` 的公开网址，
并且能被百度 / Google 收录。

> ⚠️ **重要前提**：Cloudflare 官方文档明确说明 —— 使用 Functions 时
> **不支持在控制台拖拽上传（Direct Upload）**，必须用 **Git 集成** 或 **Wrangler 命令行**。
> 下面走 Git 集成（最省事、以后改代码自动重新部署）。
> 参考：<https://developers.cloudflare.com/pages/functions/get-started/>

---

## 第 0 步：确认文件结构

部署时 **`functions` 必须放在项目根目录**（不能放进 `dist`）：

```
你的项目/
├── index.html            ← 网站入口
├── styles.css
├── data.js  vision.js  app.js
├── favicon.svg
├── robots.txt
├── sitemap.xml
├── functions/            ← ★ Pages Functions，必须在根目录
│   └── api/
│       └── chat/
│           └── completions.js    →  路由 /api/chat/completions
├── tools/
│   └── gen-seo.js        ← 构建时生成静态正文（利于 SEO）
├── server.js  start.bat  ← 仅供本地使用，不会部署
└── README.md  DEPLOY.md
```

---

## 第 1 步：把代码传到 GitHub

1. 注册 / 登录 <https://github.com>
2. 新建一个仓库，例如 `makeup-studio`，**设为 Public**（Private 也能部署，但 Pages 免费额度同样可用）
3. 把本项目文件推上去：

```bash
cd 你的项目目录
git init
git add .
git commit -m "妆造教学网站"
git branch -M main
git remote add origin https://github.com/你的用户名/makeup-studio.git
git push -u origin main
```

> 注意：`start.bat` 里如果你填过 `DEEPSEEK_API_KEY`，**不要**推到 GitHub。
> 建议在仓库里加一个 `.gitignore` 忽略它，或者干脆别在 `start.bat` 里写 Key（本地用网页填写即可）。

---

## 第 2 步：创建 Cloudflare Pages 项目

1. 注册 / 登录 <https://dash.cloudflare.com>
2. 左侧选 **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
3. 授权并选择刚建的仓库
4. 填写构建设置：

| 设置项 | 填写内容 |
|---|---|
| Framework preset | `None` |
| Build command | `node tools/gen-seo.js && node tools/build.js` |
| Build output directory | `dist` |

> **为什么不手写 `cp` 列表**：以前是手写的文件清单，结果漏掉了 `store.js`，
> 部署上去整个应用会崩。现在改成 `tools/build.js`，它**从 `index.html` 的实际引用推导**
> 需要打包哪些文件，不会再漏。同时它会做两道检查：
> ① 引用到的文件必须真实存在；② `start.bat`、`server.js` 等本地专用文件
> **一旦试图打包就直接让构建失败**（`start.bat` 里可能填过 API Key，传上去就是泄露）。
>
> `gen-seo.js` 会把 8 种妆容和 8 个阶段的正文生成成静态 HTML 再打包，
> 这样搜索引擎抓到的是真正的文字内容，而不是空容器。改了 `data.js` 会自动同步。

5. 点 **Save and Deploy**，等 1～2 分钟。

---

## 第 3 步：配置环境变量（关键）

进入项目 → **Settings** → **Environment variables**，添加（Production 和 Preview 都加）：

| 变量名 | 类型 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | **Secret（加密）** | 必填。你的 DeepSeek API Key |
| `ACCESS_CODE` | Secret（加密） | 建议填。访问口令，防止陌生人盗刷你的额度 |
| `ALLOWED_ORIGIN` | 文本 | 建议填你的域名，如 `https://makeup-studio.pages.dev` |
| `ALLOWED_MODELS` | 文本 | 选填，默认 `deepseek-flash` |

> 注意：**不要**把 API Key 写进 `functions/api/chat/completions.js` 或前端任何文件里。
> 只放在这里，浏览器永远看不到它。

### 关于 `ACCESS_CODE` 的取舍（重要）

| | 不设 ACCESS_CODE | 设置 ACCESS_CODE |
|---|---|---|
| 访客能做 AI 识图 | ✅ 可以 | ❌ 需要口令 |
| 你的额度风险 | ⚠️ 可能被人刷爆 | ✅ 安全 |
| 教学图文 / 视频 | ✅ 所有人可用 | ✅ 所有人可用 |
| 演示模式识图 | ✅ 所有人可用 | ✅ 所有人可用 |

**推荐做法**：设一个口令。这样公网访客仍然能用完整的教学内容和本地配色分析，
只有你自己（或你给了口令的人）能调用 DeepSeek。前端已做处理 ——
口令不对时会**静默回退到本地分析**，不会给访客弹错误。

你拿到网址后，在网页「设置 → 访问口令」里填上同一个口令即可自用。

---

## 第 4 步：拿到网址后设置域名

部署成功后会得到一个网址，例如 `https://makeup-studio.pages.dev`。
在本地项目目录运行：

```bash
node set-domain.js https://makeup-studio.pages.dev
```

（Windows 也可以直接双击 `set-domain.bat`，按提示输入网址）

这会自动替换 `index.html`、`robots.txt`、`sitemap.xml` 里的 `__SITE_URL__` 占位符，
补全 canonical、og:url 和 sitemap 地址。**然后重新 push 一次触发部署**：

```bash
git add .
git commit -m "设置站点域名"
git push
```

> 之后若绑定了自定义域名，用新域名再跑一次 `set-domain.js` 即可。

---

## 第 5 步：提交给搜索引擎（这一步才叫「能被搜到」）

### Google

1. 打开 <https://search.google.com/search-console>
2. 添加资源 → 选「网址前缀」→ 填你的网址
3. 验证所有权（Cloudflare 域名可用 DNS 验证）
4. 左侧「站点地图」→ 提交 `https://你的域名/sitemap.xml`
5. 用「网址检查」输入首页地址，点「请求编入索引」

### 百度

1. 打开 <https://ziyuan.baidu.com>
2. 添加站点 → 验证（推荐 HTML 标签验证，把给的 meta 标签加到 `index.html` 的 `<head>` 里）
3. 「普通收录」→ sitemap → 提交 `https://你的域名/sitemap.xml`
4. 也可用「快速收录」提交首页

> 收录需要时间：Google 通常几天，百度可能 1～4 周。之后在搜索引擎里搜
> `site:你的域名` 就能看到收录情况。

---

## 第 6 步：验证清单

部署完成后逐项确认：

- [ ] 打开 `https://你的域名/` 页面正常显示
- [ ] `https://你的域名/robots.txt` 能访问，且 Sitemap 地址是完整网址
- [ ] `https://你的域名/sitemap.xml` 能访问，`<loc>` 是正确网址
- [ ] 查看网页源代码，能搜到「清透裸妆」「妆前准备」等中文正文（说明静态内容已生成）
- [ ] 查看源代码搜 `canonical`，确认已是真实域名而不是 `__SITE_URL__`
- [ ] 页面「设置」里选「本站服务器（Cloudflare 代理）」，点「测试连接」返回 ✅
- [ ] 上传一张图片测识别；未填口令时应显示「当前使用本地配色分析」而不是报错
- [ ] 页面源代码里 **搜不到** 你的 API Key（这是最关键的检查）

---

## 安全说明：网页上的「设置」页安全吗？

先说结论：**「设置」页是给每个访客自己用的本地配置，不是网站后台。**
任何人都能改它，但只能改到**他自己浏览器里**，影响不到你、也影响不到其他访客。

| 访客能改的 | 存在哪 | 对别人有影响吗 |
|---|---|---|
| 眼型 / 脸型 / 预算档位 / 显示开关 | 他自己浏览器的 localStorage | ❌ 没有 |
| 他自己的本地账号、我的妆容 | 他自己浏览器的 localStorage | ❌ 没有 |
| 他自己填的 API Key | 他自己浏览器（或他请求里） | ❌ 没有 |
| 供应商 / 接口地址 / 模型名 | 他自己浏览器 | ❌ 没有 |

**你的数据不在网页里。** 打开公网版网页，源码里找不到任何人的账号、妆容或密钥 ——
它们全部存在各自的浏览器本地。

### 真正需要防的是什么

公网版上唯一真正危险的，是**别人蹭你的 DeepSeek 额度**。

因为 `/api/chat/completions` 是公开可达的，它的保护全在服务端：

- ✅ **API Key 存在 Cloudflare 环境变量里**，浏览器永远看不到，改设置也偷不走
- ✅ **模型白名单**：改不了的，别人拿去也只能调 `deepseek-flash`
- ✅ **限流**：每 IP 每分钟上限
- ⚠️ **`ACCESS_CODE`**：这是最关键的一道门。**没设的话，任何人打开你的网站都能消耗你的额度。**

**所以务必在 Cloudflare 里设上 `ACCESS_CODE`。** 设了之后：
- 拿到口令的人（你自己）能用真 AI
- 其他访客会**静默回退到本地配色分析**，网站照常能用，只是识别精度低一些
- 你的额度不会被消耗

### 还有个坑：本地专用文件绝不能上传

`start.bat` 里如果按注释填过 `DEEPSEEK_API_KEY`，**一旦被部署到公网就是公开泄露**。

现在 `tools/build.js` 会拦截这种情况 —— 白名单只包含
`index.html / styles.css / data.js / vision.js / store.js / app.js / favicon.svg / robots.txt / sitemap.xml`，
其他文件一律不打包。另外 `.gitignore` 也排除了 `start.bat`。

### 三条建议

1. **必做**：Cloudflare 环境变量里设 `ACCESS_CODE`（随便一串字符），然后自己也填到网站「设置 → 访问口令」
2. **建议**：去 DeepSeek 平台给这个 Key **设置消费上限**，万一被蹭也有止损
3. **可选**：Cloudflare 控制台 → **Security → WAF → Rate limiting**，给 `/api/chat/completions` 再加一层限流

### 客户端加密锁有意义吗？

**没有。** 前端代码任何人都能改（浏览器 F12 就能改 localStorage），
所以"给设置页加密码"这类做法只是**安全表演**，挡不住真想动手的人。

正确的做法是前面说的：**把敏感操作放到服务端校验**。
本站就是这么做的 —— 真正的门槛（API Key、访问口令、限流）全在 Cloudflare Function 里。

---

## 常见问题

**部署后 AI 报「本站 API 代理不可用」**
说明 `functions` 没被识别。检查：① 目录确实在仓库根目录（不在 `dist` 里）；
② 是通过 Git 集成部署而不是拖拽上传；③ 环境变量已保存并重新部署过一次。

**构建失败，提示 `cp: cannot stat`**
说明某个文件名对不上。确认根目录确实有 `favicon.svg`、`robots.txt`、`sitemap.xml`。

**「测试连接」返回 403**
`ACCESS_CODE` 没填或填错，到「设置 → 访问口令」补上。

**返回 429**
触发了限流（每 IP 每分钟 20 次）。想更严格的限流，去 Cloudflare 控制台
**Security → WAF → Rate limiting rules** 加一条针对 `/api/chat/completions` 的规则。
也可以在 Pages 项目里绑定一个 KV 命名空间并命名为 `RATE_LIMIT_KV`，
函数会自动启用分布式限流。

**担心额度被刷**
除了 `ACCESS_CODE`，还可以在 DeepSeek 平台给 Key 设置用量上限，
并在 Cloudflare 上加 WAF 限流规则，双保险。

**只想部署静态版、不要 AI**
把 `functions` 目录删掉再部署即可。站点会自动使用演示模式，完全免费且无任何风险。
