// ============================
// 📞 Voices Core - Voice Gateway v4 (Fase 2.1)
// Twilio Media Streams  <->  VoicesCore Gateway (Render)  <->  OpenAI Realtime
// Con response.create para que la IA responda
// ============================

const http = require("http");
const WebSocket = require("ws");

// ---------------------------
// Configuración básica
// ---------------------------
const PORT = process.env.PORT || 10000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview";

if (!OPENAI_API_KEY) {
  console.warn("⚠️ Falta OPENAI_API_KEY en las variables de entorno de Render.");
}

// Mapa en memoria para llamadas activas
// callSid -> { twilioWs, openAiWs, streamSid, pendingResponse }
const calls = new Map();

// ---------------------------
// Servidor HTTP base
// ---------------------------
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("VoicesCore Voice Gateway v4 is running.\n");
});

// Servidor WebSocket sobre HTTP
const wss = new WebSocket.Server({ noServer: true });

// ---------------------------
// Upgrade HTTP -> WebSocket
// ---------------------------
server.on("upgrade", (request, socket, head) => {
  const { url } = request;
  console.log("🔁 HTTP upgrade solicitado. URL:", url);

  if (url === "/twilio-stream") {
    console.log("✅ Aceptando conexión WS para /twilio-stream");
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    console.log("❌ Rechazando upgrade (ruta no válida):", url);
    socket.destroy();
  }
});

// ---------------------------
// Conexión desde Twilio
// ---------------------------
wss.on("connection", (ws, request) => {
  console.log("🌐 Nueva conexión WebSocket desde Twilio");

  let callSid = null;
  let streamSid = null;

  ws.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch (err) {
      console.error("🚨 Error parseando mensaje Twilio:", err);
      return;
    }

    const event = data.event;

    switch (event) {
      case "connected": {
        console.log("🔗 Evento Twilio: connected");
        break;
      }

      case "start": {
        callSid = data.start?.callSid;
        streamSid = data.start?.streamSid;
        console.log("▶️ Llamada iniciada. CallSid:", callSid, "StreamSid:", streamSid);

        // Crear conexión con OpenAI para esta llamada
        const openAiWs = connectOpenAiRealtime(callSid, streamSid);

        // Guardar en el mapa
        calls.set(callSid, {
          twilioWs: ws,
          openAiWs,
          streamSid,
          pendingResponse: false,
        });

        break;
      }

      case "media": {
        console.log("🎙 Evento Twilio: media");
        const payload = data.media?.payload;
        if (!payload || !callSid) return;

        const call = calls.get(callSid);
        if (!call || !call.openAiWs || call.openAiWs.readyState !== WebSocket.OPEN) {
          return;
        }

        // Enviar audio a OpenAI Realtime
        try {
          // 1) Enviamos el audio (g711_ulaw base64)
          call.openAiWs.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: payload,
            })
          );

          // 2) Confirmamos que terminamos este bloque
          call.openAiWs.send(
            JSON.stringify({
              type: "input_audio_buffer.commit",
            })
          );

          // 3) Pedimos a OpenAI que genere una respuesta
          if (!call.pendingResponse) {
            call.pendingResponse = true;

            call.openAiWs.send(
              JSON.stringify({
                type: "response.create",
                response: {
                  modalities: ["audio"],
                  instructions: "Responde al usuario de manera breve y natural.",
                },
              })
            );
          }
        } catch (err) {
          console.error("🚨 Error enviando audio/response.create a OpenAI:", err);
        }

        break;
      }

      case "mark": {
        console.log("🔖 Marca Twilio:", data.mark?.name);
        break;
      }

      case "stop": {
        console.log("⏹ Evento stop recibido. CallSid:", callSid);
        cleanupCall(callSid);
        break;
      }

      default:
        console.log("❓ Evento Twilio desconocido:", event);
    }
  });

  ws.on("close", () => {
    console.log("🔌 Conexión WebSocket Twilio cerrada");
    if (callSid) {
      cleanupCall(callSid);
    }
  });

  ws.on("error", (err) => {
    console.error("⚠️ Error WebSocket Twilio:", err);
  });
});

// ---------------------------
// Conexión a OpenAI Realtime
// ---------------------------
function connectOpenAiRealtime(callSid, streamSid) {
  if (!OPENAI_API_KEY) {
    console.error("❌ No se puede conectar a OpenAI: falta OPENAI_API_KEY");
    return null;
  }

  const url = `wss://api.openai.com/v1/realtime?model=${OPENAI_REALTIME_MODEL}`;

  console.log("🧠 Abriendo WS a OpenAI Realtime para CallSid:", callSid);

  const openAiWs = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  openAiWs.on("open", () => {
    console.log("🧠 OpenAI WS conectado para CallSid:", callSid);

    // Prompt maestro básico – luego metemos el v4 completo
    const instructions = `
Eres el asistente de voz de Voices Core.
Eres totalmente bilingüe (español e inglés).
Respondes MUY natural y breve.
Tu objetivo en cada llamada:
1. Saludar cordialmente.
2. Detectar en qué idioma habla el cliente.
3. Pedir y confirmar: nombre, número de teléfono y correo electrónico.
4. Preguntar por el motivo principal de la llamada (venta, soporte, cita, etc.).
5. Resumir la necesidad del cliente en una frase corta.
6. Preguntar si desea hablar con un agente humano ahora o agendar una llamada.
Nunca inventes información de la empresa; si no sabes algo, di que lo confirmará un agente humano.
    `.trim();

    const sessionUpdate = {
      type: "session.update",
      session: {
        instructions,
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        modalities: ["audio"],
        voice: "alloy",
      },
    };

    try {
      openAiWs.send(JSON.stringify(sessionUpdate));
    } catch (err) {
      console.error("🚨 Error enviando session.update a OpenAI:", err);
    }
  });

  openAiWs.on("message", (msg) => {
    let event;
    try {
      event = JSON.parse(msg.toString());
    } catch (err) {
      console.error("🚨 Error parseando mensaje de OpenAI:", err);
      return;
    }

    // Log básico para ver qué llega
    console.log("🧠 Evento OpenAI:", event.type);

    // Manejo de audio incremental
    if (event.type === "response.audio.delta") {
      const call = Array.from(calls.entries()).find(
        ([id, c]) => id === callSid
      )?.[1];

      if (!call || call.twilioWs.readyState !== WebSocket.OPEN) return;

      const audioB64 =
        (event.delta && event.delta.audio) ||
        event.delta ||
        event.audio ||
        null;

      if (!audioB64) return;

      const frame = {
        event: "media",
        streamSid: call.streamSid,
        media: {
          payload: audioB64, // asumimos g711_ulaw base64
        },
      };

      try {
        call.twilioWs.send(JSON.stringify(frame));
      } catch (err) {
        console.error("🚨 Error enviando audio a Twilio:", err);
      }
    }

    // Cuando la respuesta termina, liberamos el lock
    if (event.type === "response.completed") {
      const call = calls.get(callSid);
      if (call) {
        call.pendingResponse = false;
      }
    }
  });

  openAiWs.on("close", () => {
    console.log("🔌 OpenAI WS cerrado para CallSid:", callSid);
  });

  openAiWs.on("error", (err) => {
    console.error("⚠️ Error WebSocket OpenAI:", err);
  });

  return openAiWs;
}

// ---------------------------
// Limpieza de llamadas
// ---------------------------
function cleanupCall(callSid) {
  if (!callSid) return;

  const call = calls.get(callSid);
  if (!call) return;

  console.log("🧹 Limpiando recursos de CallSid:", callSid);

  try {
    if (call.openAiWs && call.openAiWs.readyState === WebSocket.OPEN) {
      call.openAiWs.close();
    }
  } catch (err) {
    console.error("⚠️ Error cerrando WS OpenAI:", err);
  }

  try {
    if (call.twilioWs && call.twilioWs.readyState === WebSocket.OPEN) {
      call.twilioWs.close();
    }
  } catch (err) {
    console.error("⚠️ Error cerrando WS Twilio:", err);
  }

  calls.delete(callSid);
}

// ---------------------------
// Iniciar servidor HTTP
// ---------------------------
server.listen(PORT, () => {
  console.log(`🚀 Voice Gateway v4 escuchando en puerto ${PORT}`);
});
