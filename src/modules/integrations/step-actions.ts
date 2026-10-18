// An app's actions as an automation's step needs them (docs/backend-report.md, "Automations with
// steps"): the list for the step panel's picker (GET /v1/apps/{appSlug}/actions), and the check of
// the inputs a user fixes on a step. Composio describes each action's inputs as a JSON schema; the
// same description the approval check uses (action-inputs.ts).
import { appOfAction } from './action-inputs.ts';
import { actionTitle, settingsOf, type AppEventSetting } from './app-events.ts';
import { actionChangesSomething, actionNeedsApproval, type CatalogApp } from './catalog.ts';
import { actionTool, toolkitTools, type ComposioTool } from './composio.ts';

export interface PickerAction {
  slug: string;
  name: string;
  description: string;
  requiresApproval: boolean;
  changesSomething: boolean;
  inputs: AppEventSetting[];
}

/** At most this many actions in one list. */
export const PICKER_MAX = 200;

const pickerAction = (t: ComposioTool, toolkit: string): PickerAction => ({
  slug: t.slug,
  name: t.name && t.name !== t.slug ? t.name : actionTitle(t.slug, toolkit),
  description: t.description,
  requiresApproval: actionNeedsApproval(t.slug, { tags: t.tags }),
  changesSomething: actionChangesSomething(t.slug, t.tags),
  inputs: settingsOf(t.inputParameters ?? {}),
});

/**
 * One app's actions for the step panel, from Composio's listing (kept 10 minutes). `search`: a word
 * in the name or the description. Throws when Composio can't be asked.
 */
export async function actionsForPicker(app: CatalogApp, search?: string): Promise<PickerAction[]> {
  const q = search?.trim().toLowerCase();
  const tools = await toolkitTools(app.toolkit);
  return tools
    .filter(
      (t) =>
        !q ||
        t.slug.toLowerCase().includes(q) ||
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q),
    )
    .slice(0, PICKER_MAX)
    .map((t) => pickerAction(t, app.toolkit));
}

export type FixedInputsCheck =
  { ok: true; tool: ComposioTool | null; title: string } | { ok: false; problem: string };

const kindOf = (v: unknown) =>
  Array.isArray(v)
    ? 'array'
    : typeof v === 'number'
      ? Number.isInteger(v)
        ? 'integer'
        : 'number'
      : typeof v;

/**
 * Whether the action is one of this app's, and the inputs a user fixed on its step have names the
 * action takes and values of the kind it takes. Required inputs may be left out: Tex fills them
 * from earlier results. When Composio can't be asked, the action is not held against the step (a
 * run then says so): `tool` is null.
 */
export async function checkFixedInputs(
  app: CatalogApp,
  action: string,
  inputs: Record<string, unknown>,
): Promise<FixedInputsCheck> {
  const owner = appOfAction(action);
  if (!owner || owner.toolkit !== app.toolkit)
    return {
      ok: false,
      problem: `${action} is not one of ${app.name}'s actions. Pick one from the list.`,
    };
  let tool: ComposioTool | null;
  try {
    tool = await actionTool(app.toolkit, action);
  } catch {
    return { ok: true, tool: null, title: actionTitle(action, app.toolkit) };
  }
  if (!tool)
    return { ok: false, problem: `${app.name} has no action ${action}. Pick one from the list.` };
  const settings = settingsOf(tool.inputParameters ?? {});
  const title =
    tool.name && tool.name !== tool.slug ? tool.name : actionTitle(tool.slug, app.toolkit);
  if (!settings.length) return { ok: true, tool, title };
  const byName = new Map(settings.map((s) => [s.name, s]));
  const othersAllowed = Boolean(
    (tool.inputParameters as { additionalProperties?: unknown }).additionalProperties,
  );
  const problems: string[] = [];
  for (const [name, value] of Object.entries(inputs)) {
    const s = byName.get(name);
    if (!s) {
      if (!othersAllowed) problems.push(`${app.name}'s ${tool.slug} has no input \`${name}\``);
      continue;
    }
    if (value === null || value === undefined || value === '') continue;
    const kind = kindOf(value);
    const fits =
      s.type === kind ||
      (s.type === 'number' && kind === 'integer') ||
      (s.type === 'object' && kind === 'object' && value !== null);
    if (!fits)
      problems.push(`\`${name}\` must be ${s.type === 'array' ? 'a list' : `a ${s.type}`}`);
    else if (s.enum && !s.enum.some((e) => e === value))
      problems.push(`\`${name}\` must be one of: ${s.enum.map(String).join(', ')}`);
  }
  if (!problems.length) return { ok: true, tool, title };
  return {
    ok: false,
    problem: `${problems.join('; ')}. Its inputs: ${settings.map((s) => s.name).join(', ')}.`,
  };
}
