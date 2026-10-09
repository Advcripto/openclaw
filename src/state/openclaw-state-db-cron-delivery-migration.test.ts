import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { ensureCronRunReceiptSchema } from "../cron/store/run-receipt-store.js";
import { preflightOpenClawDatabaseSchemas } from "./openclaw-database-preflight.js";
import {
  closeOpenClawStateDatabaseForTest,
  detectOpenClawStateDatabaseSchemaMigrations,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());

function legacyReceiptDatabase() {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("cron-delivery-migration-") } };
  const database = openOpenClawStateDatabase(options);
  ensureCronRunReceiptSchema(database.db);
  const databasePath = database.path;
  closeOpenClawStateDatabaseForTest();
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    ALTER TABLE cron_run_receipts DROP COLUMN delivery_attempt_state;
    INSERT INTO cron_run_receipts (
      receipt_id, store_key, job_id, config_revision, agent_id, status,
      owner_pid, owner_start_time, started_at_ms
    ) VALUES ('legacy-receipt', '/fixture/cron', 'legacy-job', 'revision', 'main', 'running', 123, 1, 2);
    PRAGMA user_version = 19;
    UPDATE schema_meta SET schema_version = 19;
  `);
  legacy.close();
  return { options, databasePath };
}

it.each(["runtime open", "doctor repair"] as const)(
  "%s preserves legacy receipt uncertainty and refuses a schema-19 downgrade",
  async (entry) => {
    const { options } = legacyReceiptDatabase();
    if (entry === "doctor repair") {
      expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);
    }
    const { db } = openOpenClawStateDatabase(options);
    expect(
      db.prepare("SELECT receipt_id, status, delivery_attempt_state FROM cron_run_receipts").all(),
    ).toEqual([
      { receipt_id: "legacy-receipt", status: "running", delivery_attempt_state: "unknown" },
    ]);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 21 });
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    db.exec("UPDATE cron_run_receipts SET delivery_attempt_state = 'started'");
    closeOpenClawStateDatabaseForTest();
    expect(
      openOpenClawStateDatabase(options)
        .db.prepare("SELECT delivery_attempt_state FROM cron_run_receipts")
        .get(),
    ).toEqual({ delivery_attempt_state: "started" });
    closeOpenClawStateDatabaseForTest();
    const preflight = await preflightOpenClawDatabaseSchemas({
      env: options.env,
      scope: "state",
      supportedVersions: { state: 19, agent: 23 },
    });
    expect(preflight.incompatible).toEqual([
      expect.objectContaining({ kind: "state", foundVersion: 21, supportedVersion: 19 }),
    ]);
  },
);

it("rolls receipt migration back with schema publication failure", () => {
  const { options, databasePath } = legacyReceiptDatabase();
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`CREATE TRIGGER refuse_schema_publication BEFORE UPDATE ON schema_meta
    BEGIN SELECT RAISE(ABORT, 'fixture publication refusal'); END;`);
  legacy.close();
  expect(() => openOpenClawStateDatabase(options)).toThrow("fixture publication refusal");
  const after = new DatabaseSync(databasePath, { readOnly: true });
  try {
    expect(after.prepare("PRAGMA user_version").get()).toEqual({ user_version: 19 });
    expect(after.prepare("SELECT receipt_id, status FROM cron_run_receipts").all()).toEqual([
      { receipt_id: "legacy-receipt", status: "running" },
    ]);
    expect(
      after
        .prepare(
          "SELECT 1 FROM pragma_table_info('cron_run_receipts') WHERE name = 'delivery_attempt_state'",
        )
        .get(),
    ).toBeUndefined();
  } finally {
    after.close();
  }
});

it("fences schema-20 schedulers without changing the catalog or stored automation", async () => {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("automation-policy-fence-") } };
  const current = openOpenClawStateDatabase(options);
  const databasePath = current.path;
  closeOpenClawStateDatabaseForTest();
  const legacy = new DatabaseSync(databasePath);
  const jobJson = '{"id":"monitor","payload":{"kind":"heartbeat"},"state":{"lastRunAtMs":37}}';
  const catalog = (() => {
    try {
      legacy.exec("PRAGMA user_version = 20; UPDATE schema_meta SET schema_version = 20");
      legacy
        .prepare(
          "INSERT INTO cron_jobs (store_key, job_id, name, enabled, payload_kind, job_json, updated_at) VALUES ('fixture', 'monitor', 'Preserved monitor', 1, 'heartbeat', ?, 37)",
        )
        .run(jobJson);
      return legacy.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name").all();
    } finally {
      legacy.close();
    }
  })();

  expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toEqual([
    { kind: "automation-policy-fence-v21", path: databasePath },
  ]);
  expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);
  const repaired = openOpenClawStateDatabase(options);
  expect(repaired.db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 21 });
  expect(repaired.db.prepare("SELECT schema_version FROM schema_meta").get()).toEqual({
    schema_version: 21,
  });
  expect(
    repaired.db.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name").all(),
  ).toEqual(catalog);
  expect(
    repaired.db.prepare("SELECT job_json FROM cron_jobs WHERE job_id = 'monitor'").get(),
  ).toEqual({
    job_json: jobJson,
  });
  closeOpenClawStateDatabaseForTest();
  expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toEqual([]);
  const preflight = await preflightOpenClawDatabaseSchemas({
    env: options.env,
    scope: "state",
    supportedVersions: { state: 20, agent: 24 },
  });
  expect(preflight.incompatible).toEqual([
    expect.objectContaining({ kind: "state", foundVersion: 21, supportedVersion: 20 }),
  ]);
});
