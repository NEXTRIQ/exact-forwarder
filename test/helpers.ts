// Test helpers: a minimal real PDF (Helvetica, WinAnsi) with the given lines, a fake mailbox and a fake SMTP.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Env } from "../src/config.js";
import type { ExactAddresses, MailMessage, Mailbox, OutgoingMail, Smtp } from "../src/types.js";

export function makePdf(lines: readonly string[]): Buffer {
  const esc = (s: string): string =>
    s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)").replace(/€/g, "\\200");
  const content = `BT /F1 11 Tf 50 800 Td 14 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(" ")} ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

export const tmpDir = (): string => mkdtempSync(join(tmpdir(), "exf-test-"));

export const EXACT = Object.freeze({
  purchase: "abc123@inkoop.exactonline.nl",
  sales: "abc123@verkoop.exactonline.nl",
}) satisfies ExactAddresses;
export const NOTIFY = "bookkeeping@acme.example";

/** Minimal valid environment for configFromEnv. */
export const BASE_ENV: Env = Object.freeze({
  MAIL_ACCOUNT: "invoices@acme.example",
  EXACT_PURCHASE_ADDRESS: EXACT.purchase,
  EXACT_SALES_ADDRESS: EXACT.sales,
  NOTIFY_EMAIL: NOTIFY,
  OWN_NAMES: "acme",
});

export const AUTH_PASS = (domain: string): string[] => [
  `mx.google.com; dkim=pass header.i=@${domain} header.s=s1; spf=pass (google.com: domain of billing@${domain}) smtp.mailfrom=billing@${domain}; dmarc=pass (p=REJECT) header.from=${domain}`,
];

/** A fake INBOX message that also carries the content of its attachments, by part. */
export interface FakeMessage extends MailMessage {
  readonly bodies: Readonly<Record<string, Buffer>>;
}

export interface FakeMessageInput {
  from: string;
  name?: string;
  subject: string;
  pdfs?: { buf: Buffer; filename?: string }[];
  date?: string;
  messageId?: string;
  auth?: string[];
  loop?: boolean;
}

let uidSeq = 100;
/** One fake message, optionally with PDF content (Buffer) per attachment. */
export function fakeMessage({
  from,
  name = "",
  subject,
  pdfs = [],
  date = "2026-10-25T10:00:00Z",
  messageId,
  auth,
  loop = false,
}: FakeMessageInput): FakeMessage {
  const uid = uidSeq++;
  const domain = from.split("@")[1] ?? "";
  return {
    uid,
    key: messageId ?? `<m${uid}@test>`,
    messageId: messageId ?? `<m${uid}@test>`,
    internalDate: new Date(date),
    from: { address: from, name },
    subject,
    authResults: auth ?? AUTH_PASS(domain),
    hasLoopHeader: loop,
    attachments: pdfs.map((p, i) => ({
      part: String(i + 2),
      contentType: "application/pdf",
      filename: p.filename ?? `factuur-${i}.pdf`,
      size: p.buf.length,
      disposition: "attachment",
    })),
    bodies: Object.fromEntries(pdfs.map((p, i) => [String(i + 2), p.buf])),
  };
}

export interface FakeMailbox extends Mailbox {
  readonly labels: { uid: number; label: string }[];
  readonly messages: FakeMessage[];
}

export function fakeMailbox(
  messages: FakeMessage[],
  { failConnect = false }: { failConnect?: boolean } = {},
): FakeMailbox {
  const labels: { uid: number; label: string }[] = [];
  return {
    labels,
    messages,
    connect: async () => {
      if (failConnect) throw new Error("Invalid credentials (Failure)");
    },
    close: async () => undefined,
    listInbox: async (since) =>
      messages.filter(
        (m) =>
          m.internalDate !== null && m.internalDate >= new Date(since.toISOString().slice(0, 10)),
      ),
    downloadFromInbox: async (uid, part) => {
      const buf = messages.find((m) => m.uid === uid)?.bodies[part];
      if (!buf) throw new Error(`no part ${part} in message ${uid}`);
      return buf;
    },
    addLabel: async (uid, label) => {
      labels.push({ uid, label });
    },
    listSentTo: async () => [],
  };
}

export interface FakeSmtp extends Smtp {
  readonly sent: OutgoingMail[];
}

export function fakeSmtp({
  fail = null,
}: { fail?: ((mail: OutgoingMail) => Error | null) | null } = {}): FakeSmtp {
  const sent: OutgoingMail[] = [];
  return {
    sent,
    send: async (mail) => {
      if (fail) {
        const e = fail(mail);
        if (e) throw e;
      }
      sent.push(mail);
    },
    close: () => undefined,
  };
}
