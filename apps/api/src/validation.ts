import type { FastifySchemaCompiler } from "fastify";
import type * as z from "zod";

/**
 * Validates a request part with a zod schema from `@mymandev/protocol`
 * (ADR 0003, P-06). Register it with `setValidatorCompiler` inside the plugin
 * scope of the routes whose schemas are zod schemas; routes with JSON Schema
 * keep Fastify's default compiler. The validated value replaces the input,
 * so unknown keys are stripped. A failure becomes Fastify's validation error
 * (400 with `bad_request`) whose message names the part, the path of the
 * first issue, and the issue, and never contains an input value.
 */
export const zodValidatorCompiler: FastifySchemaCompiler<z.ZodType> = ({
  schema,
  httpPart,
}) => {
  return (data) => {
    const result = schema.safeParse(data);
    if (result.success) {
      return { value: result.data };
    }
    const issue = result.error.issues[0];
    const path = [httpPart ?? "input", ...(issue?.path ?? [])]
      .map((segment) => String(segment))
      .join("/");
    return {
      error: new Error(`${path}: ${issue?.message ?? "Invalid input"}`),
    };
  };
};
