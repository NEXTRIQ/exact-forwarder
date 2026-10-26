// Decides per message: forward to Exact (purchase or sales), ask a human to review, or skip silently.
// Pure function, deterministic rules, no AI.
//
// Design rule: when in doubt, never forward. Contracts, quotes, reminders, ID documents and payslips are
// never forwarded, not even from a known supplier. Doubt becomes a "review" notice with a reason; mail that
// is clearly not an invoice (newsletters, CVs) is skipped without noise.
//
// Reasons are in Dutch on purpose: they end up in notices for Dutch bookkeeping.

import { extractInvoiceFields } from "./extract.mjs";
import { FREEMAIL, checkAuth, domainOf, lookupSender } from "./senders.mjs";

export const FORWARD_HEADER = "X-Exact-Forwarder";
export const MAX_PDF_BYTES = 20 * 1024 * 1024;

const INVOICE_WORDS = /\b(factuur|facturen|factuurnummer|invoice|invoices|receipt|rekening|nota|creditnota|credit\s*note|btw-factuur|tax\s*invoice)\b/i;
// Never forward when the subject or file name says any of these.
const BLOCK_SUBJECT = /\b(contract\w*|overeenkomst\w*|offerte\w*|quotation|quote|paspoort|passport|identiteit\w*|id-?kaart|id-?bewijs|rijbewijs|polis\w*|loonstro{1,2}k\w*|salarisstro{1,2}k\w*|jaaropgave|aanmaning\w*|herinnering\w*|reminder|proforma|pro\s*forma|mislukt|failed|declined|machtiging|mandaat|mandate|opzegging)\b/i;
// Never forward when the PDF itself looks like an ID document or payslip, whatever else it says.
const BLOCK_PDF = /\b(paspoort|passport|identiteitskaart|identity\s*card|rijbewijs|driving\s*licen[cs]e|loonstrook|salarisstrook|payslip|geboortedatum|date\s*of\s*birth)\b/i;
// A document that introduces itself as a quote or contract.
const BLOCK_PDF_HEAD = /\b(offerte|quotation|overeenkomst|contract|agreement|polisblad)\b/i;
const NOREPLY_SYSTEM = /^(mailer-daemon|postmaster)@/i;

const isPdf = (a) =>
  /^application\/pdf$/i.test(a.contentType ?? "") ||
  (/\.pdf$/i.test(a.filename ?? "") && /^application\/(octet-stream|x-pdf|download)$/i.test(a.contentType ?? "application/octet-stream"));

/** PDF attachments, recognised by content type or by file name. */
export const pdfAttachments = (attachments) => (attachments ?? []).filter(isPdf);

const review = (reason, extra = {}) => ({ decision: "review", direction: null, reason, ...extra });
const skip = (reason, extra = {}) => ({ decision: "skip", direction: null, reason, ...extra });
const forward = (direction, reason, extra = {}) => ({ decision: "forward", direction, reason, ...extra });

/**
 * msg: { from: {address, name}, subject, authResults: string[], hasLoopHeader, attachments: [{filename, contentType, size}],
 *        pdfs: [{filename, sha256, size, text}] }   (pdfs = downloaded PDF attachments)
 * ctx: { senders, ownDomains, ownNames, authservId, exact: { purchase, sales } }
 * Returns { decision: forward|review|skip, direction: purchase|sales|null, reason, vendor, fields, known, newSender? }.
 */
export function classify(msg, ctx) {
  const from = String(msg.from?.address ?? "").toLowerCase();
  const domain = domainOf(from);
  const subject = String(msg.subject ?? "");
  const ownDomains = ctx.ownDomains ?? [];
  const exactAddresses = Object.values(ctx.exact ?? {}).filter(Boolean);
  const pdfs = msg.pdfs ?? [];
  const filenames = pdfs.map((p) => p.filename ?? "").join(" ");
  const pdfText = pdfs.map((p) => p.text ?? "").join("\n");
  const sender = lookupSender(ctx.senders ?? [], from);
  const vendor = sender?.name ?? (msg.from?.name || domain || "onbekende afzender");
  const fields = extractInvoiceFields(pdfText, subject);
  const base = { vendor, fields, known: sender?.direction ?? null };

  // 0. Loops and system mail: our own forwards, Exact itself, bounces.
  if (msg.hasLoopHeader || exactAddresses.includes(from) || /(^|\.)exactonline\.\w+$|(^|\.)exact\.com$/.test(domain) || NOREPLY_SYSTEM.test(from))
    return skip("systeembericht of eigen doorstuurmail", base);

  const subjectSignal = INVOICE_WORDS.test(subject) || INVOICE_WORDS.test(filenames);
  const pdfSignal = INVOICE_WORDS.test(pdfText);

  // 1. No PDF: only worth a notice when it looks like an invoice.
  if (!pdfs.length) {
    const tooBig = pdfAttachments(msg.attachments).some((a) => Number(a.size) > MAX_PDF_BYTES);
    if (tooBig) return review("PDF-bijlage groter dan 20 MB", base);
    return subjectSignal ? review("lijkt op een factuur, maar heeft geen PDF-bijlage", base) : skip("geen PDF", base);
  }
  if (!subjectSignal && !pdfSignal)
    return sender && sender.direction !== "exclude"
      ? review("PDF van een bekende afzender, maar zonder factuurwoord in onderwerp, bestandsnaam of PDF", base)
      : skip("PDF zonder factuursignaal", base);

  // 2. Hard guardrails.
  const blocked = BLOCK_SUBJECT.exec(`${subject} ${filenames}`);
  if (blocked) return review(`onderwerp of bestandsnaam noemt "${blocked[1].toLowerCase()}" (vangrail: nooit doorsturen)`, base);
  const blockedPdf = BLOCK_PDF.exec(pdfText);
  if (blockedPdf) return review(`de PDF bevat "${blockedPdf[1].toLowerCase()}" (mogelijk ID-document of loonstrook)`, base);
  const head = pdfs.map((p) => String(p.text ?? "").slice(0, 400)).join("\n");
  const blockedHead = BLOCK_PDF_HEAD.exec(head);
  if (blockedHead && !INVOICE_WORDS.test(head)) return review(`de PDF begint als "${blockedHead[1].toLowerCase()}", niet als factuur`, base);

  // 3. Explicitly excluded sender.
  if (sender?.direction === "exclude") return review("afzender staat op de uitsluitlijst", base);

  // 4. Sender authenticity, against spoofed invoices.
  const auth = checkAuth(msg.authResults, from, { authservId: ctx.authservId });
  const own = ownDomains.some((d) => domain === d || domain.endsWith(`.${d}`));

  // 5. Own domain: a sales invoice only when this exact address is listed as `sales`.
  if (own) {
    if (sender?.direction === "sales") {
      if (!ctx.exact?.sales) return review("verkoopfactuur herkend, maar er is geen Exact-verkoopadres ingesteld", base);
      // Internal mail within the same tenant sometimes has no Authentication-Results; a forged one has a "fail".
      if (!auth.ok && auth.reason !== "geen Authentication-Results") return review(`verkoopafzender niet geverifieerd (${auth.reason})`, base);
      return forward("sales", "eigen verkoopfactuur (afzenderlijst)", base);
    }
    return review("afzender is een eigen adres: mogelijk een verkoopfactuur of een doorgestuurde inkoopfactuur; controleer en stuur zelf door", base);
  }

  if (!auth.ok) return review(`afzender niet geverifieerd: ${auth.reason}`, base);

  // 6. Known supplier.
  if (sender?.direction === "purchase") return forward("purchase", "bekende leverancier", base);
  if (sender?.direction === "sales") return review("afzender staat als verkoop, maar is geen eigen domein", base);

  // 7. Unknown sender: only when it is unmistakably an invoice addressed to us.
  if (FREEMAIL.has(domain)) return review("onbekende afzender met een persoonlijk mailadres", base);
  const names = ctx.ownNames ?? [];
  if (!names.length) return review("onbekende afzender; zet hem in senders.conf als hij klopt", base);
  const missing = [];
  if (!pdfSignal) missing.push("geen factuurwoord in de PDF");
  if (!fields.number) missing.push("geen factuurnummer");
  if (!fields.amount) missing.push("geen bedrag");
  const lower = pdfText.toLowerCase();
  if (!names.some((n) => lower.includes(n))) missing.push("de eigen bedrijfsnaam staat niet op de factuur");
  if (missing.length) return review(`onbekende afzender en ${missing.join(", ")}`, base);
  return forward("purchase", "nieuwe afzender, factuur op eigen naam met nummer en bedrag", { newSender: true, ...base });
}
