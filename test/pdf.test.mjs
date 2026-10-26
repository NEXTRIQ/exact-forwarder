import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { extractInvoiceFields } from "../src/extract.mjs";
import { looksLikePdf, pdfToText, sha256 } from "../src/pdf.mjs";
import { makePdf } from "./helpers.mjs";

const hasPdftotext = spawnSync("pdftotext", ["-v"]).error === undefined;

test("not a PDF: no text, clean error", async () => {
  assert.equal(looksLikePdf(Buffer.from("hallo")), false);
  assert.deepEqual(await pdfToText(Buffer.from("<html>")), { text: null, error: "geen geldige PDF" });
});

test("sha256 is stable per content", () => {
  const a = makePdf(["Factuur 1"]);
  assert.equal(sha256(a), sha256(Buffer.from(a)));
  assert.notEqual(sha256(a), sha256(makePdf(["Factuur 2"])));
});

test("pdftotext extracts number, date and amount from a real PDF", { skip: !hasPdftotext && "pdftotext not installed" }, async () => {
  const pdf = makePdf(["Factuur", "Factuurnummer: INV-2026-0042", "Factuurdatum: 20-10-2026", "Klant: Acme B.V.", "Totaal incl. btw: € 1.512,50"]);
  const { text, error } = await pdfToText(pdf);
  assert.equal(error, null);
  const f = extractInvoiceFields(text);
  assert.equal(f.number, "INV-2026-0042");
  assert.equal(f.date, "2026-10-20");
  assert.deepEqual(f.amount, { value: 1512.5, currency: "EUR" });
});

test("missing pdftotext: error instead of a crash", async () => {
  const r = await pdfToText(makePdf(["x"]), { bin: "/does/not/exist/pdftotext" });
  assert.equal(r.text, null);
  assert.equal(r.error, "pdftotext ontbreekt");
});
