// Decides per message: forward to Exact (purchase or sales), ask a human to review, or skip silently.
// Pure function, deterministic rules, no AI.
//
// Design rule: when in doubt, never forward. Contracts, quotes, reminders, ID documents and payslips are
// never forwarded, not even from a known supplier. Doubt becomes a "review" notice with a reason; mail that
// is clearly not an invoice (newsletters, CVs) is skipped without noise.
//
// Reasons are in Dutch on purpose: they end up in notices for Dutch bookkeeping.

import { extractInvoiceFields } from "./extract.js";
import { FREEMAIL, checkAuth, domainOf, lookupSender } from "./senders.js";
import type { SenderEntry } from "./senders.js";
import type {
  Attachment,
  Direction,
  ExactAddresses,
  InvoiceFields,
  MailMessage,
  SenderDirection,
} from "./types.js";

export const FORWARD_HEADER = "X-Exact-Forwarder";
export const MAX_PDF_BYTES = 20 * 1024 * 1024;

/** The attachment metadata classification looks at. */
export type AttachmentMeta = Pick<Attachment, "contentType" | "filename" | "size">;

/** A downloaded PDF as classification sees it; text is null for image-only or unreadable PDFs. */
export interface PdfText {
  readonly filename: string;
  readonly text: string | null;
}

/** A message plus its downloaded PDF attachments. */
export interface ClassifyInput
  extends Pick<MailMessage, "from" | "subject" | "authResults" | "hasLoopHeader"> {
  readonly attachments: readonly AttachmentMeta[];
  readonly pdfs: readonly PdfText[];
}

export interface ClassifyContext {
  readonly senders: readonly SenderEntry[];
  readonly ownDomains: readonly string[];
  readonly ownNames: readonly string[];
  /** Server whose Authentication-Results header counts (default mx.google.com). */
  readonly authservId?: string | undefined;
  readonly exact: ExactAddresses;
}

interface ResultBase {
  /** Dutch, shown to the user. */
  readonly reason: string;
  readonly vendor: string;
  readonly fields: InvoiceFields;
  /** The sender's direction in senders.conf, if listed. */
  readonly known: SenderDirection | null;
  /** Forwarded although the sender is not in senders.conf. */
  readonly newSender?: boolean;
  /** Held back because the same PDF was forwarded before. */
  readonly duplicate?: boolean;
}

export type ForwardResult = ResultBase & {
  readonly decision: "forward";
  readonly direction: Direction;
};
// A review can still carry a direction: a forward that turned out to be a duplicate keeps it.
export type ReviewResult = ResultBase & {
  readonly decision: "review";
  readonly direction: Direction | null;
};
export type SkipResult = ResultBase & { readonly decision: "skip"; readonly direction: null };
export type ClassifyResult = ForwardResult | ReviewResult | SkipResult;

type Base = Pick<ResultBase, "vendor" | "fields" | "known">;

const INVOICE_WORDS =
  /\b(factuur|facturen|factuurnummer|invoice|invoices|receipt|rekening|nota|creditnota|credit\s*note|btw-factuur|tax\s*invoice)\b/i;
// Never forward when the subject or file name says any of these.
const BLOCK_SUBJECT =
  /\b(contract\w*|overeenkomst\w*|offerte\w*|quotation|quote|paspoort|passport|identiteit\w*|id-?kaart|id-?bewijs|rijbewijs|polis\w*|loonstro{1,2}k\w*|salarisstro{1,2}k\w*|jaaropgave|aanmaning\w*|herinnering\w*|reminder|proforma|pro\s*forma|mislukt|failed|declined|machtiging|mandaat|mandate|opzegging)\b/i;
// Never forward when the PDF itself looks like an ID document or payslip, whatever else it says.
const BLOCK_PDF =
  /\b(paspoort|passport|identiteitskaart|identity\s*card|rijbewijs|driving\s*licen[cs]e|loonstrook|salarisstrook|payslip|geboortedatum|date\s*of\s*birth)\b/i;
// A document that introduces itself as a quote or contract.
const BLOCK_PDF_HEAD = /\b(offerte|quotation|overeenkomst|contract|agreement|polisblad)\b/i;
const NOREPLY_SYSTEM = /^(mailer-daemon|postmaster)@/i;

const isPdf = (a: Pick<Attachment, "contentType" | "filename">): boolean =>
  /^application\/pdf$/i.test(a.contentType) ||
  (/\.pdf$/i.test(a.filename) &&
    /^application\/(octet-stream|x-pdf|download)$/i.test(a.contentType));

/** PDF attachments, recognised by content type or by file name. */
export const pdfAttachments = <T extends Pick<Attachment, "contentType" | "filename">>(
  attachments: readonly T[],
): T[] => attachments.filter(isPdf);

const review = (reason: string, base: Base): ReviewResult => ({
  decision: "review",
  direction: null,
  reason,
  ...base,
});
const skip = (reason: string, base: Base): SkipResult => ({
  decision: "skip",
  direction: null,
  reason,
  ...base,
});
const forward = (
  direction: Direction,
  reason: string,
  base: Base & { newSender?: boolean },
): ForwardResult => ({ decision: "forward", direction, reason, ...base });

/** Classifies one message. Pure: everything it needs is in `msg` and `ctx`. */
export function classify(msg: ClassifyInput, ctx: ClassifyContext): ClassifyResult {
  const from = msg.from.address.toLowerCase();
  const domain = domainOf(from);
  const subject = msg.subject;
  const exactAddresses = [ctx.exact.purchase, ctx.exact.sales].filter(Boolean);
  const pdfs = msg.pdfs;
  const filenames = pdfs.map((p) => p.filename).join(" ");
  const pdfText = pdfs.map((p) => p.text ?? "").join("\n");
  const sender = lookupSender(ctx.senders, from);
  const vendor = sender?.name ?? (msg.from.name || domain || "onbekende afzender");
  const fields = extractInvoiceFields(pdfText, subject);
  const base: Base = { vendor, fields, known: sender?.direction ?? null };

  // 0. Loops and system mail: our own forwards, Exact itself, bounces.
  if (
    msg.hasLoopHeader ||
    exactAddresses.includes(from) ||
    /(^|\.)exactonline\.\w+$|(^|\.)exact\.com$/.test(domain) ||
    NOREPLY_SYSTEM.test(from)
  )
    return skip("systeembericht of eigen doorstuurmail", base);

  const subjectSignal = INVOICE_WORDS.test(subject) || INVOICE_WORDS.test(filenames);
  const pdfSignal = INVOICE_WORDS.test(pdfText);

  // 1. No PDF: only worth a notice when it looks like an invoice.
  if (!pdfs.length) {
    const tooBig = pdfAttachments(msg.attachments).some((a) => a.size > MAX_PDF_BYTES);
    if (tooBig) return review("PDF-bijlage groter dan 20 MB", base);
    return subjectSignal
      ? review("lijkt op een factuur, maar heeft geen PDF-bijlage", base)
      : skip("geen PDF", base);
  }
  if (!subjectSignal && !pdfSignal)
    return sender && sender.direction !== "exclude"
      ? review(
          "PDF van een bekende afzender, maar zonder factuurwoord in onderwerp, bestandsnaam of PDF",
          base,
        )
      : skip("PDF zonder factuursignaal", base);

  // 2. Hard guardrails. Capture group 1 is mandatory in each pattern.
  const blocked = BLOCK_SUBJECT.exec(`${subject} ${filenames}`);
  if (blocked)
    return review(
      `onderwerp of bestandsnaam noemt "${(blocked[1] ?? "").toLowerCase()}" (vangrail: nooit doorsturen)`,
      base,
    );
  const blockedPdf = BLOCK_PDF.exec(pdfText);
  if (blockedPdf)
    return review(
      `de PDF bevat "${(blockedPdf[1] ?? "").toLowerCase()}" (mogelijk ID-document of loonstrook)`,
      base,
    );
  const head = pdfs.map((p) => (p.text ?? "").slice(0, 400)).join("\n");
  const blockedHead = BLOCK_PDF_HEAD.exec(head);
  if (blockedHead && !INVOICE_WORDS.test(head))
    return review(
      `de PDF begint als "${(blockedHead[1] ?? "").toLowerCase()}", niet als factuur`,
      base,
    );

  // 3. Explicitly excluded sender.
  if (sender?.direction === "exclude") return review("afzender staat op de uitsluitlijst", base);

  // 4. Sender authenticity, against spoofed invoices.
  const auth = checkAuth(msg.authResults, from, { authservId: ctx.authservId });
  const own = ctx.ownDomains.some((d) => domain === d || domain.endsWith(`.${d}`));

  // 5. Own domain: a sales invoice only when this exact address is listed as `sales`.
  if (own) {
    if (sender?.direction === "sales") {
      if (!ctx.exact.sales)
        return review("verkoopfactuur herkend, maar er is geen Exact-verkoopadres ingesteld", base);
      // Internal mail within the same tenant sometimes has no Authentication-Results; a forged one has a "fail".
      if (!auth.ok && auth.reason !== "geen Authentication-Results")
        return review(`verkoopafzender niet geverifieerd (${auth.reason})`, base);
      return forward("sales", "eigen verkoopfactuur (afzenderlijst)", base);
    }
    return review(
      "afzender is een eigen adres: mogelijk een verkoopfactuur of een doorgestuurde inkoopfactuur; controleer en stuur zelf door",
      base,
    );
  }

  if (!auth.ok) return review(`afzender niet geverifieerd: ${auth.reason}`, base);

  // 6. Known supplier.
  if (sender?.direction === "purchase") return forward("purchase", "bekende leverancier", base);
  if (sender?.direction === "sales")
    return review("afzender staat als verkoop, maar is geen eigen domein", base);

  // 7. Unknown sender: only when it is unmistakably an invoice addressed to us.
  if (FREEMAIL.has(domain)) return review("onbekende afzender met een persoonlijk mailadres", base);
  const names = ctx.ownNames;
  if (!names.length)
    return review("onbekende afzender; zet hem in senders.conf als hij klopt", base);
  const missing: string[] = [];
  if (!pdfSignal) missing.push("geen factuurwoord in de PDF");
  if (!fields.number) missing.push("geen factuurnummer");
  if (!fields.amount) missing.push("geen bedrag");
  const lower = pdfText.toLowerCase();
  if (!names.some((n) => lower.includes(n)))
    missing.push("de eigen bedrijfsnaam staat niet op de factuur");
  if (missing.length) return review(`onbekende afzender en ${missing.join(", ")}`, base);
  return forward("purchase", "nieuwe afzender, factuur op eigen naam met nummer en bedrag", {
    newSender: true,
    ...base,
  });
}
