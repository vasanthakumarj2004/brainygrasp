'use strict';
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

async function ensureAuthSchema(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS auth_limits (
    key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_challenges (
      email TEXT PRIMARY KEY, verifier TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      expires_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id UUID PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL, credential TEXT, expires_at TIMESTAMPTZ NOT NULL);
    CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions(expires_at);
    UPDATE users SET otp=NULL, otp_expires=NULL WHERE otp IS NOT NULL OR otp_expires IS NOT NULL`);
}

function createAuthSecurity(db, env = process.env) {
  const digest = value => crypto.createHmac('sha256', env.JWT_SECRET).update(value).digest('hex');
  const adminCredential = () => digest(JSON.stringify([env.ADMIN_USERNAME, env.ADMIN_PASSWORD]));
  const emailAddress = value => {
    if (typeof value !== 'string') return null;
    const email = value.trim().toLowerCase();
    return email.length <= 150 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
  };
  async function limit(scope, identifier, maximum, seconds = 900) {
    const { rows } = await db.query(`INSERT INTO auth_limits(key, attempts, expires_at)
      VALUES ($1, 1, NOW() + $2 * INTERVAL '1 second') ON CONFLICT (key) DO UPDATE SET
      attempts = CASE WHEN auth_limits.expires_at <= NOW() THEN 1 ELSE auth_limits.attempts + 1 END,
      expires_at = CASE WHEN auth_limits.expires_at <= NOW() THEN EXCLUDED.expires_at ELSE auth_limits.expires_at END
      RETURNING attempts`, [digest(scope + ':' + identifier), seconds]);
    if (rows[0].attempts > maximum) throw Object.assign(new Error('Too many attempts. Please try again in 15 minutes.'), { status: 429 });
  }
  async function throttle(req, scope, account, maximum = 10) {
    // Shared by all instances; localhost proxies must not bypass limits.
    await limit(scope + ':ip', req.ip || req.socket?.remoteAddress || 'unknown', 60);
    await limit(scope + ':account', account, maximum);
  }
  async function challenge(email) {
    const otp = crypto.randomInt(100000, 1000000).toString();
    await db.query(`INSERT INTO auth_challenges(email, verifier, expires_at) VALUES ($1,$2,NOW()+INTERVAL '10 minutes')
      ON CONFLICT (email) DO UPDATE SET verifier=EXCLUDED.verifier, attempts=0, expires_at=EXCLUDED.expires_at`,
    [email, digest(email + ':' + otp)]);
    return otp;
  }
  async function invalidateChallenge(email, otp) {
    await db.query('DELETE FROM auth_challenges WHERE email=$1 AND verifier=$2', [email, digest(email + ':' + otp)]);
  }
  async function issue(claims, credential = null, connection = db) {
    const sid = crypto.randomUUID(), role = claims.role || 'customer';
    const seconds = role === 'admin' ? 8 * 3600 : 7 * 86400;
    await connection.query(`INSERT INTO auth_sessions(id,user_id,role,credential,expires_at)
      VALUES ($1,$2,$3,$4,NOW()+$5*INTERVAL '1 second')`,
    [sid, claims.id || null, role, role === 'admin' ? adminCredential() : credential, seconds]);
    return jwt.sign({ ...claims, role, sid }, env.JWT_SECRET, { algorithm: 'HS256', expiresIn: seconds });
  }
  async function consume(email, otp) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(`SELECT verifier, attempts, expires_at > NOW() AS valid
        FROM auth_challenges WHERE email=$1 FOR UPDATE`, [email]);
      const challenge = rows[0];
      let result = null;
      if (challenge && challenge.valid && challenge.attempts < 5) {
        const valid = /^\d{6}$/.test(String(otp)) && crypto.timingSafeEqual(
          Buffer.from(challenge.verifier), Buffer.from(digest(email + ':' + String(otp))));
        if (valid) {
          // Consuming the OTP and creating the session commit together. Redis cannot replay it.
          await client.query('DELETE FROM auth_challenges WHERE email=$1', [email]);
          const existing = await client.query('SELECT id, name, email, phone FROM users WHERE LOWER(email)=$1 ORDER BY id LIMIT 1', [email]);
          let user = existing.rows[0];
          if (!user) {
            const created = await client.query(`INSERT INTO users(email) VALUES ($1) ON CONFLICT(email)
              DO UPDATE SET email=EXCLUDED.email RETURNING id,name,email,phone`, [email]);
            user = created.rows[0];
          }
          result = { user, token: await issue({ id: user.id }, null, client) };
        } else {
          await client.query('UPDATE auth_challenges SET attempts=attempts+1 WHERE email=$1', [email]);
        }
      }
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async function verify(token, role) {
    let claims;
    try { claims = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }); }
    catch { return null; }
    if (!claims.sid || !/^[a-f0-9-]{36}$/i.test(claims.sid) || (role && claims.role !== role)) return null;
    const { rows } = await db.query(`SELECT user_id,role,credential FROM auth_sessions
      WHERE id=$1 AND expires_at > NOW()`, [claims.sid]);
    const session = rows[0];
    if (!session || session.role !== claims.role || String(session.user_id || '') !== String(claims.id || '')) return null;
    if (claims.role === 'admin' && session.credential !== adminCredential()) return null;
    if (claims.role === 'affiliate') {
      const result = await db.query(`SELECT u.password_hash FROM users u JOIN affiliates a ON a.user_id=u.id
        WHERE u.id=$1 AND a.id=$2 AND u.role='AFFILIATE' AND a.status='ACTIVE'`, [claims.id, claims.affiliate_id]);
      if (!result.rows[0] || session.credential !== digest(result.rows[0].password_hash || '')) return null;
    }
    return claims;
  }
  function authenticate(role) {
    return async (req, res, next) => {
      try {
        const token = /^Bearer (\S+)$/i.exec(req.headers.authorization || '')?.[1];
        const claims = token && await verify(token, role);
        if (!claims) return res.status(401).json({ error: 'Please sign in again' });
        req[role === 'admin' ? 'admin' : role === 'affiliate' ? 'affiliate' : 'user'] = claims;
        req.session = claims;
        next();
      } catch { res.status(503).json({ error: 'Sign-in service is temporarily unavailable' }); }
    };
  }
  async function revoke(sid) { await db.query('DELETE FROM auth_sessions WHERE id=$1', [sid]); }
  async function cleanup() {
    await db.query(`DELETE FROM auth_limits WHERE expires_at < NOW();
      DELETE FROM auth_challenges WHERE expires_at < NOW(); DELETE FROM auth_sessions WHERE expires_at < NOW()`);
  }
  return { emailAddress, throttle, challenge, invalidateChallenge, consume, issue, verify, authenticate, revoke, cleanup, digest };
}

let singleton;
function security() { return singleton ||= createAuthSecurity(require('./db')); }
module.exports = { ensureAuthSchema, createAuthSecurity, security };
