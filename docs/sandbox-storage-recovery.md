# Disposable sandbox storage and recovery

A workspace surviving sandbox replacement does not imply its database survived.
Docker volumes, processes, port mappings, installed tools and browser caches can
be local to the disposable machine. A newly created PostgreSQL volume is a fresh
baseline, not restoration of earlier automation history.

## Verification safeguards

- The full gate exclusively creates randomly named databases and cleans up only
  databases whose creation succeeded
- `pnpm verify:local` owns a separate temporary PostgreSQL container and random
  loopback port; it never adopts the host's existing database server
- Turbo stages and Playwright workers are serialized to fit a 2 GiB environment
- Generated evidence and candidate builds are local ignored files, not backups

## Recovery procedure

1. Keep database backups in a protected durable destination outside the disposable
   machine. Back up every required credential-key version separately
2. Restore into a separate disposable database first and verify schema, records
   and credential decryption before treating the backup as recoverable
3. Select durable PostgreSQL storage or a durable external database before relying
   on the installation for irreplaceable history
4. After replacement, reinstall the pinned pnpm version and browser prerequisites,
   confirm database identity and restore verified backups before restarting Atlas

Do not treat a directory under the workspace as durable database storage without
checking persistence, permissions and replacement semantics. Infrastructure,
network exposure and restoration into an existing database are operator choices.
