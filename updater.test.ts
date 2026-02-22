import { test, expect } from "bun:test";
import { isNewer, getAssetName } from "./updater.ts";

test("isNewer: newer version returns true", () => {
  expect(isNewer("1.0.0", "1.0.1")).toBe(true);
  expect(isNewer("1.0.0", "1.1.0")).toBe(true);
  expect(isNewer("1.0.0", "2.0.0")).toBe(true);
});

test("isNewer: same version returns false", () => {
  expect(isNewer("1.0.0", "1.0.0")).toBe(false);
});

test("isNewer: older version returns false", () => {
  expect(isNewer("1.1.0", "1.0.0")).toBe(false);
  expect(isNewer("2.0.0", "1.9.9")).toBe(false);
});

test("isNewer: handles v prefix in remote", () => {
  expect(isNewer("1.0.0", "v1.0.1")).toBe(true);
  expect(isNewer("1.0.0", "v1.0.0")).toBe(false);
});

test("getAssetName: returns correct name per platform", () => {
  expect(getAssetName("darwin")).toBe("dida-feishu-macos");
  expect(getAssetName("win32")).toBe("dida-feishu.exe");
  expect(getAssetName("linux")).toBe("dida-feishu-linux");
});
