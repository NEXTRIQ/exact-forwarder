// Sending through SMTP (587 with STARTTLS by default) as the configured mailbox.
// Hard allowlist: only the configured Exact scan addresses and the notification mailbox. Nothing read from an
// invoice or a mail can widen it.
import nodemailer from "nodemailer";
import { FORWARD_HEADER } from "./classify.js";
import type { ExactAddresses, OutgoingMail, Smtp } from "./types.js";

export interface SmtpOptions {
  readonly host: string;
  readonly port?: number;
  readonly user: string;
  readonly pass: string;
  /** RFC 5322 From, e.g. `exact-forwarder <invoices@example.com>`. */
  readonly from: string;
  readonly exact: ExactAddresses;
  readonly notifyEmail: string | null;
}

export function allowedRecipients(
  exact: ExactAddresses,
  notifyEmail: string | null,
): ReadonlySet<string> {
  const set = new Set<string>();
  for (const a of [exact.purchase, exact.sales]) if (a) set.add(a.toLowerCase());
  if (notifyEmail) set.add(notifyEmail.toLowerCase());
  return set;
}

export function assertAllowed(to: string, allowed: ReadonlySet<string>): void {
  const addr = to.trim().toLowerCase();
  if (!allowed.has(addr)) throw new Error(`recipient refused: ${addr} is not on the allowlist`);
}

export function createSmtp({
  host,
  port = 587,
  user,
  pass,
  from,
  exact,
  notifyEmail,
}: SmtpOptions): Smtp {
  const allowed = allowedRecipients(exact, notifyEmail);
  const transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    auth: { user, pass },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  });
  return {
    /** Always sets the loop header so we recognise our own mail. */
    async send(mail: OutgoingMail): Promise<void> {
      assertAllowed(mail.to, allowed);
      const info = await transport.sendMail({
        from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        attachments: mail.attachments ? [...mail.attachments] : undefined,
        headers: { [FORWARD_HEADER]: "1", "Auto-Submitted": "auto-generated" },
      });
      // SMTP reports accepted envelope recipients as plain strings; anything else cannot match.
      const accepted = (info.accepted ?? [])
        .filter((a): a is string => typeof a === "string")
        .map((a) => a.toLowerCase());
      if (!accepted.includes(mail.to.toLowerCase()))
        throw new Error("SMTP did not accept the recipient");
    },
    close: () => transport.close(),
  };
}
