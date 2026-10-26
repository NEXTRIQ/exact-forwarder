import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError, configFromEnv } from "../src/config.mjs";
import { runOnce, seed } from "../src/main.mjs";
import { sha256 } from "../src/pdf.mjs";
import { allowedRecipients, assertAllowed } from "../src/smtp.mjs";
import { emptyState, loadState, readStatus, saveState } from "../src/state.mjs";
import { BASE_ENV, EXACT, NOTIFY, fakeMailbox, fakeMessage, fakeSmtp, makePdf, tmpDir } from "./helpers.mjs";

// Fake pdftotext: returns the lines that makePdf wrote.
const pdfText = async (buf) => ({
  text: [...buf.toString("latin1").matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map((m) => m[1].replace(/\\200/g, "€").replace(/\\(.)/g, "$1")).join("\n"),
  error: null,
});

const INVOICE = (nr, amount = "€ 24,20") => makePdf(["Factuur", `Factuurnummer: ${nr}`, "Factuurdatum: 24-10-2026", "Aan: Acme B.V.", `Totaal incl. btw ${amount}`]);

function setup({ env = {}, cutoff = "2026-10-24T19:30:00Z", senders = "purchase notify.cloudflare.com Cloudflare\n" } = {}) {
  const dir = tmpDir();
  writeFileSync(join(dir, "senders.conf"), senders);
  const cfg = configFromEnv({ ...BASE_ENV, STATE_DIR: dir, SENDERS_FILE: join(dir, "senders.conf"), PAUSE_FILE: join(dir, "PAUSE"), ...env });
  if (cutoff) saveState(dir, { ...emptyState(), cutoff });
  return { dir, cfg };
}
const deps = (mailbox, smtp, telegram, now = new Date("2026-10-25T11:00:00Z")) => ({ mailbox, smtp, telegram, pdfText, now, log: () => undefined });
const tg = () => {
  const out = [];
  const f = async (t) => out.push(t);
  f.out = out;
  return f;
};
const toExact = (smtp) => smtp.sent.filter((x) => x.to === EXACT.purchase);

test("invoice from a known supplier: forwarded to purchase, labelled, notified on both channels", async () => {
  const { dir, cfg } = setup();
  const m = fakeMessage({ from: "noreply@notify.cloudflare.com", name: "Cloudflare", subject: "Your Cloudflare invoice", pdfs: [{ buf: INVOICE("F-1") }] });
  const box = fakeMailbox([m]);
  const smtp = fakeSmtp();
  const t = tg();
  const s = await runOnce(cfg, deps(box, smtp, t));
  assert.equal(s.forward, 1);
  assert.equal(s.ok, true);
  assert.equal(toExact(smtp).length, 1);
  assert.equal(toExact(smtp)[0].attachments.length, 1);
  assert.equal(toExact(smtp)[0].attachments[0].contentType, "application/pdf");
  assert.deepEqual(box.labels, [{ uid: m.uid, label: "Exact/doorgestuurd" }]);
  assert.equal(t.out.length, 1);
  assert.match(t.out[0], /Doorgestuurd naar Exact \(inkoop\)/);
  assert.match(t.out[0], /Factuurnummer: F-1/);
  assert.match(t.out[0], /Factuurdatum: 24-10-2026/);
  assert.match(t.out[0], /EUR 24,20/);
  assert.match(t.out[0], /Onderwerp: Your Cloudflare invoice/);
  const notice = smtp.sent.filter((x) => x.to === NOTIFY);
  assert.equal(notice.length, 1);
  assert.match(notice[0].subject, /Exact: doorgestuurd \(inkoop\) - Cloudflare, EUR 24,20/);
  const st = readStatus(dir);
  assert.equal(st.lastError, null);
  assert.equal(st.lastOkAt, st.lastRunAt);
  assert.equal((statSync(join(dir, "status.json")).mode & 0o777).toString(8), "644");
  assert.equal((statSync(join(dir, "state.json")).mode & 0o777).toString(8), "600");
  // the state file holds no subjects or addresses
  assert.doesNotMatch(readFileSync(join(dir, "state.json"), "utf8"), /cloudflare invoice|notify\.cloudflare/i);
});

test("only the configured channels are used", async () => {
  const { cfg } = setup({ env: { NOTIFY_EMAIL: "" } });
  const m = fakeMessage({ from: "noreply@notify.cloudflare.com", subject: "Invoice", pdfs: [{ buf: INVOICE("C-1") }] });
  const smtp = fakeSmtp();
  const t = tg();
  await runOnce(cfg, deps(fakeMailbox([m]), smtp, t));
  assert.equal(t.out.length, 1);
  assert.deepEqual(smtp.sent.map((x) => x.to), [EXACT.purchase]);
});

test("dedup: second run does nothing; the same PDF in another mail is reviewed, not resent", async () => {
  const { cfg } = setup();
  const pdf = INVOICE("F-2");
  const m1 = fakeMessage({ from: "noreply@notify.cloudflare.com", subject: "Invoice", pdfs: [{ buf: pdf }] });
  const box = fakeMailbox([m1]);
  const smtp = fakeSmtp();
  await runOnce(cfg, deps(box, smtp, tg()));
  const again = await runOnce(cfg, deps(box, smtp, tg()));
  assert.equal(again.new, 0);
  box.messages.push(fakeMessage({ from: "noreply@notify.cloudflare.com", subject: "Invoice (copy)", pdfs: [{ buf: Buffer.from(pdf) }], date: "2026-10-25T10:30:00Z" }));
  const t = tg();
  const third = await runOnce(cfg, deps(box, smtp, t));
  assert.equal(third.duplicate, 1);
  assert.equal(toExact(smtp).length, 1);
  assert.match(t.out[0], /Niet doorgestuurd.*\nReden: dezelfde PDF is al doorgestuurd/);
});

test("only mail after the cutoff; without seed a real run refuses", async () => {
  const { cfg } = setup();
  const old = fakeMessage({ from: "noreply@notify.cloudflare.com", subject: "Invoice", pdfs: [{ buf: INVOICE("F-OLD") }], date: "2026-10-24T18:00:00Z" });
  const s = await runOnce(cfg, deps(fakeMailbox([old]), fakeSmtp(), tg()));
  assert.equal(s.scanned, 0);
  const fresh = setup({ cutoff: null });
  await assert.rejects(runOnce(fresh.cfg, deps(fakeMailbox([]), fakeSmtp(), tg())), /run `exact-forwarder seed` first/);
  assert.match(readStatus(fresh.dir).lastError, /not initialised/);
});

test("doubt: notice with reason, nothing to Exact", async () => {
  const { cfg } = setup();
  const m = fakeMessage({ from: "someone@gmail.com", subject: "factuur klus", pdfs: [{ buf: INVOICE("K-1") }] });
  const smtp = fakeSmtp();
  const t = tg();
  const s = await runOnce(cfg, deps(fakeMailbox([m]), smtp, t));
  assert.equal(s.review, 1);
  assert.equal(smtp.sent.filter((x) => x.to.includes("exactonline")).length, 0);
  assert.match(t.out[0], /Reden: onbekende afzender met een persoonlijk mailadres/);
  assert.match(t.out[0], new RegExp(`zelf door naar ${EXACT.purchase} \\(inkoop\\) of ${EXACT.sales} \\(verkoop\\)`));
  assert.match(smtp.sent[0].subject, /niet doorgestuurd, controleer/);
});

test("DRY_RUN: logs counts only, sends nothing and writes no state", async () => {
  const { dir, cfg } = setup({ env: { DRY_RUN: "1" } });
  const before = readFileSync(join(dir, "state.json"), "utf8");
  const box = fakeMailbox([
    fakeMessage({ from: "noreply@notify.cloudflare.com", subject: "Invoice", pdfs: [{ buf: INVOICE("D-1") }] }),
    fakeMessage({ from: "someone@gmail.com", subject: "factuur", pdfs: [{ buf: INVOICE("D-2") }] }),
    fakeMessage({ from: "news@example.org", subject: "Nieuwsbrief" }),
  ]);
  const lines = [];
  const t = tg();
  const s = await runOnce(cfg, { ...deps(box, null, t), log: (l) => lines.push(l) });
  assert.deepEqual([s.forward, s.review, s.skip], [1, 1, 1]);
  assert.equal(t.out.length, 0);
  assert.equal(box.labels.length, 0);
  assert.equal(readFileSync(join(dir, "state.json"), "utf8"), before);
  assert.equal(lines.map((l) => JSON.parse(l)).filter((l) => l.dry).length, 3);
  assert.doesNotMatch(lines.join("\n"), /gmail|cloudflare\.com|Nieuwsbrief/);
  assert.equal(readStatus(dir).dryRun, true);
});

test("MAX_PER_RUN guardrail: too many invoices in one run means nothing is sent, plus an alarm", async () => {
  const { cfg } = setup({ env: { MAX_PER_RUN: "2" } });
  const msgs = [1, 2, 3].map((i) => fakeMessage({ from: "noreply@notify.cloudflare.com", subject: `Invoice ${i}`, pdfs: [{ buf: INVOICE(`C-${i}`) }] }));
  const smtp = fakeSmtp();
  const t = tg();
  const s = await runOnce(cfg, deps(fakeMailbox(msgs), smtp, t));
  assert.equal(s.forward, 0);
  assert.equal(s.capped, 3);
  assert.equal(s.ok, false);
  assert.equal(toExact(smtp).length, 0);
  assert.match(t.out[0], /ALARM exact-forwarder: 3 facturen in één run/);
});

test("interrupted send: never resent, but reported", async () => {
  const { dir, cfg } = setup();
  const m = fakeMessage({ from: "noreply@notify.cloudflare.com", subject: "Invoice", pdfs: [{ buf: INVOICE("P-1") }] });
  // SMTP timeout during DATA: unknown whether it went out
  const timeout = Object.assign(new Error("Timeout"), { code: "ETIMEDOUT", command: "DATA" });
  const s1 = await runOnce(cfg, deps(fakeMailbox([m]), fakeSmtp({ fail: (mail) => (mail.to === EXACT.purchase ? timeout : null) }), tg()));
  assert.equal(s1.ok, false);
  assert.ok(loadState(dir).pending[m.key]);
  const smtp = fakeSmtp();
  const t = tg();
  await runOnce(cfg, deps(fakeMailbox([m]), smtp, t));
  assert.equal(toExact(smtp).length, 0);
  assert.match(t.out[0], /onderbroken/);
  // a definite refusal (login failed) simply retries
  const b = setup();
  const m2 = fakeMessage({ from: "noreply@notify.cloudflare.com", subject: "Invoice", pdfs: [{ buf: INVOICE("P-2") }] });
  const auth = Object.assign(new Error("Invalid login"), { code: "EAUTH" });
  await runOnce(b.cfg, deps(fakeMailbox([m2]), fakeSmtp({ fail: () => auth }), tg()));
  assert.equal(loadState(b.dir).pending[m2.key], undefined);
  const smtp2 = fakeSmtp();
  await runOnce(b.cfg, deps(fakeMailbox([m2]), smtp2, tg()));
  assert.equal(toExact(smtp2).length, 1);
});

test("IMAP failure: lastOkAt stays, lastError is set (staleness-based monitoring)", async () => {
  const { dir, cfg } = setup();
  await runOnce(cfg, deps(fakeMailbox([]), fakeSmtp(), tg(), new Date("2026-10-25T10:00:00Z")));
  const okAt = readStatus(dir).lastOkAt;
  const s = await runOnce(cfg, deps(fakeMailbox([], { failConnect: true }), fakeSmtp(), tg(), new Date("2026-10-25T10:15:00Z")));
  assert.equal(s.ok, false);
  const st = readStatus(dir);
  assert.equal(st.lastOkAt, okAt);
  assert.equal(st.lastRunAt, "2026-10-25T10:15:00.000Z");
  assert.match(st.lastError, /IMAP: Invalid credentials/);
});

test("notification channel down: the forward stands, the notice follows next run", async () => {
  const { cfg } = setup();
  const m = fakeMessage({ from: "noreply@notify.cloudflare.com", subject: "Invoice", pdfs: [{ buf: INVOICE("T-1") }] });
  const smtp = fakeSmtp();
  const broken = async () => {
    throw new Error("Telegram responded 502");
  };
  const s1 = await runOnce(cfg, deps(fakeMailbox([m]), smtp, broken));
  assert.equal(s1.forward, 1);
  assert.equal(s1.ok, false);
  const t = tg();
  await runOnce(cfg, deps(fakeMailbox([m]), smtp, t));
  assert.equal(t.out.length, 1);
  assert.equal(toExact(smtp).length, 1);
  assert.equal(smtp.sent.filter((x) => x.to === NOTIFY).length, 1);
});

test("daily summary: one line after SUMMARY_AT when something was forwarded, once per day", async () => {
  const { cfg } = setup();
  const m = fakeMessage({ from: "noreply@notify.cloudflare.com", subject: "Invoice", pdfs: [{ buf: INVOICE("S-1", "€ 10,00") }] });
  const smtp = fakeSmtp();
  await runOnce(cfg, deps(fakeMailbox([m]), smtp, tg(), new Date("2026-10-25T12:00:00Z")));
  const t = tg();
  await runOnce(cfg, deps(fakeMailbox([m]), smtp, t, new Date("2026-10-25T19:05:00Z"))); // 20:05 Amsterdam (winter time)
  assert.equal(t.out.length, 1);
  assert.match(t.out[0], /^Exact vandaag: 1 factuur doorgestuurd \(inkoop 1, verkoop 0\), samen EUR 10,00; 0 ter controle\.$/);
  const t2 = tg();
  await runOnce(cfg, deps(fakeMailbox([m]), smtp, t2, new Date("2026-10-25T19:20:00Z")));
  assert.equal(t2.out.length, 0);
});

test("PAUSE file: does nothing, status says paused", async () => {
  const { dir, cfg } = setup();
  writeFileSync(join(dir, "PAUSE"), "");
  const s = await runOnce(cfg, deps(fakeMailbox([], { failConnect: true }), fakeSmtp(), tg()));
  assert.equal(s.paused, true);
  assert.match(readStatus(dir).lastError, /paused/);
});

test("seed: hashes from Sent (incl. legacy addresses), cutoff = later of --since and last send, legacy Message-IDs", async () => {
  const { dir, cfg } = setup({ cutoff: null, env: { LEGACY_EXACT_ADDRESSES: "old999@inkoop.exactonline.nl" } });
  const pdf = INVOICE("OLD-1");
  const box = fakeMailbox([]);
  let asked;
  box.listSentTo = async (addresses) => {
    asked = addresses;
    return [{ date: new Date("2026-10-08T05:00:41Z"), to: ["old999@inkoop.exactonline.nl"], hashes: [sha256(pdf)] }];
  };
  writeFileSync(join(dir, "ids.txt"), "<a@x>\n<b@x>\n\n");
  const r = await seed(cfg, { mailbox: box, now: new Date("2026-10-25T12:00:00Z") }, { since: new Date("2026-10-24T19:30:00Z"), messageIdsFile: join(dir, "ids.txt") });
  assert.deepEqual(asked, [EXACT.purchase, EXACT.sales, "old999@inkoop.exactonline.nl"]);
  assert.equal(r.cutoff, "2026-10-24T19:30:00.000Z");
  assert.equal(r.pdfHashes, 1);
  assert.equal(r.legacyMessageIds, 2);
  await assert.rejects(seed(cfg, { mailbox: box }, { since: new Date() }), /already initialised/);
  // a legacy message is not judged again, and the old PDF is not resent
  const legacy = fakeMessage({ from: "noreply@notify.cloudflare.com", subject: "Invoice", messageId: "<a@x>", pdfs: [{ buf: INVOICE("L-1") }], date: "2026-10-25T09:00:00Z" });
  const resend = fakeMessage({ from: "noreply@notify.cloudflare.com", subject: "Invoice", pdfs: [{ buf: Buffer.from(pdf) }], date: "2026-10-25T09:10:00Z" });
  const smtp = fakeSmtp();
  const s = await runOnce(cfg, deps(fakeMailbox([legacy, resend]), smtp, tg()));
  assert.equal(s.new, 1);
  assert.equal(s.duplicate, 1);
  assert.equal(toExact(smtp).length, 0);
});

test("SMTP allowlist refuses every other recipient", () => {
  const allowed = allowedRecipients(EXACT, NOTIFY);
  assert.doesNotThrow(() => assertAllowed(EXACT.purchase, allowed));
  assert.doesNotThrow(() => assertAllowed(EXACT.sales.toUpperCase(), allowed));
  assert.throws(() => assertAllowed("old999@inkoop.exactonline.nl", allowed), /refused/);
  assert.throws(() => assertAllowed("attacker@example.com", allowed), /refused/);
});

test("config: required fields and safety checks", () => {
  assert.throws(() => configFromEnv({ ...BASE_ENV, MAIL_ACCOUNT: "" }), ConfigError);
  assert.throws(() => configFromEnv({ ...BASE_ENV, EXACT_PURCHASE_ADDRESS: "" }), /EXACT_PURCHASE_ADDRESS is required/);
  assert.throws(() => configFromEnv({ ...BASE_ENV, EXACT_PURCHASE_ADDRESS: "someone@example.com" }), /Exact Online scan address/);
  assert.throws(() => configFromEnv({ ...BASE_ENV, NOTIFY_EMAIL: "me@elsewhere.example" }), /OWN_DOMAINS/);
  assert.throws(() => configFromEnv({ ...BASE_ENV, MAX_PER_RUN: "0" }), /positive integer/);
  assert.throws(() => configFromEnv({ ...BASE_ENV, SUMMARY_AT: "25:00" }), /HH:MM/);
  const cfg = configFromEnv({ ...BASE_ENV, EXACT_SALES_ADDRESS: "" });
  assert.deepEqual(cfg.ownDomains, ["acme.example"]);
  assert.equal(cfg.exact.sales, null);
  assert.equal(cfg.exact.purchase, EXACT.purchase);
});
