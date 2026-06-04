import path from "node:path";

/**
 * Decide which files to feed a native file chooser. For a multi-select input
 * we offer everything; for a single-select we rotate through the available
 * files one per chooser (so a flow with two uploads uses two distinct files).
 * Pure/testable; the session does the actual `chooser.setFiles`.
 */
export function pickUploadFiles(
  available: string[],
  isMultiple: boolean,
  index: number
): { files: string[]; nextIndex: number } {
  if (!available.length) return { files: [], nextIndex: index };
  if (isMultiple) return { files: available, nextIndex: index };
  return { files: [available[index % available.length]], nextIndex: index + 1 };
}

/** A short note describing what was fed to a chooser, for the report. */
export function describeUpload(files: string[]): string {
  if (!files.length) return "no file configured — upload cancelled";
  return files.map((f) => path.basename(f)).join(", ");
}
