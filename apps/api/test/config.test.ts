import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { TEST_DATA_KEYS } from "./helpers.js";

const env = (e: Record<string, string>) => ({ DATABASE_URL: "postgres://x", DATA_KEYS: TEST_DATA_KEYS, ...e }) as NodeJS.ProcessEnv;

describe("production cookie rule", () => {
  it("refuses insecure cookies on a real address", () => {
    expect(() => loadConfig(env({ NODE_ENV: "production", COOKIE_SECURE: "false", APP_URL: "https://app.example.com" }))).toThrow(/COOKIE_SECURE/);
    expect(() => loadConfig(env({ NODE_ENV: "production", COOKIE_SECURE: "false", APP_URL: "http://192.168.1.20:8787" }))).toThrow(/COOKIE_SECURE/);
    expect(() => loadConfig(env({ NODE_ENV: "production", COOKIE_SECURE: "false", APP_URL: "http://localhost.evil.com" }))).toThrow(/COOKIE_SECURE/);
  });

  it("allows plain HTTP when the app is only on this computer, which is what ./setup.sh writes with no domain", () => {
    for (const url of ["http://localhost:8787", "http://localhost", "http://127.0.0.1:8787"]) {
      expect(loadConfig(env({ NODE_ENV: "production", COOKIE_SECURE: "false", APP_URL: url })).cookieSecure).toBe(false);
    }
  });

  it("is happy with secure cookies anywhere", () => {
    expect(loadConfig(env({ NODE_ENV: "production", COOKIE_SECURE: "true", APP_URL: "https://app.example.com" })).cookieSecure).toBe(true);
  });
});
