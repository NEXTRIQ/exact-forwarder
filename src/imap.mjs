// IMAP side (Gmail or Google Workspace with an app password), built on imapflow. Read-only, except for the
// Gmail label "Exact/doorgestuurd" after a successful forward. Never deletes or moves anything and never sets
// \Seen, so a human still sees the invoice as unread.
import { ImapFlow } from "imapflow";

/** Flattens a bodystructure: [{ part, contentType, filename, size, disposition }] */
export function flattenParts(node, acc = []) {
  if (!node) return acc;
  if (node.childNodes?.length) {
    for (const child of node.childNodes) flattenParts(child, acc);
    return acc;
  }
  acc.push({
    part: node.part || "1",
    contentType: String(node.type || "").toLowerCase(),
    filename: node.dispositionParameters?.filename || node.parameters?.name || "",
    size: Number(node.size ?? 0),
    disposition: String(node.disposition || "").toLowerCase(),
  });
  return acc;
}

/** Raw header lines (Buffer) to a list of values per name, in order (topmost first). */
export function parseHeaderBlock(buf) {
  const out = {};
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

export function createImap({ host = "imap.gmail.com", user, pass, readOnly = false }) {
  const client = new ImapFlow({
    host,
    port: 993,
    secure: true,
    logger: false,
    auth: { user, pass },
    socketTimeout: 120_000,
  });
  let labelReady = new Set();

  async function withBox(path, fn, ro = readOnly) {
    const lock = await client.getMailboxLock(path, { readOnly: ro });
    try {
      return await fn(client.mailbox);
    } finally {
      lock.release();
    }
  }

  async function download(uid, part) {
    const { content } = await client.download(String(uid), part, { uid: true });
    const chunks = [];
    for await (const c of content) chunks.push(c);
    return Buffer.concat(chunks);
  }

  return {
    connect: () => client.connect(),
    close: () => client.logout().catch(() => undefined),

    /** Messages in INBOX with internalDate >= since (IMAP SINCE has day granularity; the caller filters further). */
    listInbox(since) {
      return withBox("INBOX", async (box) => {
        // SINCE works per calendar day in the server's time zone: search one extra day, the caller filters on internalDate.
        const uids = (await client.search({ since: new Date(since.getTime() - 24 * 60 * 60 * 1000) }, { uid: true })) || [];
        if (!uids.length) return [];
        const out = [];
        for await (const m of client.fetch(
          uids.join(","),
          { uid: true, envelope: true, bodyStructure: true, internalDate: true, emailId: true, headers: HEADERS },
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
            from: { address: String(from.address ?? "").toLowerCase(), name: from.name ?? "" },
            subject: m.envelope?.subject ?? "",
            authResults: h["authentication-results"] ?? [],
            hasLoopHeader: Boolean(h["x-exact-forwarder"]?.length),
            attachments: flattenParts(m.bodyStructure).filter((p) => !p.contentType.startsWith("text/") || p.filename),
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
          const parent = label.split("/")[0];
          if (parent !== label && !boxes.some((b) => b.path === parent)) await client.mailboxCreate(parent).catch(() => undefined);
          await client.mailboxCreate(label).catch(() => undefined);
        }
        labelReady.add(label);
      }
      return withBox("INBOX", () => client.messageFlagsAdd(String(uid), [label], { uid: true, useLabels: true }), false);
    },

    /**
     * Mails previously sent to Exact, from the special-use \Sent folder: date and SHA-256 of every PDF.
     * Used by `seed`, so nothing a previous system already forwarded is sent again.
     */
    async listSentTo(addresses, since, hash) {
      const boxes = await client.list();
      const sent = boxes.find((b) => /\\Sent/i.test(String(b.specialUse ?? "")));
      if (!sent) throw new Error("map Verzonden niet gevonden");
      return withBox(
        sent.path,
        async () => {
          const query = addresses.length === 1 ? { to: addresses[0] } : { or: addresses.map((a) => ({ to: a })) };
          const uids = (await client.search({ ...query, since }, { uid: true })) || [];
          const out = [];
          for (const uid of uids) {
            const m = await client.fetchOne(String(uid), { uid: true, envelope: true, bodyStructure: true, internalDate: true }, { uid: true });
            if (!m) continue;
            const pdfs = flattenParts(m.bodyStructure).filter(
              (p) => p.contentType === "application/pdf" || /\.pdf$/i.test(p.filename),
            );
            const hashes = [];
            for (const p of pdfs) hashes.push(hash(await download(uid, p.part)));
            const to = (m.envelope?.to ?? []).map((t) => String(t.address ?? "").toLowerCase());
            out.push({ date: new Date(m.internalDate ?? m.envelope?.date), to, hashes });
          }
          return out;
        },
        true,
      );
    },
  };
}
