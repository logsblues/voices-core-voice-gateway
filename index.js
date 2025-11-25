// ===============================================================
// 📞 Voices Core - Voice Gateway v4 (Con Twilio + OpenAI Realtime)
// Fase: DEPURACIÓN PROFUNDA (con logging completo de errores)
// ===============================================================

const http = require("http");
const WebSocket = require("ws");

// ---------------------------
// Configuración
// ---------------------------
const PORT = process.env.PORT || 10000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview";

if (!OPENAI_API_KEY) {
  console.warn("❌ Falta OPENAI_API_KEY en Render → no funcionará OpenAI.");
}

// Mapa global para llamadas activas
const calls = new Map();

// ---------------------------
// Servidor HTTP base
// ---------------------------
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Voices Core - Voice Gateway v4 is running.\n");
});

// ---------------------------
// WebSocket Server
// ---------------------------
const wss = new WebSocket.Server({ noServer: true });

// ---------------------------
// Upgrade HTTP → WebSocket
// ---------------------------
server.on("upgrade", (req, socket, head) => {
  const { url } = req;
  console.log("🔁 HTTP upgrade solicitado. URL:", url);

  if (url === "/twilio-stream") {
    console.log("✅ Aceptando conexión WS para /twilio-stream");
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    console.log("❌ Rechazando upgrade WS (ruta inválida):", url);
    socket.destroy();
  }
});

// ---------------------------
// TWILIO → NUEVA CONEXIÓN WS
// ---------------------------
wss.on("connection", (ws, request) => {
  console.log("🌐 Nueva conexión WebSocket desde Twilio");

  let callSid = null;
  let streamSid = null;

  ws.on("message", (msg) => {
    let data = null;
    try {
      data = JSON.parse(msg.toString());
    } catch (err) {
      console.error("🚨 Error parseando JSON de Twilio:", err);
      return;
    }

    const event = data.event;

    // -------------------------
    // EVENTOS DE TWILIO
    // -------------------------

    if (event === "connected") {
      console.log("🔗 Evento Twilio: connected");
    }

    if (event === "start") {
      callSid = data.start.callSid;
      streamSid = data.start.streamSid;

      console.log(`▶️ Llamada iniciada. CallSid: ${callSid} StreamSid: ${streamSid}`);

      // Abrir WebSocket con OpenAI
      const openAiWs = connectOpenAI(callSid, streamSid);

      // Guardar llamada
      calls.set(callSid, {
        twilioWs: ws,
        openAiWs,
        streamSid,
        pendingResponse: false,
      });
    }

    if (event === "media") {
      console.log("🎙 Evento Twilio: media");

      const call = calls.get(callSid);
      if (!call || !call.openAiWs) return;

      const payload = data.media.payload;
      if (!payload) return;

      try {
        // Enviar audio g711_ulaw a OpenAI
        call.openAiWs.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: payload,
          })
        );

        // Confirmar bloque
        call.openAiWs.send(
          JSON.stringify({
            type: "input_audio_buffer.commit",
          })
        );

        // Pedir respuesta
        if (!call.pendingResponse) {
          call.pendingResponse = true;

          call.openAiWs.send(
            JSON.stringify({
              type: "response.create",
              response: {
                modalities: ["audio"],
                instructions:
                  "Responde al usuario con una voz natural, breve y cordial.",
              },
            })
          );
        }
      } catch (err) {
        console.error("🚨 Error enviando audio a OpenAI:", err);
      }
    }

    if (event === "mark") {
      console.log("🔖 Marca Twilio:", data.mark.name);
    }

    if (event === "stop") {
      console.log("⏹ Evento stop recibido. CallSid:", callSid);
      cleanupCall(callSid);
    }
  });

  ws.on("close", () => {
    console.log("🔌 Conexión WebSocket Twilio cerrada");
    cleanupCall(callSid);
  });

  ws.on("error", (err) => {
    console.error("⚠️ Error WS Twilio:", err);
  });
});

// ======================================================
// FUNCION: Crear conexión WebSocket con OpenAI Realtime
// ======================================================
function connectOpenAI(callSid, streamSid) {
  console.log("🧠 Abriendo WS a OpenAI Realtime para CallSid:", callSid);

  const ws = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${OPENAI_REALTIME_MODEL}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  ws.on("open", () => {
    console.log("🧠 OpenAI WS conectado para CallSid:", callSid);

    // --------------------
    // PROMPT BASE
    // --------------------
    const instructions = `
Eres el asistente de voz oficial de Voices Core.
Hablas español e inglés de forma natural.
Recibes llamadas entrantes de clientes.
Tu misión:
1. Saludar cordialmente.
2. Detectar idioma del cliente.
3. Pedir nombre, teléfono y email.
4. Preguntar motivo de la llamada.
5. Ofrecer transferir a un agente humano o agendar.

Habla siempre de forma breve, humana y clara.
No inventes información de la empresa.
    `.trim();

    // Configurar sesión
    ws.send(
      JSON.stringify({
        type: "session.update",
        session: {
          instructions,
          voice: "alloy",
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          modalities: ["audio"],
        },
      })
    );
  });

  ws.on("message", (data) => {
    let event;
    try {
      event = JSON.parse(data.toString());
    } catch (err) {
      console.error("🧠 Error parseando mensaje de OpenAI:", err);
      return;
    }

    console.log("🧠 Evento OpenAI:", event.type);

    // ------------------------
    // LOG COMPLETO DEL ERROR
    // ------------------------
    if (event.type === "error") {
      console.error(
        "🧠 OpenAI error DETALLE:\n",
        JSON.stringify(event, null, 2)
      );
      return;
    }

    // ------------------------
    // AUDIO DE RESPUESTA
    // ------------------------
    if (event.type === "response.audio.delta") {
      const call = calls.get(callSid);
      if (!call) return;

      const audioB64 =
        event.delta?.audio || event.delta || event.audio || null;

      if (!audioB64) return;

      try {
        call.twilioWs.send(
          JSON.stringify({
            event: "media",
            streamSid: call.streamSid,
            media: {
              payload: audioB64,
            },
          })
        );
      } catch (err) {
        console.error("🚨 Error enviando audio a Twilio:", err);
      }
    }

    // ------------------------
    // RESPUESTA COMPLETA
    // ------------------------
    if (event.type === "response.completed") {
      const call = calls.get(callSid);
      if (call) {
        call.pendingResponse = false;
      }
    }
  });

  ws.on("close", () => {
    console.log("🔌 OpenAI WS cerrado para CallSid:", callSid);
  });

  ws.on("error", (err) => {
    console.error("⚠️ Error WS OpenAI:", err);
  });

  return ws;
}

// ==================================================
// FUNCIÓN: LIMPIAR LLAMADA
// ==================================================
function cleanupCall(callSid) {
  if (!callSid) return;

  const call = calls.get(callSid);
  if (!call) return;

  console.log("🧹 Limpiando recursos de CallSid:", callSid);

  try {
    if (call.openAiWs?.readyState === WebSocket.OPEN) {
      call.openAiWs.close();
    }
  } catch {}

  try {
    if (call.twilioWs?.readyState === WebSocket.OPEN) {
      call.twilioWs.close();
    }
  } catch {}

  calls.delete(callSid);
}

// ==================================================
// INICIAR SERVIDOR
// ==================================================
server.listen(PORT, () => {
  console.log(`🚀 Voice Gateway v4 escuchando en puerto ${PORT}`);
});
