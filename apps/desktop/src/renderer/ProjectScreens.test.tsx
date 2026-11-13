import { CAPABILITIES } from "@mymandev/protocol";
import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import { HIGHEST_RISK_CONFIRMATIONS } from "./permission-view.ts";
import { PermissionsScreen } from "./ProjectScreens.tsx";

function render(): string {
  return renderToString(<PermissionsScreen />);
}

/** The list item of one capability, from its opening tag to its end. */
function itemOf(html: string, capability: string): string {
  const start = html.indexOf(
    `<h4 class="capability-name"><code>${capability}</code></h4>`,
  );
  const open = html.lastIndexOf('<li class="capability"', start);
  const end = html.indexOf("</li>", start);
  expect(start).toBeGreaterThan(-1);
  return html.slice(open, end + "</li>".length);
}

test("the permission screen says that granting is not available yet, and offers no control", () => {
  const html = render();

  expect(html).toContain(
    '<section aria-labelledby="permissions-title"><h2 id="permissions-title">Permissions</h2><p>An agent gets only the permissions that its owner grants, each for one capability on one repository or on one AI provider connection.</p><p class="placeholder-note">Granting permissions is not available yet. This screen shows what each permission allows and its risk.</p>',
  );
  expect(html).not.toMatch(
    /<(?:button|input|select|textarea|form|dialog|a)[\s>]|\srole=|\stabindex=|\shref=|\sstyle=/,
  );
  // The confirmation belongs to granting, which this screen does not offer.
  for (const confirmation of Object.values(HIGHEST_RISK_CONFIRMATIONS)) {
    expect(html).not.toContain(confirmation.slice(0, 40));
  }
});

test("the capabilities are grouped by scope kind, each with its risk and what it allows", () => {
  const html = render();

  expect(html).toContain(
    '<section class="permission-section"><h3 id="permission-group-repository">On one repository</h3><p>Each of these permissions is granted on one repository.</p><ul class="capability-list" aria-labelledby="permission-group-repository"><li class="capability" data-risk="standard"><h4 class="capability-name"><code>repo.read</code></h4><p class="capability-risk">Standard risk</p><p>Read the files of the repository.</p></li>',
  );
  expect(html).toContain(
    '<section class="permission-section"><h3 id="permission-group-provider_connection">On one AI provider connection</h3><p>This permission is granted on one AI provider connection on the agent&#x27;s device.</p><ul class="capability-list" aria-labelledby="permission-group-provider_connection"><li class="capability" data-risk="standard"><h4 class="capability-name"><code>provider.use</code></h4><p class="capability-risk">Standard risk</p><p>Send requests to the AI provider of the connection, with the connection&#x27;s credentials on the agent&#x27;s device.</p></li></ul></section>',
  );
  for (const capability of CAPABILITIES) {
    expect(
      html.match(
        new RegExp(
          `<h4 class="capability-name"><code>${capability.replace(".", "\\.")}</code></h4>`,
          "g",
        ),
      ),
    ).toHaveLength(1);
  }
  expect(html.match(/<section class="permission-section">/g)).toHaveLength(2);
  // Each list is named by its own group's heading, and every ID is unique.
  expect(html).not.toContain('aria-label="Capabilities"');
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  expect(new Set(ids).size).toBe(ids.length);
  for (const [, reference] of html.matchAll(/\saria-labelledby="([^"]+)"/g)) {
    expect(ids).toContain(reference);
  }
  // One labelled region for the screen; the subsections add none.
  expect(html.match(/<section [^>]*aria-label/g)).toEqual([
    "<section aria-label",
  ]);
});

test("terminal.execute alone is shown as the highest risk, last in its group, with what a shell can do", () => {
  const html = render();
  const item = itemOf(html, "terminal.execute");

  expect(html.match(/data-risk="highest"/g)).toHaveLength(1);
  expect(html.match(/Highest risk/g)).toHaveLength(1);
  expect(item).toBe(
    '<li class="capability" data-risk="highest"><h4 class="capability-name"><code>terminal.execute</code></h4><p class="capability-risk">Highest risk</p><p>Run a shell that starts in the repository.</p><p>A shell runs as the user of the agent&#x27;s device. The repository is only where it starts: it is not a sandbox.</p><p>A shell can read and change files outside the repository, use the network, run <code>git commit</code> and <code>git push</code>, and read the credentials stored for that user, including local AI provider credentials.</p><p>So a shell can send files and those credentials over the network.</p><p>A shell can commit and push even without <code>git.commit</code> or <code>git.push</code>.</p></li>',
  );
  // Last in the repository group, right before the group ends.
  expect(html).toContain(`${item}</ul></section>`);
  expect(html.indexOf(item)).toBeLessThan(
    html.indexOf(">On one AI provider connection</h3>"),
  );
});

test("the screen says that repo.read with provider.use sends the repository's content to the provider, and that no permission includes another", () => {
  const html = render();

  expect(html).toContain(
    '<ul class="permission-statements"><li>Permissions belong to one agent of this project, and only the agent&#x27;s owner grants them.</li><li>Each permission is checked on its own: for a check, none includes another, so <code>repo.write</code> does not include <code>repo.read</code>, and <code>git.push</code> does not include <code>git.commit</code>. A permission can still let the agent do more than its name says: see <code>terminal.execute</code>.</li><li>With <code>repo.read</code> on a repository and <code>provider.use</code> on an AI provider connection, the agent can send that repository&#x27;s content to that connection&#x27;s provider.</li></ul>',
  );
});
