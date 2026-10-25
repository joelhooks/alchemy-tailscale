import { Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Request from "effect/http/HttpClientRequest";
import { ApiError, InvalidResponse, TransportError } from "./errors.ts";

export class Credentials extends Context.Service<
  Credentials,
  {
    readonly tailnet: string;
    readonly token: () => Effect.Effect<
      Redacted.Redacted,
      ApiError | InvalidResponse | TransportError
    >;
  }
>()("Tailscale.Credentials") {}

// /oauth/token is documented in Tailscale's authentication prose, not as an
// operation in the vendored OpenAPI paths. Tokens are obtained per request;
// this avoids stale-token retries (especially around non-idempotent writes).
export const credentialsFromEnvironment = Layer.effect(
  Credentials,
  Effect.gen(function* credentialsFromEnvironment() {
    const tailnet = yield* Config.NonEmptyString("TAILSCALE_TAILNET");
    const apiKey = yield* Config.option(Config.Redacted("TAILSCALE_API_KEY"));
    const http = yield* HttpClient.HttpClient;
    if (Option.isSome(apiKey)) {
      return Credentials.of({ tailnet, token: () => Effect.succeed(apiKey.value) });
    }
    const clientId = yield* Config.NonEmptyString("TAILSCALE_OAUTH_CLIENT_ID");
    const clientSecret = yield* Config.Redacted("TAILSCALE_OAUTH_CLIENT_SECRET");
    const token = Effect.fn("Tailscale.oauthToken")(function* token() {
      const response = yield* http
        .execute(
          Request.post("https://api.tailscale.com/api/v2/oauth/token").pipe(
            Request.bodyUrlParams({
              client_id: clientId,
              client_secret: Redacted.value(clientSecret),
              grant_type: "client_credentials",
            }),
          ),
        )
        .pipe(Effect.mapError(() => new TransportError()));
      if (response.status < 200 || response.status >= 300) {
        return yield* Effect.fail(new ApiError({ status: response.status }));
      }
      const json = yield* response.json.pipe(Effect.mapError(() => new InvalidResponse()));
      const result = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ access_token: Schema.NonEmptyString }),
      )(json).pipe(Effect.mapError(() => new InvalidResponse()));
      return Redacted.make(result.access_token);
    });
    return Credentials.of({ tailnet, token });
  }),
);
