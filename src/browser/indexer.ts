import type { Page, Frame } from "playwright";
import { detectChallenge, challengeNote, type Challenge } from "./challenge.js";
import { consentNote } from "./consent.js";
import { detectErrorState, errorNote, type ErrorState } from "./errorpage.js";
import { authFailureNote } from "./auth.js";

/** One interactable element discovered in the page. */
export interface ElementInfo {
  index: number;
  tag: string;
  role: string | null;
  name: string;
  type?: string;
  value?: string;
  placeholder?: string;
  href?: string;
  checked?: boolean | null;
  disabled?: boolean;
  /** A required form field (required attr or aria-required). */
  required?: boolean;
  /** The field is flagged invalid (aria-invalid="true") — e.g. after a failed submit. */
  invalid?: boolean;
  expanded?: string | null;
  inViewport: boolean;
  /** The element lives inside an open modal/dialog (focus it first). */
  inDialog?: boolean;
  /** Text of the enclosing table row / list item — disambiguates repeated controls. */
  context?: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  elements: ElementInfo[];
  /** Visible page text (trimmed) for grounding the model. */
  text: string;
  /** Pre-rendered, LLM-friendly listing of elements. */
  rendered: string;
  /** A large <canvas> dominates the page (maps, charts, drawing apps, games). */
  hasCanvas: boolean;
  /** An open modal/dialog is present — the agent should resolve it first. */
  hasOpenDialog: boolean;
  /** An external challenge (CAPTCHA/2FA/email verification) detected in the page text. */
  challenge?: Challenge | null;
  /** The page is rendering an error/crash state (weighed against intent by the judge). */
  errorState?: ErrorState | null;
}

/**
 * This function is serialized and executed *inside a frame*. It must not
 * reference any Node/TypeScript-only symbols. It walks the DOM, finds visible
 * interactable elements, tags each with `data-sn-idx`, and returns metadata.
 * `startIndex` lets the caller keep indices globally unique across frames.
 */
/* istanbul ignore next -- runs in browser context */
function collectInteractables(startIndex: number): {
  elements: ElementInfo[];
  text: string;
  title: string;
  hasCanvas: boolean;
  hasOpenDialog: boolean;
} {
  const DIALOG_SEL = '[role="dialog"]:not([aria-hidden="true"]),[role="alertdialog"],[aria-modal="true"],dialog[open]';
  const INTERACTIVE_TAGS = new Set([
    "A",
    "BUTTON",
    "INPUT",
    "SELECT",
    "TEXTAREA",
    "SUMMARY",
    "OPTION",
  ]);
  const INTERACTIVE_ROLES = new Set([
    "button",
    "link",
    "checkbox",
    "radio",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "tab",
    "switch",
    "option",
    "textbox",
    "combobox",
    "searchbox",
    "slider",
    "spinbutton",
  ]);

  function isVisible(el: Element): boolean {
    const style = window.getComputedStyle(el);
    // NB: opacity:0 is intentionally NOT treated as hidden. It is the standard
    // pattern for a custom-styled control — a real checkbox/radio/file-input laid
    // over a styled label (TodoMVC toggles, design-system inputs) and hover-
    // revealed row actions — all of which a user (and Playwright's own click
    // actionability, which ignores opacity) CAN interact with. Excluding them
    // left the agent unable to act on whole classes of real controls.
    // `pointer-events: none` IS excluded: that is how closed overlays/menus
    // (opacity:0 + pointer-events:none) and decorative elements opt out of input.
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.pointerEvents === "none"
    )
      return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return false;
    return true;
  }

  // closest() stops at a shadow boundary; this continues the search in the host's
  // tree, so a control inside a web component still sees an enclosing dialog/row.
  function composedClosest(el: Element, selector: string): Element | null {
    let node: Element | null = el;
    while (node) {
      const found = node.closest(selector);
      if (found) return found;
      const root = node.getRootNode() as ShadowRoot & { host?: Element };
      node = root && root.host ? root.host : null;
    }
    return null;
  }

  function isInteractive(el: Element): boolean {
    const tag = el.tagName;
    if (INTERACTIVE_TAGS.has(tag)) return true;
    const role = el.getAttribute("role");
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    if (el.hasAttribute("onclick")) return true;
    // Draggable elements are interactable — the agent must be able to see (and
    // address) a card/list-item it needs to drag.
    if (el.getAttribute("draggable") === "true") return true;
    if (el.hasAttribute("contenteditable") && el.getAttribute("contenteditable") !== "false")
      return true;
    const tabindex = el.getAttribute("tabindex");
    if (tabindex != null && tabindex !== "-1") return true;
    // Common clickable cursor pointer heuristic for div/span buttons.
    if ((tag === "DIV" || tag === "SPAN") && el.getAttribute("role") == null) {
      const cur = window.getComputedStyle(el).cursor;
      if (cur === "pointer" && (el as HTMLElement).innerText?.trim()) return true;
    }
    return false;
  }

  function accessibleName(el: Element): string {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const parts = labelledby
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ")
        .trim();
      if (parts) return parts;
    }
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
      const id = el.getAttribute("id");
      if (id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (lbl?.textContent?.trim()) return lbl.textContent.trim();
      }
      const wrapLabel = el.closest("label");
      if (wrapLabel?.textContent?.trim()) return wrapLabel.textContent.trim();
      const ph = el.getAttribute("placeholder");
      if (ph) return ph.trim();
    }
    const title = el.getAttribute("title");
    if (title) return title.trim();
    const txt = (el as HTMLElement).innerText ?? el.textContent ?? "";
    return txt.replace(/\s+/g, " ").trim().slice(0, 120);
  }

  // Collect every element, descending into OPEN shadow roots so web components
  // (design systems, Shoelace/Salesforce/etc.) are visible. Playwright's CSS
  // locator pierces open shadow DOM, so the data-sn-idx tag still resolves.
  function deepAll(root: Document | ShadowRoot): Element[] {
    const acc: Element[] = [];
    for (const el of Array.from(root.querySelectorAll("*"))) {
      acc.push(el);
      const sr = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (sr) acc.push(...deepAll(sr));
    }
    return acc;
  }

  const all = deepAll(document);
  // Clear stale tags from a previous snapshot.
  for (const e of all) e.removeAttribute("data-sn-idx");

  const out: ElementInfo[] = [];
  let idx = startIndex;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  for (const el of Array.from(all)) {
    if (!isInteractive(el)) continue;
    if (!isVisible(el)) continue;
    // Skip if an interactive ancestor already covers it (avoid nested dupes for links/buttons).
    const interactiveAncestor = el.parentElement?.closest(
      "a,button,[role=button],[role=link]"
    );
    if (
      interactiveAncestor &&
      interactiveAncestor !== el &&
      (el.tagName === "SPAN" || el.tagName === "DIV")
    )
      continue;

    el.setAttribute("data-sn-idx", String(idx));
    const rect = el.getBoundingClientRect();
    const inViewport =
      rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw;

    const tag = el.tagName.toLowerCase();
    const info: ElementInfo = {
      index: idx,
      tag,
      role: el.getAttribute("role"),
      name: accessibleName(el),
      inViewport,
    };
    if (composedClosest(el, DIALOG_SEL)) info.inDialog = true;
    // Row/list context disambiguates repeated controls ("Revoke" in which row?).
    const item = composedClosest(el, 'tr,li,[role="row"],[role="listitem"]');
    if (item && item !== el) {
      let ctx = (item.textContent ?? "").replace(/\s+/g, " ").trim();
      if (info.name) ctx = ctx.split(info.name).join(" ").replace(/\s+/g, " ").trim();
      if (ctx) info.context = ctx.slice(0, 80);
    }
    if (tag === "input" || tag === "textarea") {
      const inp = el as HTMLInputElement;
      info.type = inp.getAttribute("type") ?? "text";
      info.value = inp.value ?? "";
      info.placeholder = inp.getAttribute("placeholder") ?? undefined;
      if (info.type === "checkbox" || info.type === "radio") info.checked = inp.checked;
    }
    if (tag === "select") info.value = (el as HTMLSelectElement).value;
    if (tag === "a") info.href = (el as HTMLAnchorElement).getAttribute("href") ?? undefined;
    if (el.hasAttribute("disabled")) info.disabled = true;
    // Form-validation state: which field is required, and which the app has
    // flagged invalid — lets the agent fix the exact field after a failed submit.
    if (el.hasAttribute("required") || el.getAttribute("aria-required") === "true") info.required = true;
    if (el.getAttribute("aria-invalid") === "true") info.invalid = true;
    const expanded = el.getAttribute("aria-expanded");
    if (expanded != null) info.expanded = expanded;

    out.push(info);
    idx++;
  }

  // A compact, readable text dump of the page for grounding.
  const bodyText = (document.body?.innerText ?? "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
    .slice(0, 4000);

  // Detect a dominant canvas (maps/charts/drawing/games) -> vision fallback.
  const hasCanvas = Array.from(document.querySelectorAll("canvas")).some((c) => {
    const r = c.getBoundingClientRect();
    return r.width * r.height > 90_000; // ~ >300x300
  });

  const hasOpenDialog = !!document.querySelector(DIALOG_SEL);

  return { elements: out, text: bodyText, title: document.title, hasCanvas, hasOpenDialog };
}

/** Cap on how many elements to present to the model per observation. */
export const MAX_RENDERED_ELEMENTS = 120;

/**
 * On large pages, presenting every interactable element drowns the model and
 * burns tokens. Prioritize in-viewport elements (what a user actually sees),
 * cap the count, and report how many were hidden so the agent knows to scroll.
 * Returns elements in original index order for readability.
 */
export function selectForDisplay(
  elements: ElementInfo[],
  cap = MAX_RENDERED_ELEMENTS
): { shown: ElementInfo[]; omitted: number } {
  if (elements.length <= cap) return { shown: elements, omitted: 0 };
  const inView = elements.filter((e) => e.inViewport);
  const offView = elements.filter((e) => !e.inViewport);
  const shown = [...inView, ...offView].slice(0, cap).sort((a, b) => a.index - b.index);
  return { shown, omitted: elements.length - shown.length };
}

/** Render the element list into a token-efficient, model-friendly listing. */
/** The descriptor for one element, WITHOUT the index prefix or collision ordinal. */
function describeElement(e: ElementInfo): string {
  const parts: string[] = [`<${e.tag}${e.type ? ` type=${e.type}` : ""}>`];
  if (e.name) parts.push(`"${e.name}"`);
  if (e.role) parts.push(`role=${e.role}`);
  if (e.value) parts.push(`value="${truncate(e.value, 40)}"`);
  if (e.placeholder && !e.name) parts.push(`placeholder="${e.placeholder}"`);
  if (e.checked != null) parts.push(e.checked ? "[checked]" : "[unchecked]");
  if (e.expanded != null) parts.push(`expanded=${e.expanded}`);
  if (e.disabled) parts.push("[disabled]");
  if (e.required) parts.push("[required]");
  if (e.invalid) parts.push("[invalid]");
  if (e.inDialog) parts.push("(in dialog)");
  if (e.context) parts.push(`(in "${truncate(e.context, 60)}")`);
  if (!e.inViewport) parts.push("(off-screen)");
  return parts.join(" ");
}

export function renderElements(elements: ElementInfo[]): string {
  // Find descriptors that would otherwise be byte-identical (same role, name,
  // context, state) so the model can't tell those elements apart. Number them
  // in document order — e.g. three identical "Add to cart" buttons become
  // (#1 of 3)/(#2 of 3)/(#3 of 3). Differences in value/state already
  // distinguish a line, so those never collide and never get an ordinal.
  const bodies = elements.map(describeElement);
  const counts = new Map<string, number>();
  for (const b of bodies) counts.set(b, (counts.get(b) ?? 0) + 1);
  const seen = new Map<string, number>();

  return elements
    .map((e, i) => {
      const body = bodies[i];
      const total = counts.get(body) ?? 1;
      let line = `[${e.index}] ${body}`;
      if (total > 1) {
        const k = (seen.get(body) ?? 0) + 1;
        seen.set(body, k);
        line += ` (#${k} of ${total})`;
      }
      return line;
    })
    .join("\n");
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** A snapshot plus the mapping from element index to the frame that owns it. */
export interface FrameSnapshot extends PageSnapshot {
  /** Resolves an element index to the Playwright frame it lives in. */
  owner: Map<number, Frame>;
}

/**
 * Capture a fresh snapshot across *all* frames (main document + iframes). We
 * re-index on every step so refs stay valid relative to the current DOM, and
 * indices are globally unique so the agent never needs to think about frames.
 */
export async function snapshot(page: Page, opts: { hasTotp?: boolean } = {}): Promise<FrameSnapshot> {
  const elements: ElementInfo[] = [];
  const owner = new Map<number, Frame>();
  let title = "";
  let mainText = "";
  const frameTexts: string[] = [];
  let hasCanvas = false;
  let hasOpenDialog = false;
  let offset = 0;

  for (const frame of page.frames()) {
    let res: { elements: ElementInfo[]; text: string; title: string; hasCanvas: boolean; hasOpenDialog: boolean };
    try {
      res = await frame.evaluate(collectInteractables, offset);
    } catch {
      // Frame detached mid-walk, or evaluation blocked — skip it.
      continue;
    }
    for (const el of res.elements) owner.set(el.index, frame);
    elements.push(...res.elements);
    offset += res.elements.length;
    hasCanvas = hasCanvas || res.hasCanvas;
    hasOpenDialog = hasOpenDialog || res.hasOpenDialog;
    if (frame === page.mainFrame()) {
      title = res.title;
      mainText = res.text;
    } else if (res.text) {
      frameTexts.push(`\n[iframe] ${res.text.slice(0, 600)}`);
    }
  }

  const text = (mainText + frameTexts.join("")).slice(0, 5000);
  const { shown, omitted } = selectForDisplay(elements);
  const dialogNote = hasOpenDialog
    ? "⚠ A modal dialog is open — its controls are marked (in dialog). Resolve it (confirm or cancel) before interacting with the page behind it.\n"
    : "";
  // Scan the visible text for an external challenge wall (CAPTCHA/2FA/email)
  // and for a cookie/consent banner. Both are surfaced even when no element is
  // addressable (a CAPTCHA iframe / "check your email" interstitial) so the
  // agent always knows WHY before it acts. Order: challenge (most blocking) →
  // consent (resolve it to proceed) → dialog.
  const challenge = detectChallenge(text);
  const errorState = detectErrorState(text);
  // Order: challenge (most blocking) → error (app broken) → auth-failure → consent → dialog.
  const banner =
    challengeNote(text, { hasTotp: opts.hasTotp }) + errorNote(text) + authFailureNote(text) + consentNote(text);
  const rendered = elements.length
    ? banner +
      dialogNote +
      renderElements(shown) +
      (omitted > 0 ? `\n… ${omitted} more interactable element(s) off-screen — scroll to reveal them.` : "")
    : banner
      ? banner + "(none detected)"
      : "(none detected)";
  return { url: page.url(), title, elements, text, rendered, hasCanvas, hasOpenDialog, challenge, errorState, owner };
}

/**
 * Decide whether to fall back to vision (screenshot + coordinate tools): the
 * DOM is too sparse to drive reliably, typically because a canvas owns the UI.
 */
export function shouldUseVision(snap: PageSnapshot): boolean {
  if (snap.elements.length === 0) return true;
  return snap.hasCanvas && snap.elements.length < 4;
}
