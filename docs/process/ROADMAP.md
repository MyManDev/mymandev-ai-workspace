# Initial Roadmap

The first milestones build a secure local-first foundation before high-autonomy agent behavior.

## M0 - Repository and application foundation

### M0-01 Repository bootstrap

Owner: Project Manager

Finished when:

- repository exists
- develop is default
- main is release branch
- governance documents exist
- AI attribution protections exist
- initial task queue exists

### M0-02 Monorepo and tooling baseline

Default owner: Project Manager

Scope:

- npm workspaces
- shared TypeScript configuration
- lint baseline
- formatting baseline
- root scripts
- package boundaries

Do not implement desktop UI in this task.

### M0-03 Desktop application shell

Default owner: Ertugrul

Scope:

- Electron
- React
- TypeScript
- application shell
- routing
- base layout
- development startup

Do not implement the cloud API in this task.

### M0-04 Product UI skeleton

Default owner: Ertugrul

Scope:

- project navigation
- project chat layout
- agent panel
- repository panel
- tasks and decisions navigation
- permission screen shell

No real agent execution yet.

## M1 - Core contracts and local runtime

### M1-01 Protocol v0

Default owner: Project Manager

Define:

- actor identity
- device identity
- repository identity
- agent identity
- event envelope
- agent run lifecycle
- repository capability vocabulary

This is a shared boundary.

### M1-02 Cloud API skeleton

Default owner: Project Manager

Scope:

- REST API
- WebSocket gateway
- health endpoint
- configuration
- typed protocol package integration

### M1-03 PostgreSQL baseline

Default owner: Project Manager

Scope:

- database package
- migrations
- users
- devices
- projects
- repositories
- agents
- conversations
- messages
- permission grants
- agent runs

### M1-04 Local Runtime and IPC

Default owner: Ertugrul

Scope:

- Electron main process
- renderer-to-main IPC
- runtime lifecycle
- local runtime status
- safe process boundary

### M1-05 Repository mount and Git inspection

Default owner: Ertugrul

Scope:

- select local repository
- validate Git repository
- read remote information
- read current branch
- read Git status
- file watching

Read-only first.

### M1-06 Capability and permission contract v0

Owners: shared

Initial capabilities:

- repo.read
- repo.write
- terminal.execute
- git.commit
- git.push
- provider.use

No implementation may infer one capability from another.

## M2 - Realtime collaboration

### M2-01 WebSocket protocol
Default owner: Project Manager

### M2-02 Desktop WebSocket client
Default owner: Ertugrul

### M2-03 Project chat

Project Manager:
- backend
- persistence
- authorization

Ertugrul:
- desktop UI
- realtime rendering

### M2-04 Agent activity stream

Project Manager:
- event contract
- server routing

Ertugrul:
- desktop visualization

### M2-05 Two-device integration test

Owners: shared

Finished when two physical devices can:

- connect to the same workspace
- see each other's presence
- receive the same project events
- exchange project chat messages

## M3 - Agent execution

Add provider adapters only after permission enforcement exists.

Planned areas:

- Claude adapter
- Codex adapter
- provider connection status
- local credential storage
- context builder
- agent run state machine
- tool execution
- audit trail

## M4 - Cross-agent and cross-repository work

Planned areas:

- agent-to-agent messages
- repository-scoped context
- cross-repository conversations
- task dependencies
- human escalation
- decision objects

## M5 - Provider sharing

Provider sharing is intentionally later.

It requires:

- explicit grants
- device presence
- quota policy
- audit records
- request routing
- credential isolation
- revocation behavior

A shared provider credential must never be copied to another developer's device.
