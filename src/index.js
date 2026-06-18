// ==================== 用户配置区 ====================
// 禁止访问的地区。Cloudflare 会通过 cf-ipcountry 请求头传入两位国家/地区代码。
const blocked_region = [];

// 禁止访问的 IP。Cloudflare 会通过 cf-connecting-ip 请求头传入真实访客 IP。
const blocked_ip_address = [];

// 是否只允许 HTTPS 目标地址。true 表示 http:// 目标会被拒绝。
const https = true;

// 是否禁用缓存。true 会把响应头 Cache-Control 改成 no-store。
const disable_cache = false;

// 文本内容替换规则。只会处理文本响应，不会改 zip、exe、mp4、jpg 等二进制文件。
const replace_dict = {};

// 代理入口路径。建议改成不像代理服务的伪装路径，例如 /api/file、/assets/data。
const proxy_path = "/api/file";

// 其他路径处理方式：可选 "404"、"html"、"redirect"。
const fallback_mode = "redirect";

// fallback_mode = "html" 时返回这段 HTML。
const fallback_html = "";

// fallback_mode = "redirect" 时跳转到这个地址。
const fallback_redirect_url = "https://b.u.cd";
// ================== 用户配置区结束 ==================

const DEFAULT_CONFIG = {
  blocked_region,
  blocked_ip_address,
  https,
  disable_cache,
  replace_dict,
  proxy_path,
  fallback_mode,
  fallback_html,
  fallback_redirect_url,
};

const ALLOWED_METHODS = ["GET", "HEAD", "POST", "OPTIONS"];
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const RESERVED_QUERY_PARAMS = new Set(["_key", "_url", "_headers", "_mode", "_disposition"]);
const VALID_MODES = new Set(["page", "proxy", "range", "inspect"]);
const VALID_DISPOSITIONS = new Set(["inline", "attachment"]);
const PROXY_CACHE_PATH = "/__proxy_cache__";
const MAX_MANAGED_CACHE_TTL = 31536000;
const DEFAULT_RANGE_CACHE_TTL = 86400;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": ALLOWED_METHODS.join(", "),
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers": "Content-Disposition, Content-Length, Content-Range, Content-Type, Accept-Ranges",
};

function textResponse(message, status, extraHeaders = {}) {
  return new Response(message, {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function jsonResponse(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function htmlResponse(html) {
  return new Response(html, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function redirectResponse(url) {
  return new Response(null, {
    status: 302,
    headers: {
      ...CORS_HEADERS,
      Location: url,
      "Cache-Control": "no-store",
    },
  });
}

function normalizeConfig(config = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...config,
    blocked_region: config.blocked_region || DEFAULT_CONFIG.blocked_region,
    blocked_ip_address: config.blocked_ip_address || DEFAULT_CONFIG.blocked_ip_address,
    replace_dict: config.replace_dict || DEFAULT_CONFIG.replace_dict,
    proxy_path: normalizeProxyPath(
      config.proxy_path === undefined ? DEFAULT_CONFIG.proxy_path : config.proxy_path,
    ),
    fallback_mode: config.fallback_mode || DEFAULT_CONFIG.fallback_mode,
    fallback_html: config.fallback_html === undefined ? DEFAULT_CONFIG.fallback_html : config.fallback_html,
    fallback_redirect_url:
      config.fallback_redirect_url === undefined
        ? DEFAULT_CONFIG.fallback_redirect_url
        : config.fallback_redirect_url,
  };
}

function normalizeProxyPath(path) {
  if (!path || path === "/") {
    return DEFAULT_CONFIG.proxy_path;
  }

  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return normalizedPath.endsWith("/") && normalizedPath.length > 1
    ? normalizedPath.slice(0, -1)
    : normalizedPath;
}

function handleFallback(config) {
  if (config.fallback_mode === "html" && config.fallback_html) {
    return htmlResponse(config.fallback_html);
  }

  if (config.fallback_mode === "redirect" && config.fallback_redirect_url) {
    return redirectResponse(config.fallback_redirect_url);
  }

  return textResponse("Not Found", 404);
}

function matchesProxyPath(pathname, proxyPath) {
  return pathname === proxyPath || pathname.startsWith(`${proxyPath}/`);
}

function getProxyPathSuffix(pathname, proxyPath) {
  if (pathname === proxyPath) {
    return "";
  }

  return pathname.slice(proxyPath.length + 1);
}

function isAuthorized(url, env) {
  const password = (env.PROXY_PASSWORD || "").trim();

  if (!password) {
    return true;
  }

  return url.searchParams.get("_key") === password;
}

function isBlockedRequest(request, config) {
  const region = (request.headers.get("cf-ipcountry") || "").toUpperCase();
  const ipAddress = request.headers.get("cf-connecting-ip") || "";
  const blockedRegions = config.blocked_region.map((item) => item.toUpperCase());

  if (region && blockedRegions.includes(region)) {
    return "Access denied: region blocked";
  }

  if (ipAddress && config.blocked_ip_address.includes(ipAddress)) {
    return "Access denied: IP blocked";
  }

  return null;
}

function resolveRawTarget(requestUrl, config) {
  const pathSuffix = getProxyPathSuffix(requestUrl.pathname, config.proxy_path);

  if (pathSuffix) {
    return pathSuffix;
  }

  const queryTarget = requestUrl.searchParams.get("_url");
  if (queryTarget) {
    return queryTarget;
  }

  return null;
}

function parseTargetUrl(requestUrl, config) {
  const rawTarget = resolveRawTarget(requestUrl, config);

  if (!rawTarget) {
    return { error: "Missing target URL" };
  }

  const targetValue = /^https?:\/\//i.test(rawTarget) ? rawTarget : `https://${rawTarget}`;
  let targetUrl;

  try {
    targetUrl = new URL(targetValue);
  } catch {
    return { error: "Invalid target URL" };
  }

  if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
    return { error: "Only http and https URLs are allowed" };
  }

  if (config.https && targetUrl.protocol !== "https:") {
    return { error: "Only https URLs are allowed" };
  }

  for (const [name, value] of requestUrl.searchParams) {
    if (!RESERVED_QUERY_PARAMS.has(name)) {
      targetUrl.searchParams.append(name, value);
    }
  }

  return { targetUrl };
}

function parseUpstreamHeaders(value) {
  if (!value) {
    return { headers: {} };
  }

  let parsedHeaders;
  try {
    parsedHeaders = JSON.parse(value);
  } catch {
    return { error: "Invalid _headers parameter" };
  }

  if (!parsedHeaders || Array.isArray(parsedHeaders) || typeof parsedHeaders !== "object") {
    return { error: "Invalid _headers parameter" };
  }

  const headers = {};

  for (const [name, headerValue] of Object.entries(parsedHeaders)) {
    if (headerValue === undefined || headerValue === null) {
      continue;
    }

    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      continue;
    }

    try {
      new Headers({ [name]: String(headerValue) });
    } catch {
      return { error: "Invalid _headers parameter" };
    }

    headers[name] = String(headerValue);
  }

  return { headers };
}

function parseRequestOptions(url) {
  const mode = (url.searchParams.get("_mode") || "page").trim().toLowerCase();
  const dispositionValue = url.searchParams.get("_disposition");
  const disposition = dispositionValue ? dispositionValue.trim().toLowerCase() : null;

  if (!VALID_MODES.has(mode)) {
    return { error: "Invalid _mode parameter" };
  }

  if (disposition && !VALID_DISPOSITIONS.has(disposition)) {
    return { error: "Invalid _disposition parameter" };
  }

  return {
    mode,
    disposition,
    key: url.searchParams.get("_key") || "",
  };
}

function buildPreflightHeaders(request) {
  const headers = new Headers(CORS_HEADERS);
  const requestedHeaders = request.headers.get("Access-Control-Request-Headers");

  if (requestedHeaders) {
    headers.set("Access-Control-Allow-Headers", requestedHeaders);
  }

  return headers;
}

function buildUpstreamHeaders(request, targetUrl, extraHeaders = {}) {
  const headers = new Headers(request.headers);

  for (const name of HOP_BY_HOP_HEADERS) {
    headers.delete(name);
  }

  headers.delete("cf-connecting-ip");
  headers.delete("cf-ipcountry");
  headers.delete("cf-ray");
  headers.delete("x-forwarded-for");
  headers.delete("x-forwarded-proto");

  headers.set("Host", targetUrl.host);

  if (headers.has("Origin")) {
    headers.set("Origin", targetUrl.origin);
  }

  if (headers.has("Referer")) {
    headers.set("Referer", targetUrl.href);
  }

  for (const [name, value] of Object.entries(extraHeaders)) {
    if (value === undefined || value === null) {
      continue;
    }

    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      headers.set(name, String(value));
    }
  }

  return headers;
}

function setContentDisposition(headers, disposition) {
  if (!disposition) {
    return;
  }

  const currentValue = headers.get("Content-Disposition");

  if (!currentValue) {
    headers.set("Content-Disposition", disposition);
    return;
  }

  if (/^\s*(inline|attachment)\b/i.test(currentValue)) {
    headers.set(
      "Content-Disposition",
      currentValue.replace(/^\s*(inline|attachment)\b/i, disposition),
    );
    return;
  }

  headers.set("Content-Disposition", `${disposition}; ${currentValue}`);
}

function buildResponseHeaders(upstreamHeaders, config) {
  const headers = new Headers(CORS_HEADERS);

  for (const [name, value] of upstreamHeaders) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      headers.set(name, value);
    }
  }

  if (config.disable_cache) {
    headers.set("Cache-Control", "no-store");
  }

  return headers;
}

function setManagedCacheControl(headers, ttl, config) {
  if (config.disable_cache) {
    headers.set("Cache-Control", "no-store");
    return;
  }

  headers.set("Cache-Control", `public, max-age=${ttl}`);
}

function isTextResponse(headers) {
  const contentType = headers.get("Content-Type") || "";
  return (
    contentType.startsWith("text/") ||
    contentType.includes("json") ||
    contentType.includes("javascript") ||
    contentType.includes("xml")
  );
}

function isHtmlResponse(headers) {
  return (headers.get("Content-Type") || "").toLowerCase().includes("text/html");
}

function isCssResponse(headers) {
  const contentType = (headers.get("Content-Type") || "").toLowerCase();
  return contentType.includes("text/css");
}

function hasReplaceRules(replaceDict) {
  return Object.keys(replaceDict).length > 0;
}

function replaceText(text, replaceDict) {
  let replacedText = text;

  for (const [from, to] of Object.entries(replaceDict)) {
    replacedText = replacedText.replaceAll(from, to);
  }

  return replacedText;
}

function shouldSkipUrlRewrite(value) {
  const trimmedValue = value.trim();

  return (
    !trimmedValue ||
    trimmedValue.startsWith("#") ||
    /^(?:mailto|tel|javascript|data|blob):/i.test(trimmedValue)
  );
}

function escapeHtmlAttribute(value) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function buildProxyUrl(targetUrl, requestUrl, config, requestOptions) {
  const proxyUrl = new URL(requestUrl.origin);
  const targetPath =
    targetUrl.protocol === "https:"
      ? `${targetUrl.host}${targetUrl.pathname}`
      : `${targetUrl.protocol}//${targetUrl.host}${targetUrl.pathname}`;
  proxyUrl.pathname = `${config.proxy_path}/${targetPath}`;
  proxyUrl.search = targetUrl.search;

  if (requestOptions.key) {
    proxyUrl.searchParams.set("_key", requestOptions.key);
  }

  return `${proxyUrl.pathname}${proxyUrl.search}`;
}

function rewriteUrlValue(value, baseUrl, requestUrl, config, requestOptions, htmlAttribute = false) {
  if (shouldSkipUrlRewrite(value)) {
    return value;
  }

  let targetUrl;
  try {
    targetUrl = new URL(value, baseUrl.href);
  } catch {
    return value;
  }

  if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
    return value;
  }

  const rewrittenUrl = buildProxyUrl(targetUrl, requestUrl, config, requestOptions);
  return htmlAttribute ? escapeHtmlAttribute(rewrittenUrl) : rewrittenUrl;
}

function rewriteSrcset(value, baseUrl, requestUrl, config, requestOptions) {
  return value
    .split(",")
    .map((candidate) => {
      const trimmedCandidate = candidate.trim();
      if (!trimmedCandidate) {
        return candidate;
      }

      const parts = trimmedCandidate.split(/\s+/);
      parts[0] = rewriteUrlValue(parts[0], baseUrl, requestUrl, config, requestOptions, true);
      return parts.join(" ");
    })
    .join(", ");
}

function rewriteMetaRefresh(value, baseUrl, requestUrl, config, requestOptions) {
  return value.replace(/(\burl\s*=\s*)([^;]+)/i, (match, prefix, urlValue) => {
    const quote = /^['"]/.test(urlValue.trim()) ? urlValue.trim()[0] : "";
    const unquotedUrl = quote ? urlValue.trim().slice(1, -1) : urlValue.trim();
    const rewrittenUrl = rewriteUrlValue(unquotedUrl, baseUrl, requestUrl, config, requestOptions, false);
    return `${prefix}${quote}${rewrittenUrl}${quote}`;
  });
}

function rewriteHtml(html, baseUrl, requestUrl, config, requestOptions) {
  let rewrittenHtml = html.replace(
    /\b(href|src|action|poster|data)=("([^"]*)"|'([^']*)')/gi,
    (match, name, quotedValue, doubleValue, singleValue) => {
      const quote = quotedValue[0];
      const value = doubleValue ?? singleValue ?? "";
      const rewrittenValue = rewriteUrlValue(value, baseUrl, requestUrl, config, requestOptions, true);
      return `${name}=${quote}${rewrittenValue}${quote}`;
    },
  );

  rewrittenHtml = rewrittenHtml.replace(/\bsrcset=("([^"]*)"|'([^']*)')/gi, (match, quotedValue, doubleValue, singleValue) => {
    const quote = quotedValue[0];
    const value = doubleValue ?? singleValue ?? "";
    const rewrittenValue = rewriteSrcset(value, baseUrl, requestUrl, config, requestOptions);
    return `srcset=${quote}${rewrittenValue}${quote}`;
  });

  return rewrittenHtml.replace(
    /(<meta\b[^>]*http-equiv=["']?refresh["']?[^>]*content=)(["'])(.*?)\2/gi,
    (match, prefix, quote, value) => {
      const rewrittenValue = rewriteMetaRefresh(value, baseUrl, requestUrl, config, requestOptions);
      return `${prefix}${quote}${escapeHtmlAttribute(rewrittenValue)}${quote}`;
    },
  );
}

function rewriteCss(css, baseUrl, requestUrl, config, requestOptions) {
  let rewrittenCss = css.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")]*))\s*\)/gi, (match, doubleValue, singleValue, bareValue) => {
    const value = doubleValue ?? singleValue ?? bareValue ?? "";
    if (shouldSkipUrlRewrite(value)) {
      return match;
    }

    const quote = doubleValue !== undefined ? '"' : singleValue !== undefined ? "'" : '"';
    const rewrittenValue = rewriteUrlValue(value.trim(), baseUrl, requestUrl, config, requestOptions, false);
    return `url(${quote}${rewrittenValue}${quote})`;
  });

  rewrittenCss = rewrittenCss.replace(/@import\s+(?:"([^"]*)"|'([^']*)')/gi, (match, doubleValue, singleValue) => {
    const quote = doubleValue !== undefined ? '"' : "'";
    const value = doubleValue ?? singleValue ?? "";
    const rewrittenValue = rewriteUrlValue(value, baseUrl, requestUrl, config, requestOptions, false);
    return `@import ${quote}${rewrittenValue}${quote}`;
  });

  return rewrittenCss;
}

async function buildPageResponse(upstreamResponse, request, targetUrl, requestOptions, config) {
  const headers = buildResponseHeaders(upstreamResponse.headers, config);

  if (isHtmlResponse(upstreamResponse.headers)) {
    let html = await upstreamResponse.text();
    html = rewriteHtml(html, targetUrl, new URL(request.url), config, requestOptions);
    headers.delete("Content-Length");

    return new Response(html, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers,
    });
  }

  if (isCssResponse(upstreamResponse.headers)) {
    let css = await upstreamResponse.text();
    css = rewriteCss(css, targetUrl, new URL(request.url), config, requestOptions);
    headers.delete("Content-Length");

    return new Response(css, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers,
    });
  }

  if (hasReplaceRules(config.replace_dict) && isTextResponse(upstreamResponse.headers)) {
    const text = await upstreamResponse.text();
    headers.delete("Content-Length");

    return new Response(replaceText(text, config.replace_dict), {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers,
    });
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}

function buildRangeResponseHeaders(upstreamHeaders, config, ttl = DEFAULT_RANGE_CACHE_TTL) {
  const headers = buildResponseHeaders(upstreamHeaders, config);
  headers.set("Accept-Ranges", "bytes");

  if (!config.disable_cache) {
    setManagedCacheControl(headers, ttl, config);
  }

  return headers;
}

function parseSingleRangeHeader(rangeHeader, totalLength) {
  if (!rangeHeader) {
    return { type: "full" };
  }

  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());

  if (!match) {
    return { type: "invalid" };
  }

  let start = match[1] === "" ? null : Number.parseInt(match[1], 10);
  let end = match[2] === "" ? null : Number.parseInt(match[2], 10);

  if (start === null && end === null) {
    return { type: "invalid" };
  }

  if (start === null) {
    const suffixLength = end ?? 0;
    start = Math.max(totalLength - suffixLength, 0);
    end = totalLength - 1;
  } else {
    end = end === null ? totalLength - 1 : Math.min(end, totalLength - 1);
  }

  if (start < 0 || start >= totalLength || start > end) {
    return { type: "invalid" };
  }

  return {
    type: "partial",
    start,
    end,
  };
}

function finalizeResponse(response, requestMethod, disposition, extraHeaders = {}) {
  const headers = new Headers(response.headers);
  setContentDisposition(headers, disposition);

  for (const [name, value] of Object.entries(extraHeaders)) {
    headers.set(name, value);
  }

  return new Response(requestMethod === "HEAD" ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function buildRangeNotSatisfiableResponse(totalLength, disposition) {
  const headers = new Headers(CORS_HEADERS);
  headers.set("Content-Range", `bytes */${totalLength}`);
  setContentDisposition(headers, disposition);

  return new Response(null, {
    status: 416,
    headers,
  });
}

function buildBufferedRangeResponse(buffer, upstreamHeaders, request, config, disposition, ttl = DEFAULT_RANGE_CACHE_TTL) {
  const totalLength = buffer.byteLength;
  const headers = buildRangeResponseHeaders(upstreamHeaders, config, ttl);
  const range = parseSingleRangeHeader(request.headers.get("Range"), totalLength);

  if (range.type === "invalid") {
    return buildRangeNotSatisfiableResponse(totalLength, disposition);
  }

  if (range.type === "full") {
    headers.set("Content-Length", String(totalLength));
    setContentDisposition(headers, disposition);

    return new Response(request.method === "HEAD" ? null : buffer.slice(0), {
      status: 200,
      headers,
    });
  }

  const partialBuffer = buffer.slice(range.start, range.end + 1);
  headers.set("Content-Length", String(partialBuffer.byteLength));
  headers.set("Content-Range", `bytes ${range.start}-${range.end}/${totalLength}`);
  setContentDisposition(headers, disposition);

  return new Response(request.method === "HEAD" ? null : partialBuffer, {
    status: 206,
    statusText: "Partial Content",
    headers,
  });
}

async function hashText(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (item) => item.toString(16).padStart(2, "0")).join("");
}

function serializeCacheHeaders(extraHeaders) {
  return Object.entries(extraHeaders)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}:${value}`)
    .join("\n");
}

async function buildScopedCacheRequest(cachePath, requestUrl, resourceIdentity, extraHeaders) {
  const serializedHeaders = serializeCacheHeaders(extraHeaders);
  const cacheKey = await hashText(`${resourceIdentity}\n${serializedHeaders}`);
  const cacheUrl = new URL(requestUrl.origin);
  cacheUrl.pathname = cachePath;
  cacheUrl.search = `?key=${cacheKey}`;

  return new Request(cacheUrl.toString(), {
    method: "GET",
  });
}

async function buildProxyCacheRequest(requestUrl, targetUrl, extraHeaders) {
  return buildScopedCacheRequest(PROXY_CACHE_PATH, requestUrl, targetUrl.href, extraHeaders);
}

function clampCacheTtl(ttl) {
  if (!Number.isFinite(ttl) || ttl <= 0) {
    return null;
  }

  return Math.min(ttl, MAX_MANAGED_CACHE_TTL);
}

function resolveUpstreamCacheTtl(upstreamHeaders) {
  const cacheControl = upstreamHeaders.get("Cache-Control") || "";

  if (/\b(?:no-store|no-cache|private)\b/i.test(cacheControl)) {
    return null;
  }

  const sMaxAgeMatch = /(?:^|,)\s*s-maxage=(\d+)/i.exec(cacheControl);
  if (sMaxAgeMatch) {
    return clampCacheTtl(Number.parseInt(sMaxAgeMatch[1], 10));
  }

  const maxAgeMatch = /(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl);
  if (maxAgeMatch) {
    return clampCacheTtl(Number.parseInt(maxAgeMatch[1], 10));
  }

  const expiresValue = upstreamHeaders.get("Expires");
  if (!expiresValue) {
    return null;
  }

  const expiresAt = Date.parse(expiresValue);
  if (Number.isNaN(expiresAt)) {
    return null;
  }

  const dateValue = upstreamHeaders.get("Date");
  const now = dateValue ? Date.parse(dateValue) : Date.now();
  if (Number.isNaN(now)) {
    return null;
  }

  return clampCacheTtl(Math.floor((expiresAt - now) / 1000));
}

function resolveRangeCacheTtl(upstreamHeaders) {
  return resolveUpstreamCacheTtl(upstreamHeaders) || DEFAULT_RANGE_CACHE_TTL;
}

function canUseManagedCache(config, request) {
  return !config.disable_cache && request.method === "GET";
}

function requestRequiresCacheRefresh(request) {
  const cacheControl = request.headers.get("Cache-Control") || "";
  const pragma = request.headers.get("Pragma") || "";

  return /\b(?:no-cache|max-age=0)\b/i.test(cacheControl) || /\bno-cache\b/i.test(pragma);
}

async function cacheResponseBody(cache, cacheRequest, response, ttl, config) {
  if (!cache || config.disable_cache || !ttl) {
    return;
  }

  const buffer = await response.clone().arrayBuffer();
  const headers = new Headers(response.headers);
  setManagedCacheControl(headers, ttl, config);
  headers.delete("Content-Range");
  headers.set("Content-Length", String(buffer.byteLength));

  await cache.put(
    cacheRequest,
    new Response(buffer.slice(0), {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
  );
}

function buildCacheLookupRequest(cacheRequest, originalRequest) {
  const headers = new Headers();
  const rangeHeader = originalRequest.headers.get("Range");

  if (rangeHeader) {
    headers.set("Range", rangeHeader);
  }

  return new Request(cacheRequest.url, {
    method: "GET",
    headers,
  });
}

function getDefaultCache() {
  return globalThis.caches?.default || null;
}

async function handleRange(request, targetUrl, extraHeaders, requestOptions, config) {
  const requestUrl = new URL(request.url);
  const cache = getDefaultCache();
  const managedCacheEnabled = canUseManagedCache(config, request);
  const shouldRefreshCache = requestRequiresCacheRefresh(request);
  const cacheRequest = managedCacheEnabled
    ? await buildProxyCacheRequest(requestUrl, targetUrl, extraHeaders)
    : null;

  if (managedCacheEnabled && !shouldRefreshCache && cache && cacheRequest) {
    const cachedResponse = await cache.match(buildCacheLookupRequest(cacheRequest, request));

    if (cachedResponse) {
      return finalizeResponse(cachedResponse, request.method, requestOptions.disposition, {
        "X-Proxy-Cache": "hit",
      });
    }
  }

  const upstreamHeaders = buildUpstreamHeaders(request, targetUrl, extraHeaders);
  const upstreamResponse = await fetch(targetUrl.href, {
    method: "GET",
    headers: upstreamHeaders,
    redirect: "follow",
  });

  if (upstreamResponse.status === 206) {
    return finalizeResponse(
      new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: buildResponseHeaders(upstreamResponse.headers, config),
      }),
      request.method,
      requestOptions.disposition,
      { "X-Proxy-Cache": "bypass" },
    );
  }

  const buffer = await upstreamResponse.arrayBuffer();
  const resolvedTtl = resolveRangeCacheTtl(upstreamResponse.headers);

  if (managedCacheEnabled && cache && cacheRequest && upstreamResponse.ok) {
    const headers = buildRangeResponseHeaders(upstreamResponse.headers, config, resolvedTtl);
    headers.delete("Content-Range");
    headers.set("Content-Length", String(buffer.byteLength));

    await cache.put(
      cacheRequest,
      new Response(buffer.slice(0), {
        status: 200,
        headers,
      }),
    );
  }

  const response = buildBufferedRangeResponse(
    buffer,
    upstreamResponse.headers,
    request,
    config,
    requestOptions.disposition,
    resolvedTtl,
  );

  return finalizeResponse(response, request.method, requestOptions.disposition, {
    "X-Proxy-Cache": managedCacheEnabled ? "miss" : "bypass",
  });
}

async function handleProxy(request, targetUrl, extraHeaders, requestOptions, config) {
  const requestUrl = new URL(request.url);
  const cache = getDefaultCache();
  const managedCacheEnabled = requestOptions.mode === "proxy" && canUseManagedCache(config, request);
  const shouldRefreshCache = requestRequiresCacheRefresh(request);
  const cacheRequest = managedCacheEnabled
    ? await buildProxyCacheRequest(requestUrl, targetUrl, extraHeaders)
    : null;

  if (managedCacheEnabled && !shouldRefreshCache && cache && cacheRequest) {
    const cachedResponse = await cache.match(cacheRequest);

    if (cachedResponse) {
      return finalizeResponse(cachedResponse, request.method, requestOptions.disposition, {
        "X-Proxy-Cache": "hit",
      });
    }
  }

  const fetchInit = {
    method: request.method,
    headers: buildUpstreamHeaders(request, targetUrl, extraHeaders),
    redirect: "follow",
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    fetchInit.body = request.body;
  }

  const upstreamResponse = await fetch(targetUrl.href, fetchInit);
  const proxyResponse = await buildPageResponse(upstreamResponse, request, targetUrl, requestOptions, config);

  if (!managedCacheEnabled || !proxyResponse.ok || !cache || !cacheRequest) {
    return finalizeResponse(proxyResponse, request.method, requestOptions.disposition, {
      "X-Proxy-Cache": managedCacheEnabled ? "store-skipped" : "bypass",
    });
  }

  const resolvedTtl = resolveUpstreamCacheTtl(upstreamResponse.headers);
  if (!resolvedTtl) {
    return finalizeResponse(proxyResponse, request.method, requestOptions.disposition, {
      "X-Proxy-Cache": "store-skipped",
    });
  }

  await cacheResponseBody(cache, cacheRequest, proxyResponse, resolvedTtl, config);

  return finalizeResponse(proxyResponse, request.method, requestOptions.disposition, {
    "X-Proxy-Cache": shouldRefreshCache ? "refresh" : "miss",
  });
}

async function fetchUpstreamMetadata(request, targetUrl, extraHeaders) {
  const headers = buildUpstreamHeaders(request, targetUrl, extraHeaders);
  headers.delete("Range");

  return fetch(targetUrl.href, {
    method: "HEAD",
    headers,
    redirect: "follow",
  });
}

async function handleInspect(request, targetUrl, extraHeaders, requestOptions, config) {
  const requestUrl = new URL(request.url);
  const cache = getDefaultCache();
  const cacheRequest = await buildProxyCacheRequest(requestUrl, targetUrl, extraHeaders);
  const cachedResponse = cache ? await cache.match(cacheRequest) : null;
  const upstreamResponse = await fetchUpstreamMetadata(request, targetUrl, extraHeaders);

  return jsonResponse({
    mode: requestOptions.mode,
    disposition: requestOptions.disposition,
    targetUrl: targetUrl.href,
    proxyCache: {
      key: cacheRequest.url,
      status: cache ? (cachedResponse ? "hit" : "miss") : "unavailable",
      enabled: !config.disable_cache,
    },
    upstream: {
      status: upstreamResponse.status,
      finalUrl: upstreamResponse.url,
      contentType: upstreamResponse.headers.get("Content-Type"),
      contentLength: upstreamResponse.headers.get("Content-Length"),
      contentDisposition: upstreamResponse.headers.get("Content-Disposition"),
      acceptRanges: upstreamResponse.headers.get("Accept-Ranges"),
      contentRange: upstreamResponse.headers.get("Content-Range"),
    },
  });
}

async function handleProxyEntry(request, env, config) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: buildPreflightHeaders(request),
    });
  }

  if (!ALLOWED_METHODS.includes(request.method)) {
    return textResponse("Method Not Allowed", 405, {
      Allow: ALLOWED_METHODS.join(", "),
    });
  }

  const blockedReason = isBlockedRequest(request, config);
  if (blockedReason) {
    return textResponse(blockedReason, 403);
  }

  const requestUrl = new URL(request.url);

  if (!isAuthorized(requestUrl, env)) {
    return textResponse("Unauthorized", 401);
  }

  const { targetUrl, error } = parseTargetUrl(requestUrl, config);
  if (error) {
    return textResponse(error, 400);
  }

  const { headers: extraHeaders, error: headersError } = parseUpstreamHeaders(requestUrl.searchParams.get("_headers"));
  if (headersError) {
    return textResponse(headersError, 400);
  }

  const {
    mode,
    disposition,
    key,
    error: optionsError,
  } = parseRequestOptions(requestUrl);
  if (optionsError) {
    return textResponse(optionsError, 400);
  }

  const requestOptions = {
    mode,
    disposition,
    key,
  };

  if (requestOptions.mode === "inspect") {
    return handleInspect(request, targetUrl, extraHeaders, requestOptions, config);
  }

  if (requestOptions.mode === "range") {
    return handleRange(request, targetUrl, extraHeaders, requestOptions, config);
  }

  return handleProxy(request, targetUrl, extraHeaders, requestOptions, config);
}

export function createWorker(config = {}) {
  const normalizedConfig = normalizeConfig(config);

  return {
    async fetch(request, env = {}) {
      const url = new URL(request.url);

      if (!matchesProxyPath(url.pathname, normalizedConfig.proxy_path)) {
        return handleFallback(normalizedConfig);
      }

      try {
        return await handleProxyEntry(request, env, normalizedConfig);
      } catch (error) {
        console.error("[worker] unhandled.fetch.error", {
          url: request.url,
          method: request.method,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        return textResponse("Upstream request failed", 502);
      }
    },
  };
}

export default createWorker();
