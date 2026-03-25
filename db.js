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
        nombre: datos.nombre || null,
        telefono: datos.telefono || null,
        canal: datos.canal || 'whatsapp',
        estado: 'inicio'
      })
      .select()
      .single();
    usuario = nuevo;
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
};