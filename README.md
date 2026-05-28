# worker-proxy

一个只做下载代理的 Cloudflare Worker。它不绑定固定上游网站，不区分手机/桌面访问，只通过密码保护 `/download` 入口，然后把指定的 `http` 或 `https` 文件地址流式转发回来。

## 功能

- `/download?url=...` 下载代理
- 支持 `GET`、`HEAD` 和浏览器 CORS 预检 `OPTIONS`
- 支持 `Range` 请求，下载器可以断点续传，前提是源站也支持
- 密码通过查询参数传递：`?key=你的密码`
- 保留常见下载响应头，例如 `Content-Type`、`Content-Length`、`Content-Disposition`、`Content-Range`
- 支持按地区、IP、HTTPS、缓存和文本替换规则进行配置

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
https://你的-worker.你的账号.workers.dev/download?key=你的密码&url=https%3A%2F%2Fexample.com%2Ffile.zip
```

## 安全提醒

- 不要把 `PROXY_PASSWORD` 写进 `src/index.js`。
- `key=` 方式方便，但密码可能进入浏览器历史和访问日志，请避免把带密码的链接公开分享。
- 默认只允许代理 `https` 地址。如果你把 `https` 改成 `false`，才会允许 `http` 地址。
- Cloudflare Worker 有请求时长、响应大小、流量和滥用策略限制，大文件下载是否稳定取决于源站、网络和你的 Cloudflare 账户限制。

## 测试

```bash
npm test
```
