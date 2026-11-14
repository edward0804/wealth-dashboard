import { describe, expect, it } from "vitest";
import {
  PwaCloudApiError,
  encodePairingCode,
  formatMaskedExecUrl,
  hasPwaCloudBridge,
  parsePairingCode,
  validateAppsScriptExecUrl
} from "../src/services/pairing";

describe("PWA pairing bridge utilities", () => {
  const validExecUrl =
    "https://script.google.com/macros/s/AKfycbxMockDeployId1234567890abcdef/exec";
  const validToken = "0123456789abcdef0123456789abcdef";

  it("validates official Apps Script /exec URLs and rejects /dev or invalid hosts", () => {
    expect(validateAppsScriptExecUrl(`  ${validExecUrl}?v=1  `)).toBe(`${validExecUrl}?v=1`);
    expect(() =>
      validateAppsScriptExecUrl("https://script.google.com/macros/s/abc/dev")
    ).toThrow(/\/dev/);
    expect(() =>
      validateAppsScriptExecUrl("https://script.google.com/home/projects/abc/edit")
    ).toThrow(/\/exec/);
    expect(() => validateAppsScriptExecUrl("https://evil.example.com/exec")).toThrow(
      /script\.google\.com/
    );
  });

  it("roundtrips WDB1 pairing codes with tolerance for quotes and whitespace", () => {
    const code = encodePairingCode(validExecUrl, validToken);
    expect(code.startsWith("WDB1:")).toBe(true);

    const messyInput = `  "${code.slice(0, 18)}\n  ${code.slice(18)}"  `;
    expect(parsePairingCode(messyInput)).toEqual({
      apiUrl: validExecUrl,
      apiToken: validToken
    });

    expect(() => encodePairingCode(validExecUrl, "short")).toThrow(/金鑰/);
    expect(() => parsePairingCode("WDB1:not-base64!!!")).toThrow(/格式不正確/);
  });

  it("masks long exec URLs and inspects bridge readiness & custom error flags", () => {
    expect(formatMaskedExecUrl("")).toBe("");
    expect(formatMaskedExecUrl("https://script.google.com/a/exec")).toBe(
      "https://script.google.com/a/exec"
    );
    const masked = formatMaskedExecUrl(validExecUrl);
    expect(masked).toContain("...");
    expect(masked.length).toBe(32 + 3 + 18);

    expect(hasPwaCloudBridge({ apiUrl: validExecUrl, apiToken: validToken })).toBe(true);
    expect(hasPwaCloudBridge({ apiUrl: validExecUrl, apiToken: "" })).toBe(false);

    const err = new PwaCloudApiError("unauth", { isUnauthorized: true });
    expect(err.isUnauthorized).toBe(true);
    expect(err.isMissingConfig).toBe(false);
  });
});
