# exact-forwarder

[![ci](https://github.com/NEXTRIQ/exact-forwarder/actions/workflows/ci.yml/badge.svg)](https://github.com/NEXTRIQ/exact-forwarder/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Forwards supplier invoices from a Gmail / Google Workspace mailbox to the scan address of your
[Exact Online](https://www.exact.com/nl) administration. It uses deterministic rules. There is no AI and no
external service, and it does not guess.

> Nederlandstalige uitleg: [README.nl.md](README.nl.md)

Many Dutch businesses forward every incoming invoice to `…@inkoop.exactonline.nl` by hand, or use a mail filter
that also forwards contracts, quotes, reminders and phishing. exact-forwarder sits in between. It forwards what is
clearly an invoice, holds back anything doubtful with a short reason, and never sends the same PDF twice.

## How it decides

Every 15 minutes it reads new mail in the INBOX (read-only) and extracts the text of each PDF attachment with
`pdftotext`. Each message then gets one of three outcomes:

| Outcome                           | When                                                                                                                                                                                                                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **forward**                       | PDF attachment, an invoice word in the subject, file name or PDF, and SPF/DKIM/DMARC passing for the sender's domain. On top of that, the sender is listed in `senders.conf`, **or** it is an unknown business sender whose PDF has an invoice number, an amount and your own company name. |
| **review** (notice, nothing sent) | Contracts, quotes, policies, reminders, pro formas, failed payments, ID documents or payslips. Also unauthenticated senders, free-mail senders that are not listed, mail from your own domain, invoices without a PDF, and PDFs that were already forwarded.                                |
| **skip** (silent)                 | Newsletters, PDFs without any invoice signal (CVs, brochures), bounces, Exact itself, its own forwards.                                                                                                                                                                                     |

Forwarded and held-back invoices produce a notice by email and/or Telegram, with supplier, invoice number, date,
amount incl. VAT and, for a review, the reason. Notices are in Dutch, because the target audience is Dutch
bookkeeping.

## Safety by design

- **At most once.** A message is marked `pending` on disk before sending. If a run dies mid-send, the next run does not resend it. It asks a human to check the Sent folder instead.
- **Two-pass runs.** Everything is classified first and acted on afterwards. If one run would forward more than `MAX_PER_RUN` invoices, it sends nothing and raises an alarm.
- **Recipient allowlist.** The SMTP layer refuses every recipient except the configured Exact scan addresses and the notification mailbox. Config validation only accepts `…@*.exactonline.*` as a target.
- **Spoofing.** Only the topmost `Authentication-Results` header from your own receiving server counts. Copies further down can be forged by the sender.
- **Deduplication.** By Message-ID and by SHA-256 of every PDF, so a reminder that re-attaches the original invoice is not booked twice.
- **Minimal data at rest.** `state.json` (0600) holds Message-IDs, hashes, decisions and amounts. It never holds subjects, addresses or mail bodies. Dry-run logs contain booleans and counts only.
- **Hardened service.** The systemd unit runs as its own user with `ProtectSystem=strict`, no capabilities, and write access to its state directory only. Untrusted PDFs are parsed with a timeout, a page limit and bounded output.

## Requirements

- Node.js 20 or newer
- `pdftotext` from poppler-utils (`apt install poppler-utils`, `brew install poppler`)
- A Gmail or Google Workspace mailbox with IMAP enabled and an app password
- Your Exact Online scan address(es)

## Installation (Linux, systemd)

```sh
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin exact-forwarder
sudo git clone https://github.com/NEXTRIQ/exact-forwarder.git /opt/exact-forwarder
cd /opt/exact-forwarder && sudo npm ci && sudo npm run build && sudo npm prune --omit=dev

sudo install -d -m 755 /etc/exact-forwarder
sudo install -m 600 env.example /etc/exact-forwarder/env              # then fill it in
sudo install -m 644 senders.conf.example /etc/exact-forwarder/senders.conf
sudo cp deploy/systemd/exact-forwarder.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
```

### First run: dry run, seed, go live

1. **Dry run.** Keep `DRY_RUN=1` in the env file and start one run:
   `sudo systemctl start exact-forwarder && journalctl -u exact-forwarder -n 50`.
   Each message produces one JSON line with the decision and the reason. Content is never logged. Add
   `DRY_RUN_SINCE` and `DRY_RUN_IGNORE_STATE=1` to replay older mail against the rules.
2. **Seed.** Mark everything that was already sent to Exact as known, and set the cutoff:
   ```sh
   sudo systemd-run --pty --wait --uid=exact-forwarder \
     -p EnvironmentFile=/etc/exact-forwarder/env -p StateDirectory=exact-forwarder \
     /usr/bin/node /opt/exact-forwarder/dist/bin/exact-forwarder.js seed --since 2026-01-01T00:00:00Z
   ```
   This reads the Sent folder, hashes every PDF sent to your Exact address(es), including
   `LEGACY_EXACT_ADDRESSES`, and only considers mail after the later of `--since` and the last send.
3. **Go live.** Remove `DRY_RUN`, then `sudo systemctl enable --now exact-forwarder.timer`.

To pause, create `/etc/exact-forwarder/PAUSE`. To resume, delete it.

## Configuration

All settings come from environment variables. [`env.example`](env.example) documents each one. The most
important ones:

| Variable                                                        | Required    | Meaning                                                                                          |
| --------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------ |
| `MAIL_ACCOUNT`, `MAIL_PASSWORD`                                 | yes         | Mailbox and app password                                                                         |
| `EXACT_PURCHASE_ADDRESS`                                        | yes         | `…@inkoop.exactonline.nl`                                                                        |
| `EXACT_SALES_ADDRESS`                                           | no          | `…@verkoop.exactonline.nl`, only used for senders listed as `sales`                              |
| `NOTIFY_EMAIL` and/or `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | one of them | Where notices go. `NOTIFY_EMAIL` must be on an own domain.                                       |
| `OWN_NAMES`                                                     | recommended | Names that appear on invoices addressed to you. Without it, unknown senders are always reviewed. |
| `MAX_PER_RUN`                                                   | no (10)     | Burst guardrail                                                                                  |

`senders.conf` lists known suppliers (`purchase`), your own invoicing address (`sales`) and senders to ignore
(`exclude`). See [`senders.conf.example`](senders.conf.example). It is re-read on every run.

## Monitoring

After every run the tool writes `/var/lib/exact-forwarder/status.json`:

<!-- prettier-ignore -->
```json
{"lastRunAt":"…","lastOkAt":"…","lastError":null,"dryRun":false,"counts":{"scanned":2,"forward":1,"review":1}}
```

`lastOkAt` only moves when IMAP, processing and notifications all succeeded. Alert when it is older than about
an hour. Don't rely on the exit code: an expired app password or a dead notification channel shows up as
staleness, not as a crash.

`exact-forwarder status` prints the file.

## Development

```sh
npm ci
npm run check     # typecheck, lint, format check and tests
npm test          # compile, then node:test; no network; the PDF test needs pdftotext
npm run build     # compile src/ and bin/ to dist/
```

The code is TypeScript in strict mode (including `noUncheckedIndexedAccess`), compiled with `tsc` to ES
modules in `dist/`, with ESLint (type-checked rules) and Prettier. The only runtime dependencies are imapflow
and nodemailer. Decisions live in pure functions (`classify`, `extract`, `senders`) and are tested without I/O.
`runOnce` takes its mailbox, SMTP and notifier as dependencies (typed in `src/types.ts`), so the whole run is
tested end to end with fakes.

```
bin/exact-forwarder.ts   CLI: run, seed, status
src/types.ts             domain types and the Mailbox / Smtp / Notifier interfaces
src/config.ts            environment parsing and validation
src/classify.ts          the decision rules
src/extract.ts           amount, invoice number and date from PDF text (NL/EN)
src/senders.ts           senders.conf and SPF/DKIM/DMARC alignment
src/main.ts              one run, two passes; seed
src/imap.ts              IMAP via imapflow (read-only plus a Gmail label)
src/smtp.ts              SMTP via nodemailer with a recipient allowlist
src/notify.ts            notices (Telegram, email) and the daily summary
src/state.ts             atomic state and status files
src/pdf.ts               text extraction with pdftotext, sandboxed and bounded
src/errors.ts            reading fields from thrown values
```

## Limitations

- Built for Gmail and Google Workspace: labels and the default `AUTHSERV_ID`. Other IMAP servers work for reading if you set `AUTHSERV_ID` to the server that stamps `Authentication-Results`.
- Image-only (scanned) PDFs are recognised by subject and file name only, because there is no OCR.
- Amount and date extraction is tuned for Dutch and English invoices. Fields it cannot find reliably are reported as "niet gevonden" and never guessed.

## License

[MIT](LICENSE). Not affiliated with or endorsed by Exact. "Exact Online" is a trademark of its owner.

Built by [NEXTRIQ](https://nextriq.nl).
