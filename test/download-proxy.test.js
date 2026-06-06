import assert from "node:assert/strict";
import test from "node:test";

import worker, { createWorker } from "../src/index.js";

const env = {
  PROXY_PASSWORD: "secret",
};

function request(path, init) {
  return new Request(`https://proxy.example.test${path}`, init);
}

function createRangeAwareCache() {
  const store = new Map();

  return {
    async put(requestOrUrl, response) {
      const key = typeof requestOrUrl === "string" ? requestOrUrl : requestOrUrl.url;
      const buffer = await response.clone().arrayBuffer();
      store.set(key, {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers(response.headers),
        buffer,
      });
    },
    async match(requestOrUrl) {
      const request =
        typeof requestOrUrl === "string" ? new Request(requestOrUrl) : requestOrUrl;
      const entry = store.get(request.url);

      if (!entry) {
        return undefined;
      }

      const rangeHeader = request.headers.get("Range");
      const totalLength = entry.buffer.byteLength;

      if (!rangeHeader) {
        return new Response(entry.buffer.slice(0), {
          status: entry.status,
          statusText: entry.statusText,
          headers: new Headers(entry.headers),
        });
      }

      const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
      if (!match) {
        return new Response(null, {
          status: 416,
          headers: {
            "Content-Range": `bytes */${totalLength}`,
          },
        });
      }

      let start = match[1] === "" ? null : Number.parseInt(match[1], 10);
      let end = match[2] === "" ? null : Number.parseInt(match[2], 10);

      if (start === null && end === null) {
        return new Response(null, {
          status: 416,
          headers: {
            "Content-Range": `bytes */${totalLength}`,
          },
        });
      }

      if (start === null) {
        const suffixLength = end ?? 0;
        start = Math.max(totalLength - suffixLength, 0);
        end = totalLength - 1;
      } else {
        end = end === null ? totalLength - 1 : Math.min(end, totalLength - 1);
      }

      if (start < 0 || start >= totalLength || start > end) {
        return new Response(null, {
          status: 416,
          headers: {
            "Content-Range": `bytes */${totalLength}`,
          },
        });
      }

      const partialBuffer = entry.buffer.slice(start, end + 1);
      const headers = new Headers(entry.headers);
      headers.set("Content-Length", String(partialBuffer.byteLength));
      headers.set("Content-Range", `bytes ${start}-${end}/${totalLength}`);

      return new Response(partialBuffer, {
        status: 206,
        statusText: "Partial Content",
        headers,
      });
    },
  };
}

function installMockCache() {
  const originalCaches = globalThis.caches;
  const cache = createRangeAwareCache();
  globalThis.caches = {
    default: cache,
  };

  return () => {
    globalThis.caches = originalCaches;
  };
}

test("requires the configured password", async () => {
  const response = await worker.fetch(
    request("/download?url=https%3A%2F%2Ffiles.example.com%2Fdemo.zip"),
    env,
    {},
  );

  assert.equal(response.status, 401);
  assert.equal(await response.text(), "Unauthorized");
});

test("allows requests without key when no password is configured", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(url, "https://files.example.com/demo.zip");
    return new Response("ok");
  };

  try {
    const response = await worker.fetch(
      request("/download?url=https%3A%2F%2Ffiles.example.com%2Fdemo.zip"),
      {
        PROXY_PASSWORD: "",
      },
      {},
    );

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("accepts password from the key query parameter and streams the upstream response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://files.example.com/demo.zip");
    assert.equal(init.method, "GET");

    return new Response("zip-body", {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": "8",
        "Content-Disposition": 'attachment; filename="demo.zip"',
      },
    });
  };

  try {
    const response = await worker.fetch(
      request("/download?key=secret&url=https%3A%2F%2Ffiles.example.com%2Fdemo.zip"),
      env,
      {},
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "application/zip");
    assert.equal(response.headers.get("Content-Length"), "8");
    assert.equal(response.headers.get("Content-Disposition"), 'attachment; filename="demo.zip"');
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(await response.text(), "zip-body");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("forwards incoming request headers to the upstream server", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const headers = init.headers;

    assert.equal(url, "https://files.example.com/demo.zip");
    assert.equal(headers.get("Host"), "files.example.com");
    assert.equal(headers.get("Referer"), "https://movie.douban.com/");
    assert.equal(headers.get("Origin"), "https://example.com");
    assert.equal(headers.get("Accept-Language"), "zh-CN,zh;q=0.9");
    assert.equal(headers.get("Cookie"), "session=abc");
    assert.equal(headers.get("Connection"), null);

    return new Response("ok");
  };

  try {
    const response = await worker.fetch(
      request("/download?key=secret&url=https%3A%2F%2Ffiles.example.com%2Fdemo.zip", {
        headers: {
          Referer: "https://movie.douban.com/",
          Origin: "https://example.com",
          "Accept-Language": "zh-CN,zh;q=0.9",
          Cookie: "session=abc",
          Connection: "keep-alive",
        },
      }),
      env,
      {},
    );

    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("applies upstream request headers from the headers query parameter", async () => {
  const extraHeaders = encodeURIComponent(
    JSON.stringify({
      Referer: "https://movie.douban.com/",
      "User-Agent": "Mozilla/5.0 test",
      Accept: "image/webp,image/apng,image/*,*/*;q=0.8",
    }),
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const headers = init.headers;

    assert.equal(url, "https://img3.doubanio.com/view/photo/demo.webp");
    assert.equal(headers.get("Host"), "img3.doubanio.com");
    assert.equal(headers.get("Referer"), "https://movie.douban.com/");
    assert.equal(headers.get("User-Agent"), "Mozilla/5.0 test");
    assert.equal(headers.get("Accept"), "image/webp,image/apng,image/*,*/*;q=0.8");
    assert.equal(headers.get("Accept-Language"), "zh-CN");

    return new Response("ok");
  };

  try {
    const response = await worker.fetch(
      request(
        `/download?key=secret&url=https%3A%2F%2Fimg3.doubanio.com%2Fview%2Fphoto%2Fdemo.webp&headers=${extraHeaders}`,
        {
          headers: {
            Referer: "https://example.com/",
            "Accept-Language": "zh-CN",
          },
        },
      ),
      env,
      {},
    );

    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects invalid upstream headers JSON", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("upstream fetch should not be called");
  };

  try {
    const response = await worker.fetch(
      request(
        "/download?key=secret&url=https%3A%2F%2Ffiles.example.com%2Fdemo.zip&headers=%7Bbad-json",
      ),
      env,
      {},
    );

    assert.equal(response.status, 400);
    assert.equal(await response.text(), "Invalid headers parameter");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects invalid upstream header names", async () => {
  const invalidHeaders = encodeURIComponent(
    JSON.stringify({
      "Bad Header": "value",
    }),
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("upstream fetch should not be called");
  };

  try {
    const response = await worker.fetch(
      request(
        `/download?key=secret&url=https%3A%2F%2Ffiles.example.com%2Fdemo.zip&headers=${invalidHeaders}`,
      ),
      env,
      {},
    );

    assert.equal(response.status, 400);
    assert.equal(await response.text(), "Invalid headers parameter");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects passwords sent through the authorization bearer header", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("upstream fetch should not be called");
  };

  try {
    const response = await worker.fetch(
      request("/download?url=https%3A%2F%2Ffiles.example.com%2Fdemo.zip", {
        headers: {
          Authorization: "Bearer secret",
        },
      }),
      env,
      {},
    );

    assert.equal(response.status, 401);
    assert.equal(await response.text(), "Unauthorized");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects non-http download URLs", async () => {
  const response = await worker.fetch(request("/download?key=secret&url=file%3A%2F%2Fetc%2Fpasswd"), env, {});

  assert.equal(response.status, 400);
  assert.equal(await response.text(), "Only http and https URLs are allowed");
});

test("rejects unsupported methods", async () => {
  const response = await worker.fetch(
    request("/download?key=secret&url=https%3A%2F%2Ffiles.example.com%2Fdemo.zip", {
      method: "POST",
    }),
    env,
    {},
  );

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("Allow"), "GET, HEAD, OPTIONS");
});

test("supports CORS preflight requests", async () => {
  const response = await worker.fetch(
    request("/download", {
      method: "OPTIONS",
    }),
    env,
    {},
  );

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(response.headers.get("Access-Control-Allow-Methods"), "GET, HEAD, OPTIONS");
});

test("serves configured fallback HTML for non-download paths", async () => {
  const configuredWorker = createWorker({
    fallback_mode: "html",
    fallback_html: "<!doctype html><title>Home</title><main>hello</main>",
    fallback_redirect_url: "https://example.com/",
  });

  const response = await configuredWorker.fetch(request("/anything"), env, {});

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "text/html; charset=utf-8");
  assert.equal(await response.text(), "<!doctype html><title>Home</title><main>hello</main>");
});

test("redirects non-download paths when fallback redirect is configured", async () => {
  const configuredWorker = createWorker({
    fallback_mode: "redirect",
    fallback_html: "",
    fallback_redirect_url: "https://example.com/",
  });

  const response = await configuredWorker.fetch(request("/anything"), env, {});

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), "https://example.com/");
});

test("keeps non-download paths as not found by default", async () => {
  const configuredWorker = createWorker({
    fallback_mode: "404",
    fallback_html: "<!doctype html><title>Hidden</title>",
    fallback_redirect_url: "https://example.com/",
  });

  const response = await configuredWorker.fetch(request("/anything"), env, {});

  assert.equal(response.status, 404);
  assert.equal(await response.text(), "Not Found");
});

test("keeps the download endpoint working when fallback HTML is configured", async () => {
  const configuredWorker = createWorker({
    fallback_mode: "html",
    fallback_html: "<!doctype html><title>Home</title>",
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("ok");

  try {
    const response = await configuredWorker.fetch(
      request("/download?key=secret&url=https%3A%2F%2Ffiles.example.com%2Fdemo.zip"),
      env,
      {},
    );

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uses a configured download path before applying fallback behavior", async () => {
  const configuredWorker = createWorker({
    download_path: "/api/file",
    fallback_mode: "html",
    fallback_html: "<!doctype html><title>Fallback</title>",
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(url, "https://files.example.com/demo.zip");
    return new Response("ok");
  };

  try {
    const downloadResponse = await configuredWorker.fetch(
      request("/api/file?key=secret&url=https%3A%2F%2Ffiles.example.com%2Fdemo.zip"),
      env,
      {},
    );
    const oldDownloadPathResponse = await configuredWorker.fetch(
      request("/download?key=secret&url=https%3A%2F%2Ffiles.example.com%2Fdemo.zip"),
      env,
      {},
    );

    assert.equal(downloadResponse.status, 200);
    assert.equal(await downloadResponse.text(), "ok");
    assert.equal(oldDownloadPathResponse.status, 200);
    assert.equal(await oldDownloadPathResponse.text(), "<!doctype html><title>Fallback</title>");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("falls back to the default download path when configured download path is empty or root", async () => {
  for (const configuredPath of ["", "/"]) {
    const configuredWorker = createWorker({
      download_path: configuredPath,
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("ok");

    try {
      const response = await configuredWorker.fetch(
        request("/download?key=secret&url=https%3A%2F%2Ffiles.example.com%2Fdemo.zip"),
        env,
        {},
      );

      assert.equal(response.status, 200);
      assert.equal(await response.text(), "ok");
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
});

test("blocks configured Cloudflare country codes", async () => {
  const configuredWorker = createWorker({
    blocked_region: ["CN"],
  });

  const response = await configuredWorker.fetch(
    request("/download?key=secret&url=https%3A%2F%2Ffiles.example.com%2Fdemo.zip", {
      headers: {
        "cf-ipcountry": "CN",
      },
    }),
    env,
    {},
  );

  assert.equal(response.status, 403);
  assert.equal(await response.text(), "Access denied: region blocked");
});

test("blocks configured client IP addresses", async () => {
  const configuredWorker = createWorker({
    blocked_ip_address: ["203.0.113.10"],
  });

  const response = await configuredWorker.fetch(
    request("/download?key=secret&url=https%3A%2F%2Ffiles.example.com%2Fdemo.zip", {
      headers: {
        "cf-connecting-ip": "203.0.113.10",
      },
    }),
    env,
    {},
  );

  assert.equal(response.status, 403);
  assert.equal(await response.text(), "Access denied: IP blocked");
});

test("requires https target URLs when https is enabled", async () => {
  const configuredWorker = createWorker({
    https: true,
  });

  const response = await configuredWorker.fetch(
    request("/download?key=secret&url=http%3A%2F%2Ffiles.example.com%2Fdemo.zip"),
    env,
    {},
  );

  assert.equal(response.status, 400);
  assert.equal(await response.text(), "Only https URLs are allowed");
});

test("allows http target URLs when https is disabled", async () => {
  const configuredWorker = createWorker({
    https: false,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(url, "http://files.example.com/demo.zip");
    return new Response("ok");
  };

  try {
    const response = await configuredWorker.fetch(
      request("/download?key=secret&url=http%3A%2F%2Ffiles.example.com%2Fdemo.zip"),
      env,
      {},
    );

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("disables caching when disable_cache is enabled", async () => {
  const configuredWorker = createWorker({
    disable_cache: true,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("ok", {
      headers: {
        "Cache-Control": "public, max-age=3600",
      },
    });

  try {
    const response = await configuredWorker.fetch(
      request("/download?key=secret&url=https%3A%2F%2Ffiles.example.com%2Fdemo.zip"),
      env,
      {},
    );

    assert.equal(response.headers.get("Cache-Control"), "no-store");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("replaces text response content only when configured", async () => {
  const configuredWorker = createWorker({
    replace_dict: {
      "https://files.example.com": "https://proxy.example.test/download?url=https%3A%2F%2Ffiles.example.com",
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("open https://files.example.com/demo.zip", {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
      },
    });

  try {
    const response = await configuredWorker.fetch(
      request("/download?key=secret&url=https%3A%2F%2Ffiles.example.com%2Freadme.txt"),
      env,
      {},
    );

    assert.equal(
      await response.text(),
      "open https://proxy.example.test/download?url=https%3A%2F%2Ffiles.example.com/demo.zip",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not replace binary response content", async () => {
  const configuredWorker = createWorker({
    replace_dict: {
      "zip-body": "changed",
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("zip-body", {
      headers: {
        "Content-Type": "application/zip",
      },
    });

  try {
    const response = await configuredWorker.fetch(
      request("/download?key=secret&url=https%3A%2F%2Ffiles.example.com%2Fdemo.zip"),
      env,
      {},
    );

    assert.equal(await response.text(), "zip-body");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects unsupported mode values", async () => {
  const response = await worker.fetch(
    request("/download?key=secret&url=https%3A%2F%2Ffiles.example.com%2Fdemo.zip&mode=weird"),
    env,
    {},
  );

  assert.equal(response.status, 400);
  assert.equal(await response.text(), "Invalid mode parameter");
});

test("rejects unsupported cache strategy values", async () => {
  const response = await worker.fetch(
    request("/download?key=secret&url=https%3A%2F%2Ffiles.example.com%2Fdemo.zip&cache=force"),
    env,
    {},
  );

  assert.equal(response.status, 400);
  assert.equal(await response.text(), "Invalid cache parameter");
});

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

test("rejects unsupported disposition values", async () => {
  const response = await worker.fetch(
    request(
      "/download?key=secret&url=https%3A%2F%2Ffiles.example.com%2Fdemo.zip&disposition=preview",
    ),
    env,
    {},
  );

  assert.equal(response.status, 400);
  assert.equal(await response.text(), "Invalid disposition parameter");
});

test("can inspect upstream metadata and media cache status", async () => {
  const restoreCache = installMockCache();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(null, {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": "345",
        "Content-Disposition": 'attachment; filename="clip.mp4"',
      },
    });

  try {
    const response = await worker.fetch(
      request("/download?key=secret&url=https%3A%2F%2Ffiles.example.com%2Fclip.mp4&mode=inspect"),
      env,
      {},
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "application/json; charset=utf-8");

    const payload = await response.json();
    assert.equal(payload.mode, "inspect");
    assert.equal(payload.cache, "auto");
    assert.equal(payload.targetUrl, "https://files.example.com/clip.mp4");
    assert.equal(payload.mediaCache.status, "miss");
    assert.equal(payload.upstream.status, 200);
    assert.equal(payload.upstream.contentType, "video/mp4");
    assert.equal(payload.upstream.contentLength, "345");
  } finally {
    globalThis.fetch = originalFetch;
    restoreCache();
  }
});

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
    assert.equal(second.headers.get("Cache-Control"), "public, max-age=300");
    assert.equal(fetchCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
    restoreCache();
  }
});

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
    const first = await worker.fetch(
      request("/download?key=secret&url=https%3A%2F%2Ffiles.example.com%2Fttl.jpg&cache=prefer"),
      env,
      {},
    );
    const second = await worker.fetch(
      request("/download?key=secret&url=https%3A%2F%2Ffiles.example.com%2Fttl.jpg&cache=prefer"),
      env,
      {},
    );

    assert.equal(await first.text(), "ttl-body");
    assert.equal(await second.text(), "ttl-body");
    assert.equal(second.headers.get("X-Proxy-Cache"), "hit");
    assert.equal(second.headers.get("Cache-Control"), "public, max-age=120");
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
    const first = await worker.fetch(
      request("/download?key=secret&url=https%3A%2F%2Ffiles.example.com%2Fblob.bin&cache=prefer"),
      env,
      {},
    );
    const second = await worker.fetch(
      request("/download?key=secret&url=https%3A%2F%2Ffiles.example.com%2Fblob.bin&cache=prefer"),
      env,
      {},
    );

    assert.equal(await first.text(), "no-ttl");
    assert.equal(await second.text(), "no-ttl");
    assert.equal(first.headers.get("X-Proxy-Cache"), "store-skipped");
    assert.equal(second.headers.get("X-Proxy-Cache"), "store-skipped");
    assert.equal(fetchCount, 2);
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

    const cachedAgain = await worker.fetch(
      request("/download?key=secret&url=https%3A%2F%2Ffiles.example.com%2Frefresh.jpg&cache=prefer&cache_ttl=300"),
      env,
      {},
    );

    assert.equal(await refreshed.text(), "version-2");
    assert.equal(await cachedAgain.text(), "version-2");
    assert.equal(refreshed.headers.get("X-Proxy-Cache"), "refresh");
    assert.equal(cachedAgain.headers.get("X-Proxy-Cache"), "hit");
    assert.equal(fetchCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
    restoreCache();
  }
});

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

    assert.equal(await second.text(), "body-for-https://files.example.com/a.jpg");
    assert.equal(second.headers.get("X-Proxy-Cache"), "hit");
    assert.equal(fetchCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
    restoreCache();
  }
});

test("serves seekable media responses and warms the cache on the first request", async () => {
  const restoreCache = installMockCache();
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async (url, init) => {
    fetchCount += 1;
    assert.equal(url, "https://files.example.com/clip.mp4");
    assert.equal(init.method, "GET");
    assert.equal(init.headers.get("Range"), null);

    return new Response("0123456789", {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": "10",
        "Content-Disposition": 'attachment; filename="clip.mp4"',
      },
    });
  };

  try {
    const response = await worker.fetch(
      request("/download?key=secret&url=https%3A%2F%2Ffiles.example.com%2Fclip.mp4&mode=media", {
        headers: {
          Range: "bytes=2-5",
        },
      }),
      env,
      {},
    );

    assert.equal(response.status, 206);
    assert.equal(response.headers.get("Accept-Ranges"), "bytes");
    assert.equal(response.headers.get("Content-Range"), "bytes 2-5/10");
    assert.equal(response.headers.get("Content-Length"), "4");
    assert.equal(await response.text(), "2345");
    assert.equal(fetchCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
    restoreCache();
  }
});

test("reuses the cached media body for later range requests", async () => {
  const restoreCache = installMockCache();
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;

    return new Response("abcdefghij", {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": "10",
      },
    });
  };

  try {
    await worker.fetch(
      request("/download?key=secret&url=https%3A%2F%2Ffiles.example.com%2Fclip.mp4&mode=media", {
        headers: {
          Range: "bytes=0-3",
        },
      }),
      env,
      {},
    );

    const secondResponse = await worker.fetch(
      request("/download?key=secret&url=https%3A%2F%2Ffiles.example.com%2Fclip.mp4&mode=media", {
        headers: {
          Range: "bytes=4-7",
        },
      }),
      env,
      {},
    );

    assert.equal(secondResponse.status, 206);
    assert.equal(await secondResponse.text(), "efgh");
    assert.equal(fetchCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
    restoreCache();
  }
});

test("bypasses media cache when cache=bypass is requested", async () => {
  const restoreCache = installMockCache();
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;

    return new Response("klmnopqrst", {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": "10",
      },
    });
  };

  try {
    await worker.fetch(
      request(
        "/download?key=secret&url=https%3A%2F%2Ffiles.example.com%2Fclip.mp4&mode=media&cache=bypass",
        {
          headers: {
            Range: "bytes=0-1",
          },
        },
      ),
      env,
      {},
    );
    await worker.fetch(
      request(
        "/download?key=secret&url=https%3A%2F%2Ffiles.example.com%2Fclip.mp4&mode=media&cache=bypass",
        {
          headers: {
            Range: "bytes=2-3",
          },
        },
      ),
      env,
      {},
    );

    assert.equal(fetchCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
    restoreCache();
  }
});

test("can override content disposition for proxied downloads", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("ok", {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": 'attachment; filename="demo.bin"',
      },
    });

  try {
    const response = await worker.fetch(
      request(
        "/download?key=secret&url=https%3A%2F%2Ffiles.example.com%2Fdemo.bin&disposition=inline",
      ),
      env,
      {},
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Disposition"), 'inline; filename="demo.bin"');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
