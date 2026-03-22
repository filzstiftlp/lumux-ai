const express = require('express');
const router = express.Router();
const axios = require('axios');
const db = require('./db');
const { responderMensaje, analizarFactura, generarComparativa } = require('./claude');

// Endpoint principal que recibe mensajes de ManyChat
router.post('/manychat', async (req, res) => {
  try {
    const { subscriber_id, nombre, telefono, mensaje, tipo, archivo_url } = req.body;

    if (!subscriber_id) {
      return res.status(400).json({ error: 'subscriber_id requerido' });
    }

    // 1. Obtener o crear usuario en Supabase
    const usuario = await db.getOrCreateUsuario(subscriber_id, { nombre, telefono });

    // 2. Obtener historial de mensajes
    const historial = await db.getHistorial(usuario.id);

    let respuesta = '';
    let metadata = {};

    // 3. Procesar según tipo de mensaje
    if (tipo === 'imagen' || tipo === 'archivo') {
      // --- FACTURA RECIBIDA ---
      respuesta = '⏳ Estoy analizando tu factura, dame un momento...';

      // Guardamos mensaje del usuario
      await db.guardarMensaje(usuario.id, 'user', '[Factura enviada]', { archivo_url });

      // Descargamos la imagen y la convertimos a base64
      const imageResponse = await axios.get(archivo_url, { responseType: 'arraybuffer' });
      const base64 = Buffer.from(imageResponse.data).toString('base64');
      const mediaType = tipo === 'imagen' ? 'image/jpeg' : 'application/pdf';

      // Analizamos con Claude
      const datosFactura = await analizarFactura(base64, mediaType);

      if (datosFactura) {
        // Guardamos factura en Supabase
        const factura = await db.guardarFactura(usuario.id, {
          compania: datosFactura.compania,
          consumo_kwh: datosFactura.consumo_kwh,
          potencia_kw: datosFactura.potencia_kw,
          precio_kwh: datosFactura.precio_kwh,
          precio_potencia: datosFactura.precio_potencia,
          precio_total: datosFactura.precio_total,
          dias_facturacion: datosFactura.dias_facturacion,
          fecha_factura: datosFactura.fecha_factura,
          raw_texto_ocr: JSON.stringify(datosFactura)
        });

        // Obtenemos tarifas y hacemos comparativa
        const tarifas = await db.getTarifasActivas();

        if (tarifas.length > 0) {
          const comparativa = await generarComparativa(datosFactura, tarifas);
          respuesta = comparativa.mensaje;

          if (comparativa.ahorro > 0 && comparativa.tarifa) {
            // Creamos oferta en Supabase
            const oferta = await db.crearOferta(
              usuario.id,
              factura.id,
              comparativa.tarifa.id,
              comparativa.ahorro,
              null // URL webview - la añadiremos más adelante
            );

            // Programamos remarketing: 3 días si no responde
            await db.programarRemarketing(usuario.id, oferta.id, 3, 'seguimiento_oferta');

            metadata = { factura_id: factura.id, oferta_id: oferta.id };
          }
        } else {
          respuesta = '✅ He analizado tu factura de ' + (datosFactura.compania || 'tu compañía') +
                      '. Estoy preparando la comparativa, te escribo en breve.';
        }
      } else {
        respuesta = '❌ No he podido leer bien la factura. ¿Puedes enviarla más clara o en PDF?';
      }

    } else {
      // --- MENSAJE DE TEXTO ---
      await db.guardarMensaje(usuario.id, 'user', mensaje);
      respuesta = await responderMensaje(historial, mensaje);
    }

    // 4. Guardar respuesta del bot
    await db.guardarMensaje(usuario.id, 'assistant', respuesta, metadata);

    // 5. Responder a ManyChat con la variable a actualizar
    res.json({
      version: 'v2',
      content: {
        messages: [],
        actions: [
          {
            action: 'set_field_value',
            field_name: 'lumux_respuesta',
            value: respuesta
          }
        ]
      }
    });

  } catch (error) {
    console.error('Error en webhook:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

module.exports = router; 
