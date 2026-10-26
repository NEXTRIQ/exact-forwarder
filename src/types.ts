// Domain types shared across modules. Pure declarations, no runtime code.

/** Where a forwarded invoice goes in Exact Online. */
export type Direction = "purchase" | "sales";

/** A senders.conf entry: a direction, or `exclude` for senders that are never forwarded. */
export type SenderDirection = Direction | "exclude";

/** The outcome of classifying one message. */
export type Decision = "forward" | "review" | "skip";

export type Currency = "EUR" | "GBP" | "USD";

/** A money amount; currency is null when the document does not reveal it. */
export interface Amount {
  readonly value: number;
  readonly currency: Currency | null;
}

/** Fields read from an invoice. Anything not found reliably is null, never guessed. */
export interface InvoiceFields {
  readonly amount: Amount | null;
  readonly number: string | null;
  /** YYYY-MM-DD */
  readonly date: string | null;
}

/** The configured Exact Online scan addresses. */
export interface ExactAddresses {
  readonly purchase: string;
  readonly sales: string | null;
}

export interface MailAddress {
  /** Lower-cased; empty when the header had none. */
  readonly address: string;
  readonly name: string;
}

/** A leaf MIME part of a message, as reported by the IMAP body structure. */
export interface Attachment {
  readonly part: string;
  readonly contentType: string;
  readonly filename: string;
  /** Encoded size as reported by IMAP, in bytes. */
  readonly size: number;
  readonly disposition: string;
}

/** A message in the INBOX: envelope, authentication headers and attachment metadata. No body content. */
export interface MailMessage {
  readonly uid: number;
  /** Deduplication key: Message-ID, else a Gmail id, else UIDVALIDITY plus UID. */
  readonly key: string;
  readonly messageId: string | null;
  readonly internalDate: Date | null;
  readonly from: MailAddress;
  readonly subject: string;
  /** Authentication-Results header values, topmost first. */
  readonly authResults: readonly string[];
  /** True when the message carries our own loop-prevention header. */
  readonly hasLoopHeader: boolean;
  readonly attachments: readonly Attachment[];
}

/** Result of extracting text from a PDF: either text or a short (Dutch) reason why there is none. */
export type PdfTextResult =
  | { readonly text: string; readonly error: null }
  | { readonly text: null; readonly error: string };

/** A downloaded PDF attachment with its extracted text. */
export interface PdfInfo {
  readonly filename: string;
  readonly buf: Buffer;
  readonly sha256: string;
  readonly size: number;
  readonly text: string | null;
  readonly textError: string | null;
}

/** A message sent earlier from the Sent folder, reduced to what `seed` needs. */
export interface SentMessage {
  readonly date: Date;
  readonly to: readonly string[];
  readonly hashes: readonly string[];
}

export interface MailAttachment {
  readonly filename: string;
  readonly content: Buffer;
  readonly contentType: string;
}

export interface OutgoingMail {
  readonly to: string;
  readonly subject: string;
  readonly text?: string | undefined;
  readonly attachments?: readonly MailAttachment[];
}

/** The mailbox as `runOnce` and `seed` see it. Implemented over IMAP in imap.ts, faked in tests. */
export interface Mailbox {
  connect(): Promise<void>;
  close(): Promise<void>;
  /** Messages in INBOX received on or after `since` (day granularity; the caller filters further). */
  listInbox(since: Date): Promise<MailMessage[]>;
  downloadFromInbox(uid: number, part: string): Promise<Buffer>;
  addLabel(uid: number, label: string): Promise<void>;
  /** Mails in the Sent folder addressed to any of `addresses`, with the hash of every PDF. */
  listSentTo(
    addresses: readonly string[],
    since: Date,
    hash: (buf: Buffer) => string,
  ): Promise<SentMessage[]>;
}

/** Outgoing mail. Implemented over SMTP with a recipient allowlist in smtp.ts. */
export interface Smtp {
  send(mail: OutgoingMail): Promise<void>;
  close(): void;
}

/** A notification channel that takes plain text, e.g. Telegram. */
export type Notifier = (text: string) => Promise<void>;

export type PdfTextFn = (buf: Buffer) => Promise<PdfTextResult>;

/** Per-run counters. Written to status.json and the run summary; never contains content. */
export interface Counts {
  scanned: number;
  new: number;
  forward: number;
  review: number;
  skip: number;
  duplicate: number;
  capped: number;
  errors: number;
  labelErrors: number;
  notified: number;
}
