const Anthropic = require('@anthropic-ai/sdk');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT_BASE = `Eres Lumux AI, el agente comercial inteligente de Lumux, especializado en optimización de tarifas de luz y gas en España.

Tu misión es ayudar a los clientes a ahorrar en su factura y guiarles hacia la contratación de la mejor tarifa. Eres un agente comercial experto: seguro, amigable y orientado a cerrar. Respondes siempre en español, de forma concisa (máximo 3-4 líneas en WhatsApp). Nunca inventas datos.

IDENTIDAD:
- Eres Lumux AI, marca comercial de Lumux. Siempre.
- Solo si preguntan por la razón social: Fersan Energy SL.
- Solo si preguntan quién te creó: Alberto Fdez, fundador de Lumux.
- Nunca lo ofrezcas por iniciativa propia.

ROL DE AGENTE COMERCIAL:
- Cuando ya tienes el análisis de la factura, eres un comercial seguro que conoce los datos exactos del cliente.
- Si el cliente pregunta "¿tanto ahorro?", "¿es real?", "¿cómo lo calculas?" responde con SEGURIDAD y los datos reales del análisis. Nunca digas que los datos eran un ejemplo o que cometiste un error. Los datos son reales y provienen del análisis de su factura.
- Aprovecha cada pregunta del cliente para avanzar hacia la contratación. Si pregunta por el ahorro, confirma y pregunta si quiere contratar.
- Ejemplos de cierre: "¿Quieres que te preparemos el cambio? Es sin permanencia y en menos de 24h." / "¿Te llamamos para gestionarlo sin compromiso?"

CUANDO EL CLIENTE ENVÍE UNA FACTURA:
- Confirma brevemente que la recibes. Sin pedir confirmaciones innecesarias ni preguntar si la imagen se ve bien.
- No preguntes sobre autoconsumo ni placas solares a menos que la factura lo indique.

ATENCIÓN TELEFÓNICA:
- Si el cliente quiere hablar con alguien, dile que puede llamar a este mismo número de WhatsApp.

TEMAS AJENOS:
- Si preguntan sobre política, opiniones polémicas u otros temas, declina amablemente y redirige a las facturas.`;

// ─── RESPONDER MENSAJE ────────────────────────────────────────────────────────
// Inyecta el análisis de factura en el system prompt (no en el historial)
// para que Claude lo trate como verdad absoluta y no lo cuestione
async function responderMensaje(historial, mensajeUsuario) {
  let systemPrompt = SYSTEM_PROMPT_BASE;

  // Buscar el [ANÁLISIS FACTURA] más reciente e inyectarlo en el system
  const resumenAnalisis = [...historial]
    .reverse()
    .find(m => m.mensaje && m.mensaje.startsWith('[ANÁLISIS FACTURA]'));

  if (resumenAnalisis) {
    systemPrompt += `\n\nCONTEXTO REAL DE ESTA CONVERSACIÓN (datos ya calculados de la factura real del cliente, úsalos con total seguridad):\n${resumenAnalisis.mensaje}`;
  }

  // Filtrar los mensajes de resumen del historial para no duplicar ni confundir
  const messages = [
    ...historial
      .filter(m => !m.mensaje.startsWith('[ANÁLISIS FACTURA]'))
      .map(m => ({ role: m.rol, content: m.mensaje })),
    { role: 'user', content: mensajeUsuario }
  ];

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: systemPrompt,
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
  "precio_total": ⚠️ CRÍTICO: USA el subtotal de electricidad ANTES de descuentos promocionales temporales. Si la factura muestra líneas separadas como "PARA TI", "Descuento bienvenida", "Dto. fidelización", "Bonificación comercial" u otras FUERA del bloque estándar de Descuentos de tarifa, IGNÓRALAS COMPLETAMENTE. Usa el importe JUSTO antes de esas líneas adicionales. EJEMPLO: si aparece "TOTAL ELECTRICIDAD 46,59€" luego "PARA TI -20,00€" luego "TOTAL A PAGAR 32,37€", entonces precio_total = 46.59 (NO 32.37),
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
- precio_total: USA siempre el subtotal ANTES de descuentos promocionales tipo "PARA TI", "Bienvenida", "Dto. fidelización". Si ves "TOTAL 46,59€" → "PARA TI -20€" → "TOTAL A PAGAR 32,37€", precio_total = 46.59
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

// ─── COMPARATIVA DE LUZ ───────────────────────────────────────────────────────
async function generarComparativa(datosFactura, tarifas) {
  const diasFactura = datosFactura.dias_facturacion || 30;
  const factor = 30 / diasFactura;

  const consumoTotal = datosFactura.consumo_kwh || 0;
  const consumoP1    = datosFactura.consumo_p1_kwh || 0;
  const consumoP2    = datosFactura.consumo_p2_kwh || 0;
  const consumoP3    = datosFactura.consumo_p3_kwh || 0;
  const potencia     = datosFactura.potencia_kw || 4.4;
  const tieneTriperiodo = consumoP1 > 0 || consumoP2 > 0 || consumoP3 > 0;

  // Precio actual normalizado a 30 días (con todos los impuestos incluidos)
  const costeActualMes = (datosFactura.precio_total / (datosFactura.dias_facturacion || 30)) * 30;

  let mejorTarifa = null;
  let mejorAhorro = 0;
  let mejorCoste = 0;

  const tarifasFiltradas = tarifas.filter(t => {
    const minKw = t.potencia_min_kw || 0;
    const maxKw = t.potencia_max_kw || 15;
    return potencia >= minKw && potencia <= maxKw;
  });

  for (const tarifa of tarifasFiltradas) {
    let costeEnergia = 0;

    if (tieneTriperiodo && tarifa.precio_kwh_p1) {
      const p1Mes = consumoP1 * factor;
      const p2Mes = consumoP2 * factor;
      const p3Mes = consumoP3 * factor;
      costeEnergia =
        (p1Mes * tarifa.precio_kwh_p1) +
        (p2Mes * (tarifa.precio_kwh_p2 || tarifa.precio_kwh_p1)) +
        (p3Mes * (tarifa.precio_kwh_p3 || tarifa.precio_kwh_p1));
    } else {
      const consumoMes = consumoTotal * factor;
      costeEnergia = consumoMes * (tarifa.precio_kwh_p1 || tarifa.precio_kwh || 0);
    }

    const costePotencia = (tarifa.precio_kw_p1 || tarifa.precio_kw || 0) * potencia * 30;
    const costeFijo = tarifa.precio_fijo_mes || 0;

    let descuentoBV = 0;
    if ((datosFactura.tiene_autoconsumo || datosFactura.tiene_bateria_virtual) &&
        datosFactura.excedentes_kwh > 0 && tarifa.bateria_virtual) {
      const excedentesMes = datosFactura.excedentes_kwh * factor;
      descuentoBV = excedentesMes * (tarifa.compensacion_excedentes || 0.06);
    }

    // Añadir impuestos al coste nuevo (Impuesto Eléctrico 5.11% + IVA 21%)
    const costeTarifaSinImp = costeEnergia + costePotencia + costeFijo - descuentoBV;
    const costeTarifa = costeTarifaSinImp * 1.2611;
    const ahorro = costeActualMes - costeTarifa;

    if (ahorro > 3 && mejorTarifa === null) {
      mejorTarifa = tarifa;
      mejorAhorro = ahorro;
      mejorCoste = costeTarifa;
    }

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
    nombre:           nombre || '',
    compania:         datosFactura.compania || '',
    nueva_compania:   t.compania,
    nueva_tarifa:     t.nombre_tarifa,
    precio_actual:    d.precio_actual_mes,
    precio_nuevo_mes: d.precio_nuevo_mes,
    ahorro_anual:     d.ahorro_anual,
    consumo:          d.consumo_total,
    consumo_p1:       d.consumo_p1,
    consumo_p2:       d.consumo_p2,
    consumo_p3:       d.consumo_p3,
    potencia:         d.potencia,
    dias:             d.dias,
    precio_kwh_p1:    t.precio_kwh_p1 || '',
    precio_kwh_p2:    t.precio_kwh_p2 || '',
    precio_kwh_p3:    t.precio_kwh_p3 || '',
    pot_p1:           t.precio_kw_p1 || '',
    pot_p2:           t.precio_kw_p2 || '',
    wa:               telefono || process.env.WHATSAPP_PHONE_NUMBER || '955209158',
    url_contrato:     `${base}/contrato.html`,
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

// ─── RESUMEN PARA HISTORIAL ───────────────────────────────────────────────────
// Incluye TODOS los datos de la factura para que el bot pueda responder
// cualquier pregunta del cliente sobre su consumo, precios, potencia, etc.
function generarResumenHistorial(datosFactura, comparativa) {
  const f = datosFactura;

  // Datos completos de la factura actual
  const datosFacturaStr = [
    `Compañía: ${f.compania || 'desconocida'}`,
    `Fecha factura: ${f.fecha_factura || 'desconocida'}`,
    `Periodo facturado: ${f.dias_facturacion || 30} días`,
    `Tipo tarifa: ${f.tipo_tarifa || '2.0TD'}`,
    `CUPS: ${f.cups || 'no disponible'}`,
    `Potencia contratada: ${f.potencia_kw || 0} kW`,
    `Consumo total: ${f.consumo_kwh || 0} kWh`,
    f.consumo_p1_kwh ? `Consumo P1 (Punta): ${f.consumo_p1_kwh} kWh` : null,
    f.consumo_p2_kwh ? `Consumo P2 (Llano): ${f.consumo_p2_kwh} kWh` : null,
    f.consumo_p3_kwh ? `Consumo P3 (Valle): ${f.consumo_p3_kwh} kWh` : null,
    `Precio medio energía: ${f.precio_kwh || 0} €/kWh`,
    f.precio_kwh_p1 ? `Precio P1: ${f.precio_kwh_p1} €/kWh` : null,
    f.precio_kwh_p2 ? `Precio P2: ${f.precio_kwh_p2} €/kWh` : null,
    f.precio_kwh_p3 ? `Precio P3: ${f.precio_kwh_p3} €/kWh` : null,
    `Precio potencia: ${f.precio_potencia_dia || 0} €/kW/día`,
    `Importe energía: ${f.importe_energia || 0}€`,
    `Importe potencia: ${f.importe_potencia || 0}€`,
    `Total factura (con IVA): ${f.precio_total || 0}€`,
    f.tiene_autoconsumo ? `Autoconsumo: SÍ` : null,
    f.tiene_bateria_virtual ? `Batería virtual: SÍ` : null,
    f.excedentes_kwh ? `Excedentes: ${f.excedentes_kwh} kWh` : null,
    f.consumo_anual_estimado ? `Consumo anual estimado: ${f.consumo_anual_estimado} kWh` : null,
  ].filter(Boolean).join('. ');

  if (!comparativa || !comparativa.tarifa) {
    return `[ANÁLISIS FACTURA] ${datosFacturaStr}. RESULTADO: tarifa ya competitiva, no se encontró ahorro significativo.`;
  }

  const d = comparativa.datosComparativa;
  const t = comparativa.tarifa;

  const datosComparativaStr = [
    `Precio actual normalizado: ${d.precio_actual_mes}€/mes (${d.precio_actual_anual}€/año)`,
    `Tarifa recomendada: ${t.compania} - ${t.nombre_tarifa}`,
    `Precio nuevo: ${d.precio_nuevo_mes}€/mes (${d.precio_nuevo_anual}€/año)`,
    `Ahorro estimado: ${d.ahorro_anual}€/año (${d.pct_ahorro}% menos)`,
    t.precio_kwh_p1 ? `Nuevo precio P1: ${t.precio_kwh_p1} €/kWh` : null,
    t.precio_kwh_p2 ? `Nuevo precio P2: ${t.precio_kwh_p2} €/kWh` : null,
    t.precio_kwh_p3 ? `Nuevo precio P3: ${t.precio_kwh_p3} €/kWh` : null,
    t.precio_kw_p1 ? `Nueva potencia P1: ${t.precio_kw_p1} €/kW/día` : null,
    t.precio_fijo_mes ? `Cuota fija nueva tarifa: ${t.precio_fijo_mes}€/mes` : null,
  ].filter(Boolean).join('. ');

  return `[ANÁLISIS FACTURA] DATOS DE LA FACTURA ACTUAL: ${datosFacturaStr}. COMPARATIVA Y AHORRO: ${datosComparativaStr}. Cálculo basado en datos reales de la factura del cliente.`;
}

module.exports = {
  responderMensaje,
  analizarFactura,
  generarComparativa,
  generarUrlInforme,
  generarResumenHistorial,
  analizarFacturaGas,
  generarComparativaGas
};