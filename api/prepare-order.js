// api/prepare-order.js (Vercel Serverless Function — CommonJS)
// Supports:
//  1. Normal Documents (PDF, JPG, PNG, Word .doc/.docx, PPT .ppt/.pptx) + Page Range + 2-up/4-up
//  2. ID Card Mode (order_type === 'id_card'): merges cropped Front + Back onto 1 exact CR80-sized A4 sheet
//  3. Class CR Share Links (shared_doc_id reuse + 24-hour share link creation)
//  4. 100% server-side page count & price calculation + UPI/Cash auto-print queueing

const { createClient } = require('@supabase/supabase-js');
const { PDFDocument, rgb } = require('pdf-lib');

const PAGE_SIZES = {
  A4: { w: 595.28, h: 841.89 },
  A3: { w: 841.89, h: 1190.55 },
};
// Standard CR80 ID Card (Aadhaar / PAN / College ID): 85.6 mm x 54 mm in PDF points (1 mm = 2.83465 pt)
const ID_CARD_W = 242.65;
const ID_CARD_H = 153.07;
const MARGIN = 20;

function monthStartIST() {
  const d = new Date(Date.now() + 5.5 * 3600000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

function parsePageRange(rangeStr, totalPages) {
  const clean = String(rangeStr || '').trim();
  if (!clean) return null;
  const set = new Set();
  for (const rawPart of clean.split(',')) {
    const part = rawPart.trim();
    if (!part) continue;
    const m = part.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) throw new Error(`Galat page range: "${part}". Jaise "1-5, 8" likhein.`);
    const start = parseInt(m[1], 10);
    const end = m[2] ? parseInt(m[2], 10) : start;
    if (start < 1 || end < start || end > totalPages) {
      throw new Error(`Page range "${part}" galat hai (file mein total ${totalPages} pages hain).`);
    }
    for (let p = start; p <= end; p++) set.add(p - 1);
  }
  if (!set.size) throw new Error('Kam se kam 1 page select karein.');
  return Array.from(set).sort((a, b) => a - b);
}

async function convertOfficeToPdf(rawBytes, fileName, ext) {
  const convertToken = (process.env.CONVERTAPI_TOKEN || '').trim();
  const gotenbergUrl = (process.env.GOTENBERG_URL || '').trim().replace(/\/$/, '');

  if (convertToken) {
    const base64Data = Buffer.from(rawBytes).toString('base64');
    const resp = await fetch(`https://v2.convertapi.com/convert/${ext}/to/pdf`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${convertToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        Parameters: [
          { Name: 'File', FileValue: { Name: fileName, Data: base64Data } },
          { Name: 'StoreFile', Value: false },
        ],
      }),
    });
    const out = await resp.json().catch(() => ({}));
    if (!resp.ok || !out.Files || !out.Files[0] || !out.Files[0].FileData) {
      throw new Error(out.Message || 'Word/PPT ko PDF mein convert nahi kar paye.');
    }
    return new Uint8Array(Buffer.from(out.Files[0].FileData, 'base64'));
  }

  if (gotenbergUrl) {
    const form = new FormData();
    form.append('files', new Blob([rawBytes]), fileName);
    const resp = await fetch(`${gotenbergUrl}/forms/libreoffice/convert`, { method: 'POST', body: form });
    if (!resp.ok) throw new Error('Office conversion server error.');
    return new Uint8Array(await resp.arrayBuffer());
  }

  throw new Error('Word/PPT auto-convert ke liye Vercel mein CONVERTAPI_TOKEN add karein (ya file ko PDF mein save karke upload karein).');
}

async function embedAnyImage(pdf, bytes) {
  // Detect PNG signature (89 50 4E 47) vs JPEG
  const isPng = bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47;
  return isPng ? pdf.embedPng(bytes) : pdf.embedJpg(bytes);
}

async function imageToPdf(bytes, paper) {
  const pdf = await PDFDocument.create();
  const img = await embedAnyImage(pdf, bytes);
  const base = PAGE_SIZES[paper] || PAGE_SIZES.A4;
  const isLandscape = img.width > img.height;
  const pageW = isLandscape ? base.h : base.w;
  const pageH = isLandscape ? base.w : base.h;
  const page = pdf.addPage([pageW, pageH]);
  const scale = Math.min((pageW - MARGIN * 2) / img.width, (pageH - MARGIN * 2) / img.height);
  const drawW = img.width * scale;
  const drawH = img.height * scale;
  page.drawImage(img, { x: (pageW - drawW) / 2, y: (pageH - drawH) / 2, width: drawW, height: drawH });
  return pdf;
}

/**
 * Places cropped Front & Back ID card images at exact CR80 dimensions (85.6mm x 54mm)
 * centered on a single A4 page with subtle cut-guide borders.
 */
async function buildIdCardPdf(frontBytes, backBytes) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([PAGE_SIZES.A4.w, PAGE_SIZES.A4.h]);
  const frontImg = await embedAnyImage(pdf, frontBytes);
  const backImg = await embedAnyImage(pdf, backBytes);

  const x = (PAGE_SIZES.A4.w - ID_CARD_W) / 2;
  const gap = 42;
  const topY = PAGE_SIZES.A4.h - 140 - ID_CARD_H;
  const botY = topY - gap - ID_CARD_H;

  // Draw Front Card + crisp light cut border
  page.drawImage(frontImg, { x, y: topY, width: ID_CARD_W, height: ID_CARD_H });
  page.drawRectangle({
    x, y: topY, width: ID_CARD_W, height: ID_CARD_H,
    borderColor: rgb(0.78, 0.82, 0.88), borderWidth: 0.75,
  });

  // Draw Back Card + crisp light cut border
  page.drawImage(backImg, { x, y: botY, width: ID_CARD_W, height: ID_CARD_H });
  page.drawRectangle({
    x, y: botY, width: ID_CARD_W, height: ID_CARD_H,
    borderColor: rgb(0.78, 0.82, 0.88), borderWidth: 0.75,
  });

  return pdf;
}

async function slicePdf(sourcePdf, indices) {
  const sliced = await PDFDocument.create();
  const copied = await sliced.copyPages(sourcePdf, indices);
  copied.forEach(p => sliced.addPage(p));
  return sliced;
}

async function buildNUpPdf(sourcePdf, pps, paper) {
  if (pps !== 2 && pps !== 4) return sourcePdf;
  const outPdf = await PDFDocument.create();
  const embedded = await outPdf.embedPages(sourcePdf.getPages());
  const base = PAGE_SIZES[paper] || PAGE_SIZES.A4;
  const cols = 2, rows = pps === 4 ? 2 : 1;
  const sheetW = pps === 2 ? base.h : base.w;
  const sheetH = pps === 2 ? base.w : base.h;
  const gap = 12;
  const cellW = (sheetW - MARGIN * 2 - gap * (cols - 1)) / cols;
  const cellH = (sheetH - MARGIN * 2 - gap * (rows - 1)) / rows;

  for (let i = 0; i < embedded.length; i += pps) {
    const sheet = outPdf.addPage([sheetW, sheetH]);
    for (let slot = 0; slot < pps && i + slot < embedded.length; slot++) {
      const ep = embedded[i + slot];
      const col = slot % cols, row = Math.floor(slot / cols);
      const scale = Math.min(cellW / ep.width, cellH / ep.height);
      const drawW = ep.width * scale, drawH = ep.height * scale;
      const cellX = MARGIN + col * (cellW + gap);
      const cellY = sheetH - MARGIN - (row + 1) * cellH - row * gap;
      sheet.drawPage(ep, {
        x: cellX + (cellW - drawW) / 2,
        y: cellY + (cellH - drawH) / 2,
        width: drawW, height: drawH,
      });
    }
  }
  return outPdf;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
    const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
    if (!supabaseUrl || !serviceKey) {
      return res.status(500).json({ error: 'Server config missing (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)' });
    }
    if (!supabaseUrl.startsWith('https://')) {
      return res.status(500).json({ error: 'SUPABASE_URL galat hai (https:// se shuru hona chahiye).' });
    }

    const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    const {
      shop_id,
      order_type = 'doc',
      file_path,
      file_name,
      content_type,
      front_path,
      back_path,
      shared_doc_id,
      colour = 'bw',
      paper = 'A4',
      pps = 1,
      double_sided = false,
      copies = 1,
      page_range = '',
      payment_mode = 'cash',
    } = req.body || {};

    if (!shop_id) return res.status(400).json({ error: 'Missing shop_id.' });

    const cleanColour = colour === 'color' ? 'color' : 'bw';
    const cleanPaper = order_type === 'id_card' ? 'A4' : (paper === 'A3' ? 'A3' : 'A4');
    const cleanPps = order_type === 'id_card' ? 1 : ([1, 2, 4].includes(Number(pps)) ? Number(pps) : 1);
    const cleanCopies = Math.max(1, Math.min(50, parseInt(copies, 10) || 1));
    const cleanPayMode = payment_mode === 'upi' ? 'upi' : 'cash';
    const cleanRange = order_type === 'id_card' ? '' : String(page_range || '').trim();

    const { data: shop, error: shopErr } = await sb.from('shops').select('*').eq('id', shop_id).maybeSingle();
    if (shopErr || !shop) return res.status(404).json({ error: 'Dukaan nahi mili.' });

    const now = Date.now();
    const isOpen = shop.status !== 'paused' &&
      ((shop.paid_until && new Date(shop.paid_until).getTime() > now) || new Date(shop.trial_ends_at).getTime() > now);
    if (!isOpen) return res.status(403).json({ error: 'Ye dukaan abhi online orders nahi le rahi.' });

    const [{ data: plan }, { count: monthCount }] = await Promise.all([
      sb.from('plans').select('monthly_limit').eq('key', shop.plan).maybeSingle(),
      sb.from('orders').select('id', { count: 'exact', head: true }).eq('shop_id', shop.id).gte('order_date', monthStartIST()),
    ]);
    if (plan && (monthCount || 0) >= plan.monthly_limit) {
      return res.status(403).json({ error: 'Is dukaan ki mahine ki order limit poori ho gayi hai.' });
    }

    const cleanDouble = order_type === 'id_card' ? false : (Boolean(double_sided) && shop.supports_duplex !== false);

    let finalPath = '';
    let finalFileName = file_name || 'Document.pdf';
    let truePages = 1;
    let shareId = null;

    // ===== BRANCH A: ID CARD (FRONT + BACK ON 1 A4 PAGE) =====
    if (order_type === 'id_card') {
      if (!front_path || !back_path || !front_path.startsWith(`${shop_id}/`) || !back_path.startsWith(`${shop_id}/`)) {
        return res.status(400).json({ error: 'ID Card ki Front aur Back dono photo zaroori hain.' });
      }
      const [fRes, bRes] = await Promise.all([
        sb.storage.from('print-files').download(front_path),
        sb.storage.from('print-files').download(back_path),
      ]);
      if (fRes.error || !fRes.data || bRes.error || !bRes.data) {
        return res.status(400).json({ error: 'ID Card photos download nahi hui. Dobara try karein.' });
      }
      const frontBytes = new Uint8Array(await fRes.data.arrayBuffer());
      const backBytes = new Uint8Array(await bRes.data.arrayBuffer());
      const idPdf = await buildIdCardPdf(frontBytes, backBytes);
      const pdfBytes = await idPdf.save();

      finalPath = `${shop.id}/idcard-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.pdf`;
      finalFileName = 'ID_Card_Front_Back.pdf';
      const { error: upErr } = await sb.storage.from('print-files').upload(finalPath, pdfBytes, {
        contentType: 'application/pdf', upsert: false,
      });
      if (upErr) return res.status(500).json({ error: 'ID Card PDF save nahi ho payi.' });
      await sb.storage.from('print-files').remove([front_path, back_path]);
      truePages = 1;

    // ===== BRANCH B: NORMAL DOCUMENT OR CLASS CR SHARED DOC =====
    } else {
      let srcPath = file_path;
      let isSharedReuse = false;

      if (shared_doc_id) {
        const { data: sd, error: sdErr } = await sb
          .from('shared_docs')
          .select('*')
          .eq('id', shared_doc_id)
          .eq('shop_id', shop.id)
          .gt('expires_at', new Date().toISOString())
          .maybeSingle();
        if (sdErr || !sd) return res.status(404).json({ error: 'Ye shared link expire ho chuka hai. File dobara upload karein.' });
        srcPath = sd.file_path;
        finalFileName = sd.file_name;
        isSharedReuse = true;
      } else {
        if (!srcPath || !file_name || !srcPath.startsWith(`${shop_id}/`)) {
          return res.status(400).json({ error: 'Missing required file details.' });
        }
      }

      const { data: blob, error: dlErr } = await sb.storage.from('print-files').download(srcPath);
      if (dlErr || !blob) return res.status(400).json({ error: 'Uploaded file nahi mili. Dobara try karein.' });

      const rawBytes = new Uint8Array(await blob.arrayBuffer());
      const mime = content_type || blob.type || '';
      const extMatch = String(finalFileName).toLowerCase().match(/\.([a-z0-9]+)$/);
      const ext = extMatch ? extMatch[1] : '';

      let workingPdf;
      let wasConverted = false;

      if (!isSharedReuse && (mime === 'image/jpeg' || mime === 'image/png' || ['jpg', 'jpeg', 'png'].includes(ext))) {
        workingPdf = await imageToPdf(rawBytes, cleanPaper);
        wasConverted = true;
      } else if (!isSharedReuse && ['doc', 'docx', 'ppt', 'pptx'].includes(ext)) {
        const pdfBytes = await convertOfficeToPdf(rawBytes, finalFileName, ext);
        workingPdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
        wasConverted = true;
      } else if (isSharedReuse || mime === 'application/pdf' || ext === 'pdf') {
        try {
          workingPdf = await PDFDocument.load(rawBytes, { ignoreEncryption: true });
        } catch {
          return res.status(422).json({ error: 'Ye PDF password-protected ya corrupted hai. Bina password wali PDF upload karein.' });
        }
      } else {
        return res.status(400).json({ error: 'Sirf PDF, JPG, PNG, Word (.docx) ya PPT (.pptx) files chalengi.' });
      }

      const fullPageCount = workingPdf.getPageCount();
      if (fullPageCount < 1 || fullPageCount > 1000) {
        return res.status(400).json({ error: 'Page count 1 se 1000 ke beech hona chahiye.' });
      }

      // Create a 24-hour Class CR shareable copy of the clean full PDF (only for fresh normal uploads)
      if (!isSharedReuse) {
        try {
          const sharePath = `${shop.id}/shared-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.pdf`;
          const fullBytes = wasConverted ? await workingPdf.save() : rawBytes;
          const upShare = await sb.storage.from('print-files').upload(sharePath, fullBytes, {
            contentType: 'application/pdf', upsert: false,
          });
          if (!upShare.error) {
            const { data: sdRow } = await sb
              .from('shared_docs')
              .insert({ shop_id: shop.id, file_path: sharePath, file_name: finalFileName, pages: fullPageCount })
              .select('id')
              .maybeSingle();
            if (sdRow && sdRow.id) shareId = sdRow.id;
          }
        } catch (e) { /* non-blocking if shared_docs SQL not yet run */ }
      } else {
        shareId = shared_doc_id;
      }

      if (cleanRange) {
        let selectedIndices;
        try { selectedIndices = parsePageRange(cleanRange, fullPageCount); }
        catch (rangeErr) { return res.status(400).json({ error: rangeErr.message }); }
        if (selectedIndices && selectedIndices.length < fullPageCount) {
          workingPdf = await slicePdf(workingPdf, selectedIndices);
          wasConverted = true;
        }
      }

      truePages = workingPdf.getPageCount();
      const needsReupload = wasConverted || cleanPps > 1 || isSharedReuse;
      finalPath = srcPath;

      if (needsReupload) {
        const finalPdf = cleanPps > 1 ? await buildNUpPdf(workingPdf, cleanPps, cleanPaper) : workingPdf;
        const pdfBytes = await finalPdf.save();
        finalPath = `${shop.id}/ready-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pdf`;
        const { error: upErr } = await sb.storage.from('print-files').upload(finalPath, pdfBytes, {
          contentType: 'application/pdf', upsert: false,
        });
        if (upErr) return res.status(500).json({ error: 'Print-ready PDF save nahi ho payi.' });
        if (!isSharedReuse) await sb.storage.from('print-files').remove([srcPath]);
      }
    }

    const sides = Math.ceil(truePages / cleanPps);
    const sheets = cleanDouble ? Math.ceil(sides / 2) : sides;
    const rateKey = `${cleanColour === 'bw' ? 'rate_bw_' : 'rate_color_'}${cleanPaper.toLowerCase()}`;
    const rate = Number(shop[rateKey]) || 0;
    const amount = Number((sheets * rate * cleanCopies).toFixed(2));

    const { data: created, error: ordErr } = await sb.rpc('create_order', {
      p_shop_id: shop.id,
      p_file_name: finalFileName,
      p_file_path: finalPath,
      p_pages: truePages,
      p_colour: cleanColour,
      p_paper: cleanPaper,
      p_pps: cleanPps,
      p_double: cleanDouble,
      p_copies: cleanCopies,
    });
    if (ordErr || !created) return res.status(500).json({ error: ordErr ? ordErr.message : 'Order create nahi hua.' });

    await sb
      .from('orders')
      .update({
        pages: truePages,
        sheets,
        amount,
        page_range: cleanRange,
        verified_by_server: true,
        payment_mode: cleanPayMode,
        payment_status: cleanPayMode === 'upi' ? 'paid' : 'pending',
        auto_print_status: cleanPayMode === 'upi' ? 'queued' : 'waiting_cash',
      })
      .eq('id', created.order_id);

    return res.status(200).json({
      order_id: created.order_id,
      pages: truePages,
      sheets,
      amount,
      payment_mode: cleanPayMode,
      share_id: shareId,
    });
  } catch (err) {
    console.error('prepare-order error:', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
};
