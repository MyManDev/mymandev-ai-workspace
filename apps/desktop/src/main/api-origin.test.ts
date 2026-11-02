import { describe, expect, test } from "vitest";
import {
  API_ORIGIN_VARIABLE,
  isApiOrigin,
  PRODUCTION_API_ORIGIN,
  resolveApiOrigin,
} from "./api-origin.ts";

describe("isApiOrigin", () => {
  test.each([
    "https://api.mymandev.example",
    "https://api.mymandev.example:8443",
    "http://127.0.0.1:3000",
    "http://localhost:3000",
    "http://localhost",
  ])("accepts %s", (origin) => {
    expect(isApiOrigin(origin)).toBe(true);
  });

  test.each([
    "",
    "http://api.mymandev.example",
    "http://192.168.1.10:3000",
    "http://[::1]:3000",
    "https://api.mymandev.example/",
    "https://api.mymandev.example/path",
    "https://api.mymandev.example:443",
    "http://localhost:80",
    "https://API.mymandev.example",
    "ftp://api.mymandev.example",
    "https://127.1",
    " https://api.mymandev.example",
  ])("refuses %j", (origin) => {
    expect(isApiOrigin(origin)).toBe(false);
  });

  test("refuses a value that is not a string", () => {
    expect(isApiOrigin(undefined)).toBe(false);
    expect(isApiOrigin(null)).toBe(false);
    expect(isApiOrigin(42)).toBe(false);
  });
});

describe("resolveApiOrigin", () => {
  test("the production origin is not chosen yet (#96)", () => {
    expect(PRODUCTION_API_ORIGIN).toBeNull();
    expect(resolveApiOrigin({ isPackaged: true, env: {} })).toEqual({
      ok: false,
      reason: "api_origin_unset",
    });
  });

  test("a packaged build never reads the environment", () => {
    const env = { [API_ORIGIN_VARIABLE]: "http://127.0.0.1:3000" };
    expect(resolveApiOrigin({ isPackaged: true, env })).toEqual({
      ok: false,
      reason: "api_origin_unset",
    });
    expect(
      resolveApiOrigin({
        isPackaged: true,
        env,
        productionOrigin: "https://api.mymandev.example",
      }),
    ).toEqual({ ok: true, origin: "https://api.mymandev.example" });
  });

  test("a packaged build refuses a production origin outside the rules", () => {
    expect(
      resolveApiOrigin({
        isPackaged: true,
        env: {},
        productionOrigin: "http://api.mymandev.example",
      }),
    ).toEqual({ ok: false, reason: "api_origin_invalid" });
  });

  test.each([
    "http://localhost",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ])("a packaged build refuses the loopback http origin %s", (origin) => {
    // Accepted in a development build, never as the production origin.
    expect(isApiOrigin(origin)).toBe(true);
    expect(
      resolveApiOrigin({ isPackaged: true, env: {}, productionOrigin: origin }),
    ).toEqual({ ok: false, reason: "api_origin_invalid" });
    expect(
      resolveApiOrigin({
        isPackaged: false,
        env: { [API_ORIGIN_VARIABLE]: origin },
      }),
    ).toEqual({ ok: true, origin });
  });

  test("a development build reads MYMANDEV_API_ORIGIN", () => {
    expect(API_ORIGIN_VARIABLE).toBe("MYMANDEV_API_ORIGIN");
    expect(
      resolveApiOrigin({
        isPackaged: false,
        env: { MYMANDEV_API_ORIGIN: "http://localhost:3000" },
        productionOrigin: "https://api.mymandev.example",
      }),
    ).toEqual({ ok: true, origin: "http://localhost:3000" });
  });

  test("a development build without the variable has no origin", () => {
    expect(resolveApiOrigin({ isPackaged: false, env: {} })).toEqual({
      ok: false,
      reason: "api_origin_unset",
    });
    expect(
      resolveApiOrigin({ isPackaged: false, env: { MYMANDEV_API_ORIGIN: "" } }),
    ).toEqual({ ok: false, reason: "api_origin_unset" });
  });

  test("a refused value does not appear in the result", () => {
    const value = "http://attacker.example:3000";
    const result = resolveApiOrigin({
      isPackaged: false,
      env: { MYMANDEV_API_ORIGIN: value },
    });
    expect(result).toEqual({ ok: false, reason: "api_origin_invalid" });
    expect(JSON.stringify(result)).not.toContain("attacker");
  });
});
