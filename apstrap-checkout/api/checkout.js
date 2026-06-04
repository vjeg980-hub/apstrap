// ============================================================
// FLOWRA — Vercel Serverless Backend
// Chargebee Product Catalog 2.0 + Stripe processing
// ============================================================

const https = require('https');

function chargebeeRequest(method, path, data) {
  return new Promise((resolve, reject) => {
    const site   = process.env.CHARGEBEE_SITE;
    const apiKey = process.env.CHARGEBEE_API_KEY;
    const auth   = Buffer.from(`${apiKey}:`).toString('base64');
    const body   = data ? new URLSearchParams(data).toString() : '';

    const options = {
      hostname: `${site}.chargebee.com`,
      path:     `/api/v2${path}`,
      method,
      headers: {
        'Authorization':  `Basic ${auth}`,
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, res => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          if (res.statusCode >= 400) {
            reject(new Error(parsed.message || JSON.stringify(parsed)));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error('Invalid Chargebee response: ' + raw));
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

module.exports = async (req, res) => {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  const { paymentMethodId, customer, consent } = body;

  if (!paymentMethodId) return res.status(400).json({ error: 'Missing payment method' });
  if (!customer?.email) return res.status(400).json({ error: 'Missing customer email' });
  if (!consent?.authorizedVariableBilling) return res.status(400).json({ error: 'Billing authorization required' });
  if (!consent?.agreedToTerms) return res.status(400).json({ error: 'Terms agreement required' });

  try {

    // ── STEP 1: Create Chargebee customer with vaulted card ───
    const cbCustomer = await chargebeeRequest('POST', '/customers', {
      'first_name':                         customer.firstName,
      'last_name':                          customer.lastName,
      'email':                              customer.email,
      'phone':                              customer.phone || '',
      'billing_address[first_name]':        customer.firstName,
      'billing_address[last_name]':         customer.lastName,
      'billing_address[line1]':             customer.address.line1,
      'billing_address[line2]':             customer.address.line2 || '',
      'billing_address[city]':              customer.address.city,
      'billing_address[zip]':               customer.address.zip,
      'billing_address[country]':           customer.address.country,
      'payment_method[type]':               'card',
      'payment_method[gateway_account_id]': process.env.CHARGEBEE_GATEWAY_ID,
      'payment_method[tmp_token]':          paymentMethodId,
      'meta_data': JSON.stringify({
        authorized_variable_billing: consent.authorizedVariableBilling,
        agreed_to_terms:             consent.agreedToTerms,
        authorized_at:               consent.authorizedAt,
        marketing_opt_in:            consent.marketingOptIn || false,
      }),
    });

    const customerId      = cbCustomer.customer.id;
    const paymentSourceId = cbCustomer.customer.primary_payment_source_id;

    // ── STEP 2: Charge for FLOWRA Dress — one-time invoice ────
    const invoice = await chargebeeRequest('POST', '/invoices/create_for_charge_items_and_charges', {
      'customer_id':                   customerId,
      'payment_source_id':             paymentSourceId,
      'currency_code':                 'USD',
      'item_prices[item_price_id][0]': 'FLOWRA-Dress-USD',
      'item_prices[quantity][0]':      '1',
    });

    // ── STEP 3: Create FLOWRA Club subscription ───────────────
    const subscription = await chargebeeRequest(
      'POST',
      `/customers/${customerId}/subscription_for_items`,
      {
        'payment_source_id':                    paymentSourceId,
        'subscription_items[item_price_id][0]': 'FLOWRA-Club-USD-Monthly',
        'subscription_items[quantity][0]':      '1',
      }
    );

    return res.status(200).json({
      success:        true,
      customerId,
      invoiceId:      invoice.invoice?.id,
      subscriptionId: subscription.subscription?.id,
    });

  } catch (err) {
    console.error('Checkout error:', err.message);
    return res.status(500).json({
      error: err.message || 'Something went wrong. Please try again.',
    });
  }
};
