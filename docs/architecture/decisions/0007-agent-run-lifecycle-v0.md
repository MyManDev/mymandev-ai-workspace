# ADR 0007: Agent run lifecycle v0

- Status: Accepted (2026-10-28)
- Amended by [ADR 0014](0014-accounts-devices-and-invitations.md)
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
- Update of 2026-11-02 (#28): creating a run moves from M2 to #35, and no production route creates runs before it. Until then, a development-only database command, which refuses a production database, seeds an agent hosted on the developer's device and runs in `queued`, and a development-only switch in the desktop main process moves them through allowed transitions as the agent, over the real connection; these are the test source of M2. The server answers a stale `previousState` and a disabled agent with `event.refused` and `conflict`, and an unknown run and a run of another workspace alike with `not_found`, and the connection stays open. A transition sent again with the same device and event ID is never applied twice: the server records each accepted transition in a log that the database part of #28 adds, and answers a repeated one with the relayed event, sent only to the sender ([ADR 0006](0006-event-envelope-v0.md), update of 2026-11-02). The text above is unchanged.
- Update of 2026-11-06 (#201): the reason codes with which the server cancels runs, `RUN_CANCEL_REASONS` ([ADR 0014](0014-accounts-devices-and-invitations.md), P-60), come only from the server. A transition from the agent whose `reason` is one of them, in any state and also when it resends a recorded event ID, gets `event.refused` with `conflict`, nothing is stored or relayed, and the connection stays open; the decoders do not apply this rule (`runReasonAllowed`), because a decode error closes the connection. The text above is unchanged.
- Update of 2026-11-14 (#35), decided by the Project Manager: only the account that owns the agent may request a run in v0, because a run that another member requested would spend the owner's provider, which belongs to provider sharing (M5). A run carries one provider connection, which never changes after the creation, so that the enforcement point takes the scope of `provider.use` from the run that it holds ([ADR 0015](0015-capability-and-permission-contract-v0.md)). A run's input is a link to a chat message of its project, so that the instruction shows in the project's chat; a run has no text of its own. The server allocates the `RunId`, stores the run in `queued` with the asking account as its requester, and emits `null -> queued` with a `system` actor and `deviceId: null` after the commit, as decided above. The text above is unchanged.
- Update of 2026-11-14 (#35), provisional: applied as defaults until the Project Manager decides, each the more careful option, and listed as open in the [protocol README](../../../packages/protocol/README.md#run-creation). The server command that creates a run is `POST /projects/:projectId/runs`, beside the run list of the project. The owner asks from any of their devices, and the provider connection is always one of the agent's host device, which the database keeps with composite foreign keys ([ADR 0013](0013-m1-data-model.md), update of 2026-11-14). The input is any message of the project's chat that is not deleted, of any author. The run's provider connection is device data, like the agent's host device: only the account that owns the run's agent reads it, in the run list and in the creation's answer, and no event carries it. The creation's `agent.run.state_changed` gains an optional `run`, the new run as the run list shows it to every member, with its project, its creation time, and its input message; no new event type is added, and only a creation may carry it. An agent has at most 10 unfinished runs, above which a creation answers `409` with the new code `run_limit` and no `Retry-After`, and gets at most 100 runs within 24 hours, above which it answers `429` with the new code `run_daily_limit` and `Retry-After`; at both, `run_limit`. The creation carries no idempotency key and no correlation ID. No route creates an agent or registers a provider connection yet, so no run can be created in production until both exist. The text above is unchanged.
