// The crew (HLD 0.7): Tex leads; Byte, Patch and Scout are the specialists it hands work to.
// The specialists themselves are defined in the Bridge inside the agent image. This file is what
// the platform knows about them: the list the apps show, and how to read a progress line.
import { config, SPECIALIST_IDS, type SpecialistId } from '../../shared/config.ts';
import type { PlanId } from '../auth/users.ts';
import { browserAvailable, browserWanted } from './browser.ts';

export { SPECIALIST_IDS, type SpecialistId };
export type CrewId = 'tex' | SpecialistId;

export interface CrewMember {
  id: CrewId;
  name: string;
  kind: 'lead' | 'specialist';
  role: string;
  description: string;
  /** Works on this deployment (Tex always; a specialist when it is in CREW_AVAILABLE). */
  available: boolean;
  /**
   * Scout only: it can drive a real browser inside the user's container (a Max feature, HLD
   * section 11). `available`: this deployment's agent image has it (`BROWSER_AVAILABLE`).
   * `enabled`: it is on for this user, which is the state the vm-manager is sent.
   */
  browser: { available: boolean; enabled: boolean } | null;
}

/** What is the same for every user and deployment. `browser`: the member can have one. */
const CREW: Array<Omit<CrewMember, 'available' | 'browser'> & { browser: boolean }> = [
  {
    id: 'tex',
    name: 'Tex',
    kind: 'lead',
    role: 'Lead',
    description: 'The one you text. Plans the job, hands parts to the crew and answers you.',
    browser: false,
  },
  {
    id: 'byte',
    name: 'Byte',
    kind: 'specialist',
    role: 'Coding',
    description: 'Writes and changes code, and opens pull requests.',
    browser: false,
  },
  {
    id: 'patch',
    name: 'Patch',
    kind: 'specialist',
    role: 'Code review',
    description: 'Reviews code with several reviewers: bugs, security and tests.',
    browser: false,
  },
  {
    id: 'scout',
    name: 'Scout',
    kind: 'specialist',
    role: 'Research',
    // What needs Max and what doesn't (HLD 0.7, 7.1): Scout's two platform services do; the
    // search built into the user's own engine does not.
    description:
      'Searches the web and reads pages. Web search through Textcrew and the real browser need ' +
      "the Max plan. On your own Claude plan, Scout uses Claude Code's built-in search instead: " +
      'any plan, no credits.',
    browser: true,
  },
];

/** The lead and the three specialists, in a fixed order, as a user on `plan` should see them. */
export function listCrew(plan: PlanId): CrewMember[] {
  const on = config().CREW_AVAILABLE;
  return CREW.map((m) => ({
    ...m,
    available: m.kind === 'lead' || on.includes(m.id as SpecialistId),
    browser: m.browser ? { available: browserAvailable(), enabled: browserWanted(plan) } : null,
  }));
}

const PROGRESS_NAME = /^(byte|patch|scout):\s/i;

/** `Scout: reading 4 pages` → `scout`. A line that names no specialist → null. */
export function crewOfProgress(text: string): SpecialistId | null {
  const m = PROGRESS_NAME.exec(text);
  return m ? (m[1]!.toLowerCase() as SpecialistId) : null;
}

/** The specialist saved with an activity entry (`details.crew`), if any. */
export function crewOfDetails(details: Record<string, unknown> | null): SpecialistId | null {
  const crew = details?.crew;
  return typeof crew === 'string' && (SPECIALIST_IDS as readonly string[]).includes(crew)
    ? (crew as SpecialistId)
    : null;
}
