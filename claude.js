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
- Aprovecha cada pregunta del cliente para avanzar hacia la contratación.

CÓMO CERRAR LA CONTRATACIÓN — MUY IMPORTANTE:
- Cuando el cliente quiera contratar o muestre intención, NUNCA pidas datos por el chat (email, IBAN, DNI, etc.).
- Dile siempre que rellene sus datos en el informe personalizado que ya le enviaste. Ejemplo: "Solo tienes que rellenar tus datos en el informe que te envié 👆 En menos de 2 minutos está gestionado."
- Si no tiene el enlace a mano, dile que busque el mensaje anterior con el botón del informe, o que reenvíe su factura para generarle uno nuevo.
- Una vez el cliente rellena el informe, nosotros lo tramitamos todo. No necesita hacer nada más.

FORMATO DE PRECIOS — MUY IMPORTANTE:
- Expresa SIEMPRE los precios de energía en €/kWh con 4 decimales. Ejemplo: "0.1199 €/kWh".
- NUNCA uses "céntimos/kWh" — confunde al cliente y da sensación de precio alto.
- Para el ahorro usa siempre €/año y €/mes, no solo porcentajes. Ejemplo: "492€ al año (10% menos)".
- Si el ahorro parece pequeño en %, arguméntalo en €/año o comparando precios por kWh: "pagas 0.1279 €/kWh vs tu tarifa actual".
- POTENCIA — CRÍTICO: NUNCA cites el precio unitario €/kW/día de un solo periodo (P1 o P2) porque confunde. Habla siempre del COSTE MENSUAL TOTAL de potencia que aparece en el contexto como "Coste potencia actual (P1+P2 mes completo)". NUNCA calcules este importe por tu cuenta — usa SIEMPRE el dato que aparece en el contexto de la factura. Si el contexto dice "Coste potencia actual: 19.52€/mes", di exactamente 19.52€/mes, no hagas ningún cálculo propio.

PERMANENCIA:
- Tanto Iberdrola Impulsa 24h como Gana Energía Tarifa Luz Fija 24h son SIN PERMANENCIA.
- Si el cliente pregunta, confirma que puede cancelar cuando quiera sin coste ni penalización.

CUANDO EL CLIENTE ENVÍE UNA FACTURA:
- Confirma brevemente que la recibes. Sin pedir confirmaciones innecesarias ni preguntar si la imagen se ve bien.
- No preguntes sobre autoconsumo ni placas solares a menos que la factura lo indique.

CUPS (Código Universal del Punto de Suministro):
- Es el identificador único del suministro eléctrico o de gas. Empieza por ES y tiene 20-22 caracteres.
- Si en el contexto de la conversación ya tienes el CUPS del cliente, úsalo siempre que sea relevante.
- Si el cliente ya tiene un contrato activo gestionado por Lumux para ese CUPS, NO ofrezcas cambio de tarifa. Infórmale de que ya está gestionado y derívale a llamarnos.
- Si el cliente ya tiene una contratación en trámite (oferta firmada), infórmale del estado y que en menos de 24h recibirá el contrato.

DESPUÉS DE LA CONTRATACIÓN:
- Si el cliente pregunta por el estado de su contrato, dile que el equipo ya lo está tramitando y que recibirá el contrato en su email en menos de 24h.
- Si tiene dudas post-firma, derívale siempre a llamar al número de WhatsApp donde será atendido por un asesor.
- Nunca prometas fechas exactas de activación, solo "en los próximos días hábiles".

ATENCIÓN TELEFÓNICA:
- Si el cliente quiere hablar con alguien, dile que puede llamar a este mismo número de WhatsApp.

FORMATO DE RESPUESTA — CRÍTICO:
- NUNCA pongas asteriscos, negritas ni markdown alrededor de URLs o enlaces. Un enlace debe ir solo, sin ** ni __ ni ningún símbolo. Ejemplo correcto: "https://lumux.es/informe.html?id=xxx". Ejemplo incorrecto: "**https://lumux.es/informe.html?id=xxx**".
- Los enlaces deben ir siempre en su propia línea, sin ningún símbolo antes ni después.

TEMAS AJENOS:
- Si el cliente pregunta algo fuera de tu área (matemáticas, recetas, noticias, deportes, política...), respóndele con humor y chispa antes de redirigirle. Nunca seas cortante ni robótico.
- Ejemplos de tono que puedes adaptar al contexto:
  * Si pregunta "2+2" → "¡4! 😄 Aunque donde de verdad brillo es calculando cuánto te sobra en la factura de la luz. ¿Me envías la tuya? 💡"
  * Si pregunta de cocina → "Eso me supera… ¡pero sí sé cocinar un buen ahorro en tu factura! 🍳⚡ Mándame tu última factura."
  * Si pregunta de fútbol → "Del fútbol no entiendo mucho, pero de meter goles en tu factura de la luz… ahí soy el mejor del vestuario 😏 ¿Me envías tu factura?"
- Siempre remata redirigiendo al envío de la factura.

CLIENTES CON DESCUENTO CONTRACTUAL — MUY IMPORTANTE:
Cuando el contexto indique que el cliente tiene un DESCUENTO CONTRACTUAL sobre la energía (ej: "10% DTO fidelización"), usa este argumento comercial con seguridad:

1. PRECIO BASE MÁS BARATO SIN DEPENDER DEL DESCUENTO: Su descuento actual es temporal o puede desaparecer si cambian las condiciones del contrato. La nueva tarifa le ofrece un precio base competitivo que no depende de ningún descuento ni condición externa. Es una mejora estructural, no un parche.

2. EL AHORRO REAL VIENE DE LA POTENCIA: En muchas facturas con descuento en energía, la gran diferencia está en el término de potencia. Explica específicamente: "El ahorro principal viene de que tu actual compañía te cobra más caro en potencia. Con [nueva tarifa] reduces ese coste fijo mensual, que pagas siempre, consumas lo que consumas."

3. NO TE QUEDES ATASCADO EN EL €/KWH: Si el cliente dice "pero con mi descuento tengo el kWh más barato", NO CEDAS. Responde: "Sí, ahora con el descuento estás en un precio similar, pero el ahorro total viene de la combinación: potencia más barata + precio base garantizado sin depender de descuentos. Si ese descuento desaparece, pasas a pagar mucho más. Con nosotros el precio es fijo."

4. ARGUMENTO DE SEGURIDAD: "Los descuentos de fidelización los ponen las compañías para retenerte, pero pueden quitarlos. Con Lumux tienes un precio base competitivo sin letra pequeña."

NUNCA digas al cliente que "no tiene ahorro" si el informe muestra ahorro real calculado sobre su factura completa. Defiende el ahorro con los datos reales.`;

// ─── RESPONDER MENSAJE ────────────────────────────────────────────────────────

// ─── RESPONDER MENSAJE ────────────────────────────────────────────────────────
async function responderMensaje(historial, mensajeUsuario, contratosCtx = null, usuario = null) {
  let systemPrompt = SYSTEM_PROMPT_BASE;

  // Buscar el [ANÁLISIS FACTURA] más reciente e inyectarlo en el system
  const resumenAnalisis = [...historial]
    .reverse()
    .find(m => m.mensaje && m.mensaje.startsWith('[ANÁLISIS FACTURA]'));

  if (resumenAnalisis) {
    let resumen = resumenAnalisis.mensaje;

    // Si el resumen no tiene el desglose de potencia (resúmenes antiguos),
    // intentar enriquecerlo con datos de la factura guardada en BD
    if (!resumen.includes('DESGLOSE AHORRO') && usuario?.id) {
      try {
        const { data: facturas } = await require('./db').supabase
          .from('facturas')
          .select('raw_texto_ocr, precio_total, potencia_kw')
          .eq('usuario_id', usuario.id)
          .order('created_at', { ascending: false })
          .limit(1);
        if (facturas?.[0]?.raw_texto_ocr) {
          const ocr = JSON.parse(facturas[0].raw_texto_ocr);
          if (ocr.importe_potencia) {
            resumen += `\nDESGLOSE AHORRO — USA ESTOS NÚMEROS EXACTOS, NUNCA CALCULES POR TU CUENTA:\n• Potencia actual (${ocr.compania || 'compañía actual'}): ${ocr.importe_potencia}€/mes (dato real de la factura)\n• NUNCA uses ningún otro número para la potencia actual del cliente`;
          }
        }
      } catch(e) { /* silencioso */ }
    }

    systemPrompt += `\n\nCONTEXTO REAL DE ESTA CONVERSACIÓN (datos ya calculados de la factura real del cliente, úsalos con total seguridad):\n${resumen}`;
  }

  // ─── CONTEXTO DE SUMINISTROS CONTRATADOS CON LUMUX ───────────────────────
  // Incluye TODOS los suministros del teléfono, aunque sean de titulares distintos
  if (contratosCtx && (contratosCtx.contratos?.length || contratosCtx.informes?.length)) {
    let ctx = '\n\nSUMINISTROS GESTIONADOS POR LUMUX PARA ESTE TELÉFONO:\n';

    if (contratosCtx.contratos?.length) {
      ctx += '\nCONTRATOS ACTIVOS:\n';
      contratosCtx.contratos.forEach((c, i) => {
        const cups = c.propiedades?.cups || '—';
        const dir  = c.propiedades?.direccion || '—';
        ctx += `  ${i+1}. Compañía: ${c.compania} | CUPS: ${cups} | Dirección: ${dir} | Estado: ${c.estado} | Fecha: ${c.fecha_contrato ? new Date(c.fecha_contrato).toLocaleDateString('es-ES') : '—'}\n`;
      });
    }

    const informesFirmados = (contratosCtx.informes || []).filter(inf => inf.ofertas?.estado === 'firmada');
    const informesPendientes = (contratosCtx.informes || []).filter(inf => inf.ofertas?.estado !== 'firmada');

    if (informesFirmados.length) {
      ctx += '\nCONTRATACIONES EN TRÁMITE (oferta firmada, pendiente de activación):\n';
      informesFirmados.forEach((inf, i) => {
        ctx += `  ${i+1}. De ${inf.compania_actual} → ${inf.nueva_compania} (${inf.nueva_tarifa || '—'}) | CUPS: ${inf.cups || '—'} | Ahorro: ${inf.ahorro_anual ? Math.round(inf.ahorro_anual)+'€/año' : '—'} | Firmado: ${inf.ofertas?.fecha_firmado ? new Date(inf.ofertas.fecha_firmado).toLocaleDateString('es-ES') : '—'}\n`;
      });
    }

    if (informesPendientes.length) {
      ctx += '\nINFORMES ENVIADOS SIN FIRMAR AÚN:\n';
      informesPendientes.slice(0, 3).forEach((inf, i) => {
        ctx += `  ${i+1}. De ${inf.compania_actual} → ${inf.nueva_compania} | CUPS: ${inf.cups || '—'} | Ahorro: ${inf.ahorro_anual ? Math.round(inf.ahorro_anual)+'€/año' : '—'}\n`;
      });
    }

    ctx += '\nIMPORTANTE: Si el cliente pregunta cuántos suministros tiene contratados con Lumux, usa SOLO los datos de arriba. No mezcles datos entre suministros distintos. Cada CUPS es un suministro independiente.';
    systemPrompt += ctx;
  }

  // Contexto temporal de contratacion (trigger 24h firma)
  const msgContrato = [...historial].reverse().find(m => m.mensaje && m.mensaje.startsWith('[CONTRATO]'));
  if (msgContrato && msgContrato.created_at) {
    const horasDesde = Math.round((Date.now() - new Date(msgContrato.created_at).getTime()) / 3600000);
    if (horasDesde >= 24) {
      systemPrompt += `\n\nCONTEXTO CONTRATACION: Este cliente firmó su contrato hace ${horasDesde} horas (ya pasaron las 24h). Si pregunta por el SMS de firma o el estado del contrato, dile que el plazo ya pasó y que si no ha recibido el SMS en su móvil, que nos escriba aquí mismo y un asesor le llamará para resolverlo. NUNCA le digas "en menos de 24h" porque ese plazo ya transcurrió.`;
    } else {
      systemPrompt += `\n\nCONTEXTO CONTRATACION: Este cliente firmó su contrato hace ${horasDesde} horas (aún dentro del plazo de 24h). Si pregunta por el SMS de firma, dile que el proceso ya está en marcha y que en menos de 24h desde la firma le llegará el SMS para firmar digitalmente con la nueva compañía.`;
    }
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
  "descuento_energia_pct": porcentaje de descuento contractual/fidelización sobre la energía si aparece explícito en la factura (ej: 10 para un "10% DTO" o "Dto. fidelización 10%"). Solo si es un descuento CONTRACTUAL permanente sobre el consumo, NO descuentos puntuales tipo "PARA TI". null si no hay descuento contractual,
  "importe_energia_sin_descuento": importe de energía ANTES de aplicar descuento_energia_pct (null si no hay descuento contractual),
  "cups": "código CUPS" o null,
  "tiene_autoconsumo": true o false,
  "tiene_bateria_virtual": true o false,
  "excedentes_kwh": kWh exportados o null,
  "compensacion_excedentes_importe": € de compensación o null,
  "tipo_tarifa": "2.0TD" o "3.0TD",
  "precio_fijo_mes": € fijo mensual o null,
  "consumo_anual_estimado": kWh anuales estimados o null,
  "nombre_titular": "nombre completo del titular que aparece en la factura (ej: MANUEL GARCIA LOPEZ)" o null,
  "dni_titular": "DNI o NIF del titular si aparece (formato 12345678X)" o null
}

REGLAS IMPORTANTES:
- consumo_kwh: SIEMPRE suma P1+P2+P3 si hay periodos. Ejemplo: 298+205+367 = 870 kWh
- precio_kwh: DIVIDE importe_energia / consumo_kwh. Si hay descuento contractual, usa importe_energia_sin_descuento / consumo_kwh para reflejar el precio real de tarifa
- precio_total: incluye el descuento contractual si lo hay (es el importe real que paga el cliente habitualmente)
- precio_potencia_dia: es el precio UNITARIO €/kW/día (ej: 0.097), NO el importe total
- descuento_energia_pct: solo si hay un "X% DTO" o "Dto. fidelización X%" sobre la energía/consumo de forma contractual. La factura de Susana tiene "Descuento promocional 70,59 x -10% DTO" → descuento_energia_pct = 10
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
function esIberdrola(compania) { return (compania || '').toLowerCase().includes('iberdrola'); }
function esGana(compania)      { return (compania || '').toLowerCase().includes('gana'); }
function esNaturgy(compania)   { return (compania || '').toLowerCase().includes('naturgy'); }

function calcularCosteTarifa(tarifa, consumoTotal, consumoP1, consumoP2, consumoP3,
  potencia, factor, tieneTriperiodo, excedentesKwh, tieneAutoconsumo, tieneBateriaVirtual) {

  const esTarifaTriperiodo = tarifa.precio_kwh_p2 && tarifa.precio_kwh_p3 &&
    (tarifa.precio_kwh_p2 !== tarifa.precio_kwh_p1 || tarifa.precio_kwh_p3 !== tarifa.precio_kwh_p1);

  let costeEnergia = 0;
  if (tieneTriperiodo && esTarifaTriperiodo) {
    costeEnergia =
      (consumoP1 * factor * tarifa.precio_kwh_p1) +
      (consumoP2 * factor * tarifa.precio_kwh_p2) +
      (consumoP3 * factor * tarifa.precio_kwh_p3);
  } else if (!tieneTriperiodo && esTarifaTriperiodo) {
    // Sin desglose: distribución típica española 30% P1 · 20% P2 · 50% P3
    costeEnergia =
      (consumoTotal * 0.30 * factor * tarifa.precio_kwh_p1) +
      (consumoTotal * 0.20 * factor * tarifa.precio_kwh_p2) +
      (consumoTotal * 0.50 * factor * tarifa.precio_kwh_p3);
  } else {
    costeEnergia = consumoTotal * factor * (tarifa.precio_kwh_p1 || tarifa.precio_kwh || 0);
  }

  const costePotencia =
    (tarifa.precio_kw_p1 || tarifa.precio_kw || 0) * potencia * 30 +
    (tarifa.precio_kw_p2 || 0) * potencia * 30;

  let descuentoBV = 0;
  if ((tieneAutoconsumo || tieneBateriaVirtual) && excedentesKwh > 0) {
    const precioExcedentes = (tarifa.compania || '').toLowerCase().includes('gana') ? 0.05 : 0.06;
    descuentoBV = (excedentesKwh * factor) * precioExcedentes;
  }

  return (costeEnergia + costePotencia + (tarifa.precio_fijo_mes || 0) - descuentoBV) * 1.2611;
}

async function generarComparativa(datosFactura, tarifas) {
  const diasFactura     = datosFactura.dias_facturacion || 30;
  const factor          = 30 / diasFactura;
  const consumoTotal    = datosFactura.consumo_kwh || 0;
  const consumoP1       = datosFactura.consumo_p1_kwh || 0;
  const consumoP2       = datosFactura.consumo_p2_kwh || 0;
  const consumoP3       = datosFactura.consumo_p3_kwh || 0;
  const potencia        = datosFactura.potencia_kw || 4.4;
  const tieneTriperiodo = consumoP1 > 0 || consumoP2 > 0 || consumoP3 > 0;

  // ── Coste actual real: lo que el cliente paga de media al mes ──────────────
  // precio_total ya incluye descuento contractual → es el coste real del cliente
  // Lo normalizamos a 30 días para comparar igual que las tarifas nuevas
  const precioTotalReal = datosFactura.precio_total;

  const costeActualMes  = (precioTotalReal / diasFactura) * 30;

  const clienteCompania = (datosFactura.compania || '').toLowerCase();
  const args = [consumoTotal, consumoP1, consumoP2, consumoP3, potencia, factor, tieneTriperiodo,
    datosFactura.excedentes_kwh || 0, datosFactura.tiene_autoconsumo, datosFactura.tiene_bateria_virtual];

  // Tarifas de luz en rango de potencia, excluyendo la compañía del cliente
  const candidatas = tarifas.filter(t => {
    const min = t.potencia_min_kw || 0;
    const max = t.potencia_max_kw || 15;
    if (potencia < min || potencia > max) return false;
    if (t.tipo_suministro === 'gas') return false;
    const companiaT = (t.compania || '').toLowerCase();
    const palabra = clienteCompania.split(' ')[0];
    return palabra.length < 3 ? !companiaT.includes(clienteCompania) : !companiaT.includes(palabra);
  });

  // ── PRIORIDAD: Iberdrola → Gana → Naturgy (última opción, menor comisión) ──
  // Dentro de cada grupo, gana la tarifa con más ahorro real.
  function mejorDe(filtro) {
    let best = null, bestAhorro = 0, bestCoste = 0;
    for (const t of candidatas.filter(filtro)) {
      const coste  = calcularCosteTarifa(t, ...args);
      const ahorro = costeActualMes - coste;
      if (ahorro > 3 && ahorro > bestAhorro) { best = t; bestAhorro = ahorro; bestCoste = coste; }
    }
    return { tarifa: best, ahorro: bestAhorro, coste: bestCoste };
  }

  let resultado = mejorDe(t => esIberdrola(t.compania));
  if (!resultado.tarifa) resultado = mejorDe(t => esGana(t.compania));
  if (!resultado.tarifa) resultado = mejorDe(t => esNaturgy(t.compania));
  if (!resultado.tarifa) resultado = mejorDe(() => true); // último recurso

  if (!resultado.tarifa) {
    return {
      mensaje: '✅ Ya tienes una tarifa muy competitiva. ¡Estás pagando un precio justo! Te avisaremos si detectamos una bajada de precios que te beneficie.',
      ahorro: 0, tarifa: null, datosComparativa: null
    };
  }

  const { tarifa: mejorTarifa, ahorro: mejorAhorro, coste: mejorCoste } = resultado;
  const ahorroAnual     = parseFloat((mejorAhorro * 12).toFixed(2));
  const precioNuevoMes  = parseFloat(mejorCoste.toFixed(2));
  const precioActualMes = parseFloat(costeActualMes.toFixed(2));
  const pctAhorro       = Math.round((mejorAhorro / costeActualMes) * 100);

  // Para tarifas triperiodo mostrar "desde X €/kWh" con el precio MÁS BARATO (P3)
  // Para tarifas planas mostrar el precio único
  const esTarifaTriperiodo = mejorTarifa.precio_kwh_p3 &&
    mejorTarifa.precio_kwh_p3 !== mejorTarifa.precio_kwh_p1;
  const precioKwhVisible = esTarifaTriperiodo
    ? `desde ${mejorTarifa.precio_kwh_p3.toFixed(4)} €/kWh`
    : mejorTarifa.precio_kwh_p1
      ? `${mejorTarifa.precio_kwh_p1.toFixed(4)} €/kWh`
      : '';
  const permanencia = mejorTarifa.tiene_permanencia ? 'con 12 meses de permanencia' : 'sin permanencia';

  const mensaje = `💡 ¡Buenas noticias! Hemos analizado tu factura de ${datosFactura.compania || 'tu compañía'}.

Con *${mejorTarifa.compania}* (${mejorTarifa.nombre_tarifa}) podrías ahorrar:
💰 *~${ahorroAnual}€ al año* (${pctAhorro}% menos)
⚡ Precio luz: ${precioKwhVisible} · ${permanencia}

👇 Tu informe personalizado:`;

  return {
    mensaje,
    ahorro: ahorroAnual,
    tarifa: mejorTarifa,
    datosComparativa: {
      precio_actual_mes:   precioActualMes,
      precio_nuevo_mes:    precioNuevoMes,
      precio_actual_anual: parseFloat((precioActualMes * 12).toFixed(2)),
      precio_nuevo_anual:  parseFloat((precioNuevoMes * 12).toFixed(2)),
      ahorro_anual:        ahorroAnual,
      pct_ahorro:          pctAhorro,
      consumo_p1: consumoP1, consumo_p2: consumoP2, consumo_p3: consumoP3,
      consumo_total: consumoTotal, dias: diasFactura, potencia,
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
    wa:               process.env.WHATSAPP_PHONE_NUMBER || '34955209158',
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
  "compania": "nombre comercial de la compañía (ej: Gana Energía, Naturgy, Endesa, Iberdrola...)",
  "fecha_factura": "YYYY-MM-DD",
  "dias_facturacion": número de días del periodo facturado,
  "consumo_kwh": número total de kWh consumidos,
  "precio_kwh": precio del término variable €/kWh (SOLO el gas, sin servicios adicionales),
  "precio_fijo_mes": término fijo €/mes (SOLO el término de acceso fijo, sin servicios adicionales),
  "precio_total": ⚠️ USA SOLO: término_fijo + gas_consumido + impuesto_hidrocarburos + IVA. IGNORA completamente líneas de "Varios", "Canon IRC", "Servicio adicional", "Asistente", "Alquileres" y cualquier servicio extra. El precio_total debe reflejar solo el coste puro del gas,
  "tarifa_acceso": "RL.1", "RL.2" o "RL.3" según aparezca en la factura,
  "cups": "código CUPS completo o null",
  "consumo_anual_estimado": kWh anuales estimados si aparece en la factura, o null,
  "nombre_titular": "nombre completo del titular que aparece en la factura" o null,
  "dni_titular": "DNI o NIF del titular si aparece (formato 12345678X)" o null
}
REGLA CRÍTICA precio_total: término_fijo + (consumo_kwh × precio_kwh) + impuesto_hidrocarburos + IVA 21%. NO incluir servicios de valor añadido.`
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

// ─── COMPARATIVA GAS ─────────────────────────────────────────────────────────
// REGLA: si el cliente YA es de Gana Energía → tarifa actualizada, no ofrecemos.
// Si es de otra compañía → ofrecemos Gana Energía según segmento RL.
async function generarComparativaGas(datosFactura, tarifasGas) {
  const diasFactura  = datosFactura.dias_facturacion || 30;
  const factor       = 30 / diasFactura;
  const consumoKwh   = datosFactura.consumo_kwh || 0;
  const consumoMes   = consumoKwh * factor;
  const consumoAnual = datosFactura.consumo_anual_estimado || (consumoMes * 12);

  // Si ya es cliente de Gana Energía → no hay nada mejor que ofrecerle
  if ((datosFactura.compania || '').toLowerCase().includes('gana')) {
    return {
      mensaje: `✅ Ya tienes el gas con *Gana Energía*, una de las tarifas más competitivas del mercado.\n\nTe avisaremos si hay alguna bajada de precio que te beneficie. ¿Puedo ayudarte con algo más?`,
      ahorro: 0, tarifa: null, datosComparativa: null
    };
  }

  // Determinar segmento RL por consumo anual
  const segmento = datosFactura.tarifa_acceso || determinarSegmentoGas(consumoAnual);

  // Buscar tarifa de Gana para ese segmento
  const tarifaCorrecta = tarifasGas.find(t =>
    (t.compania || '').toLowerCase().includes('gana') && t.segmento === segmento
  ) || tarifasGas.find(t => t.segmento === segmento); // fallback

  if (!tarifaCorrecta) {
    return { mensaje: 'No hemos encontrado una tarifa de gas adecuada para tu perfil de consumo.', ahorro: 0, tarifa: null, datosComparativa: null };
  }

  // Coste actual normalizado a 30 días (precio puro gas, ya limpiado en OCR)
  const costeActualMes = (datosFactura.precio_total / diasFactura) * 30;

  // Coste con Gana Energía: término variable + término fijo mensual
  const costeNuevoSinIVA = (tarifaCorrecta.precio_kwh * consumoMes) + (tarifaCorrecta.precio_fijo_mes || 0);
  // Añadir IVA 21% + Impuesto Hidrocarburos (aprox 0.00234€/kWh normalizado)
  const impuestoHidro = consumoMes * 0.00234;
  const costeNuevo = (costeNuevoSinIVA + impuestoHidro) * 1.21;

  const ahorroMes   = costeActualMes - costeNuevo;

  if (ahorroMes <= 2) {
    return {
      mensaje: `✅ Ya tienes una tarifa de gas bastante competitiva con ${datosFactura.compania}.\n\nTe avisaremos si detectamos una tarifa más barata para tu perfil. ¿Puedo ayudarte con algo más?`,
      ahorro: 0, tarifa: null, datosComparativa: null
    };
  }

  const ahorroAnual    = parseFloat((ahorroMes * 12).toFixed(2));
  const precioNuevoMes = parseFloat(costeNuevo.toFixed(2));
  const pctAhorro      = Math.round((ahorroMes / costeActualMes) * 100);

  const mensaje = `💡 ¡Buenas noticias! Hemos analizado tu factura de gas de *${datosFactura.compania || 'tu compañía'}*.

Con *Gana Energía* (${tarifaCorrecta.nombre_tarifa}) podrías ahorrar:
💰 *~${ahorroAnual}€ al año* (${pctAhorro}% menos)
⚡ Precio gas: ${tarifaCorrecta.precio_kwh.toFixed(4)} €/kWh · Sin permanencia

👇 Tu informe personalizado:`;

  return {
    mensaje,
    ahorro: ahorroAnual,
    tarifa: tarifaCorrecta,
    datosComparativa: {
      precio_actual_mes:   parseFloat(costeActualMes.toFixed(2)),
      precio_nuevo_mes:    precioNuevoMes,
      precio_actual_anual: parseFloat((costeActualMes * 12).toFixed(2)),
      precio_nuevo_anual:  parseFloat((precioNuevoMes * 12).toFixed(2)),
      ahorro_anual:        ahorroAnual,
      pct_ahorro:          pctAhorro,
      consumo_total:       consumoKwh,
      dias:                diasFactura,
      segmento,
    }
  };
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
    `Coste potencia actual (P1+P2 mes completo): ${f.importe_potencia ? `${f.importe_potencia}€/mes` : 'no disponible'} — usa este importe total al hablar de potencia, NUNCA el precio unitario €/kW/día`,
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
    f.descuento_energia_pct ? `DESCUENTO CONTRACTUAL ENERGÍA: ${f.descuento_energia_pct}% (descuento permanente de su contrato con ${f.compania}, ya incluido en el total de la factura)` : null,
    f.descuento_energia_pct ? `Precio efectivo real con descuento: ${f.precio_kwh ? (f.precio_kwh * (1 - f.descuento_energia_pct/100)).toFixed(4) : '—'} €/kWh` : null,
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

  // Calcular coste potencia nueva tarifa para que el bot lo use directamente
  const costePotenciaNuevaMes = d.potencia
    ? (((t.precio_kw_p1 || t.precio_kw || 0) * d.potencia * 30) + ((t.precio_kw_p2 || 0) * d.potencia * 30)).toFixed(2)
    : null;

  const datosComparativaStr = [
    `Precio actual normalizado: ${d.precio_actual_mes}€/mes (${d.precio_actual_anual}€/año)`,
    `Tarifa recomendada: ${t.compania} - ${t.nombre_tarifa}`,
    `Precio nuevo: ${d.precio_nuevo_mes}€/mes (${d.precio_nuevo_anual}€/año)`,
    `Ahorro estimado: ${d.ahorro_anual}€/año (${d.pct_ahorro}% menos)`,
    costePotenciaNuevaMes ? `Coste potencia nueva tarifa (P1+P2 mes completo): ${costePotenciaNuevaMes}€/mes` : null,
    t.precio_kwh_p1 ? `Nuevo precio P1: ${t.precio_kwh_p1} €/kWh` : null,
    t.precio_kwh_p2 ? `Nuevo precio P2: ${t.precio_kwh_p2} €/kWh` : null,
    t.precio_kwh_p3 ? `Nuevo precio P3: ${t.precio_kwh_p3} €/kWh` : null,
    t.precio_kw_p1 ? `Nueva potencia P1: ${t.precio_kw_p1} €/kW/día` : null,
    t.precio_fijo_mes ? `Cuota fija nueva tarifa: ${t.precio_fijo_mes}€/mes` : null,
  ].filter(Boolean).join('. ');

  // Desglose para que el bot explique el ahorro sin inventar números
  const potenciaActual = f.importe_potencia ? parseFloat(f.importe_potencia) : null;
  const potenciaNueva  = costePotenciaNuevaMes ? parseFloat(costePotenciaNuevaMes) : null;
  const ahorroPotencia = (potenciaActual && potenciaNueva) ? (potenciaActual - potenciaNueva).toFixed(2) : null;

  const desgloseAhorro = [
    'DESGLOSE AHORRO — USA ESTOS NÚMEROS EXACTOS, NUNCA CALCULES POR TU CUENTA:',
    potenciaActual ? `• Potencia actual (${f.compania}): ${potenciaActual}€/mes` : null,
    potenciaNueva  ? `• Potencia nueva (${t.compania}): ${potenciaNueva}€/mes` : null,
    ahorroPotencia ? `• Ahorro en potencia: ${ahorroPotencia}€/mes` : null,
    `• Ahorro total (energía + potencia + impuestos): ${(d.ahorro_anual / 12).toFixed(2)}€/mes → ${d.ahorro_anual}€/año`,
  ].filter(Boolean).join('\n');

  return `[ANÁLISIS FACTURA] DATOS DE LA FACTURA ACTUAL: ${datosFacturaStr}. COMPARATIVA Y AHORRO: ${datosComparativaStr}.\n${desgloseAhorro}\nCálculo basado en datos reales de la factura del cliente.`;
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