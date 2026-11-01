import type { RuntimeState, RuntimeStatus } from "../shared/ipc-contract.ts";

/** What the renderer knows about the local runtime. */
export type RuntimeView =
  /** Outside Electron, or the main process refused the subscription. */
  | { readonly kind: "unavailable" }
  /** Waiting for the first status. */
  | { readonly kind: "pending" }
  | { readonly kind: "known"; readonly status: RuntimeStatus };

export function initialRuntimeView(bridgeAvailable: boolean): RuntimeView {
  return bridgeAvailable ? { kind: "pending" } : { kind: "unavailable" };
}

const STATE_LABELS: Readonly<Record<RuntimeState, string>> = {
  starting: "Starting",
  running: "Running",
  stopping: "Stopping",
  stopped: "Stopped",
  failed: "Failed",
};

export interface RuntimeIndicator {
  /** The state for styling: a runtime state, or "unknown". */
  readonly tone: RuntimeState | "unknown";
  readonly label: string;
}

/** The text and the tone of the runtime status indicator in the shell. */
export function describeRuntimeView(view: RuntimeView): RuntimeIndicator {
  switch (view.kind) {
    case "unavailable":
      return { tone: "unknown", label: "Local runtime: Unavailable" };
    case "pending":
      return { tone: "unknown", label: "Local runtime: Checking" };
    case "known":
      return {
        tone: view.status.state,
        label: `Local runtime: ${STATE_LABELS[view.status.state]}`,
      };
  }
}
