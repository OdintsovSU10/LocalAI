const DEFAULT_MONEY_SCALE = 6;

function stripCurrency(value) {
  return String(value || "")
    .trim()
    .replace(/\u00a0/g, " ")
    .replace(/[₽]/g, "")
    .replace(/(?:^|[^\p{L}\p{N}])(?:руб\.?|рубл\p{L}*)(?:[^\p{L}\p{N}]|$)/giu, "")
    .replace(/\s+/g, "");
}

function splitDecimal(value) {
  const normalized = stripCurrency(value).replace(",", ".");
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return null;
  const [integerPart, fractionalPart = ""] = normalized.split(".");
  return { integerPart, fractionalPart };
}

export function normalizeMoneyInput(value, scale = DEFAULT_MONEY_SCALE) {
  const parts = splitDecimal(value);
  if (!parts) return null;
  const paddedFraction = `${parts.fractionalPart}${"0".repeat(scale)}`.slice(0, scale);
  return `${parts.integerPart}.${paddedFraction}`;
}

function decimalToScaledInt(value, scale = DEFAULT_MONEY_SCALE) {
  const normalized = normalizeMoneyInput(value, scale);
  if (!normalized) return null;
  const negative = normalized.startsWith("-");
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [integerPart, fractionalPart] = unsigned.split(".");
  const digits = `${integerPart}${fractionalPart}`;
  const scaled = BigInt(digits);
  return negative ? -scaled : scaled;
}

function scaledIntToDecimal(value, scale = DEFAULT_MONEY_SCALE) {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, "0");
  const integerPart = digits.slice(0, -scale) || "0";
  const fractionalPart = digits.slice(-scale);
  return `${negative ? "-" : ""}${integerPart}.${fractionalPart}`;
}

export function compareMoney(left, right, tolerancePercent = 1, scale = DEFAULT_MONEY_SCALE) {
  const leftNormalized = normalizeMoneyInput(left, scale);
  const rightNormalized = normalizeMoneyInput(right, scale);
  if (!leftNormalized || !rightNormalized) {
    return {
      match: false,
      leftNormalized,
      rightNormalized,
      delta: null,
      deltaPercent: null,
      reason: "invalid_input"
    };
  }

  const leftScaled = decimalToScaledInt(leftNormalized, scale);
  const rightScaled = decimalToScaledInt(rightNormalized, scale);
  const deltaScaled = leftScaled - rightScaled;
  const absDelta = deltaScaled < 0n ? -deltaScaled : deltaScaled;
  const base = rightScaled === 0n
    ? (leftScaled === 0n ? 1n : (leftScaled < 0n ? -leftScaled : leftScaled))
    : (rightScaled < 0n ? -rightScaled : rightScaled);
  const toleranceScaled = (base * BigInt(Math.round(tolerancePercent * 10000))) / 1_000_000n;
  const match = absDelta <= toleranceScaled;
  const deltaPercent = base === 0n
    ? (absDelta === 0n ? "0" : null)
    : scaledIntToDecimal((absDelta * 100_000_000n) / base, 6);

  return {
    match,
    leftNormalized,
    rightNormalized,
    delta: scaledIntToDecimal(deltaScaled, scale),
    deltaPercent,
    reason: match ? "within_tolerance" : "outside_tolerance"
  };
}
