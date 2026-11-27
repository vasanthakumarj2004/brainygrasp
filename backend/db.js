/**
 * db.js — BrainyGrasp
 * ─────────────────────────────────────────────────────────────────────────────
 * Single shared PostgreSQL connection pool.
 *
 * All route files (routes/*.js) and server.js import this module so the
 * entire application shares ONE pool instead of creating multiple pools.
 *
 * Configuration (via .env):
 *   DATABASE_URL          — Neon/Supabase/cloud Postgres connection string
 *   DB_USER / DB_HOST / DB_NAME / DB_PASSWORD / DB_PORT — local Docker vars
 */

'use strict';

const { Pool } = require('pg');

const poolConfig = require('./databaseConfig').databaseConfig();

const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client:', err.message);
});

module.exports = pool;
