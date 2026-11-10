# Ohm Tracker

Club operations ledger and Lightning payment rail for professional club owners who hire dancers and host customers.

Customers top up Ohm credits (scan a club QR), tip dancers (scan a dancer QR), and managers track inflow, house take, and payouts on one book.

## What this is — and is not

Ohm Tracker is a **tracker + payment rail**.

It does **not** calculate payroll, withhold taxes, classify workers, or act as employer of record. The club (or its merchant entity) is the **merchant of record** for live Ohm / Lightning payments and remains responsible for dancer payouts, house share, and tax compliance. Credits are club-issued balances for in-venue top-ups and tips — not bank deposits.

This copy is shown in the product on customer, dancer, and manager surfaces.

## Roles

| Role | What they do |
| --- | --- |
| Manager | Unlock with `OHM_MANAGER_PIN`, set club name and house cut, roster dancers, show club top-up QR, record payouts and manual credits, read the ledger |
| Customer | Join with a handle, top up via Ohm checkout (or sample mode), tip by dancer QR |
| Dancer | Sign in with the passphrase the manager set, show tip QR, see tips and payouts |

There is no game / ATM / interest-debt feature set — those belong to Bijoux Debt, not Ohm Tracker.

## Run

```bash
npm install
OHM_MANAGER_PIN='choose-a-long-pin' npm start
```

Open `http://127.0.0.1:8791`.

| Variable | Purpose |
| --- | --- |
| `OHM_MANAGER_PIN` | Unlocks the manager console. Required. |
| `PORT` / `HOST` | Defaults to `8791` and `127.0.0.1`. |
| `BASE_PATH` | Public prefix when not on its own host. |
| `LND_MACAROON_HEX` | Turns checkout from sample mode into live Lightning (same Ohm node pattern as Bijoux Debt / Pantheon). |
| `LND_HOST` / `LND_REST_PORT` | The Ohm node. |
| `LND_TLS_CERT_BASE64` | Node certificate. Prefer this. |
| `LND_TLS_INSECURE` | `true` only to skip certificate checks. |

The book is stored in `data/book.json`.

## Floor flow

1. Manager opens **Show club top-up QR** and posts it at the door or bar.
2. Customer scans → creates/signs into an Ohm account → pays a package or custom amount.
3. Dancer (or manager) shows the dancer tip QR on the floor.
4. Customer scans → tips from credits; house cut is applied automatically.
5. Manager records dancer payouts when cash or settlement leaves the house.

## Tests

```bash
npm test
```

## Relation to Bijoux Debt

Bijoux Debt is a personal signed-debt and tribute book. Ohm Tracker reuses the Ohm Lightning checkout idea for a **multi-party club wallet + settlement ledger**. Keep the products separate; share only the pay rail concepts, not the debt/game domain.
