// The production wiring of the permission enforcement point and the check
// of `provider.use` before a start (#55, D13 of 2026-11-25), read from the
// entry point's source: the entry point starts Electron, so no test runs it.
// The behaviour of the wired parts is tested in
// `agents/run-supervisor.test.ts` ("wired:"), on a harness wired as here.
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

/** `source` without its block and line comments. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const ENTRY = withoutComments(
  readFileSync(new URL("./index.ts", import.meta.url), "utf8"),
);

/** The object literal passed to the one call `const name = create(...)`. */
function callArguments(name: string, create: string): string {
  expect(ENTRY.match(new RegExp(`\\b${create}\\(`, "g"))).toHaveLength(1);
  const match = new RegExp(
    `\\bconst ${name} = ${create}\\(\\{\\n([\\s\\S]*?)\\n {2}\\}\\);`,
  ).exec(ENTRY);
  if (match === null) {
    throw new Error(`The entry point does not call ${create} as expected.`);
  }
  return match[1] ?? "";
}

/** The trimmed lines of `block`, without the empty ones. */
function lines(block: string): string[] {
  return block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** Whether the entry point imports `name` from `module`. */
function imports(name: string, module: string): boolean {
  return [...ENTRY.matchAll(/import \{([^}]*)\} from "([^"]+)";/g)].some(
    (match) =>
      match[2] === module &&
      (match[1] ?? "")
        .split(",")
        .map((part) => part.trim())
        .includes(name),
  );
}

test("the entry point gives the enforcement point the wall clock, the grant store, the account's session, the signed-in device, and the file recorder", () => {
  const given = lines(
    callArguments("enforcement", "createPermissionEnforcement"),
  );
  expect(given).toEqual(
    expect.arrayContaining([
      "now: () => new Date(),",
      "grantStore,",
      "sessionState: () => account.sessionState(),",
      "thisDevice: () => signedInDevice(account.status()) as DeviceId | null,",
      "recorder: enforcementRecorder,",
    ]),
  );
  expect(
    imports("createPermissionEnforcement", "./permissions/enforcement.ts"),
  ).toBe(true);
  expect(imports("signedInDevice", "./permissions/grant-store.ts")).toBe(true);
  // The grant store is the one that the supervisor listens to.
  expect(ENTRY).toMatch(/\bconst grantStore = createGrantStore\(\{/);
});

test("the entry point records to the append-only file recorder in the data folder, closes it at quit, and wires no recorder in memory", () => {
  expect(ENTRY.match(/\bcreateSystemEnforcementRecorder\(/g)).toHaveLength(1);
  expect(ENTRY).toMatch(
    /\n {2}const enforcementRecorder = createSystemEnforcementRecorder\(\(message\) =>\n {4}console\.info\(message\),\n {2}\);\n/,
  );
  expect(
    imports(
      "createSystemEnforcementRecorder",
      "./permissions/file-recorder-system.ts",
    ),
  ).toBe(true);
  // The system module records to the record folder of the data folder.
  const system = withoutComments(
    readFileSync(
      new URL("./permissions/file-recorder-system.ts", import.meta.url),
      "utf8",
    ),
  );
  expect(system).toContain(
    [
      "  return createFileEnforcementRecorder({",
      '    folder: path.join(app.getPath("userData"), ENFORCEMENT_RECORD_FOLDER),',
      "    platform: process.platform,",
      "    log,",
      "  });",
    ].join("\n"),
  );
  // It closes at quit, after the services that check, which are added later.
  expect(ENTRY).toMatch(/\n {2}closables\.add\(enforcementRecorder\);\n/);
  expect(ENTRY.indexOf("closables.add(enforcementRecorder);")).toBeLessThan(
    ENTRY.indexOf("const enforcement = "),
  );
  // The recorder in memory never fails, so it would never deny a start.
  expect(ENTRY).not.toMatch(/memory-recorder|MemoryEnforcementRecorder/);
});

test("the entry point gives the host run supervisor the enforcement point and the check of provider.use before a start", () => {
  const given = lines(callArguments("runSupervisor", "createRunSupervisor"));
  expect(given).toEqual(
    expect.arrayContaining([
      "grants: grantStore,",
      "enforcement,",
      "beforeStart: createProviderUseStartCheck(enforcement),",
    ]),
  );
  expect(
    imports("createProviderUseStartCheck", "./agents/run-start-check.ts"),
  ).toBe(true);
  // The enforcement point is created before the supervisor that uses it.
  expect(ENTRY.indexOf("const enforcement = ")).toBeLessThan(
    ENTRY.indexOf("const runSupervisor = "),
  );
});
