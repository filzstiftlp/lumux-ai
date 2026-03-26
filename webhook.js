const express = require('express');
const router = express.Router();
const axios = require('axios');
const FormData = require('form-data');
// Email via Resend API
const db = require('./db');
const {
  responderMensaje, analizarFactura, generarComparativa, generarUrlInforme,
  generarResumenHistorial, analizarFacturaGas, generarComparativaGas
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

// Cache del inbox ID para no consultarlo en cada mensaje
let _chatwootInboxId = null;

async function getWhatsAppInboxId() {
  if (_chatwootInboxId) return _chatwootInboxId;
  // Si está en variable de entorno, usar esa directamente
  if (process.env.CHATWOOT_INBOX_ID) {
    _chatwootInboxId = process.env.CHATWOOT_INBOX_ID;
    return _chatwootInboxId;
  }
  // Auto-detectar: buscar el inbox de tipo whatsapp o api
  try {
    const res = await axios.get(
      `${process.env.CHATWOOT_URL}/api/v1/accounts/1/inboxes`,
      { headers: { api_access_token: process.env.CHATWOOT_API_TOKEN } }
    );
    const inboxes = res.data?.payload || [];
    console.log('[Chatwoot] Inboxes disponibles:', inboxes.map(i => `${i.id}:${i.channel_type}:${i.name}`));
    // Buscar primero whatsapp, luego api, luego el primero que haya
    const wa = inboxes.find(i => i.channel_type === 'Channel::Whatsapp' || i.name?.toLowerCase().includes('whatsapp'));
    const api = inboxes.find(i => i.channel_type === 'Channel::Api');
    const inbox = wa || api || inboxes[0];
    if (inbox) {
      _chatwootInboxId = String(inbox.id);
      console.log(`[Chatwoot] Inbox detectado: ${_chatwootInboxId} (${inbox.name})`);
      return _chatwootInboxId;
    }
  } catch (e) {
    console.error('[Chatwoot] Error detectando inbox:', e.message);
  }
  return '1'; // último fallback
}

async function getChatwootConversationId(contactId) {
  try {
    const inboxId = await getWhatsAppInboxId();
    const convsRes = await axios.get(
      `${process.env.CHATWOOT_URL}/api/v1/accounts/1/contacts/${contactId}/conversations`,
      { headers: { api_access_token: process.env.CHATWOOT_API_TOKEN } }
    );
    const convs = convsRes.data?.payload || [];
    // Buscar conversación abierta en el inbox correcto
    const open = convs.find(c => c.status === 'open' && String(c.inbox_id) === String(inboxId));
    if (open) return open.id;
    // Si no hay abierta, crear nueva
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
async function procesarFactura(base64, mediaType, usuario, telefono, facturaStorageUrl = null) {
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
    archivo_url:      facturaStorageUrl,
    raw_texto_ocr:    JSON.stringify(datosFactura)
  });

  // Guard: si la factura no se guardó, no continuar
  if (!factura) {
    console.error('[procesarFactura] guardarFactura devolvió null');
    return { respuesta: '❌ Error guardando la factura. Inténtalo de nuevo.', metadata: {} };
  }

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

  // Guardar siempre el resumen en historial (con o sin ahorro)
  if (!esGas) {
    const resumen = generarResumenHistorial(datosFactura, comparativa);
    await db.guardarMensaje(usuario.id, 'assistant', resumen, { tipo: 'resumen_analisis', factura_id: factura.id });
  }

  let respuesta = comparativa.mensaje;
  let metadata = {};

  if (comparativa.ahorro > 0 && comparativa.tarifa) {
    const d = comparativa.datosComparativa;

    // 1. Guardar informe con short_id
    // Guardar URL de factura en Storage si existe
    let facturaStorageUrl2 = null;
    try {
      if (typeof facturaStorageUrl !== 'undefined' && facturaStorageUrl) {
        facturaStorageUrl2 = facturaStorageUrl;
      }
    } catch(e) {}

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

      // ─── Subir factura a Supabase Storage ────────────────────────────────
      let facturaStorageUrl = null;
      try {
        const storageFileName = `facturas/${usuario.id}_${Date.now()}_${fileName}`;
        const { error: storageError } = await db.supabase.storage
          .from('facturas')
          .upload(storageFileName, fileBuffer, { contentType: mediaType, upsert: false });
        if (!storageError) {
          const { data: urlData } = db.supabase.storage.from('facturas').getPublicUrl(storageFileName);
          facturaStorageUrl = urlData?.publicUrl || null;
          console.log('[Storage] Factura guardada:', facturaStorageUrl);
        } else {
          console.error('[Storage] Error subiendo factura:', storageError.message);
        }
      } catch(se) { console.error('[Storage] Exception:', se.message); }

      const resultado = await procesarFactura(fileBuffer.toString('base64'), mediaType, usuario, from, facturaStorageUrl);
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

// ─── HELPER: email por compañía ──────────────────────────────────────────────
function getEmailProveedor(compania) {
  const mapa = {
    'iberdrola':  process.env.EMAIL_IBERDROLA,
    'endesa':     process.env.EMAIL_ENDESA,
    'repsol':     process.env.EMAIL_REPSOL,
    'naturgy':    process.env.EMAIL_NATURGY,
    'octopus':    process.env.EMAIL_OCTOPUS,
    'gana':       process.env.EMAIL_GANA,
    'aenergetic': process.env.EMAIL_AENERGETIC,
  };
  const clave = (compania || '').toLowerCase();
  for (const [k, v] of Object.entries(mapa)) {
    if (clave.includes(k) && v) return v;
  }
  return process.env.EMAIL_SOPORTE || process.env.SMTP_USER;
}

// ─── /webhook/contrato ────────────────────────────────────────────────────────
router.post('/contrato', async (req, res) => {
  try {
    const {
      short_id, nombre, nueva_compania, nueva_tarifa, ahorro_anual,
      email, iban,
      dni_frontal_base64, dni_frontal_tipo, dni_frontal_nombre,
      dni_trasero_base64, dni_trasero_tipo, dni_trasero_nombre,
    } = req.body;

    if (!email || !iban || !dni_frontal_base64 || !dni_trasero_base64) {
      return res.status(400).json({ ok: false, error: 'Faltan datos obligatorios' });
    }

    // ─── 1. Obtener informe completo + factura + propiedad ────────────────
    let informeData = null;
    let facturaData = null;
    let propiedadData = null;
    let facturaBuffer = null;
    let facturaFileName = 'factura_cliente.pdf';

    if (short_id) {
      const { data: informe } = await db.supabase
        .from('informes')
        .select(`
          *,
          facturas (
            id, archivo_url, compania, consumo_kwh, potencia_kw,
            precio_kwh, precio_potencia, precio_total, dias_facturacion, fecha_factura
          ),
          ofertas ( id, estado )
        `)
        .eq('short_id', short_id)
        .single();
      informeData = informe;
      facturaData = informe?.facturas;

      // Buscar CUPS y dirección en propiedades
      if (informe?.usuario_id) {
        const { data: prop } = await db.supabase
          .from('propiedades')
          .select('cups, direccion, codigo_postal, ciudad, provincia')
          .eq('usuario_id', informe.usuario_id)
          .order('created_at', { ascending: false })
          .limit(1)
          .single();
        propiedadData = prop;
      }

      // ─── DESCARGAR FACTURA ORIGINAL para adjuntar ─────────────────────
      const facturaUrl = facturaData?.archivo_url;
      if (facturaUrl) {
        try {
          const ext = facturaUrl.match(/\.(pdf|jpg|jpeg|png)(\?|$)/i)?.[1] || 'jpg';
          facturaFileName = `factura_${nombre || 'cliente'}.${ext}`;
          const r = await axios.get(facturaUrl, { responseType: 'arraybuffer' });
          facturaBuffer = Buffer.from(r.data);
          console.log(`[Contrato] Factura descargada: ${facturaBuffer.length} bytes (${ext})`);
        } catch(e) {
          console.error('[Contrato] No se pudo descargar factura:', e.message);
        }
      } else {
        console.warn('[Contrato] No hay archivo_url en la factura — revisar si se subió a Storage');
      }
    }

    // ─── 2. Guardar titular + marcar oferta firmada ───────────────────────
    if (informeData?.usuario_id) {
      await db.supabase.from('titulares').upsert({
        usuario_id:      informeData.usuario_id,
        nombre:          nombre || informeData.nombre,
        email,
        cuenta_bancaria: iban.replace(/\s/g, '').toUpperCase(),
        updated_at:      new Date().toISOString(),
      }, { onConflict: 'usuario_id' });

      const ofertaId = informeData.oferta_id || informeData.ofertas?.id;
      if (ofertaId) {
        await db.supabase.from('ofertas')
          .update({ estado: 'firmada', fecha_firmado: new Date().toISOString() })
          .eq('id', ofertaId);
      }
      await db.actualizarEstado(informeData.usuario_id, 'contratado');
    }

    // ─── 3. Componer datos para el email ──────────────────────────────────
    const cups          = propiedadData?.cups || 'No disponible';
    const direccion     = [
      propiedadData?.direccion,
      propiedadData?.codigo_postal,
      propiedadData?.ciudad,
      propiedadData?.provincia,
    ].filter(Boolean).join(', ') || '—';
    const compania_actual = informeData?.compania_actual || facturaData?.compania || '—';
    const consumo_total   = informeData?.consumo_kwh ?? facturaData?.consumo_kwh ?? '—';
    const consumo_p1      = informeData?.consumo_p1_kwh ?? '—';
    const consumo_p2      = informeData?.consumo_p2_kwh ?? '—';
    const consumo_p3      = informeData?.consumo_p3_kwh ?? '—';
    const potencia        = informeData?.potencia_kw ?? facturaData?.potencia_kw ?? '—';
    const dias            = informeData?.dias_facturacion ?? facturaData?.dias_facturacion ?? '—';
    const precio_actual   = informeData?.precio_actual_mes ?? facturaData?.precio_total ?? '—';
    const precio_nuevo    = informeData?.precio_nuevo_mes ?? '—';
    const pct_ahorro      = informeData?.pct_ahorro ?? '—';
    const p_kwh_p1        = informeData?.precio_kwh_p1 ?? '—';
    const p_kwh_p2        = informeData?.precio_kwh_p2 ?? '—';
    const p_kwh_p3        = informeData?.precio_kwh_p3 ?? '—';
    const p_pot_p1        = informeData?.precio_pot_p1 ?? '—';
    const p_pot_p2        = informeData?.precio_pot_p2 ?? '—';
    const p_fijo          = informeData?.precio_fijo_mes ?? '—';
    const fecha_factura   = facturaData?.fecha_factura
      ? new Date(facturaData.fecha_factura).toLocaleDateString('es-ES')
      : '—';

    // ─── 4. Adjuntos: DNI frontal + trasero + FACTURA ORIGINAL ───────────
    const attachments = [
      { filename: dni_frontal_nombre || 'dni_frontal.jpg', content: dni_frontal_base64 },
      { filename: dni_trasero_nombre || 'dni_trasero.jpg', content: dni_trasero_base64 },
    ];
    if (facturaBuffer) {
      attachments.push({ filename: facturaFileName, content: facturaBuffer.toString('base64') });
    } else {
      // Si no hay buffer, avisar en el log pero no bloquear el envío
      console.warn('[Contrato] ⚠️ Email enviado SIN factura adjunta — archivo_url vacío en Supabase');
    }

    // ─── 5. Enviar email ──────────────────────────────────────────────────
    const emailDestino = getEmailProveedor(nueva_compania);

    const row = (label, value, bg = false) =>
      `<tr style="${bg ? 'background:#f8fafc;' : ''}">
        <td style="padding:9px 12px;font-weight:600;color:#374151;width:210px;border-bottom:1px solid #e5e7eb">${label}</td>
        <td style="padding:9px 12px;color:#111827;border-bottom:1px solid #e5e7eb">${value}</td>
      </tr>`;

    await axios.post('https://api.resend.com/emails', {
      from:    'Lumux AI <ceo@lumux.es>',
      to:      [emailDestino],
      cc:      process.env.SMTP_USER ? [process.env.SMTP_USER] : [],
      subject: `CONTRATO LUMUX · ${nueva_compania} · ${nombre || 'Cliente'} · CUPS: ${cups}`,
      html: `
        <div style="font-family:sans-serif;max-width:640px;margin:0 auto">
          <div style="background:#1e1b2a;padding:20px 24px;border-radius:8px 8px 0 0">
            <h2 style="margin:0;color:#fff;font-size:18px">⚡ Nueva solicitud de contratación · Lumux AI</h2>
            <p style="margin:4px 0 0;color:#a78bfa;font-size:13px">Ref. ${short_id || '—'} · ${new Date().toLocaleString('es-ES')}</p>
          </div>

          <table style="border-collapse:collapse;width:100%;font-size:14px">
            <tr><td colspan="2" style="padding:10px 12px;background:#f0fdf4;font-weight:700;color:#15803d;font-size:13px;letter-spacing:.05em">DATOS DEL TITULAR</td></tr>
            ${row('Nombre titular',  nombre || '—', false)}
            ${row('Email',          email,          true)}
            ${row('IBAN',           `<span style="font-family:monospace">${iban}</span>`, false)}
            ${row('Dirección',      direccion,      true)}
            ${row('CUPS',           `<span style="font-family:monospace">${cups}</span>`, false)}

            <tr><td colspan="2" style="padding:10px 12px;background:#eff6ff;font-weight:700;color:#1d4ed8;font-size:13px;letter-spacing:.05em">DATOS DE LA FACTURA ACTUAL</td></tr>
            ${row('Compañía actual',    compania_actual,              false)}
            ${row('Fecha factura',      fecha_factura,                true)}
            ${row('Consumo total',      consumo_total !== '—' ? `${consumo_total} kWh` : '—', false)}
            ${row('Consumo P1 (Punta)', consumo_p1 !== '—' ? `${consumo_p1} kWh` : '—', true)}
            ${row('Consumo P2 (Llano)', consumo_p2 !== '—' ? `${consumo_p2} kWh` : '—', false)}
            ${row('Consumo P3 (Valle)', consumo_p3 !== '—' ? `${consumo_p3} kWh` : '—', true)}
            ${row('Potencia contratada',potencia !== '—' ? `${potencia} kW` : '—', false)}
            ${row('Días facturación',   `${dias} días`,                true)}
            ${row('Importe factura',    precio_actual !== '—' ? `${Number(precio_actual).toFixed(2)} €/mes` : '—', false)}

            <tr><td colspan="2" style="padding:10px 12px;background:#f0fdf4;font-weight:700;color:#15803d;font-size:13px;letter-spacing:.05em">NUEVA TARIFA LUMUX</td></tr>
            ${row('Compañía destino',   `<strong style="color:#16a34a">${nueva_compania}</strong>`, false)}
            ${row('Tarifa',             nueva_tarifa || '—',          true)}
            ${row('Precio P1 (kWh)',    p_kwh_p1 !== '—' ? `${p_kwh_p1} €/kWh` : '—', false)}
            ${row('Precio P2 (kWh)',    p_kwh_p2 !== '—' ? `${p_kwh_p2} €/kWh` : '—', true)}
            ${row('Precio P3 (kWh)',    p_kwh_p3 !== '—' ? `${p_kwh_p3} €/kWh` : '—', false)}
            ${row('Precio potencia P1', p_pot_p1 !== '—' ? `${p_pot_p1} €/kW·día` : '—', true)}
            ${row('Precio potencia P2', p_pot_p2 !== '—' ? `${p_pot_p2} €/kW·día` : '—', false)}
            ${row('Cuota fija mes',     p_fijo !== '—' ? `${p_fijo} €/mes` : '—', true)}
            ${row('Nuevo importe est.', precio_nuevo !== '—' ? `${Number(precio_nuevo).toFixed(2)} €/mes` : '—', false)}
            ${row('Ahorro estimado',    `<strong style="color:#16a34a">${ahorro_anual}€/año (${pct_ahorro}%)</strong>`, true)}
          </table>

          <div style="padding:14px 16px;background:#fefce8;border-left:4px solid #eab308;margin-top:0;font-size:13px;color:#713f12">
            📎 Adjuntos: DNI frontal · DNI trasero${facturaBuffer ? ' · <strong>Factura original</strong>' : ' · ⚠️ Factura NO disponible (revisar Storage)'}
          </div>

          <div style="padding:12px 16px;font-size:11px;color:#9ca3af;border-top:1px solid #e5e7eb;margin-top:8px">
            Gestionado automáticamente por <strong>Lumux AI</strong> · lumux.es · Ref. ${short_id || '—'}
          </div>
        </div>
      `,
      attachments: attachments.map(a => ({ filename: a.filename, content: a.content })),
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      }
    });

    console.log(`[Contrato] ✅ Email enviado → ${emailDestino} | short_id=${short_id} | factura=${facturaBuffer ? 'adjunta' : 'NO adjunta'}`);

    // ─── 6. WhatsApp de confirmación al cliente ───────────────────────────
    if (informeData?.telefono) {
      try {
        await enviarMensajeWhatsApp(
          informeData.telefono,
          `✅ ¡Todo listo, ${nombre ? nombre.split(' ')[0] : ''}! Hemos enviado tu solicitud de cambio a ${nueva_compania}.\n\nRecibirás el contrato para firmar en menos de 24h en ${email}.\n\n¿Tienes alguna duda? Escríbenos aquí mismo 💬`
        );
      } catch(e) { console.error('[Contrato] WA confirm error:', e.message); }
    }

    res.json({ ok: true });

  } catch (error) {
    console.error('[Contrato] Error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

module.exports = router;