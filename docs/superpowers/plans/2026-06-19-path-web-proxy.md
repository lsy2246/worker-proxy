# Path Web Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the worker into a path-based web proxy with hidden entry path, underscored proxy parameters, HTML/CSS rewriting, and basic POST forwarding.

**Architecture:** Keep the single Worker module and refactor the existing download route into a general proxy route. The route resolves target URLs from either path suffixes or `_url`, removes only explicit underscored proxy parameters from target query strings, fetches upstream, and rewrites HTML/CSS responses in the default page mode.

**Tech Stack:** Cloudflare Worker runtime, standard Web APIs, Node built-in test runner.

---

### Task 1: Pin the new public contract with tests

**Files:**
- Modify: `test/download-proxy.test.js`

- [x] **Step 1: Replace old download-centric tests with path proxy tests**

Add tests for `_key`, `_url`, path target parsing, reserved parameter stripping, HTML/CSS rewriting, POST forwarding, fallback behavior, HTTPS enforcement, inspect mode, range behavior, and disposition override.

- [x] **Step 2: Run tests and confirm they fail**

Run: `npm test`

Expected: failures because the implementation still expects `/download`, `key`, `url`, `headers`, `mode`, and `disposition`.

### Task 2: Implement the path proxy route

**Files:**
- Modify: `src/index.js`

- [x] **Step 1: Rename config and parse underscored params**

Use `proxy_path`, `_key`, `_url`, `_headers`, `_mode`, and `_disposition`. Default `proxy_path` is `/api/file`.

- [x] **Step 2: Resolve target URLs**

Resolve `/api/file/example.com/path` as `https://example.com/path`, preserve explicit `http://` or `https://`, and strip only the explicit underscored proxy params from the target query string.

- [x] **Step 3: Forward methods and request bodies**

Allow `GET`, `HEAD`, `POST`, and `OPTIONS`. Forward POST bodies and content headers; skip Worker cache for POST.

### Task 3: Add web response rewriting

**Files:**
- Modify: `src/index.js`

- [x] **Step 1: Rewrite HTML links**

Rewrite `href`, `src`, `action`, `poster`, `data`, `srcset`, and meta refresh URLs through `proxy_path`, carrying `_key` when present.

- [x] **Step 2: Rewrite CSS URLs**

Rewrite `url(...)` and `@import` URLs through the proxy path.

- [x] **Step 3: Preserve non-web resources**

Return binary/download responses without rewriting, while keeping `Content-Disposition` and `_disposition` override behavior.

### Task 4: Update documentation and verify

**Files:**
- Modify: `README.md`

- [x] **Step 1: Document new URL forms and parameters**

Describe path form, `_url` fallback, `_key`, `_headers`, `_mode`, `_disposition`, fallback behavior, POST support, and known non-goals.

- [x] **Step 2: Run full verification**

Run: `npm test`

Expected: all tests pass.
