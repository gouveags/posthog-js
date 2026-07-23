---
'@posthog/browser-common': patch
'@posthog/types': patch
'posthog-js': patch
---

Add the browser extension host, expose core analytics behavior through `CoreExtension`, allow key-value stores to return values synchronously or asynchronously, map keys directly to host persistence, and expose host API response details. Nullish values passed to `set` follow host-native storage semantics; use `remove` to delete a key.
