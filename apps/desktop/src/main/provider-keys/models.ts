// The models that a person may choose for a provider connection (#30, the
// Project Manager's decisions of 2026-11-26 and, for the list, of
// 2026-11-27). There is no default model: the person chooses the model of
// a Claude connection when they enter its API key, and the choice is kept
// on this device next to the key, in the same encrypted payload of the
// provider key store (key-file.ts). The list is closed and checked here,
// in the main process: the store writes only a
// model of it, and a stored model outside it (a key stored before models
// were chosen, or a model that this version no longer offers) counts as no
// model, so that the person is asked to choose one. No custom ID is
// accepted.
import {
  CLAUDE_MODEL_VIEWS,
  type ClaudeModelView,
} from "../../shared/ipc-contract.ts";

/** A model of a Claude connection, by its Claude API model ID. */
export type ClaudeModel = ClaudeModelView;

/**
 * The models that a Claude connection may use, in the order that the
 * Account screen offers them: Claude Fable 5.2, then the Opus, Sonnet, and
 * Haiku of the current Claude family, from the most capable to the fastest.
 */
export const CLAUDE_MODELS: readonly ClaudeModel[] = CLAUDE_MODEL_VIEWS;

/** Whether `value` is a model of the closed list of Claude models. */
export function isClaudeModel(value: unknown): value is ClaudeModel {
  return (
    typeof value === "string" &&
    (CLAUDE_MODELS as readonly string[]).includes(value)
  );
}

/**
 * Whether `model` may be stored with a key: a model of the closed list, or
 * null for a connection without a model to choose. The store refuses any
 * other value (`invalid_model`); which of the two a connection needs is
 * decided by its kind, in the provider connection service.
 */
export function isStorableModel(model: unknown): model is ClaudeModel | null {
  return model === null || isClaudeModel(model);
}

/** Whether a connection of `kind` needs a model chosen with its key. */
export function kindNeedsModel(kind: string): boolean {
  return kind === "claude";
}
