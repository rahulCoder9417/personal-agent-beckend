// An app action's inputs belong inside `arguments` (run_app_action, request_approval). On 17
// October 2026 Tex, on Claude Code, sent them next to `action` instead, five times in a row: the
// Platform MCP dropped every input it does not name without a word, so GITHUB_LIST_PULL_REQUESTS
// ran with no owner or repo ("it keeps saying fields are missing even when I include them") and
// GITHUB_FIND_PULL_REQUESTS ran with no filter at all, over all of GitHub. Now those inputs are
// used, and the answer says where they belong. docs/backend-report.md, "How the agent finds and
// runs an action".

/** Names an agent may wrap an action's inputs in, instead of `arguments`. */
const WRAPPERS = new Set([
  'input',
  'inputs',
  'params',
  'parameters',
  'args',
  'action_input',
  'action_inputs',
  'action_arguments',
]);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v);

export interface ActionInputs {
  /** The inputs the action runs with: `arguments`, or the ones found beside it. */
  inputs: Record<string, unknown> | undefined;
  /** The names that were beside `action` and are now used as its inputs. */
  moved: string[];
  /** Names beside `action` that were left out, because `arguments` was given too. */
  ignored: string[];
}

/**
 * The action's inputs of a call. `known`: the tool's own input names (action, arguments, …).
 * - `arguments` given and not empty: those, as before; anything beside them is ignored.
 * - Otherwise the inputs beside `action`: one wrapper object (`input`, `params`, …) is taken as
 *   the inputs themselves, any other names are the inputs.
 */
export function actionInputsOf(args: Record<string, unknown>, known: string[]): ActionInputs {
  const given = isPlainObject(args.arguments) ? args.arguments : undefined;
  const others = Object.keys(args).filter((k) => !known.includes(k) && args[k] !== undefined);
  if (others.length === 0) return { inputs: given, moved: [], ignored: [] };
  if (given && Object.keys(given).length > 0) return { inputs: given, moved: [], ignored: others };
  const only = others.length === 1 ? others[0]! : null;
  const wrapped = only && WRAPPERS.has(only) && isPlainObject(args[only]) ? args[only] : null;
  const inputs = wrapped ?? Object.fromEntries(others.map((k) => [k, args[k]]));
  return { inputs, moved: wrapped ? Object.keys(wrapped) : others, ignored: [] };
}

/** What the answer tells the agent about inputs it put beside `action`, or null. */
export function misplacedInputsNote(found: ActionInputs): string | null {
  if (found.moved.length > 0)
    return (
      `You sent ${found.moved.join(', ')} beside "action"; they were used as its inputs. Next time ` +
      'put an action\'s inputs inside "arguments": {"action": "…", "arguments": {"owner": "…"}}.'
    );
  if (found.ignored.length > 0)
    return (
      `${found.ignored.join(', ')} ${found.ignored.length === 1 ? 'was' : 'were'} beside "action" and ` +
      'not used: every input of the action goes inside "arguments".'
    );
  return null;
}
