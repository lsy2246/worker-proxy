# worker-proxy

一个基于 Cloudflare Worker 的路径式网页代理。它不绑定固定上游网站，通过一个可伪装的入口路径动态代理其他网站，并在默认模式下改写页面内链接，让页面资源、站内跳转、普通下载和基础 POST 表单提交继续经过 Worker。

## 功能

- 路径式代理：`/api/file/example.com/page?_key=你的密码`
- 支持完整协议路径：`/api/file/https://example.com/page?_key=你的密码`
- 无协议时默认使用 `https://`
- 支持 `_url=` 备用 query 入口
- 只把 `_key`、`_url`、`_headers`、`_mode`、`_disposition` 当成 Worker 参数
- 目标站自己的 `key`、`mode`、`url` 等普通参数会原样转发
- 默认 `_mode=page`，会改写 HTML 和 CSS 里的资源链接
- 支持 `GET`、`HEAD`、`POST` 和浏览器 CORS 预检 `OPTIONS`
- 支持基础 POST 表单提交和 POST 后返回文件下载
- 支持 `_mode=range`，可把完整资源转换为可 seek 的 Range 响应
- 支持 `_mode=inspect` 返回上游和缓存调试信息
- 支持 `_headers=` 临时指定上游请求头
- 支持 `_disposition=inline|attachment` 覆盖下载/预览行为
- 支持按地区、IP、HTTPS、缓存和文本替换规则进行配置
- 支持非入口路径返回 404、伪装 HTML 或跳转

## 本地准备

```bash
npm install
```

复制环境变量示例：

```bash
cp .dev.vars.example .dev.vars
```

然后修改 `.dev.vars`：

```env
PROXY_PASSWORD=换成你自己的强密码
```

如果把 `PROXY_PASSWORD` 留空，代理入口不会要求 `_key` 参数。

## 本地运行

```bash
npm run dev
```

访问网页：

```text
http://localhost:8787/api/file/example.com/?_key=你的密码
```

访问具体路径：

```text
http://localhost:8787/api/file/example.com/docs/page.html?_key=你的密码
```

使用完整协议：

```text
http://localhost:8787/api/file/https://example.com/docs/page.html?_key=你的密码
```

使用 `_url` 备用入口：

```text
http://localhost:8787/api/file?_key=你的密码&_url=https%3A%2F%2Fexample.com%2Fdocs%2Fpage.html
```

## 路由规则

默认入口路径是：

```js
const proxy_path = "/api/file";
```

入口后面的路径会被解析为目标 URL：

```text
/api/file/example.com/a       -> https://example.com/a
/api/file/https://x.com/a     -> https://x.com/a
/api/file/http://x.com/a      -> http://x.com/a
```

如果没有协议，默认补 `https://`。如果配置 `https = true`，显式 `http://` 目标仍会被拒绝。

非入口路径会走 fallback：

```js
const fallback_mode = "redirect"; // "404" | "html" | "redirect"
```

## Worker 参数

Worker 只消费这些单下划线参数：

- `_key`：鉴权密码
- `_url`：备用 query 形式目标地址
- `_headers`：发给上游的额外请求头 JSON
- `_mode`：代理模式
- `_disposition`：覆盖 `Content-Disposition`

其他 query 参数全部转发给目标站。例如：

```text
/api/file/example.com/search?q=test&key=abc&mode=list&_key=secret
```

实际代理到：

```text
https://example.com/search?q=test&key=abc&mode=list
```

## 代理模式

- `_mode=page`：默认。HTML 和 CSS 会改写资源链接，其他资源原样返回。
- `_mode=proxy`：普通透传，可按上游缓存头写入 Worker 缓存。
- `_mode=range`：完整拉取资源并按 Range 返回，适合部分视频/媒体 seek 场景。
- `_mode=inspect`：只返回 JSON 调试信息。

示例：

```text
/api/file/example.com/video.mp4?_key=secret&_mode=range
/api/file/example.com/file.zip?_key=secret&_disposition=attachment
/api/file/example.com/video.mp4?_key=secret&_mode=inspect
```

## 页面改写

默认 `_mode=page` 会改写：

- HTML 属性：`href`、`src`、`action`、`poster`、`data`
- HTML `srcset`
- `<meta http-equiv="refresh">`
- CSS `url(...)`
- CSS `@import`

不会改写：

- `#hash`
- `mailto:`
- `tel:`
- `javascript:`
- `data:`
- `blob:`

JavaScript 第一版不做深度解析。依赖复杂前端路由、WebSocket、Service Worker 或大量动态拼接 URL 的网站可能无法完整工作。

## POST 表单下载

代理入口支持 `POST`。页面里的表单 `action` 会被改写到代理入口，Worker 会把请求体和 `Content-Type` 转发给目标站。

适合：

- 导出 CSV/Excel
- 表单提交后下载文件
- 普通接口 POST 后返回 HTML 或文件

POST 不会写入 Worker 缓存。目标站登录态、CSRF、验证码等仍取决于原站逻辑，Worker 不负责托管登录会话。

## 上游请求头

可以用 `_headers` 补充或覆盖发给上游的请求头。参数值是 JSON，需要 URL 编码：

```js
const headers = encodeURIComponent(
  JSON.stringify({
    Referer: "https://movie.douban.com/",
    "User-Agent": "Mozilla/5.0 test",
    Accept: "image/webp,image/apng,image/*,*/*;q=0.8",
  }),
);

const proxyUrl = `http://localhost:8787/api/file/img3.doubanio.com/view/photo/demo.webp?_key=你的密码&_headers=${headers}`;
```

Worker 会过滤 `Connection`、`Transfer-Encoding` 等协议级请求头，并把 `Host` 改成目标站域名。对于网页代理，`Origin` 和 `Referer` 会尽量改成目标站对应地址。

## 配置说明

主要配置都在 `src/index.js` 顶部的“用户配置区”：

```js
const blocked_region = [];
const blocked_ip_address = [];
const https = true;
const disable_cache = false;
const replace_dict = {};
const proxy_path = "/api/file";
const fallback_mode = "redirect";
const fallback_html = "";
const fallback_redirect_url = "https://b.u.cd";
```

示例：换一个伪装入口：

```js
const proxy_path = "/assets/data";
```

访问：

```text
/assets/data/example.com/page?_key=secret
```

示例：其他路径返回伪装 HTML：

```js
const proxy_path = "/api/file";
const fallback_mode = "html";
const fallback_html = `<!doctype html><title>Welcome</title><main>Service is running.</main>`;
const fallback_redirect_url = "";
```

## 安全提醒

- 路径伪装只降低被扫描概率，不等于鉴权。
- 如果 `PROXY_PASSWORD` 为空，任何人都能使用代理。
- `_key=` 会出现在 URL、浏览器历史和访问日志中，不要公开分享带 `_key` 的链接。
- 默认只允许 HTTPS 目标。如果把 `https` 改成 `false`，才会允许 HTTP。
- 这个项目不会管理 Cookie 会话，也不会托管目标站登录态。
- Cloudflare Worker 有请求时长、响应大小、流量和滥用策略限制。

## 部署到 Cloudflare

登录 Cloudflare：

```bash
npx wrangler login
```

设置生产环境密码：

```bash
npx wrangler secret put PROXY_PASSWORD
```

部署：

```bash
npm run deploy
```

部署后使用：

```text
https://你的-worker.你的账号.workers.dev/api/file/example.com/?_key=你的密码
```

## 测试

```bash
npm test
```
