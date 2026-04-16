const express = require('express');
const router = express.Router();
const axios = require('axios');
const FormData = require('form-data');
// Email via Resend API
const db = require('./db');
const meta   = require('./meta');
const tiktok = require('./tiktok');
const {
  responderMensaje, analizarFactura, generarComparativa, generarUrlInforme,
  generarResumenHistorial, analizarFacturaGas, generarComparativaGas
} = require('./claude');


// ─── SISTEMA DE RECORDATORIOS ────────────────────────────────────────────────
const recuerdoFactura   = new Map();
const recuerdoContratar = new Map();

// ─── TIMERS DE TRASPASO A AGENTE ─────────────────────────────────────────────
// Timer A: cliente no envió factura tras recordatorio → 3h → pasar a Adrián
// Timer B: cliente recibió informe pero no firmó      → 3h → pasar a Adrián
const traspasoSinFactura = new Map();  // telefono → timeoutId
const traspasoSinFirma   = new Map();  // telefono → timeoutId

const HORAS_SIN_FACTURA = 3;
const HORAS_SIN_FIRMA   = 3;

function cancelarTraspasos(telefono) {
  if (traspasoSinFactura.has(telefono)) { clearTimeout(traspasoSinFactura.get(telefono)); traspasoSinFactura.delete(telefono); }
  if (traspasoSinFirma.has(telefono))   { clearTimeout(traspasoSinFirma.get(telefono));   traspasoSinFirma.delete(telefono); }
}

function programarTraspasoSinFactura(telefono) {
  if (traspasoSinFactura.has(telefono)) clearTimeout(traspasoSinFactura.get(telefono));
  const t = setTimeout(async () => {
    traspasoSinFactura.delete(telefono);
    try {
      const { data: usuarios } = await db.supabase.from('usuarios').select('id').eq('telefono', telefono).limit(1);
      if (!usuarios?.length) return;
      const uid = usuarios[0].id;
      // Verificar que sigue sin factura
      const { data: facturas } = await db.supabase.from('facturas').select('id').eq('usuario_id', uid).limit(1);
      if (facturas?.length) return; // ya mandó factura, no traspasar
      const contactId = await getChatwootContactId(telefono, null);
      if (!contactId) return;
      const convResult = await getChatwootConversationId(contactId);
      const convId = convResult?.id;
      if (!convId) return;
      await asignarAAgente(convId);
      await enviarNotaContextoAgente(convId, telefono, 'sin_factura');
      await db.supabase.from('usuarios').update({ bot_activo: false, updated_at: new Date().toISOString() }).eq('id', uid);
      await db.guardarMensaje(uid, 'assistant', '[TRASPASO_AGENTE] Cliente sin factura tras recordatorio. Conversación asignada a agente.', { tipo: 'traspaso_agente', motivo: 'sin_factura' });
      console.log(`[Traspaso] Sin factura → agente: ${telefono}`);
    } catch(e) { console.error('[Traspaso] Error sin_factura:', e.message); }
  }, HORAS_SIN_FACTURA * 60 * 60 * 1000);
  traspasoSinFactura.set(telefono, t);
}

function programarTraspasoSinFirma(telefono, convId) {
  if (traspasoSinFirma.has(telefono)) clearTimeout(traspasoSinFirma.get(telefono));
  const t = setTimeout(async () => {
    traspasoSinFirma.delete(telefono);
    try {
      const { data: usuarios } = await db.supabase.from('usuarios').select('id, estado').eq('telefono', telefono).limit(1);
      if (!usuarios?.length) return;
      const usuario = usuarios[0];
      if (usuario.estado === 'contratado') return; // ya firmó
      // Verificar que la conversación no está ya asignada a Adrián
      const yaAsignada = await convAsignadaAAgente(convId);
      if (yaAsignada) return;
      await asignarAAgente(convId);
      await enviarNotaContextoAgente(convId, telefono, 'sin_firma');
      await db.supabase.from('usuarios').update({ bot_activo: false, updated_at: new Date().toISOString() }).eq('id', usuario.id);
      await db.guardarMensaje(usuario.id, 'assistant', '[TRASPASO_AGENTE] Cliente con informe sin firmar. Conversación asignada a agente.', { tipo: 'traspaso_agente', motivo: 'sin_firma' });
      console.log(`[Traspaso] Sin firma → agente: ${telefono}`);
    } catch(e) { console.error('[Traspaso] Error sin_firma:', e.message); }
  }, HORAS_SIN_FIRMA * 60 * 60 * 1000);
  traspasoSinFirma.set(telefono, t);
}
// ─────────────────────────────────────────────────────────────────────────────

function cancelarRecordatorios(telefono) {
  if (recuerdoFactura.has(telefono))   { clearTimeout(recuerdoFactura.get(telefono));   recuerdoFactura.delete(telefono); }
  if (recuerdoContratar.has(telefono)) { clearTimeout(recuerdoContratar.get(telefono)); recuerdoContratar.delete(telefono); }
}

function programarRecuerdoFactura(telefono) {
  if (recuerdoFactura.has(telefono)) clearTimeout(recuerdoFactura.get(telefono));
  const t = setTimeout(async () => {
    recuerdoFactura.delete(telefono);
    try {
      const { data: usuario } = await db.supabase.from('usuarios').select('id').eq('telefono', telefono).single();
      if (!usuario) return;
      const { data: facturas } = await db.supabase.from('facturas').select('id').eq('usuario_id', usuario.id).limit(1);
      if (facturas && facturas.length > 0) return;
      await enviarMensajeWhatsApp(telefono,
        '\uD83D\uDC4B \u00A1Oye, que a\u00FAn no me has mandado tu factura! \uD83D\uDE04\n\nEnv\u00EDamela ahora y en segundos te digo exactamente cu\u00E1nto puedes ahorrar. \u26A1 Es gratis y sin compromiso.'
      );
      console.log('[Recordatorio] Factura enviado a', telefono);
    } catch(e) { console.error('[Recordatorio] Error factura:', e.message); }
  }, 10 * 60 * 1000);
  recuerdoFactura.set(telefono, t);
}

function programarRecuerdoContratar(telefono, ahorroAnual, compania) {
  if (recuerdoContratar.has(telefono)) clearTimeout(recuerdoContratar.get(telefono));
  const t = setTimeout(async () => {
    recuerdoContratar.delete(telefono);
    try {
      const { data: usuario } = await db.supabase.from('usuarios').select('id, estado').eq('telefono', telefono).single();
      if (!usuario || usuario.estado === 'contratado') return;
      const ahorro = Math.round(ahorroAnual);
      await enviarMensajeWhatsApp(telefono,
        `\u23f0 \u00a1Recuerda que tienes ${ahorro}\u20ac al a\u00f1o esperando! 

Tu informe con el ahorro pasando a *${compania}* sigue disponible. Solo rellena tus datos y nosotros lo gestionamos todo. 

\u00bfQuieres que te renv\u00ede el enlace?`
      );
      console.log('[Recordatorio] Contratar enviado a', telefono);
    } catch(e) { console.error('[Recordatorio] Error contratar:', e.message); }
  }, 20 * 60 * 1000);
  recuerdoContratar.set(telefono, t);
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── CHATWOOT: HELPERS DE CONTACTO / CONVERSACIÓN / ASIGNACIÓN ───────────────

async function getChatwootContactId(phone, nombre) {
  const base = { headers: { api_access_token: process.env.CHATWOOT_API_TOKEN } };
  const buscar = async () => {
    const res = await axios.get(
      `${process.env.CHATWOOT_URL}/api/v1/accounts/1/contacts/search?q=${encodeURIComponent(phone)}`, base
    );
    const lista = res.data?.payload?.contacts || res.data?.payload || [];
    // Buscar coincidencia exacta de teléfono
    const exacto = lista.find(c =>
      c.phone_number?.replace(/\D/g, '').endsWith(phone) ||
      String(c.phone_number || '').includes(phone)
    );
    return exacto?.id || (lista.length > 0 ? lista[0].id : null);
  };
  try {
    // 1. Buscar primero
    const idExistente = await buscar();
    if (idExistente) return idExistente;
    // 2. Crear
    try {
      const createRes = await axios.post(
        `${process.env.CHATWOOT_URL}/api/v1/accounts/1/contacts`,
        { name: nombre || phone, phone_number: `+${phone}` }, base
      );
      const idCreado = createRes.data?.id || createRes.data?.payload?.id;
      if (idCreado) return idCreado;
    } catch (createErr) {
      console.warn('[Chatwoot] Creación falló, reintentando búsqueda:', createErr.message);
    }
    // 3. Si creación falló (duplicado/race condition), buscar de nuevo
    const idReintentar = await buscar();
    if (idReintentar) return idReintentar;
    console.error('[Chatwoot] No se pudo obtener contactId para:', phone);
    return null;
  } catch (e) { console.error('Chatwoot contact error:', e.message); return null; }
}

let _chatwootInboxId = null;

async function getWhatsAppInboxId() {
  if (_chatwootInboxId) return _chatwootInboxId;
  if (process.env.CHATWOOT_INBOX_ID) { _chatwootInboxId = process.env.CHATWOOT_INBOX_ID; return _chatwootInboxId; }
  try {
    const res = await axios.get(
      `${process.env.CHATWOOT_URL}/api/v1/accounts/1/inboxes`,
      { headers: { api_access_token: process.env.CHATWOOT_API_TOKEN } }
    );
    const inboxes = res.data?.payload || [];
    console.log('[Chatwoot] Inboxes:', inboxes.map(i => `${i.id}:${i.channel_type}:${i.name}`));
    const wa  = inboxes.find(i => i.channel_type === 'Channel::Whatsapp' || i.name?.toLowerCase().includes('whatsapp'));
    const api = inboxes.find(i => i.channel_type === 'Channel::Api');
    const inbox = wa || api || inboxes[0];
    if (inbox) { _chatwootInboxId = String(inbox.id); return _chatwootInboxId; }
  } catch (e) { console.error('[Chatwoot] Error detectando inbox:', e.message); }
  return '1';
}

async function getChatwootConversationId(contactId) {
  try {
    const inboxId = await getWhatsAppInboxId();
    const base = { headers: { api_access_token: process.env.CHATWOOT_API_TOKEN } };
    const convsRes = await axios.get(
      `${process.env.CHATWOOT_URL}/api/v1/accounts/1/contacts/${contactId}/conversations`, base
    );
    const convs = convsRes.data?.payload || [];
    // Buscar conversación activa: open O pending (pending = nuevo contacto aún no atendido)
    const existing = convs.find(c =>
      ['open', 'pending'].includes(c.status) && String(c.inbox_id) === String(inboxId)
    );
    if (existing) {
      // Si está en pending, abrirla para que el agente la vea en la bandeja principal
      if (existing.status === 'pending') {
        await axios.post(
          `${process.env.CHATWOOT_URL}/api/v1/accounts/1/conversations/${existing.id}/toggle_status`,
          { status: 'open' }, base
        ).catch(() => {});
      }
      return { id: existing.id, nueva: false };
    }
    const createRes = await axios.post(
      `${process.env.CHATWOOT_URL}/api/v1/accounts/1/conversations`,
      { inbox_id: parseInt(inboxId), contact_id: contactId, status: 'open' }, base
    );
    const id = createRes.data?.id || createRes.data?.payload?.id;
    return { id, nueva: true };
  } catch (e) { console.error('Chatwoot conv error:', e.message); return null; }
}

// Devuelve el assignee actual de una conversación o null
async function getConvAssignee(convId) {
  try {
    const res = await axios.get(
      `${process.env.CHATWOOT_URL}/api/v1/accounts/1/conversations/${convId}`,
      { headers: { api_access_token: process.env.CHATWOOT_API_TOKEN } }
    );
    return res.data?.meta?.assignee || res.data?.assignee || null;
  } catch (e) { return null; }
}

// ¿Está asignada a Adrián? → bot SILENTE. Asignada a Alberto o sin asignar → bot habla.
async function convAsignadaAAgente(convId) {
  if (!convId || !process.env.CHATWOOT_ADRIAN_ID) return false;
  const assignee = await getConvAssignee(convId);
  if (!assignee) return false;
  return String(assignee.id) === String(process.env.CHATWOOT_ADRIAN_ID);
}

// Asignar a Alberto (auditor) — siempre al crear conversación
async function asignarAAlberto(convId) {
  if (!convId || !process.env.CHATWOOT_ALBERTO_ID) return;
  try {
    await axios.post(
      `${process.env.CHATWOOT_URL}/api/v1/accounts/1/conversations/${convId}/assignments`,
      { assignee_id: parseInt(process.env.CHATWOOT_ALBERTO_ID) },
      { headers: { api_access_token: process.env.CHATWOOT_API_TOKEN } }
    );
  } catch (e) { console.error('[Chatwoot] asignarAAlberto error:', e.message); }
}

// Asignar a Adrián (traspaso comercial) — con auto-provisioning
async function asignarAAgente(convId) {
  if (!convId) return;
  if (!process.env.CHATWOOT_ADRIAN_ID) {
    const email = process.env.CHATWOOT_ADRIAN_EMAIL || 'adrian@lumux.es';
    const base  = { headers: { api_access_token: process.env.CHATWOOT_API_TOKEN } };
    try {
      const list    = await axios.get(`${process.env.CHATWOOT_URL}/api/v1/accounts/1/agents`, base);
      const agents  = list.data || [];
      const existing = agents.find(a => a.email === email);
      if (existing) {
        process.env.CHATWOOT_ADRIAN_ID = String(existing.id);
      } else {
        const pass = process.env.CHATWOOT_ADRIAN_PASS || 'Lumux2025!';
        const res  = await axios.post(
          `${process.env.CHATWOOT_URL}/api/v1/accounts/1/agents`,
          { name: 'Adrián', email, role: 'agent', password: pass, password_confirmation: pass }, base
        );
        process.env.CHATWOOT_ADRIAN_ID = String(res.data?.id || res.data?.payload?.id);
        console.log(`[Chatwoot] Adrián auto-creado id=${process.env.CHATWOOT_ADRIAN_ID}`);
      }
    } catch(e) { console.error('[Chatwoot] Auto-provisioning Adrián:', e.message); return; }
  }
  try {
    await axios.post(
      `${process.env.CHATWOOT_URL}/api/v1/accounts/1/conversations/${convId}/assignments`,
      { assignee_id: parseInt(process.env.CHATWOOT_ADRIAN_ID) },
      { headers: { api_access_token: process.env.CHATWOOT_API_TOKEN } }
    );
    console.log(`[Chatwoot] Conv ${convId} → Adrián (id=${process.env.CHATWOOT_ADRIAN_ID})`);
  } catch (e) { console.error('[Chatwoot] asignarAAgente error:', e.message); }
}

// Nota privada de contexto para Adrián al recibir el traspaso
async function enviarNotaContextoAgente(convId, telefono, motivo) {
  if (!convId) return;
  try {
    // Buscar datos del usuario y su último informe
    const { data: usuarios } = await db.supabase
      .from('usuarios').select('id, nombre, estado').eq('telefono', telefono).limit(1);
    if (!usuarios?.length) return;
    const uid = usuarios[0].id;

    const { data: informes } = await db.supabase
      .from('informes')
      .select('nombre, compania_actual, nueva_compania, nueva_tarifa, ahorro_anual, pct_ahorro, precio_actual_mes, precio_nuevo_mes, cups, created_at, short_id, ofertas(estado)')
      .eq('usuario_id', uid)
      .order('created_at', { ascending: false })
      .limit(1);

    const inf = informes?.[0];
    const motivoTexto = motivo === 'sin_factura'
      ? '⏰ No envió factura tras recordatorio (3h sin respuesta)'
      : '⏰ Recibió informe pero no firmó (3h sin contratar)';

    let nota = `📋 *RESUMEN DEL LEAD — TRASPASO AUTOMÁTICO*\n\n`;
    nota += `*Motivo:* ${motivoTexto}\n`;
    nota += `*Teléfono:* ${telefono}\n`;
    nota += `*Nombre:* ${inf?.nombre || usuarios[0].nombre || '—'}\n\n`;

    if (inf) {
      const urlInforme = `${process.env.WEB_URL || 'https://lumux.es'}/informe.html?id=${inf.short_id}`;
      nota += `*Compañía actual:* ${inf.compania_actual || '—'}\n`;
      nota += `*Mejor oferta:* ${inf.nueva_compania} · ${inf.nueva_tarifa || '—'}\n`;
      nota += `*Factura actual:* ${inf.precio_actual_mes ? `${Number(inf.precio_actual_mes).toFixed(2)}€/mes` : '—'}\n`;
      nota += `*Con Lumux:* ${inf.precio_nuevo_mes ? `${Number(inf.precio_nuevo_mes).toFixed(2)}€/mes` : '—'}\n`;
      nota += `*Ahorro:* ${inf.ahorro_anual ? `${Math.round(inf.ahorro_anual)}€/año` : '—'} (${inf.pct_ahorro || '—'}%)\n`;
      nota += `*CUPS:* ${inf.cups || '—'}\n`;
      nota += `*Informe:* ${urlInforme}\n`;
      nota += `\n✅ *Acción:* Contactar al cliente, cerrar la firma y luego *desasignarte* para reactivar el bot.`;
    } else {
      nota += `ℹ️ El cliente inició conversación pero no llegó a enviar factura.\n`;
      nota += `\n✅ *Acción:* Contactar para pedirle la factura, y luego *desasignarte* para reactivar el bot.`;
    }

    await axios.post(
      `${process.env.CHATWOOT_URL}/api/v1/accounts/1/conversations/${convId}/messages`,
      { content: nota, message_type: 'outgoing', private: true },
      { headers: { api_access_token: process.env.CHATWOOT_API_TOKEN } }
    );
    console.log(`[Chatwoot] Nota contexto enviada a conv ${convId}`);
  } catch(e) { console.error('[Chatwoot] enviarNotaContextoAgente error:', e.message); }
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

  // ─── VALIDACIÓN: factura incompleta (página parcial sin consumo ni total) ──
  const sinConsumo    = !datosFactura.consumo_kwh && !datosFactura.consumo_p1_kwh;
  const sinPrecioTotal = !datosFactura.precio_total;
  if (sinConsumo || sinPrecioTotal) {
    return {
      respuesta: `📄 La imagen que me has enviado está incompleta — no puedo ver los datos de consumo o el importe total de tu factura.\n\nPara darte el ahorro exacto necesito que me la envíes de una de estas formas:\n\n📎 *En PDF* — descárgala desde la app o web de tu compañía (Endesa, Iberdrola, etc.) y envíamela aquí\n\n🖼️ *Foto completa* — asegúrate de que se vea la página donde aparece el resumen de kWh consumidos y el total a pagar\n\n¡En cuanto la tenga te preparo la comparativa! 👇`,
      metadata: {}
    };
  }

  const esGas = datosFactura.tipo_suministro === 'gas';
  const cups  = datosFactura.cups || null;

  // ─── BLOQUEO POR CUPS ────────────────────────────────────────────────────
  if (!cups) {
    // Sin CUPS la factura no se puede procesar ni asociar a un suministro
    console.warn(`[CUPS] Factura sin CUPS. Usuario: ${usuario.id}`);
    return {
      respuesta: `⚙️ Estamos actualizando nuestra herramienta de análisis.\n\nEn breve uno de nuestros asesores revisará tu factura y te enviará tu comparativa personalizada.\n\n¿Tienes alguna duda? Puedes llamarnos por teléfono al número de este WhatsApp 📞`,
      metadata: { sin_cups: true }
    };
  }

  // Verificar si este CUPS ya tiene contrato activo u oferta firmada
  const bloqueo = await db.verificarBloqueCUPS(cups, usuario.id);
  if (bloqueo.bloqueado) {
    console.log(`[CUPS] Bloqueado: ${bloqueo.motivo} para CUPS ${cups}`);
    return { respuesta: bloqueo.mensaje, metadata: { cups, bloqueado: true } };
  }

  // Guardar/actualizar propiedad con el CUPS y dirección extraída del OCR
  const propiedadId = await db.upsertPropiedad(usuario.id, cups, {
    direccion:  datosFactura.direccion_suministro || null,
    codigo_postal: datosFactura.codigo_postal || null,
    ciudad:     datosFactura.ciudad || null,
    provincia:  datosFactura.provincia || null,
  });

  // ─── GUARDAR FACTURA ─────────────────────────────────────────────────────
  const factura = await db.guardarFactura(usuario.id, {
    propiedad_id:     propiedadId,
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

  if (!esGas) {
    const resumen = generarResumenHistorial(datosFactura, comparativa);
    await db.guardarMensaje(usuario.id, 'assistant', resumen, { tipo: 'resumen_analisis', factura_id: factura.id });
  }

  let respuesta = comparativa.mensaje;
  let metadata = {};

  if (comparativa.ahorro > 0 && comparativa.tarifa) {
    const d = comparativa.datosComparativa;

    const informeGuardado = await db.guardarInforme({
      usuario_id:        usuario.id,
      factura_id:        factura.id,
      nombre:            datosFactura.nombre_titular || usuario.nombre,
      dni:               datosFactura.dni_titular || null,
      telefono:          telefono,
      cups:              cups,
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

    if (!informeGuardado) {
      console.error('[procesarFactura] guardarInforme devolvió null — ¿falta columna cups en la tabla informes?');
      return { respuesta: comparativa.mensaje, metadata: { factura_id: factura.id } };
    }

    const urlCorta = `${process.env.WEB_URL || 'https://lumux.es'}/informe.html?id=${informeGuardado.short_id}`;
    const oferta = await db.crearOferta(usuario.id, factura.id, comparativa.tarifa.id, comparativa.ahorro, urlCorta);
    await db.supabase.from('informes').update({ oferta_id: oferta.id }).eq('id', informeGuardado.id);
    await db.programarRemarketing(usuario.id, oferta.id, 3, 'seguimiento_oferta');

    // ─── META CAPI: Lead ──────────────────────────────────────────────────────
    meta.enviarLead({ telefono, ahorro: comparativa.ahorro }).catch(() => {});
    // ─── TIKTOK CAPI: Lead ────────────────────────────────────────────────────
    tiktok.enviarLead({ telefono, ahorro: comparativa.ahorro }).catch(() => {});
    cancelarRecordatorios(telefono);
    programarRecuerdoContratar(telefono, comparativa.ahorro, comparativa.tarifa?.compania || '');
    // ─────────────────────────────────────────────────────────────────────────

    try {
      await enviarPlantillaInforme(
        telefono, usuario.nombre, datosFactura.compania,
        comparativa.tarifa.compania, comparativa.ahorro, d.pct_ahorro, informeGuardado.short_id
      );
      respuesta = null;
    } catch (e) {
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
    const convId = conversation?.id;

    // ── Evento 0: comandos /bot off|on desde nota privada de Alberto ─────────
    if (event === 'message_created' && isPrivate && content?.trim()) {
      const cmd = content.trim().toLowerCase();
      if (cmd === '/bot off' || cmd === '/bot on') {
        const phoneRaw = conversation?.meta?.sender?.phone_number;
        if (phoneRaw) {
          const phone = phoneRaw.replace(/[\s+\-()]/g, '');
          const activar = cmd === '/bot on';
          try {
            await db.supabase.from('usuarios')
              .update({ bot_activo: activar, updated_at: new Date().toISOString() })
              .eq('telefono', phone);
            if (!activar) { cancelarRecordatorios(phone); cancelarTraspasos(phone); }
            else { cancelarTraspasos(phone); }
            await axios.post(
              `${process.env.CHATWOOT_URL}/api/v1/accounts/1/conversations/${convId}/messages`,
              { content: `✅ Bot ${activar ? 'ACTIVADO' : 'SILENCIADO'} para este cliente.`, message_type: 'outgoing', private: true },
              { headers: { api_access_token: process.env.CHATWOOT_API_TOKEN } }
            );
            console.log(`[Bot control] ${phone} → bot_activo=${activar}`);
          } catch(e) { console.error('[Bot control] error:', e.message); }
        }
        return;
      }
    }

    // ── Evento 1: mensaje saliente del agente → reenviar por WhatsApp ────────
    if (event === 'message_created' && message_type === 'outgoing' && !isPrivate && content?.trim()) {
      const phoneRaw = conversation?.meta?.sender?.phone_number;
      if (phoneRaw) {
        const phone = phoneRaw.replace(/[\s+\-()]/g, '');
        await enviarMensajeWhatsApp(phone, content);
        try {
          const { data: usuarios } = await db.supabase.from('usuarios').select('id').eq('telefono', phone).limit(1);
          if (usuarios?.length > 0) await db.guardarMensaje(usuarios[0].id, 'assistant', content, { fuente: 'agente_chatwoot' });
        } catch (e) { console.error('Chatwoot DB:', e.message); }
      }
    }

    // ── Evento 2: conversación actualizada → detectar desasignación ──────────
    // Cuando el agente desasigna (assignee pasa a null) → reactivar bot
    if ((event === 'conversation_updated' || event === 'assignment_changed') && convId) {
      const assignee     = req.body.assignee ?? req.body.meta?.assignee ?? null;
      const prevAssignee = req.body.meta?.previous_assignee || req.body.previous_assignee || null;
      const hayDesasignacion = !assignee && prevAssignee;

      if (hayDesasignacion) {
        const phoneRaw = conversation?.meta?.sender?.phone_number;
        if (phoneRaw) {
          const phone = phoneRaw.replace(/[\s+\-()]/g, '');
          try {
            await db.supabase.from('usuarios')
              .update({ bot_activo: true, updated_at: new Date().toISOString() })
              .eq('telefono', phone);
            cancelarTraspasos(phone);
            console.log(`[Bot] Reactivado para ${phone} tras desasignación conv ${convId}`);
          } catch(e) { console.error('[Bot reactivar] DB error:', e.message); }
        }
      }
    }

  } catch (error) { console.error('Error chatwoot webhook:', error); }
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
    console.log('[WA RAW]', JSON.stringify(req.body));
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
    else if (msg.type === 'interactive') {
      // Respuestas de botones o listas — típico del primer mensaje de anuncios Meta
      mensajeTexto = msg.interactive?.button_reply?.title ||
                     msg.interactive?.list_reply?.title ||
                     msg.interactive?.nfm_reply?.submitted_form_data?.name ||
                     '[Interacción de botón]';
    }
    else if (msg.type === 'button') {
      // Quick reply de plantilla — también habitual en ads
      mensajeTexto = msg.button?.text || '[Botón seleccionado]';
    }
    else if (msg.type === 'image') { tipo = 'imagen'; archivoUrl = await getMediaUrl(msg.image.id); mediaType = msg.image.mime_type || 'image/jpeg'; fileName = `factura_${Date.now()}.jpg`; }
    else if (msg.type === 'document') { tipo = 'archivo'; archivoUrl = await getMediaUrl(msg.document.id); mediaType = msg.document.mime_type || 'application/pdf'; fileName = msg.document.filename || `factura_${Date.now()}.pdf`; }
    else return;

    const usuario = await db.getOrCreateUsuario(from, { nombre, telefono: from, canal: 'whatsapp' });
    let respuesta = '', metadata = {};

    // ─── CHATWOOT: obtener / crear conversación y asignar a Alberto ──────────
    let chatwootConvId = null;
    let chatwootConvNueva = false;
    if (process.env.CHATWOOT_URL && process.env.CHATWOOT_API_TOKEN) {
      const contactId = await getChatwootContactId(from, nombre);
      if (contactId) {
        const convResult = await getChatwootConversationId(contactId);
        chatwootConvId    = convResult?.id;
        chatwootConvNueva = convResult?.nueva || false;
        await asignarAAlberto(chatwootConvId);
        if (chatwootConvId) {
          if (tipo === 'texto') {
            await enviarMensajeChatwoot(chatwootConvId, mensajeTexto, false);
          }
          // Los archivos se registran más abajo cuando ya tenemos el buffer descargado
        }
      }
    }

    // ─── GUARDIA: bot silente si está asignado a Adrián O si bot_activo=false ─
    const botSilente = (chatwootConvId && await convAsignadaAAgente(chatwootConvId)) ||
                       (usuario.bot_activo === false);
    if (botSilente) {
      const textoLog = tipo !== 'texto' ? '[Archivo enviado mientras bot silente]' : mensajeTexto;
      await db.guardarMensaje(usuario.id, 'user', textoLog, { fuente: 'bot_silente' });
      if (chatwootConvId && tipo !== 'texto') {
        try {
          const imageResponse = await axios.get(archivoUrl, { responseType: 'arraybuffer', headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } });
          await enviarArchivoChatwoot(chatwootConvId, Buffer.from(imageResponse.data), fileName, mediaType);
        } catch(e) { /* silencioso */ }
      }
      // El mensaje de texto ya se registró en Chatwoot arriba
      console.log(`[Bot silente] ${from} asignado a Adrián, mensaje ignorado por bot`);
      return;
    }

    // ─── BOT ACTIVO: procesar mensaje ────────────────────────────────────────
    const historial = await db.getHistorial(usuario.id);

    if (tipo === 'imagen' || tipo === 'archivo') {
      await db.guardarMensaje(usuario.id, 'user', '[Factura enviada]', { archivoUrl });
      cancelarRecordatorios(from);
      cancelarTraspasos(from); // cliente activo, cancelar timers de traspaso
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
      // El mensaje de texto ya se registró en Chatwoot arriba (al crear la conversación)
      cancelarTraspasos(from);
      const contratosCtx = await db.getContratosYInformesPorTelefono(from);
      respuesta = await responderMensaje(historial, mensajeTexto, contratosCtx, usuario);
      programarRecuerdoFactura(from);
      programarTraspasoSinFactura(from);
    }

    // ─── Enviar respuesta del bot ─────────────────────────────────────────────
    if (respuesta) {
      await db.guardarMensaje(usuario.id, 'assistant', respuesta, metadata);
      await enviarMensajeWhatsApp(from, respuesta);
      if (chatwootConvId) await enviarMensajeChatwoot(chatwootConvId, respuesta, true);
    } else {
      // respuesta === null → plantilla de informe enviada
      const nota = `📊 Informe enviado con botón | ID: ${metadata.short_id} | URL: ${metadata.url_informe}`;
      await db.guardarMensaje(usuario.id, 'assistant', nota, metadata);
      if (chatwootConvId) await enviarMensajeChatwoot(chatwootConvId, nota, true);
      // ─── Timer B: si no firma en 3h → pasar a Adrián ─────────────────────
      cancelarTraspasos(from);
      programarTraspasoSinFirma(from, chatwootConvId);
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

    // ─── RESPONDER AL CLIENTE INMEDIATAMENTE (antes de cualquier I/O) ─────
    res.json({ ok: true });

    // ─── TODO EN BACKGROUND: queries, descarga factura, BD, email, WA ────────
    setImmediate(async () => { try {

    // ─── 1. Obtener informe completo + factura + propiedad ────────────────
    let informeData = null;
    let facturaData = null;
    let propiedadData = null;
    let facturaBuffer = null;
    let facturaFileName = 'factura_cliente.pdf';

    if (short_id) {
      const { data: informe } = await db.supabase
        .from('informes')
        .select(`*, facturas(id, archivo_url, compania, consumo_kwh, potencia_kw, precio_total, dias_facturacion, fecha_factura, propiedad_id), ofertas(id, estado)`)
        .eq('short_id', short_id)
        .single();

      informeData = informe;
      facturaData = informe?.facturas;

      // ── CUPS y dirección: seguir la cadena informe→factura→propiedad_id ──
      // NUNCA buscar por usuario_id (riesgo de cruzar datos entre suministros)
      const propiedadId = facturaData?.propiedad_id;
      if (propiedadId) {
        const { data: prop } = await db.supabase
          .from('propiedades')
          .select('id, cups, direccion, codigo_postal, ciudad, provincia')
          .eq('id', propiedadId)
          .single();
        propiedadData = prop;
        console.log(`[Contrato] Propiedad obtenida por propiedad_id: ${propiedadId} → CUPS: ${prop?.cups}`);
      } else if (informeData?.cups) {
        // Fallback: usar el CUPS guardado en el informe directamente
        const { data: prop } = await db.supabase
          .from('propiedades')
          .select('id, cups, direccion, codigo_postal, ciudad, provincia')
          .eq('cups', informeData.cups)
          .single();
        propiedadData = prop;
        console.log(`[Contrato] Propiedad obtenida por cups del informe: ${informeData.cups}`);
      } else {
        console.warn(`[Contrato] ⚠️ No hay propiedad_id en factura ni cups en informe — short_id: ${short_id}`);
      }

      // ── Verificación de integridad: CUPS del informe vs CUPS de la propiedad ──
      if (informeData?.cups && propiedadData?.cups && informeData.cups !== propiedadData.cups) {
        console.error(`[Contrato] ❌ INCONSISTENCIA CUPS: informe.cups=${informeData.cups} vs propiedad.cups=${propiedadData.cups}`);
        // Usar siempre el del informe (es el que el cliente contrató)
        propiedadData = { ...propiedadData, cups: informeData.cups };
      }

      // ── Descargar la factura VINCULADA A ESTE INFORME (no cualquier factura) ──
      const facturaUrl = facturaData?.archivo_url;
      if (facturaUrl) {
        try {
          const ext = facturaUrl.match(/\.(pdf|jpg|jpeg|png)(\?|$)/i)?.[1] || 'pdf';
          facturaFileName = `factura_${(nombre || 'cliente').replace(/\s+/g, '_')}.${ext}`;
          const r = await axios.get(facturaUrl, { responseType: 'arraybuffer' });
          facturaBuffer = Buffer.from(r.data);
          console.log(`[Contrato] ✅ Factura descargada: ${facturaBuffer.length} bytes | factura_id: ${facturaData?.id}`);
        } catch(e) {
          console.error('[Contrato] No se pudo descargar factura:', e.message);
        }
      } else {
        console.warn(`[Contrato] ⚠️ facturas.archivo_url vacío para factura_id: ${facturaData?.id} — factura NO adjunta`);
      }
    }

    // ─── Nombre real: prioridad informe (nombre de factura) > form > fallback ─
    const nombreReal = informeData?.nombre || nombre || '—';

    // ─── 2. Guardar titular + marcar oferta firmada (operaciones críticas BD) ──
    if (informeData?.usuario_id) {
      await db.supabase.from('titulares').upsert({
        usuario_id:      informeData.usuario_id,
        nombre:          nombreReal,
        dni_cif:         informeData.dni || null,
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
      if (informeData?.telefono) cancelarRecordatorios(informeData.telefono);

      const cupsNota = propiedadData?.cups || informeData?.cups || 'no disponible';
      await db.guardarMensaje(
        informeData.usuario_id, 'assistant',
        `[CONTRATO] Contratación firmada con ${nueva_compania} (tarifa: ${nueva_tarifa || '—'}). CUPS: ${cupsNota}. Ahorro: ${ahorro_anual}€/año. Email: ${email}. Estado: tramitando. Ref: ${short_id}.`,
        { tipo: 'contrato_firmado', short_id, oferta_id: ofertaId }
      );
    }

    // ─── BACKGROUND: email + WhatsApp + Meta CAPI (continuación del setImmediate) ─

      // ─── META CAPI: Purchase ──────────────────────────────────────────────
      meta.enviarPurchase({
        telefono: informeData?.telefono,
        email,
        ahorroAnual: ahorro_anual,
        compania:    nueva_compania,
      }).catch(() => {});
      // ─── TIKTOK CAPI: Purchase ────────────────────────────────────────────
      tiktok.enviarPurchase({
        telefono: informeData?.telefono,
        email,
        ahorroAnual: ahorro_anual,
        compania:    nueva_compania,
      }).catch(() => {});

    const cups           = propiedadData?.cups || informeData?.cups || 'No disponible';
    const direccion      = [propiedadData?.direccion, propiedadData?.codigo_postal, propiedadData?.ciudad, propiedadData?.provincia].filter(Boolean).join(', ') || '—';
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
    const fecha_factura   = facturaData?.fecha_factura ? new Date(facturaData.fecha_factura).toLocaleDateString('es-ES') : '—';

    // ─── 4. Adjuntos: DNI x2 + FACTURA ORIGINAL ──────────────────────────
    const attachments = [
      { filename: dni_frontal_nombre || 'dni_frontal.jpg', content: dni_frontal_base64 },
      { filename: dni_trasero_nombre || 'dni_trasero.jpg', content: dni_trasero_base64 },
    ];
    if (facturaBuffer) {
      attachments.push({ filename: facturaFileName, content: facturaBuffer.toString('base64') });
    }

    // ─── 5. Enviar email ──────────────────────────────────────────────────
    const emailDestino = getEmailProveedor(nueva_compania);
    const r = (label, value, bg) =>
      `<tr style="${bg ? 'background:#f8fafc;' : ''}"><td style="padding:9px 12px;font-weight:600;color:#374151;width:210px;border-bottom:1px solid #e5e7eb">${label}</td><td style="padding:9px 12px;color:#111827;border-bottom:1px solid #e5e7eb">${value}</td></tr>`;

    await axios.post('https://api.resend.com/emails', {
      from: 'Lumux AI <ceo@lumux.es>',
      to:   [emailDestino],
      cc:   process.env.SMTP_USER ? [process.env.SMTP_USER] : [],
      subject: `CONTRATO LUMUX · ${nueva_compania} · ${nombreReal} · CUPS: ${cups}`,
      html: `<div style="font-family:sans-serif;max-width:640px;margin:0 auto">
        <div style="background:#1e1b2a;padding:20px 24px;border-radius:8px 8px 0 0">
          <h2 style="margin:0;color:#fff;font-size:18px">⚡ Nueva solicitud de contratación · Lumux AI</h2>
          <p style="margin:4px 0 0;color:#a78bfa;font-size:13px">Ref. ${short_id || '—'} · ${new Date().toLocaleString('es-ES')}</p>
        </div>
        <table style="border-collapse:collapse;width:100%;font-size:14px">
          <tr><td colspan="2" style="padding:10px 12px;background:#f0fdf4;font-weight:700;color:#15803d;font-size:12px;letter-spacing:.05em">DATOS DEL TITULAR</td></tr>
          ${r('Nombre titular', nombreReal)}
          ${r('DNI / NIF', informeData?.dni || '—', true)}
          ${r('Email', email)}
          ${r('IBAN', `<span style="font-family:monospace">${iban}</span>`, true)}
          ${r('Dirección', direccion)}
          ${r('CUPS', `<span style="font-family:monospace">${cups}</span>`, true)}
          <tr><td colspan="2" style="padding:10px 12px;background:#eff6ff;font-weight:700;color:#1d4ed8;font-size:12px;letter-spacing:.05em">DATOS DE LA FACTURA ACTUAL</td></tr>
          ${r('Compañía actual', compania_actual)}
          ${r('Fecha factura', fecha_factura, true)}
          ${r('Consumo total', consumo_total !== '—' ? `${consumo_total} kWh` : '—')}
          ${r('Consumo P1 / P2 / P3', [consumo_p1,consumo_p2,consumo_p3].map(v => v !== '—' ? `${v} kWh` : '—').join(' · '), true)}
          ${r('Potencia contratada', potencia !== '—' ? `${potencia} kW` : '—')}
          ${r('Días facturación', `${dias} días`, true)}
          ${r('Importe factura', precio_actual !== '—' ? `${Number(precio_actual).toFixed(2)} €/mes` : '—')}
          <tr><td colspan="2" style="padding:10px 12px;background:#f0fdf4;font-weight:700;color:#15803d;font-size:12px;letter-spacing:.05em">NUEVA TARIFA LUMUX</td></tr>
          ${r('Compañía destino', `<strong style="color:#16a34a">${nueva_compania}</strong>`)}
          ${r('Tarifa', nueva_tarifa || '—', true)}
          ${r('Precio kWh P1/P2/P3', [p_kwh_p1,p_kwh_p2,p_kwh_p3].map(v => v !== '—' ? `${v}€` : '—').join(' · '))}
          ${r('Potencia P1/P2', [p_pot_p1,p_pot_p2].map(v => v !== '—' ? `${v}€/kW·día` : '—').join(' · '), true)}
          ${r('Cuota fija', p_fijo !== '—' ? `${p_fijo} €/mes` : '—')}
          ${r('Nuevo importe est.', precio_nuevo !== '—' ? `${Number(precio_nuevo).toFixed(2)} €/mes` : '—', true)}
          ${r('Ahorro estimado', `<strong style="color:#16a34a">${ahorro_anual}€/año (${pct_ahorro}%)</strong>`)}
        </table>
        <div style="padding:12px 16px;background:#fefce8;border-left:4px solid #eab308;font-size:13px;color:#713f12">
          📎 Adjuntos: DNI frontal · DNI trasero${facturaBuffer ? ` · <strong>${facturaFileName}</strong>` : ' · ⚠️ Factura no disponible'}
        </div>
        <div style="padding:10px 16px;font-size:11px;color:#9ca3af;border-top:1px solid #e5e7eb">
          Gestionado por <strong>Lumux AI</strong> · lumux.es · Ref. ${short_id || '—'}
        </div>
      </div>`,
      attachments: attachments.map(a => ({ filename: a.filename, content: a.content })),
    }, {
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }
    });

    console.log(`[Contrato] ✅ Email → ${emailDestino} | factura=${facturaBuffer ? 'adjunta' : 'NO'} | short_id=${short_id}`);

    // ─── 6. WhatsApp confirmación al cliente ──────────────────────────────
    let telefonoCliente = informeData?.telefono;
    if (!telefonoCliente && informeData?.usuario_id) {
      try {
        const { data: usuarioTel } = await db.supabase
          .from('usuarios').select('telefono').eq('id', informeData.usuario_id).single();
        if (usuarioTel?.telefono) {
          telefonoCliente = usuarioTel.telefono;
          console.log(`[Contrato] Telefono fallback de usuarios: ${telefonoCliente}`);
        }
      } catch(e) { console.warn('[Contrato] Telefono fallback error:', e.message); }
    }
    if (!telefonoCliente) console.warn('[Contrato] ⚠️ WA NO enviado: telefono no disponible');
    if (telefonoCliente) {
      try {
        const nombreCorto = (nombreReal).split(' ')[0] || '';
        await enviarMensajeWhatsApp(
          telefonoCliente,
          `✅ ¡Todo listo${nombreCorto ? ', ' + nombreCorto : ''}! Hemos enviado tu solicitud de cambio a ${nueva_compania}.\n\nRecibirás el contrato para firmar en menos de 24h en ${email}.\n\n¿Tienes alguna duda? Escríbenos aquí mismo 💬`
        );
        console.log(`[Contrato] WA confirmación enviado → ${telefonoCliente}`);
      } catch(e) { console.error('[Contrato] WA confirm error:', e.message); }
    }

      } catch(bgErr) {
        console.error('[Contrato] Error en background (email/WA/Meta):', bgErr.message);
      }
    }); // fin setImmediate (background)

  } catch (error) {
    console.error('[Contrato] Error:', error);
    if (!res.headersSent) res.status(500).json({ ok: false, error: error.message });
  }
});

// ─── /admin/exportar-leads ────────────────────────────────────────────────────
router.get('/admin/exportar-leads', async (req, res) => {
  try {
    const secret = req.query.secret || req.headers['x-admin-secret'];
    if (secret !== process.env.ADMIN_SECRET) {
      return res.status(401).json({ ok: false, error: 'No autorizado' });
    }

    const XLSX = require('xlsx');

    const ahora = new Date();
    const año   = parseInt(req.query.año  || ahora.getFullYear());
    const mes   = parseInt(req.query.mes  || (ahora.getMonth() + 1));
    const desde = new Date(año, mes - 1, 1).toISOString();
    const hasta = new Date(año, mes, 0, 23, 59, 59).toISOString(); // último día del mes

    // ─── CLASE 1: Ofertas firmadas en el periodo ──────────────────────────
    // Buscamos primero las ofertas firmadas en el mes
    const { data: ofertasFirmadas } = await db.supabase
      .from('ofertas')
      .select('id, fecha_firmado, ahorro_estimado, tarifas(compania, nombre_tarifa)')
      .eq('estado', 'firmada')
      .gte('fecha_firmado', desde)
      .lte('fecha_firmado', hasta);

    const ofertaIds = (ofertasFirmadas || []).map(o => o.id);
    const ofertaMap = {};
    (ofertasFirmadas || []).forEach(o => { ofertaMap[o.id] = o; });

    // Luego los informes ligados a esas ofertas
    const { data: informesFirmados } = ofertaIds.length > 0
      ? await db.supabase
          .from('informes')
          .select('nombre, telefono, dni, cups, compania_actual, nueva_compania, nueva_tarifa, consumo_kwh, potencia_kw, precio_actual_mes, ahorro_anual, pct_ahorro, usuario_id, oferta_id')
          .in('oferta_id', ofertaIds)
      : { data: [] };

    const { data: todosLosTitulares } = await db.supabase
      .from('titulares').select('usuario_id, email, cuenta_bancaria, dni_cif');
    const titMap = {};
    (todosLosTitulares || []).forEach(t => { titMap[t.usuario_id] = t; });

    const filas1 = (informesFirmados || []).map(inf => {
      const firma = ofertaMap[inf.oferta_id] || {};
      const tar   = Array.isArray(firma.tarifas) ? firma.tarifas[0] : firma.tarifas;
      const tit   = titMap[inf.usuario_id] || {};
      return {
        'Fecha firma':          firma.fecha_firmado ? new Date(firma.fecha_firmado).toLocaleDateString('es-ES') : '—',
        'Nombre titular':       inf.nombre || '—',
        'DNI / NIF':            inf.dni || tit.dni_cif || '—',
        'Teléfono':             inf.telefono || '—',
        'Email':                tit.email || '—',
        'IBAN':                 tit.cuenta_bancaria || '—',
        'CUPS':                 inf.cups || '—',
        'Compañía actual':      inf.compania_actual || '—',
        'Nueva compañía':       inf.nueva_compania || tar?.compania || '—',
        'Nueva tarifa':         inf.nueva_tarifa || tar?.nombre_tarifa || '—',
        'Consumo kWh':          inf.consumo_kwh || '—',
        'Potencia kW':          inf.potencia_kw || '—',
        'Factura actual €/mes': inf.precio_actual_mes || '—',
        'Ahorro anual €':       inf.ahorro_anual || firma.ahorro_estimado || '—',
        'Ahorro %':             inf.pct_ahorro || '—',
      };
    });

    // ─── CLASE 2: Informes del mes sin contrato firmado ────────────────────
    const { data: informesMes } = await db.supabase
      .from('informes')
      .select('nombre, telefono, dni, cups, compania_actual, nueva_compania, consumo_kwh, potencia_kw, precio_actual_mes, ahorro_anual, pct_ahorro, created_at, visto, fecha_visto, oferta_id')
      .gte('created_at', desde)
      .lte('created_at', hasta)
      .order('created_at', { ascending: false });

    const idsOfertasFirmadas = new Set(ofertaIds);
    const filas2 = (informesMes || [])
      .filter(inf => !inf.oferta_id || !idsOfertasFirmadas.has(inf.oferta_id))
      .map(inf => ({
        'Fecha análisis':       new Date(inf.created_at).toLocaleDateString('es-ES'),
        'Nombre':               inf.nombre || '—',
        'DNI / NIF':            inf.dni || '—',
        'Teléfono':             inf.telefono || '—',
        'CUPS':                 inf.cups || '—',
        'Compañía actual':      inf.compania_actual || '—',
        'Mejor oferta':         inf.nueva_compania || '—',
        'Consumo kWh':          inf.consumo_kwh || '—',
        'Potencia kW':          inf.potencia_kw || '—',
        'Factura actual €/mes': inf.precio_actual_mes || '—',
        'Ahorro anual €':       inf.ahorro_anual || '—',
        'Ahorro %':             inf.pct_ahorro || '—',
        'Vio el informe':       inf.visto ? 'Sí' : 'No',
        'Fecha visto':          inf.fecha_visto ? new Date(inf.fecha_visto).toLocaleDateString('es-ES') : '—',
      }));

    // ─── CLASE 3: Solo mensajes, sin factura ──────────────────────────────
    const { data: usuariosMes } = await db.supabase
      .from('usuarios')
      .select('id, nombre, telefono, estado, created_at')
      .gte('created_at', desde)
      .lte('created_at', hasta)
      .order('created_at', { ascending: false });

    const { data: facturasMes } = await db.supabase
      .from('facturas').select('usuario_id')
      .gte('created_at', desde).lte('created_at', hasta);
    const idsConFactura = new Set((facturasMes || []).map(f => f.usuario_id));

    const filas3 = (usuariosMes || [])
      .filter(u => !idsConFactura.has(u.id))
      .map(u => ({
        'Fecha entrada':  new Date(u.created_at).toLocaleDateString('es-ES'),
        'Nombre':         u.nombre || '—',
        'Teléfono':       u.telefono || '—',
        'Estado bot':     u.estado || '—',
      }));

    // ─── Generar Excel ─────────────────────────────────────────────────────
    const wb = XLSX.utils.book_new();
    const toSheet = (filas, fallback) =>
      XLSX.utils.json_to_sheet(filas.length > 0 ? filas : [{ 'Sin datos': fallback }]);

    XLSX.utils.book_append_sheet(wb, toSheet(filas1, `Sin firmas en ${mes}/${año}`), '✅ Clase1-Firmaron');
    XLSX.utils.book_append_sheet(wb, toSheet(filas2, `Sin leads en ${mes}/${año}`), '📋 Clase2-SinContratar');
    XLSX.utils.book_append_sheet(wb, toSheet(filas3, `Sin mensajes en ${mes}/${año}`), '💬 Clase3-SoloMensajes');

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const fileName = `lumux_leads_${año}_${String(mes).padStart(2,'0')}.xlsx`;

    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
    console.log(`[Admin] Excel: ${fileName} C1:${filas1.length} C2:${filas2.length} C3:${filas3.length}`);

  } catch (error) {
    console.error('[Admin] Error exportando leads:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

module.exports = router;