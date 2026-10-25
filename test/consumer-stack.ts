// Compile-only consumer fixture; Vitest discovers only *.test.ts.
import * as Alchemy from "alchemy";
import * as Tailscale from "alchemy-tailscale";
import { Effect } from "effect";

export default Alchemy.Stack(
  "Network",
  { providers: Tailscale.providers(), state: Alchemy.localState() },
  Effect.gen(function* program() {
    const policy = yield* Tailscale.PolicyFile("Policy", { policy: { grants: [] } });
    const dns = yield* Tailscale.Dns("Dns", {
      configuration: {
        nameservers: [],
        preferences: { magicDNS: true, overrideLocalDNS: false },
        searchPaths: [],
        splitDNS: {},
      },
    });
    const device = yield* Tailscale.DeviceTags("Tags", {
      authorized: true,
      deviceId: "example-device",
      tags: ["tag:server"],
    });
    const key = yield* Tailscale.AuthKey("Key", {
      capabilities: {
        devices: { create: { ephemeral: true, preauthorized: true, tags: ["tag:server"] } },
      },
    });
    return { device, dns, key, policy };
  }),
);
