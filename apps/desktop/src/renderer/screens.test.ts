import { expect, test } from "vitest";
import {
  createShellState,
  SCREEN_IDS,
  SCREENS,
  shellReducer,
} from "./screens.ts";

test("the shell starts on the home screen unless another screen is given", () => {
  expect(createShellState()).toEqual({ screen: "home" });
  expect(createShellState("about")).toEqual({ screen: "about" });
});

test("show-screen switches the screen without changing the previous state", () => {
  const home = createShellState();
  const about = shellReducer(home, { type: "show-screen", screen: "about" });

  expect(about).toEqual({ screen: "about" });
  expect(home).toEqual({ screen: "home" });
});

test("show-screen for the current screen returns the same state object", () => {
  const home = createShellState();

  expect(shellReducer(home, { type: "show-screen", screen: "home" })).toBe(
    home,
  );
});

test("the navigation lists every screen once", () => {
  expect(SCREENS.map((screen) => screen.id)).toEqual([...SCREEN_IDS]);
});
