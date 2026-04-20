const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function getOrCreateUsuario(subscriberId, datos = {}) {
  let { data: usuario } = await supabase
    .from('usuarios')
    .select('*')
    .eq('subscriber_id', subscriberId)
    .single();

  if (!usuario) {
    const { data: nuevo } = await supabase
      .from('usuarios')
      .insert({
        subscriber_id: subscriberId,
        nombre:    datos.nombre    || null,
        telefono:  datos.telefono  || null,
        canal:     datos.canal     || 'whatsapp',
        estado:    'inicio',
        // ctwa_clid: click ID del anuncio Click-to-WhatsApp (msg.referral.ctwa_clid)
        // Solo presente en el primer mensaje de usuarios que llegan por anuncio
        ctwa_clid: datos.ctwa_clid || null,
      })
      .select()
      .single();
    usuario = nuevo;
  } else if (datos.ctwa_clid && !usuario.ctwa_clid) {
    // Usuario ya existía pero ahora llega con ctwa_clid (retargeting / sesión nueva desde anuncio)
    const { data: actualizado } = await supabase
      .from('usuarios')
      .update({ ctwa_clid: datos.ctwa_clid, updated_at: new Date().toISOString() })
      .eq('id', usuario.id)
      .select()
      .single();
    if (actualizado) usuario = actualizado;
  }
  return usuario;
}

async function getHistorial(usuarioId) {
  // FIX: obtener los 20 MÁS RECIENTES (no los más antiguos)
  const { data } = await supabase
    .from('mensajes')
    .select('rol, mensaje, created_at')
    .eq('usuario_id', usuarioId)
    .order('created_at', { ascending: false })
    .limit(20);

  const mensajes = (data || []).reverse(); // orden cronológico para Claude

  // Garantizar que el [ANÁLISIS FACTURA] más reciente SIEMPRE está incluido
  const yaHayAnalisis = mensajes.some(m => m.mensaje && m.mensaje.startsWith('[ANÁLISIS FACTURA]'));
  if (!yaHayAnalisis) {
    const { data: analisis } = await supabase
      .from('mensajes')
      .select('rol, mensaje')
      .eq('usuario_id', usuarioId)
      .ilike('mensaje', '[ANÁLISIS FACTURA]%')
      .order('created_at', { ascending: false })
      .limit(1);
    if (analisis && analisis.length > 0) {
      mensajes.unshift({ rol: analisis[0].rol, mensaje: analisis[0].mensaje });
    }
  }

  return mensajes;
}

async function guardarMensaje(usuarioId, rol, mensaje, metadata = {}) {
  await supabase.from('mensajes').insert({ usuario_id: usuarioId, rol, mensaje, metadata });
}

async function guardarFactura(usuarioId, datosFactura) {
  const { data } = await supabase
    .from('facturas')
    .insert({ usuario_id: usuarioId, ...datosFactura, estado_ocr: 'procesado' })
    .select()
    .single();
  return data;
}

async function crearOferta(usuarioId, facturaId, tarifaId, ahorroEstimado, urlWebview) {
  const { data } = await supabase
    .from('ofertas')
    .insert({ usuario_id: usuarioId, factura_id: facturaId, tarifa_id: tarifaId, ahorro_estimado: ahorroEstimado, url_webview: urlWebview, estado: 'enviada' })
    .select()
    .single();
  return data;
}

async function programarRemarketing(usuarioId, ofertaId, diasDesdeHoy, tipo) {
  const fecha = new Date();
  fecha.setDate(fecha.getDate() + diasDesdeHoy);
  await supabase.from('remarketing').insert({
    usuario_id: usuarioId, oferta_id: ofertaId, tipo,
    fecha_programada: fecha.toISOString().split('T')[0], estado: 'pendiente'
  });
}

async function actualizarEstado(usuarioId, estado) {
  await supabase.from('usuarios').update({ estado, updated_at: new Date().toISOString() }).eq('id', usuarioId);
}

// ─── INFORMES CON SHORT ID ────────────────────────────────────────────────────
function generarShortId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 7; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

async function guardarInforme(datos) {
  let shortId, existe = true;
  while (existe) {
    shortId = generarShortId();
    const { data } = await supabase.from('informes').select('id').eq('short_id', shortId).single();
    existe = !!data;
  }
  const { data } = await supabase.from('informes').insert({ short_id: shortId, ...datos }).select().single();
  return data;
}

async function getInformePorShortId(shortId) {
  const { data } = await supabase.from('informes').select('*').eq('short_id', shortId).single();
  if (data && !data.visto) {
    await supabase.from('informes').update({ visto: true, fecha_visto: new Date().toISOString() }).eq('short_id', shortId);
  }
  return data;
}

// ─── CUPS ─────────────────────────────────────────────────────────────────────

// Crea o devuelve el id de la propiedad para ese CUPS
async function upsertPropiedad(usuarioId, cups, datosDir = {}) {
  if (!cups) return null;
  const { data: existente } = await supabase.from('propiedades').select('id').eq('cups', cups).single();

  // Campos de dirección disponibles
  const camposDir = {};
  if (datosDir.direccion)     camposDir.direccion     = datosDir.direccion;
  if (datosDir.codigo_postal) camposDir.codigo_postal = datosDir.codigo_postal;
  if (datosDir.ciudad)        camposDir.ciudad        = datosDir.ciudad;
  if (datosDir.provincia)     camposDir.provincia     = datosDir.provincia;

  if (existente) {
    // Actualizar dirección si ahora tenemos datos y antes no
    if (Object.keys(camposDir).length > 0) {
      await supabase.from('propiedades').update(camposDir).eq('id', existente.id);
    }
    return existente.id;
  }

  const { data: nueva } = await supabase.from('propiedades')
    .insert({ usuario_id: usuarioId, cups, ...camposDir })
    .select('id').single();
  return nueva?.id || null;
}

// Devuelve { bloqueado, motivo, mensaje }
// Comprueba SOLO por CUPS, nunca por usuario entero
async function verificarBloqueCUPS(cups, usuarioId) {
  if (!cups) return { bloqueado: false };

  const msgTramitando = (comp) =>
    `✅ Ya tienes un cambio en tramitación para este suministro (CUPS: ${cups}) hacia *${comp || 'la nueva compañía'}*.\n\nRecibirás el contrato en tu email en menos de 24h. ¿Tienes alguna duda? Escríbenos aquí 💬`;
  const msgActivo = (comp) =>
    `✅ Este suministro (CUPS: ${cups}) ya tiene un contrato activo con *${comp || 'Lumux'}* gestionado por nosotros.\n\nSi necesitas hacer algún cambio, llámanos directamente por este WhatsApp 📞`;

  // ── 1. Contrato en tabla contratos (activo o tramitando) ──────────────────
  const { data: propiedad } = await supabase.from('propiedades').select('id').eq('cups', cups).maybeSingle();
  if (propiedad) {
    const { data: contrato } = await supabase.from('contratos')
      .select('id, compania, estado')
      .eq('propiedad_id', propiedad.id)
      .in('estado', ['activo', 'tramitando'])
      .order('fecha_contrato', { ascending: false })
      .limit(1).maybeSingle();
    if (contrato) {
      return {
        bloqueado: true, motivo: 'contrato_' + contrato.estado,
        mensaje: contrato.estado === 'activo' ? msgActivo(contrato.compania) : msgTramitando(contrato.compania)
      };
    }

    // ── 2. Oferta firmada vía factura → propiedad ─────────────────────────
    const { data: factIds } = await supabase.from('facturas').select('id').eq('propiedad_id', propiedad.id);
    if (factIds && factIds.length > 0) {
      const ids = factIds.map(f => f.id);
      const { data: oferta } = await supabase.from('ofertas')
        .select('id, tarifas(compania)').eq('estado', 'firmada').in('factura_id', ids)
        .order('fecha_firmado', { ascending: false }).limit(1).maybeSingle();
      if (oferta) {
        return { bloqueado: true, motivo: 'oferta_firmada', mensaje: msgTramitando(oferta.tarifas?.compania) };
      }
    }
  }

  // ── 3. Informe firmado por CUPS — SIEMPRE, aunque no exista propiedad ────
  // (es el check más robusto porque usa el campo cups del informe directamente)
  const { data: informeFirmado } = await supabase.from('informes')
    .select('id, nueva_compania, ofertas(estado)')
    .eq('cups', cups)
    .not('oferta_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1).maybeSingle();
  if (informeFirmado?.ofertas?.estado === 'firmada') {
    return { bloqueado: true, motivo: 'oferta_firmada', mensaje: msgTramitando(informeFirmado.nueva_compania) };
  }

  return { bloqueado: false };
}

// ─── REGISTRAR CONTRATO FIRMADO ───────────────────────────────────────────────
// Se llama al firmar → crea/actualiza registro en contratos para bloqueo definitivo por CUPS
async function registrarContrato(propiedadId, cups, datos = {}) {
  if (!propiedadId && !cups) return null;

  // Resolver propiedad_id si solo tenemos cups
  let propId = propiedadId;
  if (!propId && cups) {
    const { data: prop } = await supabase.from('propiedades').select('id').eq('cups', cups).maybeSingle();
    propId = prop?.id || null;
  }
  if (!propId) {
    console.warn(`[Contratos] No se pudo resolver propiedad para CUPS=${cups}`);
    return null;
  }

  // Ver si ya existe un contrato para esta propiedad (no hay unique constraint)
  const { data: existente } = await supabase
    .from('contratos').select('id')
    .eq('propiedad_id', propId)
    .maybeSingle();

  const payload = {
    propiedad_id:   propId,
    compania:       datos.compania  || null,
    oferta_id:      datos.oferta_id || null,
    estado:         'tramitando',
    fecha_contrato: new Date().toISOString(),
    origen:         'bot',
  };

  let result;
  if (existente) {
    const { data } = await supabase.from('contratos')
      .update({ compania: payload.compania, oferta_id: payload.oferta_id, estado: 'tramitando', fecha_contrato: payload.fecha_contrato })
      .eq('id', existente.id).select().maybeSingle();
    result = data;
  } else {
    const { data } = await supabase.from('contratos')
      .insert(payload).select().maybeSingle();
    result = data;
  }

  console.log(`[Contratos] ✅ CUPS=${cups} propId=${propId} estado=tramitando id=${result?.id}`);
  return result;
}

// ─── HISTORIAL COMPLETO POR TELÉFONO ─────────────────────────────────────────
// Agrupa contratos e informes de TODOS los usuarios que usan el mismo teléfono
// (mismo titular, diferentes suministros / titulares familiares)
async function getContratosYInformesPorTelefono(telefono) {
  if (!telefono) return { contratos: [], informes: [] };

  // 1. Todos los usuario_id con ese teléfono
  const { data: usuarios } = await supabase
    .from('usuarios').select('id').eq('telefono', telefono);
  if (!usuarios?.length) return { contratos: [], informes: [] };
  const uids = usuarios.map(u => u.id);

  // 2. Contratos activos (vía propiedades)
  const { data: propiedades } = await supabase
    .from('propiedades').select('id, cups, direccion').in('usuario_id', uids);
  const propIds = (propiedades || []).map(p => p.id);

  let contratos = [];
  if (propIds.length) {
    const { data: c } = await supabase
      .from('contratos')
      .select('id, compania, estado, fecha_contrato, propiedades(cups, direccion)')
      .in('propiedad_id', propIds)
      .order('fecha_contrato', { ascending: false });
    contratos = c || [];
  }

  // 3. Informes / ofertas firmadas
  const { data: informes } = await supabase
    .from('informes')
    .select('id, short_id, compania_actual, nueva_compania, nueva_tarifa, ahorro_anual, pct_ahorro, created_at, cups, ofertas(estado, fecha_firmado)')
    .in('usuario_id', uids)
    .order('created_at', { ascending: false })
    .limit(20);

  return { contratos: contratos || [], informes: informes || [] };
}

module.exports = {
  supabase,
  getOrCreateUsuario,
  getHistorial,
  guardarMensaje,
  guardarFactura,
  crearOferta,
  programarRemarketing,
  actualizarEstado,
  guardarInforme,
  getInformePorShortId,
  upsertPropiedad,
  verificarBloqueCUPS,
  registrarContrato,
  getContratosYInformesPorTelefono,
};