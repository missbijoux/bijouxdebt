import webpush from 'web-push';
import { newId } from './store.mjs';

export const NOTICE_LIMIT = 200;
export const PUSH_LIMIT = 40;

/** High-signal kinds both sides care about. Email can reuse these later. */
export const HIGH_SIGNAL = new Set([
  'debt_proposed',
  'debt_signed',
  'debt_status',
  'game_terms',
  'game_accepted',
  'claim_pending',
  'claim_decided',
  'task_assigned',
  'task_done',
  'task_verdict',
  'charge',
]);

export function ensureNotify(book) {
  if (!Array.isArray(book.notices)) book.notices = [];
  if (!Array.isArray(book.pushSubscriptions)) book.pushSubscriptions = [];
  if (!book.settings || typeof book.settings !== 'object') book.settings = {};
}

export function addNotice(book, partial, now = new Date()) {
  ensureNotify(book);
  const notice = {
    id: newId(8),
    audience: partial.audience,
    subId: partial.subId || null,
    handle: partial.handle || null,
    kind: partial.kind,
    title: String(partial.title || '').slice(0, 80),
    body: String(partial.body || '').slice(0, 200),
    href: partial.href || (partial.audience === 'studio' ? '/studio' : '/book'),
    at: now.toISOString(),
    readAt: null,
  };
  book.notices.push(notice);
  if (book.notices.length > NOTICE_LIMIT) {
    book.notices.splice(0, book.notices.length - NOTICE_LIMIT);
  }
  return notice;
}

export function noticesFor(book, session) {
  ensureNotify(book);
  if (!session) return [];
  if (session.role === 'studio') {
    return book.notices.filter((notice) => notice.audience === 'studio');
  }
  if (session.role === 'sub') {
    return book.notices.filter((notice) => notice.audience === 'sub' && notice.subId === session.subId);
  }
  return [];
}

export function unreadNotices(book, session) {
  return noticesFor(book, session).filter((notice) => !notice.readAt);
}

export function markNoticesRead(book, session, ids, now = new Date()) {
  const mine = new Set(noticesFor(book, session).map((notice) => notice.id));
  const wanted = ids == null ? mine : new Set((Array.isArray(ids) ? ids : []).filter((id) => mine.has(id)));
  let count = 0;
  for (const notice of book.notices) {
    if (!wanted.has(notice.id) || notice.readAt) continue;
    notice.readAt = now.toISOString();
    count += 1;
  }
  return count;
}

export function publicNotice(notice) {
  return {
    id: notice.id,
    kind: notice.kind,
    title: notice.title,
    body: notice.body,
    href: notice.href,
    handle: notice.handle || null,
    at: notice.at,
    readAt: notice.readAt,
  };
}

export function vapidKeys(book, env = process.env) {
  ensureNotify(book);
  const fromEnv = env.BIJOUX_VAPID_PUBLIC_KEY && env.BIJOUX_VAPID_PRIVATE_KEY
    ? {
        publicKey: String(env.BIJOUX_VAPID_PUBLIC_KEY).trim(),
        privateKey: String(env.BIJOUX_VAPID_PRIVATE_KEY).trim(),
      }
    : null;
  if (fromEnv?.publicKey && fromEnv?.privateKey) return fromEnv;
  if (book.settings.vapid?.publicKey && book.settings.vapid?.privateKey) {
    return book.settings.vapid;
  }
  return null;
}

/** Create and persist VAPID keys once so push works without a manual setup step. */
export function ensureVapid(book, env = process.env) {
  const existing = vapidKeys(book, env);
  if (existing) return existing;
  ensureNotify(book);
  const generated = webpush.generateVAPIDKeys();
  book.settings.vapid = {
    publicKey: generated.publicKey,
    privateKey: generated.privateKey,
  };
  return book.settings.vapid;
}

export function normalizeSubscription(raw) {
  const endpoint = String(raw?.endpoint || '');
  const p256dh = String(raw?.keys?.p256dh || '');
  const auth = String(raw?.keys?.auth || '');
  if (!/^https:\/\//i.test(endpoint) || endpoint.length > 2048) {
    throw new Error('That push subscription looks wrong.');
  }
  if (!p256dh || !auth || p256dh.length > 200 || auth.length > 100) {
    throw new Error('That push subscription is missing keys.');
  }
  return { endpoint, keys: { p256dh, auth } };
}

export function savePushSubscription(book, session, raw, now = new Date()) {
  ensureNotify(book);
  const sub = normalizeSubscription(raw);
  book.pushSubscriptions = book.pushSubscriptions.filter((item) => item.endpoint !== sub.endpoint);
  const saved = {
    id: newId(8),
    audience: session.role,
    subId: session.role === 'sub' ? session.subId : null,
    endpoint: sub.endpoint,
    keys: sub.keys,
    createdAt: now.toISOString(),
  };
  book.pushSubscriptions.push(saved);
  if (book.pushSubscriptions.length > PUSH_LIMIT) {
    book.pushSubscriptions.splice(0, book.pushSubscriptions.length - PUSH_LIMIT);
  }
  return saved;
}

export function removePushSubscription(book, session, endpoint) {
  ensureNotify(book);
  const before = book.pushSubscriptions.length;
  book.pushSubscriptions = book.pushSubscriptions.filter((item) => {
    if (item.endpoint !== endpoint) return true;
    if (session.role === 'studio') return item.audience !== 'studio';
    return !(item.audience === 'sub' && item.subId === session.subId);
  });
  return before - book.pushSubscriptions.length;
}

export function subscriptionsForNotice(book, notice) {
  ensureNotify(book);
  return book.pushSubscriptions.filter((item) => {
    if (item.audience !== notice.audience) return false;
    if (notice.audience === 'studio') return true;
    return item.subId === notice.subId;
  });
}

/**
 * Send browser push for one notice. Missing VAPID or zero subscribers is a quiet no-op.
 * Gone endpoints (410/404) are pruned from the book.
 */
export async function deliverPush(book, notice, options = {}) {
  ensureNotify(book);
  const keys = vapidKeys(book, options.env || process.env);
  if (!keys) return { sent: 0, skipped: 'no_vapid' };
  const targets = subscriptionsForNotice(book, notice);
  if (!targets.length) return { sent: 0, skipped: 'no_subscribers' };

  const subject = options.subject || process.env.BIJOUX_VAPID_SUBJECT || 'mailto:studio@mistressbijoux.com';
  webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
  const payload = JSON.stringify({
    title: notice.title,
    body: notice.body,
    href: notice.href,
    noticeId: notice.id,
    kind: notice.kind,
  });

  let sent = 0;
  const dead = new Set();
  const send = options.send || ((subscription, body) => webpush.sendNotification(subscription, body));
  for (const target of targets) {
    try {
      await send({ endpoint: target.endpoint, keys: target.keys }, payload);
      sent += 1;
    } catch (error) {
      const status = error?.statusCode || error?.status;
      if (status === 404 || status === 410) dead.add(target.endpoint);
      else if (options.log !== false) {
        console.error('bijouxdebt push', error instanceof Error ? error.message : 'error');
      }
    }
  }
  if (dead.size) {
    book.pushSubscriptions = book.pushSubscriptions.filter((item) => !dead.has(item.endpoint));
  }
  return { sent, pruned: dead.size };
}

/**
 * Hook for later email delivery (SendGrid / Resend / SES).
 * High-signal notices only; no-ops until BIJOUX_EMAIL_PROVIDER is set and contacts exist.
 */
export async function deliverEmail(notice, options = {}) {
  if (!HIGH_SIGNAL.has(notice.kind)) return { skipped: 'low_signal' };
  const provider = options.provider || process.env.BIJOUX_EMAIL_PROVIDER || '';
  if (!provider) return { skipped: 'email_not_configured' };
  // Contacts and provider wiring land with the email feature.
  return { skipped: 'email_not_wired', provider };
}

export async function deliverNotice(book, notice, options = {}) {
  const push = await deliverPush(book, notice, options);
  const email = await deliverEmail(notice, options);
  return { push, email };
}
