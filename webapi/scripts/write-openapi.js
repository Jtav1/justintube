import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadOpenApiDocument } from "../lib/loadOpenApi.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = join(__dirname, "..", "openapi.generated.json");

/**
 * Writes the swagger-jsdoc–merged OpenAPI document for Scalar CLI preview/validate.
 *
 * @returns {void}
 */
function main() {
  const document = loadOpenApiDocument();
  writeFileSync(outPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  console.log(`Wrote ${outPath}`);
}

main();
