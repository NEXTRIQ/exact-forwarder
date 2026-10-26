// Text from a PDF via pdftotext (poppler-utils). The file comes from a mail attachment and is untrusted: it runs
// under the systemd sandbox with a timeout, only the first 30 pages and bounded output (utility bills sometimes
// put the total after page 5). On failure (encrypted, image-only scan) it resolves to { text: null, error }.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PdfTextResult } from "./types.js";

const MAX_OUTPUT_BYTES = 2_000_000;

export const sha256 = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

/** True for a Buffer with a PDF header in its first KiB (PDF readers accept leading bytes before it). */
export const looksLikePdf = (buf: unknown): buf is Buffer =>
  Buffer.isBuffer(buf) && buf.subarray(0, 1024).includes(Buffer.from("%PDF-"));

export interface PdfToTextOptions {
  /** pdftotext binary; defaults to $PDFTOTEXT_BIN or "pdftotext" on the PATH. */
  readonly bin?: string;
  readonly timeoutMs?: number;
}

export function pdfToText(
  buf: Buffer,
  { bin = process.env.PDFTOTEXT_BIN || "pdftotext", timeoutMs = 20_000 }: PdfToTextOptions = {},
): Promise<PdfTextResult> {
  if (!looksLikePdf(buf)) return Promise.resolve({ text: null, error: "geen geldige PDF" });
  const dir = mkdtempSync(join(tmpdir(), "exf-"));
  const file = join(dir, "in.pdf");
  writeFileSync(file, buf, { mode: 0o600 });
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (r: PdfTextResult): void => {
      if (done) return;
      done = true;
      rmSync(dir, { recursive: true, force: true });
      resolve(r);
    };
    const p = spawn(bin, ["-layout", "-enc", "UTF-8", "-l", "30", "-q", file, "-"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      finish({ text: null, error: "pdftotext te traag" });
    }, timeoutMs);
    p.stdout.on("data", (c: Buffer) => {
      size += c.length;
      // Keep reading past the cap so the child is not blocked on a full pipe; just stop storing.
      if (size <= MAX_OUTPUT_BYTES) out.push(c);
    });
    p.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      finish({
        text: null,
        error: e.code === "ENOENT" ? "pdftotext ontbreekt" : "pdftotext faalde",
      });
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        finish({ text: null, error: `pdftotext exit ${code} (versleuteld of beschadigd)` });
        return;
      }
      const text = Buffer.concat(out).toString("utf8");
      finish(
        text.trim() ? { text, error: null } : { text: null, error: "geen tekst in de PDF (scan?)" },
      );
    });
  });
}
