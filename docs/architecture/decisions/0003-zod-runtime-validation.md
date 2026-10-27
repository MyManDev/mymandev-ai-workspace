# ADR 0003: zod 4 is the runtime validation library

- Status: Proposed
- Date: 2026-10-27
- Decided by: (filled in by the Project Manager on acceptance)

## Context

Cross-device messages are untrusted input. The protocol must validate them at runtime in three places: the Node.js API, the Electron renderer under a strict Content Security Policy, and later the Electron main process.

Requirements: strip unknown keys, including `__proto__` and `constructor` keys created by `JSON.parse`; strict UTC timestamps; branded ID types; discriminated unions with focused errors; JSON Schema export for documentation and non-TypeScript clients; works under TypeScript 6 with the repository's strict flags; works without `eval`.

## Options considered

Research measurements on 20,000 decodes of the same envelope:

| Option                | Key facts                                                                                                                                                                                                                                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| zod 4, classic API    | Passed every hostile-input case without extra code. Strips unknown keys and drops own `__proto__` and `constructor` keys. `z.iso.datetime({ precision: 3 })` accepts only UTC `Z` with milliseconds and rejects `2026-02-30`. Native JSON Schema export. 106.9 ms; works with `eval` blocked. About 28 KB gzip. |
| zod/mini 4            | Same core, about 9 KB gzip, but every message reads "Invalid input" until a locale is configured.                                                                                                                                                                                                               |
| valibot 1             | Smallest (about 3 KB gzip). Needs custom UUIDv7 and timestamp checks; its JSON Schema converter drops custom checks.                                                                                                                                                                                            |
| TypeBox (`typebox` 1) | Schemas are JSON Schema, the best fit for Fastify. But `Check()` does not strip unknown keys, `Clean()` took 8,669 ms, union errors are noisy, there are no brands and no Standard Schema, and a pattern-only timestamp accepted `2026-02-30`.                                                                  |
| arktype 2             | An own `__proto__` key survived both the `delete` and the `reject` mode, and `Object.assign({}, output)` then inherited an attacker-chosen prototype. Rejected for security.                                                                                                                                    |
| Types only            | No runtime safety for untrusted input.                                                                                                                                                                                                                                                                          |

## Decision

- zod 4 with the classic API: `import * as z from "zod"`.
- `@mymandev/protocol` declares zod as a `dependency`. Any other workspace that imports zod directly (M1-02: `apps/api` for configuration) declares the same exact version. npm then installs one hoisted copy. A zod upgrade changes every workspace in one pull request.
- Usage rules:
  1. IDs use `z.string().regex(UUIDV7_PATTERN)`, never `z.uuidv7()`, which accepts uppercase ([ADR 0004](0004-uuidv7-identifiers.md)).
  2. Objects use `z.object`, which strips unknown keys. Never `passthrough`, `looseObject`, or `strictObject` for wire data ([ADR 0006](0006-event-envelope-v0.md)).
  3. Every string and array on the wire has a maximum length.
  4. The renderer sets `z.config({ jitless: true })` before `@mymandev/protocol` is evaluated, in a module that imports zod and that the renderer entry imports first. zod reads the setting when a schema is created, not when it parses, and the protocol creates its schemas when it is evaluated, so the protocol's `enableJitlessValidation()`, called after the import, does not affect the protocol schemas. Without the setting, validation still works when code generation is blocked, because zod falls back, but zod's `new Function` probe is reported as a CSP violation.
  5. Documentation JSON Schema is exported with `io: "input"`. The default output mode adds `additionalProperties: false`, which contradicts stripping.
  6. A schema has the suffix `Schema` when a type with the same name exists (`UserIdSchema` and `UserId`). Same-name exports collided with TS2308 in the research.
  7. Error messages never include the input value. zod issues do not, unless `reportInput` is enabled.
- Fastify integration: M1-02 needs no Fastify type provider. Its only Fastify JSON Schema is the `/health` response; WebSocket frames go through `decodeClientEvent`, and configuration goes through zod. When the first REST route with a request body arrives (M2), choose between `fastify-type-provider-zod` and a small `validatorCompiler` that calls `safeParse`.

## Consequences

- About 28.7 KB gzip in the renderer for the whole protocol package, including uuid (measured with esbuild). An Electron application loads it from disk. If size ever matters, the schemas can move to zod/mini.
- Supply chain: the zod project reported that six malicious commits were pushed to its main branch on 2026-09-21 with a compromised credential and reverted the same day; according to the notice, none was published to npm. The pinned release has npm provenance and a verified registry signature. Mitigation: exact pins, the lockfile, `npm audit signatures`, and a review of every zod upgrade.
- Adding a value to a closed `z.enum` makes old receivers reject the message. That is a protocol change ([ADR 0006](0006-event-envelope-v0.md)).

## Dependency policy

- zod 4, classic API, exact pin, declared as a `dependency` by every workspace that imports it, always at the same version as `@mymandev/protocol`. A second zod copy would break `instanceof` checks on zod errors. (zod 4 keeps its global configuration, including `jitless`, on `globalThis`, so the setting itself reaches every copy.)
- Every zod upgrade is reviewed. If the Project Manager prefers a release from before the 2026-09-21 incident, the fallback is the last zod 4 release before that date; it lacks the fix that checks array bounds before elements.

## Evidence

- Schemas: [`packages/protocol/src/ids.ts`](../../../packages/protocol/src/ids.ts), [`entities.ts`](../../../packages/protocol/src/entities.ts), [`envelope.ts`](../../../packages/protocol/src/envelope.ts), and [`decode.ts`](../../../packages/protocol/src/decode.ts) (including `enableJitlessValidation`).
- Tests: [`decode.test.ts`](../../../packages/protocol/src/decode.test.ts) (hostile inputs, stripping of unknown, `__proto__`, and `constructor` keys, no mutation, JSON Schema export with `io: "input"`, and no code generation when `jitless` is set before the protocol is evaluated) and [`entities.test.ts`](../../../packages/protocol/src/entities.test.ts).
- Review record: M1 Technical Decision Set, revision 2 of 2026-10-27 (ADR 0003, Sections 2.2 and 2.5), linked from the M1-01 pull request.

## Needs Project Manager decision

- zod 4 classic (recommended), zod/mini, or valibot (P-05).
- Defer the Fastify type provider choice to the first REST route with a body in M2 (P-06).
- How the renderer enables jitless validation, agreed with the desktop owner (P-02): a renderer module that sets `z.config({ jitless: true })` before the protocol is evaluated (documented in usage rule 4), a side-effect subpath of the protocol (an exception to the ADR 0001 rule that M1 adds no subpaths), or protocol schemas that are created lazily. With the first option, `enableJitlessValidation()` has no use left and can be removed.
