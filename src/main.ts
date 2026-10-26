// One run (started by a timer, e.g. every 15 minutes) and the one-off `seed`.
//
// A run reads new mail from the INBOX (only after the cutoff), downloads and reads PDF attachments, classifies
// every message (classify.ts) and only then acts: forward to Exact, label, notify. Deduplication is by
// Message-ID and by SHA-256 of each PDF. Two passes keep reading and acting apart, so the MAX_PER_RUN
// guardrail can stop a run before anything has been sent.
//
// Delivery is at-most-once: a message is marked "pending" on disk before it is sent. If a run dies mid-send,
// the next run does not resend it but asks a human to check the Sent folder. Never twice beats never missing.
import { existsSync, readFileSync } from "node:fs";
import { classify, pdfAttachments, MAX_PDF_BYTES } from "./classify.js";
import type { ClassifyContext, ClassifyResult } from "./classify.js";
import type { Config } from "./config.js";
import { errorCode, errorProp, errorText } from "./errors.js";
import { DIRECTION_NL, composeDailySummary, composeNotice } from "./notify.js";
import { looksLikePdf, sha256 } from "./pdf.js";
import { parseSenders } from "./senders.js";
import { loadState, prune, saveState, writeStatus } from "./state.js";
import type { OutboxItem, SeedInfo, State } from "./state.js";
import type {
  Counts,
  Direction,
  ExactAddresses,
  InvoiceFields,
  MailMessage,
  Mailbox,
  Notifier,
  PdfInfo,
  PdfTextFn,
  SentMessage,
  Smtp,
} from "./types.js";

const DAY = 24 * 60 * 60 * 1000;
export const TZ = "Europe/Amsterdam";
export const LABEL_FORWARDED = "Exact/doorgestuurd";

/** Everything a run talks to, injected so the whole run can be tested with fakes. */
export interface RunDeps {
  readonly mailbox: Mailbox;
  /** Null in DRY_RUN, where nothing is sent. */
  readonly smtp: Smtp | null;
  readonly telegram?: Notifier | null;
  readonly pdfText: PdfTextFn;
  readonly now?: Date;
  readonly log?: (line: string) => void;
}

export interface SeedDeps {
  readonly mailbox: Pick<Mailbox, "connect" | "close" | "listSentTo">;
  readonly now?: Date;
}

export interface SeedOptions {
  readonly since: Date;
  /** File with Message-IDs a previous system already handled, one per line. */
  readonly messageIdsFile?: string | null;
  readonly force?: boolean;
  readonly sentLookbackDays?: number;
}

/** Summary of a run (counts only), also logged as one JSON line. */
export interface RunSummary extends Counts {
  readonly at: string;
  readonly dryRun: boolean;
  readonly since: string;
  readonly ok: boolean;
  readonly problems: string[];
  readonly paused?: undefined;
}

export interface PausedRun {
  readonly paused: true;
  readonly counts: Counts;
}

export type RunResult = RunSummary | PausedRun;

export type SeedResult = { readonly cutoff: string } & SeedInfo;

/** A classified message and the PDFs that would go to Exact. */
interface Plan {
  readonly msg: MailMessage;
  readonly pdfs: readonly PdfInfo[];
  readonly toSend: readonly PdfInfo[];
  readonly result: ClassifyResult;
}

const NO_FIELDS: InvoiceFields = Object.freeze({ amount: null, number: null, date: null });

const fmtKey = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const fmtHm = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Calendar day in Amsterdam, YYYY-MM-DD. */
export const dayKey = (d: Date | string | number): string => fmtKey.format(new Date(d));

/** "HH:MM" to minutes since midnight (NaN when malformed). */
const toMinutes = (hhmm: string): number => {
  const [h = NaN, m = NaN] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** Minutes since midnight in Amsterdam. */
export const minutesOfDay = (d: Date | string | number): number =>
  toMinutes(fmtHm.format(new Date(d)));

// nodemailer error codes raised before the message data was handed over.
const NOT_SENT_CODES = new Set([
  "EAUTH",
  "ECONNECTION",
  "EDNS",
  "ESOCKET_CONNECT",
  "EENVELOPE",
  "ETLS",
]);
/** True when an SMTP error proves the message was not sent. Anything else stays "uncertain" (never resend). */
const surelyNotSent = (e: unknown): boolean => {
  const code = errorProp(e, "code");
  const command = errorProp(e, "command");
  return (
    (typeof code === "string" && NOT_SENT_CODES.has(code)) ||
    (Number(errorProp(e, "responseCode")) >= 400 && command !== "DATA" && command !== "DT")
  );
};

/** The Exact scan address for a direction. classify() never forwards sales without one; this keeps it so. */
function exactAddressFor(exact: ExactAddresses, direction: Direction): string {
  const to = exact[direction];
  if (!to) throw new Error(`no Exact address configured for ${direction}`);
  return to;
}

/** Downloads the PDFs of one message and extracts their text. */
async function loadPdfs(msg: MailMessage, deps: RunDeps): Promise<PdfInfo[]> {
  const out: PdfInfo[] = [];
  for (const a of pdfAttachments(msg.attachments)) {
    // IMAP reports the base64-encoded size; skip what is certainly too big before downloading it.
    if (a.size * 0.75 > MAX_PDF_BYTES) continue;
    const buf = await deps.mailbox.downloadFromInbox(msg.uid, a.part);
    if (!looksLikePdf(buf)) continue;
    const { text, error } = await deps.pdfText(buf);
    out.push({
      filename: a.filename || "factuur.pdf",
      buf,
      sha256: sha256(buf),
      size: buf.length,
      text,
      textError: error,
    });
  }
  return out;
}

/** An outbox item for every configured channel. */
function outboxItem(
  cfg: Config,
  deps: RunDeps,
  { telegram, mailSubject, mailText }: { telegram: string; mailSubject: string; mailText?: string },
): OutboxItem {
  return {
    ...(deps.telegram ? { telegram } : {}),
    ...(cfg.notifyEmail
      ? { mailSubject, mailText: mailText ?? `${telegram}\n\n-- exact-forwarder\n` }
      : {}),
    attempts: 0,
  };
}

/** A review for a message that is not classified normally (interrupted send, attachment that keeps failing). */
const reviewPlan = (msg: MailMessage, reason: string): Plan => ({
  msg,
  pdfs: [],
  toSend: [],
  result: {
    decision: "review",
    direction: null,
    reason,
    fields: NO_FIELDS,
    vendor: msg.from.name || msg.from.address,
    known: null,
  },
});

/** One run. Returns the summary (counts only), or `{ paused: true }` when the PAUSE file exists. */
export async function runOnce(cfg: Config, deps: RunDeps): Promise<RunResult> {
  const now = deps.now ?? new Date();
  const log = deps.log ?? ((s: string) => process.stdout.write(`${s}\n`));
  const counts: Counts = {
    scanned: 0,
    new: 0,
    forward: 0,
    review: 0,
    skip: 0,
    duplicate: 0,
    capped: 0,
    errors: 0,
    labelErrors: 0,
    notified: 0,
  };
  const errors: string[] = [];
  // Outside DRY_RUN an SMTP transport is required; failing inside the send's try keeps the error accounting.
  const smtp = (): Smtp => {
    if (!deps.smtp) throw new Error("no SMTP transport");
    return deps.smtp;
  };

  if (existsSync(cfg.pauseFile)) {
    writeStatus(cfg.stateDir, {
      now,
      ok: false,
      error: "paused (PAUSE file present)",
      counts,
      dryRun: cfg.dryRun,
    });
    log(JSON.stringify({ paused: true }));
    return { paused: true, counts };
  }

  const persisted = loadState(cfg.stateDir);
  const state: State =
    cfg.dryRun && cfg.dryRunIgnoreState
      ? { ...persisted, messages: {}, hashes: {}, pending: {} }
      : persisted;
  const senders = parseSenders(
    existsSync(cfg.sendersFile) ? readFileSync(cfg.sendersFile, "utf8") : "",
  );
  if (senders.errors.length) errors.push(`senders.conf: ${senders.errors.length} invalid lines`);
  const ctx: ClassifyContext = {
    senders: senders.entries,
    ownDomains: cfg.ownDomains,
    ownNames: cfg.ownNames,
    authservId: cfg.authservId,
    exact: cfg.exact,
  };

  let cutoff = state.cutoff ? new Date(state.cutoff) : null;
  if (cfg.dryRun && cfg.dryRunSince) cutoff = cfg.dryRunSince;
  if (!cutoff) {
    const msg = "not initialised: run `exact-forwarder seed` first (see README)";
    writeStatus(cfg.stateDir, { now, ok: false, error: msg, counts, dryRun: cfg.dryRun });
    throw new Error(msg);
  }
  const lookback = new Date(now.getTime() - cfg.lookbackDays * DAY);
  const since =
    cfg.dryRun && cfg.dryRunSince
      ? cutoff
      : new Date(Math.max(cutoff.getTime(), lookback.getTime()));

  const plans: Plan[] = [];
  try {
    await deps.mailbox.connect();
    const inbox = (await deps.mailbox.listInbox(since))
      .filter(
        (m): m is MailMessage & { internalDate: Date } =>
          m.internalDate !== null && m.internalDate > since,
      )
      .sort((a, b) => a.internalDate.getTime() - b.internalDate.getTime());
    counts.scanned = inbox.length;

    // Pass 1: classify (read-only).
    for (const msg of inbox) {
      if (state.messages[msg.key]) continue;
      counts.new++;
      if (state.pending[msg.key]) {
        plans.push(
          reviewPlan(
            msg,
            "een eerdere run werd onderbroken tijdens het versturen; controleer in Verzonden of hij al bij Exact is",
          ),
        );
        continue;
      }
      let pdfs: PdfInfo[];
      try {
        pdfs = await loadPdfs(msg, deps);
      } catch (e) {
        counts.errors++;
        const f = (state.failures[msg.key] = {
          count: (state.failures[msg.key]?.count ?? 0) + 1,
          lastAt: now.toISOString(),
        });
        if (f.count >= 5)
          plans.push(reviewPlan(msg, "de bijlage kon 5 keer niet worden opgehaald"));
        else errors.push(`attachment download failed (${errorCode(e, "code")})`);
        continue;
      }
      let result = classify({ ...msg, pdfs }, ctx);
      let toSend: PdfInfo[] = [];
      if (result.decision === "forward") {
        const seenHere = new Set<string>();
        toSend = pdfs.filter((p) => {
          if (state.hashes[p.sha256] || seenHere.has(p.sha256)) return false;
          seenHere.add(p.sha256);
          return true;
        });
        if (!toSend.length) {
          const firstPdf = pdfs[0];
          const first = firstPdf ? state.hashes[firstPdf.sha256]?.at : undefined;
          const when = first ? ` (op ${dayKey(first).split("-").reverse().join("-")})` : "";
          result = {
            ...result,
            decision: "review",
            duplicate: true,
            reason: `dezelfde PDF is al doorgestuurd naar Exact${when}; niet opnieuw`,
          };
        }
      }
      plans.push({ msg, pdfs, toSend, result });
    }

    // Guardrail: an unusual burst of invoices means something is off. Send nothing and raise an alarm.
    const forwards = plans.filter((p) => p.result.decision === "forward");
    const capped = forwards.length > cfg.maxPerRun;
    if (capped)
      errors.push(
        `${forwards.length} invoices in one run (limit ${cfg.maxPerRun}): nothing forwarded`,
      );

    // Pass 2: act.
    for (const p of plans) {
      const { msg, result } = p;
      if (result.decision === "skip") counts.skip++;
      if (result.decision === "review") counts[result.duplicate ? "duplicate" : "review"]++;
      if (result.decision === "forward" && (cfg.dryRun || capped))
        counts[capped ? "capped" : "forward"]++;
      if (cfg.dryRun) {
        // Dry-run log lines carry booleans and counts only: no subjects, addresses or amounts.
        log(
          JSON.stringify({
            dry: true,
            decision: result.decision,
            direction: result.direction,
            reason: result.reason,
            knownSender: result.known,
            pdfs: p.pdfs.length,
            amount: Boolean(result.fields.amount),
            number: Boolean(result.fields.number),
            date: Boolean(result.fields.date),
            pdfSentBefore: p.pdfs.some((x) => persisted.hashes[x.sha256]),
          }),
        );
        continue;
      }
      if (result.decision === "skip") {
        state.messages[msg.key] = { at: now.toISOString(), decision: "skip" };
        continue;
      }
      if (result.decision === "review") {
        state.messages[msg.key] = {
          at: now.toISOString(),
          decision: result.duplicate ? "duplicate" : "review",
        };
        delete state.pending[msg.key];
        state.outbox.push(
          outboxItem(
            cfg,
            deps,
            composeNotice({
              kind: "review",
              msg,
              result,
              pdfCount: p.pdfs.length,
              exact: cfg.exact,
            }),
          ),
        );
        saveState(cfg.stateDir, state);
        continue;
      }
      if (capped) continue; // left unprocessed; the next run re-evaluates (and alarms again)
      state.pending[msg.key] = now.toISOString();
      saveState(cfg.stateDir, state);
      try {
        await smtp().send({
          to: exactAddressFor(cfg.exact, result.direction),
          subject: `Fwd: ${(msg.subject || "factuur").replace(/[\r\n]+/g, " ").slice(0, 200)}`,
          text: `Factuur doorgestuurd door exact-forwarder (${DIRECTION_NL[result.direction]}).\nOrigineel van: ${msg.from.name ? `${msg.from.name} ` : ""}<${msg.from.address}>\n`,
          attachments: p.toSend.map((x) => ({
            filename: x.filename,
            content: x.buf,
            contentType: "application/pdf",
          })),
        });
      } catch (e) {
        counts.errors++;
        if (surelyNotSent(e)) delete state.pending[msg.key];
        errors.push(`forward failed (${errorCode(e, "code", "responseCode")})`);
        saveState(cfg.stateDir, state);
        continue;
      }
      counts.forward++;
      const at = now.toISOString();
      state.messages[msg.key] = {
        at,
        decision: "forward",
        direction: result.direction,
        hashes: p.toSend.map((x) => x.sha256),
      };
      for (const x of p.toSend) state.hashes[x.sha256] = { at, direction: result.direction };
      state.forwards.push({
        at,
        direction: result.direction,
        currency: result.fields.amount?.currency ?? null,
        value: result.fields.amount?.value ?? null,
      });
      delete state.pending[msg.key];
      delete state.failures[msg.key];
      state.outbox.push(
        outboxItem(
          cfg,
          deps,
          composeNotice({
            kind: "forwarded",
            msg,
            result,
            pdfCount: p.toSend.length,
            exact: cfg.exact,
          }),
        ),
      );
      saveState(cfg.stateDir, state);
      if (cfg.labels) {
        try {
          await deps.mailbox.addLabel(msg.uid, LABEL_FORWARDED);
        } catch {
          counts.labelErrors++;
        }
      }
    }
    if (capped && !cfg.dryRun && state.capAlertFor !== dayKey(now)) {
      const text = `ALARM exact-forwarder: ${forwards.length} facturen in één run (grens ${cfg.maxPerRun}). Niets doorgestuurd. Controleer de mailbox en verhoog zo nodig MAX_PER_RUN.`;
      state.outbox.push(
        outboxItem(cfg, deps, { telegram: text, mailSubject: "Exact: ALARM, niets doorgestuurd" }),
      );
      state.capAlertFor = dayKey(now);
    }
  } catch (e) {
    errors.unshift(`IMAP: ${errorText(e).replace(/\s+/g, " ").slice(0, 120)}`);
    counts.errors++;
  } finally {
    await deps.mailbox.close();
  }

  if (!cfg.dryRun) {
    // Daily one-liner on the first run after SUMMARY_AT, only when something was forwarded today.
    const today = dayKey(now);
    if (state.summarySentFor !== today && minutesOfDay(now) >= toMinutes(cfg.summaryAt)) {
      const forwardedToday = state.forwards.filter((f) => dayKey(f.at) === today);
      const reviewedToday = Object.values(state.messages).filter(
        (m) => m.decision === "review" && dayKey(m.at) === today,
      ).length;
      const line = composeDailySummary(forwardedToday, reviewedToday);
      if (line)
        state.outbox.push(
          outboxItem(cfg, deps, { telegram: line, mailSubject: "Exact: dagoverzicht" }),
        );
      state.summarySentFor = today;
    }

    // Deliver notices. Each channel is ticked off on its own; whatever fails is retried next run.
    for (const item of state.outbox) {
      try {
        if (item.telegram && !item.telegramDone && deps.telegram) {
          await deps.telegram(item.telegram);
          item.telegramDone = true;
          counts.notified++;
        }
        if (item.mailSubject && !item.mailDone && cfg.notifyEmail) {
          await smtp().send({
            to: cfg.notifyEmail,
            subject: item.mailSubject,
            text: item.mailText,
          });
          item.mailDone = true;
        }
      } catch (e) {
        item.attempts++;
        errors.push(`notice failed (${errorText(e).slice(0, 60)})`);
      }
    }
    state.outbox = state.outbox.filter(
      (i) => !((!i.telegram || i.telegramDone) && (!i.mailSubject || i.mailDone)),
    );
    state.lastRunAt = now.toISOString();
    saveState(cfg.stateDir, prune(state, now));
  }
  deps.smtp?.close();

  const ok = errors.length === 0;
  writeStatus(cfg.stateDir, { now, ok, error: errors.join("; "), counts, dryRun: cfg.dryRun });
  const summary: RunSummary = {
    at: now.toISOString(),
    dryRun: cfg.dryRun,
    since: since.toISOString(),
    ...counts,
    ok,
    problems: errors,
  };
  log(JSON.stringify(summary));
  return summary;
}

/**
 * Run once before the first real run: fixes the cutoff and marks everything that was already sent to Exact as
 * known (SHA-256 of the PDFs in the Sent folder, including LEGACY_EXACT_ADDRESSES), plus optionally a file with
 * Message-IDs a previous system already handled (one per line, no content).
 */
export async function seed(
  cfg: Config,
  deps: SeedDeps,
  { since, messageIdsFile = null, force = false, sentLookbackDays = 400 }: SeedOptions,
): Promise<SeedResult> {
  const now = deps.now ?? new Date();
  const state = loadState(cfg.stateDir);
  if (state.cutoff && !force)
    throw new Error("already initialised (cutoff is set); use --force to seed again");
  if (Number.isNaN(since.getTime())) throw new Error("--since <ISO timestamp> is required");
  const addresses = [
    ...[cfg.exact.purchase, cfg.exact.sales].filter((a): a is string => Boolean(a)),
    ...cfg.legacyExactAddresses,
  ];
  await deps.mailbox.connect();
  let sent: SentMessage[];
  try {
    sent = await deps.mailbox.listSentTo(
      addresses,
      new Date(now.getTime() - sentLookbackDays * DAY),
      sha256,
    );
  } finally {
    await deps.mailbox.close();
  }
  let pdfHashes = 0;
  let lastSent: Date | null = null;
  for (const s of sent) {
    const direction: Direction = s.to.some((t) => t === cfg.exact.sales || t.includes("@verkoop."))
      ? "sales"
      : "purchase";
    for (const h of s.hashes) {
      if (!state.hashes[h]) pdfHashes++;
      state.hashes[h] = { at: s.date.toISOString(), direction, source: "sent" };
    }
    if (!lastSent || s.date > lastSent) lastSent = s.date;
  }
  let ids = 0;
  if (messageIdsFile) {
    for (const line of readFileSync(messageIdsFile, "utf8").split(/\r?\n/)) {
      const id = line.trim();
      if (!id || state.messages[id]) continue;
      state.messages[id] = { at: now.toISOString(), decision: "legacy" };
      ids++;
    }
  }
  const cutoff = new Date(Math.max(since.getTime(), lastSent?.getTime() ?? 0));
  state.cutoff = cutoff.toISOString();
  state.seededAt = now.toISOString();
  state.seed = {
    sentMails: sent.length,
    pdfHashes,
    legacyMessageIds: ids,
    lastSentDay: lastSent ? dayKey(lastSent) : null,
  };
  saveState(cfg.stateDir, state);
  return { cutoff: state.cutoff, ...state.seed };
}
