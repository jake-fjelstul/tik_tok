// lib/db.ts — tiny Postgres helper for the Next.js API routes.
//   npm i pg
//   set DATABASE_URL=postgres://user:pass@host:5432/learnfeed
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export const query = (text: string, params?: unknown[]) => pool.query(text, params);
