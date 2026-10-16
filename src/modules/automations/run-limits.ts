// What an automation's run may do, from the automation itself (docs/backend-report.md, "The run's
// limits"): only the apps on its canvas (its Apps box and its trigger's app), and, when the user
// chose it, a yes before any app action that changes something. The worker notes the automation
// beside the turn in Redis (orchestrator/turn.ts); the agent's app tools ask here.
import { turnAutomation } from '../orchestrator/turn.ts';
import { appForToolkit, findApp } from '../integrations/catalog.ts';
import { getAutomation, type Automation } from './automations.ts';

export interface RunLimits {
  automationId: string;
  title: string;
  /** The toolkits the run may use. Null: any connected app (none named). */
  toolkits: Set<string> | null;
  /** The names of those apps, for the agent to tell the user. */
  appNames: string[];
  askFirst: Automation['askFirst'];
}

const appOf = (name: string) => findApp(name) ?? appForToolkit(name);

/** The limits of one automation's runs. */
export function limitsOf(a: Automation): RunLimits {
  const named = a.apps ?? [];
  if (!named.length)
    return {
      automationId: a.id,
      title: a.title,
      toolkits: null,
      appNames: [],
      askFirst: a.askFirst,
    };
  const apps = [...named, ...(a.trigger ? [a.trigger.app] : [])]
    .map(appOf)
    .filter((x): x is NonNullable<typeof x> => Boolean(x));
  return {
    automationId: a.id,
    title: a.title,
    toolkits: new Set(apps.map((x) => x.toolkit.toLowerCase())),
    appNames: [...new Set(apps.map((x) => x.name))],
    askFirst: a.askFirst,
  };
}

/** Why a run's limits can't be told: the turn's note can't be read, or its automation is gone. */
export class RunLimitsUnknown extends Error {}

/**
 * The limits of the user's turn in progress, when it is an automation's run. Null: not a run.
 * Throws RunLimitsUnknown when the note can't be read or the automation was deleted meanwhile, so
 * the tool refuses rather than run without its limits.
 */
export async function currentRunLimits(userId: string): Promise<RunLimits | null> {
  const id = await turnAutomation(userId);
  if (id === 'unknown')
    throw new RunLimitsUnknown('Could not check this turn just now. Try again in a moment.');
  if (!id) return null;
  const a = await getAutomation(userId, id);
  if (!a)
    throw new RunLimitsUnknown(
      'This automation was deleted while it ran, so nothing more is done in its apps.',
    );
  return limitsOf(a);
}

/**
 * The refusal for an app the run may not use, null when it may. Written for the agent: what to
 * tell the user and where they can add the app.
 */
export function appRefusal(limits: RunLimits, toolkit: string, appName: string): string | null {
  if (!limits.toolkits || limits.toolkits.has(toolkit.toLowerCase())) return null;
  return (
    `The automation "${limits.title}" may only use ${limits.appNames.join(', ')} (the apps on its canvas), ` +
    `so ${appName} can't be used in this run. Nothing was done in ${appName}. Tell the user that, and that ` +
    `they can add ${appName} to its Apps step on the automation's page in the web app.`
  );
}
