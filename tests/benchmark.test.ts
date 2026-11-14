import { describe, expect, it } from "vitest";
import { parseBenchmarkSeries } from "../src/core/benchmark";

describe("parseBenchmarkSeries", () => {
  it("performs step-function binary search lookup and converts USD benchmarks to TWD", () => {
    const rows = [
      ["TPE:0050", "Close", "VT", "Close", "VOO", "Close", "QQQ", "Close", "USDTWD", "Close"],
      ["", "", "", "", "", "", "", "", "", ""],
      ["2026-01-01", "180", "2026-01-01", "110", "", "", "", "", "2026-01-01", "32.0"],
      ["2026-02-01", "200", "2026-02-01", "120", "", "", "", "", "2026-02-01", "33.0"]
    ];

    const bench = parseBenchmarkSeries(rows, 32.5, [], {});
    expect(bench.getFx("2026-01-15")).toBe(32.0);
    expect(bench.getTwdPrice("TPE:0050", "2026-01-15")).toBe(180);
    expect(bench.getTwdPrice("VT", "2026-01-15")).toBeCloseTo(110 * 32.0, 6);
    expect(bench.getTwdPrice("VT", "2026-02-10")).toBeCloseTo(120 * 33.0, 6);
  });
});
