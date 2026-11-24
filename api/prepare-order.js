// api/prepare-order.js (Vercel Serverless Function — CommonJS, works without "type": "module")
// Fixes #3 (Server-side page count & price calculation) + #4 (JPG/PNG to PDF & 2-up/4-up N-up layout)
//
// Required Vercel Environment Variables:
//   SUPABASE_URL=https://iwzacblitkdzenmrugjj.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here
//
// Required package.json dependencies:
//   npm install @supabase/supabase-js pdf-lib

const { createClient } = require('@supabase/supabase-js');
const { PDFDocument } = require('pdf-lib');

const PAGE_SIZES = {
  A4: { w: 595.28, h: 841.89 },
  A3: { w: 841.89, h: 1190.55 },
};

const MARGIN = 20;

function monthStartIST() {
  const d = new Date(Date.now() + 5.5 * 3600000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/**
 * Converts JPG/PNG bytes into a single-page A4 or A3 PDF centered with aspect-ratio fit.
 */
async function imageToPdf(bytes, contentType, paper) {
  const pdf = await PDFDocument.create();
  const img = contentType === 'image/png' ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
  const base = PAGE_SIZES[paper] || PAGE_SIZES.A4;

  const isLandscape = img.width > img.height;
  const pageW = isLandscape ? base.h : base.w;
  const pageH = isLandscape ? base.w : base.h;

  const page = pdf.addPage([pageW, pageH]);
  const maxW = pageW - MARGIN * 2;
  const maxH = pageH - MARGIN * 2;
  const scale = Math.min(maxW / img.width, maxH / img.height);
  const drawW = img.width * scale;
  const drawH = img.height * scale;

  page.drawImage(img, {
    x: (pageW - drawW) / 2,
    y: (pageH - drawH) / 2,
    width: drawW,
    height: drawH,
  });

  return pdf;
}

/**
 * Tiles an existing PDF into 2-up (2x1 landscape) or 4-up (2x2 portrait) print-ready PDF
 * so Windows silent printers (SumatraPDF / HP / Canon / Epson) never misalign pages_per_sheet.
 */
async function buildNUpPdf(sourcePdf, pps, paper) {
  if (pps !== 2 && pps !== 4) return sourcePdf;

  const outPdf = await PDFDocument.create();
  const srcPages = sourcePdf.getPages();
  const embedded = await outPdf.embedPages(srcPages);
  const base = PAGE_SIZES[paper] || PAGE_SIZES.A4;

  const cols = 2;
  const rows = pps === 4 ? 2 : 1;
  const sheetW = pps === 2 ? base.h : base.w;
  const sheetH = pps === 2 ? base.w : base.h;
  const gap = 12;

  const cellW = (sheetW - MARGIN * 2 - gap * (cols - 1)) / cols;
  const cellH = (sheetH - MARGIN * 2 - gap * (rows - 1)) / rows;

  for (let i = 0; i < embedded.length; i += pps) {
    const sheet = outPdf.addPage([sheetW, sheetH]);
    for (let slot = 0; slot < pps && i + slot < embedded.length; slot++) {
      const ep = embedded[i + slot];
      const col = slot % cols;
      const row = Math.floor(slot / cols);

      const scale = Math.min(cellW / ep.width, cellH / ep.height);
      const drawW = ep.width * scale;
      const drawH = ep.height * scale;

      const cellX = MARGIN + col * (cellW + gap);
      const cellY = sheetH - MARGIN - (row + 1) * cellH - row * gap;

      sheet.drawPage(ep, {
        x: cellX + (cellW - drawW) / 2,
        y: cellY + (cellH - drawH) / 2,
        width: drawW,
        height: drawH,
      });
    }
  }
  return outPdf;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: 'Server config missing (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)' });
  }

  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  try {
    const {
      shop_id,
      file_path,
      file_name,
      content_type,
      colour = 'bw',
      paper = 'A4',
      pps = 1,
      double_sided = false,
      copies = 1,
      payment_mode = 'cash',
    } = req.body || {};

    if (!shop_id || !file_path || !file_name) {
      return res.status(400).json({ error: 'Missing required order fields.' });
    }
    if (!file_path.startsWith(`${shop_id}/`)) {
      return res.status(403).json({ error: 'Invalid file path for shop.' });
    }
    const cleanColour = colour === 'color' ? 'color' : 'bw';
    const cleanPaper = paper === 'A3' ? 'A3' : 'A4';
    const cleanPps = [1, 2, 4].includes(Number(pps)) ? Number(pps) : 1;
    const cleanCopies = Math.max(1, Math.min(50, parseInt(copies, 10) || 1));
    const cleanPayMode = payment_mode === 'upi' ? 'upi' : 'cash';

    const { data: shop, error: shopErr } = await sb
      .from('shops')
      .select('*')
      .eq('id', shop_id)
      .maybeSingle();

    if (shopErr || !shop) {
      return res.status(404).json({ error: 'Dukaan nahi mili.' });
    }
    const now = Date.now();
    const isOpen =
      shop.status !== 'paused' &&
      ((shop.paid_until && new Date(shop.paid_until).getTime() > now) ||
        new Date(shop.trial_ends_at).getTime() > now);
    if (!isOpen) {
      return res.status(403).json({ error: 'Ye dukaan abhi online orders nahi le rahi.' });
    }

    const [{ data: plan }, { count: monthCount }] = await Promise.all([
      sb.from('plans').select('monthly_limit').eq('key', shop.plan).maybeSingle(),
      sb
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('shop_id', shop.id)
        .gte('order_date', monthStartIST()),
    ]);
    if (plan && (monthCount || 0) >= plan.monthly_limit) {
      return res.status(403).json({ error: 'Is dukaan ki mahine ki order limit poori ho gayi hai.' });
    }

    const cleanDouble = Boolean(double_sided) && shop.supports_duplex !== false;

    const { data: blob, error: dlErr } = await sb.storage.from('print-files').download(file_path);
    if (dlErr || !blob) {
      return res.status(400).json({ error: 'Uploaded file nahi mili. Dobara try karein.' });
    }
    const rawBytes = new Uint8Array(await blob.arrayBuffer());
    const mime = content_type || blob.type || '';

    let workingPdf;
    let truePages = 0;

    if (mime === 'image/jpeg' || mime === 'image/png' || /\.(jpe?g|png)$/i.test(file_name)) {
      const imgMime = mime === 'image/png' || /\.png$/i.test(file_name) ? 'image/png' : 'image/jpeg';
      workingPdf = await imageToPdf(rawBytes, imgMime, cleanPaper);
      truePages = 1;
    } else if (mime === 'application/pdf' || /\.pdf$/i.test(file_name)) {
      try {
        workingPdf = await PDFDocument.load(rawBytes, { ignoreEncryption: true });
        truePages = workingPdf.getPageCount();
      } catch {
        return res.status(422).json({
          error: 'Ye PDF password-protected ya corrupted hai. Bina password wali PDF upload karein.',
        });
      }
    } else {
      return res.status(400).json({ error: 'Sirf PDF, JPG ya PNG files supported hain.' });
    }

    if (truePages < 1 || truePages > 1000) {
      return res.status(400).json({ error: 'Page count 1 se 1000 ke beech hona chahiye.' });
    }

    const needsReupload = mime !== 'application/pdf' || cleanPps > 1;
    let finalPath = file_path;

    if (needsReupload) {
      const finalPdf = cleanPps > 1 ? await buildNUpPdf(workingPdf, cleanPps, cleanPaper) : workingPdf;
      const pdfBytes = await finalPdf.save();
      finalPath = `${shop.id}/ready-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pdf`;

      const { error: upErr } = await sb.storage.from('print-files').upload(finalPath, pdfBytes, {
        contentType: 'application/pdf',
        upsert: false,
      });
      if (upErr) {
        return res.status(500).json({ error: 'Print-ready PDF save nahi ho payi.' });
      }
      await sb.storage.from('print-files').remove([file_path]);
    }

    const sides = Math.ceil(truePages / cleanPps);
    const sheets = cleanDouble ? Math.ceil(sides / 2) : sides;
    const rateKey = `${cleanColour === 'bw' ? 'rate_bw_' : 'rate_color_'}${cleanPaper.toLowerCase()}`;
    const rate = Number(shop[rateKey]) || 0;
    const amount = Number((sheets * rate * cleanCopies).toFixed(2));

    const { data: created, error: ordErr } = await sb.rpc('create_order', {
      p_shop_id: shop.id,
      p_file_name: file_name,
      p_file_path: finalPath,
      p_pages: truePages,
      p_colour: cleanColour,
      p_paper: cleanPaper,
      p_pps: cleanPps,
      p_double: cleanDouble,
      p_copies: cleanCopies,
    });

    if (ordErr || !created) {
      return res.status(500).json({ error: ordErr ? ordErr.message : 'Order create nahi hua.' });
    }

    await sb
      .from('orders')
      .update({
        pages: truePages,
        sheets,
        amount,
        verified_by_server: true,
        payment_mode: cleanPayMode,
        payment_status: 'pending',
        auto_print_status: cleanPayMode === 'upi' ? 'awaiting_upi' : 'waiting_cash',
      })
      .eq('id', created.order_id);

    return res.status(200).json({
      order_id: created.order_id,
      pages: truePages,
      sheets,
      amount,
      file_path: finalPath,
    });
  } catch (err) {
    console.error('prepare-order error:', err);
    return res.status(500).json({ error: 'Server error: ' + (err.message || 'try again') });
  }
};
