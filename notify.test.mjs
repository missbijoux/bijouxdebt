import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addNotice,
  deliverEmail,
  deliverPush,
  ensureVapid,
  markNoticesRead,
  normalizeSubscription,
  publicNotice,
  savePushSubscription,
  unreadNotices,
  vapidKeys,
} from './notify.mjs';
import { emptyBook } from './store.mjs';

test('notices stay per audience and mark read only for the owner', () => {
  const book = emptyBook();
  const now = new Date('2026-11-10T12:00:00.000Z');
  const forAlice = addNotice(book, {
    audience: 'sub',
    subId: 'alice',
    kind: 'debt_proposed',
    title: 'A debt is waiting',
    body: 'Sign it on your book.',
    href: '/book',
  }, now);
  addNotice(book, {
    audience: 'studio',
    subId: 'alice',
    handle: 'alice',
    kind: 'claim_pending',
    title: 'alice claimed a payment',
    body: '$20.00 waiting.',
    href: '/studio/names/alice',
  }, now);

  assert.equal(unreadNotices(book, { role: 'sub', subId: 'alice' }).length, 1);
  assert.equal(unreadNotices(book, { role: 'sub', subId: 'bob' }).length, 0);
  assert.equal(unreadNotices(book, { role: 'studio' }).length, 1);
  assert.equal(publicNotice(forAlice).title, 'A debt is waiting');

  markNoticesRead(book, { role: 'sub', subId: 'alice' }, [forAlice.id], now);
  assert.equal(unreadNotices(book, { role: 'sub', subId: 'alice' }).length, 0);
  assert.equal(unreadNotices(book, { role: 'studio' }).length, 1);
});

test('push subscriptions are saved per role and dead endpoints are pruned', async () => {
  const book = emptyBook();
  const keys = ensureVapid(book, {});
  assert.equal(vapidKeys(book, {}).publicKey, keys.publicKey);

  const raw = {
    endpoint: 'https://push.example/sub/1',
    keys: { p256dh: 'dGVzdC1wMjU2', auth: 'dGVzdC1hdXRo' },
  };
  normalizeSubscription(raw);
  savePushSubscription(book, { role: 'sub', subId: 'alice' }, raw, new Date());
  savePushSubscription(book, { role: 'studio' }, {
    endpoint: 'https://push.example/studio',
    keys: { p256dh: 'c3R1ZGlvLXAyNTY', auth: 'c3R1ZGlvLWF1dGg' },
  }, new Date());

  const notice = addNotice(book, {
    audience: 'sub',
    subId: 'alice',
    kind: 'claim_decided',
    title: 'Claim confirmed',
    body: 'She confirmed your claim.',
  });

  const sent = [];
  const result = await deliverPush(book, notice, {
    env: {},
    log: false,
    async send(subscription, body) {
      sent.push({ endpoint: subscription.endpoint, body });
      if (subscription.endpoint.includes('/sub/1')) {
        const error = new Error('gone');
        error.statusCode = 410;
        throw error;
      }
    },
  });
  assert.equal(result.sent, 0);
  assert.equal(result.pruned, 1);
  assert.equal(book.pushSubscriptions.some((item) => item.endpoint.includes('/sub/1')), false);
  assert.equal(book.pushSubscriptions.some((item) => item.audience === 'studio'), true);
  assert.equal(sent.length, 1);
});

test('email delivery stays a quiet stub until a provider is configured', async () => {
  const quiet = await deliverEmail({ kind: 'debt_proposed', title: 'x', body: 'y' }, { provider: '' });
  assert.equal(quiet.skipped, 'email_not_configured');
  const low = await deliverEmail({ kind: 'note', title: 'x', body: 'y' }, { provider: 'resend' });
  assert.equal(low.skipped, 'low_signal');
  const reserved = await deliverEmail({ kind: 'claim_decided', title: 'x', body: 'y' }, { provider: 'resend' });
  assert.equal(reserved.skipped, 'email_not_wired');
});
