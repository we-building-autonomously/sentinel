/**
 * Heuristic: is the page still client-side rendering? Network-idle fires before
 * an SPA finishes hydrating, so the first snapshot can be an empty "Loading…"
 * shell. We detect that and wait a beat before observing. Pure/testable; the
 * session gathers the raw signals from the page and passes them here.
 */
export interface LoadingSignals {
  /** An [aria-busy=true] or [role=progressbar] element is present. */
  ariaBusy: boolean;
  /** Count of interactable elements found. */
  interactive: number;
  /** Trimmed leading visible text (a couple hundred chars). */
  text: string;
}

const LOADING_TEXT = /^(loading\b|loading…|loading\.\.\.|please wait|just a (moment|sec)|one moment)/i;

export function looksLoading(s: LoadingSignals): boolean {
  if (s.ariaBusy) return true;
  // A near-empty page whose only text is a loading word is still rendering.
  if (s.interactive < 3 && LOADING_TEXT.test(s.text.trim())) return true;
  return false;
}
