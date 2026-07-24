import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import swaggerJsdoc from "swagger-jsdoc";
import { parse as parseYaml } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const webapiRoot = join(__dirname, "..");

/**
 * Returns absolute paths of JS source files that may contain `@openapi` blocks.
 * Explicit file lists are used instead of globs so Windows path separators do
 * not break swagger-jsdoc's glob matcher.
 *
 * @returns {string[]} Absolute paths to scan for OpenAPI annotations.
 */
function openApiSourceFiles() {
  const routeDir = join(webapiRoot, "routes");
  const routeFiles = readdirSync(routeDir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => join(routeDir, name));

  return [join(webapiRoot, "index.js"), ...routeFiles];
}

/**
 * Loads the OpenAPI base document from `openapi.yaml`, then merges path
 * operations discovered from `@openapi` JSDoc annotations in route modules
 * via swagger-jsdoc.
 *
 * @returns {object} OpenAPI 3 document object suitable for `/openapi.json`.
 */
export function loadOpenApiDocument() {
  const openApiPath = join(webapiRoot, "openapi.yaml");
  const definition = parseYaml(readFileSync(openApiPath, "utf8"));

  return swaggerJsdoc({
    definition,
    apis: openApiSourceFiles(),
  });
}
