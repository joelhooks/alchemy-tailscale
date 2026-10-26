# alchemy-tailscale

Adopt-first Tailscale resources for [Alchemy](https://alchemy.run), using Effect 4.
This is an unpublished provider prototype. Development tests use synthetic fixtures.

| Resource               | Behavior                                                                                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Tailscale.PolicyFile` | Adopt an exact policy match, then validate and update using the ETag read immediately before writing. Retain on removal.                                          |
| `Tailscale.DeviceTags` | Adopt existing tags and authorization; update only an existing device. Never create or delete a device. Removal succeeds without changing the device or its tags. |
| `Tailscale.AuthKey`    | Create auth keys, deliver the one-time secret to an explicit sink, and revoke on removal. Input changes replace the key.                                          |
| `Tailscale.Dns`        | Read/adopt exact DNS configuration only. Changed writes fail with `UnsafeDnsWrite`. Retain on removal.                                                            |

## Environment

Set `TAILSCALE_TAILNET` to the tailnet identifier. `-` selects the token's own tailnet.
Nothing live is hardcoded.

Choose one authentication method:

- `TAILSCALE_API_KEY`: API access token, sent as a bearer token.
- `TAILSCALE_OAUTH_CLIENT_ID` and `TAILSCALE_OAUTH_CLIENT_SECRET`: OAuth client credentials, exchanged at `/api/v2/oauth/token` before each API request.

The API key takes precedence when both methods are configured. OAuth tokens are
not persisted or cached. A missing tailnet or credential fails provider-layer
construction. Use credentials with only the scopes your stack needs. Do not put
credentials in props, fixtures, source files, or shell history.

## Stack

After building this package, a consumer stack can use:

```ts
import * as Alchemy from "alchemy";
import * as Tailscale from "alchemy-tailscale";
import { Effect } from "effect";

export default Alchemy.Stack(
  "Network",
  { providers: Tailscale.providers(), state: Alchemy.localState() },
  Effect.gen(function* network() {
    const policy = yield* Tailscale.PolicyFile("Policy", {
      policy: { grants: [] }, // Replace with an exact copy of the existing JSON policy.
    });
    return { policy };
  }),
);
```

This example does **not** authorize deploying an empty policy. First copy the
existing policy into the private consumer stack, review the plan, and use
Alchemy's explicit adoption option. Cold singleton reads are marked `Unowned`.
Even with `--adopt`, the first reconciliation requires an exact match and sends
no write. Alchemy beta.84 can pass observed output with `olds: undefined` during
adoption; that still counts as a first reconciliation, not an update grant.

Planning checks live policy, DNS and device tags against the recorded props.
Cold adoption fails with `AdoptionMismatch` when desired props differ from the
observed resource. Its message identifies the resource type, logical ID when
available, and differing field paths, never field values. Arrays report their
field path (for example `tags`); map keys appear as quoted path segments (for
example `policy.tagOwners["tag:example"]`). Map keys and logical IDs are visible
in diagnostics, so do not put secrets in them.
Exact adoption still prints `adopted` in Alchemy beta.84;
that label is not a remote write. Owned live drift also fails during planning,
even when the desired props have not changed. Ordinary owned input changes still
plan as `update` when the live resource matches the recorded props. DNS apply
continues to refuse changed writes until conditional writes are supported.

On later policy updates, the provider rereads the policy, refuses drift from the
recorded props, requires an ETag, calls `/acl/validate`, and only then POSTs
`/acl` with `If-Match`. A 412 becomes `PreconditionFailed` and is never retried.
Any validation diagnostics, including warnings or unknown diagnostic fields,
block the write. JSON objects are supported; HuJSON comments and formatting are
not preserved. Policy object-key order is ignored; array order is significant.

DeviceTags follows the same match-first rule. Set `deviceId`, `tags`, and
optionally `authorized`. Missing devices fail with `DeviceLifecycleRefused`.
Changing `deviceId` also refuses. Tags compare as an unordered list. The tag and
authorization updates are separate API calls, not a transaction. If only one
succeeds, inspect the device and reconcile the recorded props before retrying.

### DNS is deliberately read/adopt-only

The vendored API documents `/dns/configuration` but does not document ETags or
conditional writes for it. Sending an `If-Match` header that the server might
ignore would not protect a fleet-wide overwrite. Initial mismatch raises
`AdoptionMismatch`; even recorded resources reject changed configuration with
`UnsafeDnsWrite`. The client contains the generated setter for completeness;
the **resource never calls it**. Do not bypass the resource's safety contract.

### AuthKey secret delivery

AuthKey attributes contain only `id`, `tailnet`, `created`, and `expires`.
They never contain key material, even wrapped in `Redacted`: Alchemy beta.84's
state encoder unwraps `Redacted` values and would write their plaintext to state.

Before creating keys, provide an `AuthKeySecrets` service alongside the providers
layer with `Layer.provideMerge(secretSinkLayer)`. Its interface is:

```ts
interface AuthKeySecretSink {
  capture(
    id: string,
    secret: Redacted.Redacted<string>,
  ): Effect.Effect<void, Tailscale.SecretDeliveryFailed>;
}
```

Build `secretSinkLayer` with `Layer.succeed(Tailscale.AuthKeySecrets, sink)`.
The sink must durably store the secret without logging it, and report failure
with `SecretDeliveryFailed({ keyId: id })`. No sink means creation refuses
**before minting a key**. There is no default production sink in this package.
`test/provider.test.ts` contains an in-memory fixture sink only.

Key props use `capabilities.devices.create` for `tags`, `preauthorized`,
`ephemeral`, and `reusable`, plus optional `description` and `expirySeconds`.
The resource always sets `keyType: "auth"`; it cannot create OAuth clients.
A successful create returns the key as `Redacted` to the sink exactly once per
create attempt. Subsequent reads return metadata only.

Creation and secret delivery cannot be atomic with Alchemy state. A lost response,
sink failure, or crash before state is recorded can leave an untracked key.
`SecretDeliveryFailed.keyId` identifies a known minted key for manual inspection
and revocation. Do not blindly redeploy after an ambiguous create. There are no
automatic HTTP retries anywhere in this provider.

## Development

Requires Node 24.18+ and pnpm 11.3.0.

```sh
pnpm install
pnpm vendor:agent-sources
pnpm generate:check
pnpm check
pnpm test
```

`pnpm check` verifies generated-client freshness, builds declarations, typechecks
source and a consumer stack against the built package, runs type-aware Oxlint,
and checks Oxfmt formatting. `pnpm test` uses synthetic schema-shaped fixtures and
an in-memory HTTP transport. It never reads real credentials or opens a socket.
The full upstream OpenAPI document, its fetch date/hash, generated subset, and
one schema correction are documented in [PROVENANCE.md](PROVENANCE.md).

Do not run examples against a real tailnet without reviewing credentials and the
plan. Removal retains policy, DNS, and devices; rolling back the package cannot
undo an already applied remote change.
