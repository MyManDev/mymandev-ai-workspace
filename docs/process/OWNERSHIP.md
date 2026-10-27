# Ownership

Ownership means default responsibility and review authority.
It does not mean exclusive access.

Tasks may move between developers when workload, availability, dependencies, or project risk make reassignment useful.

## Project Manager

GitHub: @SpeedyV5

Default responsibilities:

- product direction
- task prioritization
- task assignment and reassignment
- final architecture decisions
- shared-boundary decisions
- cloud control plane
- protocol design
- database and persistence baseline
- authentication and authorization architecture
- permission model
- merge decisions
- release decisions

## Ertugrul

GitHub: @ErtugrulS32175

Default implementation areas:

- desktop application
- desktop UX
- local runtime
- repository mounting
- Git integration
- filesystem integration
- local process execution
- desktop realtime integration
- activity visualization

These areas are defaults, not permanent exclusive zones.

## Shared boundaries

The following require explicit coordination:

- cross-device protocol
- event schemas
- repository permission contracts
- agent capability contracts
- security boundaries
- shared TypeScript types
- authentication contracts
- database entities consumed by both desktop and cloud
- destructive migrations
- architecture documents

If both developers need the same shared boundary, agree on the contract before building independent implementations.

## Task reassignment

A task may move between developers when:

- the current owner is overloaded
- the current owner is blocked
- another task becomes more urgent
- another developer already has the required context
- reassignment reduces merge conflict risk
- the Project Manager decides reassignment is better for delivery

A handoff should record:

- From
- To
- Current state
- Completed
- Remaining
- Important context
- Known risks
- Recommended next step

Reassignment changes responsibility for the task, not authorship of existing commits.
