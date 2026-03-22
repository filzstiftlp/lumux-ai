require('dotenv').config();
const express = require('express');
const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rutas
const webhookRouter = require('./webhook');
app.use('/webhook', webhookRouter);

// Health check (Railway lo necesita)
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Lumux AI API' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Lumux AI API corriendo en puerto ${PORT}`);
}); 
