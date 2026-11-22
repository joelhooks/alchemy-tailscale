import * as Plan from "alchemy/Plan";
import * as Apply from "alchemy/Apply";
import { Stage } from "alchemy/Stage";
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
import type { Providers, SettingsProps } from "../src/resources.ts";
import { DeviceTags, Dns, PolicyFile, providerLayer, Settings } from "../src/resources.ts";

const kinds = ["PolicyFile", "Dns", "DeviceTags", "Settings"] as const;
const mismatchPath = {
  DeviceTags: "tags",
  Dns: "configuration.preferences.magicDNS",
  PolicyFile: "policy.grants",
  Settings: "settings.devicesAutoUpdatesOn",
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

const settings: SettingsProps["settings"] = {
  adminConsoleSessionTimeoutMinutes: 45,
  devicesAutoUpdatesOn: true,
  usersApprovalOn: null,
};
const changedSettings = { ...settings, devicesAutoUpdatesOn: false };
const liveSettings = { ...settings, regionalRoutingOn: true };

const declare = (
  kind: Kind,
  changed = false,
  desiredSettings = changed ? changedSettings : settings,
) =>
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
        case "Settings": {
          yield* Settings("Resource", { settings: desiredSettings });
          break;
        }
        default: {
          const unreachable: never = kind;
          throw new Error(`Unknown fixture kind: ${String(unreachable)}`);
        }
      }
    }).pipe(Effect.provideService(Stack, stack));
    return stack;
  });

const fixture = (allowSettingsPatch = false) => {
  const requests: string[] = [];
  const patches: unknown[] = [];
  const live: Record<Kind, unknown> = {
    DeviceTags: device,
    Dns: configuration,
    PolicyFile: policy,
    Settings: liveSettings,
  };
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(request.method);
        const path = new URL(request.url).pathname;
        if (
          allowSettingsPatch &&
          request.method === "PATCH" &&
          path === "/api/v2/tailnet/example.com/settings" &&
          request.body._tag === "Uint8Array"
        ) {
          const body: unknown = JSON.parse(new TextDecoder().decode(request.body.body));
          patches.push(body);
          live.Settings = { ...changedSettings, regionalRoutingOn: false };
          return HttpResponse.fromWeb(request, Response.json(live.Settings));
        }
        if (request.method !== "GET") {
          throw new Error("Unexpected fixture write");
        }
        let body: unknown;
        if (path.endsWith("/acl")) {
          body = live.PolicyFile;
        } else if (path.endsWith("/dns/configuration")) {
          body = live.Dns;
        } else if (path.endsWith("/example-device")) {
          body = live.DeviceTags;
        } else if (path === "/api/v2/tailnet/example.com/settings") {
          body = live.Settings;
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
  return { live, patches, requests, run };
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

const applySettings = (stack: StackSpec<void>, plan: Plan.Plan) =>
  Apply.apply(plan).pipe(Effect.provideService(Stack, stack), Effect.provideService(Stage, "test"));

it("applies Settings adoption with no write, then patches only changed writable fields", async () => {
  const f = fixture(true);
  await f.run(
    Effect.gen(function* updateSettings() {
      const initial = yield* declare("Settings");
      const adoption = yield* Plan.make(initial);
      expect(adoption.resources.Resource?.action).toBe("adopted");
      yield* applySettings(initial, adoption);
      expect(f.requests.every((method) => method === "GET")).toBe(true);

      // Drift in the deprecated, read-only projection does not affect ownership.
      f.live.Settings = { ...settings, regionalRoutingOn: false };
      const updated = yield* declare("Settings", true);
      const plan = yield* Plan.make(updated);
      expect(plan.resources.Resource?.action).toBe("update");
      const beforeApply = f.requests.length;
      yield* applySettings(updated, plan);
      expect(f.requests.slice(beforeApply)).toEqual(["GET", "PATCH"]);
      expect(f.patches).toEqual([{ devicesAutoUpdatesOn: false }]);
      expect((yield* Plan.make(updated)).resources.Resource?.action).toBe("noop");

      const beforeRemoval = f.requests.length;
      const empty = { ...updated, resources: {} };
      const removal = yield* Plan.make(empty);
      expect(removal.deletions.Resource?.state.removalPolicy).toBe("retain");
      yield* applySettings(empty, removal);
      expect(f.requests).toHaveLength(beforeRemoval);
    }),
  );
});

it.each(["adopted", "update"])(
  "refuses Settings drift between %s plan and apply",
  async (action) => {
    const f = fixture();
    const exit = await f.run(
      Effect.gen(function* driftBeforeApply() {
        const initial = yield* declare("Settings");
        const adoption = yield* Plan.make(initial);
        const stack = action === "adopted" ? initial : yield* declare("Settings", true);
        if (action === "update") {
          yield* applySettings(initial, adoption);
        }
        const plan = action === "adopted" ? adoption : yield* Plan.make(stack);
        expect(plan.resources.Resource?.action).toBe(action);
        // For the owned update, live now equals the new desired state but differs
        // from the old state: this still counts as an out-of-band edit.
        f.live.Settings = changedSettings;
        return yield* applySettings(stack, plan).pipe(Effect.exit);
      }),
    );
    expect(Exit.findErrorOption(exit)).toMatchObject({
      _tag: "Some",
      value: { _tag: "AdoptionMismatch", paths: [mismatchPath.Settings] },
    });
    expect(f.requests.every((method) => method === "GET")).toBe(true);
  },
);

it("rejects read-only Settings input even when it arrives through a typed variable", async () => {
  const f = fixture();
  const exit = await f.run(
    Effect.gen(function* readOnlyInput() {
      const stack = yield* declare("Settings", false, liveSettings);
      return yield* Plan.make(stack).pipe(Effect.exit);
    }),
  );
  expect(Exit.findErrorOption(exit)).toMatchObject({
    _tag: "Some",
    value: { _tag: "InvalidSettingsProps" },
  });
  expect(f.requests.every((method) => method === "GET")).toBe(true);
});

it("refuses Settings omissions rather than guessing how to reset a field", async () => {
  const f = fixture();
  const exit = await f.run(
    Effect.gen(function* omittedField() {
      const initial = yield* declare("Settings");
      yield* applySettings(initial, yield* Plan.make(initial));
      const stack = yield* declare("Settings", false, {
        adminConsoleSessionTimeoutMinutes: 45,
        devicesAutoUpdatesOn: true,
      });
      return yield* Plan.make(stack).pipe(Effect.exit);
    }),
  );
  expect(Exit.findErrorOption(exit)).toMatchObject({
    _tag: "Some",
    value: { _tag: "UnsafeSettingsOmission", paths: ["settings.usersApprovalOn"] },
  });
  expect(f.requests.every((method) => method === "GET")).toBe(true);
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
            Settings: { ...changedSettings, regionalRoutingOn: true },
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
