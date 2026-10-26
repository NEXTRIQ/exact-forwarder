#!/usr/bin/env node
// exact-forwarder CLI.
//   exact-forwarder                 one run (meant for a timer, e.g. every 15 minutes)
//   exact-forwarder seed --since <ISO> [--message-ids <file>] [--force]
//   exact-forwarder status          print status.json (no secrets)
import { ConfigError, configFromEnv } from "../src/config.mjs";
import { createImap } from "../src/imap.mjs";
import { runOnce, seed } from "../src/main.mjs";
import { sendTelegram } from "../src/notify.mjs";
import { pdfToText } from "../src/pdf.mjs";
import { createSmtp } from "../src/smtp.mjs";
import { readStatus } from "../src/state.mjs";

// Last line of defence: error messages from libraries must never echo credentials into the journal.
const scrub = (s) => String(s).replace(/(bot)\d+:[\w-]+/g, "$1<token>");

async function main() {
  const [cmd = "run", ...args] = process.argv.slice(2);
  const cfg = configFromEnv();
  if (cmd === "status") {
    process.stdout.write(`${JSON.stringify(readStatus(cfg.stateDir))}\n`);
    return;
  }
  if (!cfg.pass) throw new ConfigError("MAIL_PASSWORD is required");
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };

  if (cmd === "seed") {
    const mailbox = createImap({ host: cfg.imapHost, user: cfg.account, pass: cfg.pass, readOnly: true });
    const r = await seed(cfg, { mailbox }, {
      since: new Date(opt("--since") ?? ""),
      messageIdsFile: opt("--message-ids") ?? null,
      force: args.includes("--force"),
    });
    process.stdout.write(`${JSON.stringify({ seeded: true, ...r })}\n`);
    return;
  }
  if (cmd !== "run") throw new ConfigError(`unknown command: ${cmd}`);

  const telegram = cfg.telegramToken && cfg.telegramChatId
    ? (text) => sendTelegram({ token: cfg.telegramToken, chatId: cfg.telegramChatId }, text)
    : null;
  // Doubtful invoices are only safe to hold back when someone hears about them.
  if (!cfg.dryRun && !telegram && !cfg.notifyEmail) throw new ConfigError("configure NOTIFY_EMAIL and/or TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID");

  const mailbox = createImap({ host: cfg.imapHost, user: cfg.account, pass: cfg.pass, readOnly: cfg.dryRun });
  const smtp = cfg.dryRun
    ? null
    : createSmtp({
        host: cfg.smtpHost,
        port: cfg.smtpPort,
        user: cfg.account,
        pass: cfg.pass,
        from: `${cfg.fromName} <${cfg.account}>`,
        exact: cfg.exact,
        notifyEmail: cfg.notifyEmail,
      });
  const summary = await runOnce(cfg, { mailbox, smtp, telegram, pdfText: (buf) => pdfToText(buf) });
  // Exit code 1 on errors. Monitoring should still watch the freshness of status.json, not the exit code.
  if (!summary.paused && !summary.ok) process.exitCode = 1;
}

main().catch((e) => {
  const prefix = e instanceof ConfigError ? "configuration error" : "error";
  process.stderr.write(`exact-forwarder: ${prefix}: ${scrub(e instanceof Error ? e.message : e)}\n`);
  process.exit(e instanceof ConfigError ? 78 : 1); // 78 = EX_CONFIG
});
