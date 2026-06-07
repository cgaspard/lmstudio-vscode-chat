/**
 * Derive a concise session title from the first user prompt. Heuristic (no LLM)
 * because local reasoning models often return empty/garbled titles. Pure + tested.
 */
export function deriveTitle(text: string): string {
  const t = (text ?? '')
    .replace(/```[\s\S]*?```/g, ' ') // drop fenced code
    .replace(/`([^`]*)`/g, '$1') // unwrap inline code
    .replace(/https?:\/\/\S+/g, ' ') // drop URLs
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) {
    return '';
  }
  const firstSentence = t.split(/(?<=[.!?])\s|\n/)[0].trim() || t;
  const words = firstSentence.split(' ').slice(0, 8).join(' ');
  let title = words.length > 52 ? words.slice(0, 52).trim() + '…' : words;
  title = title.replace(/[.,;:]+$/, '');
  return title.charAt(0).toUpperCase() + title.slice(1);
}
