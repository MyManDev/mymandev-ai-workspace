// The screen structure of the shell: a typed state and a reducer instead of a
// router library (ADR 0016). The product screens replace the placeholders in
// M0-04.

export const SCREEN_IDS = ["home", "about"] as const;

export type ScreenId = (typeof SCREEN_IDS)[number];

export interface ScreenDefinition {
  readonly id: ScreenId;
  /** The label in the navigation. */
  readonly label: string;
}

/** The screens in navigation order. */
export const SCREENS: readonly ScreenDefinition[] = [
  { id: "home", label: "Home" },
  { id: "about", label: "About" },
];

export interface ShellState {
  readonly screen: ScreenId;
}

export interface ShowScreenAction {
  readonly type: "show-screen";
  readonly screen: ScreenId;
}

export type ShellAction = ShowScreenAction;

export function createShellState(screen: ScreenId = "home"): ShellState {
  return { screen };
}

/** Returns the same state object when nothing changes, so React skips the render. */
export function shellReducer(
  state: ShellState,
  action: ShellAction,
): ShellState {
  switch (action.type) {
    case "show-screen":
      return action.screen === state.screen
        ? state
        : { ...state, screen: action.screen };
  }
}
