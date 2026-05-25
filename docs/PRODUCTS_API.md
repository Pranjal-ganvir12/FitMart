# Products API

GET /api/products

Query parameters
- `page` (number) — page number (default: 1)
- `limit` (number) — items per page (default: 24)
- `category` (string) — filter by category (e.g., `Nutrition`)
- `search` (string) — full-text search on `name` (uses MongoDB text index)
- `sort` (string) — `{field}_{asc|desc}` e.g. `price_asc` (default: `productId_asc`)
- `fields` (string) — comma-separated fields to select (e.g., `name,price,image`)
- `all=true` — return full list (backward compatible, avoid in production)

Response shape

```
{
  "data": [...],
  "meta": { "page":1, "limit":24, "total":150, "totalPages":7 },
  "links": { "next": "/api/products?page=2&limit=24", "prev": null }
}
```

Headers
- `X-Total-Count`: total matching items
- `ETag`: ETag for conditional requests
- `Link`: RFC5988 pagination links
- `X-Cache`: `HIT` or `MISS`

Cache strategy
- Results are cached by query params. Cache key is an MD5 hash of the query.
- TTL configurable via `PRODUCTS_CACHE_TTL` (seconds; default 60).
- Redis is used when `REDIS_URL`/`REDIS_HOST` is configured; otherwise an in-memory Map fallback is used.

Invalidation
- Cache is cleared on product create/update/delete and after seed operations. This is a conservative invalidation strategy to ensure consistency.

Compatibility
- Previously the API returned all products by default. To retain compatibility you can call `?all=true` but pagination is recommended.

ETag / Conditional Requests
- The API sets an `ETag` header and responds with `304 Not Modified` when the `If-None-Match` matches.

Examples
- `/api/products?page=1&limit=24&category=Equipment&search=protein&sort=price_asc`
