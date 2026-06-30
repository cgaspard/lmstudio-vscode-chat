/**
 * Selection-range formatting — pure helpers used by the bridge to label the
 * attached selection file-part. The actual selection capture uses vscode APIs
 * (offsetAt/getText) and stays in the bridge; only the display/label math lives
 * here so it can be unit-tested.
 */

/** Render a 1-based line range: "14" for a single line, "14-19" for a span. */
export function formatLineRange(startLine: number, endLine: number): string {
  return startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
}

/**
 * The reference label for a selection: "<rel-path>#<start>-<end>", e.g.
 * "src/app.js#14-19". Used as the attached file-part filename so the model sees
 * which file + lines the snippet came from.
 */
export function selectionLabel(relPath: string, startLine: number, endLine: number): string {
  return `${relPath}#${formatLineRange(startLine, endLine)}`;
}
