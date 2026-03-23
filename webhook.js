const express = require('express');
const router = express.Router();
const axios = require('axios');
const FormData = require('form-data');
const db = require('./db');
const { responderMensaje, analizarFactura, generarComparativa, analizarFacturaGas, generarComparativaGas } = require('./claude');

// ─── CHATWOOT HELPERS ────────────────────────────────────
async function getChatwootContactId(phone, nombre) {
  try {
    const searchRes = await axios.get(
      `${process.env.CHATWOOT_URL}/api/v1/accounts/1/contacts/search?q=${phone}`,
      { headers: { api_access_token: process.env.CHATWOOT_API_TOKEN } }
    );
    const contacts = searchRes.data?.payload?.contacts || searchRes.data?.payload || [];
    if (contacts.length > 0) return contacts[0].id;

    const createRes = await axios.post(
      `${process.env.CHATWOOT_URL}/api/v1/accounts/1/contacts`,
      { name: nombre || phone, phone_number: `+${phone}` },
      { headers: { api_access_token: process.env.CHATWOOT_API_TOKEN } }
    );
    return createRes.data?.id || createRes.data?.payload?.id;
  } catch (e) {
    console.error('Chatwoot contact error:', e.message);
    return null;
  }
}

async function getChatwootConversationId(contactId) {
  try {
    const inboxId = process.env.CHATWOOT_INBOX_ID || '2';
    const convsRes = await axios.get(
      `${process.env.CHATWOOT_URL}/api/v1/accounts/1/contacts/${contactId}/conversations`,
      { headers: { api_access_token: process.env.CHATWOOT_API_TOKEN } }
    );
    const convs = convsRes.data?.payload || [];
    const open = convs.find(c => c.status === 'open' && String(c.inbox_id) === String(inboxId));
    if (open) return open.id;

    const createRes = await axios.post(
      `${process.env.CHATWOOT_URL}/api/v1/accounts/1/conversations`,
      { inbox_id: parseInt(inboxId), contact_id: contactId },
      { headers: { api_access_token: process.env.CHATWOOT_API_TOKEN } }
    );
    return createRes.data?.id || createRes.data?.payload?.id;
  } catch (e) {
    console.error('Chatwoot conversation error:', e.message);
    return null;
  }
}

async function enviarMensajeChatwoot(conversationId, mensaje, esBot = false) {
  try {
    const payload = esBot
      ? { content: `🤖 ${mensaje}`, message_type: 'outgoing', private: true }
      : { content: mensaje, message_type: 'incoming' };

    await axios.post(
      `${process.env.CHATWOOT_URL}/api/v1/accounts/1/conversations/${conversationId}/messages`,
      payload,
      { headers: { api_access_token: process.env.CHATWOOT_API_TOKEN } }
    );
  } catch (e) {
    console.error('Chatwoot message error:', e.message, e.response?.data);
  }
}

async function enviarArchivoChatwoot(conversationId, fileBuffer, fileName, mimeType) {
  try {
    const form = new FormData();
    form.append('attachments[]', fileBuffer, { filename: fileName, contentType: mimeType });
    form.append('message_type', 'incoming');
    form.append('content', '');

    await axios.post(
      `${process.env.CHATWOOT_URL}/api/v1/accounts/1/conversations/${conversationId}/messages`,
      form,
      { headers: { ...form.getHeaders(), api_access_token: process.env.CHATWOOT_API_TOKEN } }
    );
  } catch (e) {
    console.error('Chatwoot file error:', e.message, e.response?.data);
  }
}

// ─── MANYCHAT ───────────────────────────────────────────
router.post('/manychat', async (req, res) => {
  try {
    const { subscriber_id, nombre, telefono, mensaje, tipo, archivo_url } = req.body;
    if (!subscriber_id) return res.status(400).json({ error: 'subscriber_id requerido' });

    const usuario = await db.getOrCreateUsuario(subscriber_id, { nombre, telefono });
    const historial = await db.getHistorial(usuario.id);
    let respuesta = '';
    let metadata = {};

    if (tipo === 'imagen' || tipo === 'archivo') {
      await db.guardarMensaje(usuario.id, 'user', '[Factura enviada]', { archivo_url });
      const imageResponse = await axios.get(archivo_url, { responseType: 'arraybuffer' });
      const base64 = Buffer.from(imageResponse.data).toString('base64');
      const mediaType = tipo === 'imagen' ? 'image/jpeg' : 'application/pdf';
      const datosFactura = await analizarFactura(base64, mediaType);

      if (datosFactura) {
        const esGas = datosFactura.tipo_suministro === 'gas';
        const factura = await db.guardarFactura(usuario.id, {
          compania: datosFactura.compania, consumo_kwh: datosFactura.consumo_kwh,
          potencia_kw: datosFactura.potencia_kw || null, precio_kwh: datosFactura.precio_kwh,
          precio_potencia: datosFactura.precio_potencia || null, precio_total: datosFactura.precio_total,
          dias_facturacion: datosFactura.dias_facturacion, fecha_factura: datosFactura.fecha_factura,
          raw_texto_ocr: JSON.stringify(datosFactura)
        });
        const { data: tarifas } = await db.supabase.from('tarifas').select('*')
          .eq('activa', true).eq('tipo_suministro', esGas ? 'gas' : 'luz').is('fecha_vigencia_hasta', null);

        if (tarifas && tarifas.length > 0) {
          const comparativa = esGas ? await generarComparativaGas(datosFactura, tarifas) : await generarComparativa(datosFactura, tarifas);
          respuesta = comparativa.mensaje;
          if (comparativa.ahorro > 0 && comparativa.tarifa) {
            const oferta = await db.crearOferta(usuario.id, factura.id, comparativa.tarifa.id, comparativa.ahorro, null);
            await db.programarRemarketing(usuario.id, oferta.id, 3, 'seguimiento_oferta');
            metadata = { factura_id: factura.id, oferta_id: oferta.id };
          }
        } else {
          respuesta = '✅ He analizado tu factura. Estoy preparando la comparativa.';
        }
      } else {
        respuesta = '❌ No he podido leer la factura. ¿Puedes enviarla más clara o en PDF?';
      }
    } else {
      await db.guardarMensaje(usuario.id, 'user', mensaje);
      respuesta = await responderMensaje(historial, mensaje);
    }

    await db.guardarMensaje(usuario.id, 'assistant', respuesta, metadata);
    res.json({ version: 'v2', content: { messages: [], actions: [{ action: 'set_field_value', field_name: 'lumux_respuesta', value: respuesta }] } });

  } catch (error) {
    console.error('Error en webhook manychat:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ─── CHATWOOT → WHATSAPP ─────────────────────────────────
// Este endpoint recibe los mensajes que el AGENTE escribe en Chatwoot
// y los reenvía al cliente por WhatsApp.
// Configurar en Chatwoot: Settings → Integrations → Webhooks → URL: https://tuservidor.com/webhook/chatwoot
router.post('/chatwoot', async (req, res) => {
  try {
    // Respondemos 200 inmediatamente para que Chatwoot no reintente
    res.status(200).send('OK');

    const { event, message_type, content, conversation } = req.body;

    // FIX: req.body.private puede venir como boolean o string "true"
    const isPrivate = req.body.private === true || req.body.private === 'true';

    console.log('[Chatwoot webhook]', { event, message_type, isPrivate, content: content?.slice(0, 80) });

    // Solo procesamos mensajes nuevos, salientes, no privados y con contenido
    if (event !== 'message_created') return;
    if (message_type !== 'outgoing') return;
    if (isPrivate) return;  // Las notas privadas del bot se ignoran
    if (!content || !content.trim()) return;

    // FIX: limpiar el número correctamente (puede venir como +34612..., 34612..., etc.)
    const phoneRaw = conversation?.meta?.sender?.phone_number;
    if (!phoneRaw) {
      console.log('[Chatwoot webhook] No se encontró phone_number en conversation.meta.sender');
      return;
    }

    // Eliminar +, espacios, guiones — dejamos solo dígitos
    const phone = phoneRaw.replace(/[\s+\-()]/g, '');
    console.log(`[Chatwoot webhook] Reenviando a WhatsApp ${phone}: ${content.slice(0, 80)}`);

    await enviarMensajeWhatsApp(phone, content);
    console.log(`[Chatwoot webhook] ✅ Mensaje enviado a ${phone}`);

    // Guardar en la DB: buscar el usuario por teléfono y guardar el mensaje del agente
    try {
      const { data: usuarios } = await db.supabase
        .from('usuarios')
        .select('id')
        .eq('telefono', phone)
        .limit(1);

      if (usuarios && usuarios.length > 0) {
        await db.guardarMensaje(usuarios[0].id, 'assistant', content, { fuente: 'agente_chatwoot' });
      }
    } catch (dbErr) {
      // No bloqueamos el flujo si falla el log en DB
      console.error('[Chatwoot webhook] Error guardando en DB:', dbErr.message);
    }

  } catch (error) {
    console.error('Error en webhook Chatwoot:', error);
  }
});

// ─── WHATSAPP VERIFICACIÓN ───────────────────────────────
router.get('/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.status(403).send('Forbidden');
  }
});

// ─── WHATSAPP → BOT ─────────────────────────────────────
router.post('/whatsapp', async (req, res) => {
  try {
    res.status(200).send('OK');

    const entry = req.body.entry?.[0];
    const value = entry?.changes?.[0]?.value;
    const messages = value?.messages;
    if (!messages || messages.length === 0) return;

    const msg = messages[0];
    const from = msg.from; // Número del cliente, ej: "34612345678"

    // FIX: WHATSAPP_PHONE_ID es el ID numérico del número de negocio (ej: "123456789012345"),
    // NO es el número de teléfono. Para filtrar mensajes enviados por nosotros mismos
    // usamos el campo "display_phone_number" del metadata, que sí es el número real.
    const ourPhoneNumber = value?.metadata?.display_phone_number?.replace(/[\s+\-()]/g, '');
    if (ourPhoneNumber && from === ourPhoneNumber) {
      console.log('[WhatsApp] Mensaje propio ignorado');
      return;
    }

    const nombre = value?.contacts?.[0]?.profile?.name || '';
    let tipo = 'texto', mensajeTexto = '', archivoUrl = null, mediaType = null, fileName = null;

    if (msg.type === 'text') {
      mensajeTexto = msg.text.body;
    } else if (msg.type === 'image') {
      tipo = 'imagen';
      archivoUrl = await getMediaUrl(msg.image.id);
      mediaType = msg.image.mime_type || 'image/jpeg';
      fileName = `factura_${Date.now()}.jpg`;
    } else if (msg.type === 'document') {
      tipo = 'archivo';
      archivoUrl = await getMediaUrl(msg.document.id);
      mediaType = msg.document.mime_type || 'application/pdf';
      fileName = msg.document.filename || `factura_${Date.now()}.pdf`;
    } else {
      console.log(`[WhatsApp] Tipo de mensaje no soportado: ${msg.type}`);
      return;
    }

    const usuario = await db.getOrCreateUsuario(from, { nombre, telefono: from, canal: 'whatsapp' });
    const historial = await db.getHistorial(usuario.id);
    let respuesta = '', metadata = {};

    // ── Chatwoot: crear/obtener contacto y conversación ──
    let chatwootConvId = null;
    if (process.env.CHATWOOT_URL && process.env.CHATWOOT_API_TOKEN) {
      const contactId = await getChatwootContactId(from, nombre);
      if (contactId) {
        chatwootConvId = await getChatwootConversationId(contactId);
      }
    }

    if (tipo === 'imagen' || tipo === 'archivo') {
      await db.guardarMensaje(usuario.id, 'user', '[Factura enviada]', { archivoUrl });
      await enviarMensajeWhatsApp(from, '⏳ Estoy analizando tu factura, dame un momento...');

      const imageResponse = await axios.get(archivoUrl, {
        responseType: 'arraybuffer',
        headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }
      });
      const fileBuffer = Buffer.from(imageResponse.data);
      const base64 = fileBuffer.toString('base64');

      if (chatwootConvId) {
        await enviarArchivoChatwoot(chatwootConvId, fileBuffer, fileName, mediaType);
      }

      const datosFactura = await analizarFactura(base64, mediaType);

      if (datosFactura) {
        const esGas = datosFactura.tipo_suministro === 'gas';
        const factura = await db.guardarFactura(usuario.id, {
          compania: datosFactura.compania, consumo_kwh: datosFactura.consumo_kwh,
          potencia_kw: datosFactura.potencia_kw || null, precio_kwh: datosFactura.precio_kwh,
          precio_potencia: datosFactura.precio_potencia || null, precio_total: datosFactura.precio_total,
          dias_facturacion: datosFactura.dias_facturacion, fecha_factura: datosFactura.fecha_factura,
          raw_texto_ocr: JSON.stringify(datosFactura)
        });
        const { data: tarifas } = await db.supabase.from('tarifas').select('*')
          .eq('activa', true).eq('tipo_suministro', esGas ? 'gas' : 'luz').is('fecha_vigencia_hasta', null);

        if (tarifas && tarifas.length > 0) {
          const comparativa = esGas ? await generarComparativaGas(datosFactura, tarifas) : await generarComparativa(datosFactura, tarifas);
          respuesta = comparativa.mensaje;
          if (comparativa.ahorro > 0 && comparativa.tarifa) {
            const oferta = await db.crearOferta(usuario.id, factura.id, comparativa.tarifa.id, comparativa.ahorro, null);
            await db.programarRemarketing(usuario.id, oferta.id, 3, 'seguimiento_oferta');
            metadata = { factura_id: factura.id, oferta_id: oferta.id };
          }
        } else {
          respuesta = '✅ He analizado tu factura. Estoy preparando la comparativa.';
        }
      } else {
        respuesta = '❌ No he podido leer la factura. ¿Puedes enviarla más clara o en PDF?';
      }
    } else {
      await db.guardarMensaje(usuario.id, 'user', mensajeTexto);

      // Mostrar mensaje del cliente en Chatwoot
      if (chatwootConvId) {
        await enviarMensajeChatwoot(chatwootConvId, mensajeTexto, false);
      }

      respuesta = await responderMensaje(historial, mensajeTexto);
    }

    await db.guardarMensaje(usuario.id, 'assistant', respuesta, metadata);
    await enviarMensajeWhatsApp(from, respuesta);

    // Registrar respuesta del bot como nota privada en Chatwoot (para visibilidad interna)
    if (chatwootConvId) {
      await enviarMensajeChatwoot(chatwootConvId, respuesta, true);
    }

  } catch (error) {
    console.error('Error en webhook WhatsApp:', error);
  }
});

// ─── HELPERS ─────────────────────────────────────────────
async function getMediaUrl(mediaId) {
  const r = await axios.get(`https://graph.facebook.com/v22.0/${mediaId}`,
    { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } });
  return r.data.url;
}

async function enviarMensajeWhatsApp(to, mensaje) {
  await axios.post(
    `https://graph.facebook.com/v22.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
    { messaging_product: 'whatsapp', to, type: 'text', text: { body: mensaje } },
    { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

module.exports = router;