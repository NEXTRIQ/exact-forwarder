// Text from a PDF via pdftotext (poppler-utils). The file comes from a mail attachment and is untrusted: it runs
// under the systemd sandbox with a timeout, only the first 30 pages and bounded output (utility bills sometimes
// put the total after page 5). On failure (encrypted, image-only scan) it resolves to { text: null, error }.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
export const looksLikePdf = (buf) => Buffer.isBuffer(buf) && buf.subarray(0, 1024).includes(Buffer.from("%PDF-"));

export function pdfToText(buf, { bin = process.env.PDFTOTEXT_BIN || "pdftotext", timeoutMs = 20_000 } = {}) {
  if (!looksLikePdf(buf)) return Promise.resolve({ text: null, error: "geen geldige PDF" });
  const dir = mkdtempSync(join(tmpdir(), "exf-"));
  const file = join(dir, "in.pdf");
  writeFileSync(file, buf, { mode: 0o600 });
  return new Promise((resolve) => {
    const out = [];
    let size = 0;
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      rmSync(dir, { recursive: true, force: true });
      resolve(r);
    };
    const p = spawn(bin, ["-layout", "-enc", "UTF-8", "-l", "30", "-q", file, "-"], { stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      finish({ text: null, error: "pdftotext te traag" });
    }, timeoutMs);
    p.stdout.on("data", (c) => {
      size += c.length;
      if (size <= 2_000_000) out.push(c);
    });
    p.on("error", (e) => {
      clearTimeout(timer);
      finish({ text: null, error: e.code === "ENOENT" ? "pdftotext ontbreekt" : "pdftotext faalde" });
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      const text = Buffer.concat(out).toString("utf8");
      if (code !== 0) return finish({ text: null, error: `pdftotext exit ${code} (versleuteld of beschadigd)` });
      finish(text.trim() ? { text, error: null } : { text: null, error: "geen tekst in de PDF (scan?)" });
    });
  });
}
