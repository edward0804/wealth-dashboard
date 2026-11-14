import { describe, expect, it } from "vitest";
import {
  OVERVIEW_HEADER_SPECS,
  adaptSheetsToCanonical,
  colIdxToLetter,
  extractRowMeta,
  resolveHeaderMap
} from "../src/core/schema";

describe("Canonical Schema v2 adapter", () => {
  it("converts zero-based column indices to A1 letters", () => {
    expect(colIdxToLetter(0)).toBe("A");
    expect(colIdxToLetter(25)).toBe("Z");
    expect(colIdxToLetter(26)).toBe("AA");
  });

  it("maps reordered English headers without confusing Initial Shares for Shares", () => {
    const map = resolveHeaderMap(
      ["Market Value", "Initial Shares", "Shares", "Asset", "Price", "Initial Cost"],
      OVERVIEW_HEADER_SPECS
    );
    expect(map.valueTwd).toBe(0);
    expect(map.initQty).toBe(1);
    expect(map.qty).toBe(2);
    expect(map.name).toBe(3);
    expect(map.unitPrice).toBe(4);
    expect(map.initCost).toBe(5);
  });

  it("adapts custom reordered sheets and extracts tickers from GOOGLEFINANCE formulas", () => {
    const canonical = adaptSheetsToCanonical(
      {
        Overview: [
          ["Asset", "Shares", "Price", "Market Value", "Memo", "Initial Shares", "Initial Cost"],
          ["台積電", "100", "1,000", "100,000", "core", "50", "600"]
        ],
        "TW Trades": [
          ["Date", "Side", "Type", "Symbol", "Amount", "Price", "Shares"],
          ["2026/02/01", "BUY", "一次買入", "TPE:2330", "10000", "1000", "10"]
        ]
      },
      [
        ["Asset", "Shares", "Price", "Market Value"],
        ["台積電", '=SUMIFS("TPE:2330")', '=GOOGLEFINANCE("TPE:2330","price")', "=B2*C2"]
      ]
    );

    expect(canonical.canonicalVersion).toBe(2);
    expect(canonical.overviewSheetName).toBe("Overview");
    expect(canonical.twTrades[0].side).toBe("買入");
    expect(canonical.overviewRowsRaw[0].rawInitQty).toBe("50");

    const meta = extractRowMeta(
      canonical.overviewRowsRaw[0].dispRow,
      canonical.overviewRowsRaw[0].formRow,
      canonical.ovMap
    );
    expect(meta.ticker).toBe("TPE:2330");
    expect(meta.category).toBe("台股");
    expect(meta.currency).toBe("TWD");
  });
});
