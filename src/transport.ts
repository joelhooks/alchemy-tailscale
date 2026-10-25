import { Context, Effect, Layer, Schema } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Request from "effect/http/HttpClientRequest";
import type { HttpMethod } from "effect/http/HttpMethod";
import { Credentials } from "./credentials.ts";
import { ApiError, InvalidResponse, PreconditionFailed, TransportError } from "./errors.ts";

export interface Response<A> {
  readonly body: A;
  readonly etag: string | undefined;
}
export type RequestError = ApiError | InvalidResponse | PreconditionFailed | TransportError;
export class Transport extends Context.Service<
  Transport,
  {
    readonly request: <A>(
      method: HttpMethod,
      path: string,
      body: unknown,
      schema: Schema.ConstraintDecoder<A>,
      headers: Readonly<Record<string, string>>,
    ) => Effect.Effect<Response<A>, RequestError>;
  }
>()("Tailscale.Transport") {}

// No automatic retries: a lost write response is ambiguous, and 412 must stop.
// Errors intentionally exclude HTTP bodies, requests, headers and decoder causes
// because any of those can contain key material or private policy contents.
export const transportLayer = Layer.effect(
  Transport,
  Effect.gen(function* transportLayer() {
    const http = yield* HttpClient.HttpClient;
    const credentials = yield* Credentials;
    return Transport.of({
      request: Effect.fn("Tailscale.request")(function* executeRequest<A>(
        method: HttpMethod,
        path: string,
        body: unknown,
        schema: Schema.ConstraintDecoder<A>,
        headers: Readonly<Record<string, string>>,
      ) {
        const token = yield* credentials.token();
        let request = Request.make(method)(`https://api.tailscale.com/api/v2${path}`).pipe(
          Request.bearerToken(token),
          Request.setHeaders({ Accept: "application/json", ...headers }),
        );
        if (body !== undefined) {
          request = request.pipe(Request.bodyJsonUnsafe(body));
        }
        const response = yield* http
          .execute(request)
          .pipe(Effect.mapError(() => new TransportError()));
        if (response.status === 412) {
          return yield* Effect.fail(new PreconditionFailed());
        }
        if (response.status < 200 || response.status >= 300) {
          return yield* Effect.fail(new ApiError({ status: response.status }));
        }
        const text = yield* response.text.pipe(Effect.mapError(() => new InvalidResponse()));
        const json =
          schema.ast === Schema.Void.ast || text === ""
            ? undefined
            : yield* Effect.try({
                catch: () => new InvalidResponse(),
                try: () => JSON.parse(text) as unknown,
              });
        // Policy validation explicitly permits an empty successful response.
        const value = json === undefined && path.endsWith("/acl/validate") ? {} : json;
        const decoded = yield* Schema.decodeUnknownEffect(schema)(value).pipe(
          Effect.mapError(() => new InvalidResponse()),
        );
        return { body: decoded, etag: response.headers.etag };
      }),
    });
  }),
);
