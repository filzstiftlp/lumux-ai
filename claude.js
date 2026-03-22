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

async function analizarFactura(base64Data, mediaType) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: base64Data }
        },
        {
          type: 'text',
          text: `Analiza esta factura de luz española y extrae los datos en formato JSON.
Devuelve SOLO el JSON, sin texto adicional, con esta estructura:
{
  "compania": "nombre de la compañía",
  "fecha_factura": "YYYY-MM-DD",
  "dias_facturacion": número,
  "consumo_kwh": número (total consumo),
  "consumo_p1_kwh": número o null (consumo punta),
  "consumo_p2_kwh": número o null (consumo llano),
  "consumo_p3_kwh": número o null (consumo valle),
  "potencia_kw": número,
  "precio_kwh": número (precio medio €/kWh),
  "precio_potencia": número (€/kW/día),
  "precio_total": número,
  "cups": "código CUPS si aparece o null",
  "tiene_bateria_virtual": true o false,
  "excedentes_kwh": número o null (kWh exportados si tiene batería virtual),
  "compensacion_excedentes_importe": número o null,
  "tipo_tarifa": "2.0TD" o "3.0TD",
  "items": [
    { "concepto": "Energía", "importe": número },
    { "concepto": "Potencia", "importe": número },
    { "concepto": "Impuesto eléctrico", "importe": número }
  ]
}
Si algún dato no aparece en la factura, pon null.
Para batería virtual: busca conceptos como "compensación excedentes", "batería virtual", "solar cloud", "energía exportada".`
        }
      ]
    }]
  });

  try {
    return JSON.parse(response.content[0].text);
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

  // Coste actual del cliente
  const costeActual = (datosFactura.precio_kwh * consumoMensual) +
                      (datosFactura.precio_potencia * potencia * diasMes);

  let mejorTarifa = null;
  let mejorAhorro = 0;

  for (const tarifa of tarifas) {
    // Si tiene batería virtual, solo comparar con tarifas que la incluyan
    if (datosFactura.tiene_bateria_virtual && !tarifa.bateria_virtual) continue;

    // Calcular coste con esta tarifa
    let costeEnergia;
    if (datosFactura.consumo_p1_kwh && tarifa.precio_kwh_p1) {
      // Cálculo detallado por periodos
      const p1 = (datosFactura.consumo_p1_kwh / (datosFactura.dias_facturacion || 30) * diasMes);
      const p2 = (datosFactura.consumo_p2_kwh / (datosFactura.dias_facturacion || 30) * diasMes);
      const p3 = (datosFactura.consumo_p3_kwh / (datosFactura.dias_facturacion || 30) * diasMes);
      costeEnergia = (p1 * tarifa.precio_kwh_p1) + (p2 * (tarifa.precio_kwh_p2 || tarifa.precio_kwh_p1)) + (p3 * (tarifa.precio_kwh_p3 || tarifa.precio_kwh_p1));
    } else {
      costeEnergia = tarifa.precio_kwh * consumoMensual;
    }

    const costePotencia = (tarifa.precio_kw_p1 || tarifa.precio_kw) * potencia * diasMes;

    // Descuento por batería virtual
    let descuentoBateria = 0;
    if (tarifa.bateria_virtual && tarifa.compensacion_excedentes && excedentes > 0) {
      const excedentesMensuales = excedentes / (datosFactura.dias_facturacion || 30) * diasMes;
      descuentoBateria = excedentesMensuales * tarifa.compensacion_excedentes;
    }

    const costeTarifa = costeEnergia + costePotencia - descuentoBateria;
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

module.exports = { responderMensaje, analizarFactura, generarComparativa };