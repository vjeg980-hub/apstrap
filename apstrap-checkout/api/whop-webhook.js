// ============================================================
// FLOWRA — Whop Webhook Receiver
// Captures payment_method_id + customer info on successful checkout
// for future off-session rebills via the Whop API.
//
// Configure this URL in Whop Dashboard -> Settings -> Webhooks
// Subscribe to: payment.succeeded (and/or setup_intent.succeeded)
// ============================================================

const crypto = require('crypto');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  // Verify webhook signature if Whop provides one (recommended)
  const signature = req.headers['x-whop-signature'];
  const secret = process.env.WHOP_WEBHOOK_SECRET;

  let rawBody;
  try {
    rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  } catch {
    return res.status(400).json({ error: 'Invalid body' });
  }

  if (secret && signature) {
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    if (expected !== signature) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  const event = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

  try {
    if (event.type === 'payment.succeeded' || event.type === 'setup_intent.succeeded') {
      const data = event.data || {};
      const record = {
        whop_member_id:     data.member_id || data.user_id || null,
        whop_payment_method_id: data.payment_method_id || data.payment_method?.id || null,
        email:              data.metadata?.customer_email || data.email || null,
        name:               data.metadata?.customer_name || null,
        amount:             data.amount || null,
        currency:           data.currency || null,
        product_color:      data.metadata?.product_color || null,
        product_size:       data.metadata?.product_size || null,
        received_at:        new Date().toISOString(),
      };

      // TODO: persist `record` to your database (this is what enables rebills)
      console.log('Captured customer/payment record:', record);
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
