const express = require('express');
const router = express.Router();
const axios = require('axios');
const FormData = require('form-data');
const db = require('./db');
const {
  responderMensaje, analizarFactura, generarComparativa, generarUrlInforme,
  analizarFacturaGas, generarComparativaGas
} = require('./claude');

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
  } catch (e) { console.error('Chatwoot contact error:', e.message); return null; }
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
  } catch (e) { console.error('Chatwoot conv error:', e.message); return null; }
}

async function enviarMensajeChatwoot(conversationId, mensaje, esBot = false) {
  try {
    const payload = esBot
      ? { content: `🤖 ${mensaje}`, message_type: 'outgoing', private: true }
      : { content: mensaje, message_type: 'incoming' };
    await axios.post(
      `${process.env.CHATWOOT_URL}/api/v1/accounts/1/conversations/${conversationId}/messages`,
      payload, { headers: { api_access_token: process.env.CHATWOOT_API_TOKEN } }
    );
  } catch (e) { console.error('Chatwoot msg error:', e.message); }
}

async function enviarArchivoChatwoot(conversationId, fileBuffer, fileName, mimeType) {
  try {
    const form = new FormData();
    form.append('attachments[]', fileBuffer, { filename: fileName, contentType: mimeType });
    form.append('message_type', 'incoming');
    form.append('content', '');
    await axios.post(
      `${process.env.CHATWOOT_URL}/api/v1/accounts/1/conversations/${conversationId}/messages`,
      form, { headers: { ...form.getHeaders(), api_access_token: process.env.CHATWOOT_API_TOKEN } }
    );
  } catch (e) { console.error('Chatwoot file error:', e.message); }
}

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

// ─── PLANTILLA CON BOTÓN ──────────────────────────────────────────────────────
async function enviarPlantillaInforme(telefono, nombre, companiaActual, nuevaCompania, ahorro, pctAhorro, shortId) {
  await axios.post(
    `https://graph.facebook.com/v22.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to: telefono,
      type: 'template',
      template: {
        name: 'informe_ahorro_lumux',
        language: { code: 'es' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: nombre || 'cliente' },
              { type: 'text', text: companiaActual || 'tu compañía' },
              { type: 'text', text: nuevaCompania },
              { type: 'text', text: String(Math.round(ahorro)) },
              { type: 'text', text: String(pctAhorro) },
            ]
          },
          {
            type: 'button',
            sub_type: 'url',
            index: '0',
            parameters: [{ type: 'text', text: shortId }]
          }
        ]
      }
    },
    { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
  );
  console.log(`[WA Template] Enviado a ${telefono} shortId=${shortId}`);
}

// ─── PROCESAR FACTURA ─────────────────────────────────────────────────────────
async function procesarFactura(base64, mediaType, usuario, telefono) {
  const datosFactura = await analizarFactura(base64, mediaType);
  if (!datosFactura) {
    return { respuesta: '❌ No he podido leer la factura. ¿Puedes enviarla más clara o en PDF?', metadata: {} };
  }

  const esGas = datosFactura.tipo_suministro === 'gas';

  const factura = await db.guardarFactura(usuario.id, {
    compania:         datosFactura.compania,
    consumo_kwh:      datosFactura.consumo_kwh,
    potencia_kw:      datosFactura.potencia_kw || null,
    precio_kwh:       datosFactura.precio_kwh,
    precio_potencia:  datosFactura.precio_potencia_dia || null,
    precio_total:     datosFactura.precio_total,
    dias_facturacion: datosFactura.dias_facturacion,
    fecha_factura:    datosFactura.fecha_factura,
    raw_texto_ocr:    JSON.stringify(datosFactura)
  });

  const { data: tarifas } = await db.supabase
    .from('tarifas').select('*')
    .eq('activa', true)
    .eq('tipo_suministro', esGas ? 'gas' : 'luz')
    .is('fecha_vigencia_hasta', null)
    .order('orden_comision', { ascending: true });

  if (!tarifas || tarifas.length === 0) {
    return { respuesta: '✅ He analizado tu factura. Estoy preparando la comparativa.', metadata: {} };
  }

  const comparativa = esGas
    ? await generarComparativaGas(datosFactura, tarifas)
    : await generarComparativa(datosFactura, tarifas);

  let respuesta = comparativa.mensaje;
  let metadata = {};

  if (comparativa.ahorro > 0 && comparativa.tarifa) {
    const d = comparativa.datosComparativa;

    // 1. Guardar informe con short_id
    const informeGuardado = await db.guardarInforme({
      usuario_id:        usuario.id,
      factura_id:        factura.id,
      nombre:            usuario.nombre,
      telefono:          telefono,
      compania_actual:   datosFactura.compania,
      consumo_kwh:       datosFactura.consumo_kwh,
      consumo_p1_kwh:    datosFactura.consumo_p1_kwh,
      consumo_p2_kwh:    datosFactura.consumo_p2_kwh,
      consumo_p3_kwh:    datosFactura.consumo_p3_kwh,
      potencia_kw:       datosFactura.potencia_kw,
      precio_actual_mes: d.precio_actual_mes,
      dias_facturacion:  datosFactura.dias_facturacion,
      nueva_compania:    comparativa.tarifa.compania,
      nueva_tarifa:      comparativa.tarifa.nombre_tarifa,
      precio_nuevo_mes:  d.precio_nuevo_mes,
      ahorro_anual:      comparativa.ahorro,
      pct_ahorro:        d.pct_ahorro,
      precio_kwh_p1:     comparativa.tarifa.precio_kwh_p1,
      precio_kwh_p2:     comparativa.tarifa.precio_kwh_p2,
      precio_kwh_p3:     comparativa.tarifa.precio_kwh_p3,
      precio_pot_p1:     comparativa.tarifa.precio_kw_p1,
      precio_pot_p2:     comparativa.tarifa.precio_kw_p2,
      precio_fijo_mes:   comparativa.tarifa.precio_fijo_mes,
    });

    // 2. URL corta
    const urlCorta = `${process.env.WEB_URL || 'https://lumux.es'}/informe.html?id=${informeGuardado.short_id}`;

    // 3. Crear oferta
    const oferta = await db.crearOferta(usuario.id, factura.id, comparativa.tarifa.id, comparativa.ahorro, urlCorta);
    await db.supabase.from('informes').update({ oferta_id: oferta.id }).eq('id', informeGuardado.id);
    await db.programarRemarketing(usuario.id, oferta.id, 3, 'seguimiento_oferta');

    // 4. Enviar plantilla con botón
    try {
      await enviarPlantillaInforme(
        telefono,
        usuario.nombre,
        datosFactura.compania,
        comparativa.tarifa.compania,
        comparativa.ahorro,
        d.pct_ahorro,
        informeGuardado.short_id
      );
      respuesta = null; // plantilla enviada, no enviar texto adicional
    } catch (e) {
      // Fallback: si falla la plantilla, enviar texto con URL corta
      console.error('[procesarFactura] Fallback a texto:', e.message);
      respuesta += `\n${urlCorta}`;
    }

    metadata = { factura_id: factura.id, oferta_id: oferta.id, short_id: informeGuardado.short_id, url_informe: urlCorta };
  }

  return { respuesta, metadata };
}

// ─── MANYCHAT ─────────────────────────────────────────────────────────────────
router.post('/manychat', async (req, res) => {
  try {
    const { subscriber_id, nombre, telefono, mensaje, tipo, archivo_url } = req.body;
    if (!subscriber_id) return res.status(400).json({ error: 'subscriber_id requerido' });
    const usuario = await db.getOrCreateUsuario(subscriber_id, { nombre, telefono });
    const historial = await db.getHistorial(usuario.id);
    let respuesta = '', metadata = {};

    if (tipo === 'imagen' || tipo === 'archivo') {
      await db.guardarMensaje(usuario.id, 'user', '[Factura enviada]', { archivo_url });
      const imageResponse = await axios.get(archivo_url, { responseType: 'arraybuffer' });
      const base64 = Buffer.from(imageResponse.data).toString('base64');
      const mediaType = tipo === 'imagen' ? 'image/jpeg' : 'application/pdf';
      const resultado = await procesarFactura(base64, mediaType, usuario, telefono);
      respuesta = resultado.respuesta || '✅ Tu informe está listo. Revisa el botón que te hemos enviado.';
      metadata = resultado.metadata;
    } else {
      await db.guardarMensaje(usuario.id, 'user', mensaje);
      respuesta = await responderMensaje(historial, mensaje);
    }
    await db.guardarMensaje(usuario.id, 'assistant', respuesta, metadata);
    res.json({ version: 'v2', content: { messages: [], actions: [{ action: 'set_field_value', field_name: 'lumux_respuesta', value: respuesta }] } });
  } catch (error) {
    console.error('Error manychat:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ─── CHATWOOT → WHATSAPP ──────────────────────────────────────────────────────
router.post('/chatwoot', async (req, res) => {
  try {
    res.status(200).send('OK');
    const { event, message_type, content, conversation } = req.body;
    const isPrivate = req.body.private === true || req.body.private === 'true';
    if (event !== 'message_created' || message_type !== 'outgoing' || isPrivate || !content?.trim()) return;
    const phoneRaw = conversation?.meta?.sender?.phone_number;
    if (!phoneRaw) return;
    const phone = phoneRaw.replace(/[\s+\-()]/g, '');
    await enviarMensajeWhatsApp(phone, content);
    try {
      const { data: usuarios } = await db.supabase.from('usuarios').select('id').eq('telefono', phone).limit(1);
      if (usuarios?.length > 0) await db.guardarMensaje(usuarios[0].id, 'assistant', content, { fuente: 'agente_chatwoot' });
    } catch (e) { console.error('Chatwoot DB:', e.message); }
  } catch (error) { console.error('Error chatwoot:', error); }
});

// ─── WHATSAPP VERIFICACIÓN ────────────────────────────────────────────────────
router.get('/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) res.status(200).send(challenge);
  else res.status(403).send('Forbidden');
});

// ─── WHATSAPP → BOT ───────────────────────────────────────────────────────────
router.post('/whatsapp', async (req, res) => {
  try {
    res.status(200).send('OK');
    const entry = req.body.entry?.[0];
    const value = entry?.changes?.[0]?.value;
    const messages = value?.messages;
    if (!messages?.length) return;

    const msg = messages[0];
    const from = msg.from;
    const nombre = value?.contacts?.[0]?.profile?.name || '';
    const ourPhone = value?.metadata?.display_phone_number?.replace(/[\s+\-()]/g, '');
    if (ourPhone && from === ourPhone) return;

    let tipo = 'texto', mensajeTexto = '', archivoUrl = null, mediaType = null, fileName = null;
    if (msg.type === 'text') { mensajeTexto = msg.text.body; }
    else if (msg.type === 'image') { tipo = 'imagen'; archivoUrl = await getMediaUrl(msg.image.id); mediaType = msg.image.mime_type || 'image/jpeg'; fileName = `factura_${Date.now()}.jpg`; }
    else if (msg.type === 'document') { tipo = 'archivo'; archivoUrl = await getMediaUrl(msg.document.id); mediaType = msg.document.mime_type || 'application/pdf'; fileName = msg.document.filename || `factura_${Date.now()}.pdf`; }
    else return;

    const usuario = await db.getOrCreateUsuario(from, { nombre, telefono: from, canal: 'whatsapp' });
    const historial = await db.getHistorial(usuario.id);
    let respuesta = '', metadata = {};

    let chatwootConvId = null;
    if (process.env.CHATWOOT_URL && process.env.CHATWOOT_API_TOKEN) {
      const contactId = await getChatwootContactId(from, nombre);
      if (contactId) chatwootConvId = await getChatwootConversationId(contactId);
    }

    if (tipo === 'imagen' || tipo === 'archivo') {
      await db.guardarMensaje(usuario.id, 'user', '[Factura enviada]', { archivoUrl });
      await enviarMensajeWhatsApp(from, '⏳ Estoy analizando tu factura, dame un momento...');
      const imageResponse = await axios.get(archivoUrl, { responseType: 'arraybuffer', headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } });
      const fileBuffer = Buffer.from(imageResponse.data);
      if (chatwootConvId) await enviarArchivoChatwoot(chatwootConvId, fileBuffer, fileName, mediaType);
      const resultado = await procesarFactura(fileBuffer.toString('base64'), mediaType, usuario, from);
      respuesta = resultado.respuesta;
      metadata = resultado.metadata;
    } else {
      await db.guardarMensaje(usuario.id, 'user', mensajeTexto);
      if (chatwootConvId) await enviarMensajeChatwoot(chatwootConvId, mensajeTexto, false);
      respuesta = await responderMensaje(historial, mensajeTexto);
    }

    // Solo enviar texto si no se usó la plantilla (respuesta === null = plantilla enviada)
    if (respuesta) {
      await db.guardarMensaje(usuario.id, 'assistant', respuesta, metadata);
      await enviarMensajeWhatsApp(from, respuesta);
      if (chatwootConvId) await enviarMensajeChatwoot(chatwootConvId, respuesta, true);
    } else {
      const nota = `📊 Informe enviado con botón | ID: ${metadata.short_id} | URL: ${metadata.url_informe}`;
      await db.guardarMensaje(usuario.id, 'assistant', nota, metadata);
      if (chatwootConvId) await enviarMensajeChatwoot(chatwootConvId, nota, true);
    }

  } catch (error) { console.error('Error WA:', error); }
});

module.exports = router;
