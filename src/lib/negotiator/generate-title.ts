/** Generate a short title from the question (5 words max, no filler) */
export function generateTitle(question: string): string {
  // Strip filler phrases
  let q = question
    .replace(
      /^(we need to |we're |our |we want to |should (we|i) |what |how should |decide |help me )/i,
      ""
    )
    .replace(/\?.*$/, "")
    .trim();

  // Take first ~5 meaningful words
  const words = q.split(/\s+/).filter((w) => w.length > 0);
  const title = words.slice(0, 5).join(" ");

  // Capitalize first letter
  return title.charAt(0).toUpperCase() + title.slice(1);
}
