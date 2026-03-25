require('dotenv').config();
const express = require('express');
const app = express();

// CORS - permitir peticiones desde lumux.es y otros orígenes
app.use((req, res, next) => {
  const allowed = ['https://lumux.es', 'https://www.lumux.es'];
  const origin = req.headers.origin;
  if (allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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