// ============================================================
// FLOWRA — Admin Bulk Charge Endpoint
// POST /api/admin — charge all customers or specific ones
// ============================================================

const Stripe = require('stripe');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

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

  // Auth check
  if (!body.password || body.password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const { action, amount, currency, description, customerIds } = body;

  try {

    // ── ACTION: list customers ──────────────────────────────
    if (action === 'list') {
      const customers = [];
      let hasMore = true;
      let startingAfter = undefined;

      while (hasMore) {
        const batch = await stripe.customers.list({
          limit: 100,
          ...(startingAfter && { starting_after: startingAfter }),
        });

        for (const customer of batch.data) {
          // Only include customers with saved payment methods
          const paymentMethods = await stripe.paymentMethods.list({
            customer: customer.id,
            type: 'card',
          });

          if (paymentMethods.data.length > 0) {
            const pm = paymentMethods.data[0];
            customers.push({
              id:       customer.id,
              name:     customer.name || 'Unknown',
              email:    customer.email || 'No email',
              card:     `${pm.card.brand.toUpperCase()} ····${pm.card.last4}`,
              expires:  `${pm.card.exp_month}/${pm.card.exp_year}`,
              color:    customer.metadata?.product_color || '—',
              size:     customer.metadata?.product_size  || '—',
              pmId:     pm.id,
            });
          }
        }

        hasMore = batch.has_more;
        if (batch.data.length > 0) {
          startingAfter = batch.data[batch.data.length - 1].id;
        }
      }

      return res.status(200).json({ customers, total: customers.length });
    }

    // ── ACTION: charge ──────────────────────────────────────
    if (action === 'charge') {
      if (!amount || amount < 1) {
        return res.status(400).json({ error: 'Invalid amount' });
      }

      // Get customers to charge
      let customersToCharge = [];

      if (customerIds && customerIds.length > 0) {
        // Charge specific customers
        for (const id of customerIds) {
          const customer = await stripe.customers.retrieve(id);
          const paymentMethods = await stripe.paymentMethods.list({
            customer: id, type: 'card',
          });
          if (paymentMethods.data.length > 0) {
            customersToCharge.push({
              id,
              name:  customer.name || 'Unknown',
              email: customer.email,
              pmId:  paymentMethods.data[0].id,
            });
          }
        }
      } else {
        // Charge all customers with saved cards
        let hasMore = true;
        let startingAfter = undefined;
        while (hasMore) {
          const batch = await stripe.customers.list({
            limit: 100,
            ...(startingAfter && { starting_after: startingAfter }),
          });
          for (const customer of batch.data) {
            const paymentMethods = await stripe.paymentMethods.list({
              customer: customer.id, type: 'card',
            });
            if (paymentMethods.data.length > 0) {
              customersToCharge.push({
                id:    customer.id,
                name:  customer.name || 'Unknown',
                email: customer.email,
                pmId:  paymentMethods.data[0].id,
              });
            }
          }
          hasMore = batch.has_more;
          if (batch.data.length > 0) {
            startingAfter = batch.data[batch.data.length - 1].id;
          }
        }
      }

      // Charge each customer
      const results = [];
      for (const customer of customersToCharge) {
        try {
          const pi = await stripe.paymentIntents.create({
            amount,
            currency:       currency || 'usd',
            customer:       customer.id,
            payment_method: customer.pmId,
            description:    description || 'FLOWRA Variable Billing',
            confirm:        true,
            off_session:    true,
            metadata: {
              admin_charge:  'true',
              customer_name: customer.name,
            },
          });
          results.push({
            customerId: customer.id,
            name:       customer.name,
            email:      customer.email,
            status:     'success',
            amount:     amount,
            piId:       pi.id,
          });
        } catch (err) {
          results.push({
            customerId: customer.id,
            name:       customer.name,
            email:      customer.email,
            status:     'failed',
            reason:     err.message,
          });
        }
      }

      const succeeded = results.filter(r => r.status === 'success').length;
      const failed    = results.filter(r => r.status === 'failed').length;

      return res.status(200).json({ results, succeeded, failed, total: results.length });
    }

    return res.status(400).json({ error: 'Invalid action' });

  } catch (err) {
    console.error('Admin error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
