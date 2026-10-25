// This is the public package entry point, not an application-internal barrel.
/* oxlint-disable oxc/no-barrel-file */
import { Layer } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { credentialsFromEnvironment } from "./credentials.ts";
import { transportLayer } from "./transport.ts";
import { providerLayer } from "./resources.ts";

export { Credentials, credentialsFromEnvironment } from "./credentials.ts";
export { Transport, transportLayer } from "./transport.ts";
export * from "./errors.ts";
export { AuthKey, AuthKeySecrets, DeviceTags, Dns, PolicyFile, Providers } from "./resources.ts";
export type {
  AuthKeyAttributes,
  AuthKeyProps,
  DeviceTagsAttributes,
  DeviceTagsProps,
  DnsAttributes,
  DnsProps,
  PolicyFileAttributes,
  PolicyFileProps,
} from "./resources.ts";
export * as Client from "./generated/client.ts";

// Bring-your-own layers remain available through providerLayer for fixture tests.
export { providerLayer } from "./resources.ts";
export const providers = () =>
  providerLayer().pipe(
    Layer.provideMerge(transportLayer),
    Layer.provide(credentialsFromEnvironment),
    Layer.provide(FetchHttpClient.layer),
    Layer.orDie,
  );
