/**
 * Detect a cookie / consent (GDPR-style) banner. These are ubiquitous on real
 * sites and are a frequent, silent cause of wasted steps: the banner is usually
 * a plain <div> (so the modal detector misses it) yet it overlays the page and
 * intercepts pointer events, so the agent's clicks land on the banner instead of
 * the control it aimed at — with no obvious error.
 *
 * Unlike an external challenge (CAPTCHA/2FA), a consent banner is something the
 * agent SHOULD and CAN resolve: accept or dismiss it, then continue. So this is
 * an advisory hint that prioritizes that action, not a reason to stop.
 *
 * Detection is conservative and text-based: it requires an explicit cookie/
 * consent phrase, so a page that merely mentions "cookies" in prose, or a
 * genuine cookie-settings page under test, is far less likely to trip it.
 */
const SIGNALS: RegExp[] = [
  /we use cookies/i,
  /this (?:site|website) uses cookies/i,
  /uses? cookies (?:to|and)/i,
  /accept (?:all )?cookies/i,
  /\bcookie (?:policy|settings|preferences|consent|notice)\b/i,
  /we value your privacy/i,
  /by continuing to (?:use|browse|visit)/i,
  /manage (?:your )?(?:cookie )?preferences/i,
  /\bgdpr\b/i,
  /consent to (?:the use of )?cookies/i,
  // --- Localized EU consent banners (the most common non-English blocker) ---
  // German
  /wir verwenden cookies/i,
  /diese (?:website|seite) verwendet cookies/i,
  /cookie[- ]einstellungen/i,
  /alle akzeptieren/i,
  // French
  /nous utilisons des cookies/i,
  /ce site (?:web )?utilise des cookies/i,
  /(?:gérer|gestion|politique) des cookies/i,
  /accepter (?:tous )?les cookies/i,
  // Spanish
  /utilizamos cookies/i,
  /este sitio (?:web )?utiliza cookies/i,
  /(?:aceptar|política de) (?:todas las )?cookies/i,
  // Italian
  /utilizziamo i cookie/i,
  /questo sito utilizza (?:i )?cookie/i,
  /accetta (?:tutti )?i cookie/i,
  // Dutch / Portuguese
  /we gebruiken cookies/i,
  /(?:utilizamos|usamos) cookies/i,
];

/** True if the visible text shows a cookie/consent banner. */
export function detectConsent(text: string): boolean {
  if (!text) return false;
  return SIGNALS.some((p) => p.test(text));
}

/** The observation banner for a detected consent wall (empty string if none). */
export function consentNote(text: string): string {
  return detectConsent(text)
    ? "⚠ COOKIE/CONSENT BANNER appears present — accept or dismiss it first " +
        '(e.g. an "Accept", "Accept all", "Got it", or "Agree" button). It can ' +
        "overlay the page and intercept clicks until handled.\n"
    : "";
}
