# worker-proxy

一个只做下载代理的 Cloudflare Worker。它不绑定固定上游网站，不区分手机/桌面访问，只通过密码保护 `/download` 入口，然后把指定的 `http` 或 `https` 文件地址流式转发回来。

## 功能

- `/download?url=...` 下载代理
- 支持 `GET`、`HEAD` 和浏览器 CORS 预检 `OPTIONS`
- 支持 `Range` 请求，下载器可以断点续传，前提是源站也支持
- 密码通过查询参数传递：`?key=你的密码`
- 保留常见下载响应头，例如 `Content-Type`、`Content-Length`、`Content-Disposition`、`Content-Range`
- 转发访客请求头给目标站，适合需要 `Referer`、`User-Agent` 等请求头的资源
- 可以通过 `headers=` 参数临时指定发给目标站的请求头
- 支持按地区、IP、HTTPS、缓存和文本替换规则进行配置
- 支持自定义下载接口路径，并配置其他路径返回 404、伪装 HTML 或跳转

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

如果把 `PROXY_PASSWORD` 留空，下载接口不会要求 `key` 参数。

## 本地运行

```bash
npm run dev
```

浏览器或下载器访问：

```text
http://localhost:8787/download?key=你的密码&url=https%3A%2F%2Fexample.com%2Ffile.zip
```

其中 `url` 参数必须 URL 编码。浏览器控制台可以这样编码：

```js
encodeURIComponent("https://example.com/file.zip")
```

如果目标站需要指定请求头，可以额外传 `headers` 参数。`headers` 是一个 JSON 对象，也需要 URL 编码：

```js
const targetUrl = encodeURIComponent("https://img3.doubanio.com/view/photo/demo.webp");
const headers = encodeURIComponent(
  JSON.stringify({
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36",
    Referer: "https://movie.douban.com/",
    Accept: "image/webp,image/apng,image/*,*/*;q=0.8",
  }),
);

const proxyUrl = `http://localhost:8787/download?key=你的密码&url=${targetUrl}&headers=${headers}`;
```

请求头优先级是：先复制访问 Worker 时自带的请求头，再应用 `headers=` 里的请求头，最后把 `Host` 固定改成目标站域名。`Connection`、`Transfer-Encoding` 等协议级请求头不会转发。

## 配置说明

主要配置都在 `src/index.js` 顶部的“用户配置区”，每一项都有中文注释：

```js
// 禁止访问的地区。Cloudflare 会通过 cf-ipcountry 请求头传入两位国家/地区代码。
const blocked_region = [];

// 禁止访问的 IP。Cloudflare 会通过 cf-connecting-ip 请求头传入真实访客 IP。
const blocked_ip_address = [];

// 是否只允许 HTTPS 下载地址。true 表示 http:// 下载链接会被拒绝。
const https = true;

// 是否禁用缓存。true 会把响应头 Cache-Control 改成 no-store。
const disable_cache = true;

// 文本内容替换规则。只会处理文本响应，不会改 zip、exe、mp4、jpg 等二进制文件。
const replace_dict = {};

// 下载接口路径。留空或填写 "/" 时，默认使用 /download。
const download_path = "/download";

// 其他路径处理方式：可选 "404"、"html"、"redirect"。
const fallback_mode = "404";

// fallback_mode = "html" 时返回这段 HTML。
const fallback_html = "";

// fallback_mode = "redirect" 时跳转到这个地址。
const fallback_redirect_url = "";
```

示例：禁止中国大陆访问，并拦截一个指定 IP：

```js
const blocked_region = ["CN"];
const blocked_ip_address = ["203.0.113.10"];
```

示例：允许 `http://` 下载链接：

```js
const https = false;
```

示例：替换文本文件里的域名：

```js
const replace_dict = {
  "https://old.example.com": "https://new.example.com",
};
```

`replace_dict` 只适合文本内容，例如 `text/plain`、`text/html`、`application/json`、`application/javascript`、`application/xml`。压缩包、安装包、视频、图片这类二进制内容不会替换，避免文件损坏。

示例：默认下载接口，其他路径返回 404：

```js
const download_path = "/download";
const fallback_mode = "404";
```

示例：隐藏下载接口，其他路径返回伪装 HTML：

```js
const download_path = "/api/file";
const fallback_mode = "html";
const fallback_html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <title>Welcome</title>
  </head>
  <body>
    <h1>Welcome</h1>
    <p>Service is running.</p>
  </body>
</html>`;
const fallback_redirect_url = "";
```

这时访问路径是：

```text
/api/file?key=你的密码&url=https%3A%2F%2Fexample.com%2Ffile.zip
```

其他路径，例如 `/`、`/download`、`/anything`，都会返回 `fallback_html`。

示例：其他路径全部跳转到其他页面：

```js
const download_path = "/download";
const fallback_mode = "redirect";
const fallback_html = "";
const fallback_redirect_url = "https://example.com/";
```

路由优先级是：先匹配 `download_path`，不匹配时才执行 `fallback_mode`。如果 `download_path` 留空或写成 `/`，会自动回退为 `/download`，避免把下载接口和整站 fallback 混在一起。

## 部署到 Cloudflare

登录 Cloudflare：

```bash
npx wrangler login
```

设置生产环境密码：

```bash
npx wrangler secret put PROXY_PASSWORD
```

如果你在 Cloudflare Dashboard 里管理变量或密钥，`wrangler.toml` 里已经设置了 `keep_vars = true`，避免 `wrangler deploy` 覆盖 Dashboard 中已有的环境变量。

部署：

```bash
npm run deploy
```

部署后使用：

```text
https://你的-worker.你的账号.workers.dev/download?key=你的密码&url=https%3A%2F%2Fexample.com%2Ffile.zip
```

## 安全提醒

- 不要把 `PROXY_PASSWORD` 写进 `src/index.js`。
- 如果 `PROXY_PASSWORD` 为空，任何人都可以不带 `key` 使用下载代理。
- `key=` 方式方便，但密码可能进入浏览器历史和访问日志，请避免把带密码的链接公开分享。
- Worker 会尽量把访客请求头转发给目标站，也允许通过 `headers=` 指定额外请求头，但会过滤 `Connection`、`Transfer-Encoding` 等协议级请求头，并改写 `Host` 为目标站域名。
- 默认只允许代理 `https` 地址。如果你把 `https` 改成 `false`，才会允许 `http` 地址。
- Cloudflare Worker 有请求时长、响应大小、流量和滥用策略限制，大文件下载是否稳定取决于源站、网络和你的 Cloudflare 账户限制。

## 测试

```bash
npm test
```
