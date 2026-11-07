const BASE = document.querySelector('meta[name="bd-base"]')?.getAttribute('content') || '';

const KIND = {
  principal: 'Signed',
  proposal: 'Proposed',
  interest: 'Interest',
  late_fee: 'Late fee',
  payment: 'Payment',
  tribute: 'Tribute',
  self_charge: 'Added by you',
  charge: 'Charge',
  penalty: 'Penalty',
  purse_draw: 'Purse',
  forgive: 'Forgiven',
  settled: 'Settled',
  note: 'Note',
  game: 'Game',
};

const SYMBOLS = {
  gem: '◆',
  ring: '◯',
  pearl: '●',
  heart: '♥\uFE0E',
  lock: '⊠',
  crown: '♛',
  star: '★',
  rose: '✿',
};

const GAME_STATUS = {
  proposed: 'Waiting for acceptance',
  ready: 'Accepted',
  paused: 'Paused by him',
};

const state = {
  adult: false,
  role: null,
  sub: null,
  pub: null,
  studio: null,
  invoice: null,
  error: '',
  formError: null,
  formNotice: null,
  notice: '',
  poll: 0,
  live: 0,
  liveSig: '',
  spin: { busy: false, stopped: 0 },
  replaying: false,
  replayQueue: [],
  atm: {},
  preview: {},
};

try {
  state.adult = localStorage.getItem('bijouxdebt-adult') === 'yes';
} catch {
  state.adult = false;
}

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'htmlFor') node.htmlFor = value;
    else if (key === 'value') node.value = String(value);
    else if (key === 'checked') node.checked = Boolean(value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function money(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(Number(cents) || 0));
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}

function dollarsToCents(value) {
  const trimmed = String(value || '').trim().replace(/^\$/, '');
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) throw new Error('Enter a dollar amount like 20 or 20.50.');
  const [dollars, fraction = ''] = trimmed.split('.');
  return Number(dollars) * 100 + Number((fraction + '00').slice(0, 2));
}

function prettyDay(iso) {
  if (!iso) return '';
  const [year, month, day] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function route() {
  const hash = (location.hash || '#/').replace(/^#/, '');
  return hash.startsWith('/') ? hash : `/${hash}`;
}

async function api(path, options = {}) {
  const response = await fetch(BASE + path, {
    method: options.method || 'GET',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: options.body == null ? undefined : JSON.stringify(options.body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || 'The book could not do that.'), { status: response.status });
  return data;
}

function field(label, control) {
  return el('label', null, el('span', null, label), control);
}

function errorSlot(key) {
  if (state.formError?.key === key) return el('p', { class: 'error form-error', role: 'alert' }, state.formError.message);
  if (state.formNotice?.key === key) return el('p', { class: 'notice form-notice', role: 'status' }, state.formNotice.message);
  return null;
}

/** Long pages put the top notice out of view, so a success stays next to the form or button that asked for it. */
function noteBesideForm(key) {
  if (!key || !state.notice) return;
  const message = state.notice;
  state.formNotice = { key, message };
  state.notice = '';
  render();
  const shown = document.querySelector('.form-notice');
  if (shown) {
    shown.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }
  state.formNotice = null;
  state.notice = message;
  render();
}

function form(key, action, ...children) {
  return formWith(key, null, action, ...children);
}

function formWith(key, attrs, action, ...children) {
  return el('form', { ...attrs, 'data-form': key, onsubmit: (event) => submit(event, action) }, ...children, errorSlot(key));
}

/** Re-rendering rebuilds every form, so put back what was typed when the same form comes back. */
function keepValues(formNode) {
  const key = formNode.getAttribute('data-form');
  const saved = [...formNode.elements].map((node) => [node.name, node.type === 'checkbox' ? node.checked : node.value]);
  return () => {
    const next = key && document.querySelector(`form[data-form="${key}"]`);
    if (!next || next.elements.length !== saved.length) return;
    [...next.elements].forEach((node, index) => {
      const [name, value] = saved[index];
      if (!name || node.name !== name || node.type === 'password' || node.type === 'file') return;
      if (node.type === 'checkbox') node.checked = value;
      else node.value = value;
    });
  };
}

function revealError() {
  document.querySelector('.form-error, .error')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function press(key, action) {
  state.error = '';
  state.formError = null;
  state.formNotice = null;
  try {
    await action();
    noteBesideForm(key);
  } catch (error) {
    state.formError = { key, message: error.message };
    render();
    revealError();
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reducedMotion() {
  return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

function clock(iso) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

function dollars(cents) {
  return (cents / 100).toFixed(2);
}

function randomHex(bytes = 16) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** One id per intended play, kept until the server answers, so a retry or refresh returns the saved result. */
const heldPlays = {};

function pendingPlayId(name) {
  try {
    const saved = sessionStorage.getItem(`bijouxdebt-play-${name}`);
    if (saved) return saved;
  } catch { /* storage blocked; the id is held in memory */ }
  heldPlays[name] ||= randomHex();
  try { sessionStorage.setItem(`bijouxdebt-play-${name}`, heldPlays[name]); } catch { /* held in memory */ }
  return heldPlays[name];
}

/**
 * The server looked the id up and turned the play down, so nothing is saved under it.
 * Sign-in and rate limits answer before that lookup, and a network error or 5xx might follow a save, so those keep the id.
 */
function refused(error) {
  return error.status >= 400 && error.status < 500 && ![401, 408, 429].includes(error.status);
}

function hasPendingPlay(name) {
  if (heldPlays[name]) return true;
  try {
    return Boolean(sessionStorage.getItem(`bijouxdebt-play-${name}`));
  } catch {
    return false;
  }
}

function clearPendingPlay(name) {
  delete heldPlays[name];
  try { sessionStorage.removeItem(`bijouxdebt-play-${name}`); } catch { /* nothing saved */ }
}

function banner() {
  const blocks = [];
  if (state.pub?.checkout === 'sandbox') {
    blocks.push(el('p', { class: 'banner' }, 'Lightning is not connected on this server. Checkout is a sample: the book updates, and no money moves.'));
  }
  if (state.error) blocks.push(el('p', { class: 'error', role: 'alert' }, state.error));
  if (state.notice) blocks.push(el('p', { class: 'notice', role: 'status' }, state.notice));
  return blocks;
}

function shell(current, ...main) {
  const link = (href, label) => el('a', { href: `#${href}`, 'aria-current': current === href ? 'page' : null }, label);
  const app = document.getElementById('app');
  app.replaceChildren(el('header', { class: 'top' },
    el('a', { class: 'brand', href: '#/' }, 'Bijoux Debt'),
    el('nav', null,
      link('/', 'The book'),
      link('/join', 'Open a name'),
      link('/book', state.sub ? state.sub.handle : 'My book'),
      link('/games', 'Games'),
      link('/studio', 'Studio'),
      el('a', { class: 'site-link', href: 'https://mistressbijoux.com', rel: 'noopener noreferrer' }, 'mistressbijoux.com'),
    ),
  ), el('main', { class: 'wrap' }, ...main));
}

function home() {
  const pub = state.pub;
  shell('/',
    ...banner(),
    el('div', { class: 'mark', 'aria-hidden': 'true' }, el('span')),
    el('p', { class: 'kicker' }, 'Dominatrix Bijoux'),
    el('h1', null, 'The book'),
    el('p', { class: 'lede' }, 'Debts, tributes, and the Lightning payments that belong on the same page. You and she see the same lines. A debt does not run until you sign it.'),
    el('div', { class: 'steps' },
      step('1', 'Open a name', 'You pick a title and a passphrase. She can then write a debt, or you can simply send tribute.'),
      step('2', 'Sign before it runs', 'Interest, due dates, and late fees stay frozen until you accept the terms on the page.'),
      step('3', 'Pay, or claim a payment', 'Lightning writes itself into the book when it settles. A payment made elsewhere waits until she confirms it.'),
    ),
    el('div', { class: 'row' },
      el('a', { class: 'btn', href: '#/join' }, 'Open a name'),
      el('a', { class: 'btn secondary', href: '#/book' }, 'Return to your book'),
    ),
    el('h2', { class: 'spaced' }, 'Tiers'),
    el('div', { class: 'grid cards' }, ...(pub?.tiers || []).map(tierCard)),
    el('h2', { id: 'hall', class: 'spaced' }, 'Hall'),
    hall(pub),
    foot(),
  );
}

function step(num, title, text) {
  return el('div', { class: 'step' },
    el('div', { class: 'num' }, num),
    el('div', null, el('strong', null, title), el('p', { class: 'muted' }, text)),
  );
}

function tierCard(tier) {
  return el('article', { class: 'card' },
    el('p', { class: 'kicker' }, tier.name),
    el('p', { class: 'figure' }, money(tier.amountCents)),
    el('p', { class: 'muted' }, tier.blurb),
    el('button', {
      class: 'btn',
      type: 'button',
      onclick: () => startTier(tier),
    }, `Send ${money(tier.amountCents)}`),
  );
}

function startTier(tier) {
  try {
    sessionStorage.setItem('bijouxdebt-pending', JSON.stringify({ tierId: tier.id, purpose: 'tribute' }));
  } catch { /* the book still opens if storage is blocked */ }
  if (state.role === 'sub') {
    location.hash = '#/book';
    consumePending().catch((error) => {
      state.error = error.message;
      render();
      revealError();
    });
    return;
  }
  location.hash = '#/join';
  render();
}

function hall(pub) {
  if (!pub?.hall?.length) return el('p', { class: 'muted' }, 'The hall is quiet. Tribute shows up here after a payment is confirmed.');
  return el('ol', { class: 'hall' }, pub.hall.map((person, index) => el('li', null,
    el('span', null, `${index + 1}. ${person.handle}`),
    el('span', null, el('span', { class: 'tag' }, person.title), ' ', money(person.sentCents)),
  )));
}

function foot() {
  return el('footer', null,
    el('p', null, 'This page keeps a private record between adults. It does not lend money, and it does not hold a balance you can withdraw.'),
    el('p', null, 'When Lightning is connected, checkout pays her node directly. A settled invoice cannot be reversed. A sample checkout, shown when the node is off, moves nothing.'),
    el('p', null, `${state.pub?.names || 0} names in the book. ${money(state.pub?.sentCents || 0)} recorded.`),
  );
}

function join() {
  shell('/join',
    ...banner(),
    el('p', { class: 'kicker' }, 'A name in the book'),
    el('h1', null, 'Open a name'),
    el('div', { class: 'grid split' },
      formWith('join', { class: 'panel' }, createName,
        field('Name', el('input', { name: 'handle', required: true, minlength: 3, maxlength: 20, autocomplete: 'username', pattern: '[A-Za-z0-9_]{3,20}' })),
        field('Title', el('select', { name: 'title' }, ...(state.pub?.titles || ['sub']).map((title) => el('option', { value: title }, title)))),
        field('Passphrase', el('input', { name: 'passphrase', type: 'password', required: true, minlength: 8, maxlength: 72, autocomplete: 'new-password' })),
        field('Age', el('span', { class: 'row' }, el('input', { name: 'adult', type: 'checkbox', required: true }), 'I am 18 or older.')),
        el('button', { class: 'btn', type: 'submit' }, 'Open my book'),
      ),
      formWith('enter', { class: 'panel' }, enterName,
        el('h2', null, 'Already opened'),
        field('Name', el('input', { name: 'handle', required: true, autocomplete: 'username' })),
        field('Passphrase', el('input', { name: 'passphrase', type: 'password', required: true, autocomplete: 'current-password' })),
        el('button', { class: 'btn secondary', type: 'submit' }, 'Enter'),
      ),
    ),
  );
}

async function createName(event) {
  const data = Object.fromEntries(new FormData(event.target));
  const session = await api('/api/join', {
    method: 'POST',
    body: {
      handle: data.handle,
      passphrase: data.passphrase,
      title: data.title,
      adult: data.adult === 'on',
    },
  });
  state.role = 'sub';
  state.sub = session.sub;
  state.notice = 'Your name is in the book.';
  location.hash = '#/book';
  await consumePending();
}

async function enterName(event) {
  const data = Object.fromEntries(new FormData(event.target));
  const session = await api('/api/login', {
    method: 'POST',
    body: { handle: data.handle, passphrase: data.passphrase },
  });
  state.role = 'sub';
  state.sub = session.sub;
  state.notice = 'The book is open.';
  location.hash = '#/book';
  await consumePending();
}

async function consumePending() {
  let pending = null;
  try {
    pending = JSON.parse(sessionStorage.getItem('bijouxdebt-pending') || 'null');
    if (pending) sessionStorage.removeItem('bijouxdebt-pending');
  } catch {
    pending = null;
  }
  if (!pending || state.role !== 'sub') {
    render();
    return;
  }
  state.invoice = await api('/api/checkout', { method: 'POST', body: pending });
  watchInvoice(state.invoice.id);
  render();
}

function book() {
  if (state.role !== 'sub' || !state.sub) {
    shell('/book', ...banner(), el('h1', null, 'My book'), el('p', { class: 'lede' }, 'Open a name, or enter one you already have.'), el('a', { class: 'btn', href: '#/join' }, 'Open a name'));
    return;
  }
  const sub = state.sub;
  const debt = sub.debt;
  shell('/book',
    ...banner(),
    el('p', { class: 'kicker' }, sub.title),
    el('h1', null, sub.handle),
    el('div', { class: 'grid cards' },
      figure('Debt', debt ? money(debt.balanceCents) : 'None', debt ? debt.status : 'No debt has been written'),
      figure('Tribute', money(sub.tributeCents), 'Recorded as tribute'),
      figure('Sent', money(sub.sentCents), 'Everything confirmed'),
      figure('Waiting', money(sub.askCents), `ATM holds ${money(sub.atm.balanceCents)}`),
    ),
    debtPanel(debt),
    invoicePanel(),
    el('div', { class: 'grid split' },
      el('section', { class: 'panel' },
        el('h2', null, 'Pay or claim'),
        payForm('Pay the debt', 'debt', Boolean(debt && debt.status === 'active')),
        payForm('Send tribute', 'tribute', true),
        form('claim', claimPayment,
          el('h3', null, 'Claim a payment made elsewhere'),
          field('Amount', el('input', { name: 'amount', inputmode: 'decimal', required: true, placeholder: '0.00' })),
          field('Toward', el('select', { name: 'purpose' }, el('option', { value: 'debt' }, 'Debt'), el('option', { value: 'tribute' }, 'Tribute'))),
          field('Note', el('input', { name: 'note', maxlength: 140, placeholder: 'Cash App, throne, cash' })),
          el('p', { class: 'muted' }, 'A payment made outside Lightning needs its transaction ID, a screenshot of it, or both. Crop out account numbers first. Lightning payments need no proof: they write themselves in when they settle.'),
          field('Transaction ID', el('input', { name: 'reference', maxlength: 100, autocomplete: 'off' })),
          field('Screenshot, PNG or JPEG up to 3 MB', el('input', { name: 'screenshot', type: 'file', accept: 'image/png,image/jpeg' })),
          el('button', { class: 'btn secondary', type: 'submit' }, 'Submit the claim'),
        ),
      ),
      el('section', { class: 'panel' },
        el('h2', null, 'Your side of the book'),
        form('self-charge', selfCharge,
          el('h3', null, 'Add to the debt'),
          field('Amount', el('input', { name: 'amount', inputmode: 'decimal', required: true })),
          field('What you are adding', el('input', { name: 'note', required: true, maxlength: 140 })),
          el('button', { class: 'btn secondary', type: 'submit' }, 'Add it'),
        ),
        el('div', null,
          el('h3', null, 'Games and the Human ATM'),
          el('p', { class: 'muted' }, `The ATM holds ${money(sub.atm.balanceCents)}. She can withdraw that much and no more until you reload it.${sub.atm.frozen ? ' It is frozen.' : ''}`),
          el('a', { class: 'btn secondary', href: '#/games' }, 'Open games'),
        ),
        form('hall', toggleHall,
          field('Hall', el('span', { class: 'row' }, el('input', { name: 'hide', type: 'checkbox', checked: sub.hideFromHall ? true : null }), 'Hide my name from the hall')),
          el('button', { class: 'btn secondary', type: 'submit' }, 'Save'),
        ),
        el('button', { class: 'btn danger', type: 'button', onclick: logout }, 'Leave this name'),
      ),
    ),
    tasks(sub, false),
    feed(sub),
  );
}

function figure(label, value, detail) {
  return el('article', { class: 'card' }, el('p', { class: 'kicker' }, label), el('p', { class: 'figure' }, value), el('p', { class: 'muted' }, detail));
}

function debtPanel(debt) {
  if (!debt) return el('p', { class: 'muted' }, 'She has not written a debt for this name. Tribute can still be sent.');
  if (debt.status === 'proposed') {
    return el('section', { class: 'panel' },
      el('h2', null, 'A debt is waiting for your signature'),
      el('p', null, `${money(debt.principalCents)} principal. ${debt.apr}% a year, posted each New York morning. Minimum ${money(debt.minPaymentCents)} by day ${debt.dueDay}. Late fee ${money(debt.lateFeeCents)}.`),
      el('p', { class: 'muted' }, 'Until you sign, nothing accrues and nothing can be recorded against it.'),
      el('button', { class: 'btn', type: 'button', onclick: signDebt }, 'Sign this debt'),
    );
  }
  return el('section', { class: 'panel' },
    el('h2', null, `Debt is ${debt.status}`),
    el('p', null, `Principal ${money(debt.principalCents)}. Balance ${money(debt.balanceCents)}. ${debt.apr}% interest. Due day ${debt.dueDay}${debt.nextDue ? `, next ${prettyDay(debt.nextDue)}` : ''}.`),
  );
}

function payForm(title, purpose, enabled) {
  if (!enabled) return el('p', { class: 'muted' }, `${title} opens after the debt is signed.`);
  return form(`pay-${purpose}`, (event) => checkoutAmount(event, purpose),
    el('h3', null, title),
    field('Amount', el('input', { name: 'amount', inputmode: 'decimal', required: true, placeholder: '0.00' })),
    el('button', { class: 'btn', type: 'submit' }, 'Checkout'),
  );
}

function invoicePanel() {
  const invoice = state.invoice;
  if (!invoice) return null;
  const bolt11 = /^ln[a-z0-9]+$/i.test(invoice.bolt11 || '') ? invoice.bolt11 : '';
  const live = invoice.mode === 'live' && bolt11;
  const qr = invoice.qrSvg && invoice.qrSvg.startsWith('<svg')
    ? el('img', { class: 'qr', alt: 'Lightning invoice', src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(invoice.qrSvg)}` })
    : null;
  return el('section', { class: 'panel', id: 'checkout' },
    el('h2', null, invoice.sample ? 'Sample checkout' : 'Lightning checkout'),
    el('p', null, `${money(invoice.amountCents)} toward ${invoice.purpose}. ${invoice.note}`),
    el('p', { class: 'tag' }, invoice.status),
    invoice.sample
      ? el('p', { class: 'muted' }, invoice.status === 'pending'
        ? 'No money moves. Settle the sample to write the line into the book.'
        : 'Sample payment recorded. No money moved.')
      : el('p', { class: 'muted' }, invoice.status === 'paid'
        ? 'Settled on Lightning and written into the book. This payment cannot be reversed.'
        : 'Pay this invoice from your wallet. When it settles, the book updates on its own. A settled Lightning payment cannot be reversed.'),
    qr,
    live ? el('p', null, el('a', { href: `lightning:${bolt11}` }, 'Open in a wallet')) : null,
    live ? el('p', null, el('code', null, bolt11)) : null,
    invoice.amountSats ? el('p', { class: 'muted' }, `${invoice.amountSats.toLocaleString('en-US')} sats`) : null,
    invoice.sample && invoice.status === 'pending'
      ? el('button', { class: 'btn', type: 'button', onclick: simulate }, 'Settle sample payment')
      : null,
  );
}

function tasks(sub, studio) {
  if (!sub.tasks?.length) return null;
  return el('section', { class: 'panel' },
    el('h2', null, 'Tasks'),
    ...sub.tasks.map((task) => el('article', null,
      el('h3', null, task.title),
      task.detail ? el('p', null, task.detail) : null,
      el('p', { class: 'muted' }, `${task.status.replace('_', ' ')}${task.due ? ` · due ${prettyDay(task.due)}` : ''}${task.penaltyCents ? ` · penalty ${money(task.penaltyCents)}` : ''}`),
      !studio && task.status === 'open' ? el('button', { class: 'btn secondary', type: 'button', onclick: () => markTask(task.id) }, 'Mark done') : null,
    )),
  );
}

function feed(sub) {
  const lines = [...(sub.entries || [])].reverse();
  return el('section', null,
    el('h2', null, 'The lines'),
    lines.length ? el('ol', { class: 'feed' }, lines.map((entry) => el('li', null,
      el('span', null,
        `${prettyDay(entry.nyDay)} · ${KIND[entry.kind] || entry.kind} · ${entry.note || ''}${entry.status === 'confirmed' ? '' : ` · ${entry.status}`}`,
        entry.reference ? ` · ID ${entry.reference}` : '',
        entry.screenshot ? [' · ', proofLink(entry, 'Screenshot')] : null,
      ),
      entry.amountCents ? el('strong', null, money(entry.amountCents)) : null,
    ))) : el('p', { class: 'muted' }, 'No lines yet.'),
  );
}

function studio() {
  if (state.role !== 'studio') {
    shell('/studio',
      ...banner(),
      el('p', { class: 'kicker' }, 'Private'),
      el('h1', null, 'Studio'),
      formWith('studio-login', { class: 'panel' }, studioLogin,
        field('Studio pin', el('input', { name: 'pin', type: 'password', required: true, autocomplete: 'current-password' })),
        el('button', { class: 'btn', type: 'submit' }, 'Unlock'),
      ),
    );
    return;
  }
  const gamesFor = route().match(/^\/studio\/games\/([a-f0-9]+)$/);
  if (gamesFor) {
    studioGames(gamesFor[1]);
    return;
  }
  const book = state.studio;
  shell('/studio',
    ...banner(),
    el('p', { class: 'kicker' }, book.month),
    el('h1', null, 'Studio'),
    el('div', { class: 'grid cards' },
      figure('This month', money(book.sentThisMonthCents), 'Confirmed payments'),
      figure('Names', String(book.subs.length), book.checkout === 'live' ? 'Lightning is live' : 'Lightning is in sample mode'),
    ),
    tierEditor(book),
    ...book.subs.map(studioCard),
    book.subs.length ? null : el('p', { class: 'muted' }, 'No names yet. They open one from the public page.'),
    el('button', { class: 'btn secondary', type: 'button', onclick: logout }, 'Lock the studio'),
  );
}

function tierEditor(book) {
  return formWith('tiers', { class: 'panel' }, saveTiers,
    el('h2', null, 'Tiers'),
    ...(book.tiers || []).map((tier) => el('div', { 'data-tier': tier.id, class: 'grid cards' },
      field('Name', el('input', { name: 'name', value: tier.name, required: true })),
      field('Amount', el('input', { name: 'amount', value: (tier.amountCents / 100).toFixed(2), required: true })),
      field('Line', el('input', { name: 'blurb', value: tier.blurb || '' })),
    )),
    el('button', { class: 'btn secondary', type: 'submit' }, 'Save tiers'),
  );
}

function studioCard(sub) {
  const debt = sub.debt;
  return el('details', { class: 'panel', open: true },
    el('summary', null, `${sub.handle} · ${sub.title} · sent ${money(sub.sentCents)} · debt ${debt ? money(debt.balanceCents) : 'none'}`),
    debt ? el('p', null, `Status ${debt.status}. ${debt.apr}% · due day ${debt.dueDay} · late fee ${money(debt.lateFeeCents)} · minimum ${money(debt.minPaymentCents)}.`) : el('p', { class: 'muted' }, 'No debt yet.'),
    el('p', { class: 'muted' }, `Ask ${money(sub.askCents)}. ATM ${money(sub.atm.balanceCents)} left of ${money(sub.atm.loadedCents)} loaded${sub.atm.frozen ? ', frozen' : ''}. This month ${money(sub.monthCents)}.`),
    el('p', { class: 'row' },
      el('a', { class: 'btn secondary', href: `#/studio/games/${sub.id}` }, 'Slot machine and ATM'),
      el('span', { class: 'muted' }, `Slot: ${sub.games.slot ? GAME_STATUS[sub.games.slot.status].toLowerCase() : 'not set up'}. ATM: ${sub.games.atm ? GAME_STATUS[sub.games.atm.status].toLowerCase() : 'no terms yet'}.${sub.standing.locks.length ? ' Games are locked.' : ''}`),
    ),
    form(`debt-${sub.id}`, (event) => proposeDebt(event, sub.id),
      el('h3', null, 'Write a debt'),
      field('Principal', el('input', { name: 'principal', required: true, placeholder: '500.00' })),
      field('Interest % per year', el('input', { name: 'apr', required: true, value: '0' })),
      field('Minimum payment', el('input', { name: 'minimum', value: '0' })),
      field('Late fee', el('input', { name: 'lateFee', value: '0' })),
      field('Due day (1–28)', el('input', { name: 'dueDay', required: true, value: '15' })),
      el('button', { class: 'btn', type: 'submit' }, 'Propose it'),
    ),
    debt && (debt.status === 'active' || debt.status === 'paused') ? el('div', { class: 'row' },
      debt.status === 'active' ? el('button', { class: 'btn secondary', type: 'button', onclick: () => debtAction(sub.id, 'pause') }, 'Pause') : null,
      debt.status === 'paused' ? el('button', { class: 'btn secondary', type: 'button', onclick: () => debtAction(sub.id, 'resume') }, 'Resume') : null,
      el('button', { class: 'btn secondary', type: 'button', onclick: () => debtAction(sub.id, 'settle') }, 'Settle'),
      el('button', { class: 'btn danger', type: 'button', onclick: () => debtAction(sub.id, 'forgive') }, 'Forgive and stop'),
    ) : null,
    form(`charge-${sub.id}`, (event) => studioMoney(event, '/api/studio/charge', sub.id),
      el('h3', null, 'Add a charge'),
      field('Amount', el('input', { name: 'amount', required: true })),
      field('Note', el('input', { name: 'note', maxlength: 140 })),
      el('button', { class: 'btn secondary', type: 'submit' }, 'Charge'),
    ),
    form(`payment-${sub.id}`, (event) => recordPayment(event, sub.id),
      el('h3', null, 'Record a payment you already received'),
      field('Amount', el('input', { name: 'amount', required: true })),
      field('Toward', el('select', { name: 'purpose' }, el('option', { value: 'debt' }, 'Debt'), el('option', { value: 'tribute' }, 'Tribute'))),
      field('Note', el('input', { name: 'note', maxlength: 140 })),
      el('button', { class: 'btn secondary', type: 'submit' }, 'Record it'),
    ),
    form(`task-${sub.id}`, (event) => createTask(event, sub.id),
      el('h3', null, 'Give a task'),
      field('Title', el('input', { name: 'title', required: true, maxlength: 80 })),
      field('Detail', el('input', { name: 'detail', maxlength: 280 })),
      field('Due', el('input', { name: 'due', type: 'date' })),
      field('Penalty if missed', el('input', { name: 'penalty', value: '0' })),
      el('button', { class: 'btn secondary', type: 'submit' }, 'Add the task'),
    ),
    claims(sub),
    verdicts(sub),
    feed(sub),
  );
}

function claims(sub) {
  const pending = (sub.entries || []).filter((entry) => entry.status === 'pending');
  if (!pending.length) return null;
  return el('div', null, el('h3', null, 'Claims'), ...pending.map((entry) => el('div', { class: 'claim' },
    el('p', null, el('strong', null, `${money(entry.amountCents)} ${entry.purpose}`), entry.note ? ` · ${entry.note}` : ''),
    el('p', null, entry.reference ? ['Transaction ID ', el('code', null, entry.reference)] : el('span', { class: 'muted' }, 'No transaction ID')),
    entry.screenshot
      ? proofLink(entry, el('img', { class: 'proof-thumb', src: `${BASE}/api/proof/${entry.id}`, alt: 'Payment screenshot' }))
      : el('p', { class: 'muted' }, 'No screenshot'),
    el('div', { class: 'row' },
      el('button', { class: 'btn', type: 'button', onclick: () => decideClaim(entry.id, 'confirm') }, 'Confirm'),
      el('button', { class: 'btn danger', type: 'button', onclick: () => decideClaim(entry.id, 'reject') }, 'Reject'),
    ),
  )));
}

function proofLink(entry, content) {
  return el('a', { href: `${BASE}/api/proof/${entry.id}`, target: '_blank', rel: 'noopener' }, content);
}

function verdicts(sub) {
  const open = (sub.tasks || []).filter((task) => task.status === 'open' || task.status === 'done_pending');
  if (!open.length) return null;
  return el('div', null, el('h3', null, 'Verdicts'), ...open.map((task) => el('div', { class: 'row' },
    el('span', null, `${task.title} · ${task.status.replace('_', ' ')}`),
    el('button', { class: 'btn', type: 'button', onclick: () => verdict(sub.id, task.id, 'accept') }, 'Accept'),
    el('button', { class: 'btn danger', type: 'button', onclick: () => verdict(sub.id, task.id, 'miss') }, 'Missed'),
  )));
}

async function submit(event, action) {
  event.preventDefault();
  state.error = '';
  state.formError = null;
  state.formNotice = null;
  const key = event.target.getAttribute('data-form');
  const restore = keepValues(event.target);
  const button = event.submitter;
  if (button) button.disabled = true;
  try {
    await action(event, restore);
    noteBesideForm(key);
  } catch (error) {
    if (key) state.formError = { key, message: error.message };
    else state.error = error.message;
    render();
    restore();
    revealError();
  }
}

async function refreshSub(next) {
  state.sub = next.sub;
  state.notice = 'The book is updated.';
  if (state.role === 'studio') state.studio = await api('/api/studio');
  state.pub = await api('/api/public');
  render();
}

async function signDebt() {
  state.error = '';
  try {
    await refreshSub(await api('/api/me/sign', { method: 'POST', body: {} }));
  } catch (error) {
    state.error = error.message;
    render();
  }
}

async function checkoutAmount(event, purpose) {
  const amountCents = dollarsToCents(new FormData(event.target).get('amount'));
  const button = event.submitter;
  if (button) {
    button.textContent = 'Creating invoice…';
    button.setAttribute('aria-busy', 'true');
  }
  state.invoice = await api('/api/checkout', { method: 'POST', body: { amountCents, purpose } });
  watchInvoice(state.invoice.id);
  state.notice = state.invoice.sample ? 'Sample invoice ready.' : 'Invoice ready.';
  render();
  document.getElementById('checkout')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function watchInvoice(id) {
  const token = ++state.poll;
  const tick = async () => {
    if (token !== state.poll) return;
    try {
      const invoice = await api(`/api/checkout/${id}`);
      state.invoice = invoice;
      if (invoice.status === 'pending') {
        setTimeout(tick, 3000);
        return;
      }
      if (invoice.status === 'paid') {
        const session = await api('/api/session');
        state.sub = session.sub;
        state.pub = await api('/api/public');
        state.notice = invoice.sample ? 'Sample payment recorded. No money moved.' : 'Payment settled and written into the book.';
      }
      render();
    } catch (error) {
      state.error = error.message;
      render();
    }
  };
  setTimeout(tick, 3000);
}

async function simulate() {
  state.error = '';
  try {
    state.invoice = await api(`/api/checkout/${state.invoice.id}/simulate`, { method: 'POST', body: {} });
    const session = await api('/api/session');
    state.sub = session.sub;
    state.pub = await api('/api/public');
    state.notice = 'Sample payment recorded. No money moved.';
    render();
  } catch (error) {
    state.error = error.message;
    render();
  }
}

const PROOF_MAX_BYTES = 3 * 1024 * 1024;

async function fileBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}

async function claimPayment(event) {
  const data = Object.fromEntries(new FormData(event.target));
  const amountCents = dollarsToCents(data.amount);
  const reference = String(data.reference || '').trim();
  const file = data.screenshot?.size ? data.screenshot : null;
  if (!reference && !file) throw new Error('Add the transaction ID, a screenshot, or both.');
  if (file && !['image/png', 'image/jpeg'].includes(file.type)) throw new Error('The screenshot must be a PNG or JPEG.');
  if (file && file.size > PROOF_MAX_BYTES) throw new Error('The screenshot is over 3 MB. Crop it or save it smaller, then try again.');
  const screenshot = file ? { type: file.type, data: await fileBase64(file) } : null;
  await refreshSub(await api('/api/me/claim', {
    method: 'POST',
    body: { amountCents, purpose: data.purpose, note: data.note, reference, screenshot },
  }));
}

async function selfCharge(event) {
  const data = Object.fromEntries(new FormData(event.target));
  await refreshSub(await api('/api/me/self-charge', {
    method: 'POST',
    body: { amountCents: dollarsToCents(data.amount), note: data.note },
  }));
}

async function toggleHall(event) {
  const hide = new FormData(event.target).get('hide') === 'on';
  await refreshSub(await api('/api/me/hide', { method: 'POST', body: { hideFromHall: hide } }));
}

async function markTask(taskId) {
  state.error = '';
  try {
    await refreshSub(await api('/api/me/task-done', { method: 'POST', body: { taskId } }));
  } catch (error) {
    state.error = error.message;
    render();
  }
}

async function logout() {
  await api('/api/logout', { method: 'POST', body: {} });
  state.role = null;
  state.sub = null;
  state.studio = null;
  state.invoice = null;
  state.notice = 'Closed.';
  location.hash = '#/';
  render();
}

async function studioLogin(event) {
  const pin = new FormData(event.target).get('pin');
  await api('/api/studio/login', { method: 'POST', body: { pin } });
  state.role = 'studio';
  state.sub = null;
  state.studio = await api('/api/studio');
  state.notice = 'Studio is open.';
  render();
}

async function saveTiers(event) {
  const tiers = [...event.target.querySelectorAll('[data-tier]')].map((row) => ({
    id: row.getAttribute('data-tier'),
    name: row.querySelector('[name=name]').value,
    blurb: row.querySelector('[name=blurb]').value,
    amountCents: dollarsToCents(row.querySelector('[name=amount]').value),
  }));
  await api('/api/studio/tiers', { method: 'POST', body: { tiers } });
  state.studio = await api('/api/studio');
  state.pub = await api('/api/public');
  state.notice = 'Tiers saved.';
  render();
}

async function proposeDebt(event, subId) {
  const data = Object.fromEntries(new FormData(event.target));
  await api('/api/studio/debt', {
    method: 'POST',
    body: {
      subId,
      principalCents: dollarsToCents(data.principal),
      apr: Number(data.apr),
      minPaymentCents: dollarsToCents(data.minimum || '0'),
      lateFeeCents: dollarsToCents(data.lateFee || '0'),
      dueDay: Number(data.dueDay),
    },
  });
  state.studio = await api('/api/studio');
  state.notice = 'The debt is proposed. It stays frozen until it is signed.';
  render();
}

async function studioMoney(event, path, subId) {
  const data = Object.fromEntries(new FormData(event.target));
  await api(path, {
    method: 'POST',
    body: { subId, amountCents: dollarsToCents(data.amount), note: data.note },
  });
  state.studio = await api('/api/studio');
  state.notice = 'Recorded.';
  render();
}

async function recordPayment(event, subId) {
  const data = Object.fromEntries(new FormData(event.target));
  await api('/api/studio/payment', {
    method: 'POST',
    body: { subId, amountCents: dollarsToCents(data.amount), purpose: data.purpose, note: data.note },
  });
  state.studio = await api('/api/studio');
  state.notice = 'Payment recorded.';
  render();
}

async function createTask(event, subId) {
  const data = Object.fromEntries(new FormData(event.target));
  await api('/api/studio/task', {
    method: 'POST',
    body: {
      subId,
      title: data.title,
      detail: data.detail,
      due: data.due || null,
      penaltyCents: dollarsToCents(data.penalty || '0'),
    },
  });
  state.studio = await api('/api/studio');
  state.notice = 'Task added.';
  render();
}

async function decideClaim(entryId, decision) {
  state.error = '';
  try {
    await api('/api/studio/claim', { method: 'POST', body: { entryId, decision } });
    state.studio = await api('/api/studio');
    state.notice = decision === 'confirm' ? 'Claim confirmed.' : 'Claim rejected.';
    render();
  } catch (error) {
    state.error = error.message;
    render();
  }
}

async function verdict(subId, taskId, decision) {
  state.error = '';
  try {
    await api('/api/studio/verdict', { method: 'POST', body: { subId, taskId, decision } });
    state.studio = await api('/api/studio');
    state.notice = 'Verdict recorded.';
    render();
  } catch (error) {
    state.error = error.message;
    render();
  }
}

async function debtAction(subId, action) {
  state.error = '';
  try {
    await api('/api/studio/status', { method: 'POST', body: { subId, action } });
    state.studio = await api('/api/studio');
    state.notice = 'The debt is updated.';
    render();
  } catch (error) {
    state.error = error.message;
    render();
  }
}

function chance(item) {
  return item.exact ? `${item.percent}%` : `${item.percent}% (exactly ${item.fraction.replace('/', ' in ')})`;
}

function averageText(average) {
  if (average.numerator % average.denominator === 0) return money(average.cents);
  return `${money(average.cents)} (exactly ${average.fraction} cents)`;
}

function duration(seconds) {
  if (seconds < 120) return `${seconds} seconds`;
  if (seconds < 7200) return `${Math.round(seconds / 60)} minutes`;
  return `${Math.round(seconds / 360) / 10} hours`;
}

function limitsLine(game, unit) {
  const own = game.subLimits?.perPlayCapCents != null || game.subLimits?.dailyCapCents != null;
  return `Up to ${money(game.limits.perPlayCapCents)} a ${unit} and ${money(game.limits.dailyCapCents)} a New York day, one ${unit} every ${duration(game.limits.cooldownSeconds)}.${own ? ' Includes caps he lowered himself.' : ''}`;
}

function table(head, rows) {
  return el('table', { class: 'odds-table' },
    el('thead', null, el('tr', null, ...head.map((cell) => el('th', { scope: 'col' }, cell)))),
    el('tbody', null, ...rows.map((row) => el('tr', null, ...row.map((cell) => el('td', null, cell))))),
  );
}

function slotTerms(game) {
  const odds = game.odds;
  return el('div', { class: 'odds' },
    el('p', { class: 'rigged' }, odds.rigged),
    el('p', null, `Stake ${money(odds.stakeCents)}. Every spin adds to the signed debt. Nothing pays out and nothing comes off: the best result is the smallest charge.`),
    table(['Outcome', 'Chance', 'Adds to the debt'], odds.outcomes.map((item) => [
      item.label,
      chance(item),
      `${money(item.chargeCents)} (${item.multiplierPct / 100}x${item.capped ? ', held to the cap' : ''})`,
    ])),
    el('p', null, el('strong', null, `Average charge per spin: ${averageText(odds.average)}.`)),
    el('p', { class: 'muted' }, `Each reel lands on ${odds.reels.map((reel) => `${SYMBOLS[reel.id]} ${reel.id} ${chance(reel)}`).join(', ')}.`),
    el('p', { class: 'muted' }, limitsLine(game, 'spin')),
  );
}

function atmTerms(game) {
  const odds = game.odds;
  return el('div', { class: 'odds' },
    el('p', { class: 'rigged' }, odds.rigged),
    el('p', null, 'Every withdrawal adds to the signed debt and comes off the loaded balance. Nothing is paid back.'),
    table(['Option', 'Chance', 'Adds to the debt'], [
      ['Her pick', 'She types the amount', `${money(100)} to ${money(game.limits.perPlayCapCents)}`],
      ['Fast cash', '100%', money(odds.quick.amountCents)],
      ['Surprise skim', `Every cent from ${money(odds.skim.minCents)} to ${money(odds.skim.maxCents)} equally likely`, `Average ${averageText(odds.skim.average)}`],
      ...odds.kick.outcomes.map((item) => ['Kick it for a bonus', chance(item), money(item.amountCents)]),
    ]),
    el('p', null, el('strong', null, `Average kick: ${averageText(odds.kick.average)}. Average skim: ${averageText(odds.skim.average)}.`)),
    el('p', { class: 'muted' }, limitsLine(game, 'withdrawal')),
  );
}

function acceptPanel(game, terms) {
  const key = `${game.key}-accept`;
  return el('div', { class: 'accept' },
    el('p', null, el('span', { class: 'tag' }, game.acceptedVersion ? `Changed · version ${game.version}` : `Proposed · version ${game.version}`)),
    el('p', null, game.acceptedVersion
      ? 'She changed the terms. Nothing can be played until you read them and accept again.'
      : 'Read the terms first. Nothing can be played until you accept them.'),
    terms,
    el('div', { class: 'row' },
      el('button', { class: 'btn', type: 'button', onclick: () => press(key, () => acceptTerms(game)) }, 'I accept these terms'),
    ),
    errorSlot(key),
  );
}

function subLimitsForm(game, unit) {
  const key = `${game.key}-limits`;
  const own = game.subLimits;
  return form(key, (event) => saveGameCaps(event, game.key),
    el('h3', null, 'Your limits'),
    el('p', { class: 'muted' }, `Pause or lower these any time. Her caps are ${money(game.terms.perPlayCapCents)} a ${unit} and ${money(game.terms.dailyCapCents)} a day. Leave a box empty to use hers.`),
    el('div', { class: 'row' },
      el('button', { class: 'btn secondary', type: 'button', onclick: () => press(key, () => setGameLimits(game.key, { paused: !game.pausedBySub })) },
        game.pausedBySub ? 'Resume this game' : 'Pause this game'),
    ),
    el('div', { class: 'grid cards' },
      field(`Most per ${unit}`, el('input', { name: 'perPlay', inputmode: 'decimal', placeholder: dollars(game.terms.perPlayCapCents), value: own.perPlayCapCents == null ? '' : dollars(own.perPlayCapCents) })),
      field('Most per day', el('input', { name: 'daily', inputmode: 'decimal', placeholder: dollars(game.terms.dailyCapCents), value: own.dailyCapCents == null ? '' : dollars(own.dailyCapCents) })),
    ),
    el('button', { class: 'btn secondary', type: 'submit' }, 'Save my limits'),
  );
}

function playList(game, replay) {
  if (!game.plays.length) return null;
  return el('div', null,
    el('h3', null, game.key === 'slot' ? 'Recent spins' : 'Withdrawals'),
    el('ol', { class: 'feed' }, [...game.plays].reverse().map((play) => el('li', null,
      el('span', null,
        `${prettyDay(play.nyDay)} ${clock(play.at)} · `,
        play.reels ? `${play.reels.map((id) => SYMBOLS[id]).join(' ')} · ` : '',
        play.label,
        play.atmBalanceAfterCents != null ? ` · ATM left ${money(play.atmBalanceAfterCents)}` : '',
        ` · debt ${money(play.balanceAfterCents)}`,
      ),
      el('span', { class: 'row' },
        el('strong', null, `+${money(play.amountCents)}`),
        replay ? el('button', { class: 'btn secondary small-btn', type: 'button', onclick: () => replayOnDemand(play) }, 'Replay') : null,
      ),
    ))),
  );
}

function games() {
  if (state.role !== 'sub' || !state.sub) {
    shell('/games', ...banner(), el('h1', null, 'Games'), el('p', { class: 'lede' }, 'Open your name to see the games she set up for you.'), el('a', { class: 'btn', href: '#/join' }, 'Open a name'));
    return;
  }
  const sub = state.sub;
  const debt = sub.debt;
  state.liveSig = JSON.stringify(sub);
  shell('/games',
    ...banner(),
    el('p', { class: 'kicker' }, sub.handle),
    el('h1', null, 'Games'),
    el('p', { class: 'lede' }, 'Every result adds to your signed debt. Nothing pays out and nothing comes off. The best you can do is the smallest charge.'),
    el('div', { class: 'grid cards' },
      figure('Debt', debt ? money(debt.balanceCents) : 'None', debt?.status === 'active' ? 'Games add here' : 'Games need an active signed debt'),
      figure('ATM', money(sub.atm.balanceCents), sub.atm.frozen ? 'Frozen' : `Loaded ${money(sub.atm.loadedCents)} in all`),
    ),
    locksPanel(sub),
    slotPanel(sub),
    atmPanel(sub),
  );
  watchLive();
}

function locksPanel(sub) {
  const locks = sub.standing?.locks || [];
  if (!locks.length) return null;
  return el('section', { class: 'panel locked', id: 'locks' },
    el('h2', null, 'Games are locked'),
    el('ul', { class: 'lock-list' }, ...locks.map((message) => el('li', null, message))),
    el('p', { class: 'muted' }, 'She sets these rules. They lift on their own once the payment is in the book. Sample checkouts never count.'),
    el('a', { class: 'btn secondary', href: '#/book' }, 'Pay or claim a payment'),
  );
}

function slotPanel(sub) {
  const game = sub.games.slot;
  if (!game) {
    return el('section', { class: 'panel', id: 'slot' }, el('h2', null, 'Slot machine'), el('p', { class: 'muted' }, 'She has not set up a slot machine for you.'));
  }
  if (game.status === 'proposed') {
    return el('section', { class: 'panel', id: 'slot' }, el('h2', null, 'Slot machine'), acceptPanel(game, slotTerms(game)));
  }
  const last = game.plays.at(-1);
  const cooling = game.nextPlayAt && Date.parse(game.nextPlayAt) > Date.now();
  let blocked = '';
  if (sub.debt?.status !== 'active') blocked = 'Games only add to an active signed debt, and none is running.';
  else if (game.locks?.length) blocked = game.locks[0];
  else if (game.pausedBySub) blocked = 'You paused this game.';
  else if (cooling) blocked = `Cooling down until ${clock(game.nextPlayAt)}.`;
  else if (game.leftTodayCents < game.odds.maxChargeCents) blocked = `Today's cap is reached. ${money(game.leftTodayCents)} is left, and a spin can cost ${money(game.odds.maxChargeCents)}.`;
  const pending = hasPendingPlay('slot');
  return el('section', { class: 'panel', id: 'slot' },
    el('h2', null, 'Slot machine'),
    el('p', { class: 'rigged' }, game.odds.rigged),
    el('div', { class: 'slot' },
      el('div', { class: 'reels', id: 'reels' }, ...[0, 1, 2].map((index) => reel(game, last, index))),
      el('p', { class: 'slot-result', id: 'slot-result', 'aria-live': 'polite' }, state.spin.busy
        ? 'Spinning…'
        : last ? `${last.label}. ${money(last.amountCents)} added to your debt.` : 'No spins yet.'),
      el('button', {
        class: 'btn spin',
        type: 'button',
        disabled: state.spin.busy || (Boolean(blocked) && !pending),
        onclick: spin,
      }, state.spin.busy ? 'Spinning…' : pending ? 'Finish the last spin' : `Spin · ${money(game.odds.stakeCents)} stake`),
      blocked && !state.spin.busy ? el('p', { class: 'muted' }, blocked) : null,
      el('p', { class: 'muted' }, `Today ${money(game.todayCents)} of ${money(game.limits.dailyCapCents)}. Average charge per spin ${averageText(game.odds.average)}.`),
      errorSlot('slot-play'),
    ),
    el('details', null, el('summary', null, 'Exact odds and terms'), slotTerms(game)),
    subLimitsForm(game, 'spin'),
    playList(game, false),
  );
}

function reel(game, play, index) {
  if (state.spin.busy && state.spin.stopped <= index) {
    const strip = [...game.terms.symbols, ...game.terms.symbols].map((symbol) => el('span', null, SYMBOLS[symbol.id]));
    return el('div', { class: `reel spinning r${index + 1}`, 'aria-hidden': 'true' }, el('div', { class: 'strip' }, ...strip));
  }
  const id = play?.reels?.[index] || game.terms.symbols[index % game.terms.symbols.length].id;
  return el('div', { class: state.spin.busy ? 'reel landed' : 'reel' },
    el('span', { class: 'symbol' }, SYMBOLS[id]),
    el('span', { class: 'name' }, id),
  );
}

async function spin() {
  if (state.spin.busy) return;
  const game = state.sub.games.slot;
  const id = pendingPlayId('slot');
  state.error = '';
  state.formError = null;
  state.spin = { busy: true, stopped: 0 };
  render();
  const started = Date.now();
  const fast = reducedMotion();
  try {
    const result = await api('/api/me/game/play', { method: 'POST', body: { game: 'slot', playId: id } });
    clearPendingPlay('slot');
    await wait(Math.max(0, (fast ? 0 : 1100) - (Date.now() - started)));
    for (let index = 0; index < 3; index += 1) {
      state.spin.stopped = index + 1;
      document.querySelectorAll('#reels .reel')[index]?.replaceWith(reel(game, result.play, index));
      await wait(fast ? 0 : 450);
    }
    state.sub = result.sub;
  } catch (error) {
    if (refused(error)) clearPendingPlay('slot');
    state.formError = { key: 'slot-play', message: error.message };
  }
  state.spin = { busy: false, stopped: 0 };
  render();
  if (state.formError) revealError();
}

function atmPanel(sub) {
  const atm = sub.atm;
  const game = sub.games.atm;
  let terms = el('p', { class: 'muted' }, 'She has not set the ATM terms yet. You can load it and set a card PIN now.');
  if (game?.status === 'proposed') terms = acceptPanel(game, atmTerms(game));
  else if (game) terms = el('details', null, el('summary', null, 'Exact odds and terms'), atmTerms(game));
  return el('section', { class: 'panel', id: 'atm' },
    el('h2', null, 'Human ATM'),
    el('p', { class: 'muted' }, 'You load it. She inserts your card, types your PIN, and withdraws, never past what is loaded or the caps. Every withdrawal adds to your signed debt.'),
    atmLive(sub),
    terms,
    el('div', { class: 'grid split' },
      el('div', null,
        form('atm-load', loadAtm,
          el('h3', null, 'Load or reload'),
          el('p', { class: 'muted' }, 'This is the most she can withdraw until you reload.'),
          field('Add', el('input', { name: 'amount', inputmode: 'decimal', required: true, placeholder: '50.00' })),
          el('button', { class: 'btn', type: 'submit' }, 'Load it'),
        ),
        form('atm-lower', lowerAtm,
          el('h3', null, 'Lower the balance'),
          el('p', { class: 'muted' }, 'Down to zero at most. What she already withdrew stays withdrawn.'),
          field('New balance', el('input', { name: 'amount', inputmode: 'decimal', required: true, value: dollars(atm.balanceCents) })),
          el('button', { class: 'btn secondary', type: 'submit' }, 'Lower it'),
        ),
      ),
      el('div', null,
        el('div', { class: 'row' },
          el('button', { class: atm.frozen ? 'btn' : 'btn danger', type: 'button', onclick: () => press('atm-freeze', () => freezeAtm(!atm.frozen)) },
            atm.frozen ? 'Unfreeze the ATM' : 'Freeze the ATM'),
        ),
        errorSlot('atm-freeze'),
        form('atm-pin', setAtmPin,
          el('h3', null, atm.pinSet ? 'Change the card PIN' : 'Set a card PIN'),
          el('p', { class: 'warning' }, 'Role-play only. Never use a real bank card PIN, or any PIN you use anywhere else.'),
          field('4-digit PIN', el('input', { name: 'pin', type: 'password', inputmode: 'numeric', pattern: '[0-9]{4}', minlength: 4, maxlength: 4, required: true, autocomplete: 'off' })),
          field('Confirm', el('span', { class: 'row' }, el('input', { name: 'notMine', type: 'checkbox', required: true }), 'This is not a real bank PIN.')),
          el('button', { class: 'btn secondary', type: 'submit' }, atm.pinSet ? 'Change PIN' : 'Set PIN'),
        ),
      ),
    ),
    game && game.status !== 'proposed' ? subLimitsForm(game, 'withdrawal') : null,
    game ? playList(game, true) : null,
  );
}

function atmStatus(atm, locks) {
  if (atm.frozen) return 'Frozen';
  if (locks.length) return 'Withdrawals locked';
  if (atm.lockedUntil) return `Card locked until ${clock(atm.lockedUntil)}`;
  if (!atm.pinSet) return 'No card PIN yet';
  return 'Ready';
}

function atmLive(sub) {
  const atm = sub.atm;
  const locks = sub.standing?.locks || [];
  return el('div', { class: 'atm', id: 'atm-live' },
    el('div', { class: 'atm-screen', id: 'atm-screen', 'aria-live': 'polite' },
      el('p', { class: 'kicker' }, atmStatus(atm, locks)),
      el('p', { class: 'atm-big' }, money(atm.balanceCents)),
      el('p', { class: 'muted' }, `Loaded ${money(atm.loadedCents)} · withdrawn ${money(atm.withdrawnCents)}`),
      locks.length && !atm.frozen ? el('p', { class: 'muted atm-lock' }, `She cannot withdraw until games unlock. ${locks[0]}`) : null,
    ),
    el('div', { class: 'atm-slots' },
      el('div', { class: 'card-slot', id: 'atm-card' }, el('span', { class: 'atm-card' })),
      el('div', { class: 'cash-slot', id: 'atm-cash' }),
    ),
    el('p', { class: 'muted live' }, 'Live. Checks for withdrawals every few seconds.'),
  );
}

function watchLive() {
  if (state.liveRunning) return;
  state.liveRunning = true;
  const tick = async () => {
    if (route() !== '/games' || state.role !== 'sub') {
      state.liveRunning = false;
      return;
    }
    try {
      const { sub } = await api('/api/me/live');
      const seen = new Set((state.sub?.games.atm?.plays || []).map((play) => play.id));
      const fresh = (sub.games.atm?.plays || []).filter((play) => !seen.has(play.id));
      const hadAtm = Boolean(state.sub?.games.atm);
      state.sub = sub;
      if (hadAtm && fresh.length) {
        state.replayQueue.push(...fresh);
        runReplays();
      } else if (JSON.stringify(sub) !== state.liveSig && canRefresh()) {
        render();
      }
    } catch { /* try again on the next tick */ }
    setTimeout(tick, 3000);
  };
  setTimeout(tick, 3000);
}

function canRefresh() {
  if (state.spin.busy || state.replaying) return false;
  return !document.activeElement?.matches('input, select, textarea');
}

async function runReplays() {
  if (state.replaying) return;
  while (state.replayQueue.length) {
    await replayWithdrawal(state.replayQueue.shift());
  }
  if (route() === '/games') render();
}

async function replayOnDemand(play) {
  if (state.replaying) return;
  document.getElementById('atm-live')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await replayWithdrawal(play);
  render();
}

/** Rebuilds a saved withdrawal on the sub's screen: card in, PIN typed digit by digit, cash out, balance ticking down. */
async function replayWithdrawal(play) {
  const screen = document.getElementById('atm-screen');
  const card = document.getElementById('atm-card');
  const cash = document.getElementById('atm-cash');
  if (!screen || !card || !cash) return;
  state.replaying = true;
  const fast = reducedMotion();
  const step = (ms) => wait(fast ? 0 : ms);
  const show = (...children) => screen.replaceChildren(...children);
  try {
    cash.classList.remove('dispensing');
    cash.replaceChildren();
    card.classList.add('in');
    show(el('p', { class: 'kicker' }, 'Card inserted'), el('p', { class: 'atm-big' }, 'Enter PIN'));
    await step(800);
    for (let attempt = 0; attempt <= (play.wrongTries || 0); attempt += 1) {
      const dots = [0, 1, 2, 3].map(() => el('span', { class: 'dot' }));
      show(el('p', { class: 'kicker' }, 'Enter PIN'), el('p', { class: 'dots' }, ...dots));
      for (const dot of dots) {
        await step(350);
        dot.classList.add('on');
      }
      await step(400);
      if (attempt < (play.wrongTries || 0)) {
        show(el('p', { class: 'kicker' }, 'Wrong PIN'), el('p', { class: 'atm-big wrong' }, 'Try again'));
        await step(900);
      }
    }
    show(el('p', { class: 'kicker' }, play.label), el('p', { class: 'atm-big' }, money(play.amountCents)));
    await step(800);
    const before = play.atmBalanceAfterCents + play.amountCents;
    const balance = el('p', { class: 'atm-big' }, money(before));
    show(el('p', { class: 'kicker' }, `Dispensing ${money(play.amountCents)}`), balance);
    cash.replaceChildren(...[1, 2, 3].map((n) => el('span', { class: `bill b${n}` })));
    cash.classList.add('dispensing');
    const ticks = fast ? 1 : 24;
    for (let tick = 1; tick <= ticks; tick += 1) {
      await step(50);
      balance.textContent = money(before - Math.round((play.amountCents * tick) / ticks));
    }
    await step(1000);
    card.classList.remove('in');
    show(
      el('p', { class: 'kicker' }, 'Take your card'),
      el('p', { class: 'atm-big' }, money(play.atmBalanceAfterCents)),
      el('p', { class: 'muted' }, `${clock(play.at)} · ${money(play.amountCents)} added to your debt`),
    );
    await step(1600);
  } finally {
    state.replaying = false;
  }
}

async function acceptTerms(game) {
  await refreshGames(await api('/api/me/game/accept', { method: 'POST', body: { game: game.key, version: game.version } }), 'Accepted. The terms are in the book.');
}

async function setGameLimits(key, body) {
  await refreshGames(await api('/api/me/game/limits', { method: 'POST', body: { game: key, ...body } }), 'Your limits are saved.');
}

async function saveGameCaps(event, key) {
  const data = Object.fromEntries(new FormData(event.target));
  await setGameLimits(key, {
    perPlayCapCents: data.perPlay.trim() ? dollarsToCents(data.perPlay) : null,
    dailyCapCents: data.daily.trim() ? dollarsToCents(data.daily) : null,
  });
}

async function loadAtm(event) {
  const addCents = dollarsToCents(new FormData(event.target).get('amount'));
  const next = await api('/api/me/atm/load', { method: 'POST', body: { addCents } });
  await refreshGames(next, `Loaded ${money(addCents)}. The ATM now holds ${money(next.sub.atm.balanceCents)}.`);
}

async function lowerAtm(event) {
  const balanceCents = dollarsToCents(new FormData(event.target).get('amount'));
  await refreshGames(await api('/api/me/atm/lower', { method: 'POST', body: { balanceCents } }), 'The ATM balance is lowered.');
}

async function freezeAtm(frozen) {
  await refreshGames(await api('/api/me/atm/freeze', { method: 'POST', body: { frozen } }), frozen ? 'The ATM is frozen.' : 'The ATM is open again.');
}

async function setAtmPin(event) {
  const data = Object.fromEntries(new FormData(event.target));
  if (!/^\d{4}$/.test(data.pin || '')) throw new Error('The card PIN is exactly 4 digits.');
  await refreshGames(await api('/api/me/atm/pin', { method: 'POST', body: { pin: data.pin, notMyBankPin: data.notMine === 'on' } }), 'Card PIN set. It is never shown again.');
}

async function refreshGames(next, notice) {
  state.sub = next.sub;
  state.notice = notice;
  render();
}

function studioGames(subId) {
  const sub = state.studio.subs.find((item) => item.id === subId);
  if (!sub) {
    shell('/studio', ...banner(), el('h1', null, 'Games'), el('p', { class: 'lede' }, 'That name is not in the book.'), el('a', { class: 'btn', href: '#/studio' }, 'Back to the studio'));
    return;
  }
  shell('/studio',
    ...banner(),
    el('p', { class: 'kicker' }, el('a', { href: '#/studio' }, 'Studio'), ` · ${sub.handle}`),
    el('h1', null, 'Games'),
    el('p', { class: 'lede' }, sub.debt?.status === 'active'
      ? `Debt ${money(sub.debt.balanceCents)}. Every result adds to it, and nothing a game does can lower it.`
      : 'Games play only against an active signed debt. Write one and have it signed first.'),
    standingPanel(sub),
    studioSlot(sub),
    studioAtm(sub),
  );
}

function standingPanel(sub) {
  const standing = sub.standing;
  const rules = standing.rules;
  const missed = standing.missed;
  const slotOnly = (sub.games.slot?.locks || []).filter((message) => !standing.locks.includes(message));
  return el('section', { class: 'panel', id: 'standing' },
    el('h2', null, 'Who can play'),
    el('p', { class: 'muted' }, 'These rules only lock games, so he does not have to accept them again. Only real money counts: Lightning that settled, payments you record, and claims you confirm. Sample checkouts never count.'),
    el('div', { class: 'grid cards' },
      figure('Paid for real', money(standing.provenPaidCents), rules.minPaidCents ? `Games need ${money(rules.minPaidCents)}` : 'No paid minimum'),
      figure('Unpaid game charges', money(standing.unpaidGameCents), rules.maxUnpaidGameCents ? `Games lock at ${money(rules.maxUnpaidGameCents)}` : 'No limit'),
    ),
    missed ? el('p', { class: 'warning' }, `He missed the ${money(missed.minimumCents)} minimum due ${prettyDay(missed.due)}, ${money(missed.shortCents)} short.`) : null,
    standing.locks.length
      ? el('div', { class: 'locked-now' }, el('p', { class: 'kicker' }, 'Locked now'), el('ul', { class: 'lock-list' }, ...standing.locks.map((message) => el('li', null, message))))
      : el('p', { class: 'notice' }, 'Games are open for this name.'),
    slotOnly.length ? el('p', { class: 'warning' }, `The slot is still locked, since one spin can cost more than the room left. ${slotOnly[0]}`) : null,
    form(`standing-${sub.id}`, (event) => saveStanding(event, sub.id),
      field('Hold', el('span', { class: 'row' }, el('input', { name: 'hold', type: 'checkbox', checked: rules.hold }), 'Hold all games for this name')),
      field('Missed minimum', el('span', { class: 'row' }, el('input', { name: 'lockWhenOverdue', type: 'checkbox', checked: rules.lockWhenOverdue }), 'Lock games when a minimum payment is missed')),
      el('div', { class: 'grid cards' },
        field('Paid before games unlock', el('input', { name: 'minPaid', inputmode: 'decimal', value: dollars(rules.minPaidCents), required: true })),
        field('Lock at unpaid game charges of', el('input', { name: 'maxUnpaid', inputmode: 'decimal', value: dollars(rules.maxUnpaidGameCents), required: true })),
      ),
      el('p', { class: 'muted' }, 'Use 0 to turn either amount off.'),
      el('button', { class: 'btn', type: 'submit' }, 'Save the rules'),
    ),
  );
}

async function saveStanding(event, subId) {
  const data = Object.fromEntries(new FormData(event.target));
  await api('/api/studio/standing', {
    method: 'POST',
    body: {
      subId,
      hold: data.hold === 'on',
      lockWhenOverdue: data.lockWhenOverdue === 'on',
      minPaidCents: dollarsToCents(data.minPaid || '0'),
      maxUnpaidGameCents: dollarsToCents(data.maxUnpaid || '0'),
    },
  });
  state.studio = await api('/api/studio');
  state.notice = 'Rules saved.';
  render();
}

function statusLine(game) {
  const own = [];
  if (game.subLimits.perPlayCapCents != null) own.push(`his own per-play cap ${money(game.subLimits.perPlayCapCents)}`);
  if (game.subLimits.dailyCapCents != null) own.push(`his own daily cap ${money(game.subLimits.dailyCapCents)}`);
  return el('p', null,
    el('span', { class: 'tag' }, GAME_STATUS[game.status]),
    ` Version ${game.version}${game.acceptedVersion ? `, he accepted version ${game.acceptedVersion}` : ''}. Today ${money(game.todayCents)} of ${money(game.limits.dailyCapCents)}.`,
    own.length ? ` He set ${own.join(' and ')}.` : '',
  );
}

function previewOf(key) {
  const odds = state.preview[key];
  if (!odds) return null;
  const game = { odds, limits: odds.limits, subLimits: {} };
  return el('div', { class: 'preview' }, el('h3', null, 'Preview, not saved'), key.startsWith('slot') ? slotTerms(game) : atmTerms(game));
}

function studioSlot(sub) {
  const game = sub.games.slot;
  const terms = game?.terms || state.studio.defaults.slot;
  return el('section', { class: 'panel', id: 'slot' },
    el('h2', null, 'Slot machine'),
    game ? statusLine(game) : el('p', { class: 'muted' }, 'Not set up yet. The form starts from the defaults.'),
    game ? el('details', null, el('summary', null, 'What he sees'), slotTerms(game)) : null,
    slotEditor(sub, terms, Boolean(game)),
    previewOf(`slot-${sub.id}`),
    game ? playList(game, false) : null,
  );
}

function option(value, label, selected) {
  return el('option', { value, selected: selected ? 'selected' : null }, label);
}

function slotEditor(sub, terms, exists) {
  const symbols = state.studio.defaults.symbols;
  const weightOf = (id) => terms.symbols.find((symbol) => symbol.id === id)?.weight;
  const rules = terms.payouts.filter((rule) => rule.match !== 'other');
  const other = terms.payouts.find((rule) => rule.match === 'other');
  const rows = [...rules, null, null].slice(0, 11);
  return form(`slot-edit-${sub.id}`, (event, restore) => saveTerms(event, sub.id, 'slot', slotTermsFrom, restore),
    el('h3', null, exists ? 'Change the terms' : 'Set it up'),
    el('p', { class: 'muted' }, 'Make the odds as unfair as you like. He sees them exactly, and any change waits for him to accept it again.'),
    el('p', { class: 'label' }, 'Reels: tick a symbol to use it, and give it a weight from 1 to 100.'),
    el('div', { class: 'symbols' }, ...symbols.map((id) => el('div', { class: 'symbol-pick' },
      el('label', { class: 'row' }, el('input', { type: 'checkbox', name: `on-${id}`, checked: weightOf(id) != null }), `${SYMBOLS[id]} ${id}`),
      el('input', { name: `w-${id}`, inputmode: 'numeric', value: weightOf(id) ?? 1, 'aria-label': `${id} weight`, class: 'small' }),
    ))),
    field('Stake', el('input', { name: 'stake', inputmode: 'decimal', value: dollars(terms.stakeCents), required: true })),
    el('p', { class: 'label' }, 'Payout table, read top to bottom. The first line that matches decides the charge.'),
    ...rows.map((rule, index) => el('div', { class: 'rule row', 'data-rule': index },
      el('select', { name: 'match', 'aria-label': 'Match' },
        option('', 'Unused', !rule),
        option('three', 'Three', rule?.match === 'three'),
        option('two', 'Exactly two', rule?.match === 'two'),
      ),
      el('select', { name: 'symbol', 'aria-label': 'Symbol' },
        option('', 'of any kind', !rule?.symbol),
        ...symbols.map((id) => option(id, `${id}s`, rule?.symbol === id)),
      ),
      el('input', { name: 'mult', inputmode: 'decimal', value: rule ? rule.multiplierPct / 100 : '', placeholder: '2', 'aria-label': 'Multiplier', class: 'small' }),
      el('span', { class: 'muted' }, 'x the stake'),
    )),
    el('div', { class: 'rule row' },
      el('span', null, 'Anything else'),
      el('input', { name: 'otherMult', inputmode: 'decimal', value: other.multiplierPct / 100, required: true, 'aria-label': 'Anything else multiplier', class: 'small' }),
      el('span', { class: 'muted' }, 'x the stake'),
    ),
    capsFields(terms, 'spin'),
    termsButtons(),
  );
}

function capsFields(terms, unit) {
  return el('div', { class: 'grid cards' },
    field(`Most per ${unit}`, el('input', { name: 'perPlay', inputmode: 'decimal', value: dollars(terms.perPlayCapCents), required: true })),
    field('Most per New York day', el('input', { name: 'daily', inputmode: 'decimal', value: dollars(terms.dailyCapCents), required: true })),
    field(`Seconds between ${unit}s`, el('input', { name: 'cooldown', inputmode: 'numeric', value: terms.cooldownSeconds, required: true })),
  );
}

function termsButtons() {
  return el('div', { class: 'row' },
    el('button', { class: 'btn', type: 'submit', name: 'intent', value: 'save' }, 'Propose these terms'),
    el('button', { class: 'btn secondary', type: 'submit', name: 'intent', value: 'preview' }, 'Preview the odds'),
  );
}

function multiplierPct(value) {
  const n = Number(String(value).trim().replace(/x$/i, ''));
  if (!Number.isFinite(n) || n <= 0) throw new Error('Use a multiplier like 2 or 1.5.');
  return Math.round(n * 100);
}

function wholeNumber(value, label) {
  if (!/^\d+$/.test(String(value).trim())) throw new Error(`${label} must be a whole number.`);
  return Number(value);
}

function capsFrom(node) {
  const get = (name) => node.querySelector(`[name="${name}"]`).value;
  return {
    perPlayCapCents: dollarsToCents(get('perPlay')),
    dailyCapCents: dollarsToCents(get('daily')),
    cooldownSeconds: wholeNumber(get('cooldown'), 'The cooldown'),
  };
}

function slotTermsFrom(node) {
  const get = (name) => node.querySelector(`[name="${name}"]`);
  const symbols = state.studio.defaults.symbols
    .filter((id) => get(`on-${id}`).checked)
    .map((id) => ({ id, weight: wholeNumber(get(`w-${id}`).value, `The ${id} weight`) }));
  const payouts = [...node.querySelectorAll('[data-rule]')]
    .filter((row) => row.querySelector('[name=match]').value)
    .map((row) => ({
      match: row.querySelector('[name=match]').value,
      symbol: row.querySelector('[name=symbol]').value || null,
      multiplierPct: multiplierPct(row.querySelector('[name=mult]').value),
    }));
  payouts.push({ match: 'other', symbol: null, multiplierPct: multiplierPct(get('otherMult').value) });
  return { symbols, stakeCents: dollarsToCents(get('stake').value), payouts, ...capsFrom(node) };
}

function atmTermsFrom(node) {
  const get = (name) => node.querySelector(`[name="${name}"]`).value;
  const kick = [...node.querySelectorAll('[data-kick]')]
    .filter((row) => row.querySelector('[name=kickAmount]').value.trim())
    .map((row) => ({
      amountCents: dollarsToCents(row.querySelector('[name=kickAmount]').value),
      weight: wholeNumber(row.querySelector('[name=kickWeight]').value, 'Each kick weight'),
    }));
  return {
    quickCents: dollarsToCents(get('quick')),
    skimMinCents: dollarsToCents(get('skimMin')),
    skimMaxCents: dollarsToCents(get('skimMax')),
    kick,
    ...capsFrom(node),
  };
}

async function saveTerms(event, subId, key, read, restore) {
  const terms = read(event.target);
  if (event.submitter?.value === 'preview') {
    const { odds } = await api('/api/studio/game/preview', { method: 'POST', body: { game: key, terms } });
    state.preview[`${key}-${subId}`] = { ...odds, limits: { perPlayCapCents: terms.perPlayCapCents, dailyCapCents: terms.dailyCapCents, cooldownSeconds: terms.cooldownSeconds } };
    render();
    restore();
    document.querySelector(`#${key} .preview`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  await api('/api/studio/game', { method: 'POST', body: { subId, game: key, terms } });
  delete state.preview[`${key}-${subId}`];
  state.studio = await api('/api/studio');
  state.notice = 'Proposed. He has to accept these terms before the next play.';
  render();
}

function studioAtm(sub) {
  const game = sub.games.atm;
  const atm = sub.atm;
  return el('section', { class: 'panel', id: 'atm' },
    el('h2', null, 'Human ATM'),
    el('p', null, `He loaded ${money(atm.loadedCents)} in all. ${money(atm.withdrawnCents)} withdrawn, ${money(atm.balanceCents)} left.${atm.frozen ? ' He froze it.' : ''}${atm.pinSet ? '' : ' He has not set a card PIN.'}`),
    game ? statusLine(game) : el('p', { class: 'muted' }, 'Set the terms below before the card will work.'),
    atmMachine(sub),
    game ? el('details', null, el('summary', null, 'What he sees'), atmTerms(game)) : null,
    atmEditor(sub, game?.terms || state.studio.defaults.atm, Boolean(game)),
    previewOf(`atm-${sub.id}`),
    game ? playList(game, false) : null,
  );
}

function atmEditor(sub, terms, exists) {
  const rows = [...terms.kick, null, null].slice(0, 6);
  return form(`atm-edit-${sub.id}`, (event, restore) => saveTerms(event, sub.id, 'atm', atmTermsFrom, restore),
    el('h3', null, exists ? 'Change the terms' : 'Set the terms'),
    el('p', { class: 'muted' }, 'Any change waits for him to accept it again. Every option must fit under the per-withdrawal cap.'),
    el('div', { class: 'grid cards' },
      field('Fast cash amount', el('input', { name: 'quick', inputmode: 'decimal', value: dollars(terms.quickCents), required: true })),
      field('Surprise skim from', el('input', { name: 'skimMin', inputmode: 'decimal', value: dollars(terms.skimMinCents), required: true })),
      field('Surprise skim up to', el('input', { name: 'skimMax', inputmode: 'decimal', value: dollars(terms.skimMaxCents), required: true })),
    ),
    el('p', { class: 'label' }, 'Kick it for a bonus: each amount and its weight. Blank rows are ignored.'),
    ...rows.map((item, index) => el('div', { class: 'rule row', 'data-kick': index },
      el('input', { name: 'kickAmount', inputmode: 'decimal', value: item ? dollars(item.amountCents) : '', placeholder: 'Amount', 'aria-label': 'Kick amount', class: 'small' }),
      el('span', { class: 'muted' }, 'weight'),
      el('input', { name: 'kickWeight', inputmode: 'numeric', value: item ? item.weight : '1', 'aria-label': 'Kick weight', class: 'small' }),
    )),
    capsFields(terms, 'withdrawal'),
    termsButtons(),
  );
}

function atmUi(subId) {
  state.atm[subId] ||= { phase: 'idle', digits: '', cardToken: null, result: null, busy: false };
  return state.atm[subId];
}

function atmMachine(sub) {
  const ui = atmUi(sub.id);
  const atm = sub.atm;
  const game = sub.games.atm;
  const key = `atm-${sub.id}`;
  if (atm.frozen || atm.lockedUntil) Object.assign(ui, { phase: 'idle', digits: '', cardToken: null });
  let screen;
  let controls;
  if (atm.frozen) {
    screen = [el('p', { class: 'kicker' }, 'Out of service'), el('p', { class: 'atm-big' }, 'Frozen'), el('p', { class: 'muted' }, 'He froze the ATM.')];
  } else if (atm.lockedUntil) {
    screen = [el('p', { class: 'kicker' }, 'Card locked'), el('p', { class: 'atm-big wrong' }, 'Locked'), el('p', { class: 'muted' }, `Three wrong PINs. Try again after ${clock(atm.lockedUntil)}.`)];
  } else if (ui.phase === 'pin') {
    screen = [el('p', { class: 'kicker' }, 'Enter PIN'), el('p', { class: 'dots' }, ...[0, 1, 2, 3].map((n) => el('span', { class: n < ui.digits.length ? 'dot on' : 'dot' }))), el('p', { class: 'muted' }, `${atm.pinTriesLeft} ${atm.pinTriesLeft === 1 ? 'try' : 'tries'} before the card locks`)];
    controls = keypad(sub);
  } else if (ui.phase === 'menu') {
    screen = [el('p', { class: 'kicker' }, 'Available'), el('p', { class: 'atm-big' }, money(atm.balanceCents)), el('p', { class: 'muted' }, game ? `Today ${money(game.leftTodayCents)} left of ${money(game.limits.dailyCapCents)}` : 'No terms yet')];
    controls = atmMenu(sub);
  } else if (ui.phase === 'cash' && ui.result) {
    screen = [el('p', { class: 'kicker' }, ui.result.label), el('p', { class: 'atm-big' }, money(ui.result.amountCents)), el('p', { class: 'muted' }, `Left in the ATM ${money(ui.result.atmBalanceAfterCents)}. Debt now ${money(ui.result.balanceAfterCents)}.`)];
    controls = el('div', { class: 'row' },
      el('button', { class: 'btn', type: 'button', onclick: () => { ui.phase = 'menu'; render(); } }, 'Another withdrawal'),
      el('button', { class: 'btn secondary', type: 'button', onclick: () => press(key, () => ejectCard(sub.id)) }, 'Eject card'),
    );
  } else {
    const locked = sub.standing.locks.length > 0;
    screen = locked
      ? [el('p', { class: 'kicker' }, 'Withdrawals locked'), el('p', { class: 'atm-big wrong' }, 'Locked'), el('p', { class: 'muted' }, sub.standing.locks[0])]
      : [el('p', { class: 'kicker' }, atm.pinSet ? 'Welcome' : 'No card PIN yet'), el('p', { class: 'atm-big' }, 'Insert card'), el('p', { class: 'muted' }, `${sub.handle}'s machine`)];
    controls = el('button', {
      class: 'btn',
      type: 'button',
      disabled: !atm.pinSet || locked,
      onclick: () => {
        state.formError = null;
        Object.assign(ui, { phase: 'pin', digits: '' });
        render();
      },
    }, 'Insert card');
  }
  return el('div', { class: 'atm studio-atm' },
    el('div', { class: 'atm-screen', 'aria-live': 'polite' }, ...screen),
    el('div', { class: 'atm-slots' },
      el('div', { class: ui.phase === 'idle' ? 'card-slot' : 'card-slot in' }, el('span', { class: 'atm-card' })),
      el('div', { class: ui.phase === 'cash' ? 'cash-slot dispensing' : 'cash-slot' },
        ...(ui.phase === 'cash' ? [1, 2, 3].map((n) => el('span', { class: `bill b${n}` })) : [])),
    ),
    controls,
    errorSlot(key),
  );
}

function keypad(sub) {
  const ui = atmUi(sub.id);
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'enter'];
  return el('div', { class: 'keypad' }, ...keys.map((key) => el('button', {
    class: key.length > 1 ? `key ${key}` : 'key',
    type: 'button',
    disabled: ui.busy,
    onclick: () => keyPress(sub.id, key),
  }, key === 'clear' ? 'Clear' : key === 'enter' ? 'Enter' : key)),
  el('button', { class: 'key cancel', type: 'button', onclick: () => { Object.assign(ui, { phase: 'idle', digits: '' }); render(); } }, 'Cancel'));
}

function keyPress(subId, key) {
  const ui = atmUi(subId);
  state.formError = null;
  if (key === 'enter') {
    press(`atm-${subId}`, () => enterPin(subId));
    return;
  }
  if (key === 'clear') ui.digits = '';
  else if (ui.digits.length < 4) ui.digits += key;
  render();
}

async function enterPin(subId) {
  const ui = atmUi(subId);
  const pin = ui.digits;
  ui.digits = '';
  if (pin.length !== 4) throw new Error('Type all 4 digits.');
  ui.busy = true;
  try {
    const result = await api('/api/studio/atm/pin', { method: 'POST', body: { subId, pin } });
    Object.assign(ui, { cardToken: result.cardToken, phase: 'menu' });
  } finally {
    ui.busy = false;
    state.studio = await api('/api/studio');
    render();
  }
}

function atmMenu(sub) {
  const game = sub.games.atm;
  const key = `atm-${sub.id}`;
  if (!game) return el('p', { class: 'muted' }, 'Set the ATM terms first.');
  const odds = game.odds;
  return el('div', { class: 'atm-menu' },
    form(`atm-amount-${sub.id}`, (event) => withdraw(sub.id, 'amount', dollarsToCents(new FormData(event.target).get('amount'))),
      field(`Amount, up to ${money(Math.min(game.limits.perPlayCapCents, sub.atm.balanceCents))}`, el('input', { name: 'amount', inputmode: 'decimal', required: true, placeholder: '20.00' })),
      el('button', { class: 'btn', type: 'submit' }, 'Withdraw'),
    ),
    el('div', { class: 'row' },
      el('button', { class: 'btn secondary', type: 'button', onclick: () => press(key, () => withdraw(sub.id, 'quick')) }, `Fast cash ${money(odds.quick.amountCents)}`),
      el('button', { class: 'btn secondary', type: 'button', onclick: () => press(key, () => withdraw(sub.id, 'skim')) }, `Surprise skim ${money(odds.skim.minCents)}–${money(odds.skim.maxCents)}`),
      el('button', { class: 'btn secondary', type: 'button', onclick: () => press(key, () => withdraw(sub.id, 'kick')) }, 'Kick it for a bonus'),
      el('button', { class: 'btn danger', type: 'button', onclick: () => press(key, () => ejectCard(sub.id)) }, 'Eject card'),
    ),
  );
}

async function withdraw(subId, option, amountCents) {
  const ui = atmUi(subId);
  if (ui.busy) return;
  ui.busy = true;
  const id = pendingPlayId(`atm-${subId}`);
  try {
    const result = await api('/api/studio/atm/withdraw', { method: 'POST', body: { subId, cardToken: ui.cardToken, playId: id, option, amountCents } });
    clearPendingPlay(`atm-${subId}`);
    Object.assign(ui, { result: result.play, phase: 'cash' });
  } catch (error) {
    if (refused(error)) clearPendingPlay(`atm-${subId}`);
    if (/Insert the card/.test(error.message)) Object.assign(ui, { phase: 'idle', cardToken: null });
    throw error;
  } finally {
    ui.busy = false;
    state.studio = await api('/api/studio');
    render();
  }
}

async function ejectCard(subId) {
  await api('/api/studio/atm/eject', { method: 'POST', body: { subId } });
  Object.assign(atmUi(subId), { phase: 'idle', digits: '', cardToken: null, result: null });
  state.studio = await api('/api/studio');
  render();
}

function gate() {
  document.getElementById('app').replaceChildren(el('div', { class: 'gate' },
    el('section', { class: 'panel' },
      el('div', { class: 'mark', 'aria-hidden': 'true' }, el('span')),
      el('p', { class: 'kicker' }, 'Adults only'),
      el('h1', null, 'Bijoux Debt'),
      el('p', { class: 'lede' }, 'This is the private book Dominatrix Bijoux keeps for signed debts and tributes. It is for adults.'),
      el('div', { class: 'row' },
        el('button', {
          class: 'btn',
          type: 'button',
          onclick: () => {
            state.adult = true;
            try { localStorage.setItem('bijouxdebt-adult', 'yes'); } catch { /* session only */ }
            render();
          },
        }, 'I am 18 or older'),
        el('a', { class: 'btn secondary', href: 'https://www.google.com/' }, 'Leave'),
      ),
    ),
  ));
}

function render() {
  if (!state.adult) {
    gate();
    return;
  }
  const path = route();
  if (path.startsWith('/join')) join();
  else if (path.startsWith('/book')) book();
  else if (path.startsWith('/games')) games();
  else if (path.startsWith('/studio')) studio();
  else home();
}

async function boot() {
  try {
    const [pub, session] = await Promise.all([api('/api/public'), api('/api/session')]);
    state.pub = pub;
    state.role = session.role;
    state.sub = session.sub || null;
    if (session.role === 'studio') state.studio = await api('/api/studio');
  } catch (error) {
    state.error = error.message;
  }
  render();
}

window.addEventListener('hashchange', () => {
  state.formError = null;
  state.formNotice = null;
  render();
  window.scrollTo(0, 0);
});
boot();
