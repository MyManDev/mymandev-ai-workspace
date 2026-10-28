import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "./schema/index.ts";

/** Works for both node-postgres (production) and PGlite (tests). */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;
