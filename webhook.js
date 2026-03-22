// Verificación del webhook de Meta
router.get('/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.status(403).send('Forbidden');
  }
});

// Recibir mensajes de WhatsApp
router.post('/whatsapp', async (req, res) => {
  try {
    res.status(200).send('OK'); // Responder inmediatamente a Meta

    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const messages = value?.messages;

    if (!messages || messages.length === 0) return;

    const msg = messages[0];
    const from = msg.from; // número de teléfono del cliente
    const nombre = value?.contacts?.[0]?.profile?.name || '';

    let tipo = 'texto';
    let mensajeTexto = '';
    let archivoUrl = null;
    let mediaType = null;

    if (msg.type === 'text') {
      tipo = 'texto';
      mensajeTexto = msg.text.body;
    } else if (msg.type === 'image') {
      tipo = 'imagen';
      archivoUrl = await getMediaUrl(msg.image.id);
      mediaType = 'image/jpeg';
    } else if (msg.type === 'document') {
      tipo = 'archivo';
      archivoUrl = await getMediaUrl(msg.document.id);
      mediaType = msg.document.mime_type || 'application/pdf';
    } else {
      return; // ignorar otros tipos
    }

    const usuario = await db.getOrCreateUsuario(from, { nombre, telefono: from, canal: 'whatsapp' });
    const historial = await db.getHistorial(usuario.id);

    let respuesta = '';
    let metadata = {};

    if (tipo === 'imagen' || tipo === 'archivo') {
      respuesta = '⏳ Estoy analizando tu factura, dame un momento...';
      await db.guardarMensaje(usuario.id, 'user', '[Factura enviada]', { archivoUrl });
      await enviarMensajeWhatsApp(from, respuesta);

      const imageResponse = await axios.get(archivoUrl, {
        responseType: 'arraybuffer',
        headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }
      });
      const base64 = Buffer.from(imageResponse.data).toString('base64');

      const datosFactura = await analizarFactura(base64, mediaType);

      if (datosFactura) {
        const esGas = datosFactura.tipo_suministro === 'gas';
        const factura = await db.guardarFactura(usuario.id, {
          compania: datosFactura.compania,
          consumo_kwh: datosFactura.consumo_kwh,
          potencia_kw: datosFactura.potencia_kw || null,
          precio_kwh: datosFactura.precio_kwh,
          precio_potencia: datosFactura.precio_potencia || null,
          precio_total: datosFactura.precio_total,
          dias_facturacion: datosFactura.dias_facturacion,
          fecha_factura: datosFactura.fecha_factura,
          raw_texto_ocr: JSON.stringify(datosFactura)
        });

        const { data: tarifas } = await db.supabase
          .from('tarifas').select('*')
          .eq('activa', true)
          .eq('tipo_suministro', esGas ? 'gas' : 'luz')
          .is('fecha_vigencia_hasta', null);

        if (tarifas && tarifas.length > 0) {
          const comparativa = esGas
            ? await generarComparativaGas(datosFactura, tarifas)
            : await generarComparativa(datosFactura, tarifas);
          respuesta = comparativa.mensaje;

          if (comparativa.ahorro > 0 && comparativa.tarifa) {
            const oferta = await db.crearOferta(usuario.id, factura.id, comparativa.tarifa.id, comparativa.ahorro, null);
            await db.programarRemarketing(usuario.id, oferta.id, 3, 'seguimiento_oferta');
            metadata = { factura_id: factura.id, oferta_id: oferta.id };
          }
        } else {
          respuesta = '✅ He analizado tu factura. Estoy preparando la comparativa, te escribo en breve.';
        }
      } else {
        respuesta = '❌ No he podido leer bien la factura. ¿Puedes enviarla más clara o en PDF?';
      }
    } else {
      await db.guardarMensaje(usuario.id, 'user', mensajeTexto);
      respuesta = await responderMensaje(historial, mensajeTexto);
    }

    await db.guardarMensaje(usuario.id, 'assistant', respuesta, metadata);
    await enviarMensajeWhatsApp(from, respuesta);

  } catch (error) {
    console.error('Error en webhook WhatsApp:', error);
  }
});

async function getMediaUrl(mediaId) {
  const response = await axios.get(
    `https://graph.facebook.com/v22.0/${mediaId}`,
    { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
  );
  return response.data.url;
}

async function enviarMensajeWhatsApp(to, mensaje) {
  await axios.post(
    `https://graph.facebook.com/v22.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: mensaje }
    },
    { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}
module.exports = router;