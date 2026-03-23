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

function buildImageContent(base64Data, mediaType) {
  const normalizedType = mediaType === 'image/jpg' ? 'image/jpeg' : mediaType;
  if (normalizedType === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Data } };
  }
  return { type: 'image', source: { type: 'base64', media_type: normalizedType, data: base64Data } };
}

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
          text: `Analiza esta factura española de electricidad y extrae los datos en formato JSON.
Devuelve SOLO el JSON, sin texto adicional ni backticks.

CAMPOS REQUERIDOS:
{
  "tipo_suministro": "luz" o "gas",
  "compania": "nombre de la compañía",
  "fecha_factura": "YYYY-MM-DD",
  "dias_facturacion": número de días del periodo facturado,
  "consumo_kwh": consumo TOTAL en kWh (suma de todos los periodos P1+P2+P3 si los hay),
  "consumo_p1_kwh": kWh en periodo punta (P1) o null,
  "consumo_p2_kwh": kWh en periodo llano (P2) o null,
  "consumo_p3_kwh": kWh en periodo valle (P3) o null,
  "potencia_kw": potencia contratada en kW (P1),
  "precio_kwh": precio medio €/kWh = importe_total_energia / consumo_total_kwh,
  "precio_kwh_p1": precio €/kWh del periodo P1 o null,
  "precio_kwh_p2": precio €/kWh del periodo P2 o null,
  "precio_kwh_p3": precio €/kWh del periodo P3 o null,
  "precio_potencia_dia": precio €/kW/día de potencia (NO el importe total, sino el precio unitario diario),
  "importe_energia": importe total en € solo de energía (sin impuestos ni potencia),
  "importe_potencia": importe total en € solo de potencia (sin impuestos),
  "precio_total": importe TOTAL a pagar en € (con todos los impuestos incluidos),
  "cups": "código CUPS" o null,
  "tiene_autoconsumo": true o false,
  "tiene_bateria_virtual": true o false,
  "excedentes_kwh": kWh exportados o null,
  "compensacion_excedentes_importe": € de compensación o null,
  "tipo_tarifa": "2.0TD" o "3.0TD",
  "precio_fijo_mes": € fijo mensual o null,
  "consumo_anual_estimado": kWh anuales estimados o null
}

REGLAS IMPORTANTES:
- consumo_kwh: SIEMPRE suma P1+P2+P3 si hay periodos. Ejemplo: 298+205+367 = 870 kWh
- precio_kwh: DIVIDE importe_energia / consumo_kwh. NO uses precios de líneas individuales
- precio_potencia_dia: es el precio UNITARIO €/kW/día (ej: 0.097), NO el importe total (ej: NO pongas 18.56)
- precio_total: el importe final total de la factura incluyendo IVA e impuestos
- Si no aparece un dato, pon null`
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
  const diasFactura = datosFactura.dias_facturacion || 30;
  const diasMes = 30;
  const factor = diasMes / diasFactura;

  // Usar precio_total real como base del coste actual (normalizado a 30 días)
  // Excluimos impuestos aproximadamente (IVA 21% + IE 5.11% ≈ 26%)
  const precioTotalSinImpuestos = datosFactura.precio_total / 1.2611;
  const costeActualMes = precioTotalSinImpuestos * factor;

  const consumoMensual = datosFactura.consumo_kwh * factor;
  const potencia = datosFactura.potencia_kw || 4.4;
  const excedentes = datosFactura.excedentes_kwh || 0;

  let mejorTarifa = null;
  let mejorAhorro = 0;

  for (const tarifa of tarifas) {
    let costeEnergia;

    if (datosFactura.consumo_p1_kwh && tarifa.precio_kwh_p1) {
      const p1 = datosFactura.consumo_p1_kwh * factor;
      const p2 = (datosFactura.consumo_p2_kwh || 0) * factor;
      const p3 = (datosFactura.consumo_p3_kwh || 0) * factor;
      costeEnergia = (p1 * tarifa.precio_kwh_p1) +
                     (p2 * (tarifa.precio_kwh_p2 || tarifa.precio_kwh_p1)) +
                     (p3 * (tarifa.precio_kwh_p3 || tarifa.precio_kwh_p1));
    } else {
      costeEnergia = (tarifa.precio_kwh || 0) * consumoMensual;
    }

    const costePotencia = (tarifa.precio_kw_p1 || tarifa.precio_kw || 0) * potencia * diasMes;

    let descuentoExcedentes = 0;
    if ((datosFactura.tiene_autoconsumo || datosFactura.tiene_bateria_virtual) && excedentes > 0) {
      const excedentesMensuales = excedentes * factor;
      const precioCompensacion = tarifa.compensacion_excedentes || 0.06;
      descuentoExcedentes = excedentesMensuales * precioCompensacion;
    }

    const costeTarifa = costeEnergia + costePotencia - descuentoExcedentes;
    const ahorro = costeActualMes - costeTarifa;

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
Devuelve SOLO el JSON, sin texto adicional ni backticks:
{
  "tipo_suministro": "gas",
  "compania": "nombre de la compañía",
  "fecha_factura": "YYYY-MM-DD",
  "dias_facturacion": número,
  "consumo_kwh": número total de kWh,
  "precio_kwh": precio medio €/kWh = importe_energia / consumo_kwh,
  "precio_fijo_mes": € fijo mensual o null,
  "precio_total": importe total con IVA,
  "cups": "código CUPS o null",
  "consumo_anual_estimado": kWh anuales estimados o null
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
  const diasFactura = datosFactura.dias_facturacion || 30;
  const diasMes = 30;
  const factor = diasMes / diasFactura;

  const consumoMensual = datosFactura.consumo_kwh * factor;
  const consumoAnualEstimado = datosFactura.consumo_anual_estimado || (consumoMensual * 12);
  const segmento = determinarSegmentoGas(consumoAnualEstimado);

  // Coste actual normalizado desde precio_total real
  const precioTotalSinIVA = datosFactura.precio_total / 1.21;
  const costeActualMes = precioTotalSinIVA * factor;

  const tarifaCorrecta = tarifasGas.find(t => t.segmento === segmento);
  if (!tarifaCorrecta) return { mensaje: 'No hemos encontrado una tarifa de gas adecuada.', ahorro: 0, tarifa: null };

  const costeNuevo = (tarifaCorrecta.precio_kwh * consumoMensual) + (tarifaCorrecta.precio_fijo_mes || 0);
  const ahorroMensual = costeActualMes - costeNuevo;

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