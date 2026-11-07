import crypto from 'node:crypto';
import pg from 'pg';
const { Pool } = pg;
import rateLimit from 'express-rate-limit';
import { normalizeEmail, normalizeName, validPassword, hashPassword, verifyPassword, digestToken } from './member-security.js';

const COOKIE = 'yqmember';
const SESSION_DAYS = 14;
const PROD = process.env.NODE_ENV === 'production';
const config = process.env.DATABASE_URL?.trim();
// Neon connection string contains sslmode=require; preserve it as supplied by Neon.
const pool = config ? new Pool({ connectionString: config, max: 5, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000 }) : null;
const gate = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: '操作过于频繁，请15分钟后再试。' } });

let schemaPromise = null;
function schema() {
  if (!pool) throw new Error('NO_DATABASE');
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS yq_members (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT NOT NULL UNIQUE,
        display_name VARCHAR(80) NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS yq_member_sessions (
        token_hash CHAR(64) PRIMARY KEY,
        member_id UUID NOT NULL REFERENCES yq_members(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await pool.query('CREATE INDEX IF NOT EXISTS yq_member_sessions_member_idx ON yq_member_sessions(member_id)');
    })().catch(e => { schemaPromise = null; throw e; });
  }
  return schemaPromise;
}

function cookieOptions() {
  return { httpOnly: true, secure: PROD, sameSite: 'strict', path: '/', maxAge: SESSION_DAYS * 24 * 3600 * 1000 };
}
function clearCookie(res) {
  res.clearCookie(COOKIE, { httpOnly: true, secure: PROD, sameSite: 'strict', path: '/' });
}
function isSameOrigin(req) {
  const origin = req.get('origin');
  if (!origin) return false; // browser submits this for JSON POST requests
  try {
    const parsed = new URL(origin);
    const proto = req.protocol;
    return parsed.origin === `${proto}://${req.get('host')}`;
  } catch { return false; }
}
function postGuard(req, res, next) {
  if (!isSameOrigin(req)) return res.status(403).json({ error: '非法请求来源，请从本站页面操作。' });
  if (!req.is('application/json')) return res.status(415).json({ error: '请求格式错误。' });
  next();
}
function safeError(res, e) {
  // Never expose DB connection string, SQL, password hashes, query details.
  if (e?.message === 'NO_DATABASE') return res.status(503).json({ error: '会员数据库尚未连接，请先在 Render 配置 DATABASE_URL。' });
  console.error('Member service unavailable:', e?.code || e?.name || 'error');
  return res.status(503).json({ error: '会员服务暂时不可用，请检查数据库连接。' });
}
async function createSession(memberId, res) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
  await pool.query('INSERT INTO yq_member_sessions(token_hash,member_id,expires_at) VALUES ($1,$2,$3)', [digestToken(token), memberId, expires]);
  res.cookie(COOKIE, token, cookieOptions());
}
function publicUser(row) {
  return { id: row.id, email: row.email, name: row.display_name, createdAt: row.created_at };
}
async function readCurrentUser(req) {
  const token = req.cookies?.[COOKIE];
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
  await schema();
  const result = await pool.query(`SELECT m.id,m.email,m.display_name,m.created_at
    FROM yq_member_sessions s JOIN yq_members m ON m.id=s.member_id
    WHERE s.token_hash=$1 AND s.expires_at>NOW()`, [digestToken(token)]);
  return result.rows[0] ? publicUser(result.rows[0]) : null;
}

export function registerMemberRoutes(app) {
  app.get('/api/members/status', (_req, res) => res.json({ configured: !!pool, enabled: !!pool }));

  app.post('/api/members/signup', gate, postGuard, async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const name = normalizeName(req.body?.name);
    const password = req.body?.password;
    if (!email || !name || !validPassword(password))
      return res.status(400).json({ error: '请填写有效姓名、邮箱，以及12至128位密码。' });
    try {
      await schema();
      const hashed = await hashPassword(password);
      const result = await pool.query('INSERT INTO yq_members (email,display_name,password_hash) VALUES ($1,$2,$3) RETURNING id,email,display_name,created_at', [email,name,hashed]);
      await createSession(result.rows[0].id, res);
      res.status(201).json({ ok: true, user: publicUser(result.rows[0]), emailVerified: false });
    } catch(e) {
      if (e?.code === '23505') return res.status(409).json({ error: '该邮箱已注册，请直接登录。' });
      safeError(res, e);
    }
  });

  app.post('/api/members/login', gate, postGuard, async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;
    if (!email || typeof password !== 'string' || password.length > 128)
      return res.status(400).json({ error: '请填写正确的邮箱和密码。' });
    try {
      await schema();
      const result = await pool.query('SELECT id,email,display_name,created_at,password_hash FROM yq_members WHERE email=$1 LIMIT 1', [email]);
      const member = result.rows[0];
      // Deliberately use generic error so the login endpoint does not disclose membership.
      if (!member || !(await verifyPassword(password, member.password_hash)))
        return res.status(401).json({ error: '邮箱或密码不正确。' });
      await createSession(member.id, res);
      res.json({ ok: true, user: publicUser(member) });
    } catch(e) { safeError(res, e); }
  });

  app.get('/api/members/me', async (req, res) => {
    try {
      const user = await readCurrentUser(req);
      res.set('Cache-Control','no-store');
      res.json({ loggedIn: !!user, user });
    } catch(e) { safeError(res, e); }
  });

  app.post('/api/members/logout', gate, postGuard, async (req, res) => {
    try {
      const token = req.cookies?.[COOKIE];
      if (pool && typeof token === 'string' && /^[a-f0-9]{64}$/.test(token)) {
        await schema();
        await pool.query('DELETE FROM yq_member_sessions WHERE token_hash=$1', [digestToken(token)]);
      }
      clearCookie(res);
      res.json({ ok: true });
    } catch(e) { safeError(res,e); }
  });
}
