import { deepEqual } from "alchemy/Diff";
import { Effect } from "effect";
import { AdoptionMismatch } from "./errors.ts";

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// Arrays are reported as fields, never as their elements. Object keys identify
// paths; values must never enter diagnostics (including error attributes).
export const changedPaths = (expected: unknown, actual: unknown, path: string): string[] => {
  if (deepEqual(expected, actual)) {
    return [];
  }
  if (isObject(expected) && isObject(actual)) {
    const left = expected;
    const right = actual;
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].toSorted().flatMap((key) => {
      const child = /^[A-Za-z_$][\w$]*$/u.test(key)
        ? `${path}.${key}`
        : `${path}[${JSON.stringify(key)}]`;
      return changedPaths(left[key], right[key], child);
    });
  }
  return [path];
};

export const mismatch = (resource: string, paths: readonly string[], id?: string) =>
  Effect.fail(new AdoptionMismatch({ paths, resource, ...(id === undefined ? {} : { id }) }));
