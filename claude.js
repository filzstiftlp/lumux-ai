const Anthropic = require('@anthropic-ai/sdk');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `Eres Lumux AI, el asistente inteligente de Lumux (First Time Energy SL),
una empresa española especializada en optimización de tarifas de luz.

Tu objetivo es ayudar a los clientes a ahorrar en su factura de la luz.
Siempre respondes en español, de forma amigable y profesional.

Cuando el cliente te envíe una factura:
1. Extrae todos los datos relevantes (compañía, consumo kWh, potencia kW, precio kWh, precio potencia, total, días facturación, fecha)
2. Responde confirmando que la has recibido y que vas a analizarla
3. El sistema hará la comparativa automáticamente

Si el cliente hace preguntas sobre luz, tarifas o facturas, responde con conocimiento experto.
Sé conciso en WhatsApp (máximo 3-4 líneas por mensaje).
Nunca inventes datos. Si no sabes algo, dilo con honestidad.`;

// Responder a mensaje de texto con historial
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

// Analizar factura desde imagen o PDF (base64)
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
  "consumo_kwh": número,
  "potencia_kw": número,
  "precio_kwh": número (€/kWh),
  "precio_potencia": número (€/kW/día),
  "precio_total": número,
  "cups": "código CUPS si aparece",
  "items": [
    { "concepto": "Energía", "importe": número },
    { "concepto": "Potencia", "importe": número },
    { "concepto": "Impuesto eléctrico", "importe": número }
  ]
}
Si algún dato no aparece en la factura, pon null.`
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

// Generar texto de comparativa para enviar al cliente
async function generarComparativa(datosFactura, tarifas) {
  const mejorTarifa = tarifas.reduce((mejor, tarifa) => {
    const costeMensual = (datosFactura.consumo_kwh / 30 * tarifa.precio_kwh) +
                         (datosFactura.potencia_kw * tarifa.precio_kw);
    const costeActual  = (datosFactura.consumo_kwh / 30 * datosFactura.precio_kwh) +
                         (datosFactura.potencia_kw * datosFactura.precio_potencia);
    const ahorro = costeActual - costeMensual;
    return ahorro > (mejor.ahorro || 0) ? { ...tarifa, ahorro, costeMensual } : mejor;
  }, {});

  if (!mejorTarifa.ahorro || mejorTarifa.ahorro <= 0) {
    return { mensaje: '✅ Ya tienes una tarifa muy competitiva. ¡Estás pagando un precio justo!', ahorro: 0, tarifa: null };
  }

  const ahorroAnual = (mejorTarifa.ahorro * 12).toFixed(2);
  const mensaje = `💡 ¡Buenas noticias! Hemos analizado tu factura.

Con ${mejorTarifa.compania} (${mejorTarifa.nombre_tarifa}) podrías ahorrar:
💰 ~${ahorroAnual}€ al año

¿Quieres ver la comparativa completa?`;

  return { mensaje, ahorro: parseFloat(ahorroAnual), tarifa: mejorTarifa };
}

module.exports = { responderMensaje, analizarFactura, generarComparativa }; 
