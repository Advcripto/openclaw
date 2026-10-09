import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { formatCliCommand } from "../cli/command-format.js";
import { UPDATE_RUN_ID_ENV } from "../infra/update-control-plane-sentinel.js";
import { recordUpdateRunStep } from "../infra/update-run-ledger.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { buildGatewayInstallEntrypointCandidates } from "./gateway-entrypoint.js";
import { resolveTaskScriptPath } from "./schtasks-layout.js";
import { auditGatewayServiceConfig, type GatewayServiceExpectedCommand } from "./service-audit.js";
import { captureGatewayServiceDefinitionBackup } from "./service-definition-backup.js";
import {
  gatewayServiceCommandMatchesRoot,
  isGatewayServiceEntrypointMissing,
  resolveServiceEntrypoint,
  resolveGatewayServiceInstallationRefreshRoot,
} from "./service-layout.js";
import { withGatewayServiceOperationLock } from "./service-operation-lock.js";
import { settleGatewayServiceRebind } from "./service-rebind.js";
import type {
  GatewayServiceDefinitionBackupReceipt,
  GatewayServiceDefinitionTransactionHooks,
} from "./service-stage.js";
import {
  hasGatewayServiceLauncherOverride,
  type GatewayServiceCommandConfig,
  type GatewayServiceEnv,
} from "./service-types.js";
import {
  GatewayServiceAuthorityError,
  isUpdateOwnedGatewayServiceCommand,
  readGatewayServiceUpdateOriginalRoot,
  withGatewayServiceInstallationRecovery,
} from "./service-update-authority.js";
import { readGatewayServiceState, resolveGatewayService } from "./service.js";

/** Update repair shares the ordinary installer, retaining only facts needed for recovery. */
export async function reconcileGatewayServiceDefinition(params: {
  env: GatewayServiceEnv;
  root: string | undefined;
  command: GatewayServiceCommandConfig | null;
  expectedCommand: GatewayServiceExpectedCommand;
  repairMissingWindowsEntrypoint?: boolean;
  install: (hooks: GatewayServiceDefinitionTransactionHooks) => Promise<void>;
  warn: (message: string) => void;
}): Promise<GatewayServiceDefinitionBackupReceipt> {
  return await withGatewayServiceOperationLock(params.env, async (assertCurrent) => {
    let warningIndex = 0;
    const warn = (message: string) => {
      params.warn(message);
      // Published updaters discard installer stdout; their existing ledger owns warnings too.
      const runId = process.env[UPDATE_RUN_ID_ENV];
      if (runId && !isUpdateOwnedGatewayServiceCommand()) {
        try {
          assertCurrent();
          recordUpdateRunStep(runId, {
            step: `warning:managed-service-reconciliation:${warningIndex++}`,
            status: "completed",
            endedAtMs: Date.now(),
            detail: message,
          });
        } catch {
          params.warn("Could not record the service definition warning in update history.");
        }
      }
    };
    const deny = (message: string): never => {
      warn(message);
      throw new Error(`SERVICE_DEFINITION_UNKNOWN: ${message}`);
    };
    const command = params.command;
    if (!command) {
      return deny("Gateway service definition could not be inspected; it was left unchanged.");
    }
    const inspectHint = `Run ${formatCliCommand("openclaw gateway status --deep", params.env)} before retrying after the active maintenance or update finishes.`;
    let keys: string[] = [];
    let preservePolicy: string[] = [];
    const transaction = await captureGatewayServiceDefinitionBackup({
      env: params.env,
      command,
      assertCurrent,
      inspect: async () => {
        const current = await resolveGatewayService().readCommand(params.env, {
          requireEffective: true,
        });
        assertCurrent();
        if (!isDeepStrictEqual(current, command)) {
          throw new Error("Gateway service definition changed during inspection.");
        }
        const roots = [params.root, readGatewayServiceUpdateOriginalRoot()].filter(
          (root): root is string => Boolean(root),
        );
        const ownership = await Promise.all(
          roots.map((root) => gatewayServiceCommandMatchesRoot(root, command)),
        );
        assertCurrent();
        if (params.repairMissingWindowsEntrypoint || !ownership.includes(true)) {
          const state = await readGatewayServiceState(resolveGatewayService(), {
            env: params.env,
            requireEffective: true,
            ...(params.repairMissingWindowsEntrypoint ? { requireLoadedCommand: true } : {}),
          });
          assertCurrent();
          // Task Scheduler adds its default cwd to the effective command.
          const inspectedCommand =
            params.repairMissingWindowsEntrypoint && state.command?.managedDefinition
              ? { ...state.command.managedDefinition, sourcePath: state.command.sourcePath }
              : state.command;
          if (!isDeepStrictEqual(inspectedCommand, command)) {
            throw new Error("Gateway service definition changed during inspection.");
          }
          const refreshRoot = await resolveGatewayServiceInstallationRefreshRoot({
            root: params.root,
            state,
          });
          assertCurrent();
          const owned =
            refreshRoot && (await gatewayServiceCommandMatchesRoot(refreshRoot, command));
          assertCurrent();
          const entrypoint = resolveServiceEntrypoint(command);
          const packageRoot = entrypoint
            ? path.win32.dirname(path.win32.dirname(entrypoint))
            : undefined;
          // A deleted package cannot prove its old root. Doctor may recover only
          // the stopped canonical task; the transaction still validates all script bytes.
          const missingWindowsEntrypointRepair =
            params.repairMissingWindowsEntrypoint &&
            process.platform === "win32" &&
            state.loadState.status === "loaded" &&
            state.runtime?.status === "stopped" &&
            !state.runtime.pid &&
            !hasGatewayServiceLauncherOverride(state.command) &&
            command.environment?.OPENCLAW_SERVICE_MARKER === "openclaw" &&
            command.environment?.OPENCLAW_SERVICE_KIND === "gateway" &&
            entrypoint &&
            packageRoot &&
            path.win32.basename(packageRoot).toLowerCase() === "openclaw" &&
            path.win32.basename(path.win32.dirname(packageRoot)).toLowerCase() === "node_modules" &&
            buildGatewayInstallEntrypointCandidates(packageRoot).some(
              (candidate) =>
                path.win32.normalize(candidate).toLowerCase() ===
                path.win32.normalize(entrypoint).toLowerCase(),
            ) &&
            command.sourcePath &&
            path.win32.normalize(command.sourcePath).toLowerCase() ===
              path.win32.normalize(resolveTaskScriptPath(params.env)).toLowerCase() &&
            (await isGatewayServiceEntrypointMissing(command)) &&
            (await gatewayServiceCommandMatchesRoot(params.root, {
              programArguments: params.expectedCommand.programArguments,
              workingDirectory: params.expectedCommand.workingDirectory,
            })) === true;
          assertCurrent();
          if (missingWindowsEntrypointRepair) {
            const expectedEntrypoint = resolveServiceEntrypoint(params.expectedCommand);
            if (!expectedEntrypoint) {
              throw new Error("Replacement Gateway entrypoint could not be inspected.");
            }
            await fs.access(expectedEntrypoint);
            assertCurrent();
          } else if (params.repairMissingWindowsEntrypoint || !owned) {
            throw new Error("Gateway service belongs to an unknown or foreign installation.");
          }
        }
        const audit = await auditGatewayServiceConfig({
          env: params.env,
          command,
          expectedCommand: params.expectedCommand,
        });
        assertCurrent();
        preservePolicy = [];
        for (const fact of audit.definitionDrift ?? []) {
          if (fact.kind === "preserved") {
            preservePolicy.push(fact.key);
            warn(fact.message);
          }
        }
        const edits =
          audit.definitionDrift?.filter(
            (fact) =>
              fact.kind === "unknown-edit" &&
              // Drop-ins are guarded inputs, never installer publication targets.
              !(
                process.platform === "linux" &&
                command.sourcePath &&
                fact.sourcePath !== command.sourcePath &&
                fact.sourcePath &&
                command.definitionPaths?.includes(fact.sourcePath)
              ),
          ) ?? [];
        if (audit.definitionDriftError || edits.length) {
          throw new Error(
            [audit.definitionDriftError, ...edits.map((fact) => `${fact.key}: ${fact.message}`)]
              .filter(Boolean)
              .join(" "),
          );
        }
        keys =
          audit.definitionDrift
            ?.filter((fact) => fact.kind === "outdated")
            .map((fact) => fact.key) ?? [];
      },
    }).catch((error: unknown) => {
      if (hasCommandProcessCleanupError(error)) {
        throw error;
      }
      if (error instanceof GatewayServiceAuthorityError) {
        warn(
          `Service definition refresh was skipped; the definition was left unchanged: ${String(error)}. ${inspectHint}`,
        );
        throw new GatewayServiceAuthorityError(error, error.outcome ?? "unchanged");
      }
      return deny(
        `Service definition inspection or backup failed; the definition was preserved: ${String(error)}`,
      );
    });
    return await settleGatewayServiceRebind(assertCurrent, async () => {
      let recoveryResult: boolean | undefined;
      let recoveryError: unknown;
      try {
        return await withGatewayServiceInstallationRecovery(
          async () => {
            await params.install({ ...transaction.hooks, preservePolicy });
            assertCurrent();
            const receipt = await transaction.finish();
            warn(
              `${keys.length ? `Reconciled Gateway service definition: ${keys.join(", ")}.` : "Refreshed Gateway service definition."} Backup: ${transaction.backupPaths.join(", ")}`,
            );
            return receipt;
          },
          async () => {
            try {
              recoveryResult = await transaction.compensate();
              return recoveryResult;
            } catch (error) {
              recoveryError = error;
              throw error;
            }
          },
        );
      } catch (error) {
        if (hasCommandProcessCleanupError(error)) {
          warn(
            `Service definition refresh did not settle; backups retained: ${transaction.backupPaths.join(", ")}`,
          );
          throw error;
        }
        if (error instanceof GatewayServiceAuthorityError) {
          warn(
            error.outcome === "unchanged" || error.outcome === "restored"
              ? `Service definition refresh stopped; the previous definition was ${error.outcome === "restored" ? "restored" : "left unchanged"}: ${String(error)}. ${inspectHint}`
              : `Service definition recovery could not be verified: ${String(error)}; backups retained: ${transaction.backupPaths.join(", ")}. ${inspectHint}`,
          );
          throw error;
        }
        if (recoveryResult === undefined) {
          warn(
            `Service definition refresh failed: ${String(error)}. Recovery could not be verified: ${String(recoveryError)}; backups retained: ${transaction.backupPaths.join(", ")}`,
          );
          throw new GatewayServiceAuthorityError(
            new Error(
              `UPDATE_NATIVE_AUTHORITY: Service definition recovery is unverified: ${String(recoveryError)}`,
              { cause: error },
            ),
            "recovery-pending",
          );
        }
        return deny(
          `Service definition refresh failed; the previous definition was ${recoveryResult ? "restored" : "left unchanged"}: ${String(error)}`,
        );
      }
    });
  });
}
