# IndexNow

The public ownership key is `16a91221eb78411198dbd6254bf9e653`. It is deliberately public and is not a credential. The matching UTF-8 file lives in `public/` and its exact resolved path is allowed through the Node session gate. Production Caddy also serves the exact key path so activation can preserve the existing application image. Every other request keeps its existing routing. The ingress response remains available if the application is offline.

```sh
npm run indexnow -- --check
npm run indexnow -- --dry-run
npm run indexnow
npm run indexnow -- /telc-deutsch-b1
npm run check:indexnow
```

The script requires Node.js 20 or later. Without paths, it reads the live flat sitemap at `https://hatoove.com/sitemap.xml`; sitemap indexes are explicitly rejected. It validates canonical same-origin HTTPS URLs, deduplicates them, verifies the live key without redirects, then sends batches of at most 10,000 URLs to `https://api.indexnow.org/indexnow`. Participating engines share submissions. Dry-run and check-only modes never submit URLs. No build or startup automatically submits URLs.

HTTP 200 means submitted; HTTP 202 means received with key validation pending. Neither guarantees indexing. HTTP 403 indicates an unavailable or invalid key, 422 a host/key scope mismatch, and 429 a rate limit. Failures exit nonzero.

Deploy only the reviewed Caddyfile delta to the existing production ingress, first checking the current source/configuration and keeping an exact backup. Validate with the currently pinned Caddy image and recreate only ingress with `--no-deps`; preserve app/worker image identities and all volumes. Verify the exact key body, a nonmatching path, retained headers, foreign-host refusal, HTTP redirect and application health. Restore the prior configuration and recreate only ingress if verification fails. Do not deploy current main's unrelated application changes as part of this activation.

The focused tests mock IndexNow requests, cover malformed/foreign URLs and failed verification, and check exact Caddy path/body/status with negative mutations. The SEO regression test checks anonymous Node key access and the existing session gate. References: [IndexNow protocol](https://www.indexnow.org/documentation), [FAQ](https://www.indexnow.org/faq).
