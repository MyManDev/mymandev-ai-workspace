import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { CAPABILITIES, type Capability } from "@mymandev/protocol";
import { CAPABILITY_SCOPE } from "./capabilities.ts";
import { hasGrant, isGrantActive } from "./check.ts";
import {
  GrantRecordSchema,
  type GrantRecord,
  type PermissionRequest,
} from "./grant.ts";

const GRANT_ID = "0192f0a0-7b3c-7d4e-8f50-000000000001";
const OTHER_GRANT_ID = "0192f0a0-7b3c-7d4e-8f50-000000000002";
const THIRD_GRANT_ID = "0192f0a0-7b3c-7d4e-8f50-000000000003";
const AGENT_ID = "0192f0a0-7b3c-7d4e-8f50-000000000004";
const OTHER_AGENT_ID = "0192f0a0-7b3c-7d4e-8f50-000000000005";
const DEVICE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000006";
const OTHER_DEVICE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000007";
const PROJECT_ID = "0192f0a0-7b3c-7d4e-8f50-000000000008";
const OTHER_PROJECT_ID = "0192f0a0-7b3c-7d4e-8f50-000000000009";
const WORKSPACE_ID = "0192f0a0-7b3c-7d4e-8f50-00000000000a";
const OTHER_WORKSPACE_ID = "0192f0a0-7b3c-7d4e-8f50-00000000000b";
const USER_ID = "0192f0a0-7b3c-7d4e-8f50-00000000000c";
const OTHER_USER_ID = "0192f0a0-7b3c-7d4e-8f50-00000000000d";
const REPOSITORY_ID = "0192f0a0-7b3c-7d4e-8f50-00000000000e";
const OTHER_REPOSITORY_ID = "0192f0a0-7b3c-7d4e-8f50-00000000000f";
const PROVIDER_CONNECTION_ID = "0192f0a0-7b3c-7d4e-8f50-000000000010";
const OTHER_PROVIDER_CONNECTION_ID = "0192f0a0-7b3c-7d4e-8f50-000000000011";
/** Used as a repository ID and as a provider connection ID at the same time. */
const SHARED_SCOPE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000012";
const OTHER_SHARED_SCOPE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000013";

const NOW = new Date("2026-10-28T12:00:00.000Z");
const CREATED_AT = "2026-10-28T10:00:00.000Z";
const PAST = "2026-10-28T11:00:00.000Z";
const FUTURE = "2026-10-29T12:00:00.000Z";

type Json = Record<string, unknown>;

/** A grant record before parsing, so that a test can change any field. */
interface RecordInput {
  grant: Json;
  facts: {
    agent: Json;
    hostDevice: Json;
    project: Json;
    grantorMembership: Json | null;
  };
}

interface RecordOptions {
  agentId?: string;
  scopeId?: string;
  change?: (input: RecordInput) => void;
}

interface RequestOptions {
  agentId?: string;
  scopeId?: string;
}

function scopeKey(capability: Capability): string {
  return CAPABILITY_SCOPE[capability] === "repository"
    ? "repositoryId"
    : "providerConnectionId";
}

function otherScopeKey(capability: Capability): string {
  return CAPABILITY_SCOPE[capability] === "repository"
    ? "providerConnectionId"
    : "repositoryId";
}

function scopeId(capability: Capability): string {
  return CAPABILITY_SCOPE[capability] === "repository"
    ? REPOSITORY_ID
    : PROVIDER_CONNECTION_ID;
}

function otherScopeId(capability: Capability): string {
  return CAPABILITY_SCOPE[capability] === "repository"
    ? OTHER_REPOSITORY_ID
    : OTHER_PROVIDER_CONNECTION_ID;
}

/** An active grant of `capability` with consistent facts. */
function recordInput(
  capability: Capability,
  options: RecordOptions = {},
): RecordInput {
  const agentId = options.agentId ?? AGENT_ID;
  const input: RecordInput = {
    grant: {
      id: GRANT_ID,
      projectId: PROJECT_ID,
      granteeAgentId: agentId,
      capability,
      [scopeKey(capability)]: options.scopeId ?? scopeId(capability),
      grantedByUserId: USER_ID,
      createdAt: CREATED_AT,
      expiresAt: null,
      revokedAt: null,
      revokedByUserId: null,
    },
    facts: {
      agent: { id: agentId, hostDeviceId: DEVICE_ID, disabledAt: null },
      hostDevice: { id: DEVICE_ID, revokedAt: null },
      project: { id: PROJECT_ID, workspaceId: WORKSPACE_ID },
      grantorMembership: {
        workspaceId: WORKSPACE_ID,
        userId: USER_ID,
        removedAt: null,
      },
    },
  };
  options.change?.(input);
  return input;
}

function record(
  capability: Capability,
  options: RecordOptions = {},
): GrantRecord {
  return recordInput(capability, options) as unknown as GrantRecord;
}

function request(
  capability: Capability,
  options: RequestOptions = {},
): PermissionRequest {
  return {
    agentId: options.agentId ?? AGENT_ID,
    capability,
    [scopeKey(capability)]: options.scopeId ?? scopeId(capability),
  } as unknown as PermissionRequest;
}

function membership(input: RecordInput): Json {
  const value = input.facts.grantorMembership;
  assert.ok(value !== null);
  return value;
}

function revoke(input: RecordInput): void {
  input.grant.revokedAt = PAST;
  input.grant.revokedByUserId = USER_ID;
}

/** A proxy that throws on every operation. */
function throwingProxy<T extends object>(target: T): T {
  const fail = (): never => {
    throw new Error("hostile input");
  };
  return new Proxy(target, {
    getPrototypeOf: fail,
    setPrototypeOf: fail,
    isExtensible: fail,
    preventExtensions: fail,
    getOwnPropertyDescriptor: fail,
    defineProperty: fail,
    has: fail,
    get: fail,
    set: fail,
    deleteProperty: fail,
    ownKeys: fail,
  });
}

/** An array proxy whose length works and whose elements throw when read. */
function throwingIndexProxy<T>(items: T[]): T[] {
  return new Proxy(items, {
    get(target, key, receiver) {
      if (key === "length") {
        return Reflect.get(target, key, receiver);
      }
      throw new Error("hostile index access");
    },
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

/** Asserts that `check` returns false without throwing. */
function assertDenied(check: () => boolean, label: string): void {
  let result: boolean | undefined;
  assert.doesNotThrow(() => {
    result = check();
  }, label);
  assert.equal(result, false, label);
}

test("an active grant of exactly the requested capability and scope is granted", () => {
  const cases: [
    label: Capability,
    record: GrantRecord,
    request: PermissionRequest,
  ][] = CAPABILITIES.map((capability) => [
    capability,
    record(capability),
    request(capability),
  ]);
  assert.equal(cases.length, 6);
  for (const [label, grantRecord, wanted] of cases) {
    assert.equal(GrantRecordSchema.safeParse(grantRecord).success, true, label);
    assert.equal(isGrantActive(grantRecord, NOW), true, label);
    assert.equal(hasGrant([grantRecord], wanted, NOW), true, label);
  }
});

test("no capability grants another", () => {
  // Every grant and request uses the same scope ID, also across scope kinds,
  // so the capability is the only difference.
  let pairs = 0;
  for (const granted of CAPABILITIES) {
    const records = [record(granted, { scopeId: SHARED_SCOPE_ID })];
    for (const requested of CAPABILITIES) {
      const result = hasGrant(
        records,
        request(requested, { scopeId: SHARED_SCOPE_ID }),
        NOW,
      );
      if (granted === requested) {
        assert.equal(result, true, granted);
      } else {
        pairs += 1;
        assert.equal(result, false, `${granted} does not grant ${requested}`);
      }
    }
  }
  assert.equal(pairs, 30);

  const named: [label: string, granted: Capability, requested: Capability][] = [
    ["repo.write does not grant repo.read", "repo.write", "repo.read"],
    ["git.push does not grant git.commit", "git.push", "git.commit"],
    [
      "terminal.execute does not grant git.commit",
      "terminal.execute",
      "git.commit",
    ],
    [
      "terminal.execute does not grant git.push",
      "terminal.execute",
      "git.push",
    ],
  ];
  assert.equal(named.length, 4);
  for (const [label, granted, requested] of named) {
    assert.equal(
      hasGrant([record(granted)], request(requested), NOW),
      false,
      label,
    );
  }
});

test("the five other capabilities, granted together, do not grant the sixth", () => {
  const cases: [
    missing: Capability,
    records: GrantRecord[],
    request: PermissionRequest,
  ][] = CAPABILITIES.map((missing) => [
    missing,
    CAPABILITIES.filter((capability) => capability !== missing).map(
      (capability) => record(capability, { scopeId: SHARED_SCOPE_ID }),
    ),
    request(missing, { scopeId: SHARED_SCOPE_ID }),
  ]);
  assert.equal(cases.length, 6);
  for (const [missing, records, wanted] of cases) {
    assert.equal(records.length, 5, missing);
    assert.equal(hasGrant(records, wanted, NOW), false, missing);
    assert.equal(
      hasGrant(
        [...records, record(missing, { scopeId: SHARED_SCOPE_ID })],
        wanted,
        NOW,
      ),
      true,
      `${missing} granted on its own`,
    );
  }
});

test("the scope must match exactly", () => {
  const cases: [
    label: string,
    build: (capability: Capability) => PermissionRequest,
  ][] = [
    [
      "another repository or provider connection of the same kind",
      (capability) =>
        request(capability, { scopeId: otherScopeId(capability) }),
    ],
    [
      "another agent",
      (capability) => request(capability, { agentId: OTHER_AGENT_ID }),
    ],
    [
      "the same UUID in the other scope kind",
      (capability) =>
        ({
          agentId: AGENT_ID,
          capability,
          [otherScopeKey(capability)]: scopeId(capability),
        }) as unknown as PermissionRequest,
    ],
  ];
  assert.equal(cases.length, 3);
  for (const capability of CAPABILITIES) {
    const records = [record(capability)];
    assert.equal(hasGrant(records, request(capability), NOW), true, capability);
    for (const [label, build] of cases) {
      assert.equal(
        hasGrant(records, build(capability), NOW),
        false,
        `${capability}: ${label}`,
      );
    }
  }
});

test("each inactive fact alone makes a grant inactive", () => {
  const cases: [label: string, change: (input: RecordInput) => void][] = [
    ["revoked in the past", revoke],
    [
      "revoked with a future revokedAt",
      (input) => {
        input.grant.revokedAt = FUTURE;
        input.grant.revokedByUserId = USER_ID;
      },
    ],
    [
      "agent disabled",
      (input) => {
        input.facts.agent.disabledAt = PAST;
      },
    ],
    [
      "agent disabled with a future disabledAt",
      (input) => {
        input.facts.agent.disabledAt = FUTURE;
      },
    ],
    [
      "host device revoked",
      (input) => {
        input.facts.hostDevice.revokedAt = PAST;
      },
    ],
    [
      "host device revoked with a future revokedAt",
      (input) => {
        input.facts.hostDevice.revokedAt = FUTURE;
      },
    ],
    [
      "grantor membership removed",
      (input) => {
        membership(input).removedAt = PAST;
      },
    ],
    [
      "grantor membership removed with a future removedAt",
      (input) => {
        membership(input).removedAt = FUTURE;
      },
    ],
    [
      "grantor membership null",
      (input) => {
        input.facts.grantorMembership = null;
      },
    ],
    [
      "the agent fact describes another agent",
      (input) => {
        input.facts.agent.id = OTHER_AGENT_ID;
      },
    ],
    [
      "the host device fact describes another device",
      (input) => {
        input.facts.hostDevice.id = OTHER_DEVICE_ID;
      },
    ],
    [
      "the project fact describes another project",
      (input) => {
        input.facts.project.id = OTHER_PROJECT_ID;
      },
    ],
    [
      "the membership is in another workspace",
      (input) => {
        membership(input).workspaceId = OTHER_WORKSPACE_ID;
      },
    ],
    [
      "the membership belongs to another user",
      (input) => {
        membership(input).userId = OTHER_USER_ID;
      },
    ],
  ];
  assert.equal(cases.length, 14);
  for (const [label, change] of cases) {
    for (const capability of CAPABILITIES) {
      const name = `${capability}: ${label}`;
      const inactive = record(capability, { change });
      // Well formed, so the denial comes from the fact and not from parsing.
      assert.equal(GrantRecordSchema.safeParse(inactive).success, true, name);
      assert.equal(isGrantActive(inactive, NOW), false, name);
      assert.equal(hasGrant([inactive], request(capability), NOW), false, name);
    }
  }
});

test("a grant is active strictly before expiresAt", () => {
  const at = (offsetMs: number): string =>
    new Date(NOW.getTime() + offsetMs).toISOString();
  const cases: [
    label: string,
    change: (input: RecordInput) => void,
    active: boolean,
  ][] = [
    [
      "expiresAt 1 ms before now",
      (input) => {
        input.grant.expiresAt = at(-1);
      },
      false,
    ],
    [
      "expiresAt equal to now",
      (input) => {
        input.grant.expiresAt = at(0);
      },
      false,
    ],
    [
      "expiresAt 1 ms after now",
      (input) => {
        input.grant.expiresAt = at(1);
      },
      true,
    ],
    [
      "no expiry",
      (input) => {
        input.grant.expiresAt = null;
      },
      true,
    ],
    [
      "createdAt after now",
      (input) => {
        input.grant.createdAt = at(3_600_000);
      },
      true,
    ],
  ];
  assert.equal(cases.length, 5);
  for (const [label, change, active] of cases) {
    for (const capability of CAPABILITIES) {
      const name = `${capability}: ${label}`;
      const grantRecord = record(capability, { change });
      assert.equal(
        GrantRecordSchema.safeParse(grantRecord).success,
        true,
        name,
      );
      assert.equal(isGrantActive(grantRecord, NOW), active, name);
      assert.equal(
        hasGrant([grantRecord], request(capability), NOW),
        active,
        name,
      );
    }
  }
});

test("malformed records are inactive and never throw", () => {
  const changed = (change: (input: RecordInput) => void): RecordInput =>
    recordInput("repo.read", { change });
  const cases: [label: string, value: unknown][] = [
    ["null", null],
    ["undefined", undefined],
    ["a number", 1],
    ["a string", "repo.read"],
    ["an array", [recordInput("repo.read")]],
    ["an empty object", {}],
    ["a record without facts", { grant: recordInput("repo.read").grant }],
    ["a record without a grant", { facts: recordInput("repo.read").facts }],
    [
      "disabledAt undefined",
      changed((input) => {
        input.facts.agent.disabledAt = undefined;
      }),
    ],
    [
      "disabledAt false",
      changed((input) => {
        input.facts.agent.disabledAt = false;
      }),
    ],
    [
      "revokedAt missing",
      changed((input) => {
        delete input.grant.revokedAt;
      }),
    ],
    [
      "removedAt missing",
      changed((input) => {
        delete membership(input).removedAt;
      }),
    ],
    [
      "expiresAt not a date",
      changed((input) => {
        input.grant.expiresAt = "not a date";
      }),
    ],
    [
      "createdAt as a Date object",
      changed((input) => {
        input.grant.createdAt = new Date(CREATED_AT);
      }),
    ],
    [
      "an uppercase agent ID",
      changed((input) => {
        input.grant.granteeAgentId = AGENT_ID.toUpperCase();
      }),
    ],
    [
      "a throwing getter",
      changed((input) => {
        Object.defineProperty(input.grant, "capability", {
          enumerable: true,
          get() {
            throw new Error("hostile getter");
          },
        });
      }),
    ],
    [
      "a Proxy that throws on every trap",
      throwingProxy(recordInput("repo.read")),
    ],
    [
      "an accessor that reads revoked first and not revoked afterwards",
      changed((input) => {
        input.grant.revokedByUserId = USER_ID;
        let reads = 0;
        Object.defineProperty(input.grant, "revokedAt", {
          enumerable: true,
          get() {
            reads += 1;
            return reads === 1 ? PAST : null;
          },
        });
      }),
    ],
    [
      "a getter that returns a valid value",
      changed((input) => {
        Object.defineProperty(input.grant, "revokedAt", {
          enumerable: true,
          get: () => null,
        });
      }),
    ],
    [
      "a getter inside an unknown key",
      changed((input) => {
        input.facts.agent.extra = Object.defineProperty({}, "value", {
          enumerable: true,
          get: () => "unknown",
        });
      }),
    ],
    [
      "an array that carries the fields of an object",
      changed((input) => {
        input.facts.agent = Object.assign([], input.facts.agent);
      }),
    ],
    [
      "a cycle inside an unknown key",
      changed((input) => {
        const cycle: Json = {};
        cycle.self = cycle;
        input.grant.extra = cycle;
      }),
    ],
    [
      "a revoked grant behind a Proxy whose reads hide the revocation",
      changed((input) => {
        revoke(input);
        input.grant = new Proxy(input.grant, {
          get(target, key, receiver) {
            return key === "revokedAt" || key === "revokedByUserId"
              ? null
              : Reflect.get(target, key, receiver);
          },
        });
      }),
    ],
    [
      "grant fields inherited through Object.create",
      changed((input) => {
        const own = { ...input.grant };
        delete own.revokedAt;
        delete own.revokedByUserId;
        input.grant = Object.assign(
          Object.create({ revokedAt: null, revokedByUserId: null }) as Json,
          own,
        );
      }),
    ],
    [
      "a grantor membership inherited through Object.create",
      changed((input) => {
        const { grantorMembership, ...own } = input.facts;
        input.facts = Object.assign(
          Object.create({ grantorMembership }) as RecordInput["facts"],
          own,
        );
      }),
    ],
  ];
  assert.equal(cases.length, 25);
  for (const [label, value] of cases) {
    const malformed = value as GrantRecord;
    assertDenied(
      () => isGrantActive(malformed, NOW),
      `isGrantActive: ${label}`,
    );
    assertDenied(
      () => hasGrant([malformed], request("repo.read"), NOW),
      `hasGrant: ${label}`,
    );
  }
});

test("malformed requests, an invalid now and a list that is not an array deny without throwing", () => {
  const granted = CAPABILITIES.map((capability) => record(capability));
  const single = record("repo.read");
  // Controls: the same inputs with a valid now, request and list are granted.
  assert.equal(hasGrant(granted, request("repo.read"), NOW), true);
  assert.equal(isGrantActive(single, NOW), true);
  // A genuine Date from another JavaScript realm is a valid now.
  const foreignNow = runInNewContext(
    `new Date(${String(NOW.getTime())})`,
  ) as Date;
  assert.equal(foreignNow instanceof Date, false);
  assert.equal(hasGrant(granted, request("repo.read"), foreignNow), true);
  assert.equal(isGrantActive(single, foreignNow), true);

  const fakeDate: unknown = Object.assign(Object.create(Date.prototype), {
    getTime: () => NOW.getTime(),
  });
  const nows: [label: string, value: unknown][] = [
    ["an Invalid Date", new Date(Number.NaN)],
    ["a number", NOW.getTime()],
    ["an ISO string", NOW.toISOString()],
    ["undefined", undefined],
    ["null", null],
    ["an object with a getTime method that inherits from Date", fakeDate],
    ["a Proxy of a Date", new Proxy(new Date(NOW.getTime()), {})],
  ];
  const requests: [label: string, value: unknown][] = [
    ["null", null],
    ["an empty object", {}],
    [
      "provider.use with a repositoryId",
      {
        agentId: AGENT_ID,
        capability: "provider.use",
        repositoryId: PROVIDER_CONNECTION_ID,
      },
    ],
    [
      "repo.read with only a providerConnectionId",
      {
        agentId: AGENT_ID,
        capability: "repo.read",
        providerConnectionId: REPOSITORY_ID,
      },
    ],
    [
      "repo.*",
      { agentId: AGENT_ID, capability: "repo.*", repositoryId: REPOSITORY_ID },
    ],
    ["*", { agentId: AGENT_ID, capability: "*", repositoryId: REPOSITORY_ID }],
    [
      "an uppercase agent ID",
      {
        agentId: AGENT_ID.toUpperCase(),
        capability: "repo.read",
        repositoryId: REPOSITORY_ID,
      },
    ],
    [
      "a missing agentId",
      { capability: "repo.read", repositoryId: REPOSITORY_ID },
    ],
    ["a throwing Proxy", throwingProxy(request("repo.read"))],
    [
      "a scope accessor that reads another repository first",
      (() => {
        let reads = 0;
        return Object.defineProperty(
          { agentId: AGENT_ID, capability: "repo.read" },
          "repositoryId",
          {
            enumerable: true,
            get() {
              reads += 1;
              return reads === 1 ? OTHER_REPOSITORY_ID : REPOSITORY_ID;
            },
          },
        );
      })(),
    ],
    [
      "another repository behind a Proxy whose reads name the granted one",
      new Proxy(request("repo.read", { scopeId: OTHER_REPOSITORY_ID }), {
        get(target, key, receiver) {
          return key === "repositoryId"
            ? REPOSITORY_ID
            : Reflect.get(target, key, receiver);
        },
      }),
    ],
  ];
  const lists: [label: string, value: unknown][] = [
    ["null", null],
    ["undefined", undefined],
    ["an object", {}],
    ["a string", "x"],
    ["a Proxy array that throws on index access", throwingIndexProxy(granted)],
    ["an array-like object", { length: 1, 0: record("repo.read") }],
  ];
  assert.equal(nows.length, 7);
  assert.equal(requests.length, 11);
  assert.equal(lists.length, 6);
  assert.equal(nows.length + requests.length + lists.length, 24);

  for (const [label, value] of nows) {
    const now = value as Date;
    assertDenied(
      () => hasGrant(granted, request("repo.read"), now),
      `now: ${label}`,
    );
    assertDenied(() => isGrantActive(single, now), `now: ${label}`);
  }
  for (const [label, value] of requests) {
    assertDenied(
      () => hasGrant(granted, value as PermissionRequest, NOW),
      `request: ${label}`,
    );
  }
  for (const [label, value] of lists) {
    assertDenied(
      () => hasGrant(value as GrantRecord[], request("repo.read"), NOW),
      `list: ${label}`,
    );
  }
});

test("a polluted Object.prototype neither fills a missing field nor widens a scope", () => {
  const providerRecord = record("provider.use");
  const repositoryRecord = record("repo.read");
  const withoutRevocation = record("repo.read", {
    change: (input) => {
      delete input.grant.revokedAt;
      delete input.grant.revokedByUserId;
    },
  });
  const membershipFact = membership(recordInput("repo.read"));
  const withoutMembership = record("repo.read", {
    change: (input) => {
      delete (input.facts as Partial<RecordInput["facts"]>).grantorMembership;
    },
  });
  const checks: [label: string, check: () => boolean, expected: boolean][] = [
    [
      "provider.use on its own connection",
      () => hasGrant([providerRecord], request("provider.use"), NOW),
      true,
    ],
    [
      "provider.use on another connection",
      () =>
        hasGrant(
          [providerRecord],
          request("provider.use", { scopeId: OTHER_PROVIDER_CONNECTION_ID }),
          NOW,
        ),
      false,
    ],
    [
      "repo.read on its own repository",
      () => hasGrant([repositoryRecord], request("repo.read"), NOW),
      true,
    ],
    [
      "repo.read on another repository",
      () =>
        hasGrant(
          [repositoryRecord],
          request("repo.read", { scopeId: OTHER_REPOSITORY_ID }),
          NOW,
        ),
      false,
    ],
    [
      "a grant without revokedAt and revokedByUserId",
      () =>
        isGrantActive(withoutRevocation, NOW) ||
        hasGrant([withoutRevocation], request("repo.read"), NOW),
      false,
    ],
    [
      "facts without a grantorMembership",
      () =>
        isGrantActive(withoutMembership, NOW) ||
        hasGrant([withoutMembership], request("repo.read"), NOW),
      false,
    ],
  ];
  const pollutions: [label: string, keys: Json, enumerable: boolean][] = [
    [
      "an enumerable repositoryId of undefined",
      { repositoryId: undefined },
      true,
    ],
    ["a non-enumerable repositoryId", { repositoryId: REPOSITORY_ID }, false],
    [
      "an enumerable providerConnectionId",
      { providerConnectionId: OTHER_PROVIDER_CONNECTION_ID },
      true,
    ],
    [
      "revokedAt and revokedByUserId of null",
      { revokedAt: null, revokedByUserId: null },
      true,
    ],
    ["a grantorMembership", { grantorMembership: membershipFact }, true],
  ];
  assert.equal(checks.length, 6);
  assert.equal(pollutions.length, 5);
  for (const [label, check, expected] of checks) {
    assert.equal(check(), expected, `without pollution: ${label}`);
  }

  for (const [pollution, keys, enumerable] of pollutions) {
    const results: boolean[] = [];
    try {
      for (const [key, value] of Object.entries(keys)) {
        Object.defineProperty(Object.prototype, key, {
          value,
          enumerable,
          configurable: true,
          writable: true,
        });
      }
      for (const [, check] of checks) {
        results.push(check());
      }
    } finally {
      for (const key of Object.keys(keys)) {
        delete (Object.prototype as Json)[key];
      }
    }
    assert.equal(results.length, checks.length, pollution);
    for (const [index, [label, , expected]] of checks.entries()) {
      assert.equal(results[index], expected, `${pollution}: ${label}`);
    }
  }
});

test("wildcard-like grants never match, and a * request is denied even when all six capabilities are granted", () => {
  const wildcards: [label: string, value: string][] = [
    ["*", "*"],
    ["**", "**"],
    ["*.*", "*.*"],
    ["repo.*", "repo.*"],
    ["git.*", "git.*"],
    ["provider.*", "provider.*"],
    ["all", "all"],
    ["REPO.READ", "REPO.READ"],
  ];
  assert.equal(wildcards.length, 8);
  for (const [label, value] of wildcards) {
    // Cast past the types, as untrusted data would arrive.
    const wildcard = record("repo.read", {
      scopeId: SHARED_SCOPE_ID,
      change: (input) => {
        input.grant.capability = value;
        input.grant.providerConnectionId = SHARED_SCOPE_ID;
      },
    });
    assert.equal(isGrantActive(wildcard, NOW), false, label);
    for (const capability of CAPABILITIES) {
      assert.equal(
        hasGrant(
          [wildcard],
          request(capability, { scopeId: SHARED_SCOPE_ID }),
          NOW,
        ),
        false,
        `${label} does not grant ${capability}`,
      );
    }
  }

  const all = CAPABILITIES.map((capability) =>
    record(capability, { scopeId: SHARED_SCOPE_ID }),
  );
  for (const capability of CAPABILITIES) {
    assert.equal(
      hasGrant(all, request(capability, { scopeId: SHARED_SCOPE_ID }), NOW),
      true,
      capability,
    );
  }
  const starRequests: [label: string, value: unknown][] = [
    [
      "* on a repository",
      { agentId: AGENT_ID, capability: "*", repositoryId: SHARED_SCOPE_ID },
    ],
    [
      "* on a provider connection",
      {
        agentId: AGENT_ID,
        capability: "*",
        providerConnectionId: SHARED_SCOPE_ID,
      },
    ],
    [
      "* on both scopes",
      {
        agentId: AGENT_ID,
        capability: "*",
        repositoryId: SHARED_SCOPE_ID,
        providerConnectionId: SHARED_SCOPE_ID,
      },
    ],
  ];
  assert.equal(starRequests.length, 3);
  for (const [label, value] of starRequests) {
    assertDenied(() => hasGrant(all, value as PermissionRequest, NOW), label);
  }
});

test("an empty list denies, one active grant among revoked duplicates is enough, and order does not matter", () => {
  for (const capability of CAPABILITIES) {
    const wanted = request(capability);
    assert.equal(hasGrant([], wanted, NOW), false, `${capability}: empty`);

    const first = record(capability, { change: revoke });
    const second = record(capability, {
      change: (input) => {
        revoke(input);
        input.grant.id = OTHER_GRANT_ID;
      },
    });
    const active = record(capability, {
      change: (input) => {
        input.grant.id = THIRD_GRANT_ID;
      },
    });
    assert.equal(
      hasGrant([first, second], wanted, NOW),
      false,
      `${capability}: only revoked grants`,
    );
    const orders: GrantRecord[][] = [
      [first, second, active],
      [first, active, second],
      [second, first, active],
      [second, active, first],
      [active, first, second],
      [active, second, first],
    ];
    assert.equal(orders.length, 6);
    for (const [index, order] of orders.entries()) {
      assert.equal(
        hasGrant(order, wanted, NOW),
        true,
        `${capability}: order ${index}`,
      );
    }
    // A malformed record is skipped; it does not stop the search.
    assert.equal(
      hasGrant([null as unknown as GrantRecord, first, active], wanted, NOW),
      true,
      `${capability}: after a malformed record`,
    );
  }
});

test("hasGrant equals a reference built from isGrantActive and exact agent, capability and scope equality", () => {
  const reference = (
    grantRecord: GrantRecord,
    wanted: PermissionRequest,
  ): boolean => {
    const key = scopeKey(wanted.capability);
    const grantFields = grantRecord.grant as unknown as Json;
    const requestFields = wanted as unknown as Json;
    return (
      isGrantActive(grantRecord, NOW) &&
      grantRecord.grant.granteeAgentId === wanted.agentId &&
      grantRecord.grant.capability === wanted.capability &&
      Object.hasOwn(grantFields, key) &&
      grantFields[key] === requestFields[key]
    );
  };

  // The same two scope IDs serve both kinds, so cross-kind pairs share a UUID.
  const scopeIds = [SHARED_SCOPE_ID, OTHER_SHARED_SCOPE_ID];
  const agentIds = [AGENT_ID, OTHER_AGENT_ID];
  const states: [label: string, change?: (input: RecordInput) => void][] = [
    ["active"],
    ["revoked", revoke],
  ];
  const records: [label: string, record: GrantRecord][] = [];
  const requests: PermissionRequest[] = [];
  for (const capability of CAPABILITIES) {
    for (const scope of scopeIds) {
      for (const agentId of agentIds) {
        requests.push(request(capability, { agentId, scopeId: scope }));
        for (const [state, change] of states) {
          records.push([
            `${state} ${capability} on ${scope} for ${agentId}`,
            record(capability, { agentId, scopeId: scope, change }),
          ]);
        }
      }
    }
  }
  assert.equal(records.length, 48);
  assert.equal(requests.length, 24);

  let granted = 0;
  for (const [label, grantRecord] of records) {
    for (const wanted of requests) {
      const expected = reference(grantRecord, wanted);
      assert.equal(
        hasGrant([grantRecord], wanted, NOW),
        expected,
        `${label}: ${JSON.stringify(wanted)}`,
      );
      if (expected) {
        granted += 1;
      }
    }
  }
  // Each active record matches exactly one request.
  assert.equal(granted, 24);

  const all = records.map(([, grantRecord]) => grantRecord);
  for (const wanted of requests) {
    const expected = all.some((grantRecord) => reference(grantRecord, wanted));
    assert.equal(expected, true, JSON.stringify(wanted));
    assert.equal(hasGrant(all, wanted, NOW), expected, JSON.stringify(wanted));
  }
});

test("the checks do not mutate their inputs", () => {
  // Unknown keys, nested unknown data and a second scope stay in the inputs,
  // so that stripping them from the caller's objects would show. Nested
  // unknown data is stripped, not rejected.
  const inputs = (): {
    records: unknown[];
    wanted: Json;
    now: Date;
  } => ({
    records: [
      ...CAPABILITIES.map((capability) =>
        recordInput(capability, {
          change: (input) => {
            input.grant.extra = "unknown";
            input.grant[otherScopeKey(capability)] = SHARED_SCOPE_ID;
            input.facts.agent.extra = { nested: ["unknown", { deeper: 1 }] };
          },
        }),
      ),
      recordInput("repo.read", { change: revoke }),
      { grant: null, facts: null },
    ],
    wanted: {
      agentId: AGENT_ID,
      capability: "git.push",
      repositoryId: REPOSITORY_ID,
      providerConnectionId: PROVIDER_CONNECTION_ID,
      extra: "unknown",
    },
    now: new Date(NOW.getTime()),
  });
  const run = (
    records: unknown[],
    wanted: Json,
    now: Date,
  ): { granted: boolean; active: boolean[] } => {
    const list = records as GrantRecord[];
    return {
      granted: hasGrant(list, wanted as unknown as PermissionRequest, now),
      active: list.map((grantRecord) => isGrantActive(grantRecord, now)),
    };
  };
  const expected = {
    granted: true,
    active: [true, true, true, true, true, true, false, false],
  };

  // Writable inputs: a write would succeed and change them.
  const writable = inputs();
  const recordsBefore = structuredClone(writable.records);
  const wantedBefore = structuredClone(writable.wanted);
  assert.deepEqual(
    run(writable.records, writable.wanted, writable.now),
    expected,
  );
  assert.deepEqual(writable.records, recordsBefore);
  assert.deepEqual(writable.wanted, wantedBefore);
  assert.equal(writable.now.getTime(), NOW.getTime());

  // Frozen inputs: a write would throw and be denied, so equal results show
  // that no write is attempted.
  const frozen = inputs();
  assert.deepEqual(
    run(deepFreeze(frozen.records), deepFreeze(frozen.wanted), frozen.now),
    expected,
  );
});
