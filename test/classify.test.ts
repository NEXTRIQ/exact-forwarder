import assert from "node:assert/strict";
import { test } from "node:test";
import { classify } from "../src/classify.js";
import type { ClassifyContext, ClassifyInput } from "../src/classify.js";
import { checkAuth, lookupSender, orgDomain, parseSenders } from "../src/senders.js";
import { AUTH_PASS, EXACT } from "./helpers.js";

const senders = parseSenders(`
purchase notify.cloudflare.com Cloudflare
inkoop   ionos.co.uk           IONOS
purchase builder.jansen@gmail.com Klusbedrijf Jansen
sales    invoices@acme.example Acme invoicing
exclude  insurer.example       Insurance broker
`).entries;
const ctx: ClassifyContext = {
  senders,
  ownDomains: ["acme.example"],
  ownNames: ["acme"],
  exact: EXACT,
};
const INVOICE_TEXT =
  "Factuur\nFactuurnummer: F-2026-118\nFactuurdatum: 01-10-2026\nAan: Acme B.V.\nTotaal incl. btw  € 24,20";

interface MsgInput {
  from: string;
  subject?: string;
  pdfText?: string | null;
  filename?: string;
  auth?: string[];
  pdf?: boolean;
  loop?: boolean;
}

function msg({
  from,
  subject = "Uw factuur",
  pdfText = INVOICE_TEXT,
  filename = "factuur.pdf",
  auth,
  pdf = true,
  loop = false,
}: MsgInput): ClassifyInput {
  const domain = from.split("@")[1] ?? "";
  return {
    from: { address: from, name: "" },
    subject,
    authResults: auth ?? AUTH_PASS(domain),
    hasLoopHeader: loop,
    attachments: pdf ? [{ contentType: "application/pdf", filename, size: 1000 }] : [],
    pdfs: pdf ? [{ filename, text: pdfText }] : [],
  };
}

test("known supplier with PDF and invoice word: purchase", () => {
  const r = classify(msg({ from: "noreply@notify.cloudflare.com" }), ctx);
  assert.equal(r.decision, "forward");
  assert.equal(r.direction, "purchase");
  assert.equal(r.vendor, "Cloudflare");
  assert.equal(r.fields.number, "F-2026-118");
  assert.deepEqual(r.fields.amount, { value: 24.2, currency: "EUR" });
});

test("known supplier, scanned PDF without text: still purchase (subject says invoice), amount unknown", () => {
  const r = classify(
    msg({ from: "billing@ionos.co.uk", subject: "Your IONOS invoice", pdfText: null }),
    ctx,
  );
  assert.equal(r.decision, "forward");
  assert.equal(r.fields.amount, null);
});

test("unknown business sender: only with invoice word, number, amount and own name on the invoice", () => {
  const ok = classify(msg({ from: "billing@hosting.example" }), ctx);
  assert.equal(ok.decision, "forward");
  assert.equal(ok.newSender, true);
  const noName = classify(
    msg({
      from: "billing@hosting.example",
      pdfText: "Invoice\nInvoice number 123456\nTotal € 5,00",
    }),
    ctx,
  );
  assert.equal(noName.decision, "review");
  assert.match(noName.reason, /eigen bedrijfsnaam staat niet op de factuur/);
  const noAmount = classify(
    msg({ from: "billing@hosting.example", pdfText: "Invoice Acme\nInvoice number 123456" }),
    ctx,
  );
  assert.equal(noAmount.decision, "review");
  assert.match(noAmount.reason, /geen bedrag/);
});

test("without OWN_NAMES, unknown senders are always reviewed", () => {
  const r = classify(msg({ from: "billing@hosting.example" }), { ...ctx, ownNames: [] });
  assert.equal(r.decision, "review");
  assert.match(r.reason, /senders\.conf/);
});

test("free-mail sender: only when the full address is listed", () => {
  assert.equal(classify(msg({ from: "someone@gmail.com" }), ctx).decision, "review");
  assert.equal(classify(msg({ from: "builder.jansen@gmail.com" }), ctx).decision, "forward");
});

test("guardrails: contract, quote, reminder, ID document are never forwarded, not even from a known supplier", () => {
  for (const subject of [
    "Contract hosting 2027 (factuur volgt)",
    "Offerte website",
    "Aanmaning factuur 118",
    "Herinnering: factuur",
  ]) {
    const r = classify(msg({ from: "noreply@notify.cloudflare.com", subject }), ctx);
    assert.equal(r.decision, "review", subject);
    assert.match(r.reason, /vangrail/);
  }
  assert.equal(
    classify(
      msg({
        from: "noreply@notify.cloudflare.com",
        filename: "overeenkomst-getekend.pdf",
        subject: "Factuur",
      }),
      ctx,
    ).decision,
    "review",
  );
  const id = classify(
    msg({
      from: "noreply@notify.cloudflare.com",
      pdfText: "Factuur\nPaspoort kopie\nGeboortedatum 01-01-1990",
    }),
    ctx,
  );
  assert.equal(id.decision, "review");
  const quote = classify(
    msg({
      from: "billing@hosting.example",
      subject: "Document Acme",
      pdfText: "OFFERTE\nOffertenummer 55\nTotaal € 500,00\nAcme\nnota",
    }),
    ctx,
  );
  assert.equal(quote.decision, "review");
});

test("unauthenticated sender (SPF/DKIM/DMARC) or a forged header: review", () => {
  const fail = classify(
    msg({
      from: "noreply@notify.cloudflare.com",
      auth: [
        "mx.google.com; dkim=fail; spf=softfail smtp.mailfrom=x@evil.test; dmarc=fail header.from=cloudflare.com",
      ],
    }),
    ctx,
  );
  assert.equal(fail.decision, "review");
  assert.match(fail.reason, /niet geverifieerd/);
  // a "pass" stamped by another server does not count; only the topmost header from the receiving server
  const spoof = classify(
    msg({
      from: "noreply@notify.cloudflare.com",
      auth: ["evil.example; dmarc=pass header.from=cloudflare.com"],
    }),
    ctx,
  );
  assert.equal(spoof.decision, "review");
});

test("own domain: sales only via the sender list and only when a sales address is configured", () => {
  const listed = classify(msg({ from: "invoices@acme.example", auth: [] }), ctx);
  assert.equal(listed.decision, "forward");
  assert.equal(listed.direction, "sales");
  const noSalesAddress = classify(msg({ from: "invoices@acme.example", auth: [] }), {
    ...ctx,
    exact: { purchase: EXACT.purchase, sales: null },
  });
  assert.equal(noSalesAddress.decision, "review");
  const colleague = classify(msg({ from: "office@acme.example" }), ctx);
  assert.equal(colleague.decision, "review");
  assert.match(colleague.reason, /eigen adres/);
  const spoofedOwn = classify(
    msg({
      from: "invoices@acme.example",
      auth: ["mx.google.com; dmarc=fail header.from=acme.example"],
    }),
    ctx,
  );
  assert.equal(spoofedOwn.decision, "review");
});

test("no PDF: review when it looks like an invoice, otherwise skip silently", () => {
  assert.equal(
    classify(
      msg({ from: "receipts@saas.example", subject: "Your receipt from SaaS", pdf: false }),
      ctx,
    ).decision,
    "review",
  );
  assert.equal(
    classify(msg({ from: "info@newsletter.example", subject: "Nieuws", pdf: false }), ctx).decision,
    "skip",
  );
});

test("PDF without invoice signal (CV, brochure) is skipped; an excluded sender with an invoice is reviewed", () => {
  assert.equal(
    classify(
      msg({
        from: "jan@company.example",
        subject: "Sollicitatie",
        filename: "cv.pdf",
        pdfText: "Curriculum vitae",
      }),
      ctx,
    ).decision,
    "skip",
  );
  const excl = classify(msg({ from: "policy@insurer.example", subject: "Uw nota" }), ctx);
  assert.equal(excl.decision, "review");
  assert.match(excl.reason, /uitsluitlijst/);
});

test("loops: own forwards, Exact itself and bounces are skipped", () => {
  assert.equal(
    classify(msg({ from: "noreply@notify.cloudflare.com", loop: true }), ctx).decision,
    "skip",
  );
  assert.equal(classify(msg({ from: "noreply@exactonline.nl" }), ctx).decision, "skip");
  assert.equal(classify(msg({ from: EXACT.purchase }), ctx).decision, "skip");
  assert.equal(classify(msg({ from: "mailer-daemon@googlemail.com" }), ctx).decision, "skip");
});

test("sender list: subdomains, exclude wins, free-mail domain refused, Dutch aliases", () => {
  const p = parseSenders(
    "purchase gmail.com Wrong\ninkoop example.com Ex\nuitsluiten bad.example.com No\nnonsense\n",
  );
  assert.equal(p.entries.length, 2);
  assert.equal(p.errors.length, 2);
  assert.equal(lookupSender(p.entries, "a@mail.example.com")?.name, "Ex");
  assert.equal(lookupSender(p.entries, "a@mail.example.com")?.direction, "purchase");
  assert.equal(lookupSender(p.entries, "a@bad.example.com")?.direction, "exclude");
  assert.equal(lookupSender(p.entries, "a@notexample.com"), null);
  assert.equal(orgDomain("mail.billing.ionos.co.uk"), "ionos.co.uk");
  assert.equal(checkAuth(AUTH_PASS("mail.stripe.com"), "invoice@stripe.com").ok, true);
});
