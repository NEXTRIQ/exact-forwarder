// Sender list (senders.conf) and sender authentication. Pure functions.
//
// One sender per line, `#` starts a comment:
//   purchase  notify.cloudflare.com   Cloudflare
//   purchase  builder.jansen@gmail.com  Klusbedrijf Jansen   (free-mail: full address only)
//   sales     invoices@example.com    Own invoicing tool     (own domain, see README)
//   exclude   formrelay.example       Contact form relay
// Dutch keywords (inkoop, verkoop, uitsluiten) are accepted as aliases.
// A domain also covers its subdomains (cloudflare.com covers notify.cloudflare.com).

export const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "outlook.nl", "hotmail.com", "hotmail.nl", "live.com", "live.nl",
  "msn.com", "icloud.com", "me.com", "mac.com", "yahoo.com", "yahoo.nl", "ziggo.nl", "kpnmail.nl", "kpnplanet.nl",
  "planet.nl", "hetnet.nl", "home.nl", "xs4all.nl", "chello.nl", "casema.nl", "tele2.nl", "proton.me",
  "protonmail.com", "pm.me", "gmx.com", "gmx.net", "gmx.de", "aol.com", "telfort.nl", "online.nl", "upcmail.nl",
]);

const DIRECTIONS = new Map([
  ["purchase", "purchase"], ["inkoop", "purchase"],
  ["sales", "sales"], ["verkoop", "sales"],
  ["exclude", "exclude"], ["uitsluiten", "exclude"],
]);

/** Parses the sender list. Invalid lines end up in `errors` and are ignored. */
export function parseSenders(text) {
  const entries = [];
  const errors = [];
  String(text ?? "")
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const line = raw.replace(/#.*$/, "").trim();
      if (!line) return;
      const [keyword, match, ...name] = line.split(/\s+/);
      const direction = DIRECTIONS.get(keyword.toLowerCase());
      const m = (match ?? "").toLowerCase().replace(/^@/, "");
      if (!direction || !m || !/^[a-z0-9._%+-]*@?[a-z0-9.-]+\.[a-z]{2,}$/.test(m)) {
        errors.push(`line ${i + 1}: unknown format`);
        return;
      }
      // A whole free-mail domain as supplier would trust everyone with a Gmail address.
      if (!m.includes("@") && FREEMAIL.has(m) && direction !== "exclude") {
        errors.push(`line ${i + 1}: ${m} is a free-mail domain; use the full address`);
        return;
      }
      entries.push({ direction, match: m, name: name.join(" ") || null });
    });
  return { entries, errors };
}

export const domainOf = (address) => String(address ?? "").toLowerCase().split("@").pop().trim();

const domainMatches = (domain, d) => domain === d || domain.endsWith(`.${d}`);

/**
 * Finds the sender. Precedence: `exclude` always wins, then an exact address, then the longest domain.
 * Returns { direction, name, match } or null.
 */
export function lookupSender(entries, address) {
  const addr = String(address ?? "").toLowerCase().trim();
  const domain = domainOf(addr);
  const hits = entries.filter((e) => (e.match.includes("@") ? e.match === addr : domainMatches(domain, e.match)));
  if (!hits.length) return null;
  const excluded = hits.find((e) => e.direction === "exclude");
  if (excluded) return excluded;
  const exact = hits.find((e) => e.match.includes("@"));
  if (exact) return exact;
  return hits.sort((a, b) => b.match.length - a.match.length)[0];
}

// ------------------------------------------------------------------ SPF / DKIM / DMARC

const MULTI_SUFFIX = new Set(["co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "co.nz", "co.za", "com.br", "co.jp", "com.tr", "com.cn"]);

/** Organisational domain, approximated without the full public suffix list: mail.billing.ionos.co.uk -> ionos.co.uk. */
export function orgDomain(domain) {
  const parts = String(domain).toLowerCase().split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const last2 = parts.slice(-2).join(".");
  return MULTI_SUFFIX.has(last2) ? parts.slice(-3).join(".") : last2;
}

/**
 * Checks the topmost Authentication-Results header only: the receiving server prepends it, while lower copies
 * may have been forged by the sender. Passing means DMARC pass, or DKIM/SPF pass aligned with the From domain.
 */
export function checkAuth(authResultsHeaders, fromAddress, { authservId = "mx.google.com" } = {}) {
  const first = (authResultsHeaders ?? [])[0];
  if (!first) return { ok: false, reason: "geen Authentication-Results" };
  const value = String(first).replace(/^authentication-results:\s*/i, "").replace(/\r?\n\s+/g, " ");
  const id = value.split(";")[0].trim().split(/\s+/)[0].toLowerCase();
  if (id !== authservId) return { ok: false, reason: `Authentication-Results niet van ${authservId}` };
  const org = orgDomain(domainOf(fromAddress));
  const v = value.toLowerCase();
  const dmarc = /\bdmarc=pass\b[^;]*?header\.from=([a-z0-9.-]+)/.exec(v);
  if (dmarc && orgDomain(dmarc[1]) === org) return { ok: true, via: "dmarc" };
  for (const m of v.matchAll(/\bdkim=pass\b[^;]*?header\.(?:i|d)=@?([a-z0-9.-]+)/g))
    if (orgDomain(m[1]) === org) return { ok: true, via: "dkim" };
  const spf = /\bspf=pass\b[^;]*?smtp\.mailfrom=(?:[^@\s;]*@)?([a-z0-9.-]+)/.exec(v);
  if (spf && orgDomain(spf[1]) === org) return { ok: true, via: "spf" };
  return { ok: false, reason: "SPF/DKIM/DMARC niet geslaagd voor het afzenderdomein" };
}
