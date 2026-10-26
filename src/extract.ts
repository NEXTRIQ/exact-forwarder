// Extracts the total amount (incl. VAT), invoice number and invoice date from the text of an invoice PDF
// (output of `pdftotext -layout`). Pure functions, no I/O. Handles Dutch and English invoices. Whatever cannot be
// found reliably stays null ("niet gevonden"); it never guesses.
//
// Capture groups that a pattern makes mandatory are read with `?? ""`: noUncheckedIndexedAccess cannot know
// they are always present, and the fallback is never used.
import type { Amount, Currency, InvoiceFields } from "./types.js";

const CUR_RE = "(?:€|EUR|GBP|£|USD|US\\$|\\$)";
// Amount with exactly two decimals; thousands separated by dot, comma, (narrow) no-break space or apostrophe.
const NUM_RE = "(?:\\d{1,3}(?:[.,\\u00a0\\u202f'’]\\d{3})+|\\d+)[.,]\\d{2}(?![\\d%])";
const AMOUNT_RE = (): RegExp =>
  new RegExp(`(?:(${CUR_RE})\\s?)?(-\\s?)?(${NUM_RE})(?:\\s?(${CUR_RE}))?`, "g");

const CURRENCY_OF: Readonly<Record<string, Currency>> = {
  "€": "EUR",
  EUR: "EUR",
  "£": "GBP",
  GBP: "GBP",
  $: "USD",
  US$: "USD",
  USD: "USD",
};

/** An amount found in text, with its position (for ordering) and its currency when one is attached. */
export interface FoundAmount extends Amount {
  readonly index: number;
}

/** "1.234,56" / "1,234.56" / "12,00" / "1 234,56" (also with a no-break space) -> Number. */
export function parseNumber(s: string): number {
  // A plain space is dropped; every other separator (no-break spaces, apostrophes) becomes "|".
  const clean = s.replace(/[\u00a0\u202f'\u2019\s]/g, (c) => (c === " " ? "" : "|"));
  const lastSep = Math.max(clean.lastIndexOf("."), clean.lastIndexOf(","));
  if (lastSep < 0) return Number(clean.replace(/\|/g, ""));
  const int = clean.slice(0, lastSep).replace(/[.,|]/g, "");
  const dec = clean.slice(lastSep + 1);
  return Number(`${int || "0"}.${dec}`);
}

/** Lower case without diacritics, for matching labels. */
const fold = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

/** All amounts in a piece of text, with their currency when one is attached. */
export function findAmounts(text: string): FoundAmount[] {
  const out: FoundAmount[] = [];
  for (const m of text.matchAll(AMOUNT_RE())) {
    // no percentages, no fragment of a date or number (e.g. 2026.10)
    const before = text[m.index - 1] ?? "";
    if (/[\d/]/.test(before)) continue;
    const cur = m[1] ?? m[4] ?? null;
    let value = parseNumber(m[3] ?? "");
    if (m[2]) value = -value;
    if (!Number.isFinite(value)) continue;
    out.push({ value, currency: cur ? (CURRENCY_OF[cur] ?? null) : null, index: m.index });
  }
  return out;
}

// Lines that carry the grand total. Tier 1 = explicit total incl. VAT or amount due; tier 2 = a bare "total".
const TIER1 = [
  /\b(totaal|total)\b[^\n]*\b(incl|inclusief|including|inc)\b/,
  /\btotaal\s*(te\s*betalen|bedrag)\b/,
  /\b(te\s*betalen|te\s*voldoen|factuurbedrag|totaalbedrag|totaal\s*factuur)\b/,
  /\b(amount\s*(due|paid|payable|charged)|total\s*(due|amount|payable|paid|charged)|balance\s*due|grand\s*total|invoice\s*total)\b/,
  /\b(betaald\s*bedrag|bedrag\s*betaald|verschuldigd(\s*bedrag)?)\b/,
  /^\s*(total\s*)?charges\b/, // e.g. "Charges £ 9.99" below the subtotal and VAT lines
  // Stripe header: "US$ 12,34 vervalt op 1 september 2026" / "€20.00 due October 1, 2026"
  /\b(vervalt\s*op|due\s*(on|by)\b|due\s*(\d|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))/,
];
const TIER2 = [/\b(totaal|total)\b/];
const NOT_TOTAL =
  /\b(sub\s*-?\s*tota\w*|excl\w*|exclusive|zonder\s*btw|before\s*tax|netto|net\s*total|btw\s*%|vat\s*%|tax\s*rate)\b/;
const VAT_ONLY = /\b(btw|vat|tax|omzetbelasting)\b/;
const INCL = /\b(incl\w*|inc)\b/;
const CUR_WORDS = /\b(EUR|GBP|USD)\b/g;

/** 0 = not a total line, 1 = explicit total incl. VAT or amount due, 2 = a bare "total". */
type Tier = 0 | 1 | 2;

function tierOf(lineFolded: string): Tier {
  if (NOT_TOTAL.test(lineFolded)) return 0;
  // "Totaal btw" / "Total VAT" is the VAT amount, not the total (unless it says "incl.")
  if (VAT_ONLY.test(lineFolded) && !INCL.test(lineFolded)) return 0;
  if (TIER1.some((r) => r.test(lineFolded))) return 1;
  if (TIER2.some((r) => r.test(lineFolded))) return 2;
  return 0;
}

/** The currency that occurs most often in the document (for amounts without their own symbol). */
export function dominantCurrency(text: string): Currency | null {
  const counts: [Currency, number][] = [
    ["EUR", (text.match(/€|\bEUR\b/g) ?? []).length],
    ["GBP", (text.match(/£|\bGBP\b/g) ?? []).length],
    ["USD", (text.match(/US\$|\bUSD\b|\$/g) ?? []).length],
  ];
  // Ties go to the first entry, in the order above.
  const [currency, count] = counts.reduce((a, b) => (b[1] > a[1] ? b : a));
  return count > 0 ? currency : null;
}

/** Total amount incl. VAT, or null. */
export function extractAmount(text: string | null | undefined): Amount | null {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  const cands: Record<1 | 2, FoundAmount[]> = { 1: [], 2: [] };
  for (const [i, line] of lines.entries()) {
    const tier = tierOf(fold(line));
    if (!tier) continue;
    let found = findAmounts(line);
    // label on this line, amount on the next (column layout)
    for (let j = 1; found.length === 0 && j <= 2; j++) {
      const next = lines[i + j];
      if (next === undefined) break;
      if (tierOf(fold(next)) === 0 && !/[a-z]{4,}/i.test(next.replace(CUR_WORDS, "")))
        found = findAmounts(next);
    }
    cands[tier].push(...found);
  }
  const doc = dominantCurrency(text);
  for (const tier of [1, 2] as const) {
    const pos = cands[tier].filter((a) => a.value > 0);
    const pool = pos.length ? pos : cands[tier];
    if (!pool.length) continue;
    const best = pool.reduce((a, b) => (b.value > a.value ? b : a));
    return { value: best.value, currency: best.currency ?? doc };
  }
  return null;
}

// ---------------------------------------------------------------- invoice number

const NUMBER_LABELS = [
  /\b(factuur\s*-?\s*(nummer|nr|no|number|#)|factuurnummer|factuurnr|invoice\s*(number|no|nr|id|#)|creditnota\s*-?\s*(nummer|nr)|credit\s*note\s*(number|no))\b\.?/i,
  /\b(receipt\s*(number|no|nr|#)|nota\s*-?\s*(nummer|nr)|notanummer|document\s*(number|nummer|nr))\b\.?/i,
  /\b(invoice|factuur|receipt|nota)\b(?!\s*(date|datum|to|aan|for|voor|from|van|address|adres))/i,
  // Receipts without an invoice number: the transaction id. A bare "Number" is often the tail of
  // "VAT Number" and is deliberately not used.
  /\b(transaction\s*id|transactie\s*-?\s*id|transactienummer)\b/i,
];
const TOKEN_RE = /[A-Z0-9][A-Z0-9\-/._]{1,40}/gi;

function looksLikeDate(tok: string): boolean {
  return /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/.test(tok);
}
function validNumberToken(tok: string): string | null {
  const t = tok.replace(/[._\-/]+$/, "");
  if (t.length < 3 || !/\d/.test(t)) return null;
  if (looksLikeDate(t)) return null;
  if (/^\d+[.,]\d{2}$/.test(t)) return null; // an amount
  return t;
}
function firstToken(s: string): string | null {
  // only the first token right after the label counts; anything else is something else
  const [m] = s.matchAll(TOKEN_RE);
  return m ? validNumberToken(m[0]) : null;
}

/** Invoice number from the PDF text, falling back to the subject. */
export function extractInvoiceNumber(text: string | null | undefined, subject = ""): string | null {
  const lines = (text ?? "").split(/\r?\n/);
  for (const label of NUMBER_LABELS) {
    for (const [i, line] of lines.entries()) {
      const m = label.exec(line);
      if (!m) continue;
      const after = line.slice(m.index + m[0].length);
      const rest = after.replace(/^[\s:#.]*/, "");
      const same = firstToken(rest);
      if (same) return same;
      if (rest.trim() === "" || /^\s{2,}/.test(after)) {
        // value in the same column on the next line(s); when the label stands alone, the whole next line
        const col = Math.max(0, m.index - 2);
        for (const next of [lines[i + 1] ?? "", lines[i + 2] ?? ""]) {
          const below =
            firstToken(next.slice(col).replace(/^\s*/, "")) ??
            (rest.trim() === "" ? firstToken(next.trim()) : null);
          if (below) return below;
        }
      }
    }
  }
  const s =
    /\b(factuur|invoice|receipt|nota)\b\s*(nr|no|number|nummer)?\.?\s*[:#]?\s*([A-Z0-9][A-Z0-9\-/._]{2,40})/i.exec(
      subject,
    );
  if (s) {
    const v = validNumberToken(s[3] ?? "");
    if (v) return v;
  }
  return null;
}

// ---------------------------------------------------------------- invoice date

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  januari: 1,
  january: 1,
  feb: 2,
  februari: 2,
  february: 2,
  mrt: 3,
  maart: 3,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  mei: 5,
  may: 5,
  jun: 6,
  juni: 6,
  june: 6,
  jul: 7,
  juli: 7,
  july: 7,
  aug: 8,
  augustus: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  okt: 10,
  oktober: 10,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};
const MONTH_RE = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join("|");

/** Year, month and day as captured; validated (and converted) by isoDate. */
type DateParts = readonly [
  string | number | undefined,
  string | number | undefined,
  string | number | undefined,
];

const monthOf = (name: string | undefined): number | undefined =>
  MONTHS[(name ?? "").toLowerCase()];

const DATE_PATTERNS: readonly { re: RegExp; f: (m: RegExpExecArray) => DateParts }[] = [
  { re: /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/, f: (m) => [m[1], m[2], m[3]] },
  {
    re: /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/,
    f: (m) => {
      const a = Number(m[1]);
      const b = Number(m[2]);
      // Dutch order (day-month), unless that is impossible (US month/day)
      return b > 12 && a <= 12 ? [m[3], a, b] : [m[3], b, a];
    },
  },
  {
    re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_RE})\\.?,?\\s+(\\d{4})\\b`, "i"),
    f: (m) => [m[3], monthOf(m[2]), m[1]],
  },
  {
    re: new RegExp(`\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "i"),
    f: (m) => [m[3], monthOf(m[1]), m[2]],
  },
];

function isoDate([y, mo, d]: DateParts): string | null {
  const Y = Number(y);
  const M = Number(mo);
  const D = Number(d);
  if (!(Y >= 2000 && Y <= 2100 && M >= 1 && M <= 12 && D >= 1 && D <= 31)) return null;
  const dt = new Date(Date.UTC(Y, M - 1, D));
  if (dt.getUTCMonth() !== M - 1) return null;
  return `${Y}-${String(M).padStart(2, "0")}-${String(D).padStart(2, "0")}`;
}

/** First date in a piece of text as YYYY-MM-DD. */
export function findDate(s: string): string | null {
  let best: { iso: string; index: number } | null = null;
  for (const p of DATE_PATTERNS) {
    const m = p.re.exec(s);
    if (!m) continue;
    const iso = isoDate(p.f(m));
    if (iso && (best === null || m.index < best.index)) best = { iso, index: m.index };
  }
  return best?.iso ?? null;
}

const DATE_LABELS = [
  /\b(factuurdatum|datum\s*factuur|factuur\s*datum|uitgiftedatum|datum\s*van\s*uitgifte|invoice\s*date|date\s*of\s*issue|issue\s*date|date\s*issued|issued\s*on|date\s*paid|betaaldatum|notadatum)\b/i,
  /\b(datum|date)\b/i,
];
const GENERIC_DATE_LABEL = DATE_LABELS[1];
// A generic "Datum"/"Date" label preceded by one of these words is a due, delivery or birth date.
const NOT_INVOICE_DATE =
  /\b(verval\w*|due|leverdatum|delivery|period|periode|tot|until|expir\w*|geboorte\w*)\b/i;

/** Invoice date as YYYY-MM-DD, or null. */
export function extractInvoiceDate(text: string | null | undefined): string | null {
  const lines = (text ?? "").split(/\r?\n/);
  for (const label of DATE_LABELS) {
    for (const [i, line] of lines.entries()) {
      const m = label.exec(line);
      if (!m) continue;
      const end = m.index + m[0].length;
      if (
        label === GENERIC_DATE_LABEL &&
        NOT_INVOICE_DATE.test(line.slice(Math.max(0, m.index - 15), end))
      )
        continue;
      const same = findDate(line.slice(end, end + 40));
      if (same) return same;
      const col = Math.max(0, m.index - 2);
      const alone = line.slice(end).trim() === "";
      for (const next of [lines[i + 1] ?? "", lines[i + 2] ?? ""]) {
        const below = findDate(next.slice(col, col + 40)) ?? (alone ? findDate(next) : null);
        if (below) return below;
      }
    }
  }
  return null;
}

/** Everything at once. */
export function extractInvoiceFields(text: string | null | undefined, subject = ""): InvoiceFields {
  return {
    amount: extractAmount(text),
    number: extractInvoiceNumber(text, subject),
    date: extractInvoiceDate(text),
  };
}

/** "EUR 1.234,56" (Dutch notation) or "bedrag niet gevonden". */
export function formatAmount(amount: Amount | null | undefined): string {
  if (!amount) return "bedrag niet gevonden";
  const n = new Intl.NumberFormat("nl-NL", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount.value);
  return `${amount.currency ?? "valuta onbekend"} ${n}`;
}
