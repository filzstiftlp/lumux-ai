/**
 * meta.js — Lumux AI · Meta Conversions API (CAPI)
 *
 * Eventos que envía:
 *   Lead        → cuando un usuario manda su primera factura y se genera informe
 *   Purchase    → cuando firma el contrato (conversión real)
 *
 * Variables de entorno necesarias en Railway:
 *   META_PIXEL_ID       → 1495964632242966
 *   META_ACCESS_TOKEN   → token de Events Manager › CAPI › Generar token
 *   META_PAGE_ID        → ID de la Facebook Page vinculada a tu WABA
 *                         (Meta Business → tu Página → Acerca de → ID de página)
 *
 * action_source dinámico (actualizado 21/04/2026 per recomendación Meta AI):
 *   - Si hay fbp o fbc (capturados desde informe.html) → "website" siempre.
 *     Meta prioriza cookies/clics para atribución y da mayor EMQ.
 *   - Si solo hay ctwa_clid y no hay datos web → "business_messaging".
 *   - Esta combinación maximiza la atribución en flujos Click-to-WhatsApp.
 *
 * Por qué ctwa_clid:
 *   Es el identificador único del clic en el anuncio. Meta lo incluye en
 *   el primer mensaje entrante del usuario (msg.referral.ctwa_clid).
 *   Sin él, Meta no puede vincular Lead/Purchase al anuncio que los originó.
 */

const crypto = require('crypto');
const axios  = require('axios');

const PIXEL_ID     = process.env.META_PIXEL_ID || '1495964632242966';
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const PAGE_ID      = process.env.META_PAGE_ID;   // Facebook Page ID — NO el Pixel ID
const CAPI_URL     = `https://graph.facebook.com/v19.0/${PIXEL_ID}/events`;

// ─── Utilidades ───────────────────────────────────────────────────────────────

/** SHA-256 normalizado — obligatorio para todos los datos personales en CAPI */
function hash(value) {
  if (!value) return undefined;
  return crypto
    .createHash('sha256')
    .update(String(value).trim().toLowerCase())
    .digest('hex');
}

/** Teléfono ES → formato E.164 sin '+' (ej: "955209158" → "34955209158") */
function normalizarTelefono(tel) {
  if (!tel) return undefined;
  const limpio = String(tel).replace(/\D/g, '');
  if (limpio.startsWith('34')) return limpio;
  if (limpio.length === 9)    return '34' + limpio;
  return limpio;
}

// ─── Envío genérico a CAPI ────────────────────────────────────────────────────

/**
 * @param {string}  eventName    — 'Lead' | 'Purchase'
 * @param {string}  telefono     — teléfono del usuario (sin +)
 * @param {string}  [email]      — email (solo Purchase)
 * @param {string}  [nombre]     — nombre completo del usuario
 * @param {number}  [valor]      — ahorro anual en € (value para Meta)
 * @param {string}  [moneda]     — EUR por defecto
 * @param {string}  [ctwaClid]   — ctwa_clid capturado del primer mensaje del anuncio
 * @param {object}  [customData] — campos adicionales de custom_data
 */
async function enviarEventoCAPI({ eventName, telefono, email, nombre, valor, moneda = 'EUR', ctwaClid, fbp, fbc, clientIp, clientUa, externalId, eventId, codigoPostal, ciudad, provincia, customData = {} }) {
  if (!PIXEL_ID || !ACCESS_TOKEN) {
    console.warn('[META CAPI] Faltan META_PIXEL_ID / META_ACCESS_TOKEN. Evento omitido.');
    return;
  }
  if (!PAGE_ID) {
    console.warn('[META CAPI] Falta META_PAGE_ID. El evento se enviará sin page_id — atribución reducida.');
  }

  // Separar nombre en fn (first name) y ln (last name)
  const partes = (nombre || '').trim().split(/\s+/);
  const fn = partes[0] || null;
  const ln = partes.length > 1 ? partes.slice(1).join(' ') : null;

  // ── user_data: campos de identidad (hashed) + campos de mensajería ──────────
  const userData = {
    // Datos personales — siempre hasheados
    // external_id: ID único del cliente (usuario.id de Supabase) — mejora EMQ +1.4 puntos
    ...(externalId ? { external_id: [hash(String(externalId))] } : {}),
    ph:      [hash(normalizarTelefono(telefono))].filter(Boolean),
    em:      [hash(email)].filter(Boolean),
    fn:      [hash(fn)].filter(Boolean),
    ln:      [hash(ln)].filter(Boolean),
    country: [hash('es')],

    // Campos específicos de business_messaging — NO se hashean
    // page_id: Facebook Page ID vinculada a la WABA (fijo, de env var)
    ...(PAGE_ID    ? { page_id:            PAGE_ID }    : {}),
    // ctwa_clid: click ID del anuncio CTWA
    ...(ctwaClid   ? { ctwa_clid:          ctwaClid }   : {}),
    // fbp: cookie Meta Pixel (_fbp) — mejora EMQ hasta +165%
    ...(fbp        ? { fbp }                            : {}),
    // fbc: click ID de Facebook (_fbc / fbclid)
    ...(fbc        ? { fbc }                            : {}),
    // IP y User Agent — mejora EMQ +33%
    ...(clientIp   ? { client_ip_address:  clientIp }   : {}),
    ...(clientUa   ? { client_user_agent:  clientUa }   : {}),
    // Localización (hashed) — código postal, ciudad, provincia — mejora EMQ +15% cada uno
    ...(codigoPostal ? { zp: [hash(String(codigoPostal).replace(/\s/g, ''))] } : {}),
    ...(ciudad       ? { ct: [hash(ciudad.trim().toLowerCase())]             } : {}),
    ...(provincia    ? { st: [hash(provincia.trim().toLowerCase())]          } : {}),
  };

  // ── action_source dinámico ──────────────────────────────────────────────────
  // Recomendación Meta AI (21/04/2026):
  // Si tenemos fbp o fbc (datos de navegador del informe.html) → SIEMPRE "website"
  // porque Meta prioriza coincidencia por cookies/clics y es más preciso para atribución.
  // Solo usar business_messaging si NO hay datos web y SÍ hay ctwa_clid.
  const tieneDatosWeb = !!(fbp || fbc);
  const usarMessaging = !tieneDatosWeb && !!ctwaClid;

  // Para business_messaging Meta exige nombres de evento específicos:
  //   "Lead" → "LeadSubmitted"   |   "Purchase" → "Purchase" (este sí es válido)
  const eventNameFinal = usarMessaging && eventName === 'Lead' ? 'LeadSubmitted' : eventName;

  const event = {
    event_name:  eventNameFinal,
    event_time:  Math.floor(Date.now() / 1000),
    // event_id: usado por Meta para deduplicación — SIEMPRE el mismo para reintentos
    ...(eventId ? { event_id: eventId } : {}),
    action_source:     usarMessaging ? 'business_messaging' : 'website',
    ...(usarMessaging ? { messaging_channel: 'whatsapp' } : {}),
    user_data:   userData,
    custom_data: {
      currency: moneda,
      ...customData,
      ...(valor !== undefined ? { value: valor } : {}),
    },
  };

  try {
    const res = await axios.post(
      CAPI_URL,
      { data: [event] },
      {
        params:  { access_token: ACCESS_TOKEN },
        headers: { 'Content-Type': 'application/json' },
      }
    );
    console.log(
      `[META CAPI] ✅ ${eventNameFinal} (${usarMessaging ? 'business_messaging' : 'website'}) → events_received:${res.data?.events_received}`,
      ctwaClid ? `| ctwa_clid:${ctwaClid.slice(0, 12)}...` : '| (sin ctwa_clid)'
    );
  } catch (err) {
    console.error(`[META CAPI] ❌ Error enviando ${eventName}:`, err.response?.data || err.message);
  }
}

// ─── Eventos públicos ─────────────────────────────────────────────────────────

/**
 * Lead — se llama cuando se genera el informe con ahorro.
 * Meta aprende qué perfil de usuario envía facturas y optimiza hacia él.
 *
 * @param {string} telefono   Teléfono del usuario (WhatsApp)
 * @param {string} nombre     Nombre del usuario
 * @param {number} ahorro     Ahorro anual estimado en € — se pasa como value
 * @param {string} [ctwaClid] Click ID del anuncio (de usuario.ctwa_clid en Supabase)
 */
async function enviarLead({ telefono, nombre, ahorro, ctwaClid, externalId, eventId,
                             fbp, fbc, clientIp, clientUa, codigoPostal, ciudad, provincia }) {
  await enviarEventoCAPI({
    eventName:  'Lead',
    telefono,
    nombre,
    ctwaClid,
    externalId,
    eventId,
    fbp,
    fbc,
    clientIp,
    clientUa,
    codigoPostal,
    ciudad,
    provincia,
    valor:      ahorro || 0,
    customData: {
      content_name: 'informe_ahorro_energia',
    },
  });
}

/**
 * Purchase — se llama cuando el cliente firma el contrato.
 * Es la conversión real que Meta necesita para salir de la fase de aprendizaje.
 *
 * @param {string} telefono     Teléfono del usuario
 * @param {string} email        Email del firmante
 * @param {string} nombre       Nombre del firmante
 * @param {number} ahorroAnual  Ahorro anual en € (value de conversión para Meta)
 * @param {string} compania     Compañía nueva contratada
 * @param {string} [ctwaClid]   Click ID del anuncio (de usuario.ctwa_clid en Supabase)
 */
async function enviarPurchase({ telefono, email, nombre, ahorroAnual, compania, ctwaClid, fbp, fbc, clientIp, clientUa, externalId, eventId }) {
  await enviarEventoCAPI({
    eventName:  'Purchase',
    telefono,
    email,
    nombre,
    ctwaClid,
    fbp,
    fbc,
    clientIp,
    clientUa,
    externalId,
    eventId,
    valor:      ahorroAnual || 0,
    customData: {
      content_name:     'contrato_firmado',
      content_category: 'energia',
      content_ids:      [compania || 'desconocida'],
    },
  });
}

/**
 * ConversacionIniciada — se llama cuando el usuario manda su PRIMER mensaje.
 * Cubre el tramo Clic → Conversación que Meta veía como agujero negro.
 * Para business_messaging el nombre válido es "InitiateCheckout" no existe,
 * Meta acepta "Contact" como evento estándar para conversación iniciada.
 *
 * @param {string} telefono   Teléfono del usuario
 * @param {string} nombre     Nombre del usuario
 * @param {string} [ctwaClid] Click ID del anuncio
 */
async function enviarConversacionIniciada({ telefono, nombre, ctwaClid, externalId, eventId }) {
  // Contact: si hay ctwa_clid (viene de anuncio CTWA) → business_messaging con ctwa_clid real.
  // Si no → website sin señales web (primer mensaje WhatsApp orgánico).
  // Pasar ctwaClid correctamente permite que Meta vincule el evento al clic del anuncio.
  await enviarEventoCAPI({
    eventName:  'Contact',
    telefono,
    nombre,
    ctwaClid,   // ← ya no se fuerza a null: si existe mejora atribución del anuncio
    externalId,
    eventId,
    customData: {
      content_name: 'conversacion_iniciada_whatsapp',
    },
  });
}

/**
 * ViewContent — se llama cuando el usuario abre su informe personalizado en el browser.
 * No cuenta como Lead (no infla conversiones), pero aporta fbp/fbc/IP/UA reales
 * que Meta usa para mejorar la coincidencia de identidad del Lead y Purchase previos.
 */
async function enviarViewContent({ telefono, nombre, ahorro, ctwaClid, externalId, eventId,
                                   fbp, fbc, clientIp, clientUa }) {
  await enviarEventoCAPI({
    eventName:  'ViewContent',
    telefono,
    nombre,
    ctwaClid,
    externalId,
    eventId,
    fbp,
    fbc,
    clientIp,
    clientUa,
    valor: ahorro || 0,
    customData: {
      content_name:     'informe_ahorro_energia',
      content_category: 'energia',
    },
  });
}

module.exports = { enviarLead, enviarPurchase, enviarConversacionIniciada, enviarViewContent };