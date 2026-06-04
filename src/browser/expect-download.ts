/**
 * Download assertions: verify the app produced an export file (by name) AND
 * that its content is right. Sentinel already captures downloads (filename,
 * bytes, saved path); this lets a spec assert "a report.csv downloaded and it
 * contains the order's SKU" — completing export testing beyond "a file arrived".
 *
 * Pure and unit-testable: the runner reads each saved file's text and hands it
 * in; this matches expectations against it.
 */

/** A captured download with its text content read (when readable). */
export interface DownloadInfo {
  filename: string;
  /** UTF-8 content of the saved file (capped); absent for binary/failed saves. */
  content?: string;
}

export interface DownloadExpectation {
  /** Match the filename: a glob (with `*`) or substring. Omit to match any download. */
  filename?: string;
  /** A substring the matched download's text content must include. */
  contentIncludes?: string;
}

export interface DownloadCheckResult {
  expectation: DownloadExpectation;
  met: boolean;
  detail: string;
}

/** Glob (only `*` is special) or substring match for a filename. */
export function filenameMatches(name: string, pattern: string): boolean {
  if (!pattern.includes("*")) return name.includes(pattern);
  const rx = new RegExp(
    "^" + pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$"
  );
  return rx.test(name);
}

function describe(exp: DownloadExpectation): string {
  const parts = [`download${exp.filename ? ` "${exp.filename}"` : ""}`];
  if (exp.contentIncludes) parts.push(`content~"${exp.contentIncludes}"`);
  return parts.join(" ");
}

export function evaluateDownloadExpectations(
  downloads: DownloadInfo[],
  expectations: DownloadExpectation[]
): DownloadCheckResult[] {
  return expectations.map((exp) => {
    const named = exp.filename ? downloads.filter((d) => filenameMatches(d.filename, exp.filename!)) : downloads;
    const met = exp.contentIncludes
      ? named.some((d) => (d.content ?? "").includes(exp.contentIncludes!))
      : named.length > 0;
    return {
      expectation: exp,
      met,
      detail: `${met ? "met" : "UNMET"}: expected ${describe(exp)} — ${
        named.length ? `${named.length} matching download(s)` : "no matching download"
      }`,
    };
  });
}
