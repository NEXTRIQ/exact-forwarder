// IMAP side (Gmail or Google Workspace with an app password), built on imapflow. Read-only, except for the
// Gmail label "Exact/doorgestuurd" after a successful forward. Never deletes or moves anything and never sets
// \Seen, so a human still sees the invoice as unread.
import { buffer } from "node:stream/consumers";
import { ImapFlow } from "imapflow";
import type { MailboxObject, MessageStructureObject, SearchObject } from "imapflow";
import type { Attachment, MailMessage, Mailbox, SentMessage } from "./types.js";

const DAY = 24 * 60 * 60 * 1000;

/** Flattens a body structure into its leaf parts. */
export function flattenParts(
  node: MessageStructureObject | undefined,
  acc: Attachment[] = [],
): Attachment[] {
  if (!node) return acc;
  if (node.childNodes?.length) {
    for (const child of node.childNodes) flattenParts(child, acc);
    return acc;
  }
  acc.push({
    part: node.part || "1",
    contentType: (node.type || "").toLowerCase(),
    filename: node.dispositionParameters?.filename || node.parameters?.name || "",
    size: Number(node.size ?? 0),
    disposition: (node.disposition || "").toLowerCase(),
  });
  return acc;
}

/** Raw header lines to a list of values per lower-cased name, in order (topmost first). */
export function parseHeaderBlock(buf: Buffer | string | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const unfolded = String(buf ?? "").replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    (out[name] ??= []).push(line.slice(i + 1).trim());
  }
  return out;
}

const HEADERS = ["authentication-results", "x-exact-forwarder", "auto-submitted"];

export interface ImapOptions {
  readonly host?: string;
  readonly user: string;
  readonly pass: string;
  /** Open mailboxes read-only (dry run, seed). Labelling always opens INBOX read-write. */
  readonly readOnly?: boolean;
}

export function createImap({
  host = "imap.gmail.com",
  user,
  pass,
  readOnly = false,
}: ImapOptions): Mailbox {
  const client = new ImapFlow({
    host,
    port: 993,
    secure: true,
    logger: false,
    auth: { user, pass },
    socketTimeout: 120_000,
  });
  const labelReady = new Set<string>();

  async function withBox<T>(
    path: string,
    fn: (box: MailboxObject) => Promise<T>,
    ro = readOnly,
  ): Promise<T> {
    const lock = await client.getMailboxLock(path, { readOnly: ro });
    try {
      // Holding the lock means the mailbox is open; imapflow types it as `false` otherwise.
      const box = client.mailbox;
      if (!box) throw new Error(`mailbox ${path} is not open`);
      return await fn(box);
    } finally {
      lock.release();
    }
  }

  async function download(uid: number, part: string): Promise<Buffer> {
    const { content } = await client.download(String(uid), part, { uid: true });
    return buffer(content);
  }

  return {
    connect: () => client.connect(),
    close: () => client.logout().catch(() => undefined),

    listInbox(since) {
      return withBox("INBOX", async (box) => {
        // SINCE works per calendar day in the server's time zone: search one extra day, the caller filters on internalDate.
        const uids =
          (await client.search({ since: new Date(since.getTime() - DAY) }, { uid: true })) || [];
        if (!uids.length) return [];
        const out: MailMessage[] = [];
        for await (const m of client.fetch(
          uids.join(","),
          {
            uid: true,
            envelope: true,
            bodyStructure: true,
            internalDate: true,
            // No `emailId` flag: imapflow always fetches the email id when the server supports it.
            headers: HEADERS,
          },
          { uid: true },
        )) {
          const h = parseHeaderBlock(m.headers);
          const from = m.envelope?.from?.[0] ?? {};
          const messageId = m.envelope?.messageId || null;
          out.push({
            uid: m.uid,
            key: messageId || (m.emailId ? `gm:${m.emailId}` : `uid:${box.uidValidity}:${m.uid}`),
            messageId,
            internalDate: m.internalDate ? new Date(m.internalDate) : null,
            from: { address: (from.address ?? "").toLowerCase(), name: from.name ?? "" },
            subject: m.envelope?.subject ?? "",
            authResults: h["authentication-results"] ?? [],
            hasLoopHeader: Boolean(h["x-exact-forwarder"]?.length),
            attachments: flattenParts(m.bodyStructure).filter(
              (p) => !p.contentType.startsWith("text/") || p.filename,
            ),
          });
        }
        return out;
      });
    },

    downloadFromInbox(uid, part) {
      return withBox("INBOX", () => download(uid, part));
    },

    /** Adds a Gmail label (creating it when needed). Throws on failure; the caller counts it. */
    async addLabel(uid, label) {
      if (!labelReady.has(label)) {
        const boxes = await client.list();
        if (!boxes.some((b) => b.path === label)) {
          const parent = label.split("/")[0] ?? label;
          if (parent !== label && !boxes.some((b) => b.path === parent))
            await client.mailboxCreate(parent).catch(() => undefined);
          await client.mailboxCreate(label).catch(() => undefined);
        }
        labelReady.add(label);
      }
      await withBox(
        "INBOX",
        () => client.messageFlagsAdd(String(uid), [label], { uid: true, useLabels: true }),
        false,
      );
    },

    /**
     * Mails previously sent to Exact, from the special-use \Sent folder: date and SHA-256 of every PDF.
     * Used by `seed`, so nothing a previous system already forwarded is sent again.
     */
    async listSentTo(addresses, since, hash) {
      const boxes = await client.list();
      const sent = boxes.find((b) => /\\Sent/i.test(b.specialUse ?? ""));
      if (!sent) throw new Error("map Verzonden niet gevonden");
      return withBox(
        sent.path,
        async () => {
          const query: SearchObject =
            addresses.length === 1
              ? { to: addresses[0] }
              : { or: addresses.map((a) => ({ to: a })) };
          const uids = (await client.search({ ...query, since }, { uid: true })) || [];
          const out: SentMessage[] = [];
          for (const uid of uids) {
            const m = await client.fetchOne(
              String(uid),
              { uid: true, envelope: true, bodyStructure: true, internalDate: true },
              { uid: true },
            );
            if (!m) continue;
            const pdfs = flattenParts(m.bodyStructure).filter(
              (p) => p.contentType === "application/pdf" || /\.pdf$/i.test(p.filename),
            );
            const hashes: string[] = [];
            for (const p of pdfs) hashes.push(hash(await download(uid, p.part)));
            const to = (m.envelope?.to ?? []).map((t) => (t.address ?? "").toLowerCase());
            // With no date at all this is an Invalid Date, as `new Date(undefined)` would be.
            out.push({ date: new Date(m.internalDate ?? m.envelope?.date ?? NaN), to, hashes });
          }
          return out;
        },
        true,
      );
    },
  };
}
