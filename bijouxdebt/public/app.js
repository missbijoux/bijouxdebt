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
};

const state = {
  adult: false,
  role: null,
  sub: null,
  pub: null,
  studio: null,
  invoice: null,
  error: '',
  notice: '',
  poll: 0,
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
  if (!response.ok) throw new Error(data.error || 'The book could not do that.');
  return data;
}

function field(label, control) {
  return el('label', null, el('span', null, label), control);
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
    el('h2', { style: 'margin-top:36px' }, 'Tiers'),
    el('div', { class: 'grid cards' }, ...(pub?.tiers || []).map(tierCard)),
    el('h2', { id: 'hall', style: 'margin-top:36px' }, 'Hall'),
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
    consumePending();
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
      el('form', { class: 'panel', onsubmit: (event) => submit(event, createName) },
        field('Name', el('input', { name: 'handle', required: true, minlength: 3, maxlength: 20, autocomplete: 'username', pattern: '[A-Za-z0-9_]{3,20}' })),
        field('Title', el('select', { name: 'title' }, ...(state.pub?.titles || ['sub']).map((title) => el('option', { value: title }, title)))),
        field('Passphrase', el('input', { name: 'passphrase', type: 'password', required: true, minlength: 8, maxlength: 72, autocomplete: 'new-password' })),
        field('Age', el('span', { class: 'row' }, el('input', { name: 'adult', type: 'checkbox', required: true }), 'I am 18 or older.')),
        el('button', { class: 'btn', type: 'submit' }, 'Open my book'),
      ),
      el('form', { class: 'panel', onsubmit: (event) => submit(event, enterName) },
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
      figure('Waiting', money(sub.askCents), `Purse left ${money(Math.max(sub.purseCapCents - sub.purseDrawnCents, 0))}`),
    ),
    debtPanel(debt),
    invoicePanel(),
    el('div', { class: 'grid split' },
      el('section', { class: 'panel' },
        el('h2', null, 'Pay or claim'),
        payForm('Pay the debt', 'debt', Boolean(debt && debt.status === 'active')),
        payForm('Send tribute', 'tribute', true),
        el('form', { onsubmit: (event) => submit(event, claimPayment) },
          el('h3', null, 'Claim a payment made elsewhere'),
          field('Amount', el('input', { name: 'amount', inputmode: 'decimal', required: true, placeholder: '0.00' })),
          field('Toward', el('select', { name: 'purpose' }, el('option', { value: 'debt' }, 'Debt'), el('option', { value: 'tribute' }, 'Tribute'))),
          field('Note', el('input', { name: 'note', maxlength: 140, placeholder: 'Cash App, throne, cash' })),
          el('button', { class: 'btn secondary', type: 'submit' }, 'Submit the claim'),
        ),
      ),
      el('section', { class: 'panel' },
        el('h2', null, 'Your side of the book'),
        el('form', { onsubmit: (event) => submit(event, selfCharge) },
          el('h3', null, 'Add to the debt'),
          field('Amount', el('input', { name: 'amount', inputmode: 'decimal', required: true })),
          field('What you are adding', el('input', { name: 'note', required: true, maxlength: 140 })),
          el('button', { class: 'btn secondary', type: 'submit' }, 'Add it'),
        ),
        el('form', { onsubmit: (event) => submit(event, setPurse) },
          el('h3', null, 'Purse ceiling'),
          el('p', { class: 'muted' }, 'She can draw up to this amount and no further. Lowering it cannot erase a draw she already took.'),
          field('Ceiling', el('input', { name: 'amount', inputmode: 'decimal', required: true, value: (sub.purseCapCents / 100).toFixed(2) })),
          el('button', { class: 'btn secondary', type: 'submit' }, 'Set the ceiling'),
        ),
        el('form', { onsubmit: (event) => submit(event, toggleHall) },
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
  return el('form', { onsubmit: (event) => submit(event, (formEvent) => checkoutAmount(formEvent, purpose)) },
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
      el('span', null, `${prettyDay(entry.nyDay)} · ${KIND[entry.kind] || entry.kind} · ${entry.note || ''}${entry.status === 'confirmed' ? '' : ` · ${entry.status}`}`),
      el('strong', null, money(entry.amountCents)),
    ))) : el('p', { class: 'muted' }, 'No lines yet.'),
  );
}

function studio() {
  if (state.role !== 'studio') {
    shell('/studio',
      ...banner(),
      el('p', { class: 'kicker' }, 'Private'),
      el('h1', null, 'Studio'),
      el('form', { class: 'panel', onsubmit: (event) => submit(event, studioLogin) },
        field('Studio pin', el('input', { name: 'pin', type: 'password', required: true, autocomplete: 'current-password' })),
        el('button', { class: 'btn', type: 'submit' }, 'Unlock'),
      ),
    );
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
  return el('form', { class: 'panel', onsubmit: (event) => submit(event, saveTiers) },
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
    el('p', { class: 'muted' }, `Ask ${money(sub.askCents)}. Purse ${money(sub.purseDrawnCents)} of ${money(sub.purseCapCents)}. This month ${money(sub.monthCents)}.`),
    el('form', { onsubmit: (event) => submit(event, (formEvent) => proposeDebt(formEvent, sub.id)) },
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
    el('form', { onsubmit: (event) => submit(event, (formEvent) => studioMoney(formEvent, '/api/studio/charge', sub.id)) },
      el('h3', null, 'Add a charge'),
      field('Amount', el('input', { name: 'amount', required: true })),
      field('Note', el('input', { name: 'note', maxlength: 140 })),
      el('button', { class: 'btn secondary', type: 'submit' }, 'Charge'),
    ),
    el('form', { onsubmit: (event) => submit(event, (formEvent) => recordPayment(formEvent, sub.id)) },
      el('h3', null, 'Record a payment you already received'),
      field('Amount', el('input', { name: 'amount', required: true })),
      field('Toward', el('select', { name: 'purpose' }, el('option', { value: 'debt' }, 'Debt'), el('option', { value: 'tribute' }, 'Tribute'))),
      field('Note', el('input', { name: 'note', maxlength: 140 })),
      el('button', { class: 'btn secondary', type: 'submit' }, 'Record it'),
    ),
    el('form', { onsubmit: (event) => submit(event, (formEvent) => studioMoney(formEvent, '/api/studio/purse-draw', sub.id)) },
      el('h3', null, 'Draw the purse'),
      field('Amount', el('input', { name: 'amount', required: true })),
      field('Note', el('input', { name: 'note', maxlength: 140 })),
      el('button', { class: 'btn secondary', type: 'submit' }, 'Draw'),
    ),
    el('form', { onsubmit: (event) => submit(event, (formEvent) => createTask(formEvent, sub.id)) },
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
  return el('div', null, el('h3', null, 'Claims'), ...pending.map((entry) => el('div', { class: 'row' },
    el('span', null, `${money(entry.amountCents)} ${entry.purpose} · ${entry.note}`),
    el('button', { class: 'btn', type: 'button', onclick: () => decideClaim(entry.id, 'confirm') }, 'Confirm'),
    el('button', { class: 'btn danger', type: 'button', onclick: () => decideClaim(entry.id, 'reject') }, 'Reject'),
  )));
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
  const button = event.submitter;
  if (button) button.disabled = true;
  try {
    await action(event);
  } catch (error) {
    state.error = error.message;
    render();
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

async function claimPayment(event) {
  const data = Object.fromEntries(new FormData(event.target));
  await refreshSub(await api('/api/me/claim', {
    method: 'POST',
    body: { amountCents: dollarsToCents(data.amount), purpose: data.purpose, note: data.note },
  }));
}

async function selfCharge(event) {
  const data = Object.fromEntries(new FormData(event.target));
  await refreshSub(await api('/api/me/self-charge', {
    method: 'POST',
    body: { amountCents: dollarsToCents(data.amount), note: data.note },
  }));
}

async function setPurse(event) {
  const data = Object.fromEntries(new FormData(event.target));
  await refreshSub(await api('/api/me/purse', { method: 'POST', body: { capCents: dollarsToCents(data.amount) } }));
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

window.addEventListener('hashchange', render);
boot();
