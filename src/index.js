// ==================== 用户配置区 ====================
// 禁止访问的地区。Cloudflare 会通过 cf-ipcountry 请求头传入两位国家/地区代码。
const blocked_region = [];

// 禁止访问的 IP。Cloudflare 会通过 cf-connecting-ip 请求头传入真实访客 IP。
const blocked_ip_address = [];

// 是否只允许 HTTPS 下载地址。true 表示 http:// 下载链接会被拒绝。
const https = true;

// 是否禁用缓存。true 会把响应头 Cache-Control 改成 no-store。
const disable_cache = false;

// 文本内容替换规则。只会处理文本响应，不会改 zip、exe、mp4、jpg 等二进制文件。
const replace_dict = {};

// 下载接口路径。留空或填写 "/" 时，默认使用 /download。
const download_path = "/download";

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
  download_path,
  fallback_mode,
  fallback_html,
  fallback_redirect_url,
};

const ALLOWED_METHODS = ["GET", "HEAD", "OPTIONS"];
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

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": ALLOWED_METHODS.join(", "),
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers": "Content-Disposition, Content-Length, Content-Range, Content-Type, Accept-Ranges",
};

const VALID_MODES = new Set(["proxy", "media", "inspect"]);
const VALID_CACHE_STRATEGIES = new Set(["prefer", "bypass", "refresh"]);
const VALID_DISPOSITIONS = new Set(["inline", "attachment"]);
const MEDIA_CACHE_PATH = "/__media_cache__";

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

function isAuthorized(url, env) {
  const password = (env.PROXY_PASSWORD || "").trim();

  if (!password) {
    return true;
  }

  return url.searchParams.get("key") === password;
}

function normalizeConfig(config = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...config,
    blocked_region: config.blocked_region || DEFAULT_CONFIG.blocked_region,
    blocked_ip_address: config.blocked_ip_address || DEFAULT_CONFIG.blocked_ip_address,
    replace_dict: config.replace_dict || DEFAULT_CONFIG.replace_dict,
    download_path: normalizeDownloadPath(
      config.download_path === undefined ? DEFAULT_CONFIG.download_path : config.download_path,
    ),
    fallback_mode: config.fallback_mode || DEFAULT_CONFIG.fallback_mode,
    fallback_html: config.fallback_html === undefined ? DEFAULT_CONFIG.fallback_html : config.fallback_html,
    fallback_redirect_url:
      config.fallback_redirect_url === undefined
        ? DEFAULT_CONFIG.fallback_redirect_url
        : config.fallback_redirect_url,
  };
}

function normalizeDownloadPath(path) {
  if (!path || path === "/") {
    return "/download";
  }

  return path.startsWith("/") ? path : `/${path}`;
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

function parseDownloadUrl(value, config) {
  if (!value) {
    return { error: "Missing url parameter" };
  }

  let targetUrl;
  try {
    targetUrl = new URL(value);
  } catch {
    return { error: "Invalid url parameter" };
  }

  if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
    return { error: "Only http and https URLs are allowed" };
  }

  if (config.https && targetUrl.protocol !== "https:") {
    return { error: "Only https URLs are allowed" };
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
    return { error: "Invalid headers parameter" };
  }

  if (!parsedHeaders || Array.isArray(parsedHeaders) || typeof parsedHeaders !== "object") {
    return { error: "Invalid headers parameter" };
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
      return { error: "Invalid headers parameter" };
    }

    headers[name] = String(headerValue);
  }

  return { headers };
}

function parseRequestOptions(url) {
  const mode = (url.searchParams.get("mode") || "proxy").trim().toLowerCase();
  const cache = (url.searchParams.get("cache") || "prefer").trim().toLowerCase();
  const dispositionValue = url.searchParams.get("disposition");
  const disposition = dispositionValue ? dispositionValue.trim().toLowerCase() : null;

  if (!VALID_MODES.has(mode)) {
    return { error: "Invalid mode parameter" };
  }

  if (!VALID_CACHE_STRATEGIES.has(cache)) {
    return { error: "Invalid cache parameter" };
  }

  if (disposition && !VALID_DISPOSITIONS.has(disposition)) {
    return { error: "Invalid disposition parameter" };
  }

  return {
    mode,
    cache,
    disposition,
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

  // headers 查询参数用于临时补充源站需要的请求头，例如 Referer、User-Agent、Accept。
  for (const [name, value] of Object.entries(extraHeaders)) {
    if (value === undefined || value === null) {
      continue;
    }

    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      headers.set(name, String(value));
    }
  }

  headers.delete("cf-connecting-ip");
  headers.delete("cf-ipcountry");
  headers.delete("cf-ray");
  headers.delete("x-forwarded-for");
  headers.delete("x-forwarded-proto");
  headers.set("Host", targetUrl.host);

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

function isTextResponse(headers) {
  const contentType = headers.get("Content-Type") || "";
  return (
    contentType.startsWith("text/") ||
    contentType.includes("json") ||
    contentType.includes("javascript") ||
    contentType.includes("xml")
  );
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

async function buildProxyResponse(upstreamResponse, config) {
  const headers = buildResponseHeaders(upstreamResponse.headers, config);

  if (hasReplaceRules(config.replace_dict) && isTextResponse(upstreamResponse.headers)) {
    const text = await upstreamResponse.text();
    const replacedText = replaceText(text, config.replace_dict);
    headers.delete("Content-Length");

    return new Response(replacedText, {
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

function buildMediaHeaders(upstreamHeaders, config) {
  const headers = buildResponseHeaders(upstreamHeaders, config);
  headers.set("Accept-Ranges", "bytes");

  if (!config.disable_cache) {
    headers.set("Cache-Control", "public, max-age=86400");
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

function finalizeResponse(response, requestMethod, disposition) {
  const headers = new Headers(response.headers);
  setContentDisposition(headers, disposition);

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

function buildBufferedMediaResponse(buffer, upstreamHeaders, request, config, disposition) {
  const totalLength = buffer.byteLength;
  const headers = buildMediaHeaders(upstreamHeaders, config);
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

async function buildMediaCacheRequest(requestUrl, targetUrl, extraHeaders) {
  const serializedHeaders = Object.entries(extraHeaders)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}:${value}`)
    .join("\n");
  const cacheKey = await hashText(`${targetUrl.href}\n${serializedHeaders}`);
  const cacheUrl = new URL(requestUrl.origin);
  cacheUrl.pathname = MEDIA_CACHE_PATH;
  cacheUrl.search = `?key=${cacheKey}`;

  return new Request(cacheUrl.toString(), {
    method: "GET",
  });
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

async function fetchUpstreamMetadata(request, targetUrl, extraHeaders) {
  const headers = buildUpstreamHeaders(request, targetUrl, extraHeaders);
  headers.delete("Range");
  const headResponse = await fetch(targetUrl.href, {
    method: "HEAD",
    headers,
    redirect: "follow",
  });

  return headResponse;
}

async function handleInspect(request, targetUrl, extraHeaders, requestOptions, config) {
  const requestUrl = new URL(request.url);
  const cache = getDefaultCache();
  const cacheRequest = await buildMediaCacheRequest(requestUrl, targetUrl, extraHeaders);
  const cachedResponse = cache ? await cache.match(cacheRequest) : null;
  const upstreamResponse = await fetchUpstreamMetadata(request, targetUrl, extraHeaders);

  return jsonResponse({
    mode: requestOptions.mode,
    cache: requestOptions.cache,
    disposition: requestOptions.disposition,
    targetUrl: targetUrl.href,
    mediaCache: {
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

async function cacheMediaResponse(cache, cacheRequest, upstreamHeaders, buffer, config) {
  if (!cache || config.disable_cache) {
    return;
  }

  const headers = buildMediaHeaders(upstreamHeaders, config);
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

async function handleMedia(request, targetUrl, extraHeaders, requestOptions, config) {
  const requestUrl = new URL(request.url);
  const cache = getDefaultCache();
  const cacheRequest = await buildMediaCacheRequest(requestUrl, targetUrl, extraHeaders);

  if (!config.disable_cache && requestOptions.cache === "prefer" && cache) {
    const cachedResponse = await cache.match(buildCacheLookupRequest(cacheRequest, request));

    if (cachedResponse) {
      return finalizeResponse(cachedResponse, request.method, requestOptions.disposition);
    }
  }

  const upstreamHeaders = buildUpstreamHeaders(request, targetUrl, extraHeaders);
  upstreamHeaders.delete("Range");
  const upstreamResponse = await fetch(targetUrl.href, {
    method: "GET",
    headers: upstreamHeaders,
    redirect: "follow",
  });

  if (!upstreamResponse.ok) {
    return buildProxyResponse(upstreamResponse, config);
  }

  const buffer = await upstreamResponse.arrayBuffer();

  if (!config.disable_cache && requestOptions.cache !== "bypass" && cache) {
    await cacheMediaResponse(cache, cacheRequest, upstreamResponse.headers, buffer, config);
  }

  return buildBufferedMediaResponse(
    buffer,
    upstreamResponse.headers,
    request,
    config,
    requestOptions.disposition,
  );
}

async function handleDownload(request, env, config) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: buildPreflightHeaders(request),
    });
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
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

  const { targetUrl, error } = parseDownloadUrl(requestUrl.searchParams.get("url"), config);
  if (error) {
    return textResponse(error, 400);
  }

  const { headers: extraHeaders, error: headersError } = parseUpstreamHeaders(requestUrl.searchParams.get("headers"));
  if (headersError) {
    return textResponse(headersError, 400);
  }

  const { mode, cache, disposition, error: optionsError } = parseRequestOptions(requestUrl);
  if (optionsError) {
    return textResponse(optionsError, 400);
  }

  const requestOptions = {
    mode,
    cache,
    disposition,
  };

  if (requestOptions.mode === "inspect") {
    return handleInspect(request, targetUrl, extraHeaders, requestOptions, config);
  }

  if (requestOptions.mode === "media") {
    return handleMedia(request, targetUrl, extraHeaders, requestOptions, config);
  }

  const upstreamResponse = await fetch(targetUrl.href, {
    method: request.method,
    headers: buildUpstreamHeaders(request, targetUrl, extraHeaders),
    redirect: "follow",
  });

  const proxyResponse = await buildProxyResponse(upstreamResponse, config);
  return finalizeResponse(proxyResponse, request.method, requestOptions.disposition);
}

export function createWorker(config = {}) {
  const normalizedConfig = normalizeConfig(config);

  return {
    async fetch(request, env = {}) {
      const url = new URL(request.url);

      if (url.pathname !== normalizedConfig.download_path) {
        return handleFallback(normalizedConfig);
      }

      try {
        return await handleDownload(request, env, normalizedConfig);
      } catch (error) {
        return textResponse("Upstream request failed", 502);
      }
    },
  };
}

export default createWorker();
