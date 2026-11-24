// api/agent.js (Vercel Serverless Function — CommonJS)
// Secure bridge between your Supabase database and the shop's Windows Print Agent.
// Supports: heartbeat (claim job), download (Vercel proxy fallback if shop ISP blocks Supabase), complete.

const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
    const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
    if (!supabaseUrl || !serviceKey) {
      return res.status(500).json({ error: 'Server config missing' });
    }

    const token = String(req.headers['x-agent-token'] || '').trim();
    if (!token) {
      return res.status(401).json({ error: 'Missing x-agent-token header' });
    }

    const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    const { data: shop, error: shopErr } = await sb
      .from('shops')
      .select('id, name, slug, status, printer_bw_a4, printer_color_a4, printer_a3, supports_duplex')
      .eq('agent_token', token)
      .maybeSingle();

    if (shopErr || !shop) {
      return res.status(401).json({ error: 'Invalid agent token' });
    }

    const body = req.body || {};
    const action = body.action || 'heartbeat';

    // 1. HEARTBEAT + CLAIM NEXT QUEUED PRINT JOB
    if (action === 'heartbeat') {
      const updateShop = { agent_last_seen: new Date().toISOString() };
      if (Array.isArray(body.printers) && body.printers.length > 0) {
        updateShop.available_printers = body.printers.slice(0, 30);
      }
      await sb.from('shops').update(updateShop).eq('id', shop.id);

      const { data: jobs, error: jobErr } = await sb
        .from('orders')
        .select('*')
        .eq('shop_id', shop.id)
        .eq('auto_print_status', 'queued')
        .not('file_path', 'is', null)
        .order('created_at', { ascending: true })
        .limit(1);

      if (jobErr) return res.status(500).json({ error: jobErr.message });
      if (!jobs || !jobs.length) {
        return res.status(200).json({ ok: true, shop: shop.name, job: null });
      }

      const job = jobs[0];

      const { data: claimed, error: claimErr } = await sb
        .from('orders')
        .update({ auto_print_status: 'printing', status: 'printing' })
        .eq('id', job.id)
        .eq('auto_print_status', 'queued')
        .select('id');

      if (claimErr || !claimed || !claimed.length) {
        return res.status(200).json({ ok: true, shop: shop.name, job: null });
      }

      const { data: signed, error: signErr } = await sb.storage
        .from('print-files')
        .createSignedUrl(job.file_path, 180);

      if (signErr || !signed || !signed.signedUrl) {
        await sb
          .from('orders')
          .update({ auto_print_status: 'failed', status: 'received' })
          .eq('id', job.id);
        return res.status(500).json({ error: 'Could not sign file URL' });
      }

      let printerName = '';
      if (job.paper === 'A3' && shop.printer_a3) {
        printerName = shop.printer_a3;
      } else if (job.colour === 'color' && shop.printer_color_a4) {
        printerName = shop.printer_color_a4;
      } else if (shop.printer_bw_a4) {
        printerName = shop.printer_bw_a4;
      }

      return res.status(200).json({
        ok: true,
        shop: shop.name,
        job: {
          id: job.id,
          ticket_no: job.ticket_no,
          file_name: job.file_name,
          signed_url: signed.signedUrl,
          colour: job.colour || 'bw',
          paper: job.paper || 'A4',
          double_sided: Boolean(job.double_sided) && shop.supports_duplex !== false,
          copies: Math.max(1, Number(job.copies) || 1),
          printer_name: printerName,
        },
      });
    }

    // 2. PROXY DOWNLOAD (fallback when shop ISP blocks direct supabase.co download)
    if (action === 'download') {
      const orderId = body.order_id;
      if (!orderId) return res.status(400).json({ error: 'Missing order_id' });

      const { data: ord, error: ordErr } = await sb
        .from('orders')
        .select('file_path')
        .eq('id', orderId)
        .eq('shop_id', shop.id)
        .maybeSingle();

      if (ordErr || !ord || !ord.file_path) {
        return res.status(404).json({ error: 'Order file not found' });
      }

      const { data: blob, error: dlErr } = await sb.storage
        .from('print-files')
        .download(ord.file_path);

      if (dlErr || !blob) {
        return res.status(500).json({ error: 'Storage download failed' });
      }

      const buf = Buffer.from(await blob.arrayBuffer());
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Length', String(buf.length));
      return res.status(200).send(buf);
    }

    // 3. REPORT PRINT COMPLETION OR FAILURE
    if (action === 'complete') {
      const orderId = body.order_id;
      if (!orderId) return res.status(400).json({ error: 'Missing order_id' });

      const success = Boolean(body.success);
      const patch = success
        ? { auto_print_status: 'printed', status: 'ready' }
        : { auto_print_status: 'failed', status: 'received' };

      const { error: upErr } = await sb
        .from('orders')
        .update(patch)
        .eq('id', orderId)
        .eq('shop_id', shop.id);

      if (upErr) return res.status(500).json({ error: upErr.message });
      return res.status(200).json({ ok: true, status: patch.status });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('agent api error:', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
};
