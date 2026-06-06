# Request-Driven Proxy Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add request-driven cache controls that let callers opt into Worker-managed proxy caching with explicit or inferred TTL while keeping default behavior conservative.

**Architecture:** Introduce a shared cache-policy parser and key builder that both proxy and media flows can use. Keep `mode=proxy` and `mode=media` response handling separate, but route both through a common cache decision layer so request semantics stay consistent.

**Tech Stack:** Cloudflare Worker runtime, Cache API, Node built-in test runner

---

### Task 1: Validate new cache parameters

**Files:**
- Modify: `src/index.js`
- Test: `test/download-proxy.test.js`

- [ ] **Step 1: Write the failing tests**

```js
test("rejects invalid cache_ttl values", async () => {
  const response = await worker.fetch(
    request("/download?key=secret&url=https%3A%2F%2Ffiles.example.com%2Fdemo.zip&cache_ttl=0"),
    env,
    {},
  );

  assert.equal(response.status, 400);
  assert.equal(await response.text(), "Invalid cache_ttl parameter");
});

test("rejects invalid cache_key_mode values", async () => {
  const response = await worker.fetch(
    request("/download?key=secret&url=https%3A%2F%2Ffiles.example.com%2Fdemo.zip&cache_key_mode=weird"),
    env,
    {},
  );

  assert.equal(response.status, 400);
  assert.equal(await response.text(), "Invalid cache_key_mode parameter");
});

test("requires cache_key for custom cache keys", async () => {
  const response = await worker.fetch(
    request("/download?key=secret&url=https%3A%2F%2Ffiles.example.com%2Fdemo.zip&cache_key_mode=custom"),
    env,
    {},
  );

  assert.equal(response.status, 400);
  assert.equal(await response.text(), "Missing cache_key parameter");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern "cache_ttl|cache_key_mode|cache_key"`
Expected: FAIL because the new parameters are not parsed yet.

- [ ] **Step 3: Write minimal implementation**

```js
const VALID_CACHE_KEY_MODES = new Set(["auto", "full", "ignore_search", "custom"]);

function parsePositiveInteger(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (!/^\d+$/.test(value)) {
    return { error: true };
  }

  const parsed = Number.parseInt(value, 10);
  return parsed > 0 ? parsed : { error: true };
}

function parseRequestOptions(url) {
  // existing fields...
  const cacheTtlValue = parsePositiveInteger(url.searchParams.get("cache_ttl"));
  const cacheKeyMode = (url.searchParams.get("cache_key_mode") || "auto").trim().toLowerCase();
  const cacheKey = url.searchParams.get("cache_key");

  if (cacheTtlValue?.error) {
    return { error: "Invalid cache_ttl parameter" };
  }

  if (!VALID_CACHE_KEY_MODES.has(cacheKeyMode)) {
    return { error: "Invalid cache_key_mode parameter" };
  }

  if (cacheKeyMode === "custom" && !cacheKey) {
    return { error: "Missing cache_key parameter" };
  }

  return {
    // existing fields...
    cache_ttl: cacheTtlValue,
    cache_key_mode: cacheKeyMode,
    cache_key: cacheKey,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern "cache_ttl|cache_key_mode|cache_key"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.js test/download-proxy.test.js
git commit -m "feat: parse request-driven proxy cache parameters"
```

### Task 2: Add proxy cache read/write with explicit TTL

**Files:**
- Modify: `src/index.js`
- Test: `test/download-proxy.test.js`

- [ ] **Step 1: Write the failing tests**

```js
test("stores proxy responses in Worker cache when cache=prefer and cache_ttl is provided", async () => {
  const restoreCache = installMockCache();
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;

  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response("cached-body", {
      headers: {
        "Content-Type": "image/jpeg",
      },
    });
  };

  try {
    const first = await worker.fetch(
      request("/download?key=secret&url=https%3A%2F%2Ffiles.example.com%2Fposter.jpg&cache=prefer&cache_ttl=300"),
      env,
      {},
    );
    const second = await worker.fetch(
      request("/download?key=secret&url=https%3A%2F%2Ffiles.example.com%2Fposter.jpg&cache=prefer&cache_ttl=300"),
      env,
      {},
    );

    assert.equal(await first.text(), "cached-body");
    assert.equal(await second.text(), "cached-body");
    assert.equal(second.headers.get("X-Proxy-Cache"), "hit");
    assert.equal(fetchCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
    restoreCache();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern "stores proxy responses in Worker cache"`
Expected: FAIL because proxy mode currently never reads or writes Worker cache.

- [ ] **Step 3: Write minimal implementation**

```js
const PROXY_CACHE_PATH = "/__proxy_cache__";

async function buildScopedCacheRequest(cachePath, requestUrl, resourceIdentity, extraHeaders) {
  const serializedHeaders = Object.entries(extraHeaders)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}:${value}`)
    .join("\n");
  const cacheKey = await hashText(`${resourceIdentity}\n${serializedHeaders}`);
  const cacheUrl = new URL(requestUrl.origin);
  cacheUrl.pathname = cachePath;
  cacheUrl.search = `?key=${cacheKey}`;
  return new Request(cacheUrl.toString(), { method: "GET" });
}

function applyManagedCacheHeaders(headers, ttl) {
  headers.set("Cache-Control", `public, max-age=${ttl}`);
}

async function handleProxyWithManagedCache(...) {
  // read Worker cache when cache=prefer
  // fetch upstream on miss
  // write cache when ttl resolves
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern "stores proxy responses in Worker cache"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.js test/download-proxy.test.js
git commit -m "feat: add managed cache for proxy mode"
```

### Task 3: Infer TTL from upstream headers and support refresh/off behavior

**Files:**
- Modify: `src/index.js`
- Test: `test/download-proxy.test.js`

- [ ] **Step 1: Write the failing tests**

```js
test("infers proxy cache ttl from upstream cache-control when cache_ttl is omitted", async () => {
  const restoreCache = installMockCache();
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;

  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response("ttl-body", {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=120",
      },
    });
  };

  try {
    await worker.fetch(
      request("/download?key=secret&url=https%3A%2F%2Ffiles.example.com%2Fttl.jpg&cache=prefer"),
      env,
      {},
    );
    const second = await worker.fetch(
      request("/download?key=secret&url=https%3A%2F%2Ffiles.example.com%2Fttl.jpg&cache=prefer"),
      env,
      {},
    );

    assert.equal(second.headers.get("X-Proxy-Cache"), "hit");
    assert.equal(fetchCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
    restoreCache();
  }
});

test("skips proxy cache storage when no ttl can be inferred", async () => {
  const restoreCache = installMockCache();
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;

  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response("no-ttl", {
      headers: {
        "Content-Type": "application/octet-stream",
      },
    });
  };

  try {
    const response = await worker.fetch(
      request("/download?key=secret&url=https%3A%2F%2Ffiles.example.com%2Fblob.bin&cache=prefer"),
      env,
      {},
    );

    assert.equal(response.headers.get("X-Proxy-Cache"), "store-skipped");
    assert.equal(fetchCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
    restoreCache();
  }
});

test("refresh overwrites proxy cache entries", async () => {
  const restoreCache = installMockCache();
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;

  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response(`version-${fetchCount}`, {
      headers: {
        "Content-Type": "image/jpeg",
      },
    });
  };

  try {
    await worker.fetch(
      request("/download?key=secret&url=https%3A%2F%2Ffiles.example.com%2Frefresh.jpg&cache=prefer&cache_ttl=300"),
      env,
      {},
    );

    const refreshed = await worker.fetch(
      request("/download?key=secret&url=https%3A%2F%2Ffiles.example.com%2Frefresh.jpg&cache=refresh&cache_ttl=300"),
      env,
      {},
    );

    assert.equal(await refreshed.text(), "version-2");
    assert.equal(refreshed.headers.get("X-Proxy-Cache"), "refresh");
  } finally {
    globalThis.fetch = originalFetch;
    restoreCache();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern "infers proxy cache ttl|skips proxy cache storage|refresh overwrites proxy cache"`
Expected: FAIL because TTL inference and refresh/off cache control are incomplete.

- [ ] **Step 3: Write minimal implementation**

```js
const MAX_MANAGED_CACHE_TTL = 31536000;

function resolveManagedCacheTtl(requestOptions, upstreamHeaders) {
  if (requestOptions.cache_ttl) {
    return Math.min(requestOptions.cache_ttl, MAX_MANAGED_CACHE_TTL);
  }

  const cacheControl = upstreamHeaders.get("Cache-Control") || "";
  const sMaxAgeMatch = /(?:^|,)\s*s-maxage=(\d+)/i.exec(cacheControl);
  const maxAgeMatch = /(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl);
  const expires = upstreamHeaders.get("Expires");
  const date = upstreamHeaders.get("Date");

  // parse and return first positive ttl
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern "infers proxy cache ttl|skips proxy cache storage|refresh overwrites proxy cache"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.js test/download-proxy.test.js
git commit -m "feat: infer proxy cache ttl from upstream metadata"
```

### Task 4: Respect cache key modes and keep media behavior green

**Files:**
- Modify: `src/index.js`
- Test: `test/download-proxy.test.js`

- [ ] **Step 1: Write the failing tests**

```js
test("reuses proxy cache entries when cache_key_mode=custom and cache_key matches", async () => {
  const restoreCache = installMockCache();
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;

  globalThis.fetch = async (url) => {
    fetchCount += 1;
    return new Response(`body-for-${url}`, {
      headers: {
        "Content-Type": "image/jpeg",
      },
    });
  };

  try {
    await worker.fetch(
      request("/download?key=secret&url=https%3A%2F%2Ffiles.example.com%2Fa.jpg&cache=prefer&cache_ttl=300&cache_key_mode=custom&cache_key=album-cover"),
      env,
      {},
    );
    const second = await worker.fetch(
      request("/download?key=secret&url=https%3A%2F%2Ffiles.example.com%2Fb.jpg&cache=prefer&cache_ttl=300&cache_key_mode=custom&cache_key=album-cover"),
      env,
      {},
    );

    assert.equal(second.headers.get("X-Proxy-Cache"), "hit");
    assert.equal(fetchCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
    restoreCache();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern "cache_key_mode=custom|cached media body"`
Expected: FAIL for custom key test while existing media tests remain green.

- [ ] **Step 3: Write minimal implementation**

```js
function resolveCacheResourceIdentity(targetUrl, requestOptions) {
  switch (requestOptions.cache_key_mode) {
    case "custom":
      return requestOptions.cache_key;
    case "ignore_search":
      return `${targetUrl.origin}${targetUrl.pathname}`;
    case "auto":
    case "full":
    default:
      return targetUrl.href;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern "cache_key_mode=custom|cached media body"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.js test/download-proxy.test.js
git commit -m "feat: support custom proxy cache keys"
```
