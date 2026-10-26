import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { AdoptionMismatch } from "../src/errors.ts";
import { changedPaths, mismatch } from "../src/mismatch.ts";

const guidance =
  "; refusing to overwrite live state. Review these fields before adopting or updating.";

describe("path-only mismatch diagnostics", () => {
  it("reports nested, added, removed and quoted fields without array values", () => {
    const paths = changedPaths(
      {
        grants: ["private-rule"],
        removed: true,
        tagOwners: { 'tag:x"y': ["synthetic-private-owner"] },
      },
      { added: "private-value", grants: [], tagOwners: { 'tag:x"y': ["different-private-owner"] } },
      "policy",
    );
    expect(paths).toEqual([
      "policy.added",
      "policy.grants",
      "policy.removed",
      'policy.tagOwners["tag:x\\\"y"]',
    ]);
    const error = Effect.runSync(
      Effect.flip(mismatch("Tailscale.PolicyFile", paths, "LogicalPolicy")),
    );
    expect(error.message).toBe(
      `Tailscale.PolicyFile (LogicalPolicy): adoption or drift mismatch at ${paths.join(", ")}${guidance}`,
    );
    const serialized = JSON.stringify(Schema.encodeSync(AdoptionMismatch)(error));
    expect(serialized).not.toContain("private");
    expect(error.stack).not.toContain("private");
    expect(serialized).toContain("LogicalPolicy");
  });
  it("reports nested DNS preferences and arrays as fields", () => {
    expect(
      changedPaths(
        { preferences: { magicDNS: true }, searchPaths: ["private.example"] },
        { preferences: { magicDNS: false }, searchPaths: ["other.example"] },
        "configuration",
      ),
    ).toEqual(["configuration.preferences.magicDNS", "configuration.searchPaths"]);
  });
  it("handles missing, null, primitive and equal fields without values", () => {
    expect(changedPaths(undefined, { grants: [] }, "policy")).toEqual(["policy"]);
    expect(changedPaths({ a: null }, { a: { secret: "private" } }, "policy")).toEqual(["policy.a"]);
    expect(changedPaths({ grants: [] }, { grants: [] }, "policy")).toEqual([]);
    const error = new AdoptionMismatch({
      paths: ["tags", "authorized"],
      resource: "Tailscale.DeviceTags",
    });
    expect(error.message).toBe(
      `Tailscale.DeviceTags: adoption or drift mismatch at tags, authorized${guidance}`,
    );
    expect(JSON.stringify(error)).not.toContain("undefined");
  });
});
