import type { BrowserSession } from "./session.js";

export interface PageForm {
  fields: string[];
  hasPassword: boolean;
  submitLabel?: string;
}

export interface PageProfile {
  url: string;
  title: string;
  /** h1/h2 text, in document order. */
  headings: string[];
  forms: PageForm[];
  /** Prominent buttons / nav links the user is likely to act on. */
  primaryActions: string[];
  /** Heuristic: a password field is present. */
  hasLogin: boolean;
}

/* istanbul ignore next -- runs in the browser */
function analyze(): Omit<PageProfile, "url"> {
  const text = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ").trim();

  const headings = Array.from(document.querySelectorAll("h1, h2"))
    .map(text)
    .filter(Boolean)
    .slice(0, 8);

  function fieldLabel(el: Element): string {
    const id = el.getAttribute("id");
    if (id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (lbl?.textContent?.trim()) return lbl.textContent.trim();
    }
    const wrap = el.closest("label");
    if (wrap?.textContent?.trim()) return wrap.textContent.trim();
    return (
      el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") ||
      el.getAttribute("name") ||
      el.getAttribute("type") ||
      "field"
    ).trim();
  }

  const forms: PageForm[] = Array.from(document.querySelectorAll("form")).map((form) => {
    const inputs = Array.from(form.querySelectorAll("input, select, textarea")).filter((el) => {
      const t = el.getAttribute("type");
      return t !== "hidden" && t !== "submit" && t !== "button";
    });
    const submit = form.querySelector(
      'button[type="submit"], input[type="submit"], button:not([type])'
    );
    return {
      fields: inputs.map(fieldLabel).slice(0, 12),
      hasPassword: inputs.some((el) => el.getAttribute("type") === "password"),
      submitLabel: submit ? text(submit) || submit.getAttribute("value") || undefined : undefined,
    };
  });

  const primaryActions = Array.from(
    document.querySelectorAll("button, a[href], [role=button]")
  )
    .map(text)
    .filter((t) => t.length > 0 && t.length < 40)
    .filter((t, i, arr) => arr.indexOf(t) === i)
    .slice(0, 12);

  return {
    title: document.title,
    headings,
    forms,
    primaryActions,
    hasLogin: forms.some((f) => f.hasPassword),
  };
}

/** Capture a structural profile of the current page (no LLM needed). */
export async function profilePage(session: BrowserSession): Promise<PageProfile> {
  const partial = await session.page.mainFrame().evaluate(analyze);
  return { url: session.url(), ...partial };
}
