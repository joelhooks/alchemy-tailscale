import * as Plan from "alchemy/Plan";
import { AdoptPolicy } from "alchemy/AdoptPolicy";
import { Stack } from "alchemy/Stack";
import type { StackSpec } from "alchemy/Stack";
import { inMemoryState } from "alchemy/State/InMemoryState";
import { State } from "alchemy/State/State";
import { Effect, Exit, Layer, Redacted } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpResponse from "effect/http/HttpClientResponse";
import { describe, expect, it } from "vitest";
import { Credentials } from "../src/credentials.ts";
import type { Transport } from "../src/transport.ts";
import { transportLayer } from "../src/transport.ts";
import type { Providers } from "../src/resources.ts";
import { DeviceTags, Dns, PolicyFile, providerLayer } from "../src/resources.ts";

const kinds = ["PolicyFile", "Dns", "DeviceTags"] as const;
const mismatchPath = {
  DeviceTags: "tags",
  Dns: "configuration.preferences.magicDNS",
  PolicyFile: "policy.grants",
};
const mismatchMessage = (kind: Kind) =>
  `Tailscale.${kind} (Resource): adoption or drift mismatch at ${mismatchPath[kind]}; refusing to overwrite live state. Review these fields before adopting or updating.`;
type Kind = (typeof kinds)[number];
const policy = { grants: [] };
const changedPolicy = { grants: [{ dst: ["100.64.0.0/10"], ip: ["*"], src: ["tag:server"] }] };
const configuration = {
  nameservers: [],
  preferences: { magicDNS: true, overrideLocalDNS: false },
  searchPaths: ["example.com"],
  splitDNS: {},
};
const changedConfiguration = {
  ...configuration,
  preferences: { ...configuration.preferences, magicDNS: false },
};
const device = { authorized: true, id: "example-device", tags: ["tag:server"] };
const changedDevice = { ...device, tags: ["tag:server", "tag:example"] };

const declare = (kind: Kind, changed = false) =>
  Effect.gen(function* declareStack() {
    const stack: StackSpec<void> = {
      actions: {},
      bindings: {},
      name: "Fixture",
      output: undefined,
      resources: {},
      stage: "test",
    };
    yield* Effect.gen(function* resource() {
      switch (kind) {
        case "PolicyFile": {
          yield* PolicyFile("Resource", { policy: changed ? changedPolicy : policy });
          break;
        }
        case "Dns": {
          yield* Dns("Resource", { configuration: changed ? changedConfiguration : configuration });
          break;
        }
        case "DeviceTags": {
          yield* DeviceTags("Resource", {
            authorized: true,
            deviceId: "example-device",
            tags: changed ? changedDevice.tags : device.tags,
          });
          break;
        }
        default: {
          throw new Error("Unknown fixture kind");
        }
      }
    }).pipe(Effect.provideService(Stack, stack));
    return stack;
  });

const fixture = () => {
  const requests: string[] = [];
  const live: Record<Kind, unknown> = {
    DeviceTags: device,
    Dns: configuration,
    PolicyFile: policy,
  };
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(request.method);
        if (request.method !== "GET") {
          throw new Error("Plan must not write");
        }
        const path = new URL(request.url).pathname;
        let body: unknown;
        if (path.endsWith("/acl")) {
          body = live.PolicyFile;
        } else if (path.endsWith("/dns/configuration")) {
          body = live.Dns;
        } else if (path.endsWith("/example-device")) {
          body = live.DeviceTags;
        } else {
          throw new Error(`Unexpected fixture path: ${path}`);
        }
        return HttpResponse.fromWeb(
          request,
          Response.json(body, { headers: { ETag: '"example-etag"' } }),
        );
      }),
    ),
  );
  const credentials = Layer.succeed(Credentials, {
    tailnet: "example.com",
    token: () => Effect.succeed(Redacted.make("synthetic-token")),
  });
  const providers = providerLayer().pipe(
    Layer.provideMerge(transportLayer),
    Layer.provide(credentials),
    Layer.provide(http),
  );
  const run = async <A, E>(effect: Effect.Effect<A, E, Providers | Transport | State>) =>
    await Effect.runPromise(
      effect.pipe(
        Effect.provide(providers),
        Effect.provide(inMemoryState()),
        Effect.provideService(AdoptPolicy, true),
      ),
    );
  return { live, requests, run };
};

it("removing DeviceTags plans retained cleanup without reading or changing the device", async () => {
  const f = fixture();
  await f.run(
    Effect.gen(function* removeEntry() {
      const stack = yield* declare("DeviceTags");
      const original = yield* Plan.make(stack);
      const adopted = original.resources.Resource;
      if (adopted?.action !== "adopted") {
        throw new Error("Expected adopted fixture");
      }
      const store = yield* yield* State;
      yield* store.set({ fqn: "Resource", stack: "Fixture", stage: "test", value: adopted.state });
      const before = f.requests.length;
      const removed = yield* Plan.make({ ...stack, resources: {} });
      expect(removed.deletions.Resource?.state.removalPolicy).toBe("retain");
      expect(f.requests).toHaveLength(before);
    }),
  );
});

// The actual beta.84 Plan engine drives provider.read and provider.diff. This
// catches regressions that direct reconcile tests cannot see.
describe.each(kinds)("%s engine planning", (kind) => {
  it("plans exact cold adoption as adopted, without writes or persisting state", async () => {
    const f = fixture();
    await f.run(
      Effect.gen(function* exactAdopt() {
        const stack = yield* declare(kind);
        const plan = yield* Plan.make(stack);
        expect(plan.resources.Resource?.action).toBe("adopted");
        const store = yield* yield* State;
        expect(yield* store.list({ stack: "Fixture", stage: "test" })).toEqual([]);
      }),
    );
    expect(f.requests.length).toBeGreaterThan(0);
    expect(f.requests.every((method) => method === "GET")).toBe(true);
  });
  it("fails a drifted cold adoption with the typed mismatch instead of labelling it adopted", async () => {
    const f = fixture();
    const exit = await f.run(
      Effect.gen(function* driftedAdopt() {
        const stack = yield* declare(kind, true);
        return yield* Plan.make(stack).pipe(Effect.exit);
      }),
    );
    expect(Exit.findErrorOption(exit)).toMatchObject({
      _tag: "Some",
      value: {
        _tag: "AdoptionMismatch",
        id: "Resource",
        message: mismatchMessage(kind),
        paths: [mismatchPath[kind]],
      },
    });
    expect(f.requests.every((method) => method === "GET")).toBe(true);
  });
  it("keeps a normal owned change as update", async () => {
    const f = fixture();
    await f.run(
      Effect.gen(function* ownedUpdate() {
        const original = yield* Plan.make(yield* declare(kind));
        const adopted = original.resources.Resource;
        if (adopted?.action !== "adopted") {
          throw new Error("Expected adopted fixture");
        }
        const store = yield* yield* State;
        yield* store.set({
          fqn: "Resource",
          stack: "Fixture",
          stage: "test",
          value: adopted.state,
        });
        const plan = yield* Plan.make(yield* declare(kind, true));
        expect(plan.resources.Resource?.action).toBe("update");
      }),
    );
    expect(f.requests.every((method) => method === "GET")).toBe(true);
  });
  it.each([false, true])(
    "fails owned live drift even with changed desired props = %s",
    async (changed) => {
      const f = fixture();
      const exit = await f.run(
        Effect.gen(function* ownedDrift() {
          const original = yield* Plan.make(yield* declare(kind));
          const adopted = original.resources.Resource;
          if (adopted?.action !== "adopted") {
            throw new Error("Expected adopted fixture");
          }
          const store = yield* yield* State;
          yield* store.set({
            fqn: "Resource",
            stack: "Fixture",
            stage: "test",
            value: adopted.state,
          });
          f.live[kind] = {
            DeviceTags: changedDevice,
            Dns: changedConfiguration,
            PolicyFile: changedPolicy,
          }[kind];
          return yield* Plan.make(yield* declare(kind, changed)).pipe(Effect.exit);
        }),
      );
      expect(Exit.findErrorOption(exit)).toMatchObject({
        _tag: "Some",
        value: {
          _tag: "AdoptionMismatch",
          id: "Resource",
          message: mismatchMessage(kind),
          paths: [mismatchPath[kind]],
        },
      });
      expect(f.requests.every((method) => method === "GET")).toBe(true);
    },
  );
});
