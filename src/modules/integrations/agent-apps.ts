// What the agent is told about the user's apps: which are connected and usable, which are not
// ready yet and why, and the actions it can run (list_app_actions, get_profile, run_app_action).
// docs/backend-report.md, "Apps through Composio".
import { logger } from '../../shared/logger.ts';
import type { PlanId } from '../auth/users.ts';
import {
  appsPageUrl,
  listConnections,
  refreshPendingConnections,
  type Connection,
} from './apps.ts';
import {
  actionChangesSomething,
  actionNeedsApproval,
  appAllowedOnPlan,
  CATALOG,
  type CatalogApp,
} from './catalog.ts';
import { appOfAction } from './action-inputs.ts';
import { actionTool, toolkitTools, type ComposioTool } from './composio.ts';

/**
 * - `connected`: an active connection, on the user's plan. Its actions are listed.
 * - `connecting`: a sign-in started a short while ago and not finished yet.
 * - `not_finished`: a sign-in started long ago and never finished.
 * - `needs_reconnecting`: the connection expired or failed.
 * - `not_on_plan`: an active connection, but the app is not on the user's plan any more.
 */
export type AgentAppStatus =
  'connected' | 'connecting' | 'not_finished' | 'needs_reconnecting' | 'not_on_plan';

export interface AgentAppState {
  app: CatalogApp;
  status: AgentAppStatus;
  /** What to tell the user, for every status but `connected`. */
  note?: string;
}

/**
 * A pending connection younger than this is "still connecting". The server's own checks run for
 * about 16 minutes after the link is made (CONNECTION_CHECK_DELAYS_MS); a sign-in still not
 * finished after that was most likely left on the provider's page.
 */
export const CONNECTING_FOR_MS = 20 * 60_000;

const planName = (plan: PlanId) => plan.charAt(0).toUpperCase() + plan.slice(1);

function minutesAgo(since: Date, now: Date): string {
  const m = Math.round((now.getTime() - since.getTime()) / 60_000);
  if (m < 1) return 'less than a minute ago';
  return m === 1 ? '1 minute ago' : `${m} minutes ago`;
}

/**
 * The state of each app the user has a connection for, in the catalog's order. An active
 * connection wins over any other of the same app; then a sign-in still in progress; then an
 * expired or failed one; then a sign-in that never finished.
 */
export function agentAppStates(
  rows: Connection[],
  plan: PlanId,
  now = new Date(),
): AgentAppState[] {
  const apps = appsPageUrl();
  const states: AgentAppState[] = [];
  for (const app of CATALOG) {
    const mine = rows.filter((r) => r.app === app.slug);
    if (mine.length === 0) continue;
    const name = app.name;
    if (mine.some((r) => r.status === 'active')) {
      states.push(
        appAllowedOnPlan(app, plan)
          ? { app, status: 'connected' }
          : {
              app,
              status: 'not_on_plan',
              note:
                `${name} is connected, but it is not on your user's ${planName(plan)} plan, so its ` +
                'actions cannot run. Tell the user it comes with a paid plan.',
            },
      );
      continue;
    }
    const pending = mine
      .filter((r) => r.status === 'pending')
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const newest = pending[0];
    if (newest && now.getTime() - newest.createdAt.getTime() < CONNECTING_FOR_MS) {
      states.push({
        app,
        status: 'connecting',
        note:
          `${name} is still connecting: the sign-in was started ${minutesAgo(newest.createdAt, now)} ` +
          'and is not finished yet. Tell the user it may still be finishing, to try again in a ' +
          `minute, and to connect it again on the Integrations page (${apps}) if it does not finish.`,
      });
      continue;
    }
    const broken = mine.find((r) => r.status === 'expired' || r.status === 'error');
    if (broken) {
      states.push({
        app,
        status: 'needs_reconnecting',
        note:
          `${name} needs to be connected again: its connection ` +
          `${broken.status === 'expired' ? 'expired' : 'failed'}. Tell the user to connect it ` +
          `again on the Integrations page (${apps}).`,
      });
      continue;
    }
    states.push({
      app,
      status: 'not_finished',
      note:
        `${name} did not finish connecting: the sign-in started on ` +
        `${newest!.createdAt.toISOString().slice(0, 10)} was never completed. Tell the user to ` +
        `connect it again on the Integrations page (${apps}).`,
    });
  }
  return states;
}

/** The user's app states, after asking Composio about connections that are still pending. */
export async function currentAgentAppStates(
  userId: string,
  plan: PlanId,
  rows?: Connection[],
): Promise<AgentAppState[]> {
  return agentAppStates(await currentConnections(userId, rows), plan);
}

/**
 * The user's connections after asking Composio about pending ones. `rows`: as the caller has just
 * read them; they are read again only when one was pending, since its status may have changed.
 */
export async function currentConnections(
  userId: string,
  rows?: Connection[],
): Promise<Connection[]> {
  const read = rows ?? (await listConnections(userId));
  return (await refreshPendingConnections(userId, read)) ? listConnections(userId) : read;
}

/** At most this many actions in one answer of list_app_actions. */
export const MAX_LISTED_ACTIONS = 100;

/**
 * Splits `total` places between lists of these sizes: an even share each, and what a short list
 * does not use goes to the longer ones.
 */
export function fairShares(sizes: number[], total: number): number[] {
  const order = sizes.map((_, i) => i).sort((a, b) => sizes[a]! - sizes[b]!);
  const out = sizes.map(() => 0);
  let left = total;
  order.forEach((i, k) => {
    out[i] = Math.min(sizes[i]!, Math.floor(left / (order.length - k)));
    left -= out[i]!;
  });
  return out;
}

/**
 * One action in list_app_actions: its name and what it does in one line. No input schema: with
 * them, Gmail's 63 actions came to about 115 thousand characters (some 33 thousand tokens), and on
 * 15 October the agent paged through that with its own tools for most of a minute. One action's
 * inputs come from describe_app_action.
 */
export interface ListedAction {
  action: string;
  app: string;
  description: string;
  requires_approval: boolean;
  costs_credits: number;
}

/** A listed action's description: its first sentence, at most this long. */
export const LISTED_DESCRIPTION_CHARS = 120;

/** The first sentence of a description, on one line, cut at LISTED_DESCRIPTION_CHARS. */
export function oneLine(description: string): string {
  const flat = description.replace(/\s+/g, ' ').trim();
  const end = flat.search(/[.!?](\s|$)/);
  const first = end >= 0 ? flat.slice(0, end + 1) : flat;
  return first.length <= LISTED_DESCRIPTION_CHARS
    ? first
    : `${first.slice(0, LISTED_DESCRIPTION_CHARS - 1).trimEnd()}…`;
}

export interface ListedApp {
  app: string;
  name: string;
  status: AgentAppStatus;
  /** How many actions the app has (matching the search words, when they are given). */
  actions?: number;
  note?: string;
}

/** Words that narrow nothing in a search for an action. */
const STOP_WORDS = new Set(
  'a all an and any are by for from i in is me my of on or the to with'.split(' '),
);

/** Short words people use, as the actions spell them. */
const SPELLED_OUT: Record<string, string[]> = { pr: ['pull', 'request'], prs: ['pull', 'request'] };

/** A word without its plural ending: "repositories" → "repository", "pulls" → "pull". */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** The words of a text, slug or search: lowercase, split at anything not a letter or digit. */
const wordsOf = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(stem);

/** The words of a search that narrow it, with the short ones spelled out. */
export function searchWords(search: string): string[] {
  const out = new Set<string>();
  for (const raw of search.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw || STOP_WORDS.has(raw)) continue;
    for (const w of SPELLED_OUT[raw] ?? [raw]) out.add(stem(w));
  }
  return [...out];
}

/** A search word fits a word of the action when it starts it ("repo" fits "repository"). */
const fits = (q: string, words: string[]) =>
  words.some((w) => (q.length <= 2 ? w === q : w.startsWith(q)));

/**
 * The actions that fit a search, best first. Each word of the search is looked for in the action's
 * name (its slug and title) and in its description, so "list pull requests" finds
 * GITHUB_LIST_PULL_REQUESTS ("Lists pull requests for a GitHub repository"). Until 17 October 2026
 * the whole search had to appear as it was typed, and it did not. An action with every word comes
 * first, the ones with the words in their name before the ones with them only in the description.
 * When no action has every word, the ones with the most of them, and `partial` says so.
 */
export function matchActions(
  tools: ComposioTool[],
  search: string,
): { tools: ComposioTool[]; partial: boolean } {
  const words = searchWords(search);
  if (words.length === 0) return { tools, partial: false };
  const scored = tools.map((t, i) => {
    const named = [...wordsOf(t.slug), ...wordsOf(t.name)];
    const described = wordsOf(t.description);
    let found = 0;
    let score = 0;
    for (const q of words) {
      if (fits(q, named)) {
        found += 1;
        score += 2;
      } else if (fits(q, described)) {
        found += 1;
        score += 1;
      }
    }
    return { t, i, found, score };
  });
  const most = Math.max(0, ...scored.map((s) => s.found));
  if (most === 0) return { tools: [], partial: false };
  return {
    tools: scored
      .filter((s) => s.found === most)
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .map((s) => s.t),
    partial: most < words.length,
  };
}

/**
 * list_app_actions: the user's apps with their state, and the actions of the connected ones.
 * Composio is asked once per app, so an app with hundreds of actions (GitHub) cannot crowd out the
 * others; then every app gets a fair share of the MAX_LISTED_ACTIONS places. Search words are
 * matched against all of an app's actions (matchActions), the best first.
 */
export async function appActionsFor(
  userId: string,
  plan: PlanId,
  filter: { app?: string; search?: string } = {},
  rows?: Connection[],
): Promise<{ apps: ListedApp[]; actions: ListedAction[]; note?: string }> {
  const wanted = filter.app?.trim().toLowerCase();
  const states = (await currentAgentAppStates(userId, plan, rows)).filter(
    (s) => !wanted || s.app.slug === wanted || s.app.toolkit === wanted,
  );
  const q = filter.search?.trim();
  const fetched = await Promise.all(
    states.map(async (s): Promise<ComposioTool[] | Error | null> => {
      if (s.status !== 'connected') return null;
      try {
        return await toolkitTools(s.app.toolkit);
      } catch (err) {
        logger().warn({ userId, app: s.app.slug, err: String(err) }, 'composio list tools failed');
        return err instanceof Error ? err : new Error(String(err));
      }
    }),
  );
  // With search words: the actions that have them all, in any app. Only when no app has an action
  // with every word, each app's actions with the most of them.
  const matched = fetched.map((l) => (Array.isArray(l) && q ? matchActions(l, q) : null));
  const anyWhole = matched.some((m) => m && !m.partial && m.tools.length > 0);
  const lists = fetched.map((l, i) => {
    const m = matched[i];
    if (!m) return l;
    return anyWhole && m.partial ? [] : m.tools;
  });
  const shares = fairShares(
    lists.map((l) => (Array.isArray(l) ? l.length : 0)),
    MAX_LISTED_ACTIONS,
  );
  const apps: ListedApp[] = [];
  const actions: ListedAction[] = [];
  states.forEach((s, i) => {
    const base = { app: s.app.slug, name: s.app.name, status: s.status };
    const list = lists[i];
    if (list === null || list === undefined) {
      apps.push({ ...base, note: s.note });
      return;
    }
    if (list instanceof Error) {
      apps.push({
        ...base,
        note: `${s.app.name}'s actions could not be listed right now. Try again in a moment.`,
      });
      return;
    }
    const shown = list.slice(0, shares[i]);
    const notes: string[] = [];
    if (q && !anyWhole && list.length === 0)
      notes.push(
        `No ${s.app.name} action matches "${q}". Search again with other words: the thing ` +
          '(e.g. "pull request", "issue", "event") or what to do with it ("list", "create").',
      );
    else if (q && !anyWhole && matched[i]?.partial)
      notes.push(`No ${s.app.name} action has every word of "${q}": these have the most of them.`);
    if (shown.length < list.length)
      notes.push(
        `Showing ${shown.length} of its ${list.length} actions${q ? ' that match, the best first' : ''}. ` +
          `To find another, call list_app_actions again with app "${s.app.slug}" and search words.`,
      );
    apps.push({
      ...base,
      actions: list.length,
      ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
    });
    for (const t of shown)
      actions.push({
        action: t.slug,
        app: s.app.slug,
        description: oneLine(t.description),
        requires_approval: actionNeedsApproval(t.slug),
        costs_credits: actionChangesSomething(t.slug, t.tags) ? 1 : 0,
      });
  });
  if (states.length > 0) return { apps, actions };
  const named = wanted && CATALOG.find((a) => a.slug === wanted || a.toolkit === wanted);
  const note = !wanted
    ? `No app is connected. Your user connects apps on the Integrations page (${appsPageUrl()}).`
    : named
      ? `${named.name} is not connected. Your user connects it on the Integrations page (${appsPageUrl()}).`
      : `There is no app "${filter.app}". Call list_app_actions with no app to see the connected ones.`;
  return { apps, actions, note };
}

/** describe_app_action: one action as Composio describes it, with its inputs. */
export interface DescribedAction {
  action: string;
  app: string;
  description: string;
  requires_approval: boolean;
  costs_credits: number;
  input_schema: Record<string, unknown>;
}

/**
 * One action of a catalog app, with its input schema (from the app's listing, kept 10 minutes, or
 * asked of Composio by name). Throws a message for the agent when the action is unknown or
 * Composio can't be asked. Reads nothing of the user's: an action's inputs are the same for all.
 */
export async function describeAppAction(action: string): Promise<DescribedAction> {
  const app = appOfAction(action);
  if (!app)
    throw new Error(
      `"${action}" is not an action of an app Textcrew connects. Call list_app_actions to see the actions.`,
    );
  let tool: ComposioTool | null;
  try {
    tool = await actionTool(app.toolkit, action);
  } catch (err) {
    logger().warn({ app: app.slug, action, err: String(err) }, 'composio describe tool failed');
    throw new Error(
      `${app.name}'s actions could not be described right now. Try again in a moment.`,
      { cause: err },
    );
  }
  if (!tool)
    throw new Error(
      `${app.name} has no action "${action}". Find the right one with list_app_actions (app "${app.slug}").`,
    );
  return {
    action: tool.slug,
    app: app.slug,
    description: tool.description,
    requires_approval: actionNeedsApproval(tool.slug),
    costs_credits: actionChangesSomething(tool.slug, tool.tags) ? 1 : 0,
    input_schema: tool.inputParameters,
  };
}
