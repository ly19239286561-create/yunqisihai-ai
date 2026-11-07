import rateLimit from 'express-rate-limit';
import { MAX_WALLET_POINTS, parseRequestedPoints, validOrderId, cleanRemark } from './credit-core.js';

const applicantRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: '申请太频繁，请稍后重试。' }
});
const adminRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: '操作太频繁，请稍后重试。' }
});

export function registerCreditRoutes(app, { pool, schema, readCurrentUser, postGuard, adminSession }) {
  let initPromise;
  async function ensureCreditSchema() {
    await schema();
    if (!initPromise) {
      if (!pool) throw new Error('NO_DATABASE');
      initPromise = (async () => {
        await pool.query(`CREATE TABLE IF NOT EXISTS yq_credit_wallets (
          member_id UUID PRIMARY KEY REFERENCES yq_members(id) ON DELETE CASCADE,
          balance INTEGER NOT NULL DEFAULT 0 CHECK (balance BETWEEN 0 AND ${MAX_WALLET_POINTS}),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
        await pool.query(`CREATE TABLE IF NOT EXISTS yq_credit_orders (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          member_id UUID NOT NULL REFERENCES yq_members(id) ON DELETE CASCADE,
          requested_points INTEGER NOT NULL CHECK (requested_points BETWEEN 1 AND 100000),
          remark VARCHAR(200) NOT NULL DEFAULT '',
          status VARCHAR(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          reviewed_at TIMESTAMPTZ,
          reviewed_by VARCHAR(254)
        )`);
        await pool.query('CREATE INDEX IF NOT EXISTS yq_credit_orders_member_time ON yq_credit_orders(member_id,created_at DESC)');
        await pool.query('CREATE INDEX IF NOT EXISTS yq_credit_orders_status_time ON yq_credit_orders(status,created_at DESC)');
        await pool.query(`CREATE TABLE IF NOT EXISTS yq_credit_ledger (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          member_id UUID NOT NULL REFERENCES yq_members(id) ON DELETE CASCADE,
          order_id UUID REFERENCES yq_credit_orders(id) ON DELETE RESTRICT,
          delta INTEGER NOT NULL CHECK (delta <> 0),
          balance_after INTEGER NOT NULL CHECK (balance_after BETWEEN 0 AND ${MAX_WALLET_POINTS}),
          note VARCHAR(200) NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
        await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS yq_credit_ledger_order_once ON yq_credit_ledger(order_id) WHERE order_id IS NOT NULL');
        await pool.query('CREATE INDEX IF NOT EXISTS yq_credit_ledger_member_time ON yq_credit_ledger(member_id,created_at DESC)');
      })().catch(e => { initPromise = null; throw e; });
    }
    return initPromise;
  }

  function errorResponse(res, error) {
    if (error?.message === 'NO_DATABASE') return res.status(503).json({ error: '请先配置 Neon 数据库。' });
    console.error('Credits request error:', error?.code || error?.name || 'database-error');
    return res.status(503).json({ error: '积分服务暂不可用，请稍后重试。' });
  }
  async function requireMember(req, res, next) {
    try {
      const user = await readCurrentUser(req);
      if (!user) return res.status(401).json({ error: '请先登录会员。' });
      req.member = user;
      next();
    } catch (error) { errorResponse(res,error); }
  }
  function requireAdmin(req,res,next) {
    if (!adminSession(req)) return res.status(401).json({ error: '请先使用管理员账户登录工作台。' });
    next();
  }

  app.get('/api/members/credits', requireMember, async(req,res) => {
    try {
      await ensureCreditSchema();
      const memberId = req.member.id;
      const [wallet,orders,ledger] = await Promise.all([
        pool.query('SELECT balance,updated_at FROM yq_credit_wallets WHERE member_id=$1',[memberId]),
        pool.query('SELECT id,requested_points,remark,status,created_at,reviewed_at FROM yq_credit_orders WHERE member_id=$1 ORDER BY created_at DESC LIMIT 30',[memberId]),
        pool.query('SELECT id,delta,balance_after,note,created_at FROM yq_credit_ledger WHERE member_id=$1 ORDER BY created_at DESC LIMIT 30',[memberId])
      ]);
      res.set('Cache-Control','no-store');
      res.json({ balance:wallet.rows[0]?.balance ?? 0, orders:orders.rows, ledger:ledger.rows, onlinePaymentEnabled:false });
    } catch (error) { errorResponse(res,error); }
  });

  app.post('/api/members/credit-orders', requireMember, applicantRateLimit, postGuard, async(req,res) => {
    const points = parseRequestedPoints(req.body?.points);
    const remark = cleanRemark(req.body?.remark);
    if (points === null || remark === null) return res.status(400).json({ error:'积分需为1至100000的整数，备注最多200字。' });
    try {
      await ensureCreditSchema();
      const pending = await pool.query("SELECT count(*)::int AS total FROM yq_credit_orders WHERE member_id=$1 AND status='pending'",[req.member.id]);
      if (pending.rows[0].total >= 3) return res.status(409).json({ error:'最多允许3笔待审核申请，请先等待管理员处理。' });
      const order = await pool.query('INSERT INTO yq_credit_orders (member_id,requested_points,remark) VALUES ($1,$2,$3) RETURNING id,requested_points,status,created_at',[req.member.id,points,remark]);
      res.status(201).json({ order:order.rows[0], message:'申请已提交；未付款、未加分，等待管理员审核。' });
    } catch (error) { errorResponse(res,error); }
  });

  app.get('/api/admin/credit-orders', requireAdmin, async(_req,res) => {
    try {
      await ensureCreditSchema();
      const orders = await pool.query(`SELECT o.id,o.requested_points,o.remark,o.status,o.created_at,o.reviewed_at,
          m.email,m.display_name FROM yq_credit_orders o JOIN yq_members m ON m.id=o.member_id
          ORDER BY (o.status='pending') DESC,o.created_at DESC LIMIT 100`);
      res.set('Cache-Control','no-store');
      res.json({ orders:orders.rows });
    } catch (error) { errorResponse(res,error); }
  });

  async function reviewOrder(req,res,decision) {
    const id = req.params.id;
    if (!validOrderId(id)) return res.status(400).json({ error:'订单编号无效。' });
    let client;
    try {
      await ensureCreditSchema();
      client = await pool.connect();
      await client.query('BEGIN');
      const found=await client.query('SELECT id,member_id,requested_points,status FROM yq_credit_orders WHERE id=$1 FOR UPDATE',[id]);
      const order=found.rows[0];
      if (!order) { await client.query('ROLLBACK'); return res.status(404).json({ error:'订单不存在。' }); }
      if (order.status !== 'pending') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error:'订单已经审核，不能重复发放积分。' });
      }
      let balance=null;
      if (decision==='approved') {
        await client.query('INSERT INTO yq_credit_wallets(member_id) VALUES ($1) ON CONFLICT(member_id) DO NOTHING',[order.member_id]);
        const wallet=await client.query(`UPDATE yq_credit_wallets
             SET balance=balance+$2,updated_at=NOW()
             WHERE member_id=$1 AND balance <= ($3::integer - $2::integer) RETURNING balance`,[order.member_id,order.requested_points,MAX_WALLET_POINTS]);
        if (!wallet.rows.length) {
          await client.query('ROLLBACK'); return res.status(409).json({ error:'会员余额达到上限，无法批准。' });
        }
        balance=wallet.rows[0].balance;
        await client.query('INSERT INTO yq_credit_ledger(member_id,order_id,delta,balance_after,note) VALUES ($1,$2,$3,$4,$5)',
          [order.member_id,order.id,order.requested_points,balance,'管理员审核发放（非在线支付）']);
      }
      await client.query('UPDATE yq_credit_orders SET status=$2,reviewed_at=NOW(),reviewed_by=$3 WHERE id=$1',
        [order.id,decision,process.env.ADMIN_EMAIL?.trim()?.toLowerCase() || 'admin']);
      await client.query('COMMIT');
      res.json({ok:true,id:order.id,status:decision,balance});
    } catch(error) {
      if (client) { try { await client.query('ROLLBACK'); } catch {} }
      errorResponse(res,error);
    } finally { if(client)client.release(); }
  }
  app.post('/api/admin/credit-orders/:id/approve', requireAdmin, adminRateLimit, postGuard, (req,res)=>reviewOrder(req,res,'approved'));
  app.post('/api/admin/credit-orders/:id/reject', requireAdmin, adminRateLimit, postGuard, (req,res)=>reviewOrder(req,res,'rejected'));
}
