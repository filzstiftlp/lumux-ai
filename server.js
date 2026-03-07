import 'dotenv/config'
import express from "express"
import cors from "cors"
import OpenAI from "openai"
import axios from "axios"
import Tesseract from "tesseract.js"
import { createRequire } from "module"

const require = createRequire(import.meta.url)
const pdfParseLib = require("pdf-parse")
const pdfParse = pdfParseLib.default || pdfParseLib

const app = express()
app.use(cors())
app.use(express.json())

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

app.get("/", (req,res)=>{
  res.send("Lumux AI backend activo 🚀")
})

/* -------------------------------- */
/* OCR IMAGEN */
/* -------------------------------- */

async function readImageOCR(url){

  const response = await axios.get(url,{responseType:"arraybuffer"})

  const result = await Tesseract.recognize(
    Buffer.from(response.data),
    "spa"
  )

  return result?.data?.text || ""
}

/* -------------------------------- */
/* OCR PDF */
/* -------------------------------- */

async function readPdfOCR(url){

  const response = await axios.get(url,{responseType:"arraybuffer"})
  const buffer = Buffer.from(response.data)

  try{

    const data = await pdfParse(buffer)

    if(data.text && data.text.length > 20){
      console.log("PDF contiene texto")
      return data.text
    }

    console.log("PDF sin texto suficiente")
    return ""

  }catch(err){

    console.log("Error leyendo PDF:", err.message)
    return ""
  }
}

/* -------------------------------- */
/* EXTRAER DATOS */
/* -------------------------------- */

function extractEnergyData(text){

  if(!text) return {consumo:null,potencia:null,precio:null}

  let consumo = 0

  const consumos = text.match(/(\d+[.,]?\d*)\s?kwh/gi)

  if(consumos){

    consumos.forEach(c=>{

      const val = parseFloat(
        c.replace(/[^\d.,]/g,"").replace(",",".")
      )

      if(!isNaN(val) && val < 2000){
        consumo += val
      }

    })

  }

  const potenciaMatch = text.match(/(\d+[.,]?\d*)\s?kW/i)

  const potencia = potenciaMatch
    ? parseFloat(potenciaMatch[1].replace(",","."))
    : null

  let precio = null

  const totalMatch = text.match(/total\s*a\s*pagar[^0-9]*(\d+[.,]?\d*)/i)

  if(totalMatch){

    let valor = totalMatch[1]

    if(!valor.includes(",") && !valor.includes(".") && valor.length > 2){
      valor = valor.slice(0,-2) + "." + valor.slice(-2)
    }

    precio = parseFloat(valor.replace(",","."))
  }

  if(!precio){

    const precios = text.match(/(\d+[.,]?\d*)\s?€/g)

    if(precios){

      const ultimo = precios[precios.length - 1]

      let valor = ultimo.replace(/[^\d.,]/g,"")

      if(!valor.includes(",") && !valor.includes(".") && valor.length > 2){
        valor = valor.slice(0,-2) + "." + valor.slice(-2)
      }

      precio = parseFloat(valor.replace(",","."))
    }

  }

  return {consumo,potencia,precio}
}

/* -------------------------------- */
/* CALCULO AHORRO */
/* -------------------------------- */

function calcularAhorro(consumo,precioActual){

  const precioEnergiaLumux = 0.111

  const costeLumux = consumo * precioEnergiaLumux

  const ahorroMensual = precioActual - costeLumux
  const ahorroAnual = ahorroMensual * 12

  return {
    costeLumux,
    ahorroMensual,
    ahorroAnual
  }
}

/* -------------------------------- */
/* ENDPOINT */
/* -------------------------------- */

app.post("/chat", async (req,res)=>{

  try{

    const input = req.body.message

    console.log("INPUT RECIBIDO:",input)

    if(!input){
      return res.json({reply:"No he recibido ningún dato."})
    }

    let text = ""

    if(typeof input === "string" && input.startsWith("http")){

      console.log("FACTURA DETECTADA")

      if(input.includes(".pdf")){
        text = await readPdfOCR(input)
      }else{
        text = await readImageOCR(input)
      }

      console.log("TEXTO OCR:", text)

      if(!text || text.length < 20){
        return res.json({
          reply:"No he podido leer correctamente la factura. ¿Podrías enviar una foto más clara?"
        })
      }

      const {consumo,potencia,precio} = extractEnergyData(text)

      console.log("DATOS EXTRAIDOS:", {consumo,potencia,precio})

      if(!consumo || !precio || isNaN(consumo) || isNaN(precio)){
        return res.json({
          reply:"No he podido leer correctamente la factura. ¿Podrías enviar una foto más clara?"
        })
      }

      const {costeLumux,ahorroMensual,ahorroAnual} =
        calcularAhorro(consumo,precio)

      const reply = `
He analizado tu factura 🔎

Consumo mensual: ${consumo.toFixed(0)} kWh  
Potencia contratada: ${potencia ?? "no detectada"} kW  

Coste actual aproximado: ${precio.toFixed(2)} €

Con nuestras tarifas pagarías aproximadamente:

${costeLumux.toFixed(2)} €

💰 Ahorro estimado mensual: ${ahorroMensual.toFixed(2)} €  
💰 Ahorro estimado anual: ${ahorroAnual.toFixed(2)} €

El cambio es administrativo y no hay cortes de suministro.

¿Quieres saber qué compañía puede ofrecerte este precio y aplicar el ahorro?
`

      return res.json({reply})
    }

    const response = await client.responses.create({
      model:"gpt-4o-mini",
      input:input
    })

    const reply = response.output_text

    return res.json({reply})

  }catch(err){

    console.error("ERROR:", err)

    return res.json({
      reply:"Ha ocurrido un problema analizando la factura."
    })
  }
})

const PORT = process.env.PORT || 3000

app.listen(PORT,()=>{
  console.log("Servidor Lumux AI activo en puerto",PORT)
})