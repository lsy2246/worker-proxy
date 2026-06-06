# Request-Driven Proxy Cache Design

**Problem**

`worker-proxy` currently has two unrelated cache behaviors:

- `mode=proxy` mostly relies on upstream and Cloudflare edge cache behavior.
- `mode=media` writes the full object into `caches.default` and serves seekable responses from there.

This makes cacheability depend on upstream response headers instead of an explicit caller decision. In practice, Douban images cache well because the upstream response is already public, while Google Photos images stay dynamic because the upstream response is private even though the caller knows the asset is effectively immutable.

**Goal**

Add a request-driven proxy cache layer that callers can opt into per request, with explicit TTL control and conservative defaults when no cache parameters are provided.

## Design Summary

Introduce cache controls that are independent from `mode`:

- `cache=auto|off|prefer|refresh`
- `cache_ttl=<seconds>`
- `cache_key_mode=auto|full|ignore_search|custom`
- `cache_key=<string>` when `cache_key_mode=custom`

When parameters are omitted, behavior stays conservative:

- `mode=proxy` does not proactively write to Worker cache.
- `mode=media` keeps the existing seekable cache flow.
- `cache=prefer` or `cache=refresh` explicitly enables Worker-managed caching.
- If `cache_ttl` is omitted while caching is enabled, TTL is inferred from upstream cache headers.

## Request Semantics

### `cache`

- `auto`
  - Default.
  - `proxy`: do not add new Worker-managed caching behavior.
  - `media`: preserve current media cache behavior.
- `off`
  - Never read or write Worker cache.
- `prefer`
  - Read Worker cache first.
  - On miss, fetch upstream and write Worker cache if the response is cacheable under the resolved policy.
- `refresh`
  - Skip Worker cache read.
  - Fetch upstream and overwrite Worker cache if the response is cacheable under the resolved policy.

### `cache_ttl`

- Optional integer in seconds.
- Must be a positive integer.
- Used only when Worker-managed caching is enabled.
- If omitted:
  - infer TTL from upstream `Cache-Control` or `Expires`
  - if no positive TTL can be inferred, treat the response as not cacheable for request-driven proxy caching

### `cache_key_mode`

- `auto` default
- `full`
  - include full target URL
- `ignore_search`
  - use origin + pathname only
- `custom`
  - use `cache_key` as the caller-specified resource identity

`auto` initially behaves the same as `full`. This keeps the first release small while reserving room for future heuristics.

### `cache_key`

- Required only when `cache_key_mode=custom`
- Used as the resource identity instead of a derived URL string

## Cache Storage Model

Keep media and generic proxy cache keys in separate namespaces:

- media cache path: existing `MEDIA_CACHE_PATH`
- generic proxy cache path: new `PROXY_CACHE_PATH`

Both cache namespaces will derive keys from:

- resource identity resolved from `cache_key_mode`
- normalized extra upstream headers from `headers=...`
- response mode namespace (`media` vs `proxy`)

Including normalized extra headers prevents collisions when the same asset URL requires different `Referer`, `Accept`, or `User-Agent` values.

## TTL Resolution

Add a TTL resolver for Worker-managed caching:

1. If `cache_ttl` is provided, use it.
2. Otherwise infer from upstream response:
   - parse `s-maxage`
   - then `max-age`
   - then `Expires - Date` fallback
3. Reject non-positive or invalid TTL values.
4. Clamp TTL to a Worker-defined maximum to avoid accidental extreme values.

For this implementation, use a max TTL of 31536000 seconds.

## Response Behavior

When a response is served from Worker-managed proxy cache:

- preserve upstream `Content-Type`, `Content-Disposition`, and other pass-through headers
- override `Cache-Control` with `public, max-age=<resolved ttl>`
- add `X-Proxy-Cache: hit|miss|bypass|refresh|store-skipped`

When a response is fetched directly without Worker cache:

- preserve current behavior as much as possible
- still expose `X-Proxy-Cache` so debugging is easier

For `mode=media`, retain current `Accept-Ranges` and range response behavior.

## Error Handling

Return `400` for:

- invalid `cache`
- invalid `cache_ttl`
- invalid `cache_key_mode`
- missing `cache_key` when `cache_key_mode=custom`

If caching is enabled but TTL cannot be resolved:

- do not fail the request
- serve the upstream response normally
- skip the Worker cache write
- emit `X-Proxy-Cache: store-skipped`

## Testing

Add tests for:

- invalid cache parameters
- explicit proxy cache write/read with caller TTL
- proxy cache skip when no TTL can be inferred
- proxy cache read/write using inferred upstream TTL
- `cache=refresh` bypassing previous cache contents
- `cache=off` bypassing Worker cache
- custom cache key reuse across different URLs only when explicitly requested
- existing media cache behavior still working

## Files

- Modify `src/index.js`
- Modify `test/download-proxy.test.js`

## Non-Goals

- Automatic content-type-based cache heuristics in this first pass
- Multi-profile named cache presets
- Purge API
- Background revalidation
