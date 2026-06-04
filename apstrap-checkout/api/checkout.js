// ============================================================
// FLOWRA — Pure Stripe Backend
// Creates customer + PaymentIntent with saved card
// Cards saved via setup_future_usage — charge anytime from
// Stripe dashboard or API using customer ID
// ============================================================

const Stripe = require('stripe');

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

  const { amount, currency, customer, product } = body;
  if (!amount)          return res.status(400).json({ error: 'Missing amount' });
  if (!customer?.email) return res.status(400).json({ error: 'Missing customer email' });

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

  try {
    // Find or create Stripe customer — so repeat buyers don't get duplicated
    const existing = await stripe.customers.list({ email: customer.email, limit: 1 });
    let stripeCustomer;

    if (existing.data.length > 0) {
      stripeCustomer = existing.data[0];
      // Update metadata with latest order info
      await stripe.customers.update(stripeCustomer.id, {
        metadata: {
          product_color: product?.color || '',
          product_size:  product?.size  || '',
        },
      });
    } else {
      stripeCustomer = await stripe.customers.create({
        email: customer.email,
        name:  `${customer.firstName} ${customer.lastName}`.trim(),
        phone: customer.phone || undefined,
        address: {
          line1:       customer.address?.line1    || '',
          line2:       customer.address?.line2    || undefined,
          city:        customer.address?.city     || '',
          postal_code: customer.address?.zip      || '',
          country:     customer.address?.country  || 'US',
        },
        metadata: {
          product_color: product?.color || '',
          product_size:  product?.size  || '',
        },
      });
    }

    // Create PaymentIntent
    // setup_future_usage: 'off_session' saves the card to the customer
    // so you can charge them again anytime from Stripe dashboard or API
    const paymentIntent = await stripe.paymentIntents.create({
      amount:   amount,
      currency: currency || 'usd',
      customer: stripeCustomer.id,
      setup_future_usage: 'off_session',
      automatic_payment_methods: { enabled: true },
      metadata: {
        customer_name:  `${customer.firstName} ${customer.lastName}`.trim(),
        customer_email: customer.email,
        product_color:  product?.color || '',
        product_size:   product?.size  || '',
      },
    });

    return res.status(200).json({
      client_secret: paymentIntent.client_secret,
      customer_id:   stripeCustomer.id,
    });

  } catch (err) {
    console.error('Stripe error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
