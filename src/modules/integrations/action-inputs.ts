// Checks an app action's arguments against Composio's own description of the action (its input
// schema), when the agent asks the user to approve it. So the user only ever approves an action
// that can run exactly as they saw it. docs/backend-report.md, section 15 ("Approvals").
import { appForToolkit, CATALOG, type CatalogApp } from './catalog.ts';
import { actionTool } from './composio.ts';

/** The catalog app an action belongs to, by the start of its name (MICROSOFT_TEAMS_… → microsoft_teams). */
export function appOfAction(action: string): CatalogApp | undefined {
  const lower = action.toLowerCase();
  const toolkit = CATALOG.map((a) => a.toolkit)
    .filter((t) => lower.startsWith(`${t}_`))
    .sort((a, b) => b.length - a.length)[0];
  return toolkit ? appForToolkit(toolkit) : undefined;
}

export type ActionInputsCheck = { ok: true; app: CatalogApp } | { ok: false; problem: string };

interface InputSchema {
  type?: unknown;
  anyOf?: unknown;
}

const JSON_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);

function kindOf(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

/** The JSON types an input accepts, when its schema names them plainly; empty when it doesn't. */
function typesOf(schema: InputSchema): string[] {
  const named = (s: unknown) =>
    s && typeof s === 'object' && typeof (s as InputSchema).type === 'string'
      ? [(s as InputSchema).type as string]
      : [];
  if (typeof schema.type === 'string') return [schema.type];
  if (Array.isArray(schema.type)) return schema.type.filter((t) => typeof t === 'string');
  if (Array.isArray(schema.anyOf)) return schema.anyOf.flatMap(named);
  return [];
}

function fits(value: unknown, types: string[]): boolean {
  if (types.length === 0 || types.some((t) => !JSON_TYPES.has(t))) return true;
  const kind = kindOf(value);
  return types.some((t) => t === kind || (t === 'number' && kind === 'integer'));
}

/**
 * Whether these arguments fit the action, by Composio's input schema:
 * - every name is one of the action's inputs (unless the schema allows others);
 * - every input the schema marks required is given;
 * - a value has the kind the schema names (text, a number, a list…). An empty value (null) is
 *   left to the app.
 *
 * Returns null when the action is not one of a catalog app's (nothing to check it against). An
 * action whose schema lists no inputs at all is not checked: Composio did not describe them.
 * When Composio can't be asked, the check fails with a "try again" problem rather than letting an
 * unchecked request through.
 */
export async function checkActionInputs(
  action: string,
  args: Record<string, unknown>,
): Promise<ActionInputsCheck | null> {
  const app = appOfAction(action);
  if (!app) return null;
  let tool;
  try {
    tool = await actionTool(app.toolkit, action);
  } catch {
    return {
      ok: false,
      problem: `${app.name}'s actions could not be checked right now. Try again in a moment.`,
    };
  }
  if (!tool)
    return {
      ok: false,
      problem:
        `${app.name} has no action "${action}". Find the right one with list_app_actions ` +
        `(app "${app.slug}").`,
    };
  const schema = tool.inputParameters as {
    properties?: unknown;
    required?: unknown;
    additionalProperties?: unknown;
  };
  const props = schema.properties;
  if (!props || typeof props !== 'object' || Array.isArray(props)) return { ok: true, app };
  const inputs = props as Record<string, InputSchema>;
  const required = Array.isArray(schema.required)
    ? schema.required.filter((r): r is string => typeof r === 'string')
    : [];

  const problems: string[] = [];
  const othersAllowed = Boolean(schema.additionalProperties);
  for (const name of Object.keys(args))
    if (!(name in inputs) && !othersAllowed) problems.push(`it has no input named "${name}"`);
  for (const name of required)
    if (args[name] === undefined) problems.push(`the input "${name}" is required`);
  for (const [name, value] of Object.entries(args)) {
    const input = inputs[name];
    if (!input || value === null) continue;
    const types = typesOf(input);
    if (!fits(value, types))
      problems.push(`"${name}" must be ${types.join(' or ')}, not ${kindOf(value)}`);
  }
  if (problems.length === 0) return { ok: true, app };

  const list = Object.entries(inputs)
    .map(([name, input]) => {
      const types = typesOf(input);
      const kind = types.length
        ? ` (${types.join(' or ')}${required.includes(name) ? ', required' : ''})`
        : '';
      return `${name}${kind}`;
    })
    .join(', ');
  return {
    ok: false,
    problem:
      `${tool.slug} can't run with these arguments, so the user was not asked: ` +
      `${problems.join('; ')}. Its inputs: ${list}. ` +
      'Call request_approval again with these input names.',
  };
}
