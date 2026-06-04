import { devices } from "playwright";

export interface ResolvedViewport {
  viewport: { width: number; height: number };
  userAgent?: string;
  isMobile?: boolean;
  hasTouch?: boolean;
  deviceScaleFactor?: number;
  /** Human label for the report ("desktop", "mobile", "iPhone 13", "900×600"). */
  label: string;
}

/** Named size+capability presets. Narrow widths trigger responsive layouts. */
const PRESETS: Record<string, ResolvedViewport> = {
  desktop: { viewport: { width: 1280, height: 800 }, label: "desktop" },
  tablet: {
    viewport: { width: 820, height: 1180 },
    hasTouch: true,
    deviceScaleFactor: 2,
    label: "tablet",
  },
  mobile: {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
    label: "mobile",
  },
};

/**
 * Resolve a spec's `viewport` into concrete context options. Accepts:
 *  - a named preset ("desktop" | "tablet" | "mobile")
 *  - a Playwright device name ("iPhone 13", "Pixel 5", ...)
 *  - an explicit { width, height }
 * Falls back to desktop for anything unrecognized.
 */
export function resolveViewport(v: unknown): ResolvedViewport {
  if (v == null) return PRESETS.desktop;

  if (typeof v === "object" && v !== null && "width" in v && "height" in v) {
    const { width, height } = v as { width: number; height: number };
    return { viewport: { width, height }, label: `${width}×${height}` };
  }

  if (typeof v === "string") {
    const key = v.toLowerCase();
    if (PRESETS[key]) return PRESETS[key];
    // "900x600" explicit-size form.
    const m = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(v.trim());
    if (m) {
      const width = Number(m[1]);
      const height = Number(m[2]);
      return { viewport: { width, height }, label: `${width}×${height}` };
    }
    const device = devices[v];
    if (device) {
      return {
        viewport: device.viewport,
        userAgent: device.userAgent,
        isMobile: device.isMobile,
        hasTouch: device.hasTouch,
        deviceScaleFactor: device.deviceScaleFactor,
        label: v,
      };
    }
  }

  return PRESETS.desktop;
}
