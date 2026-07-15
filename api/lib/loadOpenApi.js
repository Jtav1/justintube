import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Loads and parses the OpenAPI document from `openapi.yaml` next to this module's parent.
 *
 * @returns {object} Parsed OpenAPI 3.1 document object.
 */
export function loadOpenApiDocument() {
  const openApiPath = join(__dirname, '..', 'openapi.yaml');
  const raw = readFileSync(openApiPath, 'utf8');
  return parseYaml(raw);
}
