# Bijoux Debt

A personal book for [mistressbijoux.com](https://mistressbijoux.com). One domme, the people who keep accounts with her, and Lightning checkout through the same Ohm node Pantheon already uses.

WordPress stays the public site. This is a separate page you link to, or serve on a subdomain such as `debt.mistressbijoux.com`.

It is a record, not a lender. A debt does not accrue until that person signs the terms. Tribute is a running total of what they have sent. Lightning, when the node is connected, is a real payment and writes itself into the book when it settles. With no node configured, checkout is labeled as a sample and moves no money.

## What it keeps

- A signed debt: principal, yearly interest posted each New York morning, a due day from the 1st to the 28th, a minimum, and one late fee the morning after a missed due date.
- A tribute total, and a hall of confirmed payments.
- Claims for money sent somewhere else. She confirms or rejects them.
- A self-charge, which can only increase a signed debt.
- Tasks with a penalty she decides.
- A purse. He sets the ceiling. She cannot draw past it.
- Tiers on the public page that open checkout.

Payments are capped at $2,000 each. Interest is capped at 120% a year. The book does not include games of chance.

## Run

```bash
cd bijouxdebt
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

The book is stored in `bijouxdebt/data/book.json`.

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
