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
 * Por qué business_messaging y no website:
 *   Los usuarios llegan vía Click-to-WhatsApp. Meta exige action_source:
 *   "business_messaging" + messaging_channel: "whatsapp" para atribuir
 *   correctamente los eventos a campañas de mensajería. Con "website"
 *   los eventos llegan huérfanos y no cierran el loop de atribución.
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
async function enviarEventoCAPI({ eventName, telefono, email, nombre, valor, moneda = 'EUR', ctwaClid, customData = {} }) {
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
    ph:      [hash(normalizarTelefono(telefono))].filter(Boolean),
    em:      [hash(email)].filter(Boolean),
    fn:      [hash(fn)].filter(Boolean),
    ln:      [hash(ln)].filter(Boolean),
    country: [hash('es')],

    // Campos específicos de business_messaging — NO se hashean
    // page_id: Facebook Page ID vinculada a la WABA (fijo, de env var)
    ...(PAGE_ID  ? { page_id:   PAGE_ID }  : {}),
    // ctwa_clid: click ID del anuncio CTWA — es lo que cierra el loop de atribución
    // Solo presente si el usuario llegó por un anuncio; se guarda en usuarios.ctwa_clid
    ...(ctwaClid ? { ctwa_clid: ctwaClid } : {}),
  };

  const event = {
    event_name:  eventName,
    event_time:  Math.floor(Date.now() / 1000),

    // ── CRÍTICO: canal correcto para campañas Click-to-WhatsApp ─────────────
    // action_source "business_messaging" → Meta sabe que viene de mensajería
    // messaging_channel "whatsapp"       → especifica el canal dentro de messaging
    // Sin estos dos campos los eventos no se atribuyen a campañas CTWA
    action_source:     'business_messaging',
    messaging_channel: 'whatsapp',

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
      `[META CAPI] ✅ ${eventName} → events_received:${res.data?.events_received}`,
      ctwaClid ? `| ctwa_clid:${ctwaClid.slice(0, 12)}...` : '| (sin ctwa_clid — usuario no vino de anuncio)'
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
async function enviarLead({ telefono, nombre, ahorro, ctwaClid }) {
  await enviarEventoCAPI({
    eventName:  'Lead',
    telefono,
    nombre,
    ctwaClid,
    valor:      ahorro || 0,   // value en Lead → Meta optimiza por valor desde el funnel alto
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
async function enviarPurchase({ telefono, email, nombre, ahorroAnual, compania, ctwaClid }) {
  await enviarEventoCAPI({
    eventName:  'Purchase',
    telefono,
    email,
    nombre,
    ctwaClid,
    valor:      ahorroAnual || 0,
    customData: {
      content_name:     'contrato_firmado',
      content_category: 'energia',
      content_ids:      [compania || 'desconocida'],
    },
  });
}

module.exports = { enviarLead, enviarPurchase };