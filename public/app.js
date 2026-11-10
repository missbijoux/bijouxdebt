const base = (document.querySelector('meta[name="ot-base"]')?.content || '').replace(/\/$/, '');
const app = document.getElementById('app');
const toasts = document.getElementById('toasts');

const state = {
  path: location.pathname.slice(base.length) || '/',
  public: null,
  session: null,
  busy: false,
  draft: {},
  tipInfo: null,
  topupInfo: null,
  invoice: null,
  qr: null,
};

function money(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(cents || 0));
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}

function routePath() {
  return location.pathname.slice(base.length) || '/';
}

function go(path) {
  history.pushState({}, '', `${base}${path}`);
  state.path = path;
  render();
}

async function api(path, options = {}) {
  const res = await fetch(`${base}${path}`, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
    body: options.body != null ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

function toast(message) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  toasts.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function disclaimerBox(text) {
  return `<aside class="disclaimer" role="note">
    <strong>Ledger + payment rail — not payroll</strong>
    <p>${escapeHtml(text)}</p>
  </aside>`;
}

function shell(nav, body) {
  return `
    <header class="top">
      <a class="brand" href="${base}/">
        <span class="brand-mark" aria-hidden="true">Ω</span>
        <span class="brand-text">Ohm Tracker</span>
      </a>
      <nav>${nav}</nav>
    </header>
    <main class="wrap">${body}</main>
  `;
}

function navLink(href, label) {
  const current = state.path === href || state.path.startsWith(`${href}/`);
  return `<a href="${base}${href}" data-link ${current ? 'aria-current="page"' : ''}>${label}</a>`;
}

function formVal(name, fallback = '') {
  return escapeHtml(state.draft[name] ?? fallback);
}

async function refreshSession() {
  state.session = await api('/api/session');
}

async function refreshPublic() {
  state.public = await api('/api/public');
}

function landing() {
  const p = state.public;
  return shell(
    `${navLink('/account', 'Customer')}${navLink('/dancer', 'Dancer')}${navLink('/manager', 'Manager')}`,
    `
    <section class="hero">
      <div>
        <p class="kicker">Ohm</p>
        <h1>Ohm Tracker</h1>
        <p class="lede">For club owners who hire dancers and host customers. Top up credits, tip by QR, and keep the house books on one Ohm rail.</p>
        <div class="hero-actions">
          <a class="btn" href="${base}/u/${escapeHtml(p.topUpCode)}" data-link>Customer top-up</a>
          <a class="btn secondary" href="${base}/manager" data-link>Manager console</a>
        </div>
      </div>
    </section>
    ${disclaimerBox(p.disclaimer)}
    <section class="grid cards">
      <article class="panel">
        <p class="badge">Floor</p>
        <h3>Scan to fund</h3>
        <p class="muted small">Customers open the club top-up code, pay on Ohm, and hold credits on their phone.</p>
      </article>
      <article class="panel">
        <p class="badge">Tip</p>
        <h3>Scan a dancer</h3>
        <p class="muted small">Tip QR moves credits from the customer to the dancer, with the house cut you set.</p>
      </article>
      <article class="panel">
        <p class="badge">Books</p>
        <h3>Manager ledger</h3>
        <p class="muted small">Track inflow, tips, house take, and dancer payouts without treating this as payroll software.</p>
      </article>
    </section>
    `,
  );
}

function customerView() {
  const session = state.session;
  const tipMatch = state.path.match(/^\/tip\/([a-z0-9]+)$/i);
  const topMatch = state.path.match(/^\/u\/([a-z0-9]+)$/i);

  if (session?.role !== 'customer') {
    return shell(
      `${navLink('/', 'Home')}${navLink('/manager', 'Manager')}`,
      `
      <p class="kicker">Customer</p>
      <h1>Your Ohm account</h1>
      <p class="lede">Create a handle to hold club credits, top up, and tip dancers.</p>
      ${disclaimerBox(state.public.disclaimer)}
      <div class="grid split">
        <form class="panel stack" data-action="customer-join">
          <h2>Join</h2>
          <label>Handle<input name="handle" required minlength="3" maxlength="20" value="${formVal('handle')}" /></label>
          <label>Passphrase<input name="passphrase" type="password" required minlength="8" /></label>
          <label class="small"><input type="checkbox" name="adult" value="1" required /> I am 18 or older</label>
          <button class="btn" type="submit">Create account</button>
        </form>
        <form class="panel stack" data-action="customer-login">
          <h2>Sign in</h2>
          <label>Handle<input name="handle" required minlength="3" maxlength="20" /></label>
          <label>Passphrase<input name="passphrase" type="password" required minlength="8" /></label>
          <button class="btn secondary" type="submit">Sign in</button>
        </form>
      </div>
      `,
    );
  }

  const customer = session.customer;
  let focus = '';
  if (topMatch || state.path === '/account') {
    const packs = (state.topupInfo?.packages || state.public.packages || [])
      .map(
        (pack) => `<button class="btn secondary" type="button" data-action="buy-pack" data-id="${escapeHtml(pack.id)}">
          ${escapeHtml(pack.name)} · ${money(pack.amountCents)}
        </button>`,
      )
      .join('');
    focus = `
      <section class="panel stack">
        <h2>Top up credits</h2>
        <p class="muted small">${escapeHtml(state.topupInfo?.clubName || state.public.clubName)} · checkout ${escapeHtml(state.public.checkout)}</p>
        <div class="row">${packs}</div>
        <form class="row" data-action="custom-topup">
          <label>Custom amount (cents)<input name="amountCents" type="number" min="100" max="200000" step="100" required /></label>
          <button class="btn" type="submit">Create invoice</button>
        </form>
        ${
          state.invoice
            ? `<div class="stack">
                <p><strong>${money(state.invoice.amountCents)}</strong> · ${escapeHtml(state.invoice.mode)}
                ${state.invoice.sample ? ' (sample — no real money)' : ''}</p>
                <img class="qr" alt="Lightning invoice QR" src="${state.invoice.qrDataUrl}" />
                <p class="small mono muted">${escapeHtml(state.invoice.bolt11)}</p>
                <button class="btn" type="button" data-action="settle-invoice" data-id="${escapeHtml(state.invoice.id)}">
                  ${state.invoice.mode === 'sandbox' ? 'Mark sample paid' : 'Check payment'}
                </button>
              </div>`
            : ''
        }
      </section>
    `;
  }
  if (tipMatch && state.tipInfo) {
    focus = `
      <section class="panel stack">
        <h2>Tip ${escapeHtml(state.tipInfo.dancer.displayName)}</h2>
        <p class="muted small">House cut on tips: ${state.tipInfo.houseCutPercent}%</p>
        <form class="stack" data-action="send-tip" data-code="${escapeHtml(state.tipInfo.dancer.tipCode)}">
          <label>Amount (cents)<input name="amountCents" type="number" min="1" max="200000" required /></label>
          <label>Note<input name="note" maxlength="140" placeholder="Optional" /></label>
          <button class="btn" type="submit">Send tip from credits</button>
        </form>
      </section>
    `;
  }

  const feed = (session.ledger || [])
    .map(
      (entry) => `<li>
        <strong>${escapeHtml(entry.kind)}</strong> · ${money(entry.amountCents)}
        <span class="muted small">${escapeHtml(entry.note || '')}</span>
      </li>`,
    )
    .join('');

  return shell(
    `${navLink('/', 'Home')}<a href="#" data-action="logout">Sign out</a>`,
    `
    <p class="kicker">Customer</p>
    <h1>@${escapeHtml(customer.handle)}</h1>
    <p class="lede">Credits on hand: <strong class="mono">${money(customer.creditCents)}</strong></p>
    ${disclaimerBox(state.public.disclaimer)}
    <div class="grid split">
      <div class="stack">
        ${focus || `<p class="muted">Open a club top-up code or dancer tip code to move money.</p>`}
        <section class="panel">
          <h2>Quick links</h2>
          <div class="hero-actions">
            <a class="btn secondary" href="${base}/u/${escapeHtml(state.public.topUpCode)}" data-link>Club top-up</a>
          </div>
        </section>
      </div>
      <section class="panel">
        <h2>Activity</h2>
        <ul class="feed">${feed || '<li class="muted">No entries yet.</li>'}</ul>
      </section>
    </div>
    `,
  );
}

function dancerView() {
  const session = state.session;
  if (session?.role !== 'dancer') {
    return shell(
      `${navLink('/', 'Home')}`,
      `
      <p class="kicker">Dancer</p>
      <h1>Dancer sign-in</h1>
      <p class="lede">Managers create your handle. Sign in to show your tip QR and earnings.</p>
      ${disclaimerBox(state.public.disclaimer)}
      <form class="panel stack" data-action="dancer-login" style="max-width:420px">
        <label>Handle<input name="handle" required minlength="3" maxlength="20" /></label>
        <label>Passphrase<input name="passphrase" type="password" required minlength="8" /></label>
        <button class="btn" type="submit">Sign in</button>
      </form>
      `,
    );
  }
  const d = session.dancer;
  const feed = (session.ledger || [])
    .map(
      (entry) => `<li>
        <strong>${escapeHtml(entry.kind)}</strong> · ${money(entry.amountCents)}
        <span class="muted small">${escapeHtml(entry.note || '')}</span>
      </li>`,
    )
    .join('');
  return shell(
    `${navLink('/', 'Home')}<a href="#" data-action="logout">Sign out</a>`,
    `
    <p class="kicker">Dancer</p>
    <h1>${escapeHtml(d.displayName)}</h1>
    <p class="lede">Unpaid: <strong class="mono">${money(d.unpaidCents)}</strong> · Earned ${money(d.earnedCents)} · Paid out ${money(d.paidOutCents)}</p>
    ${disclaimerBox(state.public.disclaimer)}
    <div class="grid split">
      <section class="panel stack">
        <h2>Tip QR</h2>
        <p class="muted small">Customers scan this to tip you from their Ohm credits.</p>
        <button class="btn" type="button" data-action="load-tip-qr" data-code="${escapeHtml(d.tipCode)}">Show tip QR</button>
        ${
          state.qr
            ? `<img class="qr" alt="Tip QR" src="${state.qr.qrDataUrl}" /><p class="small mono">${escapeHtml(state.qr.url)}</p>`
            : ''
        }
      </section>
      <section class="panel">
        <h2>Tips & payouts</h2>
        <ul class="feed">${feed || '<li class="muted">No entries yet.</li>'}</ul>
      </section>
    </div>
    `,
  );
}

function managerView() {
  const session = state.session;
  if (session?.role !== 'manager') {
    return shell(
      `${navLink('/', 'Home')}`,
      `
      <p class="kicker">Manager</p>
      <h1>Club console</h1>
      <p class="lede">Roster, house cut, top-up QR, and the night’s ledger.</p>
      ${disclaimerBox(state.public.disclaimer)}
      <form class="panel stack" data-action="manager-login" style="max-width:420px">
        <label>Manager pin<input name="pin" type="password" required minlength="4" /></label>
        <button class="btn" type="submit">Unlock</button>
      </form>
      `,
    );
  }

  const s = session.summary;
  const dancers = (session.dancers || [])
    .map(
      (d) => `<li>
        <strong>${escapeHtml(d.displayName)}</strong> (@${escapeHtml(d.handle)})
        · unpaid ${money(d.unpaidCents)}
        · tip <span class="mono">${escapeHtml(d.tipCode)}</span>
        ${d.active ? '' : ' · inactive'}
        <div class="hero-actions" style="margin-top:8px">
          <button class="btn secondary" type="button" data-action="mgr-tip-qr" data-code="${escapeHtml(d.tipCode)}">QR</button>
          <button class="btn secondary" type="button" data-action="mgr-payout" data-id="${escapeHtml(d.id)}" data-unpaid="${d.unpaidCents}">Pay out</button>
        </div>
      </li>`,
    )
    .join('');
  const customers = (session.customers || [])
    .map(
      (c) => `<li>
        <strong>@${escapeHtml(c.handle)}</strong> · ${money(c.creditCents)}
        <button class="btn ghost" type="button" data-action="mgr-credit" data-id="${escapeHtml(c.id)}">Add credit</button>
      </li>`,
    )
    .join('');
  const feed = (session.ledger || [])
    .map(
      (entry) => `<li>
        <strong>${escapeHtml(entry.kind)}</strong> · ${money(entry.amountCents)}
        <span class="muted small">${escapeHtml(entry.note || entry.handle || entry.displayName || '')}</span>
      </li>`,
    )
    .join('');

  return shell(
    `${navLink('/', 'Home')}<a href="#" data-action="logout">Sign out</a>`,
    `
    <p class="kicker">Manager · ${escapeHtml(session.clubName)}</p>
    <h1>Club ledger</h1>
    <p class="lede">Credits in, tips out, house take, dancer payouts — tracked here. Ohm settles Lightning; you remain merchant of record.</p>
    ${disclaimerBox(session.disclaimer || state.public.disclaimer)}
    <section class="grid cards">
      <article class="panel"><p class="badge">Top-ups</p><p class="stat mono">${money(s.topUpCents)}</p></article>
      <article class="panel"><p class="badge">Tips</p><p class="stat mono">${money(s.tipCents)}</p></article>
      <article class="panel"><p class="badge">House</p><p class="stat mono">${money(s.houseCents)}</p></article>
      <article class="panel"><p class="badge">Unpaid dancers</p><p class="stat mono">${money(s.dancerUnpaidCents)}</p></article>
    </section>
    <div class="grid split" style="margin-top:18px">
      <div class="stack">
        <section class="panel stack">
          <h2>Settings</h2>
          <form class="stack" data-action="mgr-settings">
            <label>Club name<input name="clubName" value="${escapeHtml(session.clubName)}" required maxlength="60" /></label>
            <label>House cut % on tips<input name="houseCutPercent" type="number" min="0" max="50" value="${session.houseCutPercent}" required /></label>
            <button class="btn secondary" type="submit">Save</button>
          </form>
          <button class="btn" type="button" data-action="mgr-topup-qr">Show club top-up QR</button>
          <button class="btn secondary" type="button" data-action="mgr-rotate-topup">Rotate top-up code</button>
          ${
            state.qr
              ? `<img class="qr" alt="Top-up QR" src="${state.qr.qrDataUrl}" /><p class="small mono">${escapeHtml(state.qr.url)}</p>`
              : `<p class="small muted">Top-up code: <span class="mono">${escapeHtml(session.topUpCode)}</span></p>`
          }
        </section>
        <section class="panel stack">
          <h2>Add dancer</h2>
          <form class="stack" data-action="mgr-add-dancer">
            <label>Handle<input name="handle" required minlength="3" maxlength="20" /></label>
            <label>Display name<input name="displayName" required maxlength="40" /></label>
            <label>Passphrase<input name="passphrase" type="password" required minlength="8" /></label>
            <button class="btn" type="submit">Add to roster</button>
          </form>
        </section>
      </div>
      <div class="stack">
        <section class="panel">
          <h2>Dancers</h2>
          <ul class="feed">${dancers || '<li class="muted">No dancers yet.</li>'}</ul>
        </section>
        <section class="panel">
          <h2>Customers</h2>
          <ul class="feed">${customers || '<li class="muted">No customers yet.</li>'}</ul>
        </section>
        <section class="panel">
          <h2>Recent ledger</h2>
          <ul class="feed">${feed || '<li class="muted">No entries yet.</li>'}</ul>
        </section>
      </div>
    </div>
    `,
  );
}

function chooseView() {
  if (state.path.startsWith('/manager')) return managerView();
  if (state.path.startsWith('/dancer')) return dancerView();
  if (state.path.startsWith('/account') || state.path.startsWith('/tip/') || state.path.startsWith('/u/')) {
    return customerView();
  }
  return landing();
}

async function ensureRouteData() {
  const tipMatch = state.path.match(/^\/tip\/([a-z0-9]+)$/i);
  const topMatch = state.path.match(/^\/u\/([a-z0-9]+)$/i);
  if (tipMatch) {
    state.tipInfo = await api(`/api/tip/info?code=${encodeURIComponent(tipMatch[1])}`);
  } else {
    state.tipInfo = null;
  }
  if (topMatch) {
    state.topupInfo = await api(`/api/topup/info?code=${encodeURIComponent(topMatch[1])}`);
  } else if (state.path === '/account') {
    state.topupInfo = await api('/api/topup/info');
  } else {
    state.topupInfo = null;
  }
}

function render() {
  app.innerHTML = chooseView();
}

async function boot() {
  state.path = routePath();
  await refreshPublic();
  await refreshSession();
  await ensureRouteData();
  render();
}

app.addEventListener('click', async (event) => {
  const link = event.target.closest('[data-link]');
  if (link) {
    event.preventDefault();
    const url = new URL(link.href);
    go(url.pathname.slice(base.length) || '/');
    state.invoice = null;
    state.qr = null;
    await ensureRouteData();
    await refreshSession();
    render();
    return;
  }

  const actionEl = event.target.closest('[data-action]');
  if (!actionEl || actionEl.tagName === 'FORM') return;
  event.preventDefault();
  const action = actionEl.dataset.action;
  try {
    if (action === 'logout') {
      await api('/api/logout', { method: 'POST', body: {} });
      state.session = { role: null };
      state.qr = null;
      state.invoice = null;
      go('/');
      await boot();
      return;
    }
    if (action === 'buy-pack') {
      const invoice = await api('/api/checkout/topup', {
        method: 'POST',
        body: { packageId: actionEl.dataset.id, code: state.topupInfo?.topUpCode || state.public.topUpCode },
      });
      state.invoice = { ...invoice.invoice, sample: invoice.sample };
      render();
      return;
    }
    if (action === 'settle-invoice') {
      const body = { invoiceId: actionEl.dataset.id };
      if (state.invoice?.mode === 'sandbox') body.samplePay = true;
      const result = await api('/api/checkout/settle', { method: 'POST', body });
      toast(result.invoice.status === 'paid' ? 'Credits added.' : `Invoice ${result.invoice.status}`);
      state.invoice = null;
      await refreshSession();
      render();
      return;
    }
    if (action === 'load-tip-qr' || action === 'mgr-tip-qr') {
      state.qr = await api(`/api/qr/tip?code=${encodeURIComponent(actionEl.dataset.code)}`);
      render();
      return;
    }
    if (action === 'mgr-topup-qr') {
      state.qr = await api('/api/qr/topup');
      render();
      return;
    }
    if (action === 'mgr-rotate-topup') {
      await api('/api/manager/settings', { method: 'POST', body: { rotateTopUpCode: true } });
      toast('Top-up code rotated.');
      state.qr = null;
      await refreshSession();
      await refreshPublic();
      render();
      return;
    }
    if (action === 'mgr-payout') {
      const unpaid = Number(actionEl.dataset.unpaid || 0);
      const raw = prompt(`Payout amount in cents (unpaid ${unpaid}):`, String(unpaid));
      if (raw == null) return;
      const amountCents = Number(raw);
      await api('/api/manager/payout', { method: 'POST', body: { dancerId: actionEl.dataset.id, amountCents } });
      toast('Payout recorded.');
      await refreshSession();
      render();
      return;
    }
    if (action === 'mgr-credit') {
      const raw = prompt('Credit amount in cents:', '5000');
      if (raw == null) return;
      const amountCents = Number(raw);
      await api('/api/manager/credit', { method: 'POST', body: { customerId: actionEl.dataset.id, amountCents } });
      toast('Credits added.');
      await refreshSession();
      render();
      return;
    }
  } catch (error) {
    toast(error.message);
  }
});

app.addEventListener('submit', async (event) => {
  const form = event.target.closest('form[data-action]');
  if (!form) return;
  event.preventDefault();
  const action = form.dataset.action;
  const data = Object.fromEntries(new FormData(form).entries());
  try {
    if (action === 'customer-join') {
      await api('/api/customer/join', {
        method: 'POST',
        body: { handle: data.handle, passphrase: data.passphrase, adult: data.adult === '1' },
      });
      toast('Account created.');
      await refreshSession();
      if (state.path === '/' ) go('/account');
      else render();
      await ensureRouteData();
      await refreshSession();
      render();
      return;
    }
    if (action === 'customer-login') {
      await api('/api/customer/login', { method: 'POST', body: data });
      await refreshSession();
      render();
      return;
    }
    if (action === 'dancer-login') {
      await api('/api/dancer/login', { method: 'POST', body: data });
      await refreshSession();
      render();
      return;
    }
    if (action === 'manager-login') {
      await api('/api/manager/login', { method: 'POST', body: data });
      await refreshSession();
      render();
      return;
    }
    if (action === 'custom-topup') {
      const invoice = await api('/api/checkout/topup', {
        method: 'POST',
        body: {
          amountCents: Number(data.amountCents),
          code: state.topupInfo?.topUpCode || state.public.topUpCode,
        },
      });
      state.invoice = { ...invoice.invoice, sample: invoice.sample };
      render();
      return;
    }
    if (action === 'send-tip') {
      await api('/api/tip', {
        method: 'POST',
        body: {
          tipCode: form.dataset.code,
          amountCents: Number(data.amountCents),
          note: data.note || '',
        },
      });
      toast('Tip sent.');
      await refreshSession();
      render();
      return;
    }
    if (action === 'mgr-settings') {
      await api('/api/manager/settings', {
        method: 'POST',
        body: {
          clubName: data.clubName,
          houseCutPercent: Number(data.houseCutPercent),
        },
      });
      toast('Settings saved.');
      await refreshSession();
      await refreshPublic();
      render();
      return;
    }
    if (action === 'mgr-add-dancer') {
      await api('/api/manager/dancers', { method: 'POST', body: data });
      toast('Dancer added.');
      form.reset();
      await refreshSession();
      render();
      return;
    }
  } catch (error) {
    toast(error.message);
  }
});

window.addEventListener('popstate', async () => {
  state.path = routePath();
  state.invoice = null;
  state.qr = null;
  await ensureRouteData();
  await refreshSession();
  render();
});

boot().catch((error) => {
  app.innerHTML = `<main class="wrap"><h1>Ohm Tracker</h1><p class="err">${escapeHtml(error.message)}</p></main>`;
});
