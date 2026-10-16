// Automations with steps (docs/backend-report.md, "Automations with steps"; the design is
// docs/automations-steps-proposal.md): up to 6 steps, each an app action or a Tex instruction, with
// an "only if" on the result of the step before. This file holds what the steps ARE: how one given
// by the canvas or by Tex is made whole and checked (every problem, each naming its step), how they
// read in words, and how a condition is decided. Running them is runs.ts.
import { randomBytes } from 'node:crypto';
import type { PlanId } from '../auth/users.ts';
import { connectionForToolkit } from '../integrations/apps.ts';
import {
  actionNeedsApproval,
  appAllowedOnPlan,
  appForToolkit,
  findApp,
} from '../integrations/catalog.ts';
import { checkFixedInputs } from '../integrations/step-actions.ts';
import type { AutomationStep, RunStep, StepCondition } from './schema.ts';

export type { AutomationStep, StepCondition };

/** At most this many steps in one automation. */
export const MAX_STEPS = 6;
/** A step's saved result is cut to this many characters. */
export const STEP_RESULT_CHARS = 4000;

const ID = /^[a-z0-9_]{1,24}$/;
const PLAN_NAMES: Record<PlanId, string> = { free: 'Free', pro: 'Pro', max: 'Max' };

/** A step as the canvas or Tex gives it: only its type is needed to check it. */
export interface StepInput {
  id?: string | null;
  type: 'action' | 'tex';
  title?: string | null;
  app?: string | null;
  action?: string | null;
  inputs?: Record<string, unknown> | null;
  instruction?: string | null;
  readApps?: string[] | null;
  askFirst?: boolean | null;
  onlyIf?: {
    kind: StepCondition['kind'];
    words?: string[] | null;
    question?: string | null;
  } | null;
  showResult?: boolean | null;
}

/** One thing wrong with the steps: the step it belongs to (null: the list itself). */
export interface StepProblem {
  stepId: string | null;
  message: string;
}

const appOf = (name: string) => findApp(name) ?? appForToolkit(name);
export const appNameOf = (slug: string | null | undefined) =>
  (slug && appOf(slug)?.name) || slug || 'the app';

/** A new short step id. */
export function newStepId(): string {
  return `s${randomBytes(4).toString('hex').slice(0, 6)}`;
}

const cut = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

function condition(input: StepInput['onlyIf']): StepCondition {
  switch (input?.kind) {
    case 'found':
      return { kind: 'found' };
    case 'mentions':
      return {
        kind: 'mentions',
        words: (input.words ?? [])
          .map((w) => w.trim())
          .filter(Boolean)
          .slice(0, 10),
      };
    case 'tex':
      return { kind: 'tex', question: (input.question ?? '').trim() };
    default:
      return { kind: 'always' };
  }
}

/**
 * The steps made whole (ids, titles, a risky action's "ask me first" on) and checked, all at once:
 * every problem names its step ("Step 4: …"). `apps`: every app the steps name, once each, for the
 * automation's `apps`. Composio that can't be asked about an action is not held against its step.
 * `shapeOnly`: only made whole, with nothing asked of the user's connections or of Composio (the
 * user's own draft for Tex, which Tex fixes).
 */
export async function examineSteps(
  userId: string,
  plan: PlanId,
  given: StepInput[],
  opts: { shapeOnly?: boolean } = {},
): Promise<{ steps: AutomationStep[]; problems: StepProblem[]; apps: string[] }> {
  const problems: StepProblem[] = [];
  if (given.length > MAX_STEPS)
    problems.push({ stepId: null, message: `An automation has up to ${MAX_STEPS} steps.` });
  const seen = new Set<string>();
  const apps: string[] = [];
  const connected = new Map<string, boolean>();
  const isConnected = async (toolkit: string) => {
    if (!connected.has(toolkit))
      connected.set(toolkit, Boolean(await connectionForToolkit(userId, toolkit)));
    return connected.get(toolkit)!;
  };
  /** An app a step names: known, on the plan, connected. Its slug, or null with the problem said. */
  const appCheck = async (name: string, say: (m: string) => void): Promise<string | null> => {
    const app = appOf(name);
    if (!app) {
      say(`"${name}" is not an app we know.`);
      return null;
    }
    if (opts.shapeOnly) {
      // Nothing asked.
    } else if (!appAllowedOnPlan(app, plan))
      say(`${app.name} isn't on your ${PLAN_NAMES[plan]} plan.`);
    else if (!(await isConnected(app.toolkit)))
      say(`${app.name} is not connected. Connect it under Integrations, Apps.`);
    if (!apps.includes(app.slug)) apps.push(app.slug);
    return app.slug;
  };

  const steps: AutomationStep[] = [];
  for (const [i, s] of given.entries()) {
    const n = i + 1;
    let id = (s.id ?? '').trim().toLowerCase();
    if (!ID.test(id)) id = newStepId();
    while (seen.has(id)) {
      problems.push({ stepId: id, message: `Step ${n}: another step has the same id.` });
      id = newStepId();
    }
    seen.add(id);
    const say = (message: string) =>
      problems.push({ stepId: id, message: `Step ${n}: ${message}` });
    const onlyIf = condition(s.onlyIf);
    if (n === 1 && onlyIf.kind !== 'always')
      say('the first step always runs, so it has no "only if".');
    if (onlyIf.kind === 'mentions' && !onlyIf.words.length)
      say('give at least one word for "mentions".');
    if (onlyIf.kind === 'tex' && !onlyIf.question) say('write the question Tex decides.');
    const showResult = s.showResult === true;
    const title = (s.title ?? '').trim();

    if (s.type === 'action') {
      const appSlug = s.app?.trim() ? await appCheck(s.app.trim(), say) : null;
      if (!s.app?.trim()) say('pick the app.');
      const action = (s.action ?? '').trim().toUpperCase();
      const inputs = s.inputs && typeof s.inputs === 'object' ? { ...s.inputs } : {};
      let made = action;
      if (!action) say('pick the action.');
      else if (appSlug && !opts.shapeOnly) {
        const check = await checkFixedInputs(appOf(appSlug)!, action, inputs);
        if (!check.ok) say(check.problem);
        else made = `${appNameOf(appSlug)}: ${check.title.toLowerCase()}`;
      }
      steps.push({
        id,
        type: 'action',
        title: cut(title || made || 'App action', 80),
        app: appSlug ?? (s.app?.trim() || null),
        action: action || null,
        inputs,
        instruction: null,
        readApps: [],
        // A risky action (send, delete, pay) always asks first: it can't be turned off.
        askFirst: s.askFirst === true || (action ? actionNeedsApproval(action) : false),
        onlyIf,
        showResult,
      });
    } else {
      const instruction = (s.instruction ?? '').trim();
      if (!instruction) say('write what Tex does in this step.');
      const readApps: string[] = [];
      for (const name of s.readApps ?? []) {
        const slug = await appCheck(name.trim(), say);
        if (slug && !readApps.includes(slug)) readApps.push(slug);
      }
      steps.push({
        id,
        type: 'tex',
        title: cut(title || instruction || 'Tex', 80),
        app: null,
        action: null,
        inputs: {},
        instruction: instruction || null,
        readApps,
        askFirst: false,
        onlyIf,
        showResult,
      });
    }
  }
  return { steps, problems, apps };
}

/** The step as the API gives it: with whether its action is risky ("ask me first" locked on). */
export function toApiStep(s: AutomationStep) {
  return {
    id: s.id,
    type: s.type,
    title: s.title,
    app: s.app,
    action: s.action,
    inputs: s.inputs ?? {},
    instruction: s.instruction,
    readApps: s.readApps ?? [],
    askFirst: s.askFirst,
    onlyIf: s.onlyIf,
    showResult: s.showResult,
    risky: s.type === 'action' && s.action ? actionNeedsApproval(s.action) : false,
  };
}

// ---------------------------------------------------------------- in words

/** "only if step 1 found something". Empty for `always`. */
export function conditionWords(c: StepCondition, n: number): string {
  switch (c.kind) {
    case 'found':
      return `only if step ${n - 1} found something`;
    case 'mentions':
      return `only if step ${n - 1} mentions ${c.words.map((w) => `"${w}"`).join(' or ')}`;
    case 'tex':
      return `only if Tex decides yes: ${c.question}`;
    default:
      return '';
  }
}

const inputsWords = (inputs: Record<string, unknown>) => {
  const parts = Object.entries(inputs).map(
    ([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`,
  );
  return parts.length ? ` (${cut(parts.join(', '), 120)})` : '';
};

/** One step in one line, for a chat app's outline: "2. Tex: Pick the urgent ones — only if …". */
export function stepLine(s: AutomationStep, n: number): string {
  const what =
    s.type === 'action'
      ? `${appNameOf(s.app)}: ${s.title.replace(/^[^:]+:\s*/, '')}${inputsWords(s.inputs ?? {})}`
      : `Tex: ${cut(s.instruction ?? s.title, 100)}`;
  const extra = [
    conditionWords(s.onlyIf, n),
    s.type === 'action' && s.askFirst ? 'asks first' : '',
    s.showResult ? 'shown to you' : '',
  ].filter(Boolean);
  return `${n}. ${what}${extra.length ? ` — ${extra.join(', ')}` : ''}`;
}

// ---------------------------------------------------------------- deciding a condition

const EMPTY_WORDS = /^(none|nothing|no results?|nothing found|n\/a|\[\]|\{\})\.?$/i;

/**
 * Whether an app's answer found nothing: no value, an empty list or text, or an object whose lists
 * are all empty (Gmail's fetch with no emails: `{ messages: [] }`).
 */
export function isEmptyResult(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return !value.trim() || EMPTY_WORDS.test(value.trim());
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return true;
    const lists = entries.filter(([, v]) => Array.isArray(v));
    if (lists.length) return lists.every(([, v]) => (v as unknown[]).length === 0);
    // A one-item wrapper ({ data: … }, { result: … }): what it holds.
    if (entries.length === 1) return isEmptyResult(entries[0]![1]);
    return false;
  }
  return false;
}

/**
 * The "only if" of a step, decided on the step before it: true, false, or `tex` (Tex decides, and
 * has not said yet). `prev` is the step before's record in the run.
 */
export function decideCondition(c: StepCondition, prev: RunStep | undefined): boolean | 'tex' {
  switch (c.kind) {
    case 'always':
      return true;
    case 'found':
      // Set when the step was done: from the app's answer, or from Tex's finish_step.
      return prev?.found === true;
    case 'mentions': {
      // A step that found nothing mentions nothing: "No urgent emails found" holds the word
      // "urgent", but there is nothing urgent to act on (seen in the 4d run on 16 October).
      if (prev?.found === false) return false;
      const text = (prev?.result ?? '').toLowerCase();
      return c.words.some((w) => text.includes(w.toLowerCase()));
    }
    case 'tex':
      return 'tex';
  }
}
