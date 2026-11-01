// The screens of the open project. They show placeholder content only: the
// chat backend, tasks, decisions, and granting permissions come in later
// milestones.

const PLACEHOLDER_MESSAGES = [
  {
    id: "placeholder-1",
    author: "Sample person",
    text: "This is a placeholder message.",
  },
  {
    id: "placeholder-2",
    author: "Sample agent",
    text: "Messages from the people and the agents of this project appear here.",
  },
] as const;

export function ChatScreen() {
  return (
    <section className="chat" aria-labelledby="chat-title">
      <h2 id="chat-title">Chat</h2>
      <ol className="message-list" aria-label="Messages">
        {PLACEHOLDER_MESSAGES.map((message) => (
          <li className="message" key={message.id}>
            <p className="message-author">{message.author}</p>
            <p className="message-text">{message.text}</p>
          </li>
        ))}
      </ol>
      <form
        className="composer"
        aria-label="New message"
        onSubmit={(event) => event.preventDefault()}
      >
        <label className="composer-label" htmlFor="composer-text">
          Message
        </label>
        <textarea
          id="composer-text"
          className="composer-text"
          rows={3}
          disabled
          aria-describedby="composer-note"
        />
        <p className="placeholder-note" id="composer-note">
          Sending messages is not available yet.
        </p>
        <button type="submit" className="composer-send" disabled>
          Send
        </button>
      </form>
    </section>
  );
}

export function TasksScreen() {
  return (
    <section aria-labelledby="tasks-title">
      <h2 id="tasks-title">Tasks</h2>
      <p>No tasks yet.</p>
      <p className="placeholder-note">
        The tasks of this project, for people and agents, appear here.
      </p>
    </section>
  );
}

export function DecisionsScreen() {
  return (
    <section aria-labelledby="decisions-title">
      <h2 id="decisions-title">Decisions</h2>
      <p>No decisions yet.</p>
      <p className="placeholder-note">
        The decisions made in this project appear here.
      </p>
    </section>
  );
}

interface PermissionSection {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  /** The capability names of ADR 0008 that the section will grant. */
  readonly capabilities: readonly string[];
}

/**
 * The sections of the permission screen, after the capability and permission
 * contract (ADR 0015). Granting, the presentation rules (#77), and reading the
 * risk labels from `@mymandev/permissions` come later.
 */
const PERMISSION_SECTIONS: readonly PermissionSection[] = [
  {
    id: "agent",
    title: "Agent",
    text: "Permissions belong to one agent of this project, and only the agent's owner grants them.",
    capabilities: [],
  },
  {
    id: "files",
    title: "Repository files",
    text: "Reading and changing the files of one repository.",
    capabilities: ["repo.read", "repo.write"],
  },
  {
    id: "git",
    title: "Git",
    text: "Committing and pushing in one repository.",
    capabilities: ["git.commit", "git.push"],
  },
  {
    id: "terminal",
    title: "Terminal",
    text: "Running a shell that starts in one repository. This is the highest-risk permission, and it is granted on its own.",
    capabilities: ["terminal.execute"],
  },
  {
    id: "provider",
    title: "AI provider",
    text: "Using one AI provider connection on the agent's device.",
    capabilities: ["provider.use"],
  },
  {
    id: "granted",
    title: "Granted permissions",
    text: "The agent's permissions, when they expire, and revoking them.",
    capabilities: [],
  },
];

export function PermissionsScreen() {
  return (
    <section aria-labelledby="permissions-title">
      <h2 id="permissions-title">Permissions</h2>
      <p>
        An agent can do only what its owner grants: one capability on one
        repository or on one AI provider connection.
      </p>
      {/* Subsections without a name, so that they add no landmark regions. */}
      {PERMISSION_SECTIONS.map((section) => (
        <section className="permission-section" key={section.id}>
          <h3>{section.title}</h3>
          <p>{section.text}</p>
          {section.capabilities.length > 0 ? (
            <ul className="capability-list" aria-label="Capabilities">
              {section.capabilities.map((capability) => (
                <li key={capability}>
                  <code>{capability}</code>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="placeholder-note">Not available yet.</p>
        </section>
      ))}
    </section>
  );
}
