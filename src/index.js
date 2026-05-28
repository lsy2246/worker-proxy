// ==================== 用户配置区 ====================
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
// ================== 用户配置区结束 ==================

const DEFAULT_CONFIG = {
  blocked_region,
  blocked_ip_address,
  https,
  disable_cache,
  replace_dict,
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
  "Access-Control-Allow-Headers": "Content-Type, Range",
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

function isAuthorized(url, env) {
  const password = env.PROXY_PASSWORD;

  if (!password) {
    return false;
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
  };
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

function buildUpstreamHeaders(request) {
  const headers = new Headers();
  const range = request.headers.get("Range");
  const userAgent = request.headers.get("User-Agent");

  if (range) {
    headers.set("Range", range);
  }

  if (userAgent) {
    headers.set("User-Agent", userAgent);
  }

  headers.set("Accept", request.headers.get("Accept") || "*/*");
  return headers;
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

async function handleDownload(request, env, config) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS,
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

  const upstreamResponse = await fetch(targetUrl.href, {
    method: request.method,
    headers: buildUpstreamHeaders(request),
    redirect: "follow",
  });

  return buildProxyResponse(upstreamResponse, config);
}

export function createWorker(config = {}) {
  const normalizedConfig = normalizeConfig(config);

  return {
    async fetch(request, env = {}) {
      const url = new URL(request.url);

      if (url.pathname !== "/download") {
        return textResponse("Not Found", 404);
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
