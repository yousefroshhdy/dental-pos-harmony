import { describe, expect, it } from "vitest";
import { amountInWords, numberToWords, splitEgp } from "@/modules/finance/amount-words";

describe("splitEgp", () => {
  it("splits numbers and numeric strings into pounds and piastres", () => {
    expect(splitEgp("1250.50")).toEqual({ pounds: 1250, piastres: 50 });
    expect(splitEgp(1250.5)).toEqual({ pounds: 1250, piastres: 50 });
    expect(splitEgp("12")).toEqual({ pounds: 12, piastres: 0 });
    expect(splitEgp(0)).toEqual({ pounds: 0, piastres: 0 });
    expect(splitEgp("0.07")).toEqual({ pounds: 0, piastres: 7 });
  });

  it("absorbs binary noise and rounds half-up to the piastre", () => {
    expect(splitEgp(0.1 + 0.2)).toEqual({ pounds: 0, piastres: 30 });
    expect(splitEgp("1.005")).toEqual({ pounds: 1, piastres: 1 });
    expect(splitEgp("1.004")).toEqual({ pounds: 1, piastres: 0 });
    expect(splitEgp("0.999")).toEqual({ pounds: 1, piastres: 0 });
    expect(splitEgp(19.99)).toEqual({ pounds: 19, piastres: 99 });
  });

  it("refuses negative, non-numeric and too large amounts", () => {
    expect(() => splitEgp(-1)).toThrow(RangeError);
    expect(() => splitEgp("-1")).toThrow(RangeError);
    expect(() => splitEgp("abc")).toThrow(RangeError);
    expect(() => splitEgp("1e5")).toThrow(RangeError);
    expect(() => splitEgp(Number.NaN)).toThrow(RangeError);
    expect(() => splitEgp(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => splitEgp(1_000_000_000_000)).toThrow(RangeError);
    expect(splitEgp("999999999999.99")).toEqual({ pounds: 999_999_999_999, piastres: 99 });
  });
});

describe("numberToWords (Arabic)", () => {
  const cases: [number, string][] = [
    [0, "صفر"],
    [1, "واحد"],
    [2, "اثنان"],
    [10, "عشرة"],
    [11, "أحد عشر"],
    [12, "اثنا عشر"],
    [19, "تسعة عشر"],
    [20, "عشرون"],
    [21, "واحد وعشرون"],
    [99, "تسعة وتسعون"],
    [100, "مائة"],
    [101, "مائة وواحد"],
    [200, "مائتان"],
    [999, "تسعمائة وتسعة وتسعون"],
    [1000, "ألف"],
    [2000, "ألفان"],
    [3000, "ثلاثة آلاف"],
    [10_000, "عشرة آلاف"],
    [11_000, "أحد عشر ألفًا"],
    [100_000, "مائة ألف"],
    [200_000, "مائتا ألف"],
    [103_000, "مائة وثلاثة آلاف"],
    [1_000_000, "مليون"],
    [2_000_000, "مليونان"],
    [5_000_000, "خمسة ملايين"],
    [2_500_000, "مليونان وخمسمائة ألف"],
    [123_456_789, "مائة وثلاثة وعشرون مليونًا وأربعمائة وستة وخمسون ألفًا وسبعمائة وتسعة وثمانون"],
    [1_000_000_000, "مليار"],
    [3_000_000_000, "ثلاثة مليارات"],
  ];
  it.each(cases)("%d", (n, words) => {
    expect(numberToWords(n, "ar")).toBe(words);
  });
});

describe("numberToWords (English)", () => {
  const cases: [number, string][] = [
    [0, "zero"],
    [1, "one"],
    [11, "eleven"],
    [19, "nineteen"],
    [21, "twenty-one"],
    [100, "one hundred"],
    [105, "one hundred five"],
    [1000, "one thousand"],
    [1001, "one thousand one"],
    [1_000_000, "one million"],
    [2_500_000, "two million five hundred thousand"],
    [123_456_789, "one hundred twenty-three million four hundred fifty-six thousand seven hundred eighty-nine"],
    [1_000_000_000, "one billion"],
  ];
  it.each(cases)("%d", (n, words) => {
    expect(numberToWords(n, "en")).toBe(words);
  });

  it("refuses fractions, negatives and numbers beyond the billions", () => {
    expect(() => numberToWords(1.5, "en")).toThrow(RangeError);
    expect(() => numberToWords(-1, "ar")).toThrow(RangeError);
    expect(() => numberToWords(1_000_000_000_000, "ar")).toThrow(RangeError);
  });
});

describe("amountInWords (Arabic, EGP)", () => {
  const cases: [number | string, string][] = [
    [0, "فقط صفر جنيه مصري لا غير"],
    [1, "فقط جنيه مصري واحد لا غير"],
    [2, "فقط جنيهان مصريان لا غير"],
    [3, "فقط ثلاثة جنيهات مصرية لا غير"],
    [10, "فقط عشرة جنيهات مصرية لا غير"],
    [11, "فقط أحد عشر جنيهًا مصريًا لا غير"],
    [21, "فقط واحد وعشرون جنيهًا مصريًا لا غير"],
    [100, "فقط مائة جنيه مصري لا غير"],
    [105, "فقط مائة وخمسة جنيهات مصرية لا غير"],
    [200, "فقط مائتا جنيه مصري لا غير"],
    [1000, "فقط ألف جنيه مصري لا غير"],
    [2000, "فقط ألفا جنيه مصري لا غير"],
    [3000, "فقط ثلاثة آلاف جنيه مصري لا غير"],
    [11_000, "فقط أحد عشر ألف جنيه مصري لا غير"],
    ["1140.00", "فقط ألف ومائة وأربعون جنيهًا مصريًا لا غير"],
    [1_000_000, "فقط مليون جنيه مصري لا غير"],
    [2_500_000, "فقط مليونان وخمسمائة ألف جنيه مصري لا غير"],
    ["1250.50", "فقط ألف ومائتان وخمسون جنيهًا مصريًا وخمسون قرشًا لا غير"],
    [5.05, "فقط خمسة جنيهات مصرية وخمسة قروش لا غير"],
    [0.01, "فقط قرش واحد لا غير"],
    [0.02, "فقط قرشان لا غير"],
    [0.11, "فقط أحد عشر قرشًا لا غير"],
    [0.5, "فقط خمسون قرشًا لا غير"],
    [1.99, "فقط جنيه مصري واحد وتسعة وتسعون قرشًا لا غير"],
  ];
  it.each(cases)("%s", (amount, words) => {
    expect(amountInWords(amount, "ar")).toBe(words);
  });
});

describe("amountInWords (English, EGP)", () => {
  const cases: [number | string, string][] = [
    [0, "Zero Egyptian pounds only"],
    [1, "One Egyptian pound only"],
    [11, "Eleven Egyptian pounds only"],
    [100, "One hundred Egyptian pounds only"],
    [1000, "One thousand Egyptian pounds only"],
    ["1140.00", "One thousand one hundred forty Egyptian pounds only"],
    [1_000_000, "One million Egyptian pounds only"],
    ["1250.50", "One thousand two hundred fifty Egyptian pounds and fifty piastres only"],
    [2_500_000.75, "Two million five hundred thousand Egyptian pounds and seventy-five piastres only"],
    [1.01, "One Egyptian pound and one piastre only"],
    [0.01, "One piastre only"],
    [0.5, "Fifty piastres only"],
    [
      "999999999999.99",
      "Nine hundred ninety-nine billion nine hundred ninety-nine million nine hundred ninety-nine thousand nine hundred ninety-nine Egyptian pounds and ninety-nine piastres only",
    ],
  ];
  it.each(cases)("%s", (amount, words) => {
    expect(amountInWords(amount, "en")).toBe(words);
  });

  it("throws on amounts that cannot be printed", () => {
    expect(() => amountInWords(-5, "en")).toThrow(RangeError);
    expect(() => amountInWords("not a number", "ar")).toThrow(RangeError);
  });
});
