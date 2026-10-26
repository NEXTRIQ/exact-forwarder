// Configuration from the environment. Everything that identifies an organisation (mailbox, Exact scan
// addresses, own domains) is required input; there are no built-in defaults that point at a real company.
import { domainOf } from "./senders.js";
import type { ExactAddresses } from "./types.js";

const EMAIL = /^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
// Exact Online scan addresses look like <code>@inkoop.exactonline.nl / <code>@verkoop.exactonline.be.
// Forwarding is restricted to that shape so a typo or a hostile config cannot turn this into a generic relay.
const EXACT_SCAN_ADDRESS = /^[a-z0-9._-]+@[a-z]+\.exactonline\.[a-z]{2,}(\.[a-z]{2,})?$/i;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export class ConfigError extends Error {}

export type Env = Readonly<Record<string, string | undefined>>;

export interface Config {
  readonly account: string;
  readonly pass: string;
  readonly imapHost: string;
  readonly smtpHost: string;
  readonly smtpPort: number;
  readonly fromName: string;
  readonly authservId: string;
  readonly exact: ExactAddresses;
  readonly legacyExactAddresses: readonly string[];
  readonly notifyEmail: string | null;
  readonly telegramToken: string;
  readonly telegramChatId: string;
  readonly sendersFile: string;
  readonly pauseFile: string;
  readonly stateDir: string;
  readonly ownDomains: readonly string[];
  readonly ownNames: readonly string[];
  readonly lookbackDays: number;
  readonly maxPerRun: number;
  /** HH:MM, Europe/Amsterdam. */
  readonly summaryAt: string;
  readonly dryRun: boolean;
  readonly dryRunSince: Date | null;
  readonly dryRunIgnoreState: boolean;
  readonly labels: boolean;
}

const list = (v: string | undefined): string[] =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

/** A validated, lower-cased Exact scan address, or null when the variable is empty. */
function exactAddress(value: string | undefined, name: string): string | null {
  const v = (value ?? "").trim().toLowerCase();
  if (!v) return null;
  if (!EXACT_SCAN_ADDRESS.test(v))
    throw new ConfigError(`${name} must be an Exact Online scan address (…@inkoop.exactonline.nl)`);
  return v;
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new ConfigError(`${name} must be a positive integer`);
  return n;
}

/** Parses and validates the environment. Throws ConfigError with a message that never contains secrets. */
export function configFromEnv(env: Env = process.env): Config {
  const account = (env.MAIL_ACCOUNT ?? "").trim().toLowerCase();
  if (!EMAIL.test(account))
    throw new ConfigError("MAIL_ACCOUNT must be the mailbox address to read");

  const ownDomains = env.OWN_DOMAINS ? list(env.OWN_DOMAINS) : [domainOf(account)];
  const notifyEmail = (env.NOTIFY_EMAIL ?? "").trim().toLowerCase() || null;
  if (notifyEmail) {
    if (!EMAIL.test(notifyEmail)) throw new ConfigError("NOTIFY_EMAIL is not a valid address");
    const d = domainOf(notifyEmail);
    // Notices contain invoice details; they may only go to a mailbox of the organisation itself.
    if (!ownDomains.some((o) => d === o || d.endsWith(`.${o}`)))
      throw new ConfigError("NOTIFY_EMAIL must be on one of OWN_DOMAINS");
  }

  const summaryAt = env.SUMMARY_AT ?? "20:00";
  if (!HHMM.test(summaryAt)) throw new ConfigError("SUMMARY_AT must be HH:MM");
  const dryRunSince = env.DRY_RUN_SINCE ? new Date(env.DRY_RUN_SINCE) : null;
  if (dryRunSince && Number.isNaN(dryRunSince.getTime()))
    throw new ConfigError("DRY_RUN_SINCE must be an ISO timestamp");

  const purchase = exactAddress(env.EXACT_PURCHASE_ADDRESS, "EXACT_PURCHASE_ADDRESS");
  if (!purchase) throw new ConfigError("EXACT_PURCHASE_ADDRESS is required");
  const sales = exactAddress(env.EXACT_SALES_ADDRESS, "EXACT_SALES_ADDRESS");

  return {
    account,
    pass: (env.MAIL_PASSWORD ?? "").trim(),
    imapHost: (env.MAIL_IMAP_HOST ?? "imap.gmail.com").trim(),
    smtpHost: (env.MAIL_SMTP_HOST ?? "smtp.gmail.com").trim(),
    smtpPort: positiveInt(env.MAIL_SMTP_PORT, 587, "MAIL_SMTP_PORT"),
    fromName:
      (env.MAIL_FROM_NAME ?? "exact-forwarder").replace(/[\r\n<>"]/g, "").trim() ||
      "exact-forwarder",
    authservId: (env.AUTHSERV_ID ?? "mx.google.com").trim().toLowerCase(),
    exact: Object.freeze({ purchase, sales }),
    legacyExactAddresses: list(env.LEGACY_EXACT_ADDRESSES),
    notifyEmail,
    telegramToken: (env.TELEGRAM_BOT_TOKEN ?? "").trim(),
    telegramChatId: (env.TELEGRAM_CHAT_ID ?? "").trim(),
    sendersFile: env.SENDERS_FILE ?? "/etc/exact-forwarder/senders.conf",
    pauseFile: env.PAUSE_FILE ?? "/etc/exact-forwarder/PAUSE",
    stateDir: env.STATE_DIR ?? "/var/lib/exact-forwarder",
    ownDomains,
    ownNames: list(env.OWN_NAMES),
    lookbackDays: positiveInt(env.LOOKBACK_DAYS, 14, "LOOKBACK_DAYS"),
    maxPerRun: positiveInt(env.MAX_PER_RUN, 10, "MAX_PER_RUN"),
    summaryAt,
    dryRun: env.DRY_RUN === "1",
    dryRunSince,
    dryRunIgnoreState: env.DRY_RUN_IGNORE_STATE === "1",
    labels: env.GMAIL_LABELS !== "0",
  };
}
