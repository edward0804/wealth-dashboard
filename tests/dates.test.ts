import { describe, expect, it } from "vitest";
import { parseBenchDateIso, parseDateLoose, toIsoDateStr, todayIsoStr } from "../src/utils/dates";

describe("date helpers", () => {
  it("parses slash and hyphen dates loosely and formats ISO consistently", () => {
    const d = parseDateLoose("2026/03/09");
    expect(d).not.toBeNull();
    expect(toIsoDateStr(d)).toBe("2026-03-09");
    expect(parseDateLoose("bad")).toBeNull();
    expect(todayIsoStr(new Date(2026, 10, 5))).toBe("2026-11-05");
  });

  it("normalizes both ISO and DD/MM/YYYY benchmark timestamps", () => {
    expect(parseBenchDateIso("2026/1/5 16:00:00")).toBe("2026-01-05");
    expect(parseBenchDateIso("05/11/2026")).toBe("2026-11-05");
    expect(parseBenchDateIso("")).toBe("");
  });
});
