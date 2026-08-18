import { default as Ajv2020 } from "ajv/dist/2020.js";
import { readFileSync, readdirSync } from "node:fs";
import { basename } from "node:path";

const schemaUrl = new URL("../../ir/schema.json", import.meta.url);
const schemaV2Url = new URL("../../ir/schema-v2.json", import.meta.url);
const architectureSchemaUrl = new URL(
  "../../ir/architecture-request.schema.json",
  import.meta.url,
);
const examplesUrl = new URL("../../ir/examples/", import.meta.url);
const schema = JSON.parse(readFileSync(schemaUrl, "utf8")) as object;
const schemaV2 = JSON.parse(readFileSync(schemaV2Url, "utf8")) as object;
// Ajv publishes CJS-shaped NodeNext declarations; the runtime default is constructable.
// @ts-expect-error -- upstream Ajv NodeNext declaration mismatch
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictRequired: false,
});
ajv.addSchema(schema);
ajv.addSchema(schemaV2);
const validateV1 = ajv.getSchema("https://foundry.local/schema/dyad-ir.json")!;
const validateV2 = ajv.getSchema(
  "https://foundry.local/schema/dyad-ir-v2.json",
)!;
const validateArchitecture = ajv.compile(
  JSON.parse(readFileSync(architectureSchemaUrl, "utf8")) as object,
);

let failed = false;
for (const name of readdirSync(examplesUrl)
  .filter((entry) => entry.endsWith(".json"))
  .sort()) {
  const url = new URL(name, examplesUrl);
  const value = JSON.parse(readFileSync(url, "utf8")) as unknown;
  const version =
    typeof value === "object" && value !== null && "ir_version" in value
      ? (value as { ir_version?: unknown }).ir_version
      : undefined;
  const validate = version === 2 ? validateV2 : validateV1;
  if (validate(value)) {
    console.log(`VALID ${basename(name)}`);
  } else {
    failed = true;
    console.error(
      `INVALID ${basename(name)}: ${JSON.stringify(validate.errors)}`,
    );
  }
}

const architectureFixture = {
  architecture_version: 1,
  product_spec: "Build deterministic string utilities",
  repository: ".",
  base_revision: "HEAD",
  allowed_languages: ["python", "typescript", "go"],
  policy_constraints: ["tests have no network"],
};
if (validateArchitecture(architectureFixture)) {
  console.log("VALID ArchitectureRequest v1");
} else {
  failed = true;
  console.error(
    `INVALID ArchitectureRequest v1: ${JSON.stringify(validateArchitecture.errors)}`,
  );
}

process.exitCode = failed ? 1 : 0;
