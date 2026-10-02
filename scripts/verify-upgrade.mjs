import { verificationPostgresArgs } from "./verification-isolation.mjs"
import fs from "node:fs"
import { spawnSync } from "node:child_process"
import {
  ownedVerificationDatabases,
  verificationDatabaseName,
  verificationDatabaseUrl,
} from "./verification-isolation.mjs"

const databases = ownedVerificationDatabases(psqlAdmin)
const database = verificationDatabaseName("upgrade", databases.runId)
const databaseUrl = verificationDatabaseUrl("upgrade", databases.runId)

function run(command, args, options = {}) {
  if (command === "docker") args = verificationPostgresArgs(args)
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...(options.env ?? {}) },
    input: options.input,
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture
      ? ["ignore", "pipe", "inherit"]
      : options.input
        ? ["pipe", "inherit", "inherit"]
        : "inherit",
  })

  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (exit ${result.status}, signal ${result.signal})`
    )
  }

  return options.capture ? result.stdout.trim() : ""
}

function psqlAdmin(sql) {
  run("docker", [
    "compose",
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    sql,
  ])
}

function psqlInput(sql, targetDatabase = database) {
  run(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "postgres",
      "-d",
      targetDatabase,
      "-v",
      "ON_ERROR_STOP=1",
    ],
    { input: sql }
  )
}

function query(sql, targetDatabase = database) {
  return run(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "postgres",
      "-d",
      targetDatabase,
      "-A",
      "-t",
      "-c",
      sql,
    ],
    { capture: true }
  )
}

try {
  run("docker", ["compose", "up", "-d", "--wait", "--no-recreate", "postgres"])
  databases.create("upgrade")

  psqlInput(
    fs.readFileSync(
      "packages/db/drizzle/0000_initial_control_plane.sql",
      "utf8"
    )
  )

  psqlInput(`
  INSERT INTO automations (id,key,name,status)
  VALUES ('10000000-0000-4000-8000-000000000001','email-triage','Email Triage','paused');

  INSERT INTO automation_versions
  (id,automation_id,version_number,definition_schema_version,graph_definition,definition_hash)
  VALUES (
   '10000000-0000-4000-8000-000000000002',
   '10000000-0000-4000-8000-000000000001',
   1,1,
   '{"schemaVersion":1,"nodes":[{"key":"gmail_event","kind":"trigger","config":{"connectionKey":"gmail-primary"}},{"key":"classify_email","kind":"decision","config":{"modelProvider":"legacy","model":"legacy"}},{"key":"archive_email","kind":"action","config":{"connectionKey":"gmail-primary"}}],"edges":[{"key":"trigger","source":"gmail_event","target":"classify_email"},{"key":"archive","source":"classify_email","target":"archive_email"}]}'::jsonb,
   'legacy-v1'
  );

  UPDATE automations
  SET active_version_id='10000000-0000-4000-8000-000000000002'
  WHERE id='10000000-0000-4000-8000-000000000001';

  INSERT INTO connections
  (id,key,provider,label,config,status)
  VALUES
  ('10000000-0000-4000-8000-000000000010','gmail-primary','gmail','Primary Gmail','{}'::jsonb,'disabled'),
  ('10000000-0000-4000-8000-000000000011','telegram-personal','telegram','Personal Telegram','{}'::jsonb,'disabled');

  INSERT INTO runs
  (id,automation_id,automation_version_id,mode,status,trigger_connection_id,idempotency_key,input_snapshot,created_at,started_at,finished_at)
  VALUES (
   '10000000-0000-4000-8000-000000000020',
   '10000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000002',
   'live','succeeded',
   '10000000-0000-4000-8000-000000000010',
   'legacy-run-1',
   '{"messageId":"legacy"}'::jsonb,
   now(),now(),now()
  );

  INSERT INTO node_executions
  (id,run_id,sequence,node_key,node_kind,status,input_snapshot,output_snapshot,started_at,finished_at)
  VALUES (
   '10000000-0000-4000-8000-000000000030',
   '10000000-0000-4000-8000-000000000020',
   1,'archive_email','action','succeeded',
   '{"messageId":"legacy"}'::jsonb,
   '{"ok":true}'::jsonb,
   now(),now()
  );

  INSERT INTO action_executions
  (id,node_execution_id,sequence,connection_id,kind,idempotency_key,execution_status,verification_status,request_snapshot,response_snapshot,started_at,finished_at)
  VALUES (
   '10000000-0000-4000-8000-000000000040',
   '10000000-0000-4000-8000-000000000030',
   1,
   '10000000-0000-4000-8000-000000000010',
   'gmail.archive',
   'legacy-action-1',
   'succeeded',
   'pending',
   '{"messageId":"legacy"}'::jsonb,
   '{"ok":true}'::jsonb,
   now(),now()
  );
  `)

  psqlInput(
    fs.readFileSync("packages/db/drizzle/0001_integration_identity.sql", "utf8")
  )

  // Preserve every existing Run byte and tuple version during admission-index
  // installation, including deliberate null-key manual fixture repetitions.
  psqlInput(`
    INSERT INTO runs (automation_id, automation_version_id, mode, status, input_snapshot)
    SELECT automation_id, automation_version_id, 'test', 'succeeded', input_snapshot
    FROM runs WHERE id='10000000-0000-4000-8000-000000000020';
    INSERT INTO runs (automation_id, automation_version_id, mode, status, input_snapshot)
    SELECT automation_id, automation_version_id, 'test', 'succeeded', input_snapshot
    FROM runs WHERE id='10000000-0000-4000-8000-000000000020';
  `)
  const runFingerprintSql =
    "SELECT md5(string_agg(to_jsonb(r)::text || xmin::text || ctid::text, ',' ORDER BY id)) FROM runs r;"
  const beforeAdmission = query(runFingerprintSql)
  psqlInput(
    fs.readFileSync("packages/db/drizzle/0002_message_admission.sql", "utf8")
  )
  if (query(runFingerprintSql) !== beforeAdmission) {
    throw new Error("Admission migration rewrote historical Runs")
  }
  if (
    query(
      "SELECT count(*) FROM pg_indexes WHERE indexname='runs_test_event_idempotency_uq';"
    ) !== "1"
  ) {
    throw new Error("Admission unique index was not installed")
  }
  console.log(
    "✓ message-admission migration preserves live and repeated manual-test history"
  )

  const historyTables = [
    "runs",
    "node_executions",
    "model_invocations",
    "action_executions",
    "automation_versions",
  ]
  const fingerprints = Object.fromEntries(
    historyTables.map((table) => [
      table,
      query(
        `SELECT coalesce(md5(string_agg(to_jsonb(t)::text || xmin::text || ctid::text, ',' ORDER BY id)), 'empty') FROM ${table} t;`
      ),
    ])
  )
  psqlInput(
    fs.readFileSync("packages/db/drizzle/0003_archive_recovery.sql", "utf8")
  )
  for (const table of historyTables) {
    if (
      query(
        `SELECT coalesce(md5(string_agg(to_jsonb(t)::text || xmin::text || ctid::text, ',' ORDER BY id)), 'empty') FROM ${table} t;`
      ) !== fingerprints[table]
    )
      throw new Error(`Archive recovery migration rewrote ${table}`)
  }
  console.log(
    "✓ archive recovery migration preserves all historical execution/version rows"
  )

  if (
    query(
      "SELECT trigger_integration_key FROM runs WHERE id='10000000-0000-4000-8000-000000000020';"
    ) !== "gmail"
  ) {
    throw new Error("legacy Run trigger integration was not migrated")
  }
  if (
    query(
      "SELECT integration_key || '/' || action_key FROM action_executions WHERE id='10000000-0000-4000-8000-000000000040';"
    ) !== "gmail/archive-message"
  ) {
    throw new Error("legacy ActionExecution identity was not migrated")
  }

  // New source uses the credential FK and historical model Connection identity.
  // Compare the original columns while permitting schema-only additions.
  const preservedTables = [...historyTables, "connections"]
  const fingerprint = (table) =>
    query(
      `SELECT coalesce(md5(string_agg((to_jsonb(t) - ARRAY['credential_id','auth_state','revision','connection_id'])::text || xmin::text || ctid::text, ',' ORDER BY id)), 'empty') FROM ${table} t;`
    )
  const preserved = Object.fromEntries(
    preservedTables.map((table) => [table, fingerprint(table)])
  )
  for (const migration of [
    "0004_connections_credentials",
    "0005_model_connection_identity",
    "0006_admin_auth",
  ]) {
    psqlInput(
      "BEGIN;\n" +
        fs.readFileSync(`packages/db/drizzle/${migration}.sql`, "utf8") +
        "\nCOMMIT;"
    )
  }
  for (const table of preservedTables)
    if (fingerprint(table) !== preserved[table])
      throw new Error(
        `Connections/auth migration rewrote original ${table} rows`
      )
  if (
    query(
      "SELECT count(*) FROM connections WHERE credential_id IS NOT NULL OR auth_state != 'missing' OR revision != 1;"
    ) !== "0"
  )
    throw new Error("Legacy connections gained unverified credential readiness")
  if (query("SELECT count(*) FROM auth_user;") !== "0")
    throw new Error("Auth migration provisioned an owner")
  console.log(
    "✓ Connections/auth migrations preserve legacy evidence and fail-closed credential state"
  )

  run("pnpm", ["--filter", "api", "bootstrap"], {
    env: { DATABASE_URL: databaseUrl },
  })

  const candidate = query(`
  SELECT av.version_number || ':' || (a.active_version_id=av.id)::text
  FROM automation_versions av
  JOIN automations a ON a.id=av.automation_id
  WHERE a.key='email-triage'
  ORDER BY av.version_number;
  `)
  if (candidate !== "1:true\n2:false") {
    throw new Error(
      `expected legacy v1 active and canonical v2 candidate, got: ${candidate}`
    )
  }

  run("pnpm", ["--filter", "api", "runtime:verify"], {
    env: { DATABASE_URL: databaseUrl, AUTOMATION_VERSION: "2" },
  })
  run("pnpm", ["--filter", "api", "activate-version", "email-triage", "2"], {
    env: { DATABASE_URL: databaseUrl },
  })
  run("pnpm", ["--filter", "api", "finalize-integration-migration"], {
    env: { DATABASE_URL: databaseUrl },
  })

  const activeVersion = query(`
  SELECT av.version_number
  FROM automation_versions av
  JOIN automations a ON a.active_version_id=av.id
  WHERE a.key='email-triage';
  `)
  if (activeVersion !== "2") {
    throw new Error(`expected Email Triage v2 active, got ${activeVersion}`)
  }

  const legacyStatuses = query(`
  SELECT key || ':' || status
  FROM connections
  WHERE key IN ('gmail-primary','telegram-personal')
  ORDER BY key;
  `)
  if (legacyStatuses !== "gmail-primary:archived\ntelegram-personal:archived") {
    throw new Error(`legacy connections were not archived: ${legacyStatuses}`)
  }
  // A separately owned database contains committed conflicting historical
  // test keys. The real migration must fail and roll back without repairing,
  // deleting, or rewriting any of those rows.
  databases.create("schema")
  const conflictDatabase = verificationDatabaseName("schema", databases.runId)
  psqlInput(
    fs.readFileSync(
      "packages/db/drizzle/0000_initial_control_plane.sql",
      "utf8"
    ),
    conflictDatabase
  )
  psqlInput(
    fs.readFileSync(
      "packages/db/drizzle/0001_integration_identity.sql",
      "utf8"
    ),
    conflictDatabase
  )
  psqlInput(
    `
    INSERT INTO automations (id,key,name,status)
    VALUES ('20000000-0000-4000-8000-000000000001','migration-conflict','Migration fixture','paused');
    INSERT INTO automation_versions (id,automation_id,version_number,definition_schema_version,graph_definition,definition_hash)
    VALUES ('20000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001',1,1,'{}','fixture');
    INSERT INTO runs (automation_id,automation_version_id,mode,status,idempotency_key,input_snapshot)
    VALUES
    ('20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002','test','failed','historical-duplicate','{"evidence":1}'),
    ('20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002','test','failed','historical-duplicate','{"evidence":2}');
  `,
    conflictDatabase
  )
  const conflictBefore = query(runFingerprintSql, conflictDatabase)
  const rejectedMigration = spawnSync(
    "docker",
    verificationPostgresArgs([
      "compose",
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "postgres",
      "-d",
      conflictDatabase,
      "-v",
      "ON_ERROR_STOP=1",
      "-v",
      "VERBOSITY=verbose",
    ]),
    {
      input:
        "BEGIN;\n" +
        fs.readFileSync(
          "packages/db/drizzle/0002_message_admission.sql",
          "utf8"
        ) +
        "\nCOMMIT;",
      encoding: "utf8",
    }
  )
  if (rejectedMigration.error) throw rejectedMigration.error
  if (
    rejectedMigration.status === 0 ||
    !rejectedMigration.stderr.includes("23505")
  ) {
    throw new Error(
      "Conflicting admission migration did not fail with unique_violation: " +
        rejectedMigration.stderr
    )
  }
  if (
    query(runFingerprintSql, conflictDatabase) !== conflictBefore ||
    query("SELECT count(*) FROM runs;", conflictDatabase) !== "2" ||
    query(
      "SELECT count(*) FROM pg_indexes WHERE indexname='runs_test_event_idempotency_uq';",
      conflictDatabase
    ) !== "0"
  ) {
    throw new Error(
      "Failed admission migration changed conflict history or installed an index"
    )
  }
  console.log(
    "✓ conflicting committed test keys reject migration and preserve all history/index state"
  )
} finally {
  databases.cleanup()
}

console.log("Legacy integration migration upgrade: PASS")
