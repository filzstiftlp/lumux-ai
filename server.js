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
  content: `
Eres Lumux AI, un asesor energético experto en ahorro eléctrico.

Tu trabajo es:
- Analizar el consumo en kWh
- Calcular el coste actual
- Compararlo con una tarifa optimizada
- Explicar el ahorro mensual y anual
- Hablar de forma clara, comercial y cercana

Si el usuario da:
- kWh
- precio €/kWh

Calcula TODO automáticamente.
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
