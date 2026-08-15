import { default as Ajv2020 } from "ajv/dist/2020.js";
import { readFileSync, readdirSync } from "node:fs";
import { basename } from "node:path";

const schemaUrl = new URL("../../ir/schema.json", import.meta.url);
const examplesUrl = new URL("../../ir/examples/", import.meta.url);
const schema = JSON.parse(readFileSync(schemaUrl, "utf8")) as object;
// Ajv publishes CJS-shaped NodeNext declarations; the runtime default is constructable.
// @ts-expect-error -- upstream Ajv NodeNext declaration mismatch
const validate = new Ajv2020({
  allErrors: true,
  strict: true,
  strictRequired: false,
}).compile(schema);

let failed = false;
for (const name of readdirSync(examplesUrl)
  .filter((entry) => entry.endsWith(".json"))
  .sort()) {
  const url = new URL(name, examplesUrl);
  const value = JSON.parse(readFileSync(url, "utf8")) as unknown;
  if (validate(value)) {
    console.log(`VALID ${basename(name)}`);
  } else {
    failed = true;
    console.error(
      `INVALID ${basename(name)}: ${JSON.stringify(validate.errors)}`,
    );
  }
}

process.exitCode = failed ? 1 : 0;
