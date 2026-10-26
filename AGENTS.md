# Agent instructions

Tailscale v2 resources for Alchemy. This repository is public.

- Use the exact Effect and Alchemy pins in `package.json`. Read the installed
  Alchemy source and pinned Effect mirror before changing lifecycle behavior.
  `pnpm vendor:agent-sources` prepares reference-only mirrors.
- No credentials, private tailnet identifiers, account data, device names,
  addresses, or real policy contents belong here. Fixtures are synthetic.
  Never call a live tailnet from tests. The public OpenAPI document is the only
  upstream API input needed to regenerate the client.
- `pnpm check` and `pnpm test` must pass. Keep the compile-only consumer stack
  aligned with the built public package exports.
- PolicyFile is match-adopt-only on its first reconciliation. Alchemy beta.84
  passes `olds: undefined` during adoption even when observed output exists.
  Keep that exact-match/no-write guard. `--adopt` never bypasses it.
- Plan-time safety depends on `diff`, not just `reconcile`. In the pinned
  `alchemy/src/Plan.ts`, lines 1391–1442 construct a cold-adopt row with
  `props: news` and live `attr`. Lines 1596–1606 pass those as `olds` and
  `output` to `diff`. Lines 1648–1652 force an adoption noop to update, and
  lines 1787–1794 label that action `adopted`. Fail cold-adopt mismatches with
  `AdoptionMismatch` before that label can hide drift.
- Ordinary created/updated rows do **not** receive a fresh read before diff.
  The refresh at `Plan.ts:1507–1577` only handles an interrupted `creating`
  row with no attributes. Normal diff at `Plan.ts:1583–1606` uses persisted
  props and attributes; early stable resolution at `Plan.ts:764–807` does
  too. Therefore policy, DNS and device diffs read live state themselves and
  refuse differences from recorded props, even with unchanged desired props.
  Keep legitimate owned input updates planning as `update` when live state
  still matches the old props. The DNS apply-time write refusal stays intact.
- `test/plan.test.ts` drives the real pinned Plan engine with in-memory state
  and HTTP fixtures. Keep exact cold adoption, drifted cold adoption, owned
  updates, and owned live drift covered for all three adopt-only resources.
- Each policy write requires a fresh ETag, successful API validation, and
  `If-Match`. A 412 is terminal, not retryable. Removal retains the policy.
- Dns is read/adopt-only. The upstream spec does not document a conditional-write
  contract for DNS. Keep changed writes blocked with `UnsafeDnsWrite` until
  upstream supports a verified concurrency contract. Never silently remove
  this guard or assume an undocumented header is honored.
- DeviceTags only changes existing devices. No create/delete device operation
  belongs in this provider. Identity changes refuse. Removal and the provider's
  delete callback both retain the device and tags and succeed without an API
  request; do not return a permanent failure when removing the stack entry.
- Alchemy beta.84's `StateEncoding.encodeState` deliberately unwraps Redacted
  values into plaintext state. Do not copy Axiom.ApiToken's attributes pattern.
  AuthKey keeps all secret material out of attributes and uses the explicit
  `AuthKeySecrets` service. Missing sink refuses before create. Test JSON and
  the real Alchemy state encoder, not just Redacted.toJSON.
- Keep the production secret sink in the consumer. This package exposes a plain
  service interface and has an in-memory test sink only.
- All HTTP operations make one attempt. A failed response or secret delivery can
  leave a remote key without recorded state. Surface the key ID when known;
  never silently retry creation, infer success, or delete an unknown key.
- `scripts/generate-client.ts` reads `spec/openapi.yaml` offline. Commit both
  generator and output. `pnpm generate:check` must catch stale generated code.
- Do not publish to npm or apply a live change as part of development checks.
