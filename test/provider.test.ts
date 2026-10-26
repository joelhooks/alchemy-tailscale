import { readFileSync } from "node:fs";
import { ConfigProvider, Effect, Layer, Redacted, Schema } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpResponse from "effect/http/HttpClientResponse";
import type { HttpClientRequest } from "effect/http/HttpClientRequest";
import { encodeState } from "alchemy/State/StateEncoding";
import { Unowned } from "alchemy/AdoptPolicy";
import { describe, expect, it } from "vitest";
import { Credentials, credentialsFromEnvironment } from "../src/credentials.ts";
import type { Transport } from "../src/transport.ts";
import { transportLayer } from "../src/transport.ts";
import { ApiError, SecretDeliveryFailed } from "../src/errors.ts";
import {
  AuthKeySecrets,
  authKeyService,
  deviceTagsService,
  dnsService,
  policyFileService,
} from "../src/resources.ts";
import * as Api from "../src/generated/client.ts";

const fixtures = Schema.decodeUnknownSync(
  Schema.Struct({
    device: Api.Device,
    dns: Api.DnsConfiguration,
    key: Schema.Struct({
      ...Api.Key.fields,
      id: Schema.NonEmptyString,
      key: Schema.NonEmptyString,
    }),
    policy: Api.getPolicyFileOutput,
    validationFailure: Api.validateAndTestPolicyFileOutput,
  }),
)(JSON.parse(readFileSync(new URL("fixtures/responses.json", import.meta.url), "utf-8")));
interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}
const fake = (replies: Reply[]) => {
  const requests: HttpClientRequest[] = [];
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(request);
        const reply = replies.shift();
        if (!reply) {
          throw new Error(`Unexpected request: ${request.method} ${request.url}`);
        }
        return HttpResponse.fromWeb(
          request,
          new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
            headers: reply.headers ?? {},
            status: reply.status ?? 200,
          }),
        );
      }),
    ),
  );
  const credentials = Layer.succeed(Credentials, {
    tailnet: "example.com",
    token: () => Effect.succeed(Redacted.make("synthetic-api-token")),
  });
  const transport = transportLayer.pipe(Layer.provide(http), Layer.provide(credentials));
  const run = async <A, E>(effect: Effect.Effect<A, E, Transport | Credentials>) =>
    await Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(transport, credentials))));
  return { http, requests, run };
};
const livePolicy = () => ({
  etag: '"example-etag"',
  policy: fixtures.policy,
  tailnet: "example.com",
});
const policyReply = () => ({ body: fixtures.policy, headers: { ETag: '"example-etag"' } });
const desiredPolicy = {
  policy: {
    ...fixtures.policy,
    grants: [{ dst: ["100.64.0.0/10"], ip: ["*"], src: ["tag:server"] }],
  },
};
const oldPolicy = () => ({ policy: fixtures.policy });
const oldDns = () => ({ configuration: fixtures.dns });
const deviceProps = { authorized: true, deviceId: "example-device", tags: ["tag:server"] };
const deviceOutput = { ...deviceProps };
const authProps = {
  capabilities: {
    devices: { create: { ephemeral: true, preauthorized: true, tags: ["tag:server"] } },
  },
};

// Every request goes through the real generated client and transport with a
// fixture-only Effect HttpClient. No socket, credentials or live API is used.
describe("PolicyFile", () => {
  it("marks cold reads Unowned; an exact cold adoption is read-only even with output and olds undefined", async () => {
    const f = fake([policyReply(), policyReply()]);
    const result = await f.run(
      Effect.gen(function* result() {
        const service = yield* policyFileService;
        const observed = yield* service.read({ output: undefined });
        expect(Unowned.is(observed)).toBe(true);
        return yield* service.reconcile({ news: oldPolicy(), olds: undefined, output: observed });
      }),
    );
    expect(result.policy).toEqual(fixtures.policy);
    expect(f.requests.map((r) => r.method)).toEqual(["GET", "GET"]);
  });
  it.each([undefined, livePolicy()])(
    "refuses a first mismatch regardless of observed output",
    async (output) => {
      const f = fake([policyReply()]);
      const error = await f.run(
        Effect.gen(function* error() {
          const service = yield* policyFileService;
          return yield* service
            .reconcile({ news: desiredPolicy, olds: undefined, output })
            .pipe(Effect.flip);
        }),
      );
      expect(error._tag).toBe("AdoptionMismatch");
      expect(error.message).toContain(
        "Tailscale.PolicyFile: adoption or drift mismatch at policy.grants",
      );
      expect(f.requests.map((r) => r.method)).toEqual(["GET"]);
    },
  );
  it("reports policy map paths and logical id, never policy values", async () => {
    const f = fake([policyReply()]);
    const error = await f.run(
      Effect.gen(function* error() {
        const service = yield* policyFileService;
        return yield* service
          .reconcile({
            id: "LogicalPolicy",
            news: {
              policy: {
                ...fixtures.policy,
                tagOwners: { "tag:server": ["private-owner@example.net"] },
              },
            },
            olds: undefined,
            output: undefined,
          })
          .pipe(Effect.flip);
      }),
    );
    expect(error.message).toContain(
      'Tailscale.PolicyFile (LogicalPolicy): adoption or drift mismatch at policy.tagOwners["tag:server"]',
    );
    expect(error.message).not.toContain("private-owner");
    expect(JSON.stringify(error)).not.toContain("private-owner");
    expect(JSON.stringify(error)).not.toContain("user@example.com");
    expect(f.requests.map((r) => r.method)).toEqual(["GET"]);
  });
  it("validates before writing and sends exactly the read ETag", async () => {
    const f = fake([
      policyReply(),
      { body: {} },
      { body: desiredPolicy.policy, headers: { ETag: '"new-etag"' } },
    ]);
    const result = await f.run(
      Effect.gen(function* result() {
        const service = yield* policyFileService;
        return yield* service.reconcile({
          news: desiredPolicy,
          olds: oldPolicy(),
          output: livePolicy(),
        });
      }),
    );
    expect(result.policy).toEqual(desiredPolicy.policy);
    expect(f.requests.map((r) => [r.method, new URL(r.url).pathname])).toEqual([
      ["GET", "/api/v2/tailnet/example.com/acl"],
      ["POST", "/api/v2/tailnet/example.com/acl/validate"],
      ["POST", "/api/v2/tailnet/example.com/acl"],
    ]);
    expect(f.requests[2]?.headers["if-match"]).toBe('"example-etag"');
  });
  it("stops after one 412; never retries validation or the write", async () => {
    const f = fake([policyReply(), { body: {} }, { body: { message: "conflict" }, status: 412 }]);
    const error = await f.run(
      Effect.gen(function* error() {
        const service = yield* policyFileService;
        return yield* service
          .reconcile({ news: desiredPolicy, olds: oldPolicy(), output: livePolicy() })
          .pipe(Effect.flip);
      }),
    );
    expect(error._tag).toBe("PreconditionFailed");
    expect(f.requests).toHaveLength(3);
  });
  it.each([
    { body: fixtures.validationFailure },
    { body: { message: "bad policy" }, status: 400 },
    { body: { unexpectedDiagnostic: true } },
  ])("blocks writes on failed or unknown validation diagnostics", async (reply) => {
    const f = fake([policyReply(), reply]);
    const error = await f.run(
      Effect.gen(function* error() {
        const service = yield* policyFileService;
        return yield* service
          .reconcile({ news: desiredPolicy, olds: oldPolicy(), output: livePolicy() })
          .pipe(Effect.flip);
      }),
    );
    expect(error._tag).toBe("PolicyValidationFailed");
    expect(f.requests).toHaveLength(2);
  });
  it("accepts an empty validation body", async () => {
    const f = fake([policyReply(), {}, { body: desiredPolicy.policy }]);
    await f.run(
      Effect.gen(function* program() {
        const service = yield* policyFileService;
        return yield* service.reconcile({
          news: desiredPolicy,
          olds: oldPolicy(),
          output: livePolicy(),
        });
      }),
    );
    expect(f.requests).toHaveLength(3);
  });
  it("refuses a missing ETag before validation or writing", async () => {
    const f = fake([{ body: fixtures.policy }]);
    const error = await f.run(
      Effect.gen(function* error() {
        const service = yield* policyFileService;
        return yield* service
          .reconcile({ news: desiredPolicy, olds: oldPolicy(), output: livePolicy() })
          .pipe(Effect.flip);
      }),
    );
    expect(error._tag).toBe("MissingEtag");
    expect(f.requests).toHaveLength(1);
  });
  it("refuses external drift instead of overwriting it", async () => {
    const f = fake([{ body: { grants: [] }, headers: { ETag: '"drift"' } }]);
    const error = await f.run(
      Effect.gen(function* error() {
        const service = yield* policyFileService;
        return yield* service
          .reconcile({ news: desiredPolicy, olds: oldPolicy(), output: livePolicy() })
          .pipe(Effect.flip);
      }),
    );
    expect(error._tag).toBe("AdoptionMismatch");
    expect(error.message).toContain(
      "Tailscale.PolicyFile: adoption or drift mismatch at policy.tagOwners",
    );
    expect(f.requests).toHaveLength(1);
  });
  it("retains on delete", async () => {
    const f = fake([]);
    await f.run(
      Effect.gen(function* program() {
        const service = yield* policyFileService;
        yield* service.delete();
      }),
    );
    expect(f.requests).toHaveLength(0);
  });
});

describe("Dns", () => {
  it("adopts matching configuration without writing", async () => {
    const f = fake([{ body: fixtures.dns }]);
    const output = await f.run(
      Effect.gen(function* output() {
        const service = yield* dnsService;
        return yield* service.reconcile({ news: oldDns(), olds: undefined, output: undefined });
      }),
    );
    expect(output.configuration).toEqual(fixtures.dns);
    expect(f.requests.map((r) => r.method)).toEqual(["GET"]);
  });
  it("refuses an adoption mismatch", async () => {
    const f = fake([{ body: fixtures.dns }]);
    const error = await f.run(
      Effect.gen(function* error() {
        const service = yield* dnsService;
        return yield* service
          .reconcile({
            news: { configuration: { searchPaths: [] } },
            olds: undefined,
            output: undefined,
          })
          .pipe(Effect.flip);
      }),
    );
    expect(error._tag).toBe("AdoptionMismatch");
    expect(error.message).toContain("Tailscale.Dns: adoption or drift mismatch at configuration.");
    expect(error.message).toContain("configuration.searchPaths");
    expect(error.message).not.toContain("example.com");
    expect(f.requests).toHaveLength(1);
  });
  it("refuses even owned changes until the API supports conditional writes", async () => {
    const f = fake([{ body: fixtures.dns }]);
    const error = await f.run(
      Effect.gen(function* error() {
        const service = yield* dnsService;
        return yield* service
          .reconcile({
            news: { configuration: { searchPaths: [] } },
            olds: oldDns(),
            output: { tailnet: "example.com", ...oldDns() },
          })
          .pipe(Effect.flip);
      }),
    );
    expect(error._tag).toBe("UnsafeDnsWrite");
    expect(f.requests.map((r) => r.method)).toEqual(["GET"]);
  });
  it("retains on delete", async () => {
    const f = fake([]);
    await f.run(
      Effect.gen(function* program() {
        const service = yield* dnsService;
        yield* service.delete();
      }),
    );
    expect(f.requests).toHaveLength(0);
  });
});

describe("DeviceTags", () => {
  it("adopts matching tags and authorization without writing", async () => {
    const f = fake([{ body: fixtures.device }]);
    const result = await f.run(
      Effect.gen(function* result() {
        const service = yield* deviceTagsService;
        return yield* service.reconcile({ news: deviceProps, olds: undefined, output: undefined });
      }),
    );
    expect(result).toEqual(deviceOutput);
    expect(f.requests.map((r) => r.method)).toEqual(["GET"]);
  });
  it("refuses mismatching initial tags", async () => {
    const f = fake([{ body: fixtures.device }]);
    const error = await f.run(
      Effect.gen(function* error() {
        const service = yield* deviceTagsService;
        return yield* service
          .reconcile({ news: { ...deviceProps, tags: [] }, olds: undefined, output: deviceOutput })
          .pipe(Effect.flip);
      }),
    );
    expect(error._tag).toBe("AdoptionMismatch");
    expect(error.message).toContain("Tailscale.DeviceTags: adoption or drift mismatch at tags");
    expect(error.message).not.toContain("tag:server");
    expect(f.requests).toHaveLength(1);
  });
  it("reports both tag and authorization drift without tag values", async () => {
    const f = fake([{ body: fixtures.device }]);
    const error = await f.run(
      Effect.gen(function* error() {
        const service = yield* deviceTagsService;
        return yield* service
          .reconcile({
            id: "LogicalDevice",
            news: { ...deviceProps, authorized: false, tags: ["tag:private-value"] },
            olds: undefined,
            output: undefined,
          })
          .pipe(Effect.flip);
      }),
    );
    expect(error.message).toContain(
      "Tailscale.DeviceTags (LogicalDevice): adoption or drift mismatch at tags, authorized",
    );
    expect(JSON.stringify(error)).not.toContain("tag:private-value");
    expect(error.message).not.toContain("true");
    expect(error.message).not.toContain("false");
    expect(f.requests.map((r) => r.method)).toEqual(["GET"]);
  });
  it("adopts reordered tags and ignores unspecified authorization", async () => {
    const f = fake([{ body: { ...fixtures.device, tags: ["tag:server", "tag:example"] } }]);
    await f.run(
      Effect.gen(function* adopt() {
        const service = yield* deviceTagsService;
        return yield* service.reconcile({
          news: { deviceId: "example-device", tags: ["tag:example", "tag:server"] },
          olds: undefined,
          output: undefined,
        });
      }),
    );
    expect(f.requests.map((r) => r.method)).toEqual(["GET"]);
  });
  it("refuses to create a missing device", async () => {
    const f = fake([{ status: 404 }]);
    const error = await f.run(
      Effect.gen(function* error() {
        const service = yield* deviceTagsService;
        return yield* service
          .reconcile({ news: deviceProps, olds: undefined, output: undefined })
          .pipe(Effect.flip);
      }),
    );
    expect(error).toMatchObject({ _tag: "DeviceLifecycleRefused", operation: "create" });
    expect(f.requests.map((r) => r.method)).toEqual(["GET"]);
  });
  it("retains the device and its tags on removal without any API request", async () => {
    const f = fake([]);
    await f.run(
      Effect.gen(function* retainDevice() {
        const service = yield* deviceTagsService;
        yield* service.delete();
      }),
    );
    expect(f.requests).toHaveLength(0);
  });
  it("updates only tags and authorization of the existing device", async () => {
    const f = fake([
      { body: fixtures.device },
      {},
      {},
      { body: { ...fixtures.device, authorized: false, tags: [] } },
    ]);
    const result = await f.run(
      Effect.gen(function* result() {
        const service = yield* deviceTagsService;
        return yield* service.reconcile({
          news: { ...deviceProps, authorized: false, tags: [] },
          olds: deviceProps,
          output: deviceOutput,
        });
      }),
    );
    expect(result).toMatchObject({ authorized: false, tags: [] });
    expect(f.requests.map((r) => [r.method, new URL(r.url).pathname])).toEqual([
      ["GET", "/api/v2/device/example-device"],
      ["POST", "/api/v2/device/example-device/tags"],
      ["POST", "/api/v2/device/example-device/authorized"],
      ["GET", "/api/v2/device/example-device"],
    ]);
  });
});

describe("AuthKey", () => {
  it("delivers a Redacted secret once; JSON and actual Alchemy state encoding contain no secret", async () => {
    const f = fake([{ body: fixtures.key }]);
    const captured: Redacted.Redacted[] = [];
    const result = await f.run(
      Effect.gen(function* result() {
        const service = yield* authKeyService;
        const created = yield* service.reconcile({
          news: authProps,
          olds: undefined,
          output: undefined,
        });
        const unchanged = yield* service.reconcile({
          news: authProps,
          olds: authProps,
          output: created,
        });
        expect(unchanged).toEqual(created);
        return created;
      }).pipe(
        Effect.provideService(AuthKeySecrets, {
          capture: (_id, secret) =>
            Effect.sync(() => {
              captured.push(secret);
            }),
        }),
      ),
    );
    expect(captured).toHaveLength(1);
    expect(Redacted.isRedacted(captured[0])).toBe(true);
    expect(JSON.stringify(captured)).not.toContain(fixtures.key.key);
    expect(JSON.stringify(result)).not.toContain(fixtures.key.key);
    expect(JSON.stringify(encodeState(result))).not.toContain(fixtures.key.key);
    expect(f.requests).toHaveLength(1);
  });
  it("refuses before minting when no secret sink is wired", async () => {
    const f = fake([]);
    const error = await f.run(
      Effect.gen(function* error() {
        const service = yield* authKeyService;
        return yield* service
          .reconcile({ news: authProps, olds: undefined, output: undefined })
          .pipe(Effect.flip);
      }),
    );
    expect(error).toMatchObject({ _tag: "SecretDeliveryFailed", keyId: "not-created" });
    expect(f.requests).toHaveLength(0);
  });
  it("reports a failed sink without returning a key in the error", async () => {
    const f = fake([{ body: fixtures.key }]);
    const error = await f.run(
      Effect.gen(function* error() {
        const service = yield* authKeyService;
        return yield* service
          .reconcile({ news: authProps, olds: undefined, output: undefined })
          .pipe(Effect.flip);
      }).pipe(
        Effect.provideService(AuthKeySecrets, {
          capture: (id) => Effect.fail(new SecretDeliveryFailed({ keyId: id })),
        }),
      ),
    );
    expect(error._tag).toBe("SecretDeliveryFailed");
    expect(JSON.stringify(error)).not.toContain(fixtures.key.key);
    expect(f.requests).toHaveLength(1);
  });
  it("reads metadata only and revokes keys, tolerating already-revoked keys", async () => {
    const f = fake([{ body: fixtures.key }, { status: 404 }]);
    const output = { id: fixtures.key.id, tailnet: "example.com" };
    const result = await f.run(
      Effect.gen(function* result() {
        const service = yield* authKeyService;
        const metadata = yield* service.read({ output });
        yield* service.delete({ output });
        return metadata;
      }),
    );
    expect(JSON.stringify(encodeState(result))).not.toContain(fixtures.key.key);
    expect(f.requests.map((r) => r.method)).toEqual(["GET", "DELETE"]);
  });
});

describe("transport and environment auth", () => {
  it("supports API key auth and the '-' tailnet identifier", async () => {
    const f = fake([{ body: {} }]);
    await Effect.runPromise(
      Api.getPolicyFile({ tailnet: "-" }).pipe(
        Effect.provide(
          transportLayer.pipe(Layer.provide(credentialsFromEnvironment), Layer.provide(f.http)),
        ),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              TAILSCALE_API_KEY: "synthetic-token",
              TAILSCALE_TAILNET: "-",
            }),
          ),
        ),
      ),
    );
    expect(f.requests[0]?.headers.authorization).toBe("Bearer synthetic-token");
    expect(new URL(f.requests[0]?.url ?? "").pathname).toBe("/api/v2/tailnet/-/acl");
  });
  it("exchanges OAuth client credentials, then uses the access token", async () => {
    const f = fake([{ body: { access_token: "synthetic-access-token" } }, { body: {} }]);
    await Effect.runPromise(
      Api.getPolicyFile({ tailnet: "-" }).pipe(
        Effect.provide(
          transportLayer.pipe(Layer.provide(credentialsFromEnvironment), Layer.provide(f.http)),
        ),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              TAILSCALE_OAUTH_CLIENT_ID: "synthetic-client",
              TAILSCALE_OAUTH_CLIENT_SECRET: "synthetic-secret",
              TAILSCALE_TAILNET: "-",
            }),
          ),
        ),
      ),
    );
    expect(new URL(f.requests[0]?.url ?? "").pathname).toBe("/api/v2/oauth/token");
    expect(f.requests[0]?.headers["content-type"]).toContain("application/x-www-form-urlencoded");
    expect(f.requests[1]?.headers.authorization).toBe("Bearer synthetic-access-token");
  });
  it("decodes untrusted payloads and does not expose response bodies in errors", async () => {
    const f = fake([{ body: { tags: 12 } }, { body: { key: fixtures.key.key }, status: 403 }]);
    const errors = await f.run(
      Effect.gen(function* errors() {
        const invalid = yield* Api.getDevice({ deviceId: "example-device" }).pipe(Effect.flip);
        const denied = yield* Api.getDevice({ deviceId: "example-device" }).pipe(Effect.flip);
        return [invalid, denied];
      }),
    );
    expect(errors[0]?._tag).toBe("InvalidResponse");
    expect(errors[1]).toEqual(new ApiError({ status: 403 }));
    expect(JSON.stringify(errors)).not.toContain(fixtures.key.key);
  });
  it("ignores successful bodies for operations documented without a response body", async () => {
    const f = fake([{ body: {} }]);
    await f.run(Api.deleteKey({ keyId: "example-key", tailnet: "example.com" }));
    expect(f.requests.map((r) => r.method)).toEqual(["DELETE"]);
  });
  it("fixtures satisfy the generated schemas", () => {
    expect(() => Schema.decodeUnknownSync(Api.Key)(fixtures.key)).not.toThrow();
    expect(() => Schema.decodeUnknownSync(Api.Device)(fixtures.device)).not.toThrow();
    expect(() => Schema.decodeUnknownSync(Api.DnsConfiguration)(fixtures.dns)).not.toThrow();
  });
});
