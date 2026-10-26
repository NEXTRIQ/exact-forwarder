// Sending through SMTP (587 with STARTTLS by default) as the configured mailbox.
// Hard allowlist: only the configured Exact scan addresses and the notification mailbox. Nothing read from an
// invoice or a mail can widen it.
import nodemailer from "nodemailer";
import { FORWARD_HEADER } from "./classify.mjs";

export function allowedRecipients(exact, notifyEmail) {
  const set = new Set(Object.values(exact ?? {}).filter(Boolean).map((a) => a.toLowerCase()));
  if (notifyEmail) set.add(String(notifyEmail).toLowerCase());
  return set;
}

export function assertAllowed(to, allowed) {
  const addr = String(to ?? "").trim().toLowerCase();
  if (!allowed.has(addr)) throw new Error(`recipient refused: ${addr} is not on the allowlist`);
}

export function createSmtp({ host, port = 587, user, pass, from, exact, notifyEmail }) {
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
    /** mail: { to, subject, text, attachments? }. Always sets the loop header so we recognise our own mail. */
    async send(mail) {
      assertAllowed(mail.to, allowed);
      const info = await transport.sendMail({
        from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        attachments: mail.attachments,
        headers: { [FORWARD_HEADER]: "1", "Auto-Submitted": "auto-generated" },
      });
      if (!info.accepted?.map((a) => String(a).toLowerCase()).includes(String(mail.to).toLowerCase()))
        throw new Error("SMTP did not accept the recipient");
      return true;
    },
    close: () => transport.close(),
  };
}
