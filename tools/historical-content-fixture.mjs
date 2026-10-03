/** Test-only pre0035 default import. Never import this helper from runtime source. */
import {importDefaultPackage} from '../server/owned-postgres/package-importer.mjs';

async function assertHistoricalFixture(db) {
  const port=Number(process.env.OWNAPI_PG_PORT),host=process.env.OWNAPI_PG_HOST;
  if(process.env.OWNAPI_PG_ALLOW!=='1'||host!=='127.0.0.1'||!Number.isInteger(port)||port<1||port>65535||[4300,55440].includes(port)
    ||!/^ownapi_[a-z0-9_]+$/.test(db?.schema||'')||!db?.admin||!db?.migration||db.roles?.migration!==`${db.schema}_migration`)
    throw Error('Historical default import requires an explicit isolated ownapi fixture');
  for(const pool of [db.admin,db.migration])
    if(pool.options?.host!==host||Number(pool.options?.port)!==port)throw Error('Historical fixture connection target mismatch');
  const [admin,migration]=await Promise.all([
    db.admin.query('SELECT current_schema() AS schema'),
    db.migration.query('SELECT current_schema() AS schema,current_user AS role')
  ]);
  if(admin.rows[0]?.schema!==db.schema||migration.rows[0]?.schema!==db.schema||migration.rows[0]?.role!==db.roles.migration)
    throw Error('Historical fixture schema or migration role mismatch');
  const current=(await db.migration.query("SELECT to_regclass('content_review_authority') AS authority,to_regclass('content_review_decision') AS decision,to_regclass('content_review_baseline') AS baseline")).rows[0];
  if(Object.values(current).some(Boolean))throw Error('Historical import requires a pre0035 schema');
}

/** Call immediately before applyRemaining as well as after the temporary import. */
export async function assertHistoricalProjectionAbsent(db) {
  await assertHistoricalFixture(db);
  if((await db.migration.query("SELECT to_regclass('reviewed_content_version') AS projection")).rows[0]?.projection)
    throw Error('Historical metadata projection must be absent before forward migration');
}

export async function importHistoricalDefaultPackage(db) {
  await assertHistoricalProjectionAbsent(db);
  // The historical schema has only raw metadata. The view is local to this disposable
  // migration fixture, never an importer fallback and never retained across upgrade.
  await db.migration.query('CREATE VIEW reviewed_content_version AS SELECT * FROM content_version');
  try {return await importDefaultPackage(db.migration);}
  finally {
    await db.migration.query('DROP VIEW reviewed_content_version');
    await assertHistoricalProjectionAbsent(db);
  }
}
