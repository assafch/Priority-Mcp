# Security and evidence boundaries

The server defaults to **read-only**, including when `PRIORITY_READ_ONLY` is unset or misspelled. Writes require an explicit recognized off value plus the tool's `confirm=true` or `dryRun=false`. Preview runs before the write guard and remains available in read-only mode. Priority permissions still apply independently.

Use `PRIORITY_PAT` for token authentication, or a classic username/password pair. The legacy username-as-PAT form remains supported. Configuration credentials are never used as public user identity. Connection URLs must not contain userinfo, queries or fragments. Secrets belong in private environment configuration and never in git or chat.

Tool allowlists and blocklists can be combined; **block wins**. An unmatched allowlist produces an empty, functioning `tools/list`. This is tool routing policy, not form-level authorization: if `priority_query`, generic writes or schema resources remain available, they still permit their documented form access. Use Priority permissions for ERP access boundaries.

## HTTP

The default host is `127.0.0.1`. A non-loopback bind requires `MCP_HTTP_AUTH_TOKEN`; every `/mcp` call checks the bearer token and browser Origin allowlist. Host binding inside a container stays loopback unless explicitly configured. Use TLS/authenticated ingress for remote use. `/health` is local process liveness, not tenant connectivity or financial correctness.

Sessions expire after 30 idle minutes and are capped at 100 by default. A tenant/authentication configuration shares its backend rate limiter/cache while keeping separate MCP transports. Discovery and search-capability caches are client-scoped. Close/failure/shutdown cleans up sessions and pending sockets.

## Writes and results

A write acknowledgment is distinct from verified readback. No-op updates do not return successful business flags. Unknown commit outcomes are not retried automatically. Composite keys and continuation URLs are validated; next links cannot leave the configured origin/company. A tool annotation is descriptive metadata, not authorization.

An attachment row is a pointer, not proof that file bytes were uploaded or readable. Ledger balances are not bank confirmations. Unreconciled invoice face values are not verified remaining balances. Guide tools do not execute screen procedures, and unavailable tools remain explicitly unavailable until their mappings are validated.

## Operational scripts

`scripts/composite-write.mjs` defaults to preview and honors read-only mode. It requires `--confirm` for supported writes. The finalization helper provides guidance only; it cannot silently force a document's final status. No production document should be used as a test fixture.

Run `npm audit` and the full test/protocol suite after dependency changes. The October upgrade targets patched dependency versions; an audit count is a dated registry observation and not proof that every possible vulnerability is absent.

## Read workflow and handle boundaries

Composite reads check their own tool policy and every legacy dependency before access, regardless of profile visibility. Schema resources require `priority_get_entity_metadata`. Resolver candidates require current uncached exact reads before disclosure. Identifiers are not normalized as numbers. Result handles are opaque, process-boot/data/policy/query/generation-bound, expire after 15 minutes and have count/byte limits. They do not grant authority for writes. Reports expose source coverage separately from multi-observation consistency. See [rollout](performance-rollout.md).
