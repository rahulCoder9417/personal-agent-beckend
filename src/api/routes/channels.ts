import { createLinkCode, listLinks, maskDisplayId, unlink } from '../../modules/auth/links.ts';
import { badRequest, notFound } from '../../shared/errors.ts';
import { enforce } from '../../shared/rate-limit.ts';
import { route } from '../router.ts';

const WHATSAPP_WINDOW_MS = 24 * 3600 * 1000;

export const channelRoutes = [
  route('listChannels', async (c) => {
    const links = await listLinks(c.get('user').id);
    return c.json(
      {
        items: links.map((l) => ({
          id: l.id,
          channel: l.channel,
          displayId: maskDisplayId(l),
          linkedAt: l.createdAt.toISOString(),
          ...(l.channel === 'whatsapp'
            ? {
                within24hWindow: Boolean(
                  l.lastInboundAt && Date.now() - l.lastInboundAt.getTime() < WHATSAPP_WINDOW_MS,
                ),
              }
            : {}),
        })),
      },
      200,
    );
  }),

  route('createLinkCode', async (c, { body }) => {
    const user = c.get('user');
    if (body.channel === 'web') throw badRequest('The web app needs no linking');
    await enforce({ key: `linkcode:user:${user.id}`, max: 10, windowSeconds: 3600 });
    const lc = await createLinkCode(user.id, body.channel);
    return c.json(
      {
        code: lc.code,
        channel: body.channel,
        expiresAt: lc.expiresAt.toISOString(),
        instructions: lc.instructions,
        deepLink: lc.deepLink,
      },
      201,
    );
  }),

  route('unlinkChannel', async (c, { params }) => {
    if (!(await unlink(c.get('user').id, params.channelLinkId)))
      throw notFound('Channel link not found');
    return c.body(null, 204);
  }),
];
