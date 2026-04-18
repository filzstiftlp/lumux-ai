/**
 * meta.js — Lumux AI · Meta Conversions API (CAPI)
 *
 * Eventos que envía:
 *   LeadSubmitted → cuando un usuario manda su primera factura y se genera informe
 *   Purchase      → cuando firma el contrato (conversión real)
 *
 * Variables de entorno necesarias en Railway:
 *   META_DATASET_ID     → ID del Dataset (1495964632242966)
 *   META_ACCESS_TOKEN   → token generado en Events Manager › CAPI › Generar token
 *   META_WABA_ID        → WhatsApp Business Account ID (1641263713730018)
 */

const crypto = require('crypto');
const axios  = require('axios');

const DATASET_ID   = process.env.META_DATASET_ID || '1495964632242966';
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const WABA_ID      = process.env.META_WABA_ID;
const CAPI_URL     = `https://graph.facebook.com/v19.0/${DATASET_ID}/events`;

// ─── Utilidades ───────────────────────────────────────────────────────────────

/** SHA-256 normalizado — lo exige Meta para datos personales */
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

async function enviarEventoCAPI({ 
  eventName, 
  telefono, 
  email, 
  nombre, 
  ciudad,         // ← NUEVO: para mejor matching
  codigoPostal,   // ← NUEVO: para mejor matching
  ctwaClid,       // ← NUEVO: Click ID del anuncio de WhatsApp
  valor, 
  moneda = 'EUR', 
  customData = {} 
}) {
  if (!DATASET_ID || !ACCESS_TOKEN) {
    console.warn('[META CAPI] Variables META_DATASET_ID / META_ACCESS_TOKEN no configuradas. Evento omitido.');
    return;
  }

  // Separar nombre en fn (first name) y ln (last name) si es posible
  const partes = (nombre || '').trim().split(/\s+/);
  const fn = partes[0] || null;
  const ln = partes.length > 1 ? partes.slice(1).join(' ') : null;

  const userData = {
    ph: [hash(normalizarTelefono(telefono))].filter(Boolean),
    em: [hash(email)].filter(Boolean),
    fn: [hash(fn)].filter(Boolean),
    ln: [hash(ln)].filter(Boolean),
    ct: [hash(ciudad)].filter(Boolean),      // ← NUEVO: ciudad
    zp: [hash(codigoPostal)].filter(Boolean), // ← NUEVO: código postal
    country: [hash('es')],
  };

  // ← NUEVO: Añadir WABA_ID y ctwa_clid si están disponibles
  if (WABA_ID) {
    userData.whatsapp_business_account_id = WABA_ID;
  }
  if (ctwaClid) {
    userData.ctwa_clid = ctwaClid;  // ← CRÍTICO: mejora atribución 10x
  }

  const event = {
    event_name:        eventName,
    event_time:        Math.floor(Date.now() / 1000),
    action_source:     'business_messaging',  // eventos que ocurren via WhatsApp Business
    messaging_channel: 'whatsapp',            // identifica el canal como WhatsApp
    user_data:         userData,
    custom_data:       {
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
        params: { access_token: ACCESS_TOKEN },
        headers: { 'Content-Type': 'application/json' },
      }
    );
    console.log(`[META CAPI] ✅ ${eventName} enviado →`, res.data);
  } catch (err) {
    // No interrumpir el flujo principal si Meta falla
    console.error(`[META CAPI] ❌ Error enviando ${eventName}:`, err.response?.data || err.message);
  }
}

// ─── Eventos públicos ─────────────────────────────────────────────────────────

/**
 * LeadSubmitted — se llama cuando se genera el informe con ahorro.
 * Meta aprende quién envía facturas y qué perfil tiene.
 *
 * @param {string} telefono      Teléfono del usuario (WhatsApp)
 * @param {string} nombre        Nombre del usuario
 * @param {string} ciudad        Ciudad (opcional, mejora matching)
 * @param {string} codigoPostal  Código postal (opcional, mejora matching)
 * @param {string} ctwaClid      Click ID de anuncio WhatsApp (si viene de anuncio)
 * @param {number} ahorro        Ahorro anual estimado en €
 */
async function enviarLead({ telefono, nombre, ciudad, codigoPostal, ctwaClid, ahorro }) {
  await enviarEventoCAPI({
    eventName: 'LeadSubmitted',
    telefono,
    nombre,
    ciudad,
    codigoPostal,
    ctwaClid,
    customData: {
      content_name: 'informe_ahorro_energia',
      ...(ahorro ? { predicted_ltv: ahorro } : {}),
    },
  });
}

/**
 * Purchase — se llama cuando el cliente firma el contrato.
 * Es la conversión real que Meta necesita para optimizar.
 *
 * @param {string} telefono      Teléfono del usuario
 * @param {string} email         Email del firmante
 * @param {string} nombre        Nombre del firmante
 * @param {string} ciudad        Ciudad (opcional, mejora matching)
 * @param {string} codigoPostal  Código postal (opcional, mejora matching)
 * @param {string} ctwaClid      Click ID de anuncio WhatsApp (si viene de anuncio)
 * @param {number} ahorroAnual   Ahorro anual en € (valor de la conversión para Meta)
 * @param {string} compania      Compañía nueva contratada
 */
async function enviarPurchase({ telefono, email, nombre, ciudad, codigoPostal, ctwaClid, ahorroAnual, compania }) {
  await enviarEventoCAPI({
    eventName: 'Purchase',
    telefono,
    email,
    nombre,
    ciudad,
    codigoPostal,
    ctwaClid,
    valor: ahorroAnual || 0,   // Meta usa esto para optimizar por valor
    customData: {
      content_name:     'contrato_firmado',
      content_category: 'energia',
      content_ids:      [compania || 'desconocida'],
    },
  });
}

module.exports = { enviarLead, enviarPurchase };