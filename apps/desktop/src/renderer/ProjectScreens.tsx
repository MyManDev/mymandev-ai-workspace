import {
  describePermissionScreen,
  type CapabilityView,
  type Statement,
} from "./permission-view.ts";

// The other screens of the open project. Tasks and decisions show
// placeholder content only, and the permission screen shows what each
// permission allows, read-only: tasks, decisions, and granting permissions
// come in later milestones. The chat screen is in ChatScreen.tsx.

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

/** A fixed statement, with capability names as code. */
function StatementText({ statement }: { readonly statement: Statement }) {
  return statement.map((part, index) =>
    typeof part === "string" ? (
      part
    ) : (
      <code key={index}>{part.capability}</code>
    ),
  );
}

function CapabilityItem({ view }: { readonly view: CapabilityView }) {
  return (
    <li className="capability" data-risk={view.risk}>
      <h4 className="capability-name">
        <code>{view.capability}</code>
      </h4>
      <p className="capability-risk">{view.riskLabel}</p>
      <p>{view.meaning}</p>
      {view.details.map((statement, index) => (
        <p key={index}>
          <StatementText statement={statement} />
        </p>
      ))}
    </li>
  );
}

/**
 * The permission screen after the capability and permission contract (ADR
 * 0015) and its presentation rules (#77), read-only: it shows what each
 * capability allows and its risk from `@mymandev/permissions`, and it has no
 * control that grants. Granting comes later.
 */
export function PermissionsScreen() {
  const view = describePermissionScreen();
  return (
    <section aria-labelledby="permissions-title">
      <h2 id="permissions-title">Permissions</h2>
      <p>
        An agent can do only what its owner grants: one capability on one
        repository or on one AI provider connection.
      </p>
      <p className="placeholder-note">{view.unavailable}</p>
      <ul className="permission-statements">
        {view.statements.map((statement, index) => (
          <li key={index}>
            <StatementText statement={statement} />
          </li>
        ))}
      </ul>
      {/* Subsections without a name, so that they add no landmark regions. */}
      {view.groups.map((group) => (
        <section className="permission-section" key={group.scope}>
          <h3>{group.title}</h3>
          <p>{group.text}</p>
          <ul className="capability-list" aria-label="Capabilities">
            {group.capabilities.map((capability) => (
              <CapabilityItem key={capability.capability} view={capability} />
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}
