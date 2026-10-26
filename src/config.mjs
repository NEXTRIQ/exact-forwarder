// Configuration from the environment. Everything that identifies an organisation (mailbox, Exact scan
// addresses, own domains) is required input; there are no built-in defaults that point at a real company.
import { domainOf } from "./senders.mjs";

const EMAIL = /^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
// Exact Online scan addresses look like <code>@inkoop.exactonline.nl / <code>@verkoop.exactonline.be.
// Forwarding is restricted to that shape so a typo or a hostile config cannot turn this into a generic relay.
const EXACT_SCAN_ADDRESS = /^[a-z0-9._-]+@[a-z]+\.exactonline\.[a-z]{2,}(\.[a-z]{2,})?$/i;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export class ConfigError extends Error {}

const list = (v) =>
  String(v ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

function exactAddress(value, name, { required }) {
  const v = String(value ?? "").trim().toLowerCase();
  if (!v) {
    if (required) throw new ConfigError(`${name} is required`);
    return null;
  }
  if (!EXACT_SCAN_ADDRESS.test(v)) throw new ConfigError(`${name} must be an Exact Online scan address (…@inkoop.exactonline.nl)`);
  return v;
}

function positiveInt(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new ConfigError(`${name} must be a positive integer`);
  return n;
}

/** Parses and validates the environment. Throws ConfigError with a message that never contains secrets. */
export function configFromEnv(env = process.env) {
  const account = String(env.MAIL_ACCOUNT ?? "").trim().toLowerCase();
  if (!EMAIL.test(account)) throw new ConfigError("MAIL_ACCOUNT must be the mailbox address to read");

  const ownDomains = env.OWN_DOMAINS ? list(env.OWN_DOMAINS) : [domainOf(account)];
  const notifyEmail = String(env.NOTIFY_EMAIL ?? "").trim().toLowerCase() || null;
  if (notifyEmail) {
    if (!EMAIL.test(notifyEmail)) throw new ConfigError("NOTIFY_EMAIL is not a valid address");
    const d = domainOf(notifyEmail);
    // Notices contain invoice details; they may only go to a mailbox of the organisation itself.
    if (!ownDomains.some((o) => d === o || d.endsWith(`.${o}`))) throw new ConfigError("NOTIFY_EMAIL must be on one of OWN_DOMAINS");
  }

  const summaryAt = env.SUMMARY_AT ?? "20:00";
  if (!HHMM.test(summaryAt)) throw new ConfigError("SUMMARY_AT must be HH:MM");
  const dryRunSince = env.DRY_RUN_SINCE ? new Date(env.DRY_RUN_SINCE) : null;
  if (dryRunSince && Number.isNaN(dryRunSince.getTime())) throw new ConfigError("DRY_RUN_SINCE must be an ISO timestamp");

  const purchase = exactAddress(env.EXACT_PURCHASE_ADDRESS, "EXACT_PURCHASE_ADDRESS", { required: true });
  const sales = exactAddress(env.EXACT_SALES_ADDRESS, "EXACT_SALES_ADDRESS", { required: false });

  return {
    account,
    pass: String(env.MAIL_PASSWORD ?? "").trim(),
    imapHost: String(env.MAIL_IMAP_HOST ?? "imap.gmail.com").trim(),
    smtpHost: String(env.MAIL_SMTP_HOST ?? "smtp.gmail.com").trim(),
    smtpPort: positiveInt(env.MAIL_SMTP_PORT, 587, "MAIL_SMTP_PORT"),
    fromName: String(env.MAIL_FROM_NAME ?? "exact-forwarder").replace(/[\r\n<>"]/g, "").trim() || "exact-forwarder",
    authservId: String(env.AUTHSERV_ID ?? "mx.google.com").trim().toLowerCase(),
    exact: Object.freeze({ purchase, sales }),
    legacyExactAddresses: list(env.LEGACY_EXACT_ADDRESSES),
    notifyEmail,
    telegramToken: String(env.TELEGRAM_BOT_TOKEN ?? "").trim(),
    telegramChatId: String(env.TELEGRAM_CHAT_ID ?? "").trim(),
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
