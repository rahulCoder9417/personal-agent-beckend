// The events an app can start an automation on (Composio's trigger types), for the canvas's event
// picker (GET /v1/apps/{appSlug}/events) and for the checks of an app-event automation: the event
// must be one the app offers and its required settings filled. Each event's settings come as a
// JSON schema; only what a form needs is kept.
import { appEventTypes, type ComposioTriggerType } from './composio.ts';

export type SettingType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';

export interface AppEventSetting {
  name: string;
  title: string;
  description: string;
  type: SettingType;
  required: boolean;
  enum?: unknown[];
  default?: unknown;
}

export interface AppEvent {
  slug: string;
  name: string;
  description: string;
  settings: AppEventSetting[];
}

const TYPES: ReadonlySet<string> = new Set([
  'string',
  'number',
  'integer',
  'boolean',
  'array',
  'object',
]);

/** "labelIds" → "Label ids"; "repo_name" → "Repo name". */
function titleOf(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A setting's kind from its JSON schema: its `type`, the first of a list, else text. */
function typeOf(schema: Record<string, unknown>): SettingType {
  const t = Array.isArray(schema.type) ? schema.type.find((x) => x !== 'null') : schema.type;
  return typeof t === 'string' && TYPES.has(t) ? (t as SettingType) : 'string';
}

/** One kind of event as the web app's picker shows it. */
export function toAppEvent(t: ComposioTriggerType): AppEvent {
  const props = (t.config.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(Array.isArray(t.config.required) ? (t.config.required as string[]) : []);
  const settings = Object.entries(props).map(([name, schema]) => ({
    name,
    title: typeof schema.title === 'string' && schema.title ? schema.title : titleOf(name),
    description: typeof schema.description === 'string' ? schema.description : '',
    type: typeOf(schema),
    required: required.has(name),
    ...(Array.isArray(schema.enum) ? { enum: schema.enum } : {}),
    ...('default' in schema ? { default: schema.default } : {}),
  }));
  return { slug: t.slug, name: t.name || titleOf(t.slug), description: t.description, settings };
}

/** The events one app (its toolkit) offers. Throws when Composio can't be asked. */
export async function appEvents(toolkit: string): Promise<AppEvent[]> {
  return (await appEventTypes(toolkit)).map(toAppEvent);
}

const empty = (v: unknown) =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

function fits(type: SettingType, v: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'integer':
      return Number.isInteger(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'array':
      return Array.isArray(v);
    case 'object':
      return typeof v === 'object' && v !== null && !Array.isArray(v);
  }
}

/**
 * What is wrong with an app event, in words for the user: an event the app does not offer, a
 * required setting left empty, a setting of the wrong kind. Settings the event doesn't name are
 * left to Composio. Null: the app's events could not be read just now, so nothing is said.
 */
export async function appEventProblems(
  toolkit: string,
  appName: string,
  event: string,
  config: Record<string, unknown>,
): Promise<string[] | null> {
  let events: AppEvent[];
  try {
    events = await appEvents(toolkit);
  } catch {
    return null;
  }
  const found = events.find((e) => e.slug.toUpperCase() === event.toUpperCase());
  if (!found) return [`${appName} has no event "${event}". Pick one from the list.`];
  const out: string[] = [];
  for (const s of found.settings) {
    const v = config[s.name];
    if (empty(v)) {
      if (s.required && s.default === undefined) out.push(`Fill in "${s.title}".`);
      continue;
    }
    if (!fits(s.type, v)) {
      const kind =
        s.type === 'integer' ? 'a whole number' : s.type === 'array' ? 'a list' : `a ${s.type}`;
      out.push(`"${s.title}" must be ${kind}.`);
    } else if (s.enum && !s.enum.some((e) => e === v)) {
      out.push(`"${s.title}" must be one of: ${s.enum.map(String).join(', ')}.`);
    }
  }
  return out;
}
