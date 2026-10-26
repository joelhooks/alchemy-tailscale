# Provenance

## Tailscale OpenAPI

- Source: <https://api.tailscale.com/api/v2?outputOpenapiSchema=true>
- Fetched: **2026-10-25T14:23:13Z**, without authentication.
- Vendored file: `spec/openapi.yaml` (the endpoint serves YAML, not JSON).
- SHA-256: `b3532da71b7bc5f37fd030f324aaaa1e59df72ac025e7d15b4e3d268ea15ac38`.
- Document version: OpenAPI 3.1.0. Upstream describes the specification itself as
  unstable even where its API endpoints are stable.

The full upstream document is retained unchanged. It contains upstream examples,
not captured account data. Fixtures in `test/fixtures/responses.json` are
synthetic JSON built from its response shapes; none came from a live tailnet.

`scripts/generate-client.ts` generates Effect schemas, input/output types, and
Effect client functions for these paths only:

| Path                                   | Operations  |
| -------------------------------------- | ----------- |
| `/tailnet/{tailnet}/acl`               | GET, POST   |
| `/tailnet/{tailnet}/acl/validate`      | POST        |
| `/device/{deviceId}`                   | GET         |
| `/device/{deviceId}/tags`              | POST        |
| `/device/{deviceId}/authorized`        | POST        |
| `/tailnet/{tailnet}/keys`              | POST        |
| `/tailnet/{tailnet}/keys/{keyId}`      | GET, DELETE |
| `/tailnet/{tailnet}/dns/configuration` | GET, POST   |

The DNS POST is generated but is not used by the Dns resource because the spec
provides no conditional-write contract. No create/delete device operation is
generated. The output is `src/generated/client.ts`. Regeneration is offline:
`pnpm generate`; freshness is checked by `pnpm generate:check`.

### Explicit schema correction

For `validateAndTestPolicyFile`, upstream prose says a JSON object represents a
hypothetical policy, but its request schema's `oneOf` labels that variant a
string. The generator uses a JSON object record, following the endpoint prose.
The response decoder also keeps all diagnostic fields rather than discarding
unknown fields: only an empty response or `{}` counts as validation success.
This prevents a new diagnostic shape from accidentally authorizing a write.

### Authentication adapter

OAuth's `/api/v2/oauth/token` is documented in Tailscale's authentication prose
but is not an operation in this OpenAPI document. `src/credentials.ts` supplies
the small hand-written client-credentials adapter. API access tokens use bearer
authentication, which the vendored document explicitly supports.

## Runtime and template

- `alchemy@2.0.0-beta.84`: resource, provider, adoption and state-encoding contracts
  inspected from its distributed npm source (`node_modules/alchemy/src`).
- `effect@4.0.5`: typed effects, schemas, services, layers, redaction and HTTP.
  Pinned upstream source ref: `effect@4.0.5`.
- Repository shape, tsconfig set, type-aware Oxlint/Oxfmt configuration, source
  mirror script structure, and compile-only consumer test pattern follow
  `alchemy-proxmox`. No Proxmox runtime code or homeflare-kit implementation is
  included here.

The lockfile records npm integrity hashes. `.agent_sources/` contains private,
reference-only mirrors and is excluded from product commits and npm files.
