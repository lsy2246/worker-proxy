import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

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
      const cacheRequest = typeof requestOrUrl === "string" ? new Request(requestOrUrl) : requestOrUrl;
      const entry = store.get(cacheRequest.url);

      if (!entry) {
        return undefined;
      }

      const rangeHeader = cacheRequest.headers.get("Range");
      if (!rangeHeader) {
        return new Response(entry.buffer.slice(0), {
          status: entry.status,
          statusText: entry.statusText,
          headers: new Headers(entry.headers),
        });
      }

      const totalLength = entry.buffer.byteLength;
      const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
      if (!match) {
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${totalLength}` },
        });
      }

      let start = match[1] === "" ? null : Number.parseInt(match[1], 10);
      let end = match[2] === "" ? null : Number.parseInt(match[2], 10);

      if (start === null && end === null) {
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${totalLength}` },
        });
      }

      if (start === null) {
        start = Math.max(totalLength - (end ?? 0), 0);
        end = totalLength - 1;
      } else {
        end = end === null ? totalLength - 1 : Math.min(end, totalLength - 1);
      }

      if (start < 0 || start >= totalLength || start > end) {
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${totalLength}` },
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
  globalThis.caches = {
    default: createRangeAwareCache(),
  };

  return () => {
    globalThis.caches = originalCaches;
  };
}

test("requires the configured password from _key", async () => {
  const response = await worker.fetch(request("/api/file/files.example.com/demo.zip"), env, {});

  assert.equal(response.status, 401);
  assert.equal(await response.text(), "Unauthorized");
});

test("allows requests without _key when no password is configured", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(url, "https://files.example.com/demo.zip");
    return new Response("ok");
  };

  try {
    const response = await worker.fetch(
      request("/api/file/files.example.com/demo.zip"),
      { PROXY_PASSWORD: "" },
      {},
    );

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("defaults path targets without a protocol to https", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://files.example.com/demo.zip");
    assert.equal(init.method, "GET");
    return new Response("zip-body", {
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": "8",
      },
    });
  };

  try {
    const response = await worker.fetch(
      request("/api/file/files.example.com/demo.zip?_key=secret"),
      env,
      {},
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "application/zip");
    assert.equal(await response.text(), "zip-body");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uses explicit protocol from path targets", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(url, "http://files.example.com/demo.zip");
    return new Response("ok");
  };

  try {
    const response = await worker.fetch(
      request("/api/file/http://files.example.com/demo.zip?_key=secret"),
      env,
      {},
    );

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not support target query fields as proxy targets", async () => {
  const urlResponse = await worker.fetch(
    request("/api/file?_key=secret&_url=https%3A%2F%2Ffiles.example.com%2Ffrom-query.txt"),
    env,
    {},
  );
  const targetResponse = await worker.fetch(
    request("/api/file?_key=secret&_target=https%3A%2F%2Ffiles.example.com%2Ffrom-query.txt"),
    env,
    {},
  );

  assert.equal(urlResponse.status, 400);
  assert.equal(await urlResponse.text(), "Missing target URL");
  assert.equal(targetResponse.status, 400);
  assert.equal(await targetResponse.text(), "Missing target URL");
});

test("does not treat target key mode or url parameters as proxy parameters", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(url, "https://site.example.com/search?key=abc&mode=list&url=%2Fkeep&q=test");
    return new Response("ok");
  };

  try {
    const response = await worker.fetch(
      request("/api/file/site.example.com/search?key=abc&mode=list&url=%2Fkeep&q=test&_key=secret"),
      env,
      {},
    );

    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("applies upstream request headers from the _headers query parameter", async () => {
  const extraHeaders = encodeURIComponent(
    JSON.stringify({
      Referer: "https://movie.douban.com/",
      "User-Agent": "Mozilla/5.0 test",
      Accept: "image/webp,image/apng,image/*,*/*;q=0.8",
    }),
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://img3.doubanio.com/view/photo/demo.webp");
    assert.equal(init.headers.get("Host"), "img3.doubanio.com");
    assert.equal(init.headers.get("Referer"), "https://movie.douban.com/");
    assert.equal(init.headers.get("User-Agent"), "Mozilla/5.0 test");
    assert.equal(init.headers.get("Accept"), "image/webp,image/apng,image/*,*/*;q=0.8");
    return new Response("ok");
  };

  try {
    const response = await worker.fetch(
      request(`/api/file/img3.doubanio.com/view/photo/demo.webp?_key=secret&_headers=${extraHeaders}`),
      env,
      {},
    );

    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("strips client hint headers before forwarding upstream requests", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://example.com/");
    assert.equal(init.headers.get("Sec-CH-UA-Mobile"), null);
    assert.equal(init.headers.get("Sec-CH-Viewport-Width"), null);
    assert.equal(init.headers.get("Viewport-Width"), null);
    assert.equal(init.headers.get("DPR"), null);
    return new Response("ok");
  };

  try {
    const response = await worker.fetch(
      request("/api/file/example.com/?_key=secret", {
        headers: {
          "Sec-CH-UA-Mobile": "?1",
          "Sec-CH-Viewport-Width": "390",
          "Viewport-Width": "390",
          DPR: "3",
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

test("rejects invalid _headers JSON", async () => {
  const response = await worker.fetch(
    request("/api/file/files.example.com/demo.zip?_key=secret&_headers=%7Bbad-json"),
    env,
    {},
  );

  assert.equal(response.status, 400);
  assert.equal(await response.text(), "Invalid _headers parameter");
});

test("rejects unsupported _mode values", async () => {
  const response = await worker.fetch(
    request("/api/file/files.example.com/demo.zip?_key=secret&_mode=weird"),
    env,
    {},
  );

  assert.equal(response.status, 400);
  assert.equal(await response.text(), "Invalid _mode parameter");
});

test("rejects unsupported _disposition values", async () => {
  const response = await worker.fetch(
    request("/api/file/files.example.com/demo.zip?_key=secret&_disposition=preview"),
    env,
    {},
  );

  assert.equal(response.status, 400);
  assert.equal(await response.text(), "Invalid _disposition parameter");
});

test("rewrites HTML resource links through the proxy path", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(url, "https://example.com/docs/index.html?lang=zh");
    return new Response(
      '<!doctype html><link href="/site.css"><img src="img/logo.png"><a href="../file.zip?x=1">Download</a><form method="post" action="/export"><input></form><meta http-equiv="refresh" content="0; url=/next">',
      {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": "999",
        },
      },
    );
  };

  try {
    const response = await worker.fetch(
      request("/api/file/example.com/docs/index.html?lang=zh&_key=secret"),
      env,
      {},
    );
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Length"), null);
    assert.match(html, /href="\/api\/file\/example.com\/site.css\?_key=secret"/);
    assert.match(html, /src="\/api\/file\/example.com\/docs\/img\/logo.png\?_key=secret"/);
    assert.match(html, /href="\/api\/file\/example.com\/file.zip\?x=1&amp;_key=secret"/);
    assert.match(html, /action="\/api\/file\/example.com\/export\?_key=secret"/);
    assert.match(html, /content="0; url=\/api\/file\/example.com\/next\?_key=secret"/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rewrites upstream redirects through the proxy path", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://example.com/start");
    assert.equal(init.redirect, "manual");
    return new Response(null, {
      status: 302,
      headers: {
        Location: "https://www.example.com/final?x=1",
      },
    });
  };

  try {
    const response = await worker.fetch(
      request("/api/file/example.com/start?_key=secret"),
      env,
      {},
    );

    assert.equal(response.status, 302);
    assert.equal(response.headers.get("Location"), "/api/file/www.example.com/final?x=1&_key=secret");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not duplicate proxy paths embedded in upstream redirects", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(null, {
      status: 302,
      headers: {
        Location: "https://www.example.com/?utm=https%3A%2F%2Fproxy.example.test%2Fapi%2Ffile%2Fexample.com%2Fwatch%3Fv%3D1",
      },
    });

  try {
    const response = await worker.fetch(
      request("/api/file/example.com/watch?v=1&_key=secret"),
      env,
      {},
    );

    assert.equal(
      response.headers.get("Location"),
      "/api/file/www.example.com/?utm=https%3A%2F%2Fproxy.example.test%2Fapi%2Ffile%2Fexample.com%2Fwatch%3Fv%3D1&_key=secret",
    );
    assert.doesNotMatch(response.headers.get("Location"), /\/api\/file\/example\.com\/api\/file\//);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("removes upstream browser security policy headers from rewritten pages", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response('<link rel="stylesheet" href="/site.css">', {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'none'; style-src github.githubassets.com",
        "Content-Security-Policy-Report-Only": "default-src 'none'",
        "X-Frame-Options": "deny",
        "Permissions-Policy": "geolocation=()",
        "Accept-CH": "Sec-CH-UA-Mobile, Sec-CH-Viewport-Width",
        "Critical-CH": "Sec-CH-UA-Mobile",
        Vary: "Sec-CH-UA-Mobile, Accept-Encoding",
      },
    });

  try {
    const response = await worker.fetch(
      request("/api/file/github.com?_key=secret"),
      env,
      {},
    );

    assert.match(response.headers.get("Content-Security-Policy"), /script-src 'self'/);
    assert.doesNotMatch(response.headers.get("Content-Security-Policy"), /github\.githubassets\.com/);
    assert.equal(response.headers.get("Content-Security-Policy-Report-Only"), null);
    assert.equal(response.headers.get("X-Frame-Options"), null);
    assert.equal(response.headers.get("Permissions-Policy"), null);
    assert.equal(response.headers.get("Accept-CH"), null);
    assert.equal(response.headers.get("Critical-CH"), null);
    assert.equal(response.headers.get("Vary"), "Accept-Encoding");
    assert.match(response.headers.get("Cache-Control"), /no-transform/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("injects a runtime URL patch for dynamic browser requests", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("<!doctype html><title>App</title>", {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
    });

  try {
    const response = await worker.fetch(
      request("/api/file/example.com/app/index.html?_key=secret"),
      env,
      {},
    );
    const html = await response.text();

    assert.match(html, /data-worker-proxy-runtime/);
    assert.match(html, /const proxyPath = "\/api\/file"/);
    assert.match(html, /const baseTargetUrl = "https:\/\/example.com\/app\/index.html"/);
    assert.match(html, /window\.fetch = function/);
    assert.match(html, /XMLHttpRequest\.prototype\.open = function/);
    assert.match(html, /alreadyProxied/);
    assert.match(html, /document\.addEventListener\("submit"/);
    assert.match(html, /HTMLFormElement\.prototype\.submit/);
    assert.doesNotMatch(html, /history\.pushState = function/);
    assert.doesNotMatch(html, /history\.replaceState = function/);
    assert.doesNotMatch(html, /searchParams\.set\("_target"/);
    assert.match(html, /searchParams\.set\("_key", proxyKey\)/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runtime treats same-origin non-proxy URLs as target-site navigations", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("<!doctype html><title>App</title>", {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
    });

  try {
    const response = await worker.fetch(
      request("/api/file/example.com/app/index.html?_key=secret"),
      env,
      {},
    );
    const html = await response.text();
    const scriptMatch = /<script data-worker-proxy-runtime>([\s\S]*?)<\/script>/.exec(html);
    assert.ok(scriptMatch);

    let fetchedUrl = "";
    const sandbox = {
      URL,
      Request,
      location: new URL("https://proxy.example.test/api/file/example.com/app/index.html?_key=secret"),
      window: {
        fetch(input) {
          fetchedUrl = typeof input === "string" ? input : input.url;
          return Promise.resolve(new Response("ok"));
        },
      },
      XMLHttpRequest: function XMLHttpRequest() {},
      navigator: {},
      HTMLFormElement: function HTMLFormElement() {},
      history: {},
      document: {
        addEventListener() {},
      },
    };
    sandbox.XMLHttpRequest.prototype.open = function open() {};
    sandbox.HTMLFormElement.prototype.submit = function submit() {};

    vm.runInNewContext(scriptMatch[1], sandbox);
    await sandbox.window.fetch("https://proxy.example.test/search?q=lsy22&type=repositories");

    assert.equal(
      fetchedUrl,
      "https://proxy.example.test/api/file/example.com/search?q=lsy22&type=repositories&_key=secret",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runtime leaves SPA history route updates visible to the app router", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("<!doctype html><title>App</title>", {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
    });

  try {
    const response = await worker.fetch(
      request("/api/file/github.com?_key=secret"),
      env,
      {},
    );
    const html = await response.text();
    const scriptMatch = /<script data-worker-proxy-runtime>([\s\S]*?)<\/script>/.exec(html);
    assert.ok(scriptMatch);

    const pushedUrls = [];
    const sandbox = {
      URL,
      Request,
      location: new URL("https://proxy.example.test/api/file/github.com?_key=secret"),
      window: {},
      XMLHttpRequest: function XMLHttpRequest() {},
      navigator: {},
      HTMLFormElement: function HTMLFormElement() {},
      history: {
        pushState(state, title, url) {
          pushedUrls.push(url);
        },
        replaceState() {},
      },
      document: {
        addEventListener() {},
      },
    };
    sandbox.XMLHttpRequest.prototype.open = function open() {};
    sandbox.HTMLFormElement.prototype.submit = function submit() {};

    vm.runInNewContext(scriptMatch[1], sandbox);
    sandbox.history.pushState({}, "", "/search?q=lsy22&type=repositories");

    assert.deepEqual(pushedUrls, ["/search?q=lsy22&type=repositories"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("preserves explicit http targets when rewriting links", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(url, "http://example.com/page");
    return new Response('<a href="/next">Next</a>', {
      headers: { "Content-Type": "text/html" },
    });
  };

  try {
    const response = await worker.fetch(
      request("/api/file/http://example.com/page?_key=secret"),
      env,
      {},
    );
    const html = await response.text();

    assert.match(html, /href="\/api\/file\/http:\/\/example.com\/next\?_key=secret"/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("leaves non-proxyable HTML links unchanged", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response('<a href="#top">Top</a><a href="mailto:a@example.com">Mail</a><img src="data:image/png;base64,abc">', {
      headers: { "Content-Type": "text/html" },
    });

  try {
    const response = await worker.fetch(request("/api/file/example.com?_key=secret"), env, {});
    const html = await response.text();

    assert.match(html, /href="#top"/);
    assert.match(html, /href="mailto:a@example.com"/);
    assert.match(html, /src="data:image\/png;base64,abc"/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rewrites CSS url and import references through the proxy path", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(url, "https://example.com/assets/site.css");
    return new Response('@import "../base.css"; body{background:url("/img/bg.png")} .icon{src:url(data:image/png;base64,abc)}', {
      headers: {
        "Content-Type": "text/css",
        "Content-Length": "999",
      },
    });
  };

  try {
    const response = await worker.fetch(
      request("/api/file/example.com/assets/site.css?_key=secret"),
      env,
      {},
    );
    const css = await response.text();

    assert.equal(response.headers.get("Content-Length"), null);
    assert.match(css, /@import "\/api\/file\/example.com\/base.css\?_key=secret"/);
    assert.match(css, /url\("\/api\/file\/example.com\/img\/bg.png\?_key=secret"\)/);
    assert.match(css, /url\(data:image\/png;base64,abc\)/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("forwards POST bodies for proxied forms", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://example.com/export?format=csv");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.get("Content-Type"), "application/x-www-form-urlencoded");
    assert.equal(init.headers.get("Origin"), "https://example.com");
    assert.equal(init.headers.get("Referer"), "https://example.com/export?format=csv");
    assert.equal(await new Response(init.body).text(), "from=2026&to=2027");
    return new Response("a,b\n1,2\n", {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": 'attachment; filename="report.csv"',
      },
    });
  };

  try {
    const response = await worker.fetch(
      request("/api/file/example.com/export?format=csv&_key=secret", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://proxy.example.test",
          Referer: "https://proxy.example.test/api/file/example.com/form?_key=secret",
        },
        body: "from=2026&to=2027",
      }),
      env,
      {},
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Disposition"), 'attachment; filename="report.csv"');
    assert.equal(await response.text(), "a,b\n1,2\n");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rewrites HTML returned by POST responses", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response('<a href="/result">Result</a>', {
      headers: { "Content-Type": "text/html" },
    });

  try {
    const response = await worker.fetch(
      request("/api/file/example.com/submit?_key=secret", {
        method: "POST",
        body: "ok=1",
      }),
      env,
      {},
    );
    const html = await response.text();

    assert.match(html, /href="\/api\/file\/example.com\/result\?_key=secret"/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("supports CORS preflight requests", async () => {
  const response = await worker.fetch(
    request("/api/file/example.com", {
      method: "OPTIONS",
    }),
    env,
    {},
  );

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(response.headers.get("Access-Control-Allow-Methods"), "GET, HEAD, POST, OPTIONS");
});

test("serves configured fallback HTML for non-proxy paths", async () => {
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

test("recovers same-origin navigations from proxied page referers", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(url, "https://github.com/search?q=lsy22&type=repositories");
    return new Response("<!doctype html><title>Search</title>", {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
    });
  };

  try {
    const response = await worker.fetch(
      request("/search?q=lsy22&type=repositories", {
        headers: {
          Referer: "https://proxy.example.test/api/file/github.com?_key=secret",
        },
      }),
      env,
      {},
    );
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /<title>Search<\/title>/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("keeps fallback for non-proxy paths without proxied referers", async () => {
  const configuredWorker = createWorker({
    fallback_mode: "html",
    fallback_html: "<!doctype html><title>Fallback</title>",
  });

  const response = await configuredWorker.fetch(
    request("/search?q=lsy22"),
    env,
    {},
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "<!doctype html><title>Fallback</title>");
});

test("uses a configured proxy path before applying fallback behavior", async () => {
  const configuredWorker = createWorker({
    proxy_path: "/service/view",
    fallback_mode: "html",
    fallback_html: "<!doctype html><title>Fallback</title>",
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(url, "https://files.example.com/demo.zip");
    return new Response("ok");
  };

  try {
    const proxyResponse = await configuredWorker.fetch(
      request("/service/view/files.example.com/demo.zip?_key=secret"),
      env,
      {},
    );
    const defaultPathResponse = await configuredWorker.fetch(
      request("/api/file/files.example.com/demo.zip?_key=secret"),
      env,
      {},
    );

    assert.equal(proxyResponse.status, 200);
    assert.equal(await proxyResponse.text(), "ok");
    assert.equal(defaultPathResponse.status, 200);
    assert.equal(await defaultPathResponse.text(), "<!doctype html><title>Fallback</title>");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("blocks configured Cloudflare country codes", async () => {
  const configuredWorker = createWorker({ blocked_region: ["CN"] });

  const response = await configuredWorker.fetch(
    request("/api/file/files.example.com/demo.zip?_key=secret", {
      headers: { "cf-ipcountry": "CN" },
    }),
    env,
    {},
  );

  assert.equal(response.status, 403);
  assert.equal(await response.text(), "Access denied: region blocked");
});

test("can inspect upstream metadata and proxy cache status", async () => {
  const restoreCache = installMockCache();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://files.example.com/clip.mp4");
    assert.equal(init.method, "HEAD");
    return new Response(null, {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": "345",
        "Content-Disposition": 'attachment; filename="clip.mp4"',
      },
    });
  };

  try {
    const response = await worker.fetch(
      request("/api/file/files.example.com/clip.mp4?_key=secret&_mode=inspect"),
      env,
      {},
    );

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.mode, "inspect");
    assert.equal(payload.targetUrl, "https://files.example.com/clip.mp4");
    assert.equal(payload.proxyCache.status, "miss");
    assert.equal(payload.upstream.contentType, "video/mp4");
  } finally {
    globalThis.fetch = originalFetch;
    restoreCache();
  }
});

test("serves seekable range responses when upstream returns a full body", async () => {
  const restoreCache = installMockCache();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://files.example.com/clip.mp4");
    assert.equal(init.method, "GET");
    assert.equal(init.headers.get("Range"), "bytes=2-5");

    return new Response("0123456789", {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": "10",
      },
    });
  };

  try {
    const response = await worker.fetch(
      request("/api/file/files.example.com/clip.mp4?_key=secret&_mode=range", {
        headers: { Range: "bytes=2-5" },
      }),
      env,
      {},
    );

    assert.equal(response.status, 206);
    assert.equal(response.headers.get("Content-Range"), "bytes 2-5/10");
    assert.equal(await response.text(), "2345");
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
      request("/api/file/files.example.com/demo.bin?_key=secret&_disposition=inline"),
      env,
      {},
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Disposition"), 'inline; filename="demo.bin"');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
