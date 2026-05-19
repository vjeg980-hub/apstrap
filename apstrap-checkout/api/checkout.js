// ============================================================
// AP STRAP — Vercel Serverless Backend
// Chargebee customer + subscription + Stripe processing
// ============================================================

const https = require('https');

// ── Helpers ─────────────────────────────────────────────────

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
            reject(new Error(parsed.message || 'Chargebee error'));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error('Invalid Chargebee response'));
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Main handler ─────────────────────────────────────────────

module.exports = async (req, res) => {

  // CORS headers — update origin to your actual domain
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── Parse body ─────────────────────────────────────────────
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  const {
    paymentMethodId,
    customer,
    consent,
  } = body;

  // ── Validate required fields ───────────────────────────────
  if (!paymentMethodId)              return res.status(400).json({ error: 'Missing payment method' });
  if (!customer?.email)              return res.status(400).json({ error: 'Missing customer email' });
  if (!consent?.authorizedVariableBilling) return res.status(400).json({ error: 'Billing authorization required' });
  if (!consent?.agreedToTerms)       return res.status(400).json({ error: 'Terms agreement required' });

  try {

    // ── STEP 1: Create Chargebee customer ─────────────────────
    // Card is stored in Chargebee vault via Stripe gateway
    // Tokens stored in Chargebee — NOT Stripe alone
    const customerData = {
      'first_name':                     customer.firstName,
      'last_name':                      customer.lastName,
      'email':                          customer.email,
      'phone':                          customer.phone || '',
      'billing_address[first_name]':    customer.firstName,
      'billing_address[last_name]':     customer.lastName,
      'billing_address[line1]':         customer.address.line1,
      'billing_address[line2]':         customer.address.line2 || '',
      'billing_address[city]':          customer.address.city,
      'billing_address[zip]':           customer.address.zip,
      'billing_address[country]':       customer.address.country,
      'payment_method[type]':           'card',
      'payment_method[gateway]':        'stripe',
      'payment_method[gateway_account_id]': process.env.CHARGEBEE_GATEWAY_ID,
      'payment_method[tmp_token]':      paymentMethodId,
      // Store consent on customer record for audit trail
      'meta_data': JSON.stringify({
        authorized_variable_billing: consent.authorizedVariableBilling,
        agreed_to_terms:             consent.agreedToTerms,
        authorized_at:               consent.authorizedAt,
        marketing_opt_in:            consent.marketingOptIn || false,
      }),
    };

    const cbCustomer = await chargebeeRequest(
      'POST',
      '/customers',
      customerData
    );

    const customerId = cbCustomer.customer.id;

    // ── STEP 2: Charge $54.99 for AP Strap (one-time) ────────
    // This creates an invoice and charges the stored card
    const chargeData = {
      'customer_id':             customerId,
      'currency_code':           'USD',
      'charges[0][amount]':      5499,   // cents
      'charges[0][description]': 'AP Strap Conversion Band',
      'charges[0][taxable]':     false,
    };

    const invoice = await chargebeeRequest(
      'POST',
      '/invoices/charge',
      chargeData
    );

    // ── STEP 3: Create free AP Club VIP subscription ──────────
    // Price is $0 so no charge today
    // Card is vaulted — future usage charges via Chargebee dashboard
    const subscriptionData = {
      'plan_id':                            'AP-Club-VIP',
      'customer_id':                         customerId,
      'payment_source_id':                   cbCustomer.customer.primary_payment_source_id,
    };

    const subscription = await chargebeeRequest(
      'POST',
      `/customers/${customerId}/subscriptions`,
      subscriptionData
    );

    // ── STEP 4: Return success ────────────────────────────────
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
