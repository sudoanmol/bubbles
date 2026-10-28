/**
 * Brings a Durable Object's tables up to date: runs, in order and in one transaction, each migration this object has
 * not run yet, so data survives schema changes. Append new migrations to the end; never edit or remove one that has
 * shipped, since objects that already ran it won't run it again.
 */
export function migrate(storage: DurableObjectStorage, migrations: string[]) {
  storage.transactionSync(() => {
    storage.sql.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)')
    const [row] = storage.sql.exec<{ value: number }>("SELECT value FROM meta WHERE key = 'migrations'").toArray()
    for (const ddl of migrations.slice(row?.value ?? 0)) storage.sql.exec(ddl)
    storage.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('migrations', ?)", migrations.length)
  })
}
