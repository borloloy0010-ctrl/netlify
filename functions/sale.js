// netlify/functions/sale.js
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !WEBHOOK_SECRET) {
  console.error('Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY, WEBHOOK_SECRET');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const incomingSecret = event.headers['x-webhook-secret'] || event.headers['X-Webhook-Secret'];
  if (!incomingSecret || incomingSecret !== WEBHOOK_SECRET) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  // Accept either device_key or device name; prefer device_key for lookup
  const { device_key, device, vendo, amount, txn, ts = new Date().toISOString(), metadata = {} } = payload;

  if (!vendo || amount == null || !txn) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields: vendo, amount, txn' }) };
  }

  try {
    // 1) Resolve tenant_id from device_registry if device_key provided
    let tenant_id = null;
    let device_identifier = device_key || device || null;

    if (device_identifier) {
      const { data: devices, error: devErr } = await supabase
        .from('device_registry')
        .select('tenant_id, device_key, device_name')
        .or(device_key.eq.${device_identifier},device_name.eq.${device_identifier})
        .limit(1);

      if (devErr) {
        console.error('Device lookup error', devErr);
        return { statusCode: 502, body: JSON.stringify({ error: 'Device lookup failed', detail: devErr.message }) };
      }

      if (devices && devices.length) {
        tenant_id = devices[0].tenant_id;
      }
    }

    // If tenant_id still not found, reject (prefer explicit tenant resolution)
    if (!tenant_id) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Unknown device or missing tenant association' }) };
    }

    // 2) Prepare row for insert
    const row = {
      tenant_id,
      device: device_identifier,
      vendo,
      amount,
      txn,
      ts,
      metadata
    };

    // 3) Insert with dedupe handling - rely on unique index (tenant_id, txn)
    const { data, error } = await supabase.from('sales').insert([row]).select();

    if (error) {
      // If unique violation, return friendly message
      const msg = error.message || '';
      if (msg.toLowerCase().includes('duplicate') || msg.toLowerCase().includes('unique')) {
        return { statusCode: 200, body: JSON.stringify({ ok: true, message: 'Duplicate txn ignored', txn }) };
      }
      console.error('Supabase insert error', error);
      return { statusCode: 502, body: JSON.stringify({ error: 'DB insert failed', detail: error.message }) };
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, inserted: data }) };
  } catch (err) {
    console.error('Unhandled error', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
