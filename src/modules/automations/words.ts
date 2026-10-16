// An automation's schedule and trigger in plain words, for the outline of a draft sent to a chat
// app (drafts.ts). The web app has its own, richer version (src/lib/automations.ts); this one only
// needs to be right for the usual shapes and honest for the rest.

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WHOLE = /^\d+$/;

/** 9, 0 → "9:00 AM"; 18, 30 → "6:30 PM"; 0, 5 → "12:05 AM". */
export function clock12(hour: number, minute: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}:${String(minute).padStart(2, '0')} ${hour % 24 < 12 ? 'AM' : 'PM'}`;
}

/** ["a"] → "a"; ["a", "b"] → "a and b"; ["a", "b", "c"] → "a, b and c". */
function listWords(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/** "1-5" → [1..5]; "1,4" → [1,4]. Null for anything else. */
function weekdays(field: string): number[] | null {
  const days: number[] = [];
  for (const part of field.split(',')) {
    const range = /^(\d)-(\d)$/.exec(part);
    if (range) {
      const [from, to] = [Number(range[1]), Number(range[2])];
      if (from > to || to > 7) return null;
      for (let day = from; day <= to; day++) days.push(day % 7);
    } else if (/^[0-7]$/.test(part)) {
      days.push(Number(part) % 7);
    } else {
      return null;
    }
  }
  return days;
}

const sameDays = (days: number[], wanted: number[]) =>
  days.length === wanted.length && wanted.every((d) => days.includes(d));

/**
 * A five-field cron line in words, starting in small letters: "every Monday at 9:00 AM", "every
 * weekday at 8:00 AM", "on the 1st of every month at 10:00 AM", "every 30 minutes". Null for a
 * line that is not one of these shapes.
 */
export function cronInWords(cron: string): string | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (month !== '*') return null;
  const anyDay = dayOfMonth === '*' && dayOfWeek === '*';
  const everyMinutes = /^\*\/(\d+)$/.exec(minute);
  if (everyMinutes && hour === '*' && anyDay) return `every ${everyMinutes[1]} minutes`;
  if (!WHOLE.test(minute) || Number(minute) > 59) return null;
  const everyHours = /^\*\/(\d+)$/.exec(hour);
  if (everyHours && anyDay)
    return Number(everyHours[1]) === 1 ? 'every hour' : `every ${everyHours[1]} hours`;
  if (hour === '*' && anyDay)
    return Number(minute) === 0 ? 'every hour' : `every hour, at ${Number(minute)} past`;
  const hours = hour.split(',');
  if (!hours.every((h) => WHOLE.test(h) && Number(h) < 24)) return null;
  const at = listWords(hours.map((h) => clock12(Number(h), Number(minute))));
  if (anyDay) return `every day at ${at}`;
  if (dayOfMonth === '*') {
    const days = weekdays(dayOfWeek);
    if (!days) return null;
    if (sameDays(days, [1, 2, 3, 4, 5])) return `every weekday at ${at}`;
    if (sameDays(days, [0, 1, 2, 3, 4, 5, 6])) return `every day at ${at}`;
    return `every ${listWords(days.map((d) => DAY_NAMES[d]!))} at ${at}`;
  }
  if (dayOfWeek === '*' && WHOLE.test(dayOfMonth) && Number(dayOfMonth) >= 1) {
    if (Number(dayOfMonth) > 31) return null;
    return `on the ${ordinal(Number(dayOfMonth))} of every month at ${at}`;
  }
  return null;
}

// What common Composio trigger names wait for, most specific first. Matched against the name
// without the app's own prefix.
const TRIGGER_PHRASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/PULL_REQUEST|(^|_)PR(_|$)/, 'a pull request opens or gets new commits'],
  [/(NEW|RECEIV|INCOMING).*(MAIL|GMAIL_MESSAGE)|MAIL.*(NEW|RECEIV|ARRIV)/, 'a new email arrives'],
  [/ISSUE.*(ADD|CREAT|NEW|OPEN)|(NEW|CREAT|OPEN).*ISSUE/, 'a new issue is opened'],
  [/COMMIT|PUSH/, 'new commits are pushed'],
  [/(NEW|RECEIV|INCOMING).*MESSAGE|MESSAGE.*(NEW|RECEIV|POST)/, 'a new message arrives'],
  [/(EVENT|MEETING).*(CREAT|ADD|NEW)|(NEW|CREAT).*(EVENT|MEETING)/, 'a new event is added'],
];

/** A setting's value as a short phrase: strings as they are, lists joined, the rest as JSON. */
function settingValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(settingValue).join(', ');
  return JSON.stringify(value);
}

/**
 * What an app event waits for: "a new email arrives in Gmail (from: boss@acme.com)". A trigger
 * name not known here keeps its own name: "GITHUB_STAR_ADDED_EVENT in GitHub".
 */
export function triggerInWords(
  trigger: { event: string; config?: Record<string, unknown> },
  appName: string,
  appSlug: string,
): string {
  const name = trigger.event.toUpperCase();
  const prefix = `${appSlug.toUpperCase().replace(/[^A-Z0-9]+/g, '')}_`;
  const core = (name.startsWith(prefix) ? name.slice(prefix.length) : name).replace(
    /_(TRIGGER|EVENT)$/,
    '',
  );
  const known = TRIGGER_PHRASES.find(([pattern]) => pattern.test(core));
  const what = known ? `${known[1]} in ${appName}` : `${trigger.event} in ${appName}`;
  const settings = Object.entries(trigger.config ?? {})
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${settingValue(v)}`)
    .join(', ');
  return settings ? `${what} (${settings.slice(0, 200)})` : what;
}
