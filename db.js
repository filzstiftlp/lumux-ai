const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Obtener o crear usuario por subscriber_id de ManyChat
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

// Obtener historial de mensajes del usuario (últimos 20)
async function getHistorial(usuarioId) {
  const { data } = await supabase
    .from('mensajes')
    .select('rol, mensaje')
    .eq('usuario_id', usuarioId)
    .order('created_at', { ascending: true })
    .limit(20);

  return data || [];
}

// Guardar mensaje en la base de datos
async function guardarMensaje(usuarioId, rol, mensaje, metadata = {}) {
  await supabase.from('mensajes').insert({
    usuario_id: usuarioId,
    rol,
    mensaje,
    metadata
  });
}

// Guardar factura (datos extraídos por Claude)
async function guardarFactura(usuarioId, datosFactura) {
  const { data } = await supabase
    .from('facturas')
    .insert({
      usuario_id: usuarioId,
      ...datosFactura,
      estado_ocr: 'procesado'
    })
    .select()
    .single();
  return data;
}

// Obtener tarifas activas para comparativa
async function getTarifasActivas() {
  const { data } = await supabase
    .from('tarifas')
    .select('*')
    .eq('activa', true)
    .is('fecha_vigencia_hasta', null);
  return data || [];
}

// Crear oferta
async function crearOferta(usuarioId, facturaId, tarifaId, ahorroEstimado, urlWebview) {
  const { data } = await supabase
    .from('ofertas')
    .insert({
      usuario_id: usuarioId,
      factura_id: facturaId,
      tarifa_id: tarifaId,
      ahorro_estimado: ahorroEstimado,
      url_webview: urlWebview,
      estado: 'enviada'
    })
    .select()
    .single();
  return data;
}

// Programar remarketing
async function programarRemarketing(usuarioId, ofertaId, diasDesdeHoy, tipo) {
  const fecha = new Date();
  fecha.setDate(fecha.getDate() + diasDesdeHoy);

  await supabase.from('remarketing').insert({
    usuario_id: usuarioId,
    oferta_id: ofertaId,
    tipo,
    fecha_programada: fecha.toISOString().split('T')[0],
    estado: 'pendiente'
  });
}

// Actualizar estado del usuario
async function actualizarEstado(usuarioId, estado) {
  await supabase
    .from('usuarios')
    .update({ estado, updated_at: new Date().toISOString() })
    .eq('id', usuarioId);
}

module.exports = {
  supabase,
  getOrCreateUsuario,
  getHistorial,
  guardarMensaje,
  guardarFactura,
  getTarifasActivas,
  crearOferta,
  programarRemarketing,
  actualizarEstado
}; 
