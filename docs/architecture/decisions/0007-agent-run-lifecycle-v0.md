# ADR 0007: Agent run lifecycle v0

- Status: Accepted (2026-10-28)
- Date: 2026-10-27
- Decided by: Project Manager

## Context

Agents run on their host device. Other members see run progress. The state machine must be the same in the protocol, on the server, and in the database, and terminal states must stay terminal.

## Options considered

- One `awaiting_input` state for both "waiting for a permission approval" and "waiting for a human answer" (recommended), or two states. Two states add a protocol change for every new reason to wait.
- Retry as a new run (recommended) or as a transition back from `failed`. A transition back would make terminal states non-terminal.

## Decision

| From              | Allowed next states                                  |
| ----------------- | ---------------------------------------------------- |
| (created, `null`) | `queued` (emitted by the server only)                |
| `queued`          | `running`, `failed`, `cancelled`                     |
| `running`         | `awaiting_input`, `completed`, `failed`, `cancelled` |
| `awaiting_input`  | `running`, `failed`, `cancelled`                     |
| `completed`       | none (terminal)                                      |
| `failed`          | none (terminal)                                      |
| `cancelled`       | none (terminal)                                      |

- A retry is a new run with a new `RunId`, linked through `correlationId`.
- Creating a run is a server command (M2). The server allocates the `RunId` ([ADR 0004](0004-uuidv7-identifiers.md)), stores the run, and emits `null -> queued` with a `system` actor and `deviceId: null`. A device never sends a creation transition; `decodeClientEvent` rejects `previousState: null` with `not_allowed_from_device`.
- Every later transition comes from the agent's host device, with the actor `{ kind: "agent", agentId }` matching `payload.agentId` (`invalid_actor` otherwise). The server accepts it only if the run exists in the event's workspace with that agent ([ADR 0006](0006-event-envelope-v0.md), reference binding), `previousState` equals the stored state (optimistic concurrency), and `canTransition()` allows it. The server answers an unknown run ID with the same rejection as a run in another workspace, so a device cannot probe which run IDs exist.
- A cancel request from another member is a command. Commands are out of scope for v0.
- The database stores `state` with a CHECK constraint on the six values and a second CHECK: `finished_at` is set exactly when the state is terminal (M1-03).

## Consequences

- The protocol enforces the transition rule inside the payload schema, so every decoder rejects an illegal transition.
- Retries keep a clean audit trail: one run never moves from `failed` back to `running`.

## Dependency policy

No new dependency.

## Evidence

- [`packages/protocol/src/model.ts`](../../../packages/protocol/src/model.ts): `RUN_STATES`, `INITIAL_RUN_STATE`, `TERMINAL_RUN_STATES`, `RUN_TRANSITIONS`, `canTransition`, and `isTerminalRunState`.
- The payload rule in [`packages/protocol/src/envelope.ts`](../../../packages/protocol/src/envelope.ts) and the device rule in [`packages/protocol/src/decode.ts`](../../../packages/protocol/src/decode.ts).
- Tests: [`model.test.ts`](../../../packages/protocol/src/model.test.ts) (every state pair, terminal states) and [`decode.test.ts`](../../../packages/protocol/src/decode.test.ts) (every allowed transition decodes, an illegal transition is `invalid_payload`, a run creation from a device is `not_allowed_from_device`).
- Review record: [M1 Technical Decision Set](../research/m1-technical-decision-set.md), revision 2 of 2026-10-27 (ADR 0007).

## Needs Project Manager decision

Answered by the Project Manager on 2026-10-28.

- The six state names, one `awaiting_input` state, retry as a new run, and run creation as a server command (P-19).
  - Accepted.
