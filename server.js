import 'dotenv/config'
import express from "express"
import cors from "cors"
import OpenAI from "openai"
import axios from "axios"
import Tesseract from "tesseract.js"
import { createRequire } from "module"
import { fromBuffer } from "pdf2pic"
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.js"
import { createCanvas } from "canvas"

const require = createRequire(import.meta.url)
const pdfParse = require("pdf-parse").default

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
/* OCR PARA IMAGEN */
/* -------------------------------- */

async function readImageOCR(url){

  const response = await axios.get(url,{responseType:"arraybuffer"})

  const result = await Tesseract.recognize(
    Buffer.from(response.data),
    "spa"
  )

  const text = result?.data?.text || ""

  return text
}

/* -------------------------------- */
/* OCR PARA PDF */
/* -------------------------------- */

async function readPdfOCR(url){

  const response = await axios.get(url,{responseType:"arraybuffer"})
  const buffer = Buffer.from(response.data)

  const loadingTask = pdfjsLib.getDocument({data: buffer})
  const pdf = await loadingTask.promise

  const page = await pdf.getPage(1)

  const viewport = page.getViewport({scale:2})

  const canvas = createCanvas(viewport.width,viewport.height)
  const context = canvas.getContext("2d")

  await page.render({
    canvasContext:context,
    viewport:viewport
  }).promise

  const imageBuffer = canvas.toBuffer()

  const { data:{ text } } = await Tesseract.recognize(
    imageBuffer,
    "spa"
  )

  return text
}

/* -------------------------------- */
/* EXTRAER DATOS DE FACTURA */
/* -------------------------------- */

function extractEnergyData(text){

  if(!text) return {consumo:null,potencia:null,precio:null}

  let consumo = 0

  const consumos = text.match(/(\d+[,\.]?\d*)\s?kwh/gi)

  if(consumos){
    consumos.forEach(c=>{
      const val = parseFloat(
        c.replace(/[^\d.,]/g,"").replace(",",".")
      )

      if(!isNaN(val)){
        consumo += val
      }
    })
  }

  const potenciaMatch = text.match(/(\d+[,\.]?\d*)\s?kW/i)

  const potencia = potenciaMatch
    ? parseFloat(potenciaMatch[1].replace(",","."))
    : null

  const precios = text.match(/(\d+[,\.]\d{2})\s?€/g)

  let precio = null

  if(precios){

    const ultimo = precios[precios.length - 1]

    precio = parseFloat(
      ultimo.replace(/[^\d.,]/g,"").replace(",",".")
    )

  }

  return {consumo,potencia,precio}

}

/* -------------------------------- */
/* CALCULO DE AHORRO */
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
/* ENDPOINT PRINCIPAL */
/* -------------------------------- */

app.post("/chat", async (req,res)=>{

  try{

    const input = req.body.message

    console.log("INPUT RECIBIDO:",input)

    if(!input){

      return res.json({
        reply:"No he recibido ningún dato."
      })

    }

    let text = ""

    /* Detectar si es URL */

    if(typeof input === "string" && input.startsWith("http")){

      console.log("FACTURA DETECTADA")

      if(input.includes(".pdf")){

        text = await readPdfOCR(input)
console.log("OCR RESULTADO:")
console.log(text)
      }else{

        text = await readImageOCR(input)

      }

      console.log("TEXTO OCR:",text)

      const {consumo,potencia,precio} = extractEnergyData(text)

      if(!consumo || !precio){

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

    /* ------------------------------ */
    /* FALLBACK IA SI ES TEXTO */
/* ------------------------------ */

    const response = await client.responses.create({
      model:"gpt-4o-mini",
      input:input
    })

    const reply = response.output_text

    res.json({reply})

  }

  catch(err){

    console.error("ERROR:",err)

    res.json({
      reply:"Ha ocurrido un problema analizando la factura."
    })

  }

})

const PORT = process.env.PORT || 3000

app.listen(PORT,()=>{

  console.log("Servidor Lumux AI activo en puerto",PORT)

})