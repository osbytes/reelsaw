/**
 * Whether `text` matches `glob`, where `*` is any run of characters and everything else is literal, anchored at
 * both ends. Linear in the input: the literal pieces are found left to right with `indexOf`, never by
 * backtracking, so a pattern with many stars cannot be made slow by the text it is tested against (a RegExp of
 * `.*` pieces can: `a*a*a*a*b` against a long run of `a` takes seconds).
 */
export function globMatch(glob: string, text: string): boolean {
  const parts = glob.split("*");
  if (parts.length === 1) return glob === text;
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  if (text.length < first.length + last.length || !text.startsWith(first) || !text.endsWith(last)) return false;
  let at = first.length;
  const end = text.length - last.length;
  for (const piece of parts.slice(1, -1)) {
    if (!piece) continue;
    const found = text.indexOf(piece, at);
    if (found < 0 || found + piece.length > end) return false;
    at = found + piece.length;
  }
  return true;
}
