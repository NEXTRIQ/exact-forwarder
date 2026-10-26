// Notices: text for Telegram and for the notification mailbox (pure functions), and sending to Telegram.
// Notices contain sender, subject and invoice fields, so they only go to channels the operator configured
// (a Telegram chat and/or a mailbox on an own domain). The journal only ever gets counts.
import { formatAmount } from "./extract.mjs";

export const DIRECTION_NL = Object.freeze({ purchase: "inkoop", sales: "verkoop" });

const one = (s, max = 160) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
const nlDate = (iso) => (iso ? iso.split("-").reverse().join("-") : "niet gevonden");
const fromText = (from) => (from?.address ? `${one(from.name, 60) ? `${one(from.name, 60)} ` : ""}<${one(from.address, 80)}>` : "onbekend");

/** Notice for one message. kind: forwarded | review. Returns { telegram, mailSubject, mailText }. */
export function composeNotice(kind, { msg, result, pdfCount, exact }) {
  const f = result.fields ?? {};
  const vendor = one(result.vendor, 60);
  const dir = DIRECTION_NL[result.direction];
  const lines = [];
  let mailSubject;
  if (kind === "forwarded") {
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
  if (kind === "forwarded" && result.newSender) lines.push("Let op: nieuwe afzender. Klopt het, zet hem dan in senders.conf.");
  if (kind === "review") {
    const targets = [exact?.purchase && `${exact.purchase} (inkoop)`, exact?.sales && `${exact.sales} (verkoop)`].filter(Boolean);
    lines.push(`Is het wel een factuur? Stuur hem zelf door naar ${targets.join(" of ")}.`);
  }
  const text = lines.join("\n");
  return { telegram: text, mailSubject: one(mailSubject, 180), mailText: `${text}\n\n-- exact-forwarder\n` };
}

/** One-line daily summary, only when something was forwarded today. */
export function composeDailySummary(forwardsToday, reviewsToday = 0) {
  if (!forwardsToday.length) return null;
  const dir = { purchase: 0, sales: 0 };
  const totals = {};
  let unknown = 0;
  for (const f of forwardsToday) {
    dir[f.direction] = (dir[f.direction] ?? 0) + 1;
    if (f.value == null) unknown++;
    else totals[f.currency ?? "?"] = (totals[f.currency ?? "?"] ?? 0) + f.value;
  }
  const money = Object.entries(totals)
    .map(([c, v]) => formatAmount({ currency: c === "?" ? null : c, value: v }))
    .join(" + ");
  return (
    `Exact vandaag: ${forwardsToday.length} ${forwardsToday.length === 1 ? "factuur" : "facturen"} doorgestuurd ` +
    `(inkoop ${dir.purchase}, verkoop ${dir.sales})${money ? `, samen ${money}` : ""}` +
    `${unknown ? `, ${unknown} zonder gevonden bedrag` : ""}; ${reviewsToday} ter controle.`
  );
}

/** Sends plain text to Telegram. Throws on failure; never logs the URL, because it carries the token. */
export async function sendTelegram({ token, chatId, fetchImpl = fetch }, text) {
  if (!token || !chatId) throw new Error("TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing");
  const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 3900), disable_web_page_preview: true }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Telegram responded ${res.status}`);
}
