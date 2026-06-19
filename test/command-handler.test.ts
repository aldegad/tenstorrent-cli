import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { handleLine } from "../src/index";

const logSpy = spyOn(console, "log").mockImplementation(() => {});
const errorSpy = spyOn(console, "error").mockImplementation(() => {});

afterEach(() => {
  logSpy.mockClear();
  errorSpy.mockClear();
});

describe("handleLine", () => {
  test("reports command failures to the caller", async () => {
    await expect(handleLine("/video hello --model nope")).resolves.toEqual({
      shouldExit: false,
      failed: true,
    });
    expect(errorSpy).toHaveBeenCalledWith("모르는 video 모델이야: nope");
  });

  test("treats unknown slash commands as failures", async () => {
    await expect(handleLine("/wat")).resolves.toEqual({
      shouldExit: false,
      failed: true,
    });
    expect(errorSpy).toHaveBeenCalledWith("✗ 모르는 명령이야. /help 쳐봐.");
  });

  test("keeps successful control commands at zero failure state", async () => {
    await expect(handleLine("/help")).resolves.toEqual({
      shouldExit: false,
      failed: false,
    });
    await expect(handleLine("/exit")).resolves.toEqual({
      shouldExit: true,
      failed: false,
    });
  });
});
