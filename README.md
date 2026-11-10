# Bijoux Debt

A personal book for [mistressbijoux.com](https://mistressbijoux.com). One domme, the people who keep accounts with her, and Lightning checkout through the same Ohm node Pantheon already uses.

WordPress stays the public site. This is a separate page you link to, or serve on a subdomain such as `debt.mistressbijoux.com`.

It is a record, not a lender. A debt does not accrue until that person signs the terms. Tribute is a running total of what they have sent. Lightning, when the node is connected, is a real payment and writes itself into the book when it settles. With no node configured, checkout is labeled as a sample and moves no money.

## What it keeps

- A signed debt: principal, yearly interest posted each New York morning, a due day from the 1st to the 28th, a minimum, and one late fee the morning after a missed due date.
- A tribute total, and a hall of confirmed payments.
- Claims for money sent somewhere else. She confirms or rejects them. Each claim needs a transaction ID, a screenshot of the payment, or both. Screenshots are PNG or JPEG up to 3 MB, stripped of camera and text metadata, and shown only to her and the name that sent them. They are saved in `data/proofs/`, so back up the whole `data/` folder, not just the book.
- A self-charge, which can only increase a signed debt.
- Tasks with a penalty she decides.
- Games that decide an amount owed. Every result is a charge added to an active signed debt. A game never pays out, refunds, lowers a balance, or clears a debt, and none can be played without an active debt. The best outcome is the smallest charge.
  - The server draws every result with `crypto.randomInt` and saves it before answering. Each play carries its own id, so a retry, double-click, or refresh returns the saved play instead of drawing again. The browser only animates it.
  - He sees the exact odds of every outcome and the average charge per play. She can make them as unfair as she likes, and the page says so plainly.
  - He accepts a game's terms before the first play. Any change she makes sends it back for him to accept again.
  - She sets a per-play cap, a daily cap (New York day), and a cooldown, all under hard ceilings in `ledger.mjs`. He can pause a game or lower his own caps at any time.
  - Each play writes a `game` line into the feed both sides see.
  - Her payment rules decide who can play. She can hold all games for a name, lock them while a minimum payment is missed, keep them locked until a set amount is paid, and lock them once unpaid game charges reach a limit. Only real money counts: Lightning that settled, payments she records, and claims she confirms. A sample checkout never does. A lock stops slot spins and ATM withdrawals alike, and both pages say why.
- A slot machine per name: three reels, symbols and weights, a stake, and a payout table of multipliers that she sets.
- A Human ATM, which replaces the old purse. He loads it, and that balance is the most she can withdraw until he reloads. He can reload, lower it down to zero, or freeze it at any time. He sets a 4-digit card PIN for role-play only, stored with scrypt and never shown. She inserts the card, types the PIN, and withdraws an amount, fast cash, a surprise skim, or a kick for a bonus. Three wrong PINs lock the card for 15 minutes. His page shows the machine live, and replays each withdrawal from the saved log.
- Tiers on the public page that open checkout.

Payments are capped at $2,000 each. Interest is capped at 120% a year.

If the Lightning node does not answer, checkout gives up within 10 seconds and shows the error next to the form.

## Run

```bash
npm install
BIJOUX_STUDIO_PIN='choose-a-long-pin' npm start
```

Open `http://127.0.0.1:8787`. The studio pin is read from the environment and is not stored in the book.

| Variable | Purpose |
| --- | --- |
| `BIJOUX_STUDIO_PIN` | Unlocks the studio. Required before she can write debts. |
| `PORT` / `HOST` | Defaults to `8787` and `127.0.0.1`. |
| `BASE_PATH` | Public prefix, such as `/bijouxdebt`, when it is not on its own host. |
| `LND_MACAROON_HEX` | Turns checkout from sample mode into live Lightning. Same value as Pantheon. |
| `LND_HOST` / `LND_REST_PORT` | The Ohm node. No host is assumed. |
| `LND_TLS_CERT_BASE64` | Node certificate. Prefer this. |
| `LND_TLS_INSECURE` | Set to `true` only if you intentionally skip certificate checks. |
| `LND_INVOICE_INCLUDE_ROUTE_HINTS` | Set to `false` to omit routing hints. Default includes them, matching Pantheon. |
| `BIJOUX_VAPID_PUBLIC_KEY` / `BIJOUX_VAPID_PRIVATE_KEY` | Optional. Pin Web Push VAPID keys. If unset, the book generates and stores a pair on first use. |
| `BIJOUX_VAPID_SUBJECT` | Optional `mailto:` or `https:` contact for VAPID. Defaults to `mailto:studio@mistressbijoux.com`. |

The book is stored in `data/book.json`.

## Alerts

High-signal changes write an unread notice into the book: debt proposed or signed, game terms changed or accepted, claims, tasks, charges, and debt status. While someone is signed in, the page polls for unread notices, shows a toast, and keeps a badge until they are marked read.

Browser push is optional per device. On your book or in the studio, use **Enable browser push**. That asks the browser for permission and stores a push subscription in the book. No email is required. Push needs HTTPS (or localhost).

Email is reserved for the same high-signal events later. It will need a provider key and an opt-in contact on the name; nothing is sent today.

## WordPress

Add a custom link in the menu, or a button on a page:

```html
<a href="https://debt.mistressbijoux.com">Bijoux Debt</a>
```

Nginx for that subdomain:

```nginx
server {
    server_name debt.mistressbijoux.com;
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

To hang it on the existing domain instead, set `BASE_PATH=/bijouxdebt` and proxy `location /bijouxdebt/` to the same process without stripping the prefix.

## Tests

```bash
npm test
```
