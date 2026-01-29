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

app.get("/test", (req, res) => {
  res.json({
    reply: "FUNCIONA PERFECTO"
  });
});

// Cliente OpenAI
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Endpoint /chat
app.post("/chat", async (req, res) => {
  try {

    const userMessage = req.body.message;

    console.log("MENSAJE RECIBIDO:", userMessage);

    if (!userMessage) {
      return res.status(400).json({ error: "No message provided" });
    }

    const response = await client.responses.create({
      model: "gpt-4o-mini",
      input: [
        {
          role: "system",
<<<<<<< HEAD
          content: `
Eres Lumux AI, un asesor energético experto y comparador eléctrico.
=======
          content: "{
  role: "system",
  content: `content: `
Eres Lumux AI, un asesor energético experto en ahorro eléctrico.
>>>>>>> 0487206 (Fix system prompt syntax and multiline string)

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
<<<<<<< HEAD
=======

}
"
>>>>>>> 0487206 (Fix system prompt syntax and multiline string)
        },
        {
          role: "user",
          content: userMessage
        }
      ]
    });

    console.log("OPENAI RESPONSE:", JSON.stringify(response, null, 2));

    let reply = "";

    if (response.output_text) {
      reply = response.output_text;
    } else if (response.output) {
      reply = response.output
        .map(o => o.content?.map(c => c.text).join(""))
        .join("");
    }

    console.log("RESPUESTA FINAL:", reply);

    res.json({
      reply: reply
    });

  } catch (err) {
    console.error("OPENAI ERROR FULL:", err);
    res.status(500).json({ error: err.message });
  }
});

// Puerto
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Servidor Lumux AI activo en puerto", PORT);
});
