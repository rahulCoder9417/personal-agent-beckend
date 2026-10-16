// The runs of automations with steps (docs/backend-report.md, "Automations with steps"). A run is
// still one turn of Tex in the user's container: the platform keeps the step pointer here and the
// agent's tools ask here before they act, so a call that does not fit the current step is refused.
// One run per event (the table's unique key), so a job that runs again never starts a second one.
//
// The run's life: running → (waiting for a yes → running) → done | stopped | failed, or superseded
// when a newer run of the same automation starts while it waits. Every change of the run is made
// with its row locked, so two tool calls at once can't both move the pointer.
import { isDeepStrictEqual } from 'node:util';
import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import { db, type Tx } from '../../shared/db/client.ts';
import { newId } from '../../shared/ids.ts';
import { logger } from '../../shared/logger.ts';
import { publish } from '../channels/stream.ts';
import { appOfAction } from '../integrations/action-inputs.ts';
import { appForToolkit, findApp } from '../integrations/catalog.ts';
import { replaceRunApproval } from '../orchestrator/approvals.ts';
import type { Automation } from './automations.ts';
import { automationRuns, type AutomationStep, type RunStep } from './schema.ts';
import {
  appNameOf,
  conditionWords,
  decideCondition,
  isEmptyResult,
  STEP_RESULT_CHARS,
} from './steps.ts';

export type Run = typeof automationRuns.$inferSelect;

/** At most this many app calls in one step, and in one run. */
export const MAX_CALLS_PER_STEP = 10;
export const MAX_CALLS_PER_RUN = 30;
/** A step's own action may fail once and be tried again; a second failure fails the step. */
export const MAX_TRIES = 2;
/** Results are removed this long after the run ended; the trail is kept 30 days. */
export const RESULTS_KEEP_MS = 2 * 24 * 3600 * 1000;
export const RUNS_KEEP_MS = 30 * 24 * 3600 * 1000;
/** A run waits this long for the user's OK (an approval's own life). */
export const WAIT_MS = 24 * 3600 * 1000;

const ENDED = new Set<Run['state']>(['done', 'stopped', 'failed', 'superseded']);
export const runEnded = (r: Pick<Run, 'state'>) => ENDED.has(r.state);

const cut = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

// ---------------------------------------------------------------- reading, and for the API

export function toApiRun(r: Run) {
  return {
    id: r.id,
    automationId: r.automationId,
    state: r.state,
    test: r.test,
    currentStepId: r.currentStepId,
    stopReason: r.stopReason,
    steps: r.plan.map((s, i) => {
      const rec = r.steps.find((x) => x.stepId === s.id);
      return {
        stepId: s.id,
        number: i + 1,
        title: s.title,
        state: rec?.state ?? 'pending',
        result: rec?.result ?? null,
        reason: rec?.reason ?? null,
        tries: rec?.tries ?? 0,
        approvalId: rec?.approvalId ?? null,
      };
    }),
    resultsRemoved: r.resultsRemovedAt !== null,
    startedAt: r.startedAt.toISOString(),
    endedAt: r.endedAt ? r.endedAt.toISOString() : null,
  };
}

const emitRun = (r: Run) =>
  publish(r.userId, 'automation_run.updated', toApiRun(r)).catch((err: unknown) =>
    logger().debug({ userId: r.userId, err: String(err) }, 'run update not published'),
  );

export async function getRun(userId: string, id: string): Promise<Run | undefined> {
  const [row] = await db()
    .select()
    .from(automationRuns)
    .where(and(eq(automationRuns.userId, userId), eq(automationRuns.id, id)));
  return row;
}

/** An automation's last runs, newest first (the canvas's trail). */
export async function listRuns(userId: string, automationId: string, limit = 10): Promise<Run[]> {
  return db()
    .select()
    .from(automationRuns)
    .where(and(eq(automationRuns.userId, userId), eq(automationRuns.automationId, automationId)))
    .orderBy(desc(automationRuns.startedAt), desc(automationRuns.id))
    .limit(limit);
}

/** The run's current step: its place, its plan and its record. */
export function currentStep(r: Run): { index: number; step: AutomationStep; rec: RunStep } | null {
  if (!r.currentStepId) return null;
  const index = r.plan.findIndex((s) => s.id === r.currentStepId);
  if (index < 0) return null;
  return { index, step: r.plan[index]!, rec: r.steps[index]! };
}

/**
 * Changes one run with its row locked: `fn` gets the run as it is now and changes its copy (the
 * steps are a copy too); what it returns is passed on. The change is saved, and the web app told,
 * only when `fn` changed something.
 */
async function withRun<T>(
  userId: string,
  runId: string,
  fn: (r: Run, tx: Tx) => Promise<T> | T,
): Promise<{ run: Run; out: T } | null> {
  const done = await db().transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(automationRuns)
      .where(and(eq(automationRuns.userId, userId), eq(automationRuns.id, runId)))
      .for('update');
    if (!row) return null;
    const before = JSON.stringify(row);
    const r: Run = { ...row, steps: row.steps.map((s) => ({ ...s })) };
    const out = await fn(r, tx);
    if (JSON.stringify(r) === before) return { run: r, out, changed: false };
    const [saved] = await tx
      .update(automationRuns)
      .set({
        state: r.state,
        currentStepId: r.currentStepId,
        steps: r.steps,
        appCalls: r.appCalls,
        stopReason: r.stopReason,
        turnId: r.turnId,
        endedAt: r.endedAt,
      })
      .where(eq(automationRuns.id, r.id))
      .returning();
    return { run: saved!, out, changed: true };
  });
  if (!done) return null;
  if (done.changed) await emitRun(done.run);
  return { run: done.run, out: done.out };
}

/** The run ends: its state, why, the current step's state, and every step not reached skipped. */
function end(r: Run, state: Run['state'], why: string | null, current?: Partial<RunStep>): void {
  const at = currentStep(r);
  if (at && current) Object.assign(r.steps[at.index]!, current);
  for (const s of r.steps) if (s.state === 'pending' || s.state === 'running') s.state = 'skipped';
  r.state = state;
  r.stopReason = why;
  r.currentStepId = null;
  r.endedAt = new Date();
}

// ---------------------------------------------------------------- starting a run

/**
 * The run of this event: made when it is new (the automation's steps copied in, step 1 current),
 * or the one made before when the job runs again. A new run supersedes the automation's older
 * runs that wait for a yes: their approval becomes "replaced", so a morning run never sends
 * yesterday's draft too (decision 6).
 */
export async function startRun(
  a: Automation,
  eventId: string,
  opts: { test?: boolean } = {},
): Promise<{ run: Run; created: boolean }> {
  const plan = a.steps ?? [];
  const [made] = await db()
    .insert(automationRuns)
    .values({
      id: newId('arn'),
      userId: a.userId,
      automationId: a.id,
      eventId,
      test: opts.test === true,
      currentStepId: plan[0]?.id ?? null,
      plan,
      steps: plan.map((s, i) => ({
        stepId: s.id,
        state: i === 0 ? 'running' : 'pending',
        result: null,
        reason: null,
        tries: 0,
        calls: 0,
        approvalId: null,
      })),
      turnId: eventId,
    })
    .onConflictDoNothing()
    .returning();
  if (!made) {
    const [seen] = await db()
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.eventId, eventId));
    return { run: seen!, created: false };
  }
  await emitRun(made);
  await supersedeWaiting(a, made.id);
  return { run: made, created: true };
}

/** The automation's runs that wait for a yes, other than `keep`, are superseded. */
async function supersedeWaiting(a: Automation, keep: string): Promise<void> {
  const waiting = await db()
    .select({ id: automationRuns.id })
    .from(automationRuns)
    .where(
      and(
        eq(automationRuns.userId, a.userId),
        eq(automationRuns.automationId, a.id),
        eq(automationRuns.state, 'waiting'),
      ),
    );
  for (const w of waiting) {
    if (w.id === keep) continue;
    const res = await withRun(a.userId, w.id, (r) => {
      if (r.state !== 'waiting') return null;
      const approvalId = currentStep(r)?.rec.approvalId ?? null;
      end(r, 'superseded', 'A newer run of this automation started, so this one stopped.', {
        state: 'skipped',
        reason: 'A newer run started while this step waited for your OK.',
      });
      return approvalId;
    });
    if (res?.out)
      await replaceRunApproval(a.userId, res.out).catch((err: unknown) =>
        logger().warn({ userId: a.userId, err: String(err) }, 'older approval not replaced'),
      );
  }
}

/** The run's turn now: set before the turn after a yes, so a rerun of that job carries on. */
export async function resumeAfterYes(
  userId: string,
  runId: string,
  approvalId: string,
  turnId: string,
): Promise<Run | null> {
  const res = await withRun(userId, runId, (r) => {
    if (r.state === 'running' && r.turnId === turnId) return true;
    const at = currentStep(r);
    if (r.state !== 'waiting' || !at || at.rec.approvalId !== approvalId) return false;
    r.state = 'running';
    r.turnId = turnId;
    at.rec.state = 'running';
    return true;
  });
  return res?.out ? res.run : null;
}

/**
 * The step a run waits on won't run: the user said no (the default words), or the automation was
 * paused meanwhile. The run stops there; the steps after it are skipped. Null: it no longer waits
 * on that approval (already stopped, superseded), so nothing is said twice.
 */
export async function stopAfterNo(
  userId: string,
  runId: string,
  approvalId: string,
  words: { why?: (n: number) => string; reason?: string } = {},
): Promise<Run | null> {
  const res = await withRun(userId, runId, (r) => {
    const at = currentStep(r);
    if (r.state !== 'waiting' || !at || at.rec.approvalId !== approvalId) return false;
    const n = at.index + 1;
    end(r, 'stopped', words.why?.(n) ?? `You said no to step ${n}, so it did not run.`, {
      state: 'skipped',
      reason: words.reason ?? 'You said no.',
    });
    return true;
  });
  return res?.out ? res.run : null;
}

// ---------------------------------------------------------------- what Tex is told

const inputsText = (inputs: Record<string, unknown>) =>
  Object.keys(inputs).length ? ` Fixed inputs: ${JSON.stringify(inputs)}.` : '';

/** One step for Tex: what it is, its "only if", and how to do it. */
function stepForTex(s: AutomationStep, n: number): string {
  const cond = conditionWords(s.onlyIf, n);
  const when = cond ? ` It runs ${cond}.` : '';
  const show = s.showResult ? " Show me this: put its result in the run's answer." : '';
  if (s.type === 'action') {
    const ask = s.askFirst
      ? ' Ask first: call request_approval for exactly this action, then end your turn; after the yes run it with that approval_id.'
      : '';
    return (
      `${n}. [step_id "${s.id}"] App action in ${appNameOf(s.app)}: ${s.action}.${inputsText(s.inputs ?? {})}` +
      ` Fill any other input from the results before.${when}${ask}${show}`
    );
  }
  const reads = s.readApps?.length
    ? ` You may read ${s.readApps.map(appNameOf).join(', ')} with actions that only read.`
    : ' It uses no app.';
  return (
    `${n}. [step_id "${s.id}"] Tex: ${s.instruction}.${reads} When done, call finish_step with ` +
    `step_id "${s.id}" and your result in words (found false if you found nothing).${when}${show}`
  );
}

/** What to do now, at the current step: for the turn's text and for every tool answer. */
export function nowText(r: Run): string {
  if (r.state === 'done')
    return (
      "All steps are done. Now write the run's answer with send_message: short, with the results of the " +
      'steps marked "Show me this". The platform adds the line with each step\'s state.'
    );
  if (r.state === 'stopped' || r.state === 'superseded')
    return `The run ends here (${r.stopReason ?? 'stopped'}). Write nothing more and end your turn: the platform tells the user.`;
  if (r.state === 'failed')
    return `The run failed: ${r.stopReason ?? 'a step failed'}. End your turn with one short sentence to the user saying which step failed and why.`;
  if (r.state === 'waiting')
    return "The run waits for the user's OK. End your turn now: the user sees the question with Approve and Deny.";
  const at = currentStep(r);
  if (!at) return 'End your turn.';
  const n = at.index + 1;
  const s = at.step;
  if (s.onlyIf.kind === 'tex' && at.rec.conditionMet === undefined)
    return (
      `Now step ${n}. It runs only if you decide yes: "${s.onlyIf.question}". Decide from the results so far, ` +
      `then call finish_step with step_id "${s.id}", condition_met true or false, and why in one line.`
    );
  if (s.type === 'action')
    return (
      `Now step ${n}: run ${s.action} in ${appNameOf(s.app)} with run_app_action` +
      (s.askFirst ? " after request_approval and the user's yes" : '') +
      `. You may first look something up with an action of ${appNameOf(s.app)} that only reads.`
    );
  return `Now step ${n}: ${s.instruction}. Then call finish_step with step_id "${s.id}" and your result.`;
}

/** The results so far, for a turn that carries on (after a crash, or after a yes). */
function doneSoFar(r: Run): string {
  const lines = r.plan
    .map((s, i) => {
      const rec = r.steps[i]!;
      if (rec.state !== 'done') return null;
      return `- Step ${i + 1} is done. Its result: ${cut(rec.result ?? '(none)', 1500)}`;
    })
    .filter(Boolean);
  return lines.length ? `Done so far (do not do these again):\n${lines.join('\n')}\n` : '';
}

/**
 * The text of a run's turn: the purpose, the numbered steps and the rules (one at a time, in
 * order, nothing extra), what is done already, and the step to do now. `head`: the automation's own
 * first lines (its name, a late or test note); `tail`: an app event's data.
 */
export function runTurnText(
  a: Pick<Automation, 'title' | 'instruction'>,
  r: Run,
  opts: { head: string; tail?: string },
): string {
  return [
    opts.head,
    `Purpose: ${a.instruction}`,
    'This automation runs in steps. The platform keeps the step you are on and refuses any call that does ' +
      'not fit it. Do one step at a time, in order, and nothing that is not a step. A Tex step only reads ' +
      'and writes words: it never changes anything in an app. Every tool answer ends with what comes next ' +
      '("next"): follow it. When it says the run ends, end your turn.',
    'Steps:',
    ...r.plan.map((s, i) => stepForTex(s, i + 1)),
    doneSoFar(r),
    nowText(r),
    ...(opts.tail ? [opts.tail] : []),
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------- the trail line

const MARK: Record<RunStep['state'], string> = {
  done: '✓',
  failed: '✗ failed',
  skipped: 'skipped',
  waiting: 'waiting for your OK',
  pending: 'skipped',
  running: '…',
};

/** "Steps: 1 ✓ 2 ✓ 3 ✓ 4 waiting for your OK". */
export function trailLine(r: Run): string {
  return `Steps: ${r.steps.map((s, i) => `${i + 1} ${MARK[s.state]}`).join(' ')}`;
}

// ---------------------------------------------------------------- the tools' checks

/** What a tool may do in a run with steps, or why it can't (`refusal`, for the agent). */
export type StepGate =
  | { ok: false; refusal: string }
  | {
      ok: true;
      /** `step`: the current step's own action. `lookup`: a read to look something up first. */
      kind: 'step' | 'lookup';
      run: Run;
      step: AutomationStep;
      index: number;
      /** The arguments with the step's fixed inputs put in. */
      args: Record<string, unknown>;
    };

const refuse = (refusal: string): StepGate => ({ ok: false, refusal });

/** Refusals when the run is not at a step that can act now. */
function notActing(r: Run): string | null {
  if (r.state === 'running') return null;
  return `Nothing was done. ${nowText(r)}`;
}

/** The fixed inputs put in, or the refusal when Tex changed one. */
function withFixed(
  s: AutomationStep,
  n: number,
  args: Record<string, unknown>,
): { args: Record<string, unknown> } | { refusal: string } {
  const fixed = s.inputs ?? {};
  for (const [k, v] of Object.entries(fixed))
    if (k in args && !isDeepStrictEqual(args[k], v))
      return {
        refusal:
          `Step ${n}'s input \`${k}\` is fixed to ${JSON.stringify(v)} by the user. Nothing was done: ` +
          'leave it out (the platform puts it in) or give exactly that value.',
      };
  return { args: { ...args, ...fixed } };
}

/**
 * Before an app action in a run with steps: the action must be the current step's (its fixed
 * inputs unchanged, put in when left out), or one that only reads, of the step's own app (an
 * action step) or of the apps a Tex step may read. A changing action in a Tex step, or an action of
 * another step or app, is refused, naming the current step. Counts the call: at most 10 in a step
 * and 30 in a run; past that the run fails.
 */
export async function gateAppAction(
  userId: string,
  runId: string,
  input: { action: string; args: Record<string, unknown>; changes: boolean },
): Promise<StepGate> {
  const res = await withRun(userId, runId, (r): StepGate => {
    const stop = notActing(r);
    if (stop) return refuse(stop);
    const at = currentStep(r);
    if (!at) return refuse('Nothing was done: the run has no step to do now. End your turn.');
    const n = at.index + 1;
    const s = at.step;
    if (s.onlyIf.kind === 'tex' && at.rec.conditionMet === undefined)
      return refuse(`Nothing was done. ${nowText(r)}`);
    const action = input.action.toUpperCase();
    let kind: 'step' | 'lookup';
    let args = input.args;
    const app = appOfAction(action);
    if (s.type === 'action') {
      if (action === (s.action ?? '').toUpperCase()) {
        kind = 'step';
        const fixed = withFixed(s, n, args);
        if ('refusal' in fixed) return refuse(fixed.refusal);
        args = fixed.args;
      } else if (
        !input.changes &&
        app &&
        app.slug === (findApp(s.app ?? '') ?? appForToolkit(s.app ?? ''))?.slug
      ) {
        kind = 'lookup';
      } else
        return refuse(
          `${input.action} is not step ${n}'s action, so nothing was done. ${nowText(r)}`,
        );
    } else {
      if (input.changes)
        return refuse(
          `Step ${n} is a Tex step: it only reads and writes words, so ${input.action} can't run (nothing was ` +
            `done). Changes in an app are app steps. ${nowText(r)}`,
        );
      if (!app || !(s.readApps ?? []).includes(app.slug))
        return refuse(
          `Step ${n} may read ${s.readApps?.length ? s.readApps.map(appNameOf).join(', ') : 'no app'}, so ` +
            `${input.action} can't run (nothing was done). ${nowText(r)}`,
        );
      kind = 'lookup';
    }
    // The limits on app calls: past them the run fails at this step.
    if (r.appCalls >= MAX_CALLS_PER_RUN || at.rec.calls >= MAX_CALLS_PER_STEP) {
      const words =
        r.appCalls >= MAX_CALLS_PER_RUN
          ? `the run made ${MAX_CALLS_PER_RUN} app calls, the most a run may make`
          : `step ${n} made ${MAX_CALLS_PER_STEP} app calls, the most a step may make`;
      end(r, 'failed', `Step ${n} failed: ${words}.`, { state: 'failed', reason: words });
      return refuse(`Nothing was done: ${words}. ${nowText(r)}`);
    }
    r.appCalls += 1;
    at.rec.calls += 1;
    return { ok: true, kind, run: r, step: s, index: at.index, args };
  });
  if (!res) return refuse('This run is no longer there, so nothing was done. End your turn.');
  return res.out;
}

/** The step a run waits on is asked for (request_approval), checked like its action is. */
export async function gateApprovalRequest(
  userId: string,
  runId: string,
  input: { action: string | null; args: Record<string, unknown> },
): Promise<StepGate> {
  const r = await getRun(userId, runId);
  if (!r) return refuse('This run is no longer there, so nobody was asked. End your turn.');
  const stop = notActing(r);
  if (stop) return refuse(stop.replace('Nothing was done.', 'Nobody was asked.'));
  const at = currentStep(r);
  if (!at) return refuse('Nobody was asked: the run has no step now. End your turn.');
  const n = at.index + 1;
  const s = at.step;
  if (s.onlyIf.kind === 'tex' && at.rec.conditionMet === undefined)
    return refuse(`Nobody was asked. ${nowText(r)}`);
  if (
    s.type !== 'action' ||
    !input.action ||
    input.action.toUpperCase() !== (s.action ?? '').toUpperCase()
  )
    return refuse(
      `During a run with steps, ask only for the current step's action. Nobody was asked. ${nowText(r)}`,
    );
  const fixed = withFixed(s, n, input.args);
  if ('refusal' in fixed)
    return refuse(fixed.refusal.replace('Nothing was done', 'Nobody was asked'));
  return { ok: true, kind: 'step', run: r, step: s, index: at.index, args: fixed.args };
}

/** The approval was asked: the run waits for the user's OK on its step, holding no container. */
export async function markWaiting(
  userId: string,
  runId: string,
  approvalId: string,
): Promise<Run | null> {
  const res = await withRun(userId, runId, (r) => {
    const at = currentStep(r);
    if (r.state !== 'running' || !at) return;
    r.state = 'waiting';
    at.rec.state = 'waiting';
    at.rec.approvalId = approvalId;
    at.rec.waitingSince = new Date().toISOString();
  });
  return res?.run ?? null;
}

/**
 * Moves the pointer past a step that is done: to the next one, if its "only if" holds (a false one
 * ends the run as stopped, a success; "Tex decides" waits for Tex), or to the end.
 */
function advance(r: Run, fromIndex: number): void {
  const next = r.plan[fromIndex + 1];
  if (!next) {
    r.state = 'done';
    r.currentStepId = null;
    r.endedAt = new Date();
    return;
  }
  r.currentStepId = next.id;
  const rec = r.steps[fromIndex + 1]!;
  const held = decideCondition(next.onlyIf, r.steps[fromIndex]);
  if (held === false) {
    end(
      r,
      'stopped',
      `Nothing to do: step ${fromIndex + 2} runs ${conditionWords(next.onlyIf, fromIndex + 2)}, and it didn't.`,
      { state: 'skipped', reason: 'Its "only if" was false.' },
    );
    return;
  }
  rec.state = 'running';
}

/** The current step's own action ran: its short result is saved and the pointer moves on. */
export async function stepActionDone(
  userId: string,
  runId: string,
  stepId: string,
  data: unknown,
): Promise<Run | null> {
  const res = await withRun(userId, runId, (r) => {
    const at = currentStep(r);
    if (!at || at.step.id !== stepId || r.state !== 'running') return;
    at.rec.state = 'done';
    at.rec.result = cut(
      typeof data === 'string' ? data : JSON.stringify(data ?? null),
      STEP_RESULT_CHARS,
    );
    at.rec.found = !isEmptyResult(data);
    at.rec.tries += 1;
    advance(r, at.index);
  });
  return res?.run ?? null;
}

/**
 * The current step's own action failed (the app refused it, or could not be reached): one more
 * try is allowed; a second failure fails the step and the run. Returns what Tex is told.
 */
export async function stepActionFailed(
  userId: string,
  runId: string,
  stepId: string,
  error: string,
): Promise<string> {
  const res = await withRun(userId, runId, (r) => {
    const at = currentStep(r);
    if (!at || at.step.id !== stepId || r.state !== 'running') return '';
    at.rec.tries += 1;
    const n = at.index + 1;
    if (at.rec.tries >= MAX_TRIES) {
      end(r, 'failed', `Step ${n} failed: ${cut(error, 300)}`, {
        state: 'failed',
        reason: cut(error, 300),
      });
      return nowText(r);
    }
    return `Step ${n} may be tried once more if the problem looks passing; a second failure fails the step and ends the run.`;
  });
  return res?.out ?? '';
}

/** The current step can't be done (out of credits): it fails, and the run stops. What Tex is told. */
export async function failStep(
  userId: string,
  runId: string,
  stepId: string,
  why: string,
): Promise<string> {
  const res = await withRun(userId, runId, (r) => {
    const at = currentStep(r);
    if (!at || at.step.id !== stepId || r.state !== 'running') return '';
    end(r, 'failed', `Step ${at.index + 1} failed: ${why}.`, { state: 'failed', reason: why });
    return nowText(r);
  });
  return res?.out ?? '';
}

/** What finish_step gives. */
export interface FinishInput {
  stepId: string;
  result?: string;
  found?: boolean;
  conditionMet?: boolean;
  why?: string;
}

/**
 * finish_step: a Tex step's result, and/or Tex's answer to a "Tex decides" condition of the
 * current step. Returns the run after it, or a refusal for the agent.
 */
export async function finishStep(
  userId: string,
  runId: string,
  input: FinishInput,
): Promise<{ ok: true; run: Run } | { ok: false; refusal: string }> {
  const res = await withRun(userId, runId, (r): string | null => {
    const stop = notActing(r);
    if (stop) return stop;
    const at = currentStep(r);
    if (!at) return 'Nothing was saved: the run has no step now. End your turn.';
    const n = at.index + 1;
    const s = at.step;
    if (input.stepId !== s.id)
      return `Nothing was saved: the run is at step ${n} (step_id "${s.id}"), not "${input.stepId}". ${nowText(r)}`;
    // A "Tex decides" condition is answered first.
    if (s.onlyIf.kind === 'tex' && at.rec.conditionMet === undefined) {
      if (input.conditionMet === undefined || !input.why?.trim())
        return `Nothing was saved. ${nowText(r)}`;
      at.rec.conditionMet = input.conditionMet;
      at.rec.reason = cut(
        `Tex decided ${input.conditionMet ? 'yes' : 'no'}: ${input.why.trim()}`,
        300,
      );
      if (!input.conditionMet) {
        end(
          r,
          'stopped',
          `Nothing to do: Tex decided no for step ${n} (${cut(input.why.trim(), 200)}).`,
          {
            state: 'skipped',
          },
        );
        return null;
      }
      if (s.type === 'action' || input.result === undefined) return null;
    }
    // A condition answer nobody asked for is ignored; the result still counts.
    if (s.type === 'action')
      return `Step ${n} is an app action: run ${s.action} with run_app_action; finish_step does not do it. ${nowText(r)}`;
    const text = (input.result ?? '').trim();
    if (!text)
      return `Nothing was saved: give step ${n}'s result in words (or "nothing found" with found false).`;
    at.rec.state = 'done';
    at.rec.result = cut(text, STEP_RESULT_CHARS);
    at.rec.found = input.found ?? !isEmptyResult(text);
    advance(r, at.index);
    return null;
  });
  if (!res) return { ok: false, refusal: 'This run is no longer there. End your turn.' };
  if (res.out) return { ok: false, refusal: res.out };
  return { ok: true, run: res.run };
}

/**
 * After a run's turn: a run still at a step that Tex left (it ended the turn early, or the turn
 * failed) is failed there; it counts as a failure. Returns the run as it ends the turn.
 */
export async function closeTurn(
  userId: string,
  runId: string,
  outcome: 'done' | 'error' | 'out_of_credits' | 'other',
): Promise<Run | null> {
  const res = await withRun(userId, runId, (r) => {
    if (r.state !== 'running') return;
    const n = (currentStep(r)?.index ?? 0) + 1;
    if (outcome === 'out_of_credits') {
      end(r, 'stopped', "Out of credits, so the run didn't start.", { state: 'skipped' });
      return;
    }
    const why =
      outcome === 'error'
        ? `Stopped at step ${n}: the turn ended with an error.`
        : `Stopped at step ${n}: Tex ended before finishing it.`;
    end(r, 'failed', why, { state: 'failed', reason: why });
  });
  return res?.run ?? null;
}

// ---------------------------------------------------------------- upkeep

/**
 * system/expire-automation-runs (hourly): runs that waited 24 hours for a yes stop there (the
 * approval expired too). Returns the runs stopped, for their line in the Automations chat.
 */
export async function expireWaitingRuns(now = new Date()): Promise<Run[]> {
  const waiting = await db()
    .select()
    .from(automationRuns)
    .where(eq(automationRuns.state, 'waiting'));
  const stopped: Run[] = [];
  for (const w of waiting) {
    const since = currentStep(w)?.rec.waitingSince;
    if (!since || now.getTime() - new Date(since).getTime() < WAIT_MS) continue;
    const res = await withRun(w.userId, w.id, (r) => {
      if (r.state !== 'waiting') return false;
      const n = (currentStep(r)?.index ?? 0) + 1;
      end(r, 'stopped', `No answer in 24 hours, so step ${n} did not run.`, {
        state: 'skipped',
        reason: 'No answer in 24 hours.',
      });
      return true;
    });
    if (res?.out) stopped.push(res.run);
  }
  return stopped;
}

/** Daily clean-up: results 2 days after the end (they can hold bits of emails), runs after 30. */
export async function cleanupRuns(now = new Date()): Promise<{ cleared: number; removed: number }> {
  const cleared = await db()
    .update(automationRuns)
    .set({
      resultsRemovedAt: now,
      steps: sql`(select coalesce(jsonb_agg(jsonb_set(e.v, '{result}', 'null'::jsonb) order by e.i), '[]'::jsonb) from jsonb_array_elements(${automationRuns.steps}) with ordinality as e(v, i))`,
    })
    .where(
      and(
        isNull(automationRuns.resultsRemovedAt),
        lt(automationRuns.endedAt, new Date(now.getTime() - RESULTS_KEEP_MS)),
      ),
    );
  const removed = await db()
    .delete(automationRuns)
    .where(lt(automationRuns.startedAt, new Date(now.getTime() - RUNS_KEEP_MS)));
  return { cleared: cleared.rowCount ?? 0, removed: removed.rowCount ?? 0 };
}
