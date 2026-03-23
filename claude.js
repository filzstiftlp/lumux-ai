const Anthropic = require('@anthropic-ai/sdk');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `Eres Lumux AI, el asistente inteligente de Lumux (First Time Energy SL),
una empresa española especializada en optimización de tarifas de luz.

Tu objetivo es ayudar a los clientes a ahorrar en su factura de la luz.
Siempre respondes en español, de forma amigable y profesional.

Cuando el cliente te envíe una factura:
1. Extrae todos los datos relevantes
2. Detecta si tiene batería virtual o compensación de excedentes
3. Confirma que la has recibido y que vas a analizarla

Si el cliente hace preguntas sobre luz, tarifas o facturas, responde con conocimiento experto.
Sé conciso en WhatsApp (máximo 3-4 líneas por mensaje).
Nunca inventes datos. Si no sabes algo, dilo con honestidad.`;

async function responderMensaje(historial, mensajeUsuario) {
  const messages = [
    ...historial.map(m => ({ role: m.rol, content: m.mensaje })),
    { role: 'user', content: mensajeUsuario }
  ];

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages
  });

  return response.content[0].text;
}

// FIX: Normaliza media_type y construye el content block correctamente según tipo
function buildImageContent(base64Data, mediaType) {
  // Normalizar image/jpg → image/jpeg
  const normalizedType = mediaType === 'image/jpg' ? 'image/jpeg' : mediaType;

  if (normalizedType === 'application/pdf') {
    // PDFs usan type: 'document'
    return {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: base64Data }
    };
  } else {
    // Imágenes usan type: 'image'
    return {
      type: 'image',
      source: { type: 'base64', media_type: normalizedType, data: base64Data }
    };
  }
}

// FIX: Limpia backticks de ```json ... ``` antes de parsear
function parseJSONSafe(text) {
  const clean = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(clean);
}

async function analizarFactura(base64Data, mediaType) {
  const imageContent = buildImageContent(base64Data, mediaType);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: [
        imageContent,
        {
          type: 'text',
          text: `Analiza esta factura española y extrae los datos en formato JSON.
Devuelve SOLO el JSON, sin texto adicional:
{
  "tipo_suministro": "luz" o "gas",
  "compania": "nombre de la compañía",
  "fecha_factura": "YYYY-MM-DD",
  "dias_facturacion": número,
  "consumo_kwh": número,
  "consumo_p1_kwh": número o null,
  "consumo_p2_kwh": número o null,
  "consumo_p3_kwh": número o null,
  "potencia_kw": número,
  "precio_kwh": número,
  "precio_potencia": número,
  "precio_total": número,
  "cups": "código CUPS o null",
  "tiene_autoconsumo": true o false,
  "tiene_bateria_virtual": true o false,
  "excedentes_kwh": número o null,
  "compensacion_excedentes_importe": número o null,
  "tipo_tarifa": "2.0TD" o "3.0TD",
  "precio_fijo_mes": número o null,
  "consumo_anual_estimado": número o null,
  "items": [
    { "concepto": "Energía", "importe": número },
    { "concepto": "Potencia", "importe": número },
    { "concepto": "Impuesto eléctrico", "importe": número }
  ]
}
IMPORTANTE:
- tipo_suministro: "gas" si ves gas natural, "luz" si es electricidad
- tiene_autoconsumo: true si hay paneles solares, compensación excedentes, energía exportada, solar cloud, batería virtual, o cualquier referencia a autoconsumo o generación propia
- tiene_bateria_virtual: true SOLO si el producto se llama explícitamente "batería virtual", "solar cloud" o similar
- excedentes_kwh: kWh exportados a la red si aparecen
- Si algún dato no aparece, pon null`
        }
      ]
    }]
  });

  try {
    return parseJSONSafe(response.content[0].text);
  } catch (e) {
    console.error('Error parseando factura:', e);
    return null;
  }
}

async function generarComparativa(datosFactura, tarifas) {
  const diasMes = 30;
  const consumoMensual = datosFactura.consumo_kwh / (datosFactura.dias_facturacion || 30) * diasMes;
  const potencia = datosFactura.potencia_kw || 4.4;
  const excedentes = datosFactura.excedentes_kwh || 0;

  const costeActual = (datosFactura.precio_kwh * consumoMensual) +
                      (datosFactura.precio_potencia * potencia * diasMes);

  let mejorTarifa = null;
  let mejorAhorro = 0;

  for (const tarifa of tarifas) {
    let costeEnergia;
    if (datosFactura.consumo_p1_kwh && tarifa.precio_kwh_p1) {
      const p1 = (datosFactura.consumo_p1_kwh / (datosFactura.dias_facturacion || 30) * diasMes);
      const p2 = (datosFactura.consumo_p2_kwh / (datosFactura.dias_facturacion || 30) * diasMes);
      const p3 = (datosFactura.consumo_p3_kwh / (datosFactura.dias_facturacion || 30) * diasMes);
      costeEnergia = (p1 * tarifa.precio_kwh_p1) +
                     (p2 * (tarifa.precio_kwh_p2 || tarifa.precio_kwh_p1)) +
                     (p3 * (tarifa.precio_kwh_p3 || tarifa.precio_kwh_p1));
    } else {
      costeEnergia = tarifa.precio_kwh * consumoMensual;
    }

    const costePotencia = (tarifa.precio_kw_p1 || tarifa.precio_kw) * potencia * diasMes;

    let descuentoExcedentes = 0;
    if ((datosFactura.tiene_autoconsumo || datosFactura.tiene_bateria_virtual) && excedentes > 0) {
      const excedentesMensuales = excedentes / (datosFactura.dias_facturacion || 30) * diasMes;
      const precioCompensacion = tarifa.compensacion_excedentes || 0.06;
      descuentoExcedentes = excedentesMensuales * precioCompensacion;
    }

    const costeTarifa = costeEnergia + costePotencia - descuentoExcedentes;
    const ahorro = costeActual - costeTarifa;

    if (ahorro > mejorAhorro) {
      mejorAhorro = ahorro;
      mejorTarifa = { ...tarifa, ahorro, costeMensual: costeTarifa };
    }
  }

  if (!mejorTarifa || mejorAhorro <= 0) {
    return {
      mensaje: '✅ Ya tienes una tarifa muy competitiva. ¡Estás pagando un precio justo!',
      ahorro: 0,
      tarifa: null
    };
  }

  const ahorroAnual = (mejorAhorro * 12).toFixed(2);
  let mensaje = `💡 ¡Buenas noticias! Hemos analizado tu factura de ${datosFactura.compania || 'tu compañía'}.

Con ${mejorTarifa.compania} (${mejorTarifa.nombre_tarifa}) podrías ahorrar:
💰 ~${ahorroAnual}€ al año`;

  if (mejorTarifa.bateria_virtual) {
    mensaje += `\n⚡ Incluye batería virtual con compensación a ${mejorTarifa.compensacion_excedentes}€/kWh`;
  }

  mensaje += `\n\n¿Quieres ver la comparativa completa?`;

  return { mensaje, ahorro: parseFloat(ahorroAnual), tarifa: mejorTarifa };
}

async function analizarFacturaGas(base64Data, mediaType) {
  const imageContent = buildImageContent(base64Data, mediaType);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: [
        imageContent,
        {
          type: 'text',
          text: `Analiza esta factura de GAS española y extrae los datos en formato JSON.
Devuelve SOLO el JSON, sin texto adicional:
{
  "tipo_suministro": "gas",
  "compania": "nombre de la compañía",
  "fecha_factura": "YYYY-MM-DD",
  "dias_facturacion": número,
  "consumo_kwh": número,
  "precio_kwh": número,
  "precio_fijo_mes": número,
  "precio_total": número,
  "cups": "código CUPS si aparece o null",
  "consumo_anual_estimado": número o null
}
Si algún dato no aparece, pon null.`
        }
      ]
    }]
  });

  try {
    return parseJSONSafe(response.content[0].text);
  } catch (e) {
    console.error('Error parseando factura gas:', e);
    return null;
  }
}

function determinarSegmentoGas(consumoAnualKwh) {
  if (!consumoAnualKwh || consumoAnualKwh <= 5000) return 'RL.1';
  if (consumoAnualKwh <= 15000) return 'RL.2';
  return 'RL.3';
}

async function generarComparativaGas(datosFactura, tarifasGas) {
  const diasMes = 30;
  const consumoMensual = datosFactura.consumo_kwh / (datosFactura.dias_facturacion || 30) * diasMes;
  const consumoAnualEstimado = datosFactura.consumo_anual_estimado || (consumoMensual * 12);
  const segmento = determinarSegmentoGas(consumoAnualEstimado);

  const tarifaCorrecta = tarifasGas.find(t => t.segmento === segmento);
  if (!tarifaCorrecta) return { mensaje: 'No hemos encontrado una tarifa de gas adecuada.', ahorro: 0, tarifa: null };

  const costeActual = (datosFactura.precio_kwh * consumoMensual) + (datosFactura.precio_fijo_mes || 0);
  const costeNuevo = (tarifaCorrecta.precio_kwh * consumoMensual) + tarifaCorrecta.precio_fijo_mes;
  const ahorroMensual = costeActual - costeNuevo;

  if (ahorroMensual <= 0) {
    return { mensaje: '✅ Ya tienes una tarifa de gas muy competitiva.', ahorro: 0, tarifa: null };
  }

  const ahorroAnual = (ahorroMensual * 12).toFixed(2);
  const mensaje = `💡 Hemos analizado tu factura de gas de ${datosFactura.compania || 'tu compañía'}.

Con Gana Energía (${tarifaCorrecta.nombre_tarifa}) podrías ahorrar:
💰 ~${ahorroAnual}€ al año

¿Quieres ver la comparativa completa?`;

  return { mensaje, ahorro: parseFloat(ahorroAnual), tarifa: tarifaCorrecta };
}

module.exports = {
  responderMensaje,
  analizarFactura,
  generarComparativa,
  analizarFacturaGas,
  generarComparativaGas
};