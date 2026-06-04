import type { Page } from "playwright";

/**
 * Responsive-layout check: a page whose document is wider than the viewport
 * (the whole body scrolls horizontally) is almost always a layout bug —
 * overflowing content, a fixed-width element, an unwrapped long string — and
 * it's the #1 thing that breaks on the mobile viewports Sentinel tests. This is
 * a deterministic signal the LLM judge can't reliably see from text alone.
 */
export interface LayoutMetrics {
  scrollWidth: number;
  clientWidth: number;
  horizontalOverflow: boolean;
}

/**
 * Pure overflow test. A few px of slop avoids false positives from sub-pixel
 * rounding / scrollbar width; a real overflow is many pixels.
 */
export function hasHorizontalOverflow(m: { scrollWidth: number; clientWidth: number }): boolean {
  return m.scrollWidth - m.clientWidth > 4;
}

/** Measure the document vs viewport width on the live page. Best-effort. */
export async function measureLayout(page: Page): Promise<LayoutMetrics> {
  const m = await page
    .evaluate(() => {
      const d = document.documentElement;
      return { scrollWidth: d.scrollWidth, clientWidth: d.clientWidth };
    })
    .catch(() => ({ scrollWidth: 0, clientWidth: 0 }));
  return { ...m, horizontalOverflow: hasHorizontalOverflow(m) };
}
