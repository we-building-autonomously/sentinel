import { describe, it, expect } from "vitest";
import { detectConsent, consentNote } from "./consent.js";

describe("detectConsent", () => {
  it("detects common cookie/consent banner phrasings", () => {
    expect(detectConsent("We use cookies to improve your experience. Accept all")).toBe(true);
    expect(detectConsent("This website uses cookies.")).toBe(true);
    expect(detectConsent("We value your privacy")).toBe(true);
    expect(detectConsent("Manage your preferences")).toBe(true);
    expect(detectConsent("By continuing to browse you agree to our policy")).toBe(true);
    expect(detectConsent("See our cookie policy")).toBe(true);
    expect(detectConsent("GDPR")).toBe(true);
  });

  it("detects localized EU consent banners (de/fr/es/it/nl/pt)", () => {
    expect(detectConsent("Wir verwenden Cookies, um Ihre Erfahrung zu verbessern. Alle akzeptieren")).toBe(true);
    expect(detectConsent("Diese Website verwendet Cookies.")).toBe(true);
    expect(detectConsent("Nous utilisons des cookies pour améliorer votre expérience")).toBe(true);
    expect(detectConsent("Accepter les cookies")).toBe(true);
    expect(detectConsent("Utilizamos cookies propias y de terceros")).toBe(true);
    expect(detectConsent("Política de cookies")).toBe(true);
    expect(detectConsent("Utilizziamo i cookie per offrirti la migliore esperienza")).toBe(true);
    expect(detectConsent("Accetta tutti i cookie")).toBe(true);
    expect(detectConsent("We gebruiken cookies op deze site")).toBe(true);
  });

  it("is conservative — incidental mentions of cookies do not trip it", () => {
    expect(detectConsent("Grandma's cookie recipe: bake at 350°F")).toBe(false);
    expect(detectConsent("Clear your browser cookies in Settings")).toBe(false);
    expect(detectConsent("")).toBe(false);
    expect(detectConsent("Welcome to your dashboard")).toBe(false);
  });

  it("consentNote renders a banner with an actionable hint only when present", () => {
    expect(consentNote("nothing here")).toBe("");
    const note = consentNote("We use cookies. Accept all?");
    expect(note).toMatch(/^⚠ COOKIE\/CONSENT BANNER/);
    expect(note).toMatch(/accept or dismiss/i);
    expect(note).toMatch(/intercept clicks/i);
    expect(note.endsWith("\n")).toBe(true);
  });
});
