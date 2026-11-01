// The typed IPC contract between the renderer and the main process: a zod
// schema for the arguments and the result of every invoke channel, and for
// the payload of every event channel. The main process validates the
// arguments of every call and parses every value it sends, so unknown keys
// never reach the renderer (ADR 0003, ADR 0014). The preload script and the
// renderer import the types only, so zod is bundled into the main process
// alone and the renderer needs no `jitless` setting.
import * as z from "zod";
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  type EventChannel,
  type InvokeChannel,
} from "./ipc-channels.ts";

/** The states of the local runtime. */
export const RUNTIME_STATES = Object.freeze([
  "starting",
  "running",
  "stopping",
  "stopped",
  "failed",
] as const);

export const RuntimeStateSchema = z.enum(RUNTIME_STATES);
export type RuntimeState = z.infer<typeof RuntimeStateSchema>;

export const RuntimeStatusSchema = z.object({
  state: RuntimeStateSchema,
  /**
   * Starts at 0 and grows by one with every change of the state. A receiver
   * keeps the status with the highest revision, because the answer to a call
   * and a later event can arrive in either order.
   */
  revision: z.int().nonnegative(),
});
export type RuntimeStatus = z.infer<typeof RuntimeStatusSchema>;

/** The arguments of a channel that takes none. Extra arguments are refused. */
const NoArgumentsSchema = z.tuple([]);

/** The schemas of every invoke channel. */
export const INVOKE_CONTRACT = Object.freeze({
  [INVOKE_CHANNELS.getRuntimeStatus]: Object.freeze({
    args: NoArgumentsSchema,
    result: RuntimeStatusSchema,
  }),
  [INVOKE_CHANNELS.subscribeRuntimeStatus]: Object.freeze({
    args: NoArgumentsSchema,
    result: RuntimeStatusSchema,
  }),
});

/** The payload schema of every event channel. */
export const EVENT_CONTRACT = Object.freeze({
  [EVENT_CHANNELS.runtimeStatusChanged]: RuntimeStatusSchema,
});

export type InvokeArgs<C extends InvokeChannel> = z.infer<
  (typeof INVOKE_CONTRACT)[C]["args"]
>;

export type InvokeResult<C extends InvokeChannel> = z.infer<
  (typeof INVOKE_CONTRACT)[C]["result"]
>;

export type EventPayload<C extends EventChannel> = z.infer<
  (typeof EVENT_CONTRACT)[C]
>;
