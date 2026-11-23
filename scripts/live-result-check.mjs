const numberPattern = /(?<![A-Za-z0-9_])[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][-+]?\d+)?/g;

export function extractNumbers(text) {
  return [...text.matchAll(numberPattern)].map(([token]) => Number(token.replaceAll(',', ''))).filter(Number.isFinite);
}

export function containsExpectedNumbers(text, expected) {
  const actual = new Set(extractNumbers(text));
  return expected.every((value) => actual.has(Number(value)));
}
