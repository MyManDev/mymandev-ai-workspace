import type {
  AgentBridge,
  GrantBridge,
  ProjectRepositoriesBridge,
} from "../shared/desktop-bridge.ts";
import { PermissionGrants } from "./PermissionGrants.tsx";
import {
  describePermissionScreen,
  type CapabilityView,
} from "./permission-view.ts";
import { StatementText } from "./StatementText.tsx";

// The other screens of the open project. Tasks and decisions show
// placeholder content only, and come in later milestones. The permission
// screen grants and revokes permissions (#342) and shows what each
// permission allows. The chat screen is in ChatScreen.tsx.

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
 * 0015): the grant form and the grants of the agents that this device may
 * grant for (#342), with the presentation rules of #77, and what each
 * capability allows and its risk from `@mymandev/permissions`.
 */
export function PermissionsScreen({
  agents,
  projectRepositories,
  grants,
}: {
  readonly agents?: AgentBridge | undefined;
  readonly projectRepositories?: ProjectRepositoriesBridge | undefined;
  readonly grants?: GrantBridge | undefined;
} = {}) {
  const view = describePermissionScreen();
  return (
    <section aria-labelledby="permissions-title">
      <h2 id="permissions-title">Permissions</h2>
      <p>
        An agent gets only the permissions that its owner grants, each for one
        capability on one repository or on one AI provider connection.
      </p>
      <PermissionGrants
        agents={agents}
        projectRepositories={projectRepositories}
        grants={grants}
      />
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
          <h3 id={`permission-group-${group.scope}`}>{group.title}</h3>
          <p>{group.text}</p>
          <ul
            className="capability-list"
            aria-labelledby={`permission-group-${group.scope}`}
          >
            {group.capabilities.map((capability) => (
              <CapabilityItem key={capability.capability} view={capability} />
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}
