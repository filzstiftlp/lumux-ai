import 'dotenv/config'
import express from "express"
import cors from "cors"
import OpenAI from "openai"
import axios from "axios"
import Tesseract from "tesseract.js"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { exec } from "child_process"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

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

  try{

    const response = await axios.get(url,{responseType:"arraybuffer"})

    const result = await Tesseract.recognize(
      Buffer.from(response.data),
      "spa"
    )

    return result?.data?.text || ""

  }catch(err){

    console.log("Error OCR imagen:",err.message)
    return ""

  }
}

/* -------------------------------- */
/* OCR PDF */
/* -------------------------------- */

async function readPdfOCR(url){

  try{

    const pdfPath = path.join(__dirname,"temp.pdf")
    const imgPath = path.join(__dirname,"temp.png")

    const response = await axios.get(url,{responseType:"arraybuffer"})
    fs.writeFileSync(pdfPath,response.data)

    await new Promise((resolve,reject)=>{

      exec(
        `pdftoppm -png -singlefile ${pdfPath} temp`,
        {cwd:__dirname},
        (error)=>{
          if(error) reject(error)
          else resolve()
        }
      )

    })

    const imageBuffer = fs.readFileSync(imgPath)

    const result = await Tesseract.recognize(
      imageBuffer,
      "spa"
    )

    fs.unlinkSync(pdfPath)
    fs.unlinkSync(imgPath)

    return result?.data?.text || ""

  }catch(err){

    console.log("Error leyendo PDF:",err.message)
    return ""

  }
}

/* -------------------------------- */
/* EXTRAER DATOS */
/* -------------------------------- */

function extractEnergyData(text){

  if(!text) return {consumo:null,potencia:null,precio:null,dias:null,nombre:null,direccion:null}

  const cleanNumber = (n)=>{
    return parseFloat(
      n.replace(/\./g,"").replace(",",".")
    )
  }

  /* CONSUMO */

  let consumo=null

  const consumoMatch = text.match(/([\d.,]+)\s*kwh/i)

  if(consumoMatch){
    consumo = cleanNumber(consumoMatch[1])
  }

  /* POTENCIA */

  let potencia=null

  const potenciaMatch = text.match(/(\d+[.,]?\d*)\s*kW/i)

  if(potenciaMatch){
    potencia = cleanNumber(potenciaMatch[1])
  }

  /* DIAS FACTURADOS */

  let dias=null

  const diasMatch = text.match(/(\d+)\s*d[ií]as/i)

  if(diasMatch){
    dias=parseInt(diasMatch[1])
  }

  /* TOTAL FACTURA */

  let precio=null

  const totalMatch = text.match(/total[^0-9]{0,20}([\d.,]+)\s?€/i)

  if(totalMatch){
    precio = cleanNumber(totalMatch[1])
  }

  /* NOMBRE */

  let nombre=null

  const nombreMatch = text.match(/Titular.*?:\s*(.*)/i)

  if(nombreMatch){
    nombre = nombreMatch[1].trim()
  }

  /* DIRECCION */

  let direccion=null

  const dirMatch = text.match(/Direcci[oó]n.*?:\s*(.*)/i)

  if(dirMatch){
    direccion = dirMatch[1].trim()
  }

  return {consumo,potencia,precio,dias,nombre,direccion}

}

/* -------------------------------- */
/* CALCULO AHORRO */
/* -------------------------------- */

function calcularAhorro(consumo,potencia,dias,precioActual){

  const energia = consumo * 0.111

  const potenciaCoste = potencia * dias * 0.17

  let subtotal = energia + potenciaCoste

  subtotal = subtotal * 1.0511269632

  const totalLumux = subtotal * 1.21

  const ahorroMensual = precioActual - totalLumux

  const ahorroAnual = ahorroMensual * 12

  return{
    totalLumux,
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
      }
      else{
        text = await readImageOCR(input)
      }

      console.log("TEXTO OCR:",text)

      if(!text || text.length < 20){

        return res.json({
          reply:"No he podido leer correctamente la factura. ¿Podrías enviar una foto más clara?"
        })

      }

      const {consumo,potencia,precio,dias,nombre,direccion} =
      extractEnergyData(text)

      console.log("DATOS EXTRAIDOS:",{consumo,potencia,precio,dias,nombre,direccion})

      if(!consumo || !precio || !potencia || !dias){

        return res.json({
          reply:"No he podido analizar correctamente la factura. Intenta enviar otra imagen."
        })

      }

      const {totalLumux,ahorroMensual,ahorroAnual} =
      calcularAhorro(consumo,potencia,dias,precio)

      const reply = `

He analizado tu factura 🔎

Titular: ${nombre ?? "No detectado"}
Dirección: ${direccion ?? "No detectada"}

Consumo: ${consumo.toFixed(2)} kWh
Potencia: ${potencia} kW
Periodo: ${dias} días

Total factura actual: ${precio.toFixed(2)} €

Con Lumux pagarías aproximadamente:

${totalLumux.toFixed(2)} €

💰 Ahorro estimado en esta factura: ${ahorroMensual.toFixed(2)} €
💰 Ahorro anual estimado: ${(ahorroAnual).toFixed(2)} €

¿Quieres saber qué compañía puede aplicarte este ahorro?
`

      return res.json({reply})

    }

    const response = await client.responses.create({
      model:"gpt-4o-mini",
      input:input
    })

    const reply = response.output_text

    return res.json({reply})

  }

  catch(err){

    console.error("ERROR:",err)

    return res.json({
      reply:"Ha ocurrido un problema analizando la factura."
    })

  }

})

const PORT = process.env.PORT || 3000

app.listen(PORT,()=>{
  console.log("Servidor Lumux AI activo en puerto",PORT)
})