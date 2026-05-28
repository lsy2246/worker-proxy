import assert from "node:assert/strict";
import test from "node:test";

import worker, { createWorker } from "../src/index.js";

const env = {
  PROXY_PASSWORD: "secret",
};

function request(path, init) {
  return new Request(`https://proxy.example.test${path}`, init);
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
