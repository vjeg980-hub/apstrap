// ============================================================
// FLOWRA — Whop Checkout Backend
// Creates a Whop checkout session (charges + saves card for rebills)
// ============================================================

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  const { customer, product } = body;
  if (!customer?.email) return res.status(400).json({ error: 'Missing customer email' });

  const WHOP_API_KEY = process.env.WHOP_API_KEY;
  const WHOP_PLAN_ID = process.env.WHOP_PLAN_ID; // plan_XXXXXXXX for the $7.99 product
  const RETURN_URL   = process.env.RETURN_URL || 'https://flowra.vercel.app/checkout/complete';

  if (!WHOP_API_KEY || !WHOP_PLAN_ID) {
    return res.status(500).json({ error: 'Server misconfigured: missing Whop env vars' });
  }

  try {
    // Also save the card for future off-session rebills:
    // setupFutureUsage on the plan/checkout enables setup_intent.succeeded
    // webhook with the payment_method_id.
    const r = await fetch('https://api.whop.com/api/v2/checkout_sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WHOP_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        plan_id: WHOP_PLAN_ID,
        redirect_url: RETURN_URL,
        metadata: {
          customer_email: customer.email,
          customer_name:  `${customer.firstName || ''} ${customer.lastName || ''}`.trim(),
          customer_phone: customer.phone || '',
          address_line1:  customer.address?.line1 || '',
          address_line2:  customer.address?.line2 || '',
          address_city:   customer.address?.city || '',
          address_zip:    customer.address?.zip || '',
          address_country: customer.address?.country || 'US',
          product_color:  product?.color || '',
          product_size:   product?.size || '',
        },
      }),
    });

    const data = await r.json();

    if (!r.ok) {
      console.error('Whop checkout session error:', data);
      return res.status(500).json({ error: data?.error || data?.message || 'Failed to create checkout session' });
    }

    return res.status(200).json({ session_id: data.id });

  } catch (err) {
    console.error('Whop error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
