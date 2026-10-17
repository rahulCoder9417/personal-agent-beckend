// Skip rules (founder's decision, 17 October: "make a section where it is asked if it wanna be
// skipped, like skip approval, but have a log in the approvals with auto approved"). A rule is the
// user's standing "don't ask again" for one risky app action. While it holds, that action runs at
// once without a card, and is kept in Approvals as `auto_approved` (approvals.ts, claimAutoApproval;
// the run itself is run_app_action's, platform-mcp/tools/apps.ts).
//
// Who decides what:
//   - Only the user makes or removes a rule, in the web app with their session (the API routes).
//     The agent has no tool for rules, and nothing the agent sends can make, widen or list one.
//   - Which actions a rule may cover is integrations/catalog.ts (approvalSkippable): deleting,
//     paying, merging and the platform's own kinds always ask, whatever a stored rule says.
//   - An automation set to ask before anything that changes something stays strict: its run never
//     uses a rule (apps.ts).
import { and, asc, count, eq } from 'drizzle-orm';
import { db } from '../../shared/db/client.ts';
import { AppError, badRequest, conflict, notFound } from '../../shared/errors.ts';
import { newId } from '../../shared/ids.ts';
import { audit } from '../admin/audit.ts';
import {
  actionSendsToOthers,
  actionWords,
  approvalSkippable,
  findApp,
} from '../integrations/catalog.ts';
import { approvalKind } from './approval-kinds.ts';
import { skipRules, type SkipScope, approvals } from './schema.ts';

export type SkipRule = typeof skipRules.$inferSelect;
type Approval = typeof approvals.$inferSelect;

/** At most this many rules per user. */
export const MAX_SKIP_RULES = 50;
/** At most this many recipients on one `listed` rule. */
const MAX_RECIPIENTS = 50;

// --- who or where a request goes ----------------------------------------------------------------

/**
 * Inputs that name who or where a request goes: to, cc, bcc, recipient(s), attendees, invitees,
 * guests, a channel or a chat (Gmail's recipient_email, cc, bcc and extra_recipients; Outlook's
 * to_email and cc_emails; Slack's channel; Teams' chat_id and channel_id; a calendar's attendees).
 * More inputs counted as recipients only make a listed rule match less: never more.
 */
const RECIPIENT_INPUT =
  /(^|_)(to|cc|bcc|recipient|recipients|attendee|attendees|invitee|invitees|guest|guests|channel|channels|chat|chats)(_|$)/i;
/** A person's display name beside the address (Outlook's to_name): not where it goes. */
const NAME_INPUT = /(^|_)names?$/i;
/** In an object (a calendar attendee, an Outlook recipient): the keys that hold the address. */
const ADDRESS_KEY = /(email|address)/i;

function normal(raw: string): string | null {
  let v = raw.trim();
  const angle = /<([^<>@\s]+@[^<>\s]+)>/.exec(v);
  if (angle) v = angle[1]!;
  v = v.replace(/^mailto:/i, '').trim();
  if (!v.includes('@')) v = v.replace(/^[#@]+/, '');
  v = v.toLowerCase();
  return v && v.length <= 254 ? v : null;
}

function leaves(value: unknown, out: string[], depth = 0): void {
  if (depth > 4 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    for (const part of value.split(/[,;\n]/)) {
      const v = normal(part);
      if (v) out.push(v);
    }
  } else if (typeof value === 'number') {
    out.push(String(value));
  } else if (Array.isArray(value)) {
    for (const item of value) leaves(item, out, depth + 1);
  } else if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const addresses = entries.filter(([k]) => ADDRESS_KEY.test(k));
    // { email, displayName } → the email; { emailAddress: { address, name } } → the address. An
    // object without such a key: every value in it, the careful way.
    for (const [, v] of addresses.length ? addresses : entries) leaves(v, out, depth + 1);
  }
}

/** Where a GitHub action acts: its repository, as owner/repo. */
function githubRepo(args: Record<string, unknown>): string | null {
  const { owner, repo } = args;
  if (typeof owner !== 'string' || typeof repo !== 'string' || !owner.trim() || !repo.trim())
    return null;
  return `${owner.trim()}/${repo.trim()}`.toLowerCase();
}

const isGithub = (action: string) => action.toUpperCase().startsWith('GITHUB_');

/**
 * Who or where this request goes, lower case, each once: the addresses and channels in its
 * recipient inputs, or for GitHub its repository (owner/repo). Empty when it names none.
 */
export function recipientsOf(action: string, args: Record<string, unknown>): string[] {
  if (isGithub(action)) {
    const repo = githubRepo(args);
    return repo ? [repo] : [];
  }
  const out: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (!RECIPIENT_INPUT.test(key)) continue;
    if (NAME_INPUT.test(key) && !/channel/i.test(key)) continue;
    leaves(value, out);
  }
  return [...new Set(out)];
}

// --- what the card may offer --------------------------------------------------------------------

/** What "Don't ask again for this…" may offer for one request (OpenAPI SkipOffer). */
export interface SkipOffer {
  actionName: string;
  recipients: string[];
  target: 'people' | 'repository';
  /** The default first. */
  scopes: SkipScope[];
}

/**
 * The choices for a rule made from this request, or null when the action always asks (or is not
 * risky: then nothing asks). With recipients: only to these (the default) or anyone. Without: an
 * action that sends to others can only be "anyone" (a post goes to everyone who sees it); any
 * other is "this action", which still asks when a request of it does name recipients.
 */
export function skipOfferFor(action: string, args: Record<string, unknown>): SkipOffer | null {
  if (!approvalSkippable(action, args)) return null;
  const recipients = recipientsOf(action, args);
  return {
    actionName: actionWords(action),
    recipients,
    target: isGithub(action) ? 'repository' : 'people',
    scopes: recipients.length
      ? ['listed', 'anyone']
      : actionSendsToOthers(action)
        ? ['anyone']
        : ['action'],
  };
}

/** The offer on an approval's card: a pending request for an app's action, nothing else. */
export function skipOfferOf(
  a: Pick<Approval, 'status' | 'app' | 'action' | 'arguments'>,
): SkipOffer | null {
  if (a.status !== 'pending' || !a.app || !a.action) return null;
  if (approvalKind(a) !== 'app_action') return null;
  return skipOfferFor(a.action, a.arguments ?? {});
}

// --- does a rule cover a request ---------------------------------------------------------------

/**
 * Whether this rule lets this request run without asking. Never for an action that always asks,
 * whatever the rule says (one written straight into the database included).
 */
export function ruleCovers(
  rule: Pick<SkipRule, 'action' | 'scope' | 'recipients'>,
  action: string,
  args: Record<string, unknown>,
): boolean {
  if (rule.action !== action.toUpperCase()) return false;
  if (!approvalSkippable(action, args)) return false;
  const recipients = recipientsOf(action, args);
  switch (rule.scope) {
    case 'anyone':
      return true;
    case 'listed': {
      const allowed = new Set(rule.recipients ?? []);
      return recipients.length > 0 && recipients.every((r) => allowed.has(r));
    }
    case 'action':
      return recipients.length === 0;
    default:
      return false;
  }
}

/** The most specific first: a list, then the action alone, then anyone. */
const SCOPE_ORDER: Record<SkipScope, number> = { listed: 0, action: 1, anyone: 2 };

/** The user's rule that lets this request run without asking, or null: then it asks. */
export async function matchingSkipRule(
  userId: string,
  action: string,
  args: Record<string, unknown>,
): Promise<SkipRule | null> {
  if (!approvalSkippable(action, args)) return null;
  const rows = await db()
    .select()
    .from(skipRules)
    .where(and(eq(skipRules.userId, userId), eq(skipRules.action, action.toUpperCase())));
  return (
    rows
      .filter((r) => ruleCovers(r, action, args))
      .sort((a, b) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope])[0] ?? null
  );
}

/** A rule's scope in words, for the agent and the activity log: "only to a@b.com". */
export function scopeWords(rule: Pick<SkipRule, 'action' | 'scope' | 'recipients'>): string {
  const into = isGithub(rule.action) ? 'only in' : 'only to';
  if (rule.scope === 'listed') return `${into} ${(rule.recipients ?? []).join(', ')}`;
  if (rule.scope === 'anyone') return isGithub(rule.action) ? 'in any repository' : 'to anyone';
  return 'whenever it names no recipients';
}

// --- the user's rules (web API only) -------------------------------------------------------------

export function toApiSkipRule(r: SkipRule) {
  return {
    id: r.id,
    app: r.app,
    action: r.action,
    actionName: actionWords(r.action),
    scope: r.scope,
    recipients: r.scope === 'listed' ? (r.recipients ?? []) : [],
    createdAt: r.createdAt.toISOString(),
  };
}

/** The user's rules, newest first. */
export async function listSkipRules(userId: string): Promise<SkipRule[]> {
  const rows = await db()
    .select()
    .from(skipRules)
    .where(eq(skipRules.userId, userId))
    .orderBy(asc(skipRules.createdAt));
  return rows.reverse();
}

const notSkippable = (message: string) => new AppError(400, 'not_skippable', message);

/**
 * The card's "Don't ask again for this…": a rule from one of the user's approvals, for its app and
 * action, with a scope its offer has. Made only here, from the web API with the user's session.
 * A rule for the same action and scope already there is returned; a `listed` one gets the new
 * recipients added.
 */
export async function createSkipRule(
  userId: string,
  input: { approvalId: string; scope: SkipScope; recipients?: string[] },
): Promise<SkipRule> {
  const [a] = await db()
    .select()
    .from(approvals)
    .where(and(eq(approvals.userId, userId), eq(approvals.id, input.approvalId)));
  if (!a) throw notFound('Approval not found');
  const offer =
    a.app && a.action && approvalKind(a) === 'app_action'
      ? skipOfferFor(a.action, a.arguments ?? {})
      : null;
  if (!offer || !a.app || !a.action)
    throw notSkippable(
      'This action always asks first: deleting, paying, merging and Tex’s own commands and pushes can’t be skipped.',
    );
  if (!offer.scopes.includes(input.scope))
    throw notSkippable(`For this action the choice is: ${offer.scopes.join(' or ')}.`);
  let recipients: string[] = [];
  if (input.scope === 'listed') {
    const given = input.recipients ?? offer.recipients;
    recipients = [...new Set(given.map(normal).filter((r): r is string => Boolean(r)))];
    if (!recipients.length) throw badRequest('Name at least one recipient');
  }
  const action = a.action.toUpperCase();
  const app = findApp(a.app)?.slug ?? a.app;

  const [existing] = await db()
    .select()
    .from(skipRules)
    .where(
      and(
        eq(skipRules.userId, userId),
        eq(skipRules.action, action),
        eq(skipRules.scope, input.scope),
      ),
    );
  if (existing) {
    if (input.scope !== 'listed') return existing;
    const merged = [...new Set([...(existing.recipients ?? []), ...recipients])];
    if (merged.length > MAX_RECIPIENTS)
      throw badRequest(`A rule holds at most ${MAX_RECIPIENTS} recipients`);
    if (merged.length === (existing.recipients ?? []).length) return existing;
    const [updated] = await db()
      .update(skipRules)
      .set({ recipients: merged })
      .where(and(eq(skipRules.userId, userId), eq(skipRules.id, existing.id)))
      .returning();
    await logRule(userId, 'skip_rule_created', updated!);
    return updated!;
  }
  const [{ n } = { n: 0 }] = await db()
    .select({ n: count() })
    .from(skipRules)
    .where(eq(skipRules.userId, userId));
  if (n >= MAX_SKIP_RULES)
    throw new AppError(
      409,
      'too_many_rules',
      `You have ${MAX_SKIP_RULES} skip rules already. Remove one first.`,
    );
  const [row] = await db()
    .insert(skipRules)
    .values({
      id: newId('skp'),
      userId,
      app,
      action,
      scope: input.scope,
      recipients,
      createdVia: 'web',
      approvalId: a.id,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) {
    // Made a moment ago by the same click twice: that one.
    const [made] = await db()
      .select()
      .from(skipRules)
      .where(
        and(
          eq(skipRules.userId, userId),
          eq(skipRules.action, action),
          eq(skipRules.scope, input.scope),
        ),
      );
    if (!made) throw conflict('Could not save the rule; try again');
    return made;
  }
  await logRule(userId, 'skip_rule_created', row);
  return row;
}

/** Removes one of the user's rules; that action asks again from now on. False: not theirs. */
export async function deleteSkipRule(userId: string, id: string): Promise<boolean> {
  const [row] = await db()
    .delete(skipRules)
    .where(and(eq(skipRules.userId, userId), eq(skipRules.id, id)))
    .returning();
  if (!row) return false;
  await logRule(userId, 'skip_rule_removed', row);
  return true;
}

async function logRule(
  userId: string,
  action: 'skip_rule_created' | 'skip_rule_removed',
  r: SkipRule,
): Promise<void> {
  const what = `${findApp(r.app)?.name ?? r.app}: ${actionWords(r.action).toLowerCase()} ${scopeWords(r)}`;
  await audit({
    userId,
    actor: 'user',
    action,
    summary:
      action === 'skip_rule_created'
        ? `Don't ask again: ${what}`
        : `Asks again from now on: ${what}`,
    details: { ruleId: r.id, action: r.action, scope: r.scope },
  });
}

/** Account deletion: every rule of the user. Safe to re-run. */
export async function deleteUserSkipRules(userId: string): Promise<number> {
  const res = await db().delete(skipRules).where(eq(skipRules.userId, userId));
  return res.rowCount ?? 0;
}
