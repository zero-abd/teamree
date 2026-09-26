// List prices per million tokens, read 2026-09-26 from Anthropic's and OpenAI's pricing pages.
// Only for the ≈$ beside token counts; a model missing here is shown without a cost.

export type Tokens = {
  input: number
  output: number
  cacheRead: number
  /** Every cache write, the 1-hour ones included. */
  cacheWrite: number
  cacheWrite1h: number
}

/** Tokens by model id; '' for a model the transcript did not name. */
export type ModelTokens = Map<string, Tokens>

type Price = { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number }

/** Anthropic: 5-minute writes 1.25×, 1-hour writes 2×, reads 0.1× input unless given. */
const CLAUDE: Record<string, [input: number, output: number, cacheRead?: number]> = {
  'claude-fable-5-1': [10, 50, 0.25],
  'claude-fable-5': [10, 50],
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25],
  'claude-opus-4-7': [5, 25],
  'claude-opus-4-6': [5, 25],
  'claude-opus-4-5': [5, 25],
  'claude-opus-4-1': [15, 75],
  'claude-opus-4': [15, 75],
  'claude-sonnet-5': [2, 10],
  'claude-sonnet-4-6': [3, 15],
  'claude-sonnet-4-5': [3, 15],
  'claude-sonnet-4': [3, 15],
  'claude-3-7-sonnet': [3, 15],
  'claude-haiku-4-5': [1, 5],
  'claude-3-5-haiku': [0.8, 4]
}

/** OpenAI: cached input is a read; there is no write charge. */
const OPENAI: Record<string, [input: number, output: number, cacheRead: number]> = {
  'gpt-5.2': [1.75, 14, 0.175],
  'gpt-5.2-codex': [1.75, 14, 0.175],
  'gpt-5.1': [1.25, 10, 0.125],
  'gpt-5.1-codex': [1.25, 10, 0.125],
  'gpt-5.1-codex-max': [1.25, 10, 0.125],
  'gpt-5.1-codex-mini': [0.25, 2, 0.025],
  'gpt-5': [1.25, 10, 0.125],
  'gpt-5-codex': [1.25, 10, 0.125],
  'gpt-5-codex-mini': [0.25, 2, 0.025],
  'gpt-5-mini': [0.25, 2, 0.025],
  'gpt-5-nano': [0.05, 0.4, 0.005]
}

const PRICES: ReadonlyMap<string, Price> = new Map([
  ...Object.entries(CLAUDE).map(([model, [input, output, cacheRead]]): [string, Price] => [
    model,
    { input, output, cacheRead: cacheRead ?? input * 0.1, cacheWrite5m: input * 1.25, cacheWrite1h: input * 2 }
  ]),
  ...Object.entries(OPENAI).map(([model, [input, output, cacheRead]]): [string, Price] => [
    model,
    { input, output, cacheRead, cacheWrite5m: input, cacheWrite1h: input }
  ])
])

/** The id without a provider prefix or version (`us.anthropic.…-v1:0`), a context tag (`[1m]`) or a date. */
export function priceKey(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/^.*?(?=claude-)/, '')
    .replace(/\[.*\]$/, '')
    .replace(/-v\d+(:\d+)?$/, '')
    .replace(/[-@](\d{8}|\d{4}-\d{2}-\d{2})$/, '')
}

export function priceOf(model: string): Price | null {
  return PRICES.get(priceKey(model)) ?? null
}

/** Dollars for these tokens, or null when any of them came from a model without a price. */
export function costOf(byModel: ModelTokens): number | null {
  let usd = 0
  for (const [model, tokens] of byModel) {
    if (isEmpty(tokens)) continue
    const price = priceOf(model)
    if (price === null) return null
    const fiveMinute = tokens.cacheWrite - tokens.cacheWrite1h
    usd +=
      (tokens.input * price.input +
        tokens.output * price.output +
        tokens.cacheRead * price.cacheRead +
        fiveMinute * price.cacheWrite5m +
        tokens.cacheWrite1h * price.cacheWrite1h) /
      1e6
  }
  return usd
}

export function emptyTokens(): Tokens {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 }
}

export function isEmpty(tokens: Tokens): boolean {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite === 0
}

/** Adds `tokens` into `into` under `model`. */
export function addTokens(into: ModelTokens, model: string, tokens: Tokens): void {
  const held = into.get(model) ?? emptyTokens()
  into.set(model, {
    input: held.input + tokens.input,
    output: held.output + tokens.output,
    cacheRead: held.cacheRead + tokens.cacheRead,
    cacheWrite: held.cacheWrite + tokens.cacheWrite,
    cacheWrite1h: held.cacheWrite1h + tokens.cacheWrite1h
  })
}
