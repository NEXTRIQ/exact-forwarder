// One run (started by a timer, e.g. every 15 minutes) and the one-off `seed`.
//
// A run reads new mail from the INBOX (only after the cutoff), downloads and reads PDF attachments, classifies
// every message (classify.mjs) and only then acts: forward to Exact, label, notify. Deduplication is by
// Message-ID and by SHA-256 of each PDF. Two passes keep reading and acting apart, so the MAX_PER_RUN
// guardrail can stop a run before anything has been sent.
//
// Delivery is at-most-once: a message is marked "pending" on disk before it is sent. If a run dies mid-send,
// the next run does not resend it but asks a human to check the Sent folder. Never twice beats never missing.
import { existsSync, readFileSync } from "node:fs";
import { classify, pdfAttachments, MAX_PDF_BYTES } from "./classify.mjs";
import { DIRECTION_NL, composeDailySummary, composeNotice } from "./notify.mjs";
import { looksLikePdf, sha256 } from "./pdf.mjs";
import { parseSenders } from "./senders.mjs";
import { loadState, prune, saveState, writeStatus } from "./state.mjs";

const DAY = 24 * 60 * 60 * 1000;
export const TZ = "Europe/Amsterdam";
export const LABEL_FORWARDED = "Exact/doorgestuurd";

const fmtKey = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const fmtHm = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
export const dayKey = (d) => fmtKey.format(new Date(d));
export const minutesOfDay = (d) => {
  const [h, m] = fmtHm.format(new Date(d)).split(":").map(Number);
  return h * 60 + m;
};
const hhmm = (s) => {
  const [h, m] = String(s).split(":").map(Number);
  return h * 60 + m;
};

/** True when an SMTP error proves the message was not sent. Anything else stays "uncertain" (never resend). */
const surelyNotSent = (e) =>
  ["EAUTH", "ECONNECTION", "EDNS", "ESOCKET_CONNECT", "EENVELOPE", "ETLS"].includes(e?.code) ||
  (Number(e?.responseCode) >= 400 && e?.command !== "DATA" && e?.command !== "DT");

/** Downloads the PDFs of one message and extracts their text. */
async function loadPdfs(msg, deps) {
  const out = [];
  for (const a of pdfAttachments(msg.attachments)) {
    // IMAP reports the base64-encoded size; skip what is certainly too big before downloading it.
    if (Number(a.size) * 0.75 > MAX_PDF_BYTES) continue;
    const buf = await deps.mailbox.downloadFromInbox(msg.uid, a.part);
    if (!looksLikePdf(buf)) continue;
    const { text, error } = await deps.pdfText(buf);
    out.push({ filename: a.filename || "factuur.pdf", buf, sha256: sha256(buf), size: buf.length, text, textError: error });
  }
  return out;
}

/** An outbox item for every configured channel. */
function outboxItem(cfg, deps, { telegram, mailSubject, mailText }) {
  return {
    ...(deps.telegram ? { telegram } : {}),
    ...(cfg.notifyEmail ? { mailSubject, mailText: mailText ?? `${telegram}\n\n-- exact-forwarder\n` } : {}),
    attempts: 0,
  };
}

/**
 * One run. deps: { mailbox, smtp, telegram?(text), pdfText(buf), now?, log?(line) }.
 * Returns the summary (counts only).
 */
export async function runOnce(cfg, deps) {
  const now = deps.now ?? new Date();
  const log = deps.log ?? ((s) => process.stdout.write(`${s}\n`));
  const counts = { scanned: 0, new: 0, forward: 0, review: 0, skip: 0, duplicate: 0, capped: 0, errors: 0, labelErrors: 0, notified: 0 };
  const errors = [];

  if (existsSync(cfg.pauseFile)) {
    writeStatus(cfg.stateDir, { now, ok: false, error: "paused (PAUSE file present)", counts, dryRun: cfg.dryRun });
    log(JSON.stringify({ paused: true }));
    return { paused: true, counts };
  }

  const persisted = loadState(cfg.stateDir);
  const state = cfg.dryRun && cfg.dryRunIgnoreState ? { ...persisted, messages: {}, hashes: {}, pending: {} } : persisted;
  const senders = parseSenders(existsSync(cfg.sendersFile) ? readFileSync(cfg.sendersFile, "utf8") : "");
  if (senders.errors.length) errors.push(`senders.conf: ${senders.errors.length} invalid lines`);
  const ctx = { senders: senders.entries, ownDomains: cfg.ownDomains, ownNames: cfg.ownNames, authservId: cfg.authservId, exact: cfg.exact };

  let cutoff = state.cutoff ? new Date(state.cutoff) : null;
  if (cfg.dryRun && cfg.dryRunSince) cutoff = cfg.dryRunSince;
  if (!cutoff) {
    const msg = "not initialised: run `exact-forwarder seed` first (see README)";
    writeStatus(cfg.stateDir, { now, ok: false, error: msg, counts, dryRun: cfg.dryRun });
    throw new Error(msg);
  }
  const lookback = new Date(now - cfg.lookbackDays * DAY);
  const since = cfg.dryRun && cfg.dryRunSince ? cutoff : new Date(Math.max(cutoff, lookback));

  const plans = [];
  try {
    await deps.mailbox.connect();
    const inbox = (await deps.mailbox.listInbox(since))
      .filter((m) => m.internalDate && m.internalDate > since)
      .sort((a, b) => a.internalDate - b.internalDate);
    counts.scanned = inbox.length;

    // Pass 1: classify (read-only).
    for (const msg of inbox) {
      if (state.messages[msg.key]) continue;
      counts.new++;
      if (state.pending[msg.key]) {
        const reason = "een eerdere run werd onderbroken tijdens het versturen; controleer in Verzonden of hij al bij Exact is";
        plans.push({ msg, pdfs: [], result: { decision: "review", reason, fields: {}, vendor: msg.from?.name || msg.from?.address } });
        continue;
      }
      let pdfs;
      try {
        pdfs = await loadPdfs(msg, deps);
      } catch (e) {
        counts.errors++;
        const f = (state.failures[msg.key] = { count: (state.failures[msg.key]?.count ?? 0) + 1, lastAt: now.toISOString() });
        if (f.count >= 5)
          plans.push({ msg, pdfs: [], result: { decision: "review", reason: "de bijlage kon 5 keer niet worden opgehaald", fields: {}, vendor: msg.from?.name || msg.from?.address } });
        else errors.push(`attachment download failed (${e?.code ?? "error"})`);
        continue;
      }
      let result = classify({ ...msg, pdfs }, ctx);
      let toSend = [];
      if (result.decision === "forward") {
        const seenHere = new Set();
        toSend = pdfs.filter((p) => {
          if (state.hashes[p.sha256] || seenHere.has(p.sha256)) return false;
          seenHere.add(p.sha256);
          return true;
        });
        if (!toSend.length) {
          const first = state.hashes[pdfs[0]?.sha256]?.at;
          const when = first ? ` (op ${dayKey(first).split("-").reverse().join("-")})` : "";
          result = { ...result, decision: "review", duplicate: true, reason: `dezelfde PDF is al doorgestuurd naar Exact${when}; niet opnieuw` };
        }
      }
      plans.push({ msg, pdfs, toSend, result });
    }

    // Guardrail: an unusual burst of invoices means something is off. Send nothing and raise an alarm.
    const forwards = plans.filter((p) => p.result.decision === "forward");
    const capped = forwards.length > cfg.maxPerRun;
    if (capped) errors.push(`${forwards.length} invoices in one run (limit ${cfg.maxPerRun}): nothing forwarded`);

    // Pass 2: act.
    for (const p of plans) {
      const { msg, result } = p;
      const kind = result.decision;
      if (kind === "skip") counts.skip++;
      if (kind === "review") counts[result.duplicate ? "duplicate" : "review"]++;
      if (kind === "forward" && (cfg.dryRun || capped)) counts[capped ? "capped" : "forward"]++;
      if (cfg.dryRun) {
        // Dry-run log lines carry booleans and counts only: no subjects, addresses or amounts.
        log(JSON.stringify({
          dry: true,
          decision: kind,
          direction: result.direction ?? null,
          reason: result.reason,
          knownSender: result.known ?? null,
          pdfs: p.pdfs.length,
          amount: Boolean(result.fields?.amount),
          number: Boolean(result.fields?.number),
          date: Boolean(result.fields?.date),
          pdfSentBefore: p.pdfs.some((x) => persisted.hashes[x.sha256]),
        }));
        continue;
      }
      if (kind === "skip") {
        state.messages[msg.key] = { at: now.toISOString(), decision: "skip" };
        continue;
      }
      if (kind === "review") {
        state.messages[msg.key] = { at: now.toISOString(), decision: result.duplicate ? "duplicate" : "review" };
        delete state.pending[msg.key];
        state.outbox.push(outboxItem(cfg, deps, composeNotice("review", { msg, result, pdfCount: p.pdfs.length, exact: cfg.exact })));
        saveState(cfg.stateDir, state);
        continue;
      }
      if (capped) continue; // left unprocessed; the next run re-evaluates (and alarms again)
      const to = cfg.exact[result.direction];
      state.pending[msg.key] = now.toISOString();
      saveState(cfg.stateDir, state);
      try {
        await deps.smtp.send({
          to,
          subject: `Fwd: ${String(msg.subject || "factuur").replace(/[\r\n]+/g, " ").slice(0, 200)}`,
          text: `Factuur doorgestuurd door exact-forwarder (${DIRECTION_NL[result.direction]}).\nOrigineel van: ${msg.from?.name ? `${msg.from.name} ` : ""}<${msg.from?.address}>\n`,
          attachments: p.toSend.map((x) => ({ filename: x.filename, content: x.buf, contentType: "application/pdf" })),
        });
      } catch (e) {
        counts.errors++;
        if (surelyNotSent(e)) delete state.pending[msg.key];
        errors.push(`forward failed (${e?.code ?? e?.responseCode ?? "error"})`);
        saveState(cfg.stateDir, state);
        continue;
      }
      counts.forward++;
      const at = now.toISOString();
      state.messages[msg.key] = { at, decision: "forward", direction: result.direction, hashes: p.toSend.map((x) => x.sha256) };
      for (const x of p.toSend) state.hashes[x.sha256] = { at, direction: result.direction };
      state.forwards.push({ at, direction: result.direction, currency: result.fields?.amount?.currency ?? null, value: result.fields?.amount?.value ?? null });
      delete state.pending[msg.key];
      delete state.failures[msg.key];
      state.outbox.push(outboxItem(cfg, deps, composeNotice("forwarded", { msg, result, pdfCount: p.toSend.length, exact: cfg.exact })));
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
      state.outbox.push(outboxItem(cfg, deps, { telegram: text, mailSubject: "Exact: ALARM, niets doorgestuurd" }));
      state.capAlertFor = dayKey(now);
    }
  } catch (e) {
    errors.unshift(`IMAP: ${String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 120)}`);
    counts.errors++;
  } finally {
    await deps.mailbox.close?.();
  }

  if (!cfg.dryRun) {
    // Daily one-liner on the first run after SUMMARY_AT, only when something was forwarded today.
    const today = dayKey(now);
    if (state.summarySentFor !== today && minutesOfDay(now) >= hhmm(cfg.summaryAt)) {
      const forwardedToday = state.forwards.filter((f) => dayKey(f.at) === today);
      const reviewedToday = Object.values(state.messages).filter((m) => m.decision === "review" && dayKey(m.at) === today).length;
      const line = composeDailySummary(forwardedToday, reviewedToday);
      if (line) state.outbox.push(outboxItem(cfg, deps, { telegram: line, mailSubject: "Exact: dagoverzicht" }));
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
          await deps.smtp.send({ to: cfg.notifyEmail, subject: item.mailSubject, text: item.mailText });
          item.mailDone = true;
        }
      } catch (e) {
        item.attempts++;
        errors.push(`notice failed (${String(e?.message ?? e).slice(0, 60)})`);
      }
    }
    state.outbox = state.outbox.filter((i) => !((!i.telegram || i.telegramDone) && (!i.mailSubject || i.mailDone)));
    state.lastRunAt = now.toISOString();
    saveState(cfg.stateDir, prune(state, now));
  }
  await deps.smtp?.close?.();

  const ok = errors.length === 0;
  writeStatus(cfg.stateDir, { now, ok, error: errors.join("; "), counts, dryRun: cfg.dryRun });
  const summary = { at: now.toISOString(), dryRun: cfg.dryRun, since: since.toISOString(), ...counts, ok, problems: errors };
  log(JSON.stringify(summary));
  return summary;
}

/**
 * Run once before the first real run: fixes the cutoff and marks everything that was already sent to Exact as
 * known (SHA-256 of the PDFs in the Sent folder, including LEGACY_EXACT_ADDRESSES), plus optionally a file with
 * Message-IDs a previous system already handled (one per line, no content).
 */
export async function seed(cfg, deps, { since, messageIdsFile = null, force = false, sentLookbackDays = 400 }) {
  const now = deps.now ?? new Date();
  const state = loadState(cfg.stateDir);
  if (state.cutoff && !force) throw new Error("already initialised (cutoff is set); use --force to seed again");
  if (!since || Number.isNaN(since.getTime())) throw new Error("--since <ISO timestamp> is required");
  const addresses = [...Object.values(cfg.exact).filter(Boolean), ...cfg.legacyExactAddresses];
  await deps.mailbox.connect();
  let sent;
  try {
    sent = await deps.mailbox.listSentTo(addresses, new Date(now - sentLookbackDays * DAY), sha256);
  } finally {
    await deps.mailbox.close?.();
  }
  let pdfHashes = 0;
  let lastSent = null;
  for (const s of sent) {
    const direction = s.to.some((t) => t === cfg.exact.sales || t.includes("@verkoop.")) ? "sales" : "purchase";
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
  const cutoff = new Date(Math.max(since, lastSent ?? 0));
  state.cutoff = cutoff.toISOString();
  state.seededAt = now.toISOString();
  state.seed = { sentMails: sent.length, pdfHashes, legacyMessageIds: ids, lastSentDay: lastSent ? dayKey(lastSent) : null };
  saveState(cfg.stateDir, state);
  return { cutoff: state.cutoff, ...state.seed };
}
