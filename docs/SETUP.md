# 部署教程（从零到能用，约 15 分钟）

本项目是**纯前端单页应用**：不需要服务器、不需要编译、不需要 Node 环境跑起来。
你只需要一个能存数据的云后端 + 一个能放静态页面的地方。

---

## 一、准备云数据库（WorkBuddy 云服务）

本项目用 **WorkBuddy 云服务**（Serverless PostgreSQL + PostgREST）作后端，免费、无需运维。

### 1. 创建云服务应用

在 WorkBuddy 对话中提出需求，例如：

> 我要做一个演讲比赛评分系统，需要云数据库存活动/选手/评分数据

AI 助手会自动为你创建云服务应用，并在工作区生成 `.workbuddy/applications.yaml`：

```yaml
applications:
  - name: 演讲评分系统
    locator: wbapp_XXXXXXXXXXXXXXXX
```

### 2. 建表

把 `docs/schema.sql` 交给 AI 助手执行，或让助手按你的需求建表。四张表：

| 表 | 用途 |
|---|---|
| `events` | 活动（名称、评分维度、计分规则、状态） |
| `speakers` | 选手（序号、姓名、单位、分组） |
| `scores` | 评分（活动、选手、评委、各维度分数、留痕） |
| `app_config` | 全局配置（管理口令） |

> ⚠️ **关键坑**：PostgREST 场景下「建表」和「授权」是**两道独立的门**——
> 必须同时 `GRANT` 权限给 `anon`/`authenticated` 角色 **并且** 创建 RLS 策略，
> 只做其中一步会持续报 `42501 权限不足`。`schema.sql` 里两个都写好了。

### 3. 拿到连接凭据

建好后，你会得到两个值（AI 助手可直接读取）：

- **endpoint**：形如 `https://your-app-xxxxx.app.workbuddy.host`
- **publishableKey**：形如 `wbpk_xxxxxxxxxxxx`

把它们填进 `app.js` 顶部：

```js
const PUBLIC_CONFIG = {
  endpoint: 'https://your-app-xxxxx.app.workbuddy.host',
  publishableKey: 'wbpk_xxxxxxxxxxxx'
};
```

> **关于 publishableKey 的安全性**：它是**设计为公开**的前端公钥（和 Supabase 的 anon key 同理），
> 随前端代码暴露是正常的。真正的安全边界由数据库 RLS 策略控制。
> 本项目是「匿名可读写」场景（评委免登录扫码），因此策略全放行——
> 这意味着**任何知道链接的人都能读写数据**。内部比赛够用；
> 若用于公开场景，请自行收窄 RLS 策略（例如只允许 INSERT scores、禁止 DELETE）。

---

## 二、发布前端

### 方式 A：WorkBuddy 一键发布（推荐）

在 WorkBuddy 中让 AI 助手发布本项目目录，会自动得到分享链接，形如：

```
https://your-app-xxxxx.app.workbuddy.host/
```

发布后三个入口：

| 页面 | 地址 |
|---|---|
| 首页（活动列表） | `/` |
| 管理台 | `/#/admin?e=活动ID` |
| 评委端（扫码用） | `/#/judge?e=活动ID` |
| 大屏看板 | `/#/board?e=活动ID` |

### 方式 B：任意静态托管

本项目无构建步骤，`index.html` + `styles.css` + `app.js` + `vendor/` 四个东西
直接丢到任何静态托管（Nginx / 对象存储 / GitHub Pages / Vercel）即可，唯一要求是
**必须能通过 HTTPS 访问**（浏览器限制：HTTPS 页面不能请求 HTTP 接口）。

> 不要用 `file://` 直接双击打开——那样没有域名，跨域请求会被浏览器拦掉。

---

## 三、开始使用

1. 打开首页 → 点「＋ 新建活动」
2. 进管理台（默认口令 **`admin888`**，进去后立刻改）
3. 配置评分维度（默认模板：主题内容 30 / 语言表达 30 / 台风仪表 20 / 时间控制 20）
4. 录入选手名单（格式 `项目名称,汇报人,汇报主题`，每行一位）
5. 录入评委名单（格式 `姓名,单位`，每行一位）——可选但推荐
6. 把活动状态改成「接收评分」
7. 把 `/#/judge?e=活动ID` 的二维码投出来，评委扫码打分
8. 大屏打开 `/#/board?e=活动ID` 实时看排名

---

## 四、常见问题

| 现象 | 原因 / 解决 |
|---|---|
| 页面一直「加载中」 | SDK 没加载 / endpoint 填错。检查 `vendor/workbuddy-cloud-sdk.global.js` 是否存在 |
| 报 `42501` | 建表时漏了 GRANT 或 RLS 策略（见上文「两道门」） |
| 报 `42P01` | 表还没建好，或表名写错 |
| 手机扫码打不开 | 必须用 HTTPS 域名访问，不能是 `file://` 或局域网 IP |
| 扫码后落到首页 | 检查 URL 里是否带了 `#/judge?e=活动ID`（hash 路由） |
| 评委提交后管理台看不到 | 管理台切页签会自动刷新；若还看不到，看活动状态是否为「接收评分」 |
| Excel 打开 CSV 乱码 | 本项目导出的 CSV 已带 BOM，若自行改动请保留 BOM |

---

## 五、进阶：做多人协作与权限隔离

当前是「匿名全放行」模式，适合内部活动。若需更严格：

1. **收窄 RLS**：把 `anon` 的 DELETE 权限去掉，防止误删；
2. **接入登录**：WorkBuddy 云服务支持邮箱 / 手机验证码 / 微信登录，
   可把 `judge_name` 与登录用户绑定，彻底杜绝冒名；
3. **服务端校验**：把写入逻辑放到云函数，前端只提交，由服务端校验身份与数据合法性。

详见 WorkBuddy 云服务的认证文档。