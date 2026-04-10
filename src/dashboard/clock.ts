// clock.ts — Japanese era clock for the Wallace dashboard
// Reiwa (令和) era started May 2019, so 2026 = Reiwa 8 (令和八年).

// Kanji numeral map — covers 1-99 comfortably for era years
const KANJI_DIGITS = ["〇", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

/**
 * Convert a number (1–99) to kanji numeral string.
 * Follows traditional Japanese short-form notation:
 *   1–9  → 一 二 … 九
 *   10   → 十
 *   11–19 → 十一 … 十九
 *   20+  → 二十 … 二十九 …
 */
export function toKanjiNumber(n: number): string {
  if (n <= 0) return KANJI_DIGITS[0];
  if (n < 10) return KANJI_DIGITS[n];
  if (n === 10) return KANJI_DIGITS[10];

  const tens = Math.floor(n / 10);
  const ones = n % 10;

  let result = tens === 1 ? KANJI_DIGITS[10] : KANJI_DIGITS[tens] + KANJI_DIGITS[10];
  if (ones > 0) result += KANJI_DIGITS[ones];
  return result;
}

/**
 * Build the current era-clock string.
 * Format: 令和八年 04.10 14:32
 */
export function getEraTime(): string {
  const now = new Date();

  // Reiwa started 2019 (year 1), so 2026 → 8
  const reiwaYear = now.getFullYear() - 2018;

  const month   = String(now.getMonth() + 1).padStart(2, "0");
  const day     = String(now.getDate()).padStart(2, "0");
  const hours   = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");

  return `令和${toKanjiNumber(reiwaYear)}年 ${month}.${day} ${hours}:${minutes}`;
}

/**
 * Mount a live clock into the given element, ticking every second.
 * Returns a cancel function so callers can stop the interval.
 */
export function startClock(element: HTMLElement): () => void {
  const tick = () => {
    element.textContent = getEraTime();
  };
  tick(); // paint immediately — no blank flash on load
  const id = setInterval(tick, 1000);
  return () => clearInterval(id);
}
