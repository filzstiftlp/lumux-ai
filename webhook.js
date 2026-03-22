const express = require('express');
const router = express.Router();
const axios = require('axios');
const db = require('./db');
const { responderMensaje, analizarFactura, generarComparativa, analizarFacturaGas, generarComparativaGas } = require('./claude');

router.post('/manychat', async (req, res) => {
  try {
    const { subscriber_id, nombre, telefono, mensaje, tipo, archivo_url } = req.body;

    if (!subscriber_id) {
      return res.status(400).json({ error: 'subscriber_id requerido' });
    }

    const usuario = await db.getOrCreateUsuario(subscriber_id, { nombre, telefono });
    const historial = await db.getHistorial(usuario.id);

    let respuesta = '';
    let metadata = {};

    if (tipo === 'imagen' || tipo === 'archivo') {
      respuesta = '⏳ Estoy analizando tu factura, dame un momento...';
      await db.guardarMensaje(usuario.id, 'user', '[Factura enviada]', { archivo_url });

      const imageResponse = await axios.get(archivo_url, { responseType: 'arraybuffer' });
      const base64 = Buffer.from(imageResponse.data).toString('base64');
      const mediaType = tipo === 'imagen' ? 'image/jpeg' : 'application/pdf';

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
          .from('tarifas')
          .select('*')
          .eq('activa', true)
          .eq('tipo_suministro', esGas ? 'gas' : 'luz')
          .is('fecha_vigencia_hasta', null);

        if (tarifas && tarifas.length > 0) {
          const comparativa = esGas
            ? await generarComparativaGas(datosFactura, tarifas)
            : await generarComparativa(datosFactura, tarifas);

          respuesta = comparativa.mensaje;

          if (comparativa.ahorro > 0 && comparativa.tarifa) {
            const oferta = await db.crearOferta(
              usuario.id, factura.id, comparativa.tarifa.id,
              comparativa.ahorro, null
            );
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
      await db.guardarMensaje(usuario.id, 'user', mensaje);
      respuesta = await responderMensaje(historial, mensaje);
    }

    await db.guardarMensaje(usuario.id, 'assistant', respuesta, metadata);

    res.json({
      version: 'v2',
      content: {
        messages: [],
        actions: [{ action: 'set_field_value', field_name: 'lumux_respuesta', value: respuesta }]
      }
    });

  } catch (error) {
    console.error('Error en webhook:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

module.exports = router;