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