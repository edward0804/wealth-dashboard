import { describe, expect, it } from "vitest";
import { escapeHtml, safeStorageGet, safeStorageJsonGet } from "../src/utils/storage";
import {
  formatPctValue,
  formatQtyValue,
  formatTwdValue,
  formatUsdValue,
  parseNum
} from "../src/utils/formatters";

describe("parseNum & privacy-aware formatters", () => {
  it("parses formatted currency strings and rejects sentinel #N/A", () => {
    expect(parseNum("NT$ 1,234,567")).toBe(1234567);
    expect(parseNum("US$ -89.50")).toBe(-89.5);
    expect(parseNum("#N/A")).toBe(0);
    expect(parseNum("")).toBe(0);
    expect(parseNum(null)).toBe(0);
  });

  it("formats TWD, USD, quantity, and percent values with signed & privacy masking", () => {
    expect(formatTwdValue(12345.6, false, true)).toBe("+NT$12,346");
    expect(formatTwdValue(-500, false, true)).toBe("-NT$500");
    expect(formatTwdValue(999, true, true)).toBe("+NT$ ****");
    expect(formatUsdValue(1200.5, false, true)).toBe("+USD $1,200.50");
    expect(formatUsdValue(-40, true, true)).toBe("-USD ****");
    expect(formatQtyValue(12.34567, false, " 股")).toBe("12.3457 股");
    expect(formatQtyValue(0, false, " 股")).toBe("—");
    expect(formatQtyValue(10, true, " 股")).toBe("**** 股");
    expect(formatPctValue(8.126, true)).toBe("+8.13%");
    expect(formatPctValue(null)).toBe("—");
  });

  it("escapes XSS payloads and handles failing storage safely", () => {
    expect(escapeHtml(`<img src=x onerror="alert('1')">`)).toBe(
      "&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;"
    );
    const brokenStore = {
      getItem() {
        throw new Error("quota/sandbox denied");
      },
      setItem() {
        throw new Error("denied");
      }
    };
    expect(safeStorageGet(brokenStore, "k", "fallback")).toBe("fallback");
    expect(safeStorageJsonGet(brokenStore, "k", { a: 1 })).toEqual({ a: 1 });
  });
});
