import type { ProjectSummary } from "./screens.ts";

/**
 * The projects that the product UI skeleton shows. They are placeholders: the
 * workspace's real projects come from the cloud API in a later milestone.
 */
export const PLACEHOLDER_PROJECTS: readonly ProjectSummary[] = Object.freeze([
  { id: "sample-project-a", name: "Sample project A" },
  { id: "sample-project-b", name: "Sample project B" },
  { id: "sample-project-c", name: "Sample project C" },
]);
