require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const app = express();

// Railway corre detrás de un reverse proxy — necesario para que
// express-rate-limit lea X-Forwarded-For sin lanzar ValidationError
app.set('trust proxy', 1);

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

// ─── RATE LIMITING ────────────────────────────────────────────────────────────
// WhatsApp webhook: Meta envía 1 msg a la vez por usuario, 30/min es más que suficiente
const limiterWhatsApp = rateLimit({
  windowMs: 60 * 1000,       // 1 minuto
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests' },
  skip: (req) => req.method === 'GET', // verificación GET de Meta siempre pasa
});

// Contrato: máx 5 firmas por IP cada 15 min (previene spam de contratos falsos)
const limiterContrato = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutos
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests' },
});

// Admin export: máx 20 descargas por hora
const limiterAdmin = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hora
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests' },
});

app.use('/webhook/whatsapp', limiterWhatsApp);
app.use('/webhook/contrato', limiterContrato);
app.use('/webhook/admin', limiterAdmin);

// ─── BODY LIMITS + FIRMA WHATSAPP ────────────────────────────────────────────
// /contrato recibe base64 de 2 DNIs + factura (~10-12MB). El resto no necesita más de 1MB.
app.use('/webhook/contrato', express.json({ limit: '15mb' }));
app.use('/webhook/contrato', express.urlencoded({ extended: true, limit: '15mb' }));

// Para el webhook de WhatsApp necesitamos el raw body para verificar la firma HMAC
const { verificarFirmaWhatsApp } = require('./webhook');
app.use('/webhook/whatsapp', express.json({
  limit: '1mb',
  verify: (req, res, buf) => {
    try { verificarFirmaWhatsApp(req, res, buf); }
    catch(e) { res.status(401).json({ error: 'Unauthorized' }); throw e; }
  }
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

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
  // Auto-provisioning Chatwoot: detectar IDs de Alberto y Adrián al arrancar
  if (process.env.CHATWOOT_URL && process.env.CHATWOOT_API_TOKEN) {
    provisionarChatwoot().catch(e => console.error('[Chatwoot init] Error:', e.message));
  }
});

async function provisionarChatwoot() {
  const axios = require('axios');
  const base  = { headers: { api_access_token: process.env.CHATWOOT_API_TOKEN } };
  try {
    const { data: agents } = await axios.get(
      `${process.env.CHATWOOT_URL}/api/v1/accounts/1/agents`, base
    );

    // ── Alberto (admin/auditor): detectar por email ──────────────────────────
    if (!process.env.CHATWOOT_ALBERTO_ID) {
      const alberto = agents.find(a => a.email === 'ceo@lumux.es');
      if (alberto) {
        process.env.CHATWOOT_ALBERTO_ID = String(alberto.id);
        console.log(`[Chatwoot] Alberto id=${alberto.id}`);
      } else {
        console.warn('[Chatwoot] No se encontró Alberto (ceo@lumux.es) en agents');
      }
    }

    // ── Adrián (agente): buscar o crear ──────────────────────────────────────
    if (!process.env.CHATWOOT_ADRIAN_ID) {
      const adrianEmail = process.env.CHATWOOT_ADRIAN_EMAIL || 'adrian.costales@lumux.es';
      const adrian = agents.find(a => a.email === adrianEmail);
      if (adrian) {
        process.env.CHATWOOT_ADRIAN_ID = String(adrian.id);
        console.log(`[Chatwoot] Adrián encontrado id=${adrian.id}`);
      } else {
        const pass = process.env.CHATWOOT_ADRIAN_PASS || 'Lumux2025!';
        // role: 'agent' → permisos mínimos:
        //   ✅ Ve solo conversaciones asignadas a él (pestaña "Mine")
        //   ✅ Puede responder y desasignarse
        //   ❌ Sin acceso a Reports, Settings, Campaigns, Contacts globales
        const { data: nuevo } = await axios.post(
          `${process.env.CHATWOOT_URL}/api/v1/accounts/1/agents`,
          {
            name:                  'Adrián',
            email:                 adrianEmail,
            role:                  'agent',
            password:              pass,
            password_confirmation: pass,
          },
          base
        );
        const id = String(nuevo?.id || nuevo?.payload?.id);
        process.env.CHATWOOT_ADRIAN_ID = id;
        console.log(`[Chatwoot] Adrián CREADO id=${id} email=${adrianEmail} role=agent`);
        console.log(`[Chatwoot] Adrián recibirá email de bienvenida en ${adrianEmail}`);
        console.log(`[Chatwoot] Indicarle que use la vista "Mine" y el inbox de WhatsApp`);
      }
    }
  } catch(e) {
    console.error('[Chatwoot init] Error provisionando agentes:', e.response?.data || e.message);
  }
}