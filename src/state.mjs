// State on disk: what has been handled or forwarded, plus status.json for external monitoring.
// The state holds only Message-IDs, SHA-256 hashes, decisions and amounts; never subjects, addresses or mail
// bodies. Writes are atomic (tmp file + rename).
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STATE_FILE = "state.json";
const STATUS_FILE = "status.json";
const DAY = 24 * 60 * 60 * 1000;

export function emptyState() {
  return { version: 1, cutoff: null, messages: {}, hashes: {}, pending: {}, failures: {}, outbox: [], forwards: [] };
}

export function loadState(dir) {
  try {
    return { ...emptyState(), ...JSON.parse(readFileSync(join(dir, STATE_FILE), "utf8")) };
  } catch (e) {
    if (e?.code === "ENOENT") return emptyState();
    // A corrupt state file must never turn into "forward everything again".
    throw new Error(`state unreadable (${STATE_FILE}): repair or remove it deliberately`);
  }
}

function writeAtomic(path, data, mode) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

export function saveState(dir, state) {
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  writeAtomic(join(dir, STATE_FILE), `${JSON.stringify(state, null, 1)}\n`, 0o600);
}

/**
 * status.json: { lastRunAt, lastOkAt, lastError, dryRun, counts }. lastOkAt only moves when IMAP, processing
 * and notifications all succeeded, so a monitor can alert on staleness instead of trusting exit codes.
 * World-readable (0644) and free of secrets and personal data.
 */
export function writeStatus(dir, { now, ok, error, counts, dryRun }) {
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const path = join(dir, STATUS_FILE);
  let prev = {};
  try {
    prev = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // first run
  }
  const status = {
    lastRunAt: now.toISOString(),
    lastOkAt: ok ? now.toISOString() : (prev.lastOkAt ?? null),
    lastError: ok ? null : String(error ?? "unknown error").slice(0, 200),
    dryRun: Boolean(dryRun),
    counts: counts ?? null,
  };
  writeAtomic(path, `${JSON.stringify(status)}\n`, 0o644);
  return status;
}

export function readStatus(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, STATUS_FILE), "utf8"));
  } catch {
    return null;
  }
}

/** Drops old data: messages and hashes after 400 days, failures after 30, the forward log after 3. */
export function prune(state, now) {
  const old = (iso, days) => now - new Date(iso) > days * DAY;
  for (const [k, v] of Object.entries(state.messages)) if (old(v.at, 400)) delete state.messages[k];
  for (const [k, v] of Object.entries(state.hashes)) if (old(v.at, 400)) delete state.hashes[k];
  for (const [k, v] of Object.entries(state.failures)) if (old(v.lastAt, 30)) delete state.failures[k];
  state.forwards = state.forwards.filter((f) => !old(f.at, 3));
  state.outbox = state.outbox.filter((o) => o.attempts < 20);
  return state;
}
