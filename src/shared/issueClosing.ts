/** Whether the text already closes issue `number` the way GitHub reads it (`Closes #12`, `fixed #12`, …). */
export function closesIssue(text: string, number: number): boolean {
  return new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):? #${number}\\b`, 'i').test(text)
}
