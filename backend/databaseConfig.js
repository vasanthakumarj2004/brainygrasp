'use strict';
const fs = require('fs');

function databaseConfig(env = process.env) {
  const url = env.DATABASE_URL ? new URL(env.DATABASE_URL) : null;
  const mode = url?.searchParams.get('sslmode');
  if (mode && !['disable', 'require', 'verify-ca', 'verify-full', 'prefer'].includes(mode)) {
    throw new Error('Unsupported database TLS mode. Use verify-full.');
  }
  const useSsl = env.DB_SSL === 'true' || Boolean(mode && mode !== 'disable') ||
    ['true', '1'].includes(url?.searchParams.get('ssl')) || Boolean(url?.searchParams.has('sslrootcert'));
  // pg connection-string SSL options can otherwise override certificate validation.
  for (const name of ['sslmode', 'ssl', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat']) url?.searchParams.delete(name);
  if (env.DB_SSL_CA && env.DB_SSL_CA_FILE) throw new Error('Set only one database CA option');
  const ca = env.DB_SSL_CA_FILE ? fs.readFileSync(env.DB_SSL_CA_FILE, 'utf8') : env.DB_SSL_CA?.replace(/\\n/g, '\n');
  return {
    ...(url ? { connectionString: url.toString() } : {
      user: env.DB_USER || 'postgres', host: env.DB_HOST || 'localhost', database: env.DB_NAME || 'brainygras',
      password: env.DB_PASSWORD, port: Number(env.DB_PORT) || 5432 }),
    ssl: useSsl ? { rejectUnauthorized: true, ...(ca ? { ca } : {}) } : false,
    connectionTimeoutMillis: 5000,
  };
}
module.exports = { databaseConfig };
