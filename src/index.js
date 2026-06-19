// ==================== 用户配置区 ====================
// 禁止访问的地区。Cloudflare 会通过 cf-ipcountry 请求头传入两位国家/地区代码。
const blocked_region = [];

// 禁止访问的 IP。Cloudflare 会通过 cf-connecting-ip 请求头传入真实访客 IP。
const blocked_ip_address = [];

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

const RESERVED_QUERY_PARAMS = new Set(["_key", "_headers", "_mode", "_disposition"]);
const VALID_MODES = new Set(["page", "proxy", "range", "inspect"]);
const VALID_DISPOSITIONS = new Set(["inline", "attachment"]);
const BLOCKING_BROWSER_POLICY_HEADERS = [
  "Content-Security-Policy",
  "Content-Security-Policy-Report-Only",
  "X-Frame-Options",
  "Permissions-Policy",
];
const PROXY_CACHE_PATH = "/__proxy_cache__";
const LOCAL_COOKIE_PREFIX = "_pc_";
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
    if (/^https?%3a%2f%2f/i.test(pathSuffix)) {
      try {
        return decodeURIComponent(pathSuffix);
      } catch {
        return pathSuffix;
      }
    }

    return pathSuffix;
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

  for (const [name, value] of requestUrl.searchParams) {
    if (!RESERVED_QUERY_PARAMS.has(name)) {
      targetUrl.searchParams.append(name, value);
    }
  }

  return { targetUrl };
}

function buildRefererRecoveredRequest(request, config) {
  const requestUrl = new URL(request.url);
  const refererValue = request.headers.get("Referer");

  if (!refererValue) {
    return null;
  }

  let refererUrl;
  try {
    refererUrl = new URL(refererValue);
  } catch {
    return null;
  }

  if (refererUrl.origin !== requestUrl.origin || !matchesProxyPath(refererUrl.pathname, config.proxy_path)) {
    return null;
  }

  const { targetUrl, error } = parseTargetUrl(refererUrl, config);
  if (error) {
    return null;
  }

  const recoveredTargetUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, targetUrl.origin);
  const recoveredUrl = new URL(requestUrl.origin);
  const targetPath =
    recoveredTargetUrl.protocol === "https:"
      ? `${recoveredTargetUrl.host}${recoveredTargetUrl.pathname}`
      : `${recoveredTargetUrl.protocol}//${recoveredTargetUrl.host}${recoveredTargetUrl.pathname}`;

  recoveredUrl.pathname = `${config.proxy_path}/${targetPath}`;
  recoveredUrl.search = recoveredTargetUrl.search;

  const refererKey = refererUrl.searchParams.get("_key");
  if (refererKey && !recoveredUrl.searchParams.has("_key")) {
    recoveredUrl.searchParams.set("_key", refererKey);
  }

  return new Request(recoveredUrl.href, request);
}

function isTopLevelNavigationRequest(request) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return false;
  }

  const fetchMode = (request.headers.get("Sec-Fetch-Mode") || "").toLowerCase();
  const fetchDest = (request.headers.get("Sec-Fetch-Dest") || "").toLowerCase();

  return fetchMode === "navigate" || fetchDest === "document";
}

function buildSameOriginRedirectLocation(request) {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
}

function buildQueryProxyPathRecoveredRequest(request, config) {
  const requestUrl = new URL(request.url);

  for (const value of requestUrl.searchParams.values()) {
    if (!value || !matchesProxyPath(value, config.proxy_path)) {
      continue;
    }

    const proxyUrl = new URL(requestUrl.origin);
    proxyUrl.pathname = value;
    const { targetUrl, error } = parseTargetUrl(proxyUrl, config);
    if (error) {
      continue;
    }

    const recoveredTargetUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, targetUrl.origin);
    const recoveredUrl = new URL(requestUrl.origin);
    const targetPath =
      recoveredTargetUrl.protocol === "https:"
        ? `${recoveredTargetUrl.host}${recoveredTargetUrl.pathname}`
        : `${recoveredTargetUrl.protocol}//${recoveredTargetUrl.host}${recoveredTargetUrl.pathname}`;

    recoveredUrl.pathname = `${config.proxy_path}/${targetPath}`;
    recoveredUrl.search = recoveredTargetUrl.search;

    return new Request(recoveredUrl.href, request);
  }

  return null;
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

function encodeBase64Url(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value) {
  const paddedValue = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(paddedValue);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new TextDecoder().decode(bytes);
}

function parseCookieHeader(value) {
  const cookies = [];

  for (const part of (value || "").split(";")) {
    const trimmedPart = part.trim();
    if (!trimmedPart) {
      continue;
    }

    const separatorIndex = trimmedPart.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    cookies.push({
      name: trimmedPart.slice(0, separatorIndex).trim(),
      value: trimmedPart.slice(separatorIndex + 1),
    });
  }

  return cookies;
}

function splitSetCookieHeader(value) {
  if (!value) {
    return [];
  }

  return value.split(/,\s*(?=[^;,=\s]+=)/);
}

function getSetCookieHeaders(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }

  return splitSetCookieHeader(headers.get("Set-Cookie"));
}

function parseSetCookieHeader(value) {
  const parts = value.split(";");
  const [nameValue, ...attributeParts] = parts;
  const separatorIndex = nameValue.indexOf("=");

  if (separatorIndex <= 0) {
    return null;
  }

  const cookie = {
    name: nameValue.slice(0, separatorIndex).trim(),
    value: nameValue.slice(separatorIndex + 1),
    path: "/",
    domain: "",
    expires: "",
    maxAge: "",
    secure: false,
    httpOnly: false,
    sameSite: "",
  };

  for (const part of attributeParts) {
    const trimmedPart = part.trim();
    const attributeSeparatorIndex = trimmedPart.indexOf("=");
    const name = (attributeSeparatorIndex === -1 ? trimmedPart : trimmedPart.slice(0, attributeSeparatorIndex)).trim().toLowerCase();
    const attributeValue = attributeSeparatorIndex === -1 ? "" : trimmedPart.slice(attributeSeparatorIndex + 1).trim();

    if (name === "domain") {
      cookie.domain = attributeValue.toLowerCase().replace(/^\./, "");
    } else if (name === "path") {
      cookie.path = attributeValue || "/";
    } else if (name === "expires") {
      cookie.expires = attributeValue;
    } else if (name === "max-age") {
      cookie.maxAge = attributeValue;
    } else if (name === "secure") {
      cookie.secure = true;
    } else if (name === "httponly") {
      cookie.httpOnly = true;
    } else if (name === "samesite") {
      cookie.sameSite = attributeValue;
    }
  }

  return cookie;
}

function domainMatches(host, cookieDomain) {
  return host === cookieDomain || host.endsWith(`.${cookieDomain}`);
}

function pathMatches(pathname, cookiePath) {
  return pathname === cookiePath || pathname.startsWith(cookiePath.endsWith("/") ? cookiePath : `${cookiePath}/`);
}

function buildLocalCookieName(targetHost, cookieName) {
  return `${LOCAL_COOKIE_PREFIX}${encodeBase64Url(`${targetHost}|${cookieName}`).slice(0, 80)}`;
}

function encodeLocalCookiePayload(payload) {
  return encodeBase64Url(JSON.stringify(payload));
}

function decodeLocalCookiePayload(value) {
  try {
    const payload = JSON.parse(decodeBase64Url(value));
    if (!payload || typeof payload !== "object") {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

function buildUpstreamCookieHeader(request, targetUrl) {
  const cookies = [];

  for (const cookie of parseCookieHeader(request.headers.get("Cookie"))) {
    if (!cookie.name.startsWith(LOCAL_COOKIE_PREFIX)) {
      continue;
    }

    const payload = decodeLocalCookiePayload(cookie.value);
    if (!payload || !payload.name || payload.value === undefined || !payload.host) {
      continue;
    }

    const cookieDomain = String(payload.domain || payload.host).toLowerCase().replace(/^\./, "");
    const cookiePath = String(payload.path || "/");

    if (!domainMatches(targetUrl.hostname.toLowerCase(), cookieDomain) || !pathMatches(targetUrl.pathname || "/", cookiePath)) {
      continue;
    }

    cookies.push(`${payload.name}=${payload.value}`);
  }

  return cookies.join("; ");
}

function appendLocalSetCookies(headers, upstreamHeaders, targetUrl, config) {
  const setCookieHeaders = getSetCookieHeaders(upstreamHeaders);

  headers.delete("Set-Cookie");

  for (const setCookieValue of setCookieHeaders) {
    const upstreamCookie = parseSetCookieHeader(setCookieValue);
    if (!upstreamCookie) {
      continue;
    }

    if (upstreamCookie.domain && !domainMatches(targetUrl.hostname.toLowerCase(), upstreamCookie.domain)) {
      continue;
    }

    const payload = {
      host: targetUrl.hostname.toLowerCase(),
      domain: upstreamCookie.domain,
      path: upstreamCookie.path,
      name: upstreamCookie.name,
      value: upstreamCookie.value,
    };
    const cookieParts = [
      `${buildLocalCookieName(payload.host, payload.name)}=${encodeLocalCookiePayload(payload)}`,
      `Path=${config.proxy_path}`,
      "Secure",
    ];

    if (upstreamCookie.maxAge) {
      cookieParts.push(`Max-Age=${upstreamCookie.maxAge}`);
    } else if (upstreamCookie.expires) {
      cookieParts.push(`Expires=${upstreamCookie.expires}`);
    }

    if (upstreamCookie.httpOnly) {
      cookieParts.push("HttpOnly");
    }

    cookieParts.push(`SameSite=${upstreamCookie.sameSite || "Lax"}`);
    headers.append("Set-Cookie", cookieParts.join("; "));
  }
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

function resolveProxiedRefererTarget(request, config) {
  const requestUrl = new URL(request.url);
  const refererValue = request.headers.get("Referer");

  if (!refererValue) {
    return null;
  }

  try {
    const refererUrl = new URL(refererValue);
    if (refererUrl.origin !== requestUrl.origin || !matchesProxyPath(refererUrl.pathname, config.proxy_path)) {
      return null;
    }

    const { targetUrl } = parseTargetUrl(refererUrl, config);
    return targetUrl || null;
  } catch {
    return null;
  }
}

function isIpv4Address(hostname) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

function getApproximateSite(hostname) {
  const normalizedHost = hostname.toLowerCase().replace(/\.$/, "");
  if (!normalizedHost || normalizedHost === "localhost" || isIpv4Address(normalizedHost) || normalizedHost.includes(":")) {
    return normalizedHost;
  }

  const labels = normalizedHost.split(".").filter(Boolean);
  if (labels.length <= 2) {
    return normalizedHost;
  }

  return labels.slice(-2).join(".");
}

function getSecFetchSiteForTarget(refererTargetUrl, targetUrl) {
  if (!refererTargetUrl) {
    return null;
  }

  if (refererTargetUrl.origin === targetUrl.origin) {
    return "same-origin";
  }

  if (refererTargetUrl.protocol === targetUrl.protocol && getApproximateSite(refererTargetUrl.hostname) === getApproximateSite(targetUrl.hostname)) {
    return "same-site";
  }

  return "cross-site";
}

function buildUpstreamHeaders(request, targetUrl, extraHeaders = {}, config = DEFAULT_CONFIG) {
  const headers = new Headers(request.headers);
  const refererTargetUrl = resolveProxiedRefererTarget(request, config);

  for (const name of HOP_BY_HOP_HEADERS) {
    headers.delete(name);
  }

  headers.delete("cf-connecting-ip");
  headers.delete("cf-ipcountry");
  headers.delete("cf-ray");
  headers.delete("x-forwarded-for");
  headers.delete("x-forwarded-proto");

  headers.delete("Cookie");
  headers.set("Host", targetUrl.host);

  const upstreamCookieHeader = buildUpstreamCookieHeader(request, targetUrl);
  if (upstreamCookieHeader) {
    headers.set("Cookie", upstreamCookieHeader);
  }

  if (headers.has("Origin")) {
    headers.set("Origin", refererTargetUrl ? refererTargetUrl.origin : targetUrl.origin);
  }

  if (headers.has("Referer")) {
    headers.set("Referer", refererTargetUrl ? refererTargetUrl.href : targetUrl.href);
  }

  const secFetchSite = getSecFetchSiteForTarget(refererTargetUrl, targetUrl);
  if (secFetchSite && headers.has("Sec-Fetch-Site")) {
    headers.set("Sec-Fetch-Site", secFetchSite);
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

function buildResponseHeaders(upstreamHeaders, config, targetUrl = null) {
  const headers = new Headers(CORS_HEADERS);

  for (const [name, value] of upstreamHeaders) {
    const lowerName = name.toLowerCase();
    if (!HOP_BY_HOP_HEADERS.has(lowerName) && lowerName !== "set-cookie") {
      headers.set(name, value);
    }
  }

  for (const name of BLOCKING_BROWSER_POLICY_HEADERS) {
    headers.delete(name);
  }

  normalizeVaryHeader(headers);

  if (config.disable_cache) {
    headers.set("Cache-Control", "no-store");
  }

  if (targetUrl) {
    appendLocalSetCookies(headers, upstreamHeaders, targetUrl, config);
  }

  return headers;
}

function isRedirectStatus(status) {
  return status >= 300 && status < 400;
}

function buildUpstreamRedirectResponse(upstreamResponse, request, targetUrl, requestOptions, config) {
  const headers = buildResponseHeaders(upstreamResponse.headers, config, targetUrl);
  const location = upstreamResponse.headers.get("Location");

  if (location) {
    try {
      const redirectTarget = new URL(location, targetUrl.href);
      if (redirectTarget.protocol === "http:" || redirectTarget.protocol === "https:") {
        headers.set("Location", buildProxyUrl(redirectTarget, new URL(request.url), config, requestOptions));
      }
    } catch {
      headers.set("Location", location);
    }
  }

  headers.delete("Content-Length");

  return new Response(null, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}

function normalizeVaryHeader(headers) {
  const vary = headers.get("Vary");
  if (!vary) {
    return;
  }

  const keptValues = vary
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (keptValues.length === 0) {
    headers.delete("Vary");
    return;
  }

  headers.set("Vary", keptValues.join(", "));
}

function setNoTransformCacheControl(headers) {
  const cacheControl = headers.get("Cache-Control") || "";
  if (/\bno-transform\b/i.test(cacheControl)) {
    return;
  }

  headers.set("Cache-Control", cacheControl ? `${cacheControl}, no-transform` : "no-transform");
}

function applyPageResponseHeaders(headers) {
  setNoTransformCacheControl(headers);
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

function isJavaScriptResponse(headers) {
  const contentType = (headers.get("Content-Type") || "").toLowerCase();
  return (
    contentType.includes("javascript") ||
    contentType.includes("ecmascript") ||
    contentType.includes("text/jscript") ||
    contentType.includes("application/x-javascript")
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

function buildRuntimeScript(baseUrl, config, requestOptions) {
  return `<script data-worker-proxy-runtime>
(() => {
  const proxyOrigin = location.origin;
  const proxyPath = ${JSON.stringify(config.proxy_path)};
  const baseTargetUrl = ${JSON.stringify(baseUrl.href)};
  const proxyKey = ${JSON.stringify(requestOptions.key || "")};
  const skipPattern = /^(?:#|mailto:|tel:|javascript:|data:|blob:|about:)/i;

  function alreadyProxied(url) {
    return url.origin === proxyOrigin && (
      url.pathname === proxyPath ||
      url.pathname.startsWith(proxyPath + "/")
    );
  }

  function proxifyUrl(value) {
    if (typeof value !== "string" || !value || skipPattern.test(value)) {
      return value;
    }

    try {
      if (value === proxyPath || value.startsWith(proxyPath + "/")) {
        return value;
      }

      let target = new URL(value, baseTargetUrl);
      if (alreadyProxied(target)) {
        return value;
      }

      if (target.origin === proxyOrigin) {
        target = new URL(target.pathname + target.search + target.hash, baseTargetUrl);
      }

      if (target.protocol !== "http:" && target.protocol !== "https:") {
        return value;
      }

      const proxied = new URL(proxyOrigin);
      const targetPath = target.protocol === "https:"
        ? target.host + target.pathname
        : target.protocol + "//" + target.host + target.pathname;
      proxied.pathname = proxyPath + "/" + targetPath;
      proxied.search = target.search;
      if (proxyKey) {
        proxied.searchParams.set("_key", proxyKey);
      }
      return proxied.href;
    } catch {
      return value;
    }
  }

  function containsProxyPathHint(url) {
    const values = [];
    url.searchParams.forEach((value) => values.push(value));
    if (url.hash) {
      values.push(url.hash);
    }

    return values.some((value) => {
      if (!value) {
        return false;
      }

      if (value === proxyPath || value.startsWith(proxyPath + "/")) {
        return true;
      }

      try {
        const hintedUrl = new URL(value, proxyOrigin);
        return alreadyProxied(hintedUrl);
      } catch {
        return false;
      }
    });
  }

  function proxifyHistoryUrl(value) {
    if (typeof value !== "string" || !value || skipPattern.test(value)) {
      return value;
    }

    try {
      const target = new URL(value, location.href);
      if (alreadyProxied(target) || !containsProxyPathHint(target)) {
        return value;
      }

      return proxifyUrl(value);
    } catch {
      return value;
    }
  }

  const originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = function(input, init) {
      if (typeof input === "string") {
        return originalFetch.call(this, proxifyUrl(input), init);
      }

      if (input instanceof Request) {
        return originalFetch.call(this, new Request(proxifyUrl(input.url), input), init);
      }

      return originalFetch.call(this, input, init);
    };
  }

  const originalOpen = XMLHttpRequest && XMLHttpRequest.prototype.open;
  if (originalOpen) {
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      return originalOpen.call(this, method, proxifyUrl(url), ...rest);
    };
  }

  const originalSendBeacon = navigator.sendBeacon && navigator.sendBeacon.bind(navigator);
  if (originalSendBeacon) {
    navigator.sendBeacon = function(url, data) {
      return originalSendBeacon(proxifyUrl(url), data);
    };
  }

  const originalLocationAssign = location.assign && location.assign.bind(location);
  if (originalLocationAssign) {
    try {
      location.assign = function(url) {
        return originalLocationAssign(proxifyUrl(url));
      };
    } catch {}
  }

  const originalLocationReplace = location.replace && location.replace.bind(location);
  if (originalLocationReplace) {
    try {
      location.replace = function(url) {
        return originalLocationReplace(proxifyUrl(url));
      };
    } catch {}
  }

  const originalPushState = history.pushState && history.pushState.bind(history);
  if (originalPushState) {
    history.pushState = function(state, title, url) {
      return originalPushState(state, title, proxifyHistoryUrl(url));
    };
  }

  const originalReplaceState = history.replaceState && history.replaceState.bind(history);
  if (originalReplaceState) {
    history.replaceState = function(state, title, url) {
      return originalReplaceState(state, title, proxifyHistoryUrl(url));
    };
  }

  function proxifyFormAction(form) {
    if (!form || !form.action) {
      return;
    }

    form.action = proxifyUrl(form.action);
  }

  document.addEventListener("submit", (event) => {
    proxifyFormAction(event.target);
  }, true);

  const originalFormSubmit = HTMLFormElement && HTMLFormElement.prototype.submit;
  if (originalFormSubmit) {
    HTMLFormElement.prototype.submit = function() {
      proxifyFormAction(this);
      return originalFormSubmit.call(this);
    };
  }

  document.addEventListener("click", (event) => {
    const link = event.target && event.target.closest && event.target.closest("a[href]");
    if (!link || event.defaultPrevented || link.target || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }

    const proxiedHref = proxifyUrl(link.getAttribute("href"));
    if (proxiedHref !== link.getAttribute("href")) {
      link.href = proxiedHref;
    }
  }, true);
})();
</script>`;
}

function injectRuntimeScript(html, baseUrl, config, requestOptions) {
  const runtimeScript = buildRuntimeScript(baseUrl, config, requestOptions);

  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (match) => `${match}\n${runtimeScript}`);
  }

  if (/<html\b[^>]*>/i.test(html)) {
    return html.replace(/<html\b[^>]*>/i, (match) => `${match}\n${runtimeScript}`);
  }

  return `${runtimeScript}${html}`;
}

function removeBrowserPolicyMetaTags(html) {
  return html.replace(/<meta\b[^>]*>/gi, (tag) => {
    const httpEquivMatch = /\bhttp-equiv\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(tag);
    const httpEquiv = (httpEquivMatch?.[1] ?? httpEquivMatch?.[2] ?? httpEquivMatch?.[3] ?? "").toLowerCase();

    if (httpEquiv === "content-security-policy" || httpEquiv === "content-security-policy-report-only") {
      return "";
    }

    return tag;
  });
}

function rewriteHtml(html, baseUrl, requestUrl, config, requestOptions) {
  let rewrittenHtml = removeBrowserPolicyMetaTags(html).replace(
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

function rewriteJavaScriptStringUrl(quote, value, baseUrl, requestUrl, config, requestOptions) {
  const rewrittenValue = rewriteUrlValue(value, baseUrl, requestUrl, config, requestOptions, false);
  return `${quote}${rewrittenValue}${quote}`;
}

function rewriteJavaScript(js, baseUrl, requestUrl, config, requestOptions) {
  let rewrittenJs = js.replace(
    /\b(import\s*\(\s*)(["'])([^"']+)\2/g,
    (match, prefix, quote, value) => `${prefix}${rewriteJavaScriptStringUrl(quote, value, baseUrl, requestUrl, config, requestOptions)}`,
  );

  rewrittenJs = rewrittenJs.replace(
    /\b((?:import|export)\s+(?:[\s\S]*?\s+from\s*)?)(["'])([^"']+)\2/g,
    (match, prefix, quote, value) => `${prefix}${rewriteJavaScriptStringUrl(quote, value, baseUrl, requestUrl, config, requestOptions)}`,
  );

  rewrittenJs = rewrittenJs.replace(
    /\b(new\s+(?:Shared)?Worker\s*\(\s*)(["'])([^"']+)\2/g,
    (match, prefix, quote, value) => `${prefix}${rewriteJavaScriptStringUrl(quote, value, baseUrl, requestUrl, config, requestOptions)}`,
  );

  rewrittenJs = rewrittenJs.replace(
    /\b(new\s+URL\s*\(\s*)(["'])([^"']+)\2(\s*,\s*import\.meta\.url\s*\))/g,
    (match, prefix, quote, value, suffix) => `${prefix}${rewriteJavaScriptStringUrl(quote, value, baseUrl, requestUrl, config, requestOptions)}${suffix}`,
  );

  return rewrittenJs.replace(
    /\b((?:navigator\.)?serviceWorker\.register\s*\(\s*)(["'])([^"']+)\2/g,
    (match, prefix, quote, value) => `${prefix}${rewriteJavaScriptStringUrl(quote, value, baseUrl, requestUrl, config, requestOptions)}`,
  );
}

async function buildPageResponse(upstreamResponse, request, targetUrl, requestOptions, config) {
  const headers = buildResponseHeaders(upstreamResponse.headers, config, targetUrl);

  if (isHtmlResponse(upstreamResponse.headers)) {
    let html = await upstreamResponse.text();
    html = rewriteHtml(html, targetUrl, new URL(request.url), config, requestOptions);
    html = injectRuntimeScript(html, targetUrl, config, requestOptions);
    headers.delete("Content-Length");
    applyPageResponseHeaders(headers);

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

  if (isJavaScriptResponse(upstreamResponse.headers)) {
    let js = await upstreamResponse.text();
    js = rewriteJavaScript(js, targetUrl, new URL(request.url), config, requestOptions);

    if (hasReplaceRules(config.replace_dict)) {
      js = replaceText(js, config.replace_dict);
    }

    headers.delete("Content-Length");

    return new Response(js, {
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

function buildRangeResponseHeaders(upstreamHeaders, config, ttl = DEFAULT_RANGE_CACHE_TTL, targetUrl = null) {
  const headers = buildResponseHeaders(upstreamHeaders, config, targetUrl);
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

function buildBufferedRangeResponse(buffer, upstreamHeaders, request, config, disposition, ttl = DEFAULT_RANGE_CACHE_TTL, targetUrl = null) {
  const totalLength = buffer.byteLength;
  const headers = buildRangeResponseHeaders(upstreamHeaders, config, ttl, targetUrl);
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

  const upstreamHeaders = buildUpstreamHeaders(request, targetUrl, extraHeaders, config);
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
        headers: buildResponseHeaders(upstreamResponse.headers, config, targetUrl),
      }),
      request.method,
      requestOptions.disposition,
      { "X-Proxy-Cache": "bypass" },
    );
  }

  const buffer = await upstreamResponse.arrayBuffer();
  const resolvedTtl = resolveRangeCacheTtl(upstreamResponse.headers);

  if (managedCacheEnabled && cache && cacheRequest && upstreamResponse.ok) {
    const headers = buildRangeResponseHeaders(upstreamResponse.headers, config, resolvedTtl, targetUrl);
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
    targetUrl,
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
    headers: buildUpstreamHeaders(request, targetUrl, extraHeaders, config),
    redirect: "manual",
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    fetchInit.body = request.body;
  }

  const upstreamResponse = await fetch(targetUrl.href, fetchInit);
  if (isRedirectStatus(upstreamResponse.status)) {
    return finalizeResponse(
      buildUpstreamRedirectResponse(upstreamResponse, request, targetUrl, requestOptions, config),
      request.method,
      requestOptions.disposition,
      {
        "X-Proxy-Cache": "bypass",
      },
    );
  }

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

async function fetchUpstreamMetadata(request, targetUrl, extraHeaders, config) {
  const headers = buildUpstreamHeaders(request, targetUrl, extraHeaders, config);
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
  const upstreamResponse = await fetchUpstreamMetadata(request, targetUrl, extraHeaders, config);

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
      let proxyRequest = request;

      if (!matchesProxyPath(url.pathname, normalizedConfig.proxy_path)) {
        proxyRequest =
          buildRefererRecoveredRequest(request, normalizedConfig) ||
          buildQueryProxyPathRecoveredRequest(request, normalizedConfig);
        if (proxyRequest && isTopLevelNavigationRequest(request)) {
          return redirectResponse(buildSameOriginRedirectLocation(proxyRequest));
        }

        if (!proxyRequest) {
          return handleFallback(normalizedConfig);
        }
      }

      try {
        return await handleProxyEntry(proxyRequest, env, normalizedConfig);
      } catch (error) {
        console.error("[worker] unhandled.fetch.error", {
          url: proxyRequest.url,
          method: proxyRequest.method,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        return textResponse("Upstream request failed", 502);
      }
    },
  };
}

export default createWorker();
