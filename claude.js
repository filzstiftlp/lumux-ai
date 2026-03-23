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
  "precio_potencia_dia": precio €/kW/día de potencia P1 (precio unitario, NO importe total),
  "precio_potencia_dia_p2": precio €/kW/día de potencia P2 o null,
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
- precio_potencia_dia: es el precio UNITARIO €/kW/día (ej: 0.097), NO el importe total
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

// ─── COMPARATIVA DE LUZ (con datos reales + orden por comisión) ───────────────
async function generarComparativa(datosFactura, tarifas) {
  const diasFactura = datosFactura.dias_facturacion || 30;
  const factor = 30 / diasFactura; // Normalizar a 30 días

  const consumoTotal = datosFactura.consumo_kwh || 0;
  const consumoP1    = datosFactura.consumo_p1_kwh || 0;
  const consumoP2    = datosFactura.consumo_p2_kwh || 0;
  const consumoP3    = datosFactura.consumo_p3_kwh || 0;
  const potencia     = datosFactura.potencia_kw || 4.4;
  const tieneTriperiodo = consumoP1 > 0 || consumoP2 > 0 || consumoP3 > 0;

  // Coste actual real normalizado a 30 días (sin impuestos: IVA 21% + IE 5.11% ≈ x1.2611)
  const precioTotalSinImpuestos = datosFactura.precio_total / 1.2611;
  const costeActualMes = precioTotalSinImpuestos * factor;

  // Las tarifas ya vienen ordenadas por orden_comision ASC desde la query
  // Buscamos la primera (mayor comisión) que produzca ahorro real para el cliente
  let mejorTarifa = null;
  let mejorAhorro = 0;
  let mejorCoste = 0;

  // Filtrar tarifas por potencia del cliente
  const tarifasFiltradas = tarifas.filter(t => {
    const minKw = t.potencia_min_kw || 0;
    const maxKw = t.potencia_max_kw || 15;
    return potencia >= minKw && potencia <= maxKw;
  });

  for (const tarifa of tarifasFiltradas) {
    // ── Calcular coste energía con precios REALES de la tarifa ──
    let costeEnergia = 0;

    if (tieneTriperiodo && tarifa.precio_kwh_p1) {
      // Usar consumos reales por periodo
      const p1Mes = consumoP1 * factor;
      const p2Mes = consumoP2 * factor;
      const p3Mes = consumoP3 * factor;
      costeEnergia =
        (p1Mes * tarifa.precio_kwh_p1) +
        (p2Mes * (tarifa.precio_kwh_p2 || tarifa.precio_kwh_p1)) +
        (p3Mes * (tarifa.precio_kwh_p3 || tarifa.precio_kwh_p1));
    } else {
      // Tarifa plana o no tenemos desglose por periodos
      const consumoMes = consumoTotal * factor;
      costeEnergia = consumoMes * (tarifa.precio_kwh_p1 || tarifa.precio_kwh || 0);
    }

    // ── Calcular coste potencia con precios REALES ──
    const costePotencia =
      (tarifa.precio_kw_p1 || tarifa.precio_kw || 0) * potencia * 30;

    // ── Coste fijo mensual (mantenimiento, etc.) ──
    const costeFijo = tarifa.precio_fijo_mes || 0;

    // ── Descuento batería virtual si aplica ──
    let descuentoBV = 0;
    if ((datosFactura.tiene_autoconsumo || datosFactura.tiene_bateria_virtual) &&
        datosFactura.excedentes_kwh > 0 && tarifa.bateria_virtual) {
      const excedentesMes = datosFactura.excedentes_kwh * factor;
      descuentoBV = excedentesMes * (tarifa.compensacion_excedentes || 0.06);
    }

    const costeTarifa = costeEnergia + costePotencia + costeFijo - descuentoBV;
    const ahorro = costeActualMes - costeTarifa;

    // Tomamos la primera tarifa (mayor comisión) que genere ahorro > 3€/mes
    if (ahorro > 3 && mejorTarifa === null) {
      mejorTarifa = tarifa;
      mejorAhorro = ahorro;
      mejorCoste = costeTarifa;
    }

    // Si ninguna con comisión alta ahorra, guardamos la que más ahorra
    if (ahorro > mejorAhorro && mejorTarifa === null) {
      mejorAhorro = ahorro;
      mejorCoste = costeTarifa;
      mejorTarifa = tarifa;
    }
  }

  if (!mejorTarifa || mejorAhorro <= 0) {
    return {
      mensaje: '✅ Ya tienes una tarifa muy competitiva. ¡Estás pagando un precio justo!',
      ahorro: 0,
      tarifa: null,
      datosComparativa: null
    };
  }

  const ahorroAnual = parseFloat((mejorAhorro * 12).toFixed(2));
  const precioNuevoMes = parseFloat(mejorCoste.toFixed(2));
  const precioActualAnual = parseFloat((costeActualMes * 12).toFixed(2));
  const pctAhorro = Math.round((mejorAhorro / costeActualMes) * 100);

  let mensaje = `💡 ¡Buenas noticias! Hemos analizado tu factura de ${datosFactura.compania || 'tu compañía'}.

Con ${mejorTarifa.compania} podrías ahorrar:
💰 ~${ahorroAnual}€ al año (${pctAhorro}% menos)`;

  if (mejorTarifa.bateria_virtual) {
    mensaje += `\n⚡ Incluye batería virtual con compensación a ${mejorTarifa.compensacion_excedentes}€/kWh`;
  }

  mensaje += `\n\n👇 Tu informe personalizado:`;

  return {
    mensaje,
    ahorro: ahorroAnual,
    tarifa: mejorTarifa,
    datosComparativa: {
      precio_actual_mes: parseFloat(costeActualMes.toFixed(2)),
      precio_nuevo_mes: precioNuevoMes,
      precio_actual_anual: precioActualAnual,
      precio_nuevo_anual: parseFloat((precioNuevoMes * 12).toFixed(2)),
      ahorro_anual: ahorroAnual,
      pct_ahorro: pctAhorro,
      consumo_p1: consumoP1,
      consumo_p2: consumoP2,
      consumo_p3: consumoP3,
      consumo_total: consumoTotal,
      dias: diasFactura,
      potencia,
    }
  };
}

// ─── GENERAR URL DEL INFORME ──────────────────────────────────────────────────
function generarUrlInforme(nombre, telefono, datosFactura, comparativa) {
  const base = process.env.WEB_URL || 'https://lumux.es';
  const t = comparativa.tarifa;
  const d = comparativa.datosComparativa;

  const params = new URLSearchParams({
    nombre:            nombre || '',
    compania:          datosFactura.compania || '',
    nueva_compania:    t.compania,
    nueva_tarifa:      t.nombre_tarifa,
    precio_actual:     d.precio_actual_mes,
    precio_nuevo_mes:  d.precio_nuevo_mes,
    ahorro_anual:      d.ahorro_anual,
    consumo:           d.consumo_total,
    consumo_p1:        d.consumo_p1,
    consumo_p2:        d.consumo_p2,
    consumo_p3:        d.consumo_p3,
    potencia:          d.potencia,
    dias:              d.dias,
    precio_kwh_p1:     t.precio_kwh_p1 || '',
    precio_kwh_p2:     t.precio_kwh_p2 || '',
    precio_kwh_p3:     t.precio_kwh_p3 || '',
    pot_p1:            t.precio_kw_p1 || '',
    pot_p2:            t.precio_kw_p2 || '',
    wa:                telefono || process.env.WHATSAPP_PHONE_NUMBER || '955209158',
    url_contrato:      `${base}/contrato.html`,
  });

  return `${base}/informe.html?${params.toString()}`;
}

// ─── ANÁLISIS DE FACTURA DE GAS ───────────────────────────────────────────────
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
  const factor = 30 / diasFactura;

  const consumoMensual = datosFactura.consumo_kwh * factor;
  const consumoAnualEstimado = datosFactura.consumo_anual_estimado || (consumoMensual * 12);
  const segmento = determinarSegmentoGas(consumoAnualEstimado);

  const precioTotalSinIVA = datosFactura.precio_total / 1.21;
  const costeActualMes = precioTotalSinIVA * factor;

  const tarifaCorrecta = tarifasGas.find(t => t.segmento === segmento);
  if (!tarifaCorrecta) return { mensaje: 'No hemos encontrado una tarifa de gas adecuada.', ahorro: 0, tarifa: null };

  const costeNuevo = (tarifaCorrecta.precio_kwh * consumoMensual) + (tarifaCorrecta.precio_fijo_mes || 0);
  const ahorroMensual = costeActualMes - costeNuevo;

  if (ahorroMensual <= 0) {
    return { mensaje: '✅ Ya tienes una tarifa de gas muy competitiva.', ahorro: 0, tarifa: null };
  }

  const ahorroAnual = parseFloat((ahorroMensual * 12).toFixed(2));
  const mensaje = `💡 Hemos analizado tu factura de gas de ${datosFactura.compania || 'tu compañía'}.

Con Gana Energía (${tarifaCorrecta.nombre_tarifa}) podrías ahorrar:
💰 ~${ahorroAnual}€ al año

¿Quieres ver la comparativa completa?`;

  return { mensaje, ahorro: ahorroAnual, tarifa: tarifaCorrecta };
}

module.exports = {
  responderMensaje,
  analizarFactura,
  generarComparativa,
  generarUrlInforme,
  analizarFacturaGas,
  generarComparativaGas
};