'use strict';

function payable(order) {
  if (order.payment_review || ['cancelled', 'rto', 'returned'].includes(String(order.status).toLowerCase())) return false;
  if (order.payment_method === 'cod') return order.status === 'Delivered' && Boolean(order.cod_collected_at);
  return order.payment_method === 'razorpay' && Boolean(order.payment_verified_at && order.payment_id) &&
    String(order.razorpay_key_id || '').startsWith('rzp_live_');
}

async function credit(db, commission) {
  await db.query(`INSERT INTO affiliate_wallets (affiliate_id, current_balance, total_earned) VALUES ($1, $2, $2)
    ON CONFLICT (affiliate_id) DO UPDATE SET current_balance = affiliate_wallets.current_balance + $2,
    total_earned = affiliate_wallets.total_earned + $2, updated_at = NOW()`, [commission.affiliate_id, commission.commission_amount]);
  await db.query(`INSERT INTO wallet_transactions (affiliate_id, transaction_type, amount, description, reference_id)
    VALUES ($1, 'COMMISSION', $2, $3, $4)`, [commission.affiliate_id, commission.commission_amount,
    `Commission from Order #${commission.order_id}`, commission.id]);
}

async function confirmCodCollection(pool, id) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const { rows } = await db.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id]);
    const order = rows[0];
    if (!order || order.payment_method !== 'cod' || order.status !== 'Delivered' || order.payment_review) {
      throw Object.assign(new Error('Only a delivered COD order can have collection confirmed'), { status: 409 });
    }
    await db.query('UPDATE orders SET cod_collected_at=COALESCE(cod_collected_at,NOW()) WHERE id=$1', [id]);
    const commissions = await db.query(`UPDATE commissions SET status='APPROVED'
      WHERE order_id=$1 AND status='PENDING' RETURNING *`, [id]);
    for (const commission of commissions.rows) await credit(db, commission);
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

async function ensureCommissionSecurity(pool) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(71346, 1)');
    await db.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS cod_collected_at TIMESTAMPTZ');
    // Hold existing unpaid COD/test credits as well as new ones. Paid historical payouts need manual review.
    const { rows } = await db.query(`SELECT c.* FROM commissions c JOIN orders o ON o.id=c.order_id
      WHERE c.status='APPROVED' AND (o.payment_method='cod' AND o.cod_collected_at IS NULL
        OR o.payment_method='razorpay' AND (o.razorpay_key_id IS NULL OR LEFT(o.razorpay_key_id,9) <> 'rzp_live_'
          OR o.payment_verified_at IS NULL OR o.payment_id IS NULL)) FOR UPDATE OF c`);
    for (const commission of rows) {
      await db.query("UPDATE commissions SET status='PENDING' WHERE id=$1", [commission.id]);
      await db.query(`UPDATE affiliate_wallets SET current_balance=current_balance-$2,
        total_earned=total_earned-$2, updated_at=NOW() WHERE affiliate_id=$1`, [commission.affiliate_id, commission.commission_amount]);
      await db.query(`INSERT INTO wallet_transactions(affiliate_id,transaction_type,amount,description,reference_id)
        VALUES ($1,'REVERSAL',$2,'Uncollected/test payment commission held for review',$3)`,
      [commission.affiliate_id, -commission.commission_amount, commission.id]);
    }
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

module.exports = { payable, credit, confirmCodCollection, ensureCommissionSecurity };
