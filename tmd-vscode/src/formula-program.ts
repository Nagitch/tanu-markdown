/** Convert a zero-based column index to its spreadsheet label. */
export function spreadsheetColumnName(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error("Formula column indexes must be nonnegative safe integers.");
  }
  let value = index + 1;
  let label = "";
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}
