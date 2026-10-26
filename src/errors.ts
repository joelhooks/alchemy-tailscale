// Effect's TaggedError is a curried class factory, not a constructor call.
/* oxlint-disable unicorn/throw-new-error, max-classes-per-file */
import { Schema } from "effect";

export class ApiError extends Schema.TaggedError<ApiError>()("ApiError", {
  status: Schema.Number,
}) {}
export class TransportError extends Schema.TaggedError<TransportError>()("TransportError", {}) {}
export class InvalidResponse extends Schema.TaggedError<InvalidResponse>()("InvalidResponse", {}) {}
export class PreconditionFailed extends Schema.TaggedError<PreconditionFailed>()(
  "PreconditionFailed",
  {},
) {}
export class AdoptionMismatch extends Schema.TaggedError<AdoptionMismatch>()("AdoptionMismatch", {
  id: Schema.optionalKey(Schema.String),
  paths: Schema.Array(Schema.String),
  resource: Schema.String,
}) {
  override get message() {
    const identity = this.id === undefined ? this.resource : `${this.resource} (${this.id})`;
    return `${identity}: adoption or drift mismatch at ${this.paths.join(", ")}; refusing to overwrite live state. Review these fields before adopting or updating.`;
  }
}
export class MissingEtag extends Schema.TaggedError<MissingEtag>()("MissingEtag", {}) {}
export class PolicyValidationFailed extends Schema.TaggedError<PolicyValidationFailed>()(
  "PolicyValidationFailed",
  {},
) {}
export class UnsafeDnsWrite extends Schema.TaggedError<UnsafeDnsWrite>()("UnsafeDnsWrite", {}) {}
export class DeviceLifecycleRefused extends Schema.TaggedError<DeviceLifecycleRefused>()(
  "DeviceLifecycleRefused",
  {
    operation: Schema.Literals(["create", "delete", "changeIdentity"]),
  },
) {}
export class SecretDeliveryFailed extends Schema.TaggedError<SecretDeliveryFailed>()(
  "SecretDeliveryFailed",
  {
    keyId: Schema.String,
  },
) {}
export class KeyReplacementRequired extends Schema.TaggedError<KeyReplacementRequired>()(
  "KeyReplacementRequired",
  {},
) {}
