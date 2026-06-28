import { describe, it, expect, vi } from 'vitest';
import { makeSendBulk } from './send-bulk.js';
import { createLogger } from '../logging/logger.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const client = {} as any;
const logger = createLogger({ sink: () => {} });

const okEnv = (sent: number, rejected = 0, failed = 0, rejected_items: unknown[] = []) => ({
  ok: true,
  statusCode: 200,
  data: { sent_count: sent, rejected_count: rejected, failed_count: failed, rejected_items },
});

describe('makeSendBulk', () => {
  it('returns normalized counts on a clean push (flat form)', async () => {
    const sendBulk = makeSendBulk(client, logger);
    const res = await sendBulk(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (_c, items: any[]) => Promise.resolve(okEnv(items.length) as any),
      [{ id: 1 }, { id: 2 }],
    );
    expect(res).toEqual({ sent: 2, rejected: 0, rejected_items: [] });
  });

  it('surfaces rejections via onReject + returns rejected_items (never a silent drop)', async () => {
    const onReject = vi.fn();
    const sendBulk = makeSendBulk(client, logger, onReject);
    const res = await sendBulk(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (_c, items: any[]) => Promise.resolve(okEnv(items.length - 1, 1, 0, [items[0]]) as any),
      [{ id: 'bad' }, { id: 'ok' }],
    );
    expect(res.sent).toBe(1);
    expect(res.rejected).toBe(1);
    expect(res.rejected_items).toEqual([{ id: 'bad' }]);
    expect(onReject).toHaveBeenCalledWith(1, [{ id: 'bad' }]);
  });

  it('throws on a transport/HTTP failure (!ok) so the caller can replay', async () => {
    const sendBulk = makeSendBulk(client, logger);
    await expect(
      sendBulk(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        () => Promise.resolve({ ok: false, statusCode: 500, error: { message: 'boom' } } as any),
        [{ id: 1 }],
      ),
    ).rejects.toThrow();
  });

  it('throws on failed chunks even when ok (transport must replay, never tolerated)', async () => {
    const onReject = vi.fn();
    const sendBulk = makeSendBulk(client, logger, onReject);
    await expect(
      sendBulk(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (_c, items: any[]) => Promise.resolve(okEnv(items.length - 1, 0, 1) as any),
        [{ id: 1 }, { id: 2 }],
      ),
    ).rejects.toThrow();
    // failed must NOT be routed to the tolerable sink (tolerateRejects could never lift it).
    expect(onReject).not.toHaveBeenCalled();
  });

  it('supports the thunk form (path-param bulk signatures)', async () => {
    const sendBulk = makeSendBulk(client, logger);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await sendBulk(() => Promise.resolve(okEnv(3) as any));
    expect(res.sent).toBe(3);
  });
});
