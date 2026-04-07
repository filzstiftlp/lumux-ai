/**
 * tiktok.js — Lumux AI · TikTok Events API (server-side CAPI)
 *
 * Eventos que envía:
 *   Lead      → cuando se genera informe con ahorro (factura analizada)
 *   Purchase  → cuando el cliente firma el contrato
 *
 * Variables de entorno en Railway:
 *   TIKTOK_PIXEL_ID      → D7ABJOJC77U75VFH7VGG
 *   TIKTOK_ACCESS_TOKEN  → token generado en Events Manager paso 7
 */

const crypto = require('crypto');
const axios  = require('axios');

const PIXEL_ID    = process.env.TIKTOK_PIXEL_ID;
const ACCESS_TOKEN = process.env.TIKTOK_ACCESS_TOKEN;
const CAPI_URL    = 'https://business-api.tiktok.com/open_api/v1.3/event/track/';

// ─── Utilidades ───────────────────────────────────────────────────────────────

/** SHA-256 normalizado — obligatorio para datos personales en TikTok CAPI */
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

// ─── Envío genérico a TikTok Events API ──────────────────────────────────────

async function enviarEventoTikTok({ eventName, telefono, email, valor, properties = {} }) {
  if (!PIXEL_ID || !ACCESS_TOKEN) {
    console.warn('[TIKTOK CAPI] Variables TIKTOK_PIXEL_ID / TIKTOK_ACCESS_TOKEN no configuradas. Evento omitido.');
    return;
  }

  const telNormalizado = normalizarTelefono(telefono);

  const payload = {
    pixel_code: PIXEL_ID,
    event:      eventName,
    event_time: Math.floor(Date.now() / 1000),
    user: {
      phone_number: hash(telNormalizado),
      email:        hash(email),
    },
    properties: {
      currency: 'EUR',
      ...properties,
      ...(valor !== undefined ? { value: String(valor) } : {}),
    },
  };

  try {
    const res = await axios.post(
      CAPI_URL,
      payload,
      {
        headers: {
          'Access-Token':  ACCESS_TOKEN,
          'Content-Type':  'application/json',
        },
      }
    );
    console.log(`[TIKTOK CAPI] ✅ ${eventName} enviado →`, res.data);
  } catch (err) {
    console.error(`[TIKTOK CAPI] ❌ Error enviando ${eventName}:`, err.response?.data || err.message);
  }
}

// ─── Eventos públicos ─────────────────────────────────────────────────────────

/**
 * Lead — se llama cuando se genera el informe con ahorro.
 * TikTok aprende qué perfil de usuario envía facturas.
 *
 * @param {string} telefono   Teléfono del usuario (WhatsApp)
 * @param {number} ahorro     Ahorro anual estimado en €
 */
async function enviarLead({ telefono, ahorro }) {
  await enviarEventoTikTok({
    eventName: 'SubmitForm',   // TikTok usa SubmitForm como equivalente a Lead
    telefono,
    properties: {
      content_name: 'informe_ahorro_energia',
      ...(ahorro ? { value: String(Math.round(ahorro)) } : {}),
    },
  });
}

/**
 * Purchase — se llama cuando el cliente firma el contrato.
 * Es la conversión real que TikTok necesita para optimizar.
 *
 * @param {string} telefono     Teléfono del usuario
 * @param {string} email        Email del firmante
 * @param {number} ahorroAnual  Ahorro anual en € (valor de conversión)
 * @param {string} compania     Compañía nueva contratada
 */
async function enviarPurchase({ telefono, email, ahorroAnual, compania }) {
  await enviarEventoTikTok({
    eventName: 'Purchase',
    telefono,
    email,
    valor: ahorroAnual || 0,
    properties: {
      content_name:     'contrato_firmado',
      content_category: 'energia',
      content_id:       compania || 'desconocida',
    },
  });
}

module.exports = { enviarLead, enviarPurchase };
