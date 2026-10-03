import { and, count, desc, eq, gt, isNull, lt, TransactionRollbackError } from 'drizzle-orm';
import { config, isChannelEnabled } from '../../shared/config.ts';
import { randomString, sha256Hex } from '../../shared/crypto.ts';
import { db } from '../../shared/db/client.ts';
import { channelDisabled } from '../../shared/errors.ts';
import { newId } from '../../shared/ids.ts';
import { channelLinks, linkCodes } from './schema.ts';

export type ChannelLink = typeof channelLinks.$inferSelect;
export type LinkChannel = ChannelLink['channel'];

export const LINK_CODE_TTL_MS = 10 * 60 * 1000;
/** No 0/O, 1/I. */
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const LINK_CODE_PATTERN = /\bLINK-?([A-Z2-9]{4})-?([A-Z2-9]{4})\b/i;

export function normalizeLinkCode(text: string): string | null {
  const m = LINK_CODE_PATTERN.exec(text.toUpperCase());
  return m ? `LINK-${m[1]}-${m[2]}` : null;
}

export async function countChannelLinks(userId: string): Promise<number> {
  const [row] = await db()
    .select({ n: count() })
    .from(channelLinks)
    .where(eq(channelLinks.userId, userId));
  return row?.n ?? 0;
}

/**
 * One-time code (random, single use, 10 minutes). Only its hash is stored.
 * A channel that is switched off can't be linked (`channel_disabled`, HLD 0.3).
 */
export async function createLinkCode(userId: string, channel: LinkChannel) {
  if (!isChannelEnabled(channel)) throw channelDisabled(channel);
  const code = `LINK-${randomString(4, ALPHABET)}-${randomString(4, ALPHABET)}`;
  const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS);
  await db()
    .insert(linkCodes)
    .values({ id: newId('lnk'), codeHash: sha256Hex(code), userId, channel, expiresAt });
  return { code, expiresAt, ...linkInstructions(channel, code) };
}

function linkInstructions(
  channel: LinkChannel,
  code: string,
): { instructions: string; deepLink: string | null } {
  const c = config();
  switch (channel) {
    case 'telegram': {
      const bot = c.TELEGRAM_BOT_USERNAME;
      return {
        instructions: bot
          ? `Send ${code} to @${bot} on Telegram`
          : `Send ${code} to our Telegram bot`,
        deepLink: bot ? `https://t.me/${bot}?start=${code}` : null,
      };
    }
    case 'whatsapp': {
      const num = c.WHATSAPP_DISPLAY_NUMBER;
      return {
        instructions: num
          ? `Send ${code} to ${num} on WhatsApp`
          : `Send ${code} to our WhatsApp number`,
        deepLink: num
          ? `https://wa.me/${num.replace(/\D/g, '')}?text=${encodeURIComponent(code)}`
          : null,
      };
    }
    case 'imessage': {
      const num = c.SENDBLUE_NUMBER;
      return {
        instructions: num
          ? `Send ${code} to ${num} on iMessage`
          : `Send ${code} to our iMessage number`,
        deepLink: num ? `sms:${num}&body=${encodeURIComponent(code)}` : null,
      };
    }
  }
}

export type LinkResult =
  | { ok: true; link: ChannelLink; alreadyLinked: boolean }
  | { ok: false; reason: 'invalid_code' | 'linked_to_other_user' };

/** Consumes a code sent from a chat and links that chat to the code's user. */
export async function linkWithCode(input: {
  code: string;
  channel: LinkChannel;
  externalId: string;
  displayId: string;
}): Promise<LinkResult> {
  const normalized = normalizeLinkCode(input.code);
  if (!normalized) return { ok: false, reason: 'invalid_code' };
  return db()
    .transaction(async (tx) => {
      const [code] = await tx
        .update(linkCodes)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(linkCodes.codeHash, sha256Hex(normalized)),
            eq(linkCodes.channel, input.channel),
            isNull(linkCodes.usedAt),
            gt(linkCodes.expiresAt, new Date()),
          ),
        )
        .returning();
      if (!code) return { ok: false as const, reason: 'invalid_code' as const };
      const [existing] = await tx
        .select()
        .from(channelLinks)
        .where(
          and(
            eq(channelLinks.channel, input.channel),
            eq(channelLinks.externalId, input.externalId),
          ),
        );
      if (existing && existing.userId !== code.userId) {
        tx.rollback();
      }
      if (existing) return { ok: true as const, link: existing, alreadyLinked: true };
      const [link] = await tx
        .insert(channelLinks)
        .values({
          id: newId('chl'),
          userId: code.userId,
          channel: input.channel,
          externalId: input.externalId,
          displayId: input.displayId,
          lastInboundAt: new Date(),
        })
        .returning();
      return { ok: true as const, link: link!, alreadyLinked: false };
    })
    .catch((err: unknown) => {
      if (err instanceof TransactionRollbackError) {
        return { ok: false as const, reason: 'linked_to_other_user' as const };
      }
      throw err;
    });
}

export async function findLink(
  channel: LinkChannel,
  externalId: string,
): Promise<ChannelLink | undefined> {
  const [row] = await db()
    .select()
    .from(channelLinks)
    .where(and(eq(channelLinks.channel, channel), eq(channelLinks.externalId, externalId)));
  return row;
}

export async function listLinks(userId: string): Promise<ChannelLink[]> {
  return db()
    .select()
    .from(channelLinks)
    .where(eq(channelLinks.userId, userId))
    .orderBy(desc(channelLinks.createdAt));
}

export async function unlink(userId: string, linkId: string): Promise<boolean> {
  const rows = await db()
    .delete(channelLinks)
    .where(and(eq(channelLinks.userId, userId), eq(channelLinks.id, linkId)))
    .returning({ id: channelLinks.id });
  return rows.length > 0;
}

export async function touchInbound(linkId: string): Promise<void> {
  await db()
    .update(channelLinks)
    .set({ lastInboundAt: new Date(), blocked: false })
    .where(eq(channelLinks.id, linkId));
}

export async function markBlocked(
  userId: string,
  channel: LinkChannel,
  externalId: string,
): Promise<void> {
  await db()
    .update(channelLinks)
    .set({ blocked: true })
    .where(
      and(
        eq(channelLinks.userId, userId),
        eq(channelLinks.channel, channel),
        eq(channelLinks.externalId, externalId),
      ),
    );
}

/** Is this chat one of the user's own linked chats? (Agents may only message their own user.) */
export async function ownsChat(
  userId: string,
  channel: LinkChannel,
  externalId: string,
): Promise<ChannelLink | undefined> {
  const link = await findLink(channel, externalId);
  return link?.userId === userId ? link : undefined;
}

export async function deleteUserLinks(userId: string): Promise<void> {
  await db().delete(channelLinks).where(eq(channelLinks.userId, userId));
  await db().delete(linkCodes).where(eq(linkCodes.userId, userId));
}

export function maskDisplayId(link: ChannelLink): string {
  if (link.channel === 'telegram') return link.displayId || 'Telegram';
  const digits = link.externalId.replace(/\D/g, '');
  if (digits.length < 6) return link.displayId || link.externalId;
  return `+${digits.slice(0, 2)} •••• ••${digits.slice(-4, -2)} ${digits.slice(-2)}`;
}

/** Used or expired link codes older than a day. */
export async function cleanupLinkCodes(): Promise<number> {
  const rows = await db()
    .delete(linkCodes)
    .where(lt(linkCodes.expiresAt, new Date(Date.now() - 86400_000)))
    .returning({ id: linkCodes.id });
  return rows.length;
}
