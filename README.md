# worker-proxy

一个只做下载代理的 Cloudflare Worker。它不绑定固定上游网站，不区分手机/桌面访问，只通过密码保护 `/download` 入口，然后把指定的 `http` 或 `https` 文件地址代理回来。

## 功能

- `/download?url=...` 下载代理
- 支持 `GET`、`HEAD` 和浏览器 CORS 预检 `OPTIONS`
- 支持 `Range` 请求，下载器可以断点续传，前提是源站也支持
- 支持 `mode=proxy|media|inspect` 三种处理模式
- 支持请求驱动的代理缓存控制，例如 `cache=auto|off|prefer|refresh`
- 支持 `disposition=inline|attachment` 响应头覆盖
- `mode=media` 会把完整媒体拉到 Cloudflare Cache API，再由 Worker 自己提供可拖拽的 `206 Partial Content`
- `mode=inspect` 会返回 JSON 元数据，方便排查源站和缓存状态
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

## 请求参数

除了 `url`、`key` 和 `headers`，现在还支持下面几个可选参数：

- `mode`
  - `proxy`：默认值。透传上游响应，适合图片、普通文件、原本就支持 Range 的源站。
  - `media`：媒体模式。先完整拉取资源，再缓存为可 seek 的下载体，适合视频。
  - `inspect`：只返回 JSON，不返回文件内容，用来查看源站状态和缓存状态。
- `cache`
  - `auto`：默认值。偏保守。`mode=proxy` 不主动写 Worker 缓存，`mode=media` 保持现有媒体缓存行为。
  - `off`：完全跳过 Worker 管理的缓存。
  - `prefer`：优先读 Worker 缓存，未命中时拉取上游并尝试回填缓存。
  - `refresh`：忽略旧缓存，强制重新拉取并覆盖缓存。
  - `bypass`：兼容旧参数，等价于 `off`。
- `cache_ttl`
  - 传秒数，例如 `300`、`3600`、`2592000`。
  - 只在 Worker 管理的缓存启用时生效。
  - 不传时会自动从上游响应头推导 TTL。
- `cache_key_mode`
  - `auto`：默认值。当前实现等价于完整 URL。
  - `full`：按完整 URL 生成缓存键。
  - `ignore_search`：忽略查询参数，只按域名和路径生成缓存键。
  - `custom`：配合 `cache_key` 手动指定缓存资源身份。
- `cache_key`
  - 只有 `cache_key_mode=custom` 时需要。
- `disposition`
  - `inline`：尽量让浏览器直接打开。
  - `attachment`：尽量让浏览器按附件下载。

示例：普通透传

```text
/download?key=你的密码&url=https%3A%2F%2Fexample.com%2Ffile.zip
```

示例：视频拖拽模式

```text
/download?key=你的密码&url=https%3A%2F%2Fexample.com%2Fclip.mp4&mode=media
```

示例：给图片启用 30 天代理缓存

```text
/download?key=你的密码&url=https%3A%2F%2Fexample.com%2Fposter.jpg&cache=prefer&cache_ttl=2592000
```

示例：给清单接口启用 5 分钟代理缓存

```text
/download?key=你的密码&url=https%3A%2F%2Fexample.com%2Ffeed.json&cache=prefer&cache_ttl=300
```

示例：强制刷新媒体缓存

```text
/download?key=你的密码&url=https%3A%2F%2Fexample.com%2Fclip.mp4&mode=media&cache=refresh
```

示例：查看当前资源信息

```text
/download?key=你的密码&url=https%3A%2F%2Fexample.com%2Fclip.mp4&mode=inspect
```

示例：两个不同 URL 共用同一份缓存键

```text
/download?key=你的密码&url=https%3A%2F%2Fexample.com%2Fa.jpg&cache=prefer&cache_ttl=300&cache_key_mode=custom&cache_key=album-cover
```

示例：覆盖 `Content-Disposition`

```text
/download?key=你的密码&url=https%3A%2F%2Fexample.com%2Fdemo.bin&disposition=inline
```

## 媒体模式说明

`mode=media` 的目标不是“把浏览器的 `Range` 原样转发给上游”，而是“把原本不支持 seek 的上游资源，转换成浏览器可拖拽的 `206 Partial Content` 响应”。

处理流程是：

1. 浏览器首次请求媒体资源时，Worker 会先完整拉取上游文件。
2. Worker 会把完整响应写入 Cloudflare Cache API。
3. 当前请求会直接由 Worker 根据完整内容生成 `206` 或 `200` 响应。
4. 后续请求会优先命中 Cloudflare Cache，并继续支持 `Range` 拖拽。

注意事项：

- `mode=media` 首次请求的等待时间通常会比普通透传更长，因为它需要先拿到完整媒体。
- Cloudflare Cache API 是边缘缓存，不保证所有数据中心都已经预热。
- 如果你把 `disable_cache` 设为 `true`，媒体模式仍能工作，但每次都会重新拉取上游文件。
- 这个模式最适合“源站能整文件下载，但不能标准 Range seek”的视频源。

## 代理缓存说明

Worker 现在支持“请求驱动的代理缓存”：

- 不传缓存参数时，默认走 `cache=auto`，行为偏保守。
- 想缓存时，在请求里显式传 `cache=prefer` 或 `cache=refresh`。
- `cache_ttl` 传秒数时，用调用方指定的 TTL。
- 不传 `cache_ttl` 时，会尝试从上游 `Cache-Control` 或 `Expires` 推导。
- 如果 TTL 推导失败，普通 `mode=proxy` 会直接透传并跳过缓存写入。
- 返回头里会带 `X-Proxy-Cache: hit|miss|bypass|refresh|store-skipped`，方便排查是否真的命中了 Worker 缓存。

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
- `mode=media` 会在首次请求时完整拉取文件，更适合短视频、中等体积媒体，不适合无限制地代理超大文件。

## 测试

```bash
npm test
```
