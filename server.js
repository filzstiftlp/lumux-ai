import 'dotenv/config';
import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
app.use(cors());
app.use(express.json());

// Ruta raíz
app.get("/", (req, res) => {
  res.send("Lumux AI backend activo 🚀");
});

// Cliente OpenAI
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Endpoint /chat
app.post("/chat", async (req, res) => {
  try {
    const userMessage = req.body.message;

    if (!userMessage) {
      return res.status(400).json({ error: "No message provided" });
    }

    const response = await client.responses.create({
      model: "gpt-4o-mini",
      input: [
        {
          role: "system",
          content: "{
  role: "system",
  content: `
Eres Lumux AI, un asesor energético experto y comparador eléctrico.

Tu función es analizar facturas de luz, calcular el consumo anual y mostrar el ahorro económico real comparando la tarifa actual del cliente con una tarifa optimizada de 0,111 €/kWh.

Forma de actuar:
- Analizas los kWh y el precio €/kWh que indique el usuario.
- Si hay varios tramos, los sumas.
- Calculas:
  • Consumo anual (kWh × 12)
  • Coste actual anual
  • Coste anual con tarifa optimizada (0,111 €/kWh)
  • Ahorro anual estimado

Tono:
- Claro, directo, cercano
- Nada de lenguaje comercial agresivo
- Transmites seguridad y transparencia
- Antiteleoperador

Reglas importantes:
- NO pidas IBAN ni DNI en esta fase
- Explica siempre los números
- Refuerza que el cambio es administrativo y sin cortes
- Termina con una pregunta de intención suave (ej: “¿Quieres que te diga cómo aplicar este ahorro?”)

Objetivo final:
Demostrar ahorro real y preparar el terreno para que un agente humano cierre la contratación.
`
}
"
        },
        {
          role: "user",
          content: userMessage
        }
      ]
    });

    const reply = response.output_text;

    res.send(reply);


  } catch (err) {
    console.error("OPENAI ERROR FULL:", err);
    res.status(500).json({ error: err.message });
  }
}); // 👈 ESTA LLAVE FALTABA

// Puerto
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Servidor Lumux AI activo en puerto", PORT);
});
