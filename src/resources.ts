// Alchemy resources intentionally share a type/value name; services share a module.
// Effect's `return yield* fail(...)` is a terminal typed failure, not a return value.
/* oxlint-disable no-redeclare, max-classes-per-file, typescript/consistent-return, unicorn/no-useless-undefined */
import { Context, Effect, Layer, Option, Redacted } from "effect";
import { Resource } from "alchemy/Resource";
import * as Provider from "alchemy/Provider";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import { Credentials } from "./credentials.ts";
import type { Transport } from "./transport.ts";
import * as Api from "./generated/client.ts";
import {
  AdoptionMismatch,
  DeviceLifecycleRefused,
  InvalidResponse,
  KeyReplacementRequired,
  MissingEtag,
  PolicyValidationFailed,
  SecretDeliveryFailed,
  UnsafeDnsWrite,
} from "./errors.ts";

export class Providers extends Provider.ProviderCollection<Providers>()("Tailscale") {}
export interface PolicyFileProps {
  readonly policy: Api.setPolicyFileInput;
}
export interface PolicyFileAttributes {
  readonly tailnet: string;
  readonly policy: Api.getPolicyFileOutput;
  readonly etag: string | undefined;
}
export type PolicyFile = Resource<
  "Tailscale.PolicyFile",
  PolicyFileProps,
  PolicyFileAttributes,
  never,
  Providers
>;
export const PolicyFile = Resource<PolicyFile>("Tailscale.PolicyFile", {
  defaultRemovalPolicy: "retain",
});

export interface DnsProps {
  readonly configuration: Api.DnsConfiguration;
}
export interface DnsAttributes {
  readonly tailnet: string;
  readonly configuration: Api.DnsConfiguration;
}
export type Dns = Resource<"Tailscale.Dns", DnsProps, DnsAttributes, never, Providers>;
export const Dns = Resource<Dns>("Tailscale.Dns", { defaultRemovalPolicy: "retain" });

export interface DeviceTagsProps {
  readonly deviceId: string;
  readonly tags: readonly string[];
  readonly authorized?: boolean;
}
export interface DeviceTagsAttributes {
  readonly deviceId: string;
  readonly tags: readonly string[];
  readonly authorized: boolean;
}
export type DeviceTags = Resource<
  "Tailscale.DeviceTags",
  DeviceTagsProps,
  DeviceTagsAttributes,
  never,
  Providers
>;
export const DeviceTags = Resource<DeviceTags>("Tailscale.DeviceTags", {
  defaultRemovalPolicy: "retain",
});

export type AuthKeyProps = Pick<
  Api.createKeyInput,
  "description" | "capabilities" | "expirySeconds"
>;
export interface AuthKeyAttributes {
  readonly tailnet: string;
  readonly id: string;
  readonly created?: string;
  readonly expires?: string;
}
export type AuthKey = Resource<
  "Tailscale.AuthKey",
  AuthKeyProps,
  AuthKeyAttributes,
  never,
  Providers
>;
export const AuthKey = Resource<AuthKey>("Tailscale.AuthKey");

// A sink is deliberately outside resource props/state. Alchemy's encodeState
// unwraps Redacted values, so putting one in attributes would persist plaintext.
export class AuthKeySecrets extends Context.Service<
  AuthKeySecrets,
  {
    readonly capture: (
      id: string,
      secret: Redacted.Redacted,
    ) => Effect.Effect<void, SecretDeliveryFailed>;
  }
>()("Tailscale.AuthKeySecrets") {}

const mismatch = (resource: string) => Effect.fail(new AdoptionMismatch({ resource }));
const sameTags = (left: readonly string[], right: readonly string[]) =>
  deepEqual(left.toSorted(), right.toSorted());
const deviceMatches = (props: DeviceTagsProps | undefined, live: DeviceTagsAttributes) =>
  props !== undefined &&
  props.deviceId === live.deviceId &&
  sameTags(props.tags, live.tags) &&
  (props.authorized === undefined || props.authorized === live.authorized);

export const policyFileService = Effect.gen(function* policyFileService() {
  const { tailnet } = yield* Credentials;
  const observe = Effect.fn("PolicyFile.observe")(function* observe() {
    const current = yield* Api.getPolicyFile({ tailnet });
    return { etag: current.etag, policy: current.body, tailnet };
  });
  return {
    delete: () => Effect.void,
    diff: Effect.fn("PolicyFile.diff")(function* policyDiff({ news, olds, output }) {
      if (!isResolved(news)) {
        return;
      }
      if (output && deepEqual(olds, news) && !deepEqual(news.policy, output.policy)) {
        return yield* mismatch("PolicyFile");
      }
      // Normal created/updated rows carry recorded attributes, not a fresh read.
      // Observe here as well, so an owned plan cannot hide external drift.
      const live = yield* observe();
      if (!deepEqual(olds?.policy, live.policy)) {
        return yield* mismatch("PolicyFile drift");
      }
      if (!deepEqual(news.policy, live.policy)) {
        return { action: "update" } as const;
      }
    }),
    nuke: { singleton: true },
    read: Effect.fn("PolicyFile.read")(function* program({
      output,
    }: {
      output: PolicyFileAttributes | undefined;
    }) {
      const live = yield* observe();
      return output?.tailnet === tailnet ? live : Unowned(live);
    }),
    reconcile: Effect.fn("PolicyFile.reconcile")(function* program({
      news,
      olds,
      output,
    }: {
      news: PolicyFileProps;
      olds: PolicyFileProps | undefined;
      output: PolicyFileAttributes | undefined;
    }) {
      const live = yield* observe();
      if (deepEqual(news.policy, live.policy)) {
        return live;
      }
      // beta.83 cold adoption supplies output but no olds. Never treat the
      // observed output as proof that an initial mutation was authorized.
      if (!olds || !output || output.tailnet !== tailnet) {
        return yield* mismatch("PolicyFile");
      }
      if (!deepEqual(olds.policy, live.policy)) {
        return yield* mismatch("PolicyFile drift");
      }
      if (live.etag === undefined || live.etag === "") {
        return yield* Effect.fail(new MissingEtag());
      }
      const validation = yield* Api.validateAndTestPolicyFile({ tailnet }, news.policy).pipe(
        Effect.catchTag("ApiError", (error) =>
          Effect.fail(error.status === 400 ? new PolicyValidationFailed() : error),
        ),
      );
      // Empty {} (or empty HTTP body) is the only affirmative pass. Warnings,
      // failed tests, and unknown diagnostics are all fail-closed.
      if (Object.keys(validation.body).length !== 0) {
        return yield* Effect.fail(new PolicyValidationFailed());
      }
      const updated = yield* Api.setPolicyFile({ tailnet }, news.policy, { "If-Match": live.etag });
      return { etag: updated.etag, policy: updated.body, tailnet };
    }),
  } satisfies Provider.ProviderServiceInput<PolicyFile, Transport, Transport, never, Transport>;
});

export const dnsService = Effect.gen(function* dnsService() {
  const { tailnet } = yield* Credentials;
  const observe = Effect.fn("Dns.observe")(function* observe() {
    const current = yield* Api.getDnsConfiguration({ tailnet });
    return { configuration: current.body, tailnet };
  });
  return {
    delete: () => Effect.void,
    diff: Effect.fn("Dns.diff")(function* dnsDiff({ news, olds, output }) {
      if (!isResolved(news)) {
        return;
      }
      if (output && deepEqual(olds, news) && !deepEqual(news.configuration, output.configuration)) {
        return yield* mismatch("Dns");
      }
      const live = yield* observe();
      if (!deepEqual(olds?.configuration, live.configuration)) {
        return yield* mismatch("Dns drift");
      }
      if (!deepEqual(news.configuration, live.configuration)) {
        return { action: "update" } as const;
      }
    }),
    nuke: { singleton: true },
    read: Effect.fn("Dns.read")(function* program({
      output,
    }: {
      output: DnsAttributes | undefined;
    }) {
      const live = yield* observe();
      return output?.tailnet === tailnet ? live : Unowned(live);
    }),
    reconcile: Effect.fn("Dns.reconcile")(function* program({
      news,
      olds,
      output,
    }: {
      news: DnsProps;
      olds: DnsProps | undefined;
      output: DnsAttributes | undefined;
    }) {
      const live = yield* observe();
      if (deepEqual(news.configuration, live.configuration)) {
        return live;
      }
      if (!olds || !output || output.tailnet !== tailnet) {
        return yield* mismatch("Dns");
      }
      // The spec documents neither ETag nor If-Match for DNS. Sending a header
      // that may be ignored does not make a fleet-wide overwrite safe.
      return yield* Effect.fail(new UnsafeDnsWrite());
    }),
  } satisfies Provider.ProviderServiceInput<Dns, Transport, Transport, never, Transport>;
});

export const deviceTagsService = Effect.sync(() => {
  const observe = Effect.fn("DeviceTags.observe")(function* observe(deviceId: string) {
    const current = yield* Api.getDevice({ deviceId }).pipe(
      Effect.catchTag("ApiError", (error) =>
        Effect.fail(
          error.status === 404 ? new DeviceLifecycleRefused({ operation: "create" }) : error,
        ),
      ),
    );
    if (current.body.authorized === undefined) {
      return yield* Effect.fail(new InvalidResponse());
    }
    return { authorized: current.body.authorized, deviceId, tags: current.body.tags ?? [] };
  });
  return {
    delete: () => Effect.void,
    diff: Effect.fn("DeviceTags.diff")(function* program({ news, olds, output }) {
      if (!isResolved(news)) {
        return;
      }
      if (output && news.deviceId !== output.deviceId) {
        return yield* Effect.fail(new DeviceLifecycleRefused({ operation: "changeIdentity" }));
      }
      if (output && deepEqual(olds, news) && !deviceMatches(news, output)) {
        return yield* mismatch("DeviceTags");
      }
      const live = yield* observe(news.deviceId);
      if (!deviceMatches(olds, live)) {
        return yield* mismatch("DeviceTags drift");
      }
      if (!deviceMatches(news, live)) {
        return { action: "update" } as const;
      }
    }),
    nuke: { skip: true },
    read: Effect.fn("DeviceTags.read")(function* program({
      olds,
      output,
    }: {
      olds: DeviceTagsProps | undefined;
      output: DeviceTagsAttributes | undefined;
    }) {
      const deviceId = output?.deviceId ?? olds?.deviceId;
      if (deviceId === undefined || deviceId === "") {
        return undefined;
      }
      const live = yield* observe(deviceId);
      return output ? live : Unowned(live);
    }),
    reconcile: Effect.fn("DeviceTags.reconcile")(function* program({
      news,
      olds,
      output,
    }: {
      news: DeviceTagsProps;
      olds: DeviceTagsProps | undefined;
      output: DeviceTagsAttributes | undefined;
    }) {
      if (
        (output && output.deviceId !== news.deviceId) ||
        (olds && olds.deviceId !== news.deviceId)
      ) {
        return yield* Effect.fail(new DeviceLifecycleRefused({ operation: "changeIdentity" }));
      }
      const live = yield* observe(news.deviceId);
      const matches =
        sameTags(live.tags, news.tags) &&
        (news.authorized === undefined || live.authorized === news.authorized);
      if (matches) {
        return live;
      }
      if (!olds || !output) {
        return yield* mismatch("DeviceTags");
      }
      if (
        !sameTags(live.tags, olds.tags) ||
        (olds.authorized !== undefined && live.authorized !== olds.authorized)
      ) {
        return yield* mismatch("DeviceTags drift");
      }
      if (!sameTags(news.tags, live.tags)) {
        yield* Api.setDeviceTags({ deviceId: news.deviceId }, { tags: [...news.tags] });
      }
      if (news.authorized !== undefined && news.authorized !== live.authorized) {
        yield* Api.authorizeDevice({ deviceId: news.deviceId }, { authorized: news.authorized });
      }
      return yield* observe(news.deviceId);
    }),
  } satisfies Provider.ProviderServiceInput<DeviceTags, Transport, Transport, never, Transport>;
});

export const authKeyService = Effect.gen(function* authKeyService() {
  const { tailnet } = yield* Credentials;
  const attributes = (key: Api.Key): Effect.Effect<AuthKeyAttributes, InvalidResponse> => {
    if (key.id === undefined || key.id === "") {
      return Effect.fail(new InvalidResponse());
    }
    return Effect.succeed({
      id: key.id,
      tailnet,
      ...(key.created === undefined ? {} : { created: key.created }),
      ...(key.expires === undefined ? {} : { expires: key.expires }),
    });
  };
  return {
    delete: Effect.fn("AuthKey.delete")(function* program({
      output,
    }: {
      output: AuthKeyAttributes;
    }) {
      if (output.tailnet !== tailnet) {
        return yield* mismatch("AuthKey tailnet");
      }
      yield* Api.deleteKey({ keyId: output.id, tailnet }).pipe(
        Effect.catchTag("ApiError", (error) =>
          error.status === 404 ? Effect.void : Effect.fail(error),
        ),
      );
    }),
    diff: ({ news, olds, output }) =>
      Effect.sync(() => {
        if (isResolved(news) && output && !deepEqual(news, olds)) {
          return { action: "replace" } as const;
        }
      }),
    read: Effect.fn("AuthKey.read")(function* program({
      output,
    }: {
      output: AuthKeyAttributes | undefined;
    }) {
      if (!output) {
        return undefined;
      }
      if (output.tailnet !== tailnet) {
        return yield* mismatch("AuthKey tailnet");
      }
      const key = yield* Api.getKey({ keyId: output.id, tailnet }).pipe(
        Effect.catchTag("ApiError", (error) =>
          error.status === 404 ? Effect.succeed(undefined) : Effect.fail(error),
        ),
      );
      if (!key || key.body.invalid === true) {
        return undefined;
      }
      return yield* attributes(key.body);
    }),
    reconcile: Effect.fn("AuthKey.reconcile")(function* program({
      news,
      olds,
      output,
    }: {
      news: AuthKeyProps;
      olds: AuthKeyProps | undefined;
      output: AuthKeyAttributes | undefined;
    }) {
      if (output) {
        if (output.tailnet !== tailnet) {
          return yield* mismatch("AuthKey tailnet");
        }
        if (!deepEqual(news, olds)) {
          return yield* Effect.fail(new KeyReplacementRequired());
        }
        return output;
      }
      const sink = yield* Effect.serviceOption(AuthKeySecrets);
      if (Option.isNone(sink)) {
        return yield* Effect.fail(new SecretDeliveryFailed({ keyId: "not-created" }));
      }
      const created = yield* Api.createKey({ tailnet }, { ...news, keyType: "auth" });
      const attrs = yield* attributes(created.body);
      if (created.body.key === undefined || created.body.key === "") {
        return yield* Effect.fail(new InvalidResponse());
      }
      yield* sink.value.capture(attrs.id, Redacted.make(created.body.key));
      return attrs;
    }),
  } satisfies Provider.ProviderServiceInput<AuthKey, Transport, never, never, Transport, Transport>;
});

export const PolicyFileProvider = () => Provider.effect(PolicyFile, policyFileService);
export const DnsProvider = () => Provider.effect(Dns, dnsService);
export const DeviceTagsProvider = () => Provider.effect(DeviceTags, deviceTagsService);
export const AuthKeyProvider = () => Provider.effect(AuthKey, authKeyService);
export const providerLayer = () =>
  Layer.effect(Providers, Provider.collection([PolicyFile, Dns, DeviceTags, AuthKey])).pipe(
    Layer.provide(
      Layer.mergeAll(PolicyFileProvider(), DnsProvider(), DeviceTagsProvider(), AuthKeyProvider()),
    ),
  );
