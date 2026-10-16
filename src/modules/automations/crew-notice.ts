// The notice on Telegram when a crew job asked in the web app ends (docs/backend-report.md,
// "Notices on Telegram"). The report stays in the chat the job was asked in; the notice says in a
// line how it went and links to that conversation. A job asked on Telegram reports there already,
// so it gets none.
import { conversationLink, sendTelegramNotice } from '../channels/notify.ts';
import { parseSessionKey } from '../channels/types.ts';
import type { CrewJob } from './crew-jobs.ts';

const NAMES: Record<CrewJob['member'], string> = { patch: 'Patch', byte: 'Byte' };

const one = (text: string) => text.replace(/\s+/g, ' ').trim();
const ended = (text: string) => (/[.!?…]$/.test(text) ? text : `${text}.`);
function cut(text: string, max: number): string {
  const t = one(text);
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/**
 * What the report says, in a few words: its verdict, the pull request Byte opened, and whether the
 * tests passed. The report has a fixed shape (crew-jobs.ts, PATCH_REPORT and BYTE_REPORT); what is
 * not found is left out. Example: "Done. PR #43 opened. Tests passed."
 */
export function reportSummary(member: CrewJob['member'], report: string | null): string {
  if (!report) return '';
  const text = report.replace(/\*\*|__|`/g, '');
  const parts: string[] = [];
  const verdict = /^\s*verdict:\s*(.+)$/im.exec(text)?.[1];
  if (verdict) {
    const v = cut(verdict, 60);
    parts.push(
      ended(member === 'byte' ? `${v.charAt(0).toUpperCase()}${v.slice(1)}` : `Verdict: ${v}`),
    );
  }
  if (member === 'byte') {
    const pr = /pull request:\s*([^\s·]+)/i.exec(text)?.[1] ?? '';
    const number = /github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/.exec(pr)?.[1];
    if (number) parts.push(`PR #${number} opened.`);
  }
  const tests = /^\s*tests run\b([\s\S]*?)(?=^\s*not checked\b|$(?![\s\S]))/im.exec(text)?.[1];
  if (tests) {
    const said = tests.replace(/\b0 failed\b/gi, '');
    if (/\bfail(ed|s|ing|ure)?\b/i.test(said)) parts.push('Some tests failed.');
    else if (/\bpass(ed|es|ing)?\b/i.test(said)) parts.push('Tests passed.');
    else if (/\bnone run\b/i.test(said)) parts.push('No tests were run.');
  }
  return parts.join(' ');
}

/**
 * The notice: "✅ Byte finished: Fix the login redirect in acme/web. Done. PR #43 opened. Tests
 * passed.", or "❌ Patch couldn't finish: Review acme/web#42. <why>.", then the link to the
 * conversation with the report.
 */
export function crewNoticeText(input: {
  member: CrewJob['member'];
  title: string;
  failure: string | null;
  report: string | null;
  conversationId: string | null | undefined;
}): string {
  const name = NAMES[input.member];
  const link = conversationLink(input.conversationId);
  if (input.failure)
    return `❌ ${name} couldn't finish: ${ended(input.title)} ${ended(one(input.failure))}\nDetails: ${link}`;
  const summary = reportSummary(input.member, input.report);
  return `✅ ${name} finished: ${ended(input.title)}${summary ? ` ${summary}` : ''}\nReport: ${link}`;
}

/**
 * Tells the user on Telegram that the job ended (`failure`: why it failed, null when it finished),
 * when it was asked anywhere but Telegram, their "Byte or Patch finishes a job" switch (`crewJobs`) is on and Telegram is
 * linked. Once per job, also when its queue job runs again.
 */
export async function noticeCrewJob(
  job: Pick<CrewJob, 'id' | 'userId' | 'member' | 'sessionKey' | 'report'>,
  title: string,
  failure: string | null,
  conversationId: string | null | undefined,
): Promise<void> {
  if (parseSessionKey(job.sessionKey)?.channel === 'telegram') return;
  await sendTelegramNotice({
    userId: job.userId,
    kind: 'crew_job',
    key: `notice:crew_job:${job.id}`,
    conversationId,
    text: crewNoticeText({
      member: job.member,
      title,
      failure,
      report: job.report,
      conversationId,
    }),
  });
}
