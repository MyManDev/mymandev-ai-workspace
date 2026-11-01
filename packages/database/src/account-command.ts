import { type UserId, UserIdSchema } from "@mymandev/protocol";
import type { EraseAccountResult } from "./account-erasure.ts";
import type {
  DisableAccountResult,
  EnableAccountResult,
} from "./account-status.ts";

/** The flag that `erase` needs, because an erasure cannot be undone. */
export const CONFIRM_FLAG = "--confirm";

export const ACCOUNT_COMMAND_USAGE = `Usage: db:account -- disable|enable <user ID (UUIDv7)>
       db:account -- erase <user ID (UUIDv7)> ${CONFIRM_FLAG}`;

export type AccountCommand = Readonly<{
  action: "disable" | "enable" | "erase";
  userId: UserId;
}>;

export type ParsedAccountCommand =
  | Readonly<{ ok: true; command: AccountCommand }>
  | Readonly<{ ok: false; message: string }>;

/**
 * Reads the arguments of the operator command `db:account` (`src/account-cli.ts`):
 * an action and a user ID, and for `erase` also `--confirm`, in any order
 * after the action. An unknown action, a malformed user ID, a missing or
 * extra argument, and `--confirm` on another action are refused with the
 * usage; `erase` without `--confirm` is refused with what it would do.
 */
export function parseAccountCommand(
  args: readonly string[],
): ParsedAccountCommand {
  const [action, ...rest] = args;
  const confirmed = rest.includes(CONFIRM_FLAG);
  const others = rest.filter((arg) => arg !== CONFIRM_FLAG);
  const userId = UserIdSchema.safeParse(others[0]);
  if (
    (action !== "disable" && action !== "enable" && action !== "erase") ||
    others.length !== 1 ||
    rest.length - others.length > 1 ||
    !userId.success ||
    (confirmed && action !== "erase")
  ) {
    return { ok: false, message: ACCOUNT_COMMAND_USAGE };
  }
  if (action === "erase" && !confirmed) {
    return {
      ok: false,
      message: `Erasing an account cannot be undone: its GitHub identity and names are erased, its devices revoked, and its memberships ended. To erase ${userId.data}, repeat the command with ${CONFIRM_FLAG}.`,
    };
  }
  return { ok: true, command: { action, userId: userId.data } };
}

/** What the command prints, and its exit code: 0 to standard output, 1 to standard error. */
export type CommandReport = Readonly<{ exitCode: 0 | 1; message: string }>;

/** The number of items in all of the lists. */
function total(lists: readonly (readonly unknown[])[]): number {
  return lists.reduce((sum, list) => sum + list.length, 0);
}

export function disableReport(result: DisableAccountResult): CommandReport {
  return {
    exitCode: 0,
    message: result.changed
      ? `Account disabled; ${result.revokedGrantIds.length} grants revoked.`
      : "No change: the account does not exist or is already disabled.",
  };
}

/** An erased account stays disabled, so enabling it is refused with 1. */
export function enableReport(result: EnableAccountResult): CommandReport {
  if (result.erased) {
    return {
      exitCode: 1,
      message:
        "Refused: the account is erased and stays disabled. Nothing was changed.",
    };
  }
  return {
    exitCode: 0,
    message: result.changed
      ? "Account enabled; no grant was restored."
      : "No change: the account does not exist or is not disabled.",
  };
}

/**
 * An erasure that is refused, because the account owns a workspace or does
 * not exist, exits with 1; a second erasure of an erased account changes
 * nothing and exits with 0.
 */
export function erasureReport(result: EraseAccountResult): CommandReport {
  if (result.erased) {
    const ended = [...result.endedMemberships, ...result.revokedDevices];
    const summary = [
      `Account erased: ${result.endedMemberships.length} memberships ended,`,
      `${result.revokedDevices.length} devices revoked,`,
      `${result.withdrawnJoinRequestIds.length} join requests withdrawn,`,
      `${total(result.endedMemberships.map((end) => end.revokedInvitationIds))} invitations revoked,`,
      `${total(ended.map((end) => end.revokedGrantIds))} grants revoked,`,
      `${total(ended.map((end) => end.cancelledRuns))} runs cancelled.`,
    ].join(" ");
    // This command runs outside the API, which learns of the erasure only
    // from the database.
    return {
      exitCode: 0,
      message: `${summary}\nThe API closes the account's open connections at its next sweep, within 60 seconds. Its access tokens stop working at once, because every request checks the device, and leave the API's memory within 15 minutes. The other members are not sent the removals or the cancelled runs; they see them when they next load the workspace.`,
    };
  }
  switch (result.refusal) {
    case "owner":
      return {
        exitCode: 1,
        message: `Refused: the account owns ${result.ownedWorkspaceIds.length} workspaces (${result.ownedWorkspaceIds.join(", ")}). Transfer their ownership first. Nothing was changed.`,
      };
    case "not_found":
      return {
        exitCode: 1,
        message:
          "Refused: no account with this ID and a GitHub identity exists. Nothing was changed.",
      };
    case "already_erased":
      return {
        exitCode: 0,
        message: "No change: the account is already erased.",
      };
  }
}
