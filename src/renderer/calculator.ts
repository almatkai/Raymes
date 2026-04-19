import { create, all, type MathJsInstance } from 'mathjs'

/**
 * Lazy-initialized math.js scope. Building the full instance is cheap
 * (a few ms) but we still avoid paying it until the first keystroke that
 * could actually be an expression.
 */
let mathInstance: MathJsInstance | null = null

function getMath(): MathJsInstance {
  if (!mathInstance) {
    // mathjs's exported `all` factory map is typed as possibly-undefined,
    // but at runtime it's always populated — hence the assertion.
    mathInstance = create(all!)
  }
  return mathInstance
}

export type CalcResult = {
  /** Original trimmed input (what the user typed). */
  expression: string
  /** Display string — e.g. "3.1415", "42 km/h", "[1, 2]". */
  formatted: string
  /** Value suitable for clipboard. Always a plain string. */
  clipboard: string
}

/**
 * We gate expression evaluation to inputs that unambiguously look like math.
 *
 * Reasons:
 *   - `math.evaluate("pi")` returns 3.1415… which would fire the calc UI on
 *     every three-letter word starting with `pi` (pictures, picasso, …).
 *   - `math.evaluate("5")` returns 5 — technically correct but useless noise.
 *   - Bare words like `hello` evaluate to the string `"hello"` in math.js so
 *     we have to filter them out explicitly.
 *
 * Heuristics we accept:
 *   1. Contains a math operator or parens:  + - * / ^ % ( )
 *   2. Contains a function call:             sqrt(, sin(, log(, ...
 *   3. Contains a unit conversion keyword:   "to" / "in" between tokens
 *      (e.g. `1 km to m`, `10 usd in eur`).
 *   4. Matches "X% of Y" natural-language percentage.
 */
const OPERATOR_RE = /[+\-*/^%()]/
const FUNCTION_CALL_RE = /[a-zA-Z_][a-zA-Z0-9_]*\s*\(/
const UNIT_CONVERSION_RE = /\s(to|in)\s/i
const PERCENT_OF_RE = /^(\d+(?:\.\d+)?)\s*%\s+of\s+(\d+(?:\.\d+)?)$/i

function looksLikeMath(input: string): boolean {
  if (OPERATOR_RE.test(input)) return true
  if (FUNCTION_CALL_RE.test(input)) return true
  if (UNIT_CONVERSION_RE.test(input)) return true
  if (PERCENT_OF_RE.test(input)) return true
  return false
}

/**
 * math.js's `evaluate("hello")` returns the string `"hello"` instead of
 * throwing, so we need to reject any non-numeric result explicitly.
 *
 * Accepted shapes: finite number, math Unit, BigNumber, Complex, Fraction,
 * Matrix. Rejected: string, boolean, function, undefined, node, etc.
 */
function isCalcValue(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'bigint') return true
  if (value && typeof value === 'object') {
    const isA = (value as { isNode?: boolean; type?: string }).isNode === true
    if (isA) return false
    return true
  }
  return false
}

function formatValue(math: MathJsInstance, value: unknown): string {
  try {
    const formatted = math.format(value, { precision: 14 })
    return typeof formatted === 'string' ? formatted : String(value)
  } catch {
    return String(value)
  }
}

export function evaluateExpression(rawInput: string): CalcResult | null {
  const expression = rawInput.trim()
  if (!expression) return null

  const percentMatch = PERCENT_OF_RE.exec(expression)
  if (percentMatch) {
    const pct = parseFloat(percentMatch[1]!)
    const of = parseFloat(percentMatch[2]!)
    if (!Number.isFinite(pct) || !Number.isFinite(of)) return null
    const result = (pct / 100) * of
    const formatted = String(result)
    return { expression, formatted, clipboard: formatted }
  }

  if (!looksLikeMath(expression)) return null

  const math = getMath()
  try {
    const value = math.evaluate(expression)
    if (!isCalcValue(value)) return null

    const formatted = formatValue(math, value)
    // Reject results that are exactly equal to the input — e.g. typing `(x)`
    // would just echo `x` back and feel pointless as a calc row.
    if (formatted === expression) return null
    return { expression, formatted, clipboard: formatted }
  } catch {
    return null
  }
}
