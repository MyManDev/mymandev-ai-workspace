import { afterEach, expect, test, vi } from "vitest";
import type { InvitationActionsBridge } from "../shared/desktop-bridge.ts";
import {
  type AcceptInvitationResult,
  InvitationCodeTextSchema,
  JOIN_INVITATION_REFUSALS,
  type JoinInvitationRefusal,
  type PreviewInvitationResult,
  type WorkspaceView,
} from "../shared/ipc-contract.ts";
import {
  codeProblem,
  createJoinInvitation,
  describeAcceptResult,
  describeJoined,
  describePreviewFailure,
  focusesTitleAfterLeave,
  IDLE_JOIN_INVITATION,
  INVITATION_CODE_PATTERN,
  JOIN_MESSAGES,
  JOIN_REFUSAL_MESSAGES,
  JOIN_RESULT_MESSAGES,
  joinAvailability,
  nextJoinClockChange,
  pastedCode,
  previewExpired,
  type JoinInvitationView,
} from "./join-invitation-view.ts";
import type { WorkspacePanelView } from "./workspace-view.ts";

const CODE = `mmdi_${"J01nW1thC0de-_".repeat(4).slice(0, 42)}g`;
const OTHER_CODE = `mmdi_${"An0th3rC0de_-x".repeat(4).slice(0, 42)}A`;
const WORKSPACE_A = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3";
const WORKSPACE_B = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a4";
const JOINED = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a5";

const PREVIEW: PreviewInvitationResult = {
  outcome: "ok",
  workspaceName: "Team",
  displayName: "Margaret",
  inviterName: "Ada",
  inviterLogin: "octocat",
  inviterVerifiedAt: "2026-11-06T22:30:00.000Z",
  expiresAt: "2026-11-12T12:00:00.000Z",
};

const ACCEPTED: AcceptInvitationResult = {
  outcome: "ok",
  workspaceId: JOINED,
  workspaceName: "Team",
};

/** The renderer's clock in the tests: three days before the expiry. */
const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const EXPIRES_AT = Date.parse("2026-11-12T12:00:00.000Z");

const SHOWN = {
  workspaceName: "Team",
  displayName: "Margaret",
  inviterName: "Ada",
  inviterLogin: "octocat",
  inviterVerifiedAt: "2026-11-06T22:30:00.000Z",
  expiresAt: "2026-11-12T12:00:00.000Z",
};

function workspaceState(overrides: Partial<WorkspaceView> = {}): WorkspaceView {
  return {
    revision: 1,
    status: "ready",
    workspaces: [
      { id: WORKSPACE_A, name: "Workspace A" },
      { id: WORKSPACE_B, name: "Workspace B" },
    ],
    selectedWorkspaceId: WORKSPACE_A,
    projects: [],
    openProjectId: null,
    ...overrides,
  } as WorkspaceView;
}

function known(overrides: Partial<WorkspaceView> = {}): WorkspacePanelView {
  return { kind: "known", state: workspaceState(overrides) };
}

const SIGNED_OUT = known({
  status: "signed_out",
  workspaces: [],
  selectedWorkspaceId: null,
});

function refused(
  reason: JoinInvitationRefusal,
  retryAfterMs: number | null = null,
): Extract<PreviewInvitationResult, { outcome: "refused" }> {
  return { outcome: "refused", reason, retryAfterMs };
}

/** An answer that waits until the test resolves or rejects it. */
interface Pending<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function pendingAnswer<T>(): Pending<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

type PreviewAnswer = () => Promise<PreviewInvitationResult>;
type AcceptAnswer = () => Promise<AcceptInvitationResult>;

/**
 * A controller over a fake bridge that records each call and answers with
 * `preview` and `accept`, after a first workspace state with workspace A
 * selected.
 */
function controllerWith(
  preview: PreviewAnswer = () => Promise.resolve(PREVIEW),
  accept: AcceptAnswer = () => Promise.resolve(ACCEPTED),
  first: WorkspacePanelView = known(),
) {
  const calls: [string, string][] = [];
  const bridge: Pick<InvitationActionsBridge, "preview" | "accept"> = {
    preview: (code: string) => {
      calls.push(["preview", code]);
      return preview();
    },
    accept: (code: string) => {
      calls.push(["accept", code]);
      return accept();
    },
  };
  const views: JoinInvitationView[] = [];
  let now = NOW;
  const join = createJoinInvitation(
    bridge,
    (view) => views.push(view),
    () => now,
  );
  join.workspacesChanged(first);
  const last = () => views.at(-1) ?? IDLE_JOIN_INVITATION;
  const setNow = (time: number) => {
    now = time;
  };
  return { join, calls, views, last, setNow };
}

/** A controller that shows the preview of CODE and asks the question. */
async function asking(accept: AcceptAnswer) {
  const setup = controllerWith(() => Promise.resolve(PREVIEW), accept);
  setup.join.editCode(CODE);
  await setup.join.preview();
  setup.join.ask();
  expect(setup.last().asking).toBe(true);
  return setup;
}

afterEach(() => {
  vi.restoreAllMocks();
});

test("the code pattern accepts exactly the texts that the contract's code accepts", () => {
  const samples = [
    CODE,
    OTHER_CODE,
    `${CODE.slice(0, -1)}h`,
    CODE.slice(0, -1),
    `${CODE}A`,
    `mmda_${CODE.slice(5)}`,
    CODE.toUpperCase(),
    ` ${CODE}`,
    `${CODE}\n`,
    `${CODE.slice(0, 20)} ${CODE.slice(21)}`,
    `${CODE.slice(0, 20)}+${CODE.slice(21)}`,
    `${CODE.slice(0, 20)}\u00e9${CODE.slice(21)}`,
    "",
  ];
  for (const sample of samples) {
    expect(INVITATION_CODE_PATTERN.test(sample), JSON.stringify(sample)).toBe(
      InvitationCodeTextSchema.safeParse(sample).success,
    );
  }
  expect(
    samples.filter((sample) => INVITATION_CODE_PATTERN.test(sample)),
  ).toEqual([CODE, OTHER_CODE]);
});

test("a pasted code is trimmed before it is sent, also a paste with a trailing newline", async () => {
  const pastes = [
    `${CODE}\n`,
    `${CODE}\r\n`,
    `\n${CODE}\n\n`,
    `  ${CODE}  `,
    `\t${CODE}\t`,
    // A no-break space and a byte order mark, which `trim` removes too.
    `\u00a0${CODE}\ufeff`,
    // Characters that chat applications add, which `trim` keeps: a
    // zero-width space, joiner, and non-joiner, a word joiner, a next line,
    // and the marks of the text's direction.
    `${CODE}\u200b`,
    `\ufeff${CODE}`,
    `${CODE}\u2060`,
    `\u200c\u200d${CODE}\u200d`,
    `${CODE}\u0085`,
    `\u200e\u2066${CODE}\u2069\u200f\n`,
  ];
  for (const paste of pastes) {
    const { join, calls, last } = controllerWith();
    join.editCode(paste);
    // The field keeps the text as pasted.
    expect(last().code).toBe(paste);
    await join.preview();
    expect(calls, JSON.stringify(paste)).toEqual([["preview", CODE]]);
    expect(last().problem).toBeUndefined();
    expect(last().preview).toEqual(SHOWN);
    join.ask();
    await join.confirm();
    expect(calls, JSON.stringify(paste)).toEqual([
      ["preview", CODE],
      ["accept", CODE],
    ]);
  }
});

test("a text that is not a code once trimmed is not sent, and the field's own problem says why", async () => {
  const cases: [string, string][] = [
    ["", JOIN_MESSAGES.codeMissing],
    [" \n\t", JOIN_MESSAGES.codeMissing],
    ["mmdi_short", JOIN_MESSAGES.notACode],
    [`${CODE}A`, JOIN_MESSAGES.notACode],
    [`${CODE.slice(0, -1)}h`, JOIN_MESSAGES.notACode],
    [`${CODE.slice(0, 20)} ${CODE.slice(21)}`, JOIN_MESSAGES.notACode],
    [`https://example.invalid/join?code=${CODE}`, JOIN_MESSAGES.notACode],
    [`${CODE.slice(0, 20)}\u200b${CODE.slice(20)}`, JOIN_MESSAGES.notACode],
    [`${CODE.slice(0, 20)}\u2060${CODE.slice(21)}`, JOIN_MESSAGES.notACode],
    [`\u200b\u200b`, JOIN_MESSAGES.codeMissing],
  ];
  for (const [text, problem] of cases) {
    expect(codeProblem(text), JSON.stringify(text)).toBe(problem);
    const { join, calls, last } = controllerWith();
    join.editCode(text);
    await join.preview();
    expect(calls, JSON.stringify(text)).toEqual([]);
    expect(last()).toMatchObject({
      running: false,
      code: text,
      problem,
      preview: undefined,
      message: undefined,
    });
  }
  expect(codeProblem(`${CODE}\n`)).toBeUndefined();
  expect(JOIN_MESSAGES.notACode).toBe(
    "This is not an invitation code. A code starts with mmdi_ and has 48 characters. Paste all of it.",
  );
  expect(CODE).toHaveLength(48);
});

test("editing the text ends its problem, its preview, and the question", async () => {
  const { join, last } = controllerWith();
  join.editCode("mmdi_");
  await join.preview();
  expect(last().problem).toBe(JOIN_MESSAGES.notACode);
  join.editCode(CODE);
  expect(last().problem).toBeUndefined();
  await join.preview();
  join.ask();
  expect(last()).toMatchObject({ asking: true, preview: SHOWN });
  join.editCode(OTHER_CODE);
  expect(last()).toMatchObject({
    code: OTHER_CODE,
    problem: undefined,
    preview: undefined,
    expired: false,
    asking: false,
  });
});

test("a preview shows the invitation's facts and a sentence, and keeps nothing else of the answer", async () => {
  const { join, last } = controllerWith(() =>
    Promise.resolve({
      ...PREVIEW,
      code: CODE,
      userId: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192ff",
    } as PreviewInvitationResult),
  );
  join.editCode(CODE);
  await join.preview();
  expect(last()).toEqual({
    running: false,
    code: CODE,
    problem: undefined,
    preview: SHOWN,
    expired: false,
    asking: false,
    message: "The invitation is shown below. Check it before you join.",
    joined: undefined,
  });
  expect(Object.keys(last().preview ?? {})).toEqual(Object.keys(SHOWN));
});

test("every refusal and result of a preview and an accept has its fixed sentence, and the waits say how long", () => {
  const texts: Record<string, string> = {
    invalid: "The text is not an invitation code. Nothing was sent.",
    not_signed_in:
      "This device is not signed in, or the server did not accept its sign-in. Sign in on the Account screen, then try again.",
    unavailable:
      "This device cannot send it now. Wait until the sign-in or the current change of the account is finished, then try again.",
    too_soon:
      "This device sent many requests in a short time. Try again in 3 seconds.",
    rate_limited:
      "The server asked to wait, for example after several codes that did not work. Try again in 15 minutes.",
    invitation_invalid:
      "The code does not work: it may be mistyped, expired, revoked, or already used, or its person may have been removed. Ask the person who sent it for a new invitation.",
    already_member:
      "You are already a member of this workspace, so the code was not used. Tell the person who sent it, so that they can revoke it.",
    failed: "The server refused it.",
  };
  expect(Object.keys(texts).sort()).toEqual(
    [...JOIN_INVITATION_REFUSALS].sort(),
  );
  for (const reason of JOIN_INVITATION_REFUSALS) {
    const wait =
      reason === "too_soon"
        ? 2_500
        : reason === "rate_limited"
          ? 900_000
          : null;
    expect(describePreviewFailure(refused(reason, wait))).toBe(
      `The invitation could not be shown. ${texts[reason]}`,
    );
    expect(describeAcceptResult(refused(reason, wait))).toBe(
      `You did not join the workspace. ${texts[reason]}`,
    );
  }
  expect(describePreviewFailure({ outcome: "unknown" })).toBe(
    "The preview got no clear answer from the server. Nothing was joined. Try again.",
  );
  expect(describeAcceptResult({ outcome: "unknown" })).toBe(
    "It is not known whether you joined the workspace. Check the list of workspaces; the request is not sent again on its own.",
  );
  expect(describeAcceptResult(ACCEPTED)).toBe("You joined the workspace.");
  expect(JOIN_REFUSAL_MESSAGES.rateLimited("1 hour")).toContain("1 hour");
});

test("a call that fails on its way says that nothing was sent, with a fixed text", async () => {
  const error = new Error(`Error invoking remote method with ${CODE}`);
  const { join, last } = controllerWith(
    () => Promise.reject(error),
    () => Promise.reject(error),
  );
  join.editCode(CODE);
  await join.preview();
  expect(last()).toMatchObject({
    running: false,
    code: CODE,
    preview: undefined,
    message: "The invitation could not be shown. It was not sent. Try again.",
  });

  const second = await asking(() => Promise.reject(error));
  await expect(second.join.confirm()).resolves.toBe(true);
  expect(second.last()).toMatchObject({
    running: false,
    code: "",
    preview: undefined,
    message:
      "You did not join the workspace. It was not sent. Paste the code again to try again.",
    joined: undefined,
  });
});

test("Join the workspace asks first, sends nothing until it is confirmed, goes back on request, and then accepts the previewed code once", async () => {
  const { join, calls, last } = controllerWith();
  // No question without a preview.
  join.ask();
  expect(last().asking).toBe(false);
  join.editCode(`${CODE}\n`);
  await join.preview();
  join.ask();
  expect(last()).toMatchObject({ asking: true, preview: SHOWN });
  expect(calls).toEqual([["preview", CODE]]);

  // Back keeps the code and its preview.
  join.back();
  expect(last()).toMatchObject({
    asking: false,
    code: `${CODE}\n`,
    preview: SHOWN,
  });
  await expect(join.confirm()).resolves.toBe(false);
  expect(calls).toEqual([["preview", CODE]]);

  join.ask();
  await expect(join.confirm()).resolves.toBe(true);
  expect(calls).toEqual([
    ["preview", CODE],
    ["accept", CODE],
  ]);
  // The question is closed and the code is gone: nothing more is sent.
  await expect(join.confirm()).resolves.toBe(false);
  join.ask();
  expect(last().asking).toBe(false);
  expect(calls).toHaveLength(2);
});

test("the code leaves the field before the accept goes, and every accept's answer ends the preview", async () => {
  const answers: (AcceptInvitationResult | Error)[] = [
    ACCEPTED,
    { outcome: "unknown" },
    ...JOIN_INVITATION_REFUSALS.map((reason) =>
      refused(
        reason,
        reason === "too_soon" || reason === "rate_limited" ? 1_000 : null,
      ),
    ),
    new Error("failed on its way"),
  ];
  for (const answer of answers) {
    const pending = pendingAnswer<AcceptInvitationResult>();
    const { join, last } = await asking(() => pending.promise);
    const done = join.confirm();
    expect(last(), JSON.stringify(answer)).toEqual({
      running: true,
      code: "",
      problem: undefined,
      preview: SHOWN,
      expired: false,
      asking: false,
      message: undefined,
      joined: undefined,
    });
    if (answer instanceof Error) {
      pending.reject(answer);
    } else {
      pending.resolve(answer);
    }
    await expect(done).resolves.toBe(true);
    expect(last(), JSON.stringify(answer)).toMatchObject({
      running: false,
      code: "",
      preview: undefined,
      asking: false,
    });
  }
});

test("a confirmed accept says so and keeps only the joined workspace's ID and name, never a user ID", async () => {
  const { join, views, last } = await asking(() =>
    Promise.resolve({
      ...ACCEPTED,
      userId: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192ff",
      member: { userId: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192fe" },
    } as AcceptInvitationResult),
  );
  await join.confirm();
  expect(last()).toEqual({
    running: false,
    code: "",
    problem: undefined,
    preview: undefined,
    expired: false,
    asking: false,
    message: "You joined the workspace.",
    joined: { workspaceId: JOINED, workspaceName: "Team" },
  });
  expect(Object.keys(last().joined ?? {})).toEqual([
    "workspaceId",
    "workspaceName",
  ]);
  expect(JSON.stringify(views)).not.toContain("userId");
  expect(JSON.stringify(views)).not.toContain("708192f");
});

test("one request runs at a time: while one runs, the code stays, and nothing else starts, asks, cancels, or confirms", async () => {
  const pending = pendingAnswer<PreviewInvitationResult>();
  const { join, calls, last } = controllerWith(() => pending.promise);
  join.editCode(CODE);
  const first = join.preview();
  expect(last()).toMatchObject({
    running: true,
    code: CODE,
    message: undefined,
  });
  join.editCode(OTHER_CODE);
  await join.preview();
  join.ask();
  expect(join.cancel()).toBe(false);
  await expect(join.confirm()).resolves.toBe(false);
  expect(calls).toEqual([["preview", CODE]]);
  expect(last()).toMatchObject({ running: true, code: CODE, asking: false });
  pending.resolve(PREVIEW);
  await first;
  expect(last()).toMatchObject({ running: false, code: CODE, preview: SHOWN });

  // And while an accept runs.
  const accepting = pendingAnswer<AcceptInvitationResult>();
  const second = await asking(() => accepting.promise);
  const done = second.join.confirm();
  second.join.editCode(OTHER_CODE);
  await second.join.preview();
  second.join.ask();
  expect(second.join.cancel()).toBe(false);
  await expect(second.join.confirm()).resolves.toBe(false);
  expect(second.calls).toEqual([
    ["preview", CODE],
    ["accept", CODE],
  ]);
  expect(second.last()).toMatchObject({ running: true, code: "" });
  accepting.resolve(ACCEPTED);
  await done;
});

test("an unknown accept says so, asks to check the list, and is never sent again", async () => {
  const { join, calls, last } = await asking(() =>
    Promise.resolve({ outcome: "unknown" }),
  );
  await join.confirm();
  expect(last().message).toBe(JOIN_RESULT_MESSAGES.acceptUnknown);
  await new Promise((done) => setTimeout(done, 10));
  await join.confirm();
  await join.preview();
  expect(calls.filter(([name]) => name === "accept")).toEqual([
    ["accept", CODE],
  ]);
  expect(last()).toMatchObject({
    code: "",
    preview: undefined,
    problem: JOIN_MESSAGES.codeMissing,
  });
});

test("Cancel drops the code, its problem, its preview, and the sentence, and keeps the joined workspace", async () => {
  const { join, calls, last } = await asking(() => Promise.resolve(ACCEPTED));
  await join.confirm();
  expect(last().joined).toBeDefined();
  // Nothing to drop: Cancel does not show.
  expect(join.cancel()).toBe(false);
  expect(last().message).toBe("You joined the workspace.");

  join.editCode(CODE);
  expect(join.cancel()).toBe(true);
  expect(last()).toEqual({
    running: false,
    code: "",
    problem: undefined,
    preview: undefined,
    expired: false,
    asking: false,
    message: undefined,
    joined: { workspaceId: JOINED, workspaceName: "Team" },
  });

  // A new preview is about another code: the joined workspace goes.
  join.editCode(CODE);
  await join.preview();
  expect(last()).toMatchObject({ preview: SHOWN, joined: undefined });
  expect(join.cancel()).toBe(true);
  expect(last()).toEqual(IDLE_JOIN_INVITATION);

  join.editCode("not a code");
  await join.preview();
  expect(last().problem).toBe(JOIN_MESSAGES.notACode);
  expect(join.cancel()).toBe(true);
  expect(last()).toMatchObject({ code: "", problem: undefined });
  expect(calls).toEqual([
    ["preview", CODE],
    ["accept", CODE],
    ["preview", CODE],
  ]);
});

test("Cancel does nothing while a preview runs, so its answer still shows", async () => {
  // Cancel is inert while a request runs; the controller refuses it too.
  const pending = pendingAnswer<PreviewInvitationResult>();
  const { join, last } = controllerWith(() => pending.promise);
  join.editCode(CODE);
  const done = join.preview();
  expect(join.cancel()).toBe(false);
  pending.resolve(PREVIEW);
  await done;
  expect(last().preview).toEqual(SHOWN);
});

test("another selected workspace drops the code, its preview, the question, and a preview's sentence", async () => {
  const { join, last } = controllerWith();
  join.editCode(CODE);
  await join.preview();
  join.ask();
  join.workspacesChanged(known({ selectedWorkspaceId: WORKSPACE_B }));
  expect(last()).toEqual({
    running: false,
    code: "",
    problem: undefined,
    preview: undefined,
    expired: false,
    asking: false,
    message: undefined,
    joined: undefined,
  });

  // Also a problem, and also a switch to no workspace.
  join.editCode("mmdi_");
  await join.preview();
  join.workspacesChanged(known({ selectedWorkspaceId: null }));
  expect(last()).toMatchObject({ code: "", problem: undefined });

  // A new state of the same selection changes nothing.
  join.editCode(CODE);
  join.workspacesChanged(known({ selectedWorkspaceId: null, revision: 7 }));
  expect(last().code).toBe(CODE);
});

test("a preview's answer that arrives after a switch, also one away and back, shows nothing", async () => {
  for (const switches of [[WORKSPACE_B], [WORKSPACE_B, WORKSPACE_A]]) {
    const pending = pendingAnswer<PreviewInvitationResult>();
    const { join, last } = controllerWith(() => pending.promise);
    join.editCode(CODE);
    const done = join.preview();
    for (const workspaceId of switches) {
      join.workspacesChanged(known({ selectedWorkspaceId: workspaceId }));
    }
    pending.resolve(PREVIEW);
    await done;
    expect(last()).toMatchObject({
      running: false,
      code: "",
      preview: undefined,
      message: undefined,
    });
  }
});

test("a switch keeps an accept's sentence and the joined workspace, also when the answer arrives after it", async () => {
  const { join, last } = await asking(() => Promise.resolve(ACCEPTED));
  await join.confirm();
  // The service selects the joined workspace when none was selected.
  join.workspacesChanged(known({ selectedWorkspaceId: JOINED }));
  join.workspacesChanged(known({ selectedWorkspaceId: WORKSPACE_B }));
  expect(last()).toMatchObject({
    message: "You joined the workspace.",
    joined: { workspaceId: JOINED, workspaceName: "Team" },
  });

  const pending = pendingAnswer<AcceptInvitationResult>();
  const second = await asking(() => pending.promise);
  const done = second.join.confirm();
  second.join.workspacesChanged(known({ selectedWorkspaceId: JOINED }));
  // The preview went with the switch.
  expect(second.last().preview).toBeUndefined();
  pending.resolve({ outcome: "unknown" });
  await expect(done).resolves.toBe(true);
  expect(second.last().message).toBe(JOIN_RESULT_MESSAGES.acceptUnknown);
});

test("a sign-out drops everything, also the joined workspace and an accept's answer on its way, and every sign-out ends the session", async () => {
  const { join, last } = await asking(() => Promise.resolve(ACCEPTED));
  await join.confirm();
  join.editCode(CODE);
  join.workspacesChanged(SIGNED_OUT);
  expect(last()).toEqual(IDLE_JOIN_INVITATION);

  for (let round = 0; round < 2; round += 1) {
    const pending = pendingAnswer<AcceptInvitationResult>();
    const setup = await asking(() => pending.promise);
    if (round === 1) {
      // A session that already ended once.
      setup.join.workspacesChanged(SIGNED_OUT);
      setup.join.workspacesChanged(known());
      setup.join.editCode(CODE);
      await setup.join.preview();
      setup.join.ask();
    }
    const done = setup.join.confirm();
    setup.join.workspacesChanged(SIGNED_OUT);
    // Signed in again before the answer arrives.
    setup.join.workspacesChanged(known());
    pending.resolve(ACCEPTED);
    await expect(done).resolves.toBe(false);
    expect(setup.last(), String(round)).toMatchObject({
      running: false,
      code: "",
      preview: undefined,
      message: undefined,
      joined: undefined,
    });
  }

  // A preview's answer after a sign-out shows nothing either.
  const previewing = pendingAnswer<PreviewInvitationResult>();
  const third = controllerWith(() => previewing.promise);
  third.join.editCode(CODE);
  const shown = third.join.preview();
  third.join.workspacesChanged(SIGNED_OUT);
  previewing.resolve(PREVIEW);
  await shown;
  expect(third.last()).toMatchObject({
    preview: undefined,
    message: undefined,
  });
});

test("the first workspace state, a state before the first one, and an unavailable bridge drop nothing", () => {
  const { join, last } = controllerWith(undefined, undefined, {
    kind: "pending",
  });
  join.editCode(CODE);
  join.workspacesChanged({ kind: "unavailable" });
  join.workspacesChanged(known({ selectedWorkspaceId: WORKSPACE_B }));
  expect(last().code).toBe(CODE);
});

test("the joined workspace is offered to open while the list holds it and it is not selected", () => {
  const joined = { workspaceId: JOINED, workspaceName: "Team" };
  const listed = [
    { id: WORKSPACE_A, name: "Workspace A" },
    { id: JOINED, name: "Team" },
  ];
  expect(describeJoined(joined, known({ workspaces: listed }))).toBe("open");
  expect(
    describeJoined(
      joined,
      known({ workspaces: listed, selectedWorkspaceId: null }),
    ),
  ).toBe("open");
  expect(
    describeJoined(
      joined,
      known({ workspaces: listed, selectedWorkspaceId: JOINED }),
    ),
  ).toBe("selected");
  expect(describeJoined(joined, known())).toBe("not_listed");
  expect(describeJoined(joined, { kind: "pending" })).toBe("not_listed");
  expect(describeJoined(joined, { kind: "unavailable" })).toBe("not_listed");
});

test("the form shows with the bridge unless no device is signed in and ready", () => {
  expect(joinAvailability(false, known())).toBe("unavailable");
  expect(joinAvailability(true, known())).toBe("form");
  expect(joinAvailability(true, known({ status: "loading" }))).toBe("form");
  expect(joinAvailability(true, { kind: "pending" })).toBe("form");
  expect(joinAvailability(true, { kind: "unavailable" })).toBe("form");
  expect(joinAvailability(true, SIGNED_OUT)).toBe("signed_out");
});

test("the focus moves to the title only when a shown control left and the focus fell to the page", () => {
  expect(focusesTitleAfterLeave(true, false, true)).toBe(true);
  expect(focusesTitleAfterLeave(true, false, false)).toBe(false);
  expect(focusesTitleAfterLeave(false, false, true)).toBe(false);
  expect(focusesTitleAfterLeave(true, true, true)).toBe(false);
});

test("the code appears only in the field's text and in the requests, never in a sentence, a problem, a preview, the joined workspace, or a log", async () => {
  const sinks = (
    ["log", "info", "warn", "error", "debug", "trace"] as const
  ).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => undefined),
  );
  const leak = new Error(`could not send ${CODE}`);
  const previewAnswers: (PreviewInvitationResult | Error)[] = [
    PREVIEW,
    { outcome: "unknown" },
    ...JOIN_INVITATION_REFUSALS.map((reason) =>
      refused(
        reason,
        reason === "too_soon" || reason === "rate_limited" ? 1_000 : null,
      ),
    ),
    leak,
  ];
  const acceptAnswers: (AcceptInvitationResult | Error)[] = [
    ACCEPTED,
    { outcome: "unknown" },
    refused("invitation_invalid"),
    refused("rate_limited", 60_000),
    leak,
  ];
  const all: JoinInvitationView[] = [];
  const requests: [string, string][] = [];
  const answerOf = <T>(answer: T | Error) =>
    answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  for (const previewAnswer of previewAnswers) {
    for (const acceptAnswer of acceptAnswers) {
      const { join, calls, views } = controllerWith(
        () => answerOf(previewAnswer),
        () => answerOf(acceptAnswer),
      );
      join.editCode(` ${CODE}\n`);
      await join.preview();
      join.ask();
      await join.confirm();
      // Then a code that a switch, Cancel, and a sign-out drop.
      join.editCode(CODE);
      await join.preview();
      join.workspacesChanged(known({ selectedWorkspaceId: WORKSPACE_B }));
      join.editCode(CODE);
      join.cancel();
      join.editCode(CODE);
      join.workspacesChanged(SIGNED_OUT);
      all.push(...views);
      requests.push(...calls);
      expect(views.at(-1)?.code).toBe("");
    }
  }
  for (const view of all) {
    const { code, ...rest } = view;
    expect(JSON.stringify(rest)).not.toContain(CODE.slice(5));
    expect([` ${CODE}\n`, CODE, ""]).toContain(code);
  }
  // Every request carries the trimmed code, and nothing else does.
  expect(new Set(requests.map(([, sent]) => sent))).toEqual(new Set([CODE]));
  for (const sink of sinks) {
    expect(sink).not.toHaveBeenCalled();
  }
});

test("only the ends of a paste are trimmed, so a text that is not a code never becomes one", () => {
  expect(pastedCode(`\u200b \u2060${CODE}\u0085\ufeff`)).toBe(CODE);
  // Characters inside stay where they are.
  const inside = `${CODE.slice(0, 10)}\u200b \u0085${CODE.slice(10)}`;
  expect(pastedCode(` ${inside} `)).toBe(inside);
  expect(codeProblem(inside)).toBe(JOIN_MESSAGES.notACode);
  // Characters outside ASCII that are not format or white space stay.
  expect(pastedCode(`\u00e9${CODE}`)).toBe(`\u00e9${CODE}`);
  // An astral format character, a tag, goes as one character.
  expect(pastedCode(`${CODE}\u{e0041}`)).toBe(CODE);
  expect(pastedCode("")).toBe("");
  // A long paste with a long run of spaces inside is one pass.
  const long = `a${" ".repeat(200_000)}b`;
  expect(pastedCode(long)).toBe(long);
});

test("the first selection after none is no switch: the code, its preview, and a preview's answer on its way stay", async () => {
  const loading = known({
    status: "loading",
    workspaces: [],
    selectedWorkspaceId: null,
  });
  const { join, last } = controllerWith(undefined, undefined, loading);
  join.editCode(CODE);
  await join.preview();
  join.ask();
  // The service selects the default workspace once the list loads.
  join.workspacesChanged(known());
  expect(last()).toMatchObject({
    code: CODE,
    preview: SHOWN,
    asking: true,
    message: JOIN_RESULT_MESSAGES.previewShown,
  });
  // A change away from it is a switch.
  join.workspacesChanged(known({ selectedWorkspaceId: WORKSPACE_B }));
  expect(last()).toMatchObject({
    code: "",
    preview: undefined,
    asking: false,
    message: undefined,
  });

  // A preview on its way while the first workspace is selected still counts.
  const pending = pendingAnswer<PreviewInvitationResult>();
  const second = controllerWith(() => pending.promise, undefined, loading);
  second.join.editCode(CODE);
  const done = second.join.preview();
  second.join.workspacesChanged(known());
  pending.resolve(PREVIEW);
  await done;
  expect(second.last()).toMatchObject({ code: CODE, preview: SHOWN });
});

test("an invitation is expired once the clock reaches its expiry", () => {
  expect(previewExpired(SHOWN, EXPIRES_AT - 1)).toBe(false);
  expect(previewExpired(SHOWN, EXPIRES_AT)).toBe(true);
  expect(
    previewExpired({ ...SHOWN, expiresAt: "not a time" }, EXPIRES_AT),
  ).toBe(false);
});

test("once the clock passes the expiry, the question closes, the join goes, nothing is sent, and the sentence says so", async () => {
  const { join, calls, last, setNow } = await asking(() =>
    Promise.resolve(ACCEPTED),
  );
  setNow(EXPIRES_AT - 1);
  join.clockChanged();
  expect(last()).toMatchObject({ asking: true, expired: false });

  setNow(EXPIRES_AT);
  join.clockChanged();
  expect(last()).toEqual({
    running: false,
    code: CODE,
    problem: undefined,
    preview: SHOWN,
    expired: true,
    asking: false,
    message:
      "The invitation has expired. Ask the person who sent it for a new one.",
    joined: undefined,
  });
  join.ask();
  expect(last().asking).toBe(false);
  await expect(join.confirm()).resolves.toBe(false);
  expect(calls).toEqual([["preview", CODE]]);

  // Editing the text, or Cancel, ends it.
  join.editCode(`${CODE} `);
  expect(last()).toMatchObject({ preview: undefined, expired: false });
});

test("an open question checks the clock before it sends, also when no timer fired", async () => {
  const { join, calls, last, setNow } = await asking(() =>
    Promise.resolve(ACCEPTED),
  );
  setNow(EXPIRES_AT + 60_000);
  await expect(join.confirm()).resolves.toBe(false);
  expect(calls).toEqual([["preview", CODE]]);
  expect(last()).toMatchObject({
    expired: true,
    asking: false,
    code: CODE,
    message: JOIN_RESULT_MESSAGES.previewExpired,
  });

  // And Join the workspace does not open the question.
  const second = controllerWith();
  second.join.editCode(CODE);
  await second.join.preview();
  second.setNow(EXPIRES_AT);
  second.join.ask();
  expect(second.last()).toMatchObject({ asking: false, expired: true });
});

test("a preview that arrives already expired by the clock offers no join", async () => {
  const { join, last, setNow } = controllerWith();
  setNow(EXPIRES_AT + 1);
  join.editCode(CODE);
  await join.preview();
  expect(last()).toMatchObject({
    preview: SHOWN,
    expired: true,
    message: JOIN_RESULT_MESSAGES.previewExpired,
  });
});

test("the clock changes nothing while an accept runs, and nothing of an accept's answer", async () => {
  const pending = pendingAnswer<AcceptInvitationResult>();
  const { join, last, setNow } = await asking(() => pending.promise);
  const done = join.confirm();
  setNow(EXPIRES_AT);
  join.clockChanged();
  expect(last()).toMatchObject({ running: true, expired: false });
  pending.resolve(ACCEPTED);
  await done;
  join.clockChanged();
  expect(last()).toMatchObject({
    expired: false,
    message: "You joined the workspace.",
    joined: { workspaceId: JOINED, workspaceName: "Team" },
  });
});

test("the clock is read again at the expiry of the shown invitation only, also once it has passed", () => {
  const view = { ...IDLE_JOIN_INVITATION, preview: SHOWN };
  expect(nextJoinClockChange(view)).toBe(EXPIRES_AT);
  expect(nextJoinClockChange({ ...view, expired: true })).toBeUndefined();
  // While a request runs, the preview is about to go.
  expect(nextJoinClockChange({ ...view, running: true })).toBeUndefined();
  expect(nextJoinClockChange(IDLE_JOIN_INVITATION)).toBeUndefined();
  expect(
    nextJoinClockChange({
      ...view,
      preview: { ...SHOWN, expiresAt: "not a time" },
    }),
  ).toBeUndefined();
});
