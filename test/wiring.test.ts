import * as Tailscale from "alchemy-tailscale";
import { noopSession } from "alchemy/Report";
import { encodeState } from "alchemy/State/StateEncoding";
import type { Redacted } from "effect";
import { ConfigProvider, Effect, Layer } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { expect, it } from "vitest";

it("the built package wires provider lifecycle transports and the explicit secret sink", async () => {
  const requests: string[] = [];
  const captured: Redacted.Redacted[] = [];
  const secret = "tskey-auth-synthetic-wiring-only";
  // An in-memory fetch adapter only: the public providers() layer is exercised,
  // but no socket is opened and no environment credentials are consulted.
  const fetch: typeof globalThis.fetch = async (input) => {
    requests.push(input instanceof Request ? input.url : input.toString());
    return await Promise.resolve(Response.json({ id: "example-key", key: secret }));
  };
  const sink = Layer.succeed(Tailscale.AuthKeySecrets, {
    capture: (_id, value) =>
      Effect.sync(() => {
        captured.push(value);
      }),
  });
  const result: unknown = await Effect.runPromise(
    Effect.gen(function* wiring() {
      const collection = yield* Tailscale.Providers;
      expect(Object.keys(collection.providers).toSorted()).toEqual([
        "Tailscale.AuthKey",
        "Tailscale.DeviceTags",
        "Tailscale.Dns",
        "Tailscale.PolicyFile",
      ]);
      const provider = collection.get("Tailscale.AuthKey");
      if (!provider) {
        throw new Error("Missing AuthKey provider");
      }
      return yield* provider.reconcile({
        bindings: [],
        fqn: "Network/Key",
        id: "Key",
        instanceId: "example-instance",
        news: { capabilities: { devices: { create: { tags: ["tag:server"] } } } },
        olds: undefined,
        output: undefined,
        session: { ...noopSession, note: () => Effect.void },
      });
    }).pipe(
      Effect.provide(Tailscale.providers().pipe(Layer.provideMerge(sink))),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            TAILSCALE_API_KEY: "synthetic-token",
            TAILSCALE_TAILNET: "-",
          }),
        ),
      ),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    ),
  );
  expect(result).toEqual({ id: "example-key", tailnet: "-" });
  expect(requests).toEqual(["https://api.tailscale.com/api/v2/tailnet/-/keys"]);
  expect(captured).toHaveLength(1);
  expect(JSON.stringify(encodeState(result))).not.toContain(secret);
});
