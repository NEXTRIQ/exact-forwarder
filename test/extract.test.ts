import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractAmount,
  extractInvoiceDate,
  extractInvoiceNumber,
  formatAmount,
  parseNumber,
} from "../src/extract.js";

test("parseNumber: Dutch and English notation", () => {
  assert.equal(parseNumber("1.234,56"), 1234.56);
  assert.equal(parseNumber("1,234.56"), 1234.56);
  assert.equal(parseNumber("12,00"), 12);
  assert.equal(parseNumber("0.99"), 0.99);
  assert.equal(parseNumber("1 234,50"), 1234.5);
});

test("Dutch invoice: total incl. VAT, not the subtotal or the VAT line", () => {
  const text = `
    Factuur
    Factuurnummer:    2026-0142
    Factuurdatum:     14-10-2026
    Vervaldatum:      28-10-2026
    Omschrijving                         Bedrag
    Hosting oktober                    € 100,00
    Subtotaal                          € 100,00
    BTW 21%                             € 21,00
    Totaal incl. btw                   € 121,00
  `;
  assert.deepEqual(extractAmount(text), { value: 121, currency: "EUR" });
  assert.equal(extractInvoiceNumber(text), "2026-0142");
  assert.equal(extractInvoiceDate(text), "2026-10-14");
});

test("Dutch: 'Te betalen' beats a bare total; thousands separators", () => {
  const text = "Totaal excl. btw  EUR 1.000,00\nTotaal btw  EUR 210,00\nTe betalen  EUR 1.210,00";
  assert.deepEqual(extractAmount(text), { value: 1210, currency: "EUR" });
});

test("English Stripe receipt: amount paid, invoice number, month-name date", () => {
  const text = `
Receipt from Example Software Inc.
Receipt number 2045-1187
Invoice number  ABCD1234-0007
Date paid  October 12, 2026
Payment method  Visa - 4242
Subtotal   $25.00
Total      $25.00
Amount paid  $25.00
Amount due   $0.00
`;
  assert.deepEqual(extractAmount(text), { value: 25, currency: "USD" });
  assert.equal(extractInvoiceNumber(text), "ABCD1234-0007");
  assert.equal(extractInvoiceDate(text), "2026-10-12");
});

test("GBP with the currency after the amount and a date like 12 Oct 2026", () => {
  const text =
    "Invoice no. 202612345678\nInvoice date: 12 Oct 2026\nTotal amount   8.40 GBP\nVAT 20%  1.40 GBP";
  assert.deepEqual(extractAmount(text), { value: 8.4, currency: "GBP" });
  assert.equal(extractInvoiceNumber(text), "202612345678");
  assert.equal(extractInvoiceDate(text), "2026-10-12");
});

test("column layout: label above the value", () => {
  const text = [
    "Invoice number              Date of issue",
    "INV-77812                   2026-10-01",
    "",
    "Amount due",
    "€ 49,99",
  ].join("\n");
  assert.equal(extractInvoiceNumber(text), "INV-77812");
  assert.equal(extractInvoiceDate(text), "2026-10-01");
  assert.deepEqual(extractAmount(text), { value: 49.99, currency: "EUR" });
});

test("nothing found stays null; invoice number falls back to the subject", () => {
  assert.equal(extractAmount("Bedankt voor uw bestelling"), null);
  assert.equal(extractAmount(null), null);
  assert.equal(
    extractInvoiceNumber("geen nummer", "Your invoice #INV-2026-09 is ready"),
    "INV-2026-09",
  );
  assert.equal(extractInvoiceNumber("Invoice date 12-10-2026"), null);
  assert.equal(extractInvoiceDate("geen datum"), null);
  assert.equal(formatAmount(null), "bedrag niet gevonden");
  assert.equal(formatAmount({ value: 1234.5, currency: "EUR" }), "EUR 1.234,50");
});

test("IBANs and percentages are not amounts or invoice numbers", () => {
  const text = "Rekeningnummer NL91ABNA0417164300\nBTW 21%\nTotaal  € 60,50";
  assert.deepEqual(extractAmount(text), { value: 60.5, currency: "EUR" });
});

test("'Charges' below subtotal and VAT is the total", () => {
  const text = [
    "Pos. Service Charges Usage Net (£) VAT (%)",
    "1 Basic Fee £ 1.00 a month 1 mo. 1.00 20.0 %",
    "Subtotal (net.) £ 7.00",
    "+ VAT (20.0 %) £ 1.40",
    "Charges £ 8.40",
    "The total amount due will be charged to your card on file within the next seven days.",
  ].join("\n");
  assert.deepEqual(extractAmount(text), { value: 8.4, currency: "GBP" });
});

test("Stripe header: 'US$ x vervalt op' and '€x due October 1'", () => {
  assert.deepEqual(
    extractAmount("US$ 12,34 vervalt op 12 augustus 2026\nOnline betalen\nWorkers 1 US$ 5,00"),
    { value: 12.34, currency: "USD" },
  );
  assert.deepEqual(extractAmount("€20.00 due October 1, 2026\nPay online"), {
    value: 20,
    currency: "EUR",
  });
  assert.deepEqual(extractAmount("Verschuldigd bedrag   € 7,26"), { value: 7.26, currency: "EUR" });
});

test("invoice number and date: transaction id instead of VAT number, 'Uitgiftedatum', label alone above the value", () => {
  const github =
    "Date 2026-10-01 10:00AM PDT\nVAT/GST Registration   EU999999999\nNumber\n\nTransaction ID         ch_3PqR7xYz9AbC\nTotal $4.00";
  assert.equal(extractInvoiceNumber(github), "ch_3PqR7xYz9AbC");
  assert.equal(
    extractInvoiceDate(
      "Factuurnummer IN-12345678\nUitgiftedatum 12 augustus 2026\nVervaldatum 26 augustus 2026",
    ),
    "2026-08-12",
  );
  assert.equal(
    extractInvoiceDate("                         Factuurdatum\n31 aug. 2026"),
    "2026-08-31",
  );
});
