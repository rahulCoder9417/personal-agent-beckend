// Google's class for the scopes our Google apps can ask for (docs/composio.md, section 9). It
// decides what Google wants before real users may allow our own Google sign-in app:
// - basic and non-sensitive: nothing beyond the brand check;
// - sensitive: Google's review (a demo video, a reason per scope);
// - restricted: Google's review and a yearly outside security assessment (CASA).
// From Google's scope pages for Gmail, Drive, Docs and Sheets, read on 15 October 2026. Google's
// Calendar page doesn't label its scopes; Google names reading calendar events as its example of a
// sensitive scope, and the four Calendar scopes below are listed as sensitive elsewhere.
export type GoogleScopeClass = 'basic' | 'non-sensitive' | 'sensitive' | 'restricted';

const G = 'https://www.googleapis.com/auth/';

const CLASSES: Record<string, GoogleScopeClass> = {
  openid: 'basic',
  email: 'basic',
  profile: 'basic',
  [`${G}userinfo.email`]: 'basic',
  [`${G}userinfo.profile`]: 'basic',

  'https://mail.google.com/': 'restricted',
  [`${G}gmail.readonly`]: 'restricted',
  [`${G}gmail.compose`]: 'restricted',
  [`${G}gmail.insert`]: 'restricted',
  [`${G}gmail.modify`]: 'restricted',
  [`${G}gmail.metadata`]: 'restricted',
  [`${G}gmail.settings.basic`]: 'restricted',
  [`${G}gmail.settings.sharing`]: 'restricted',
  [`${G}gmail.send`]: 'sensitive',
  [`${G}gmail.addons.current.message.metadata`]: 'sensitive',
  [`${G}gmail.addons.current.message.readonly`]: 'sensitive',
  [`${G}gmail.labels`]: 'non-sensitive',
  [`${G}gmail.addons.current.action.compose`]: 'non-sensitive',
  [`${G}gmail.addons.current.message.action`]: 'non-sensitive',

  [`${G}drive`]: 'restricted',
  [`${G}drive.readonly`]: 'restricted',
  [`${G}drive.activity`]: 'restricted',
  [`${G}drive.activity.readonly`]: 'restricted',
  [`${G}drive.meet.readonly`]: 'restricted',
  [`${G}drive.metadata`]: 'restricted',
  [`${G}drive.metadata.readonly`]: 'restricted',
  [`${G}drive.scripts`]: 'restricted',
  [`${G}drive.apps.readonly`]: 'sensitive',
  [`${G}drive.file`]: 'non-sensitive',
  [`${G}drive.appdata`]: 'non-sensitive',
  [`${G}drive.appfolder`]: 'non-sensitive',
  [`${G}drive.install`]: 'non-sensitive',

  [`${G}documents`]: 'sensitive',
  [`${G}documents.readonly`]: 'sensitive',
  [`${G}spreadsheets`]: 'sensitive',
  [`${G}spreadsheets.readonly`]: 'sensitive',

  [`${G}calendar`]: 'sensitive',
  [`${G}calendar.readonly`]: 'sensitive',
  [`${G}calendar.events`]: 'sensitive',
  [`${G}calendar.events.readonly`]: 'sensitive',
};

/** A scope as Google writes it: `gmail.modify` → `https://www.googleapis.com/auth/gmail.modify`. */
export function fullGoogleScope(scope: string): string {
  const s = scope.trim();
  if (s.includes('://') || s === 'openid' || s === 'email' || s === 'profile') return s;
  return `${G}${s}`;
}

/** Google's class for a scope, or null when this table doesn't know it (check at Google). */
export function googleScopeClass(scope: string): GoogleScopeClass | null {
  return CLASSES[fullGoogleScope(scope)] ?? null;
}

/** What a class means for our own Google sign-in app, in a few words. */
export function googleScopeNeeds(cls: GoogleScopeClass | null): string {
  switch (cls) {
    case 'basic':
    case 'non-sensitive':
      return 'no review beyond the brand check';
    case 'sensitive':
      return "Google's review, no security assessment";
    case 'restricted':
      return "Google's review and a yearly security assessment (CASA)";
    default:
      return 'not in our table: look it up at Google';
  }
}
