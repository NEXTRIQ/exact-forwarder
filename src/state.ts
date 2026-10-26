// State on disk: what has been handled or forwarded, plus status.json for external monitoring.
// The state holds only Message-IDs, SHA-256 hashes, decisions and amounts; never subjects, addresses or mail
// bodies. Writes are atomic (tmp file + rename).
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errorProp } from "./errors.js";
import type { Counts, Currency, Direction } from "./types.js";

const STATE_FILE = "state.json";
const STATUS_FILE = "status.json";
const DAY = 24 * 60 * 60 * 1000;

/** What happened to a message. `legacy` = handled by a previous system (seeded). */
export type MessageOutcome = "forward" | "review" | "duplicate" | "skip" | "legacy";

export interface MessageRecord {
  at: string;
  decision: MessageOutcome;
  direction?: Direction;
  hashes?: string[];
}

export interface HashRecord {
  at: string;
  direction: Direction;
  /** "sent" when seeded from the Sent folder. */
  source?: "sent";
}

export interface FailureRecord {
  count: number;
  lastAt: string;
}

/** A pending notice. Each channel is ticked off on its own, so a dead channel does not block the other. */
export interface OutboxItem {
  telegram?: string;
  telegramDone?: boolean;
  mailSubject?: string;
  mailText?: string;
  mailDone?: boolean;
  attempts: number;
}

/** One forward, for the daily summary. Kept for three days. */
export interface ForwardRecord {
  at: string;
  direction: Direction;
  currency: Currency | null;
  value: number | null;
}

export interface SeedInfo {
  sentMails: number;
  pdfHashes: number;
  legacyMessageIds: number;
  lastSentDay: string | null;
}

export interface State {
  version: 1;
  /** ISO timestamp; only mail received after it is considered. Set by `seed`. */
  cutoff: string | null;
  /** By message key. */
  messages: Record<string, MessageRecord>;
  /** By SHA-256 of a forwarded PDF. */
  hashes: Record<string, HashRecord>;
  /** Message key -> ISO timestamp of a send that has not been confirmed (at-most-once delivery). */
  pending: Record<string, string>;
  /** Message key -> attachment download failures. */
  failures: Record<string, FailureRecord>;
  outbox: OutboxItem[];
  forwards: ForwardRecord[];
  /** Day key (YYYY-MM-DD) of the last MAX_PER_RUN alarm, so it is sent once per day. */
  capAlertFor?: string;
  /** Day key of the last daily summary. */
  summarySentFor?: string;
  lastRunAt?: string;
  seededAt?: string;
  seed?: SeedInfo;
}

/** status.json: free of secrets and personal data. */
export interface Status {
  lastRunAt: string;
  lastOkAt: string | null;
  lastError: string | null;
  dryRun: boolean;
  counts: Counts | null;
}

export function emptyState(): State {
  return {
    version: 1,
    cutoff: null,
    messages: {},
    hashes: {},
    pending: {},
    failures: {},
    outbox: [],
    forwards: [],
  };
}

export function loadState(dir: string): State {
  try {
    // Our own file, written by saveState; missing top-level keys fall back to an empty state.
    const stored = JSON.parse(readFileSync(join(dir, STATE_FILE), "utf8")) as Partial<State>;
    return { ...emptyState(), ...stored };
  } catch (e) {
    if (errorProp(e, "code") === "ENOENT") return emptyState();
    // A corrupt state file must never turn into "forward everything again".
    throw new Error(`state unreadable (${STATE_FILE}): repair or remove it deliberately`, {
      cause: e,
    });
  }
}

function writeAtomic(path: string, data: string, mode: number): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, { mode });
  // The mode given to writeFileSync is reduced by the umask (the systemd unit sets 0077) and ignored for an
  // existing file, so set it explicitly: status.json must stay world-readable.
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

export function saveState(dir: string, state: State): void {
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  writeAtomic(join(dir, STATE_FILE), `${JSON.stringify(state, null, 1)}\n`, 0o600);
}

export interface StatusUpdate {
  readonly now: Date;
  readonly ok: boolean;
  readonly error?: string;
  readonly counts?: Counts;
  readonly dryRun: boolean;
}

/**
 * Writes status.json: { lastRunAt, lastOkAt, lastError, dryRun, counts }. lastOkAt only moves when IMAP,
 * processing and notifications all succeeded, so a monitor can alert on staleness instead of trusting exit
 * codes. World-readable (0644) and free of secrets and personal data.
 */
export function writeStatus(dir: string, { now, ok, error, counts, dryRun }: StatusUpdate): Status {
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const path = join(dir, STATUS_FILE);
  let prev: Partial<Status> = {};
  try {
    prev = JSON.parse(readFileSync(path, "utf8")) as Partial<Status>;
  } catch {
    // first run
  }
  const status: Status = {
    lastRunAt: now.toISOString(),
    lastOkAt: ok ? now.toISOString() : (prev.lastOkAt ?? null),
    lastError: ok ? null : (error ?? "unknown error").slice(0, 200),
    dryRun,
    counts: counts ?? null,
  };
  writeAtomic(path, `${JSON.stringify(status)}\n`, 0o644);
  return status;
}

/** The last status.json, or null when there is none (or it is unreadable). */
export function readStatus(dir: string): Status | null {
  try {
    return JSON.parse(readFileSync(join(dir, STATUS_FILE), "utf8")) as Status | null;
  } catch {
    return null;
  }
}

/** Drops old data: messages and hashes after 400 days, failures after 30, the forward log after 3. */
export function prune(state: State, now: Date): State {
  const old = (iso: string, days: number): boolean =>
    now.getTime() - new Date(iso).getTime() > days * DAY;
  for (const [k, v] of Object.entries(state.messages)) if (old(v.at, 400)) delete state.messages[k];
  for (const [k, v] of Object.entries(state.hashes)) if (old(v.at, 400)) delete state.hashes[k];
  for (const [k, v] of Object.entries(state.failures))
    if (old(v.lastAt, 30)) delete state.failures[k];
  state.forwards = state.forwards.filter((f) => !old(f.at, 3));
  state.outbox = state.outbox.filter((o) => o.attempts < 20);
  return state;
}
