import type { SQLInputValue } from 'node:sqlite';
import { acceptedRunReportSchema, acceptedRunReportMaxBytes } from '../../contracts/runs.js';
import type { StateDatabase } from './database.js';
/** The 48 KB request plus bounded accepted evidence can exceed the ordinary 32 KB row limit. */
export function readAcceptedRunReport(db: StateDatabase, sql: string, ...args: SQLInputValue[]) {
  return db.data(
    acceptedRunReportSchema,
    db.statement(sql).get(...args),
    acceptedRunReportMaxBytes,
  );
}
