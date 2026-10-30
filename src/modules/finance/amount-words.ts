/**
 * Amounts in words for printed invoices and receipts ("tafqeet"), in Arabic and
 * English, for Egyptian pounds and piastres (1 EGP = 100 piastres). No dependency.
 *
 *   amountInWords(1250.5, "ar") → "فقط ألف ومائتان وخمسون جنيهًا مصريًا وخمسون قرشًا لا غير"
 *   amountInWords(1250.5, "en") → "One thousand two hundred fifty Egyptian pounds and fifty piastres only"
 *
 * Arabic follows the usual invoice grammar for a masculine counted noun:
 *   1 → "جنيه مصري واحد", 2 → dual "جنيهان مصريان", 3–10 → plural "جنيهات مصرية",
 *   11–99 → accusative singular "جنيهًا مصريًا", otherwise singular "جنيه مصري"
 *   (decided by the last two digits; e.g. 103 → plural, 111 → accusative, 100 → singular).
 * Thousands, millions and billions follow the same rule (ألف/ألفان/آلاف/ألفًا …); before
 * the currency noun a dual or accusative scale takes its construct form (مائتا، ألفا،
 * "أحد عشر ألف جنيه").
 * Supports 0 … 999,999,999,999.99; amounts are rounded half-up to the piastre.
 */

export type WordsLang = "ar" | "en";

/** Largest whole-pound part that can be written in words (999,999,999,999.99 in all). */
export const MAX_WORDS_POUNDS = 999_999_999_999;

/** An amount (number or numeric string from PostgREST) → whole pounds and piastres. */
export function splitEgp(value: number | string): { pounds: number; piastres: number } {
  const text = typeof value === "number" ? numberText(value) : value.trim();
  const m = /^(\d+)(?:\.(\d*))?$/.exec(text);
  if (!m) throw new RangeError(`not a non-negative amount: ${String(value)}`);
  let pounds = Number(m[1]);
  const fraction = (m[2] ?? "").padEnd(3, "0");
  let piastres = Number(fraction.slice(0, 2));
  if (Number(fraction[2]) >= 5) piastres += 1; // half-up on the third decimal
  if (piastres === 100) {
    pounds += 1;
    piastres = 0;
  }
  if (!Number.isSafeInteger(pounds) || pounds > MAX_WORDS_POUNDS) {
    throw new RangeError(`amount too large for words: ${String(value)}`);
  }
  return { pounds, piastres };
}

function numberText(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`not a non-negative amount: ${value}`);
  // Six decimals absorb binary noise (0.1 + 0.2) before rounding to the piastre.
  return value.toFixed(6);
}

/** A whole number (0 … 999,999,999,999) in words. */
export function numberToWords(n: number, lang: WordsLang): string {
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX_WORDS_POUNDS) throw new RangeError(`unsupported number: ${n}`);
  return lang === "ar" ? arabicNumber(n) : englishNumber(n);
}

/** The full "amount in words" line of a printed document. */
export function amountInWords(value: number | string, lang: WordsLang): string {
  const { pounds, piastres } = splitEgp(value);
  return lang === "ar" ? arabicAmount(pounds, piastres) : englishAmount(pounds, piastres);
}

// ---------------------------------------------------------------------------
// Arabic
// ---------------------------------------------------------------------------
const AR_ONES = ["", "واحد", "اثنان", "ثلاثة", "أربعة", "خمسة", "ستة", "سبعة", "ثمانية", "تسعة"];
const AR_TEENS = ["عشرة", "أحد عشر", "اثنا عشر", "ثلاثة عشر", "أربعة عشر", "خمسة عشر", "ستة عشر", "سبعة عشر", "ثمانية عشر", "تسعة عشر"];
const AR_TENS = ["", "", "عشرون", "ثلاثون", "أربعون", "خمسون", "ستون", "سبعون", "ثمانون", "تسعون"];
const AR_HUNDREDS = ["", "مائة", "مائتان", "ثلاثمائة", "أربعمائة", "خمسمائة", "ستمائة", "سبعمائة", "ثمانمائة", "تسعمائة"];

interface ArabicNoun {
  one: string;
  two: string;
  plural: string;
  accusative: string;
}

const AR_SCALES: ArabicNoun[] = [
  { one: "ألف", two: "ألفان", plural: "آلاف", accusative: "ألفًا" },
  { one: "مليون", two: "مليونان", plural: "ملايين", accusative: "مليونًا" },
  { one: "مليار", two: "ملياران", plural: "مليارات", accusative: "مليارًا" },
];
const AR_POUND: ArabicNoun = { one: "جنيه مصري", two: "جنيهان مصريان", plural: "جنيهات مصرية", accusative: "جنيهًا مصريًا" };
const AR_PIASTRE: ArabicNoun = { one: "قرش", two: "قرشان", plural: "قروش", accusative: "قرشًا" };

/**
 * Before a counted noun, a dual loses its final ن and an accusative scale its tanween
 * (construct state): "مائتا جنيه", "ألفا جنيه", "أحد عشر ألف جنيه".
 */
const AR_CONSTRUCT: [string, string][] = [
  ["مائتان", "مائتا"],
  ["ألفان", "ألفا"],
  ["مليونان", "مليونا"],
  ["ملياران", "مليارا"],
  ["ألفًا", "ألف"],
  ["مليونًا", "مليون"],
  ["مليارًا", "مليار"],
];

function arabicBelow100(n: number): string {
  if (n < 10) return AR_ONES[n] ?? "";
  if (n < 20) return AR_TEENS[n - 10] ?? "";
  const unit = n % 10;
  const ten = AR_TENS[Math.floor(n / 10)] ?? "";
  return unit ? `${AR_ONES[unit]} و${ten}` : ten;
}

function arabicBelow1000(n: number): string {
  const parts: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds) parts.push(AR_HUNDREDS[hundreds] ?? "");
  if (rest) parts.push(arabicBelow100(rest));
  return parts.join(" و");
}

function construct(words: string): string {
  for (const [dual, form] of AR_CONSTRUCT) if (words.endsWith(dual)) return words.slice(0, -dual.length) + form;
  return words;
}

/** "n <noun>" with the noun form the count takes. */
function arabicCounted(n: number, noun: ArabicNoun, words: (k: number) => string): string {
  if (n === 1) return noun.one;
  if (n === 2) return noun.two;
  const lastTwo = n % 100;
  if (lastTwo >= 3 && lastTwo <= 10) return `${words(n)} ${noun.plural}`;
  if (lastTwo >= 11) return `${words(n)} ${noun.accusative}`;
  return `${construct(words(n))} ${noun.one}`;
}

function arabicNumber(n: number): string {
  if (n === 0) return "صفر";
  const parts: string[] = [];
  const groups: number[] = [];
  for (let rest = n; rest > 0; rest = Math.floor(rest / 1000)) groups.push(rest % 1000);
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i] ?? 0;
    if (!g) continue;
    const scale = i > 0 ? AR_SCALES[i - 1] : undefined;
    parts.push(scale ? arabicCounted(g, scale, arabicBelow1000) : arabicBelow1000(g));
  }
  return parts.join(" و");
}

function arabicUnit(n: number, noun: ArabicNoun): string {
  if (n === 0) return `صفر ${noun.one}`;
  if (n === 1) return `${noun.one} واحد`;
  return arabicCounted(n, noun, arabicNumber);
}

function arabicAmount(pounds: number, piastres: number): string {
  const parts: string[] = [];
  if (pounds > 0 || piastres === 0) parts.push(arabicUnit(pounds, AR_POUND));
  if (piastres > 0) parts.push(arabicUnit(piastres, AR_PIASTRE));
  return `فقط ${parts.join(" و")} لا غير`;
}

// ---------------------------------------------------------------------------
// English
// ---------------------------------------------------------------------------
const EN_ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
];
const EN_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const EN_SCALES = ["", "thousand", "million", "billion"];

function englishBelow100(n: number): string {
  if (n < 20) return EN_ONES[n] ?? "";
  const unit = n % 10;
  const ten = EN_TENS[Math.floor(n / 10)] ?? "";
  return unit ? `${ten}-${EN_ONES[unit]}` : ten;
}

function englishBelow1000(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (hundreds) parts.push(`${EN_ONES[hundreds]} hundred`);
  if (rest) parts.push(englishBelow100(rest));
  return parts.join(" ");
}

function englishNumber(n: number): string {
  if (n === 0) return "zero";
  const parts: string[] = [];
  const groups: number[] = [];
  for (let rest = n; rest > 0; rest = Math.floor(rest / 1000)) groups.push(rest % 1000);
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i] ?? 0;
    if (!g) continue;
    parts.push(i > 0 ? `${englishBelow1000(g)} ${EN_SCALES[i]}` : englishBelow1000(g));
  }
  return parts.join(" ");
}

function englishAmount(pounds: number, piastres: number): string {
  const parts: string[] = [];
  if (pounds > 0 || piastres === 0) parts.push(`${englishNumber(pounds)} Egyptian ${pounds === 1 ? "pound" : "pounds"}`);
  if (piastres > 0) parts.push(`${englishNumber(piastres)} ${piastres === 1 ? "piastre" : "piastres"}`);
  const text = `${parts.join(" and ")} only`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}
