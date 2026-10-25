import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parse } from "yaml";

// Generate only the operations used by this provider. Unsupported schema features
// fail generation instead of silently weakening the client to any.
interface Node {
  $ref?: string;
  type?: string | string[];
  properties?: Record<string, Node>;
  required?: string[];
  items?: Node;
  additionalProperties?: boolean | Node;
  enum?: (string | number | boolean)[];
  oneOf?: Node[];
  anyOf?: Node[];
}
interface Operation {
  operationId: string;
  requestBody?: { content?: Record<string, { schema?: Node }> };
  responses: Record<string, { content?: Record<string, { schema?: Node }> }>;
}
interface Spec {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Node> };
}
const raw = readFileSync(new URL("../spec/openapi.yaml", import.meta.url), "utf-8");
// The input is a committed upstream document, hashed in PROVENANCE.md. Schema
// traversal below rejects unknown references/types instead of emitting any.
// oxlint-disable-next-line typescript/no-unsafe-assignment
const spec: Spec = parse(raw);
const selected = new Set([
  "getPolicyFile",
  "setPolicyFile",
  "validateAndTestPolicyFile",
  "getDevice",
  "setDeviceTags",
  "authorizeDevice",
  "createKey",
  "getKey",
  "deleteKey",
  "getDnsConfiguration",
  "setDnsConfiguration",
]);
const definitions = new Map<string, string>();
const schema = (n: Node): string => {
  if (n.$ref !== undefined) {
    const name = n.$ref.split("/").at(-1);
    if (name === undefined || name === "" || !spec.components.schemas[name]) {
      throw new Error(`Unknown reference ${n.$ref}`);
    }
    if (!definitions.has(name)) {
      definitions.set(name, "");
      const expression = schema(spec.components.schemas[name]);
      definitions.delete(name);
      definitions.set(
        name,
        `export const ${name} = ${expression};\nexport type ${name} = typeof ${name}.Type;`,
      );
    }
    return name;
  }
  const variants = n.oneOf ?? n.anyOf;
  if (variants) {
    return `Schema.Union([${variants.map(schema).join(", ")}])`;
  }
  if (Array.isArray(n.type)) {
    return `Schema.Union([${n.type.map((type) => schema({ ...n, type })).join(", ")}])`;
  }
  if (n.enum) {
    return `Schema.Literals(${JSON.stringify(n.enum)})`;
  }
  // The default rejects every unsupported type, including a missing type.
  // oxlint-disable-next-line typescript/switch-exhaustiveness-check
  switch (n.type) {
    case "string": {
      return "Schema.String";
    }
    case "integer":
    case "number": {
      return "Schema.Number";
    }
    case "boolean": {
      return "Schema.Boolean";
    }
    case "null": {
      return "Schema.Null";
    }
    case "array": {
      if (!n.items) {
        throw new Error("Missing array items");
      }
      return `Schema.Array(${schema(n.items)})`;
    }
    case "object": {
      if (n.properties) {
        const fields = Object.entries(n.properties).map(([key, value]) => {
          const valueSchema = schema(value);
          return `${JSON.stringify(key)}: ${n.required?.includes(key) === true ? valueSchema : `Schema.optionalKey(${valueSchema})`}`;
        });
        return `Schema.Struct({${fields.join(",\n")}})`;
      }
      return `Schema.Record(Schema.String, ${typeof n.additionalProperties === "object" ? schema(n.additionalProperties) : "Schema.Json"})`;
    }
    default: {
      throw new Error(`Unsupported schema ${JSON.stringify(n)}`);
    }
  }
};
const operations: string[] = [];
for (const [path, item] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(item)) {
    if (!selected.has(op.operationId)) {
      continue;
    }
    selected.delete(op.operationId);
    const name = op.operationId;
    const params = [...path.matchAll(/\{(?<param>\w+)\}/gu)].map((match) => match[1]);
    const request = op.requestBody?.content?.["application/json"]?.schema;
    const response = op.responses["200"]?.content?.["application/json"]?.schema;
    // The description documents JSON objects here. The upstream oneOf calls
    // that variant a string. Keep this one explicit, documented correction.
    let reqSchema = request ? schema(request) : undefined;
    let resSchema = response ? schema(response) : "Schema.Void";
    if (name === "validateAndTestPolicyFile") {
      reqSchema = "Schema.Record(Schema.String, Schema.Json)";
      resSchema = "Schema.Record(Schema.String, Schema.Json)";
    }
    if (reqSchema !== undefined) {
      operations.push(
        `export const ${name}Input = ${reqSchema};\nexport type ${name}Input = typeof ${name}Input.Type;`,
      );
    }
    operations.push(
      `export const ${name}Output = ${resSchema};\nexport type ${name}Output = typeof ${name}Output.Type;`,
    );
    const route = path.replaceAll(
      /\{(?<param>\w+)\}/gu,
      (_, key: string) => `\${encodeURIComponent(params.${key})}`,
    );
    operations.push(
      `export const ${name} = Effect.fn("Tailscale.${name}")(function* (params: {${params.map((p) => `${p}: string`).join("; ")}}${reqSchema === undefined ? "" : `, body: ${name}Input`}, headers: Readonly<Record<string, string>> = {}) {\n  const api = yield* Transport;\n  return yield* api.request(${JSON.stringify(method.toUpperCase())}, \`${route}\`, ${reqSchema === undefined ? "undefined" : "body"}, ${name}Output, headers);\n});`,
    );
  }
}
if (selected.size) {
  throw new Error(`Missing operations: ${[...selected].join(", ")}`);
}
const output = `// Generated by scripts/generate-client.ts. Do not edit.\n// OpenAPI SHA-256: ${createHash("sha256").update(raw).digest("hex")}\nimport { Effect, Schema } from "effect";\nimport { Transport } from "../transport.ts";\n\n${[...definitions.values(), ...operations].join("\n\n")}\n`;
const { format } = await import("oxfmt");
const formatted = await format("src/generated/client.ts", output);
if (formatted.errors.length) {
  throw new Error(JSON.stringify(formatted.errors));
}
const target = new URL("../src/generated/client.ts", import.meta.url);
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf-8") !== formatted.code) {
    throw new Error("Generated client is stale. Run pnpm generate.");
  }
} else {
  writeFileSync(target, formatted.code);
}
