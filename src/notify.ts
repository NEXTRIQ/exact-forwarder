// Notices: text for Telegram and for the notification mailbox (pure functions), and sending to Telegram.
// Notices contain sender, subject and invoice fields, so they only go to channels the operator configured
// (a Telegram chat and/or a mailbox on an own domain). The journal only ever gets counts.
import type { ClassifyResult, ForwardResult } from "./classify.js";
import { formatAmount } from "./extract.js";
import type { ForwardRecord } from "./state.js";
import type { Currency, Direction, ExactAddresses, MailAddress, MailMessage } from "./types.js";

export const DIRECTION_NL: Readonly<Record<Direction, string>> = Object.freeze({
  purchase: "inkoop",
  sales: "verkoop",
});

export interface Notice {
  readonly telegram: string;
  readonly mailSubject: string;
  readonly mailText: string;
}

interface NoticeCommon {
  readonly msg: Pick<MailMessage, "from" | "subject">;
  readonly pdfCount: number;
  readonly exact: ExactAddresses;
}

/** A forwarded notice always has a direction; a review notice may not. */
export type NoticeInput = NoticeCommon &
  (
    | { readonly kind: "forwarded"; readonly result: ForwardResult }
    | { readonly kind: "review"; readonly result: ClassifyResult }
  );

/** Collapses whitespace and caps the length, so mail content cannot break the layout of a notice. */
const one = (s: string | null | undefined, max = 160): string =>
  (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const nlDate = (iso: string | null): string =>
  iso ? iso.split("-").reverse().join("-") : "niet gevonden";
const fromText = (from: MailAddress): string =>
  from.address
    ? `${one(from.name, 60) ? `${one(from.name, 60)} ` : ""}<${one(from.address, 80)}>`
    : "onbekend";

/** Notice for one message. */
export function composeNotice(input: NoticeInput): Notice {
  const { msg, result, pdfCount, exact } = input;
  const f = result.fields;
  const vendor = one(result.vendor, 60);
  const lines: string[] = [];
  let mailSubject: string;
  if (input.kind === "forwarded") {
    const dir = DIRECTION_NL[input.result.direction];
    lines.push(`Doorgestuurd naar Exact (${dir})`);
    mailSubject = `Exact: doorgestuurd (${dir}) - ${vendor}, ${formatAmount(f.amount)}`;
  } else {
    lines.push("Niet doorgestuurd naar Exact, controleer");
    lines.push(`Reden: ${one(result.reason, 300)}`);
    mailSubject = `Exact: niet doorgestuurd, controleer - ${vendor}`;
  }
  lines.push(
    `Leverancier/afzender: ${vendor} ${fromText(msg.from)}`,
    `Factuurnummer: ${f.number ?? "niet gevonden"}`,
    `Factuurdatum: ${nlDate(f.date)}`,
    `Bedrag incl. btw: ${formatAmount(f.amount)}`,
    `Onderwerp: ${one(msg.subject, 200) || "(geen onderwerp)"}`,
    `PDF-bijlagen: ${pdfCount}`,
  );
  if (input.kind === "forwarded" && result.newSender)
    lines.push("Let op: nieuwe afzender. Klopt het, zet hem dan in senders.conf.");
  if (input.kind === "review") {
    const targets: string[] = [];
    if (exact.purchase) targets.push(`${exact.purchase} (inkoop)`);
    if (exact.sales) targets.push(`${exact.sales} (verkoop)`);
    lines.push(`Is het wel een factuur? Stuur hem zelf door naar ${targets.join(" of ")}.`);
  }
  const text = lines.join("\n");
  return {
    telegram: text,
    mailSubject: one(mailSubject, 180),
    mailText: `${text}\n\n-- exact-forwarder\n`,
  };
}

/** One-line daily summary, only when something was forwarded today. */
export function composeDailySummary(
  forwardsToday: readonly ForwardRecord[],
  reviewsToday = 0,
): string | null {
  if (!forwardsToday.length) return null;
  const dir: Record<Direction, number> = { purchase: 0, sales: 0 };
  // Insertion-ordered, so currencies are listed in the order they first occur.
  const totals = new Map<Currency | null, number>();
  let unknown = 0;
  for (const f of forwardsToday) {
    dir[f.direction] += 1;
    if (f.value == null) unknown++;
    else totals.set(f.currency ?? null, (totals.get(f.currency ?? null) ?? 0) + f.value);
  }
  const money = [...totals]
    .map(([currency, value]) => formatAmount({ currency, value }))
    .join(" + ");
  return (
    `Exact vandaag: ${forwardsToday.length} ${forwardsToday.length === 1 ? "factuur" : "facturen"} doorgestuurd ` +
    `(inkoop ${dir.purchase}, verkoop ${dir.sales})${money ? `, samen ${money}` : ""}` +
    `${unknown ? `, ${unknown} zonder gevonden bedrag` : ""}; ${reviewsToday} ter controle.`
  );
}

export interface TelegramTarget {
  readonly token: string;
  readonly chatId: string;
  readonly fetchImpl?: typeof fetch;
}

/** Sends plain text to Telegram. Throws on failure; never logs the URL, because it carries the token. */
export async function sendTelegram(
  { token, chatId, fetchImpl = fetch }: TelegramTarget,
  text: string,
): Promise<void> {
  if (!token || !chatId) throw new Error("TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing");
  const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text.slice(0, 3900),
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Telegram responded ${res.status}`);
}
