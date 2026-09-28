// Loads openapi/openapi.yaml (the contract) and compiles JSON-schema validators from it.
// Request validation (api) and response contract tests share these.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsImport from 'ajv-formats';
import { parse } from 'yaml';

const addFormats = addFormatsImport as unknown as typeof addFormatsImport.default;

const specPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../openapi/openapi.yaml');

type Json = Record<string, unknown>;
export const spec = parse(readFileSync(specPath, 'utf8')) as Json & {
  paths: Record<string, Record<string, Json>>;
  components: Json;
};

export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface SpecParam {
  name: string;
  in: 'query' | 'path' | 'header' | 'cookie';
  required?: boolean;
  schema?: Json;
}

export interface SpecOperation {
  operationId: string;
  method: HttpMethod;
  /** OpenAPI path, e.g. /v1/channels/{channelLinkId} */
  path: string;
  /** Hono path, e.g. /v1/channels/:channelLinkId */
  honoPath: string;
  tags: string[];
  /** false when `security: []` (public). */
  requiresAuth: boolean;
  parameters: SpecParam[];
  hasJsonBody: boolean;
  bodyRequired: boolean;
  bodyPointer: string | null;
  responses: Record<string, Json>;
  pointer: string;
}

function escapePointer(s: string): string {
  return s.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Resolves a local `#/...` $ref against the spec. */
export function resolveRef<T = Json>(node: unknown): T {
  let current = node as Json;
  for (let i = 0; i < 10 && current && typeof current.$ref === 'string'; i++) {
    const parts = (current.$ref as string).replace(/^#\//, '').split('/');
    let target: unknown = spec;
    for (const p of parts) target = (target as Json)[p.replace(/~1/g, '/').replace(/~0/g, '~')];
    current = target as Json;
  }
  return current as T;
}

const operations = new Map<string, SpecOperation>();
const globalSecurity = (spec.security as unknown[] | undefined) ?? [];

for (const [path, item] of Object.entries(spec.paths)) {
  for (const method of HTTP_METHODS) {
    const op = item[method] as Json | undefined;
    if (!op) continue;
    const operationId = op.operationId as string;
    const pointer = `#/paths/${escapePointer(path)}/${method}`;
    const params = [...((item.parameters as unknown as unknown[] | undefined) ?? []), ...((op.parameters as unknown[]) ?? [])].map(
      (p) => resolveRef<SpecParam>(p),
    );
    const body = op.requestBody ? resolveRef<Json>(op.requestBody) : undefined;
    const jsonBody = (body?.content as Json | undefined)?.['application/json'] as Json | undefined;
    let bodyPointer: string | null = null;
    if (jsonBody) {
      bodyPointer =
        typeof (op.requestBody as Json).$ref === 'string'
          ? `${(op.requestBody as Json).$ref as string}/content/application~1json/schema`
          : `${pointer}/requestBody/content/application~1json/schema`;
    }
    const security = (op.security as unknown[] | undefined) ?? globalSecurity;
    operations.set(operationId, {
      operationId,
      method,
      path,
      honoPath: path.replace(/\{([^}]+)\}/g, ':$1'),
      tags: (op.tags as string[]) ?? [],
      requiresAuth: security.length > 0,
      parameters: params,
      hasJsonBody: Boolean(jsonBody),
      bodyRequired: Boolean(body?.required),
      bodyPointer,
      responses: (op.responses as Record<string, Json>) ?? {},
      pointer,
    });
  }
}

export function getOperation(operationId: string): SpecOperation {
  const op = operations.get(operationId);
  if (!op) throw new Error(`operationId ${operationId} is not in openapi.yaml`);
  return op;
}

export function allOperations(): SpecOperation[] {
  return [...operations.values()];
}

// --- validators ---------------------------------------------------------------------------

function makeAjv(coerceTypes: boolean) {
  const ajv = new Ajv2020({ strict: false, allErrors: true, coerceTypes, useDefaults: coerceTypes });
  addFormats(ajv);
  ajv.addFormat('binary', true);
  ajv.addSchema(spec, 'openapi');
  return ajv;
}

const bodyAjv = makeAjv(false);
const paramAjv = makeAjv(true);

/** Rewrites local refs so a schema built outside the spec still resolves them. */
function absolutize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(absolutize);
  if (node && typeof node === 'object') {
    const out: Json = {};
    for (const [k, v] of Object.entries(node as Json)) {
      out[k] = k === '$ref' && typeof v === 'string' && v.startsWith('#') ? `openapi${v}` : absolutize(v);
    }
    return out;
  }
  return node;
}

const cache = new Map<string, ValidateFunction>();

function cached(key: string, build: () => ValidateFunction): ValidateFunction {
  let v = cache.get(key);
  if (!v) {
    v = build();
    cache.set(key, v);
  }
  return v;
}

export function bodyValidator(op: SpecOperation): ValidateFunction | null {
  if (!op.bodyPointer) return null;
  return cached(`body:${op.operationId}`, () => bodyAjv.compile({ $ref: `openapi${op.bodyPointer}` }));
}

export function paramValidator(op: SpecOperation, location: 'path' | 'query'): ValidateFunction {
  return cached(`${location}:${op.operationId}`, () => {
    const params = op.parameters.filter((p) => p.in === location);
    return paramAjv.compile({
      type: 'object',
      properties: Object.fromEntries(params.map((p) => [p.name, absolutize(p.schema ?? {})])),
      required: params.filter((p) => p.required || location === 'path').map((p) => p.name),
    });
  });
}

/** Validator for a documented response body (null when the response has no JSON body). */
export function responseValidator(operationId: string, status: number): ValidateFunction | null {
  const op = getOperation(operationId);
  const raw = op.responses[String(status)];
  if (!raw) throw new Error(`${operationId}: status ${status} is not documented in openapi.yaml`);
  const response = resolveRef<Json>(raw);
  const content = response.content as Json | undefined;
  if (!content) return null;
  const mediaType = Object.keys(content)[0]!;
  const pointer =
    typeof raw.$ref === 'string'
      ? `${raw.$ref}/content/${escapePointer(mediaType)}/schema`
      : `${op.pointer}/responses/${status}/content/${escapePointer(mediaType)}/schema`;
  return cached(`res:${operationId}:${status}`, () => bodyAjv.compile({ $ref: `openapi${pointer}` }));
}

export function formatErrors(v: ValidateFunction): Array<{ path: string; message: string }> {
  return (v.errors ?? []).map((e) => ({ path: e.instancePath || '/', message: e.message ?? 'invalid' }));
}
