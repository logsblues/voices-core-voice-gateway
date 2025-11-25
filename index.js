// ===============================================================
// 📞 Voices Core - Voice Gateway v4 (Twilio + OpenAI Realtime)
// Versión: LOG de errores de OpenAI simplificado (mensaje claro)
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
  console.warn("❌ Falta OPENAI_API_KEY en Render → OpenAI no funcionará.");
}

// callSid -> { twilioWs, openAiWs, streamSid, pendingResponse }
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

    switch (event) {
      case "connected":
        console.log("🔗 Evento Twilio: connected");
        break;

      case "start":
        callSid = data.start.callSid;
        streamSid = data.start.streamSid;
        console.log(`▶️ Llamada iniciada. CallSid: ${callSid} StreamSid: ${streamSid}`);

        // Abrir WebSocket con OpenAI
        const openAiWs = connectOpenAI(callSid, streamSid);

        calls.set(callSid, {
          twilioWs: ws,
          openAiWs,
          streamSid,
          pendingResponse: false,
        });
        break;

      case "media":
        console.log("🎙 Evento Twilio: media");
        if (!callSid) return;

        const call = calls.get(callSid);
        if (!call || !call.openAiWs || call.openAiWs.readyState !== WebSocket.OPEN) {
          return;
        }

        const payload = data.media?.payload;
        if (!payload) return;

        try {
          // 1) Mandar audio (g711_ulaw base64)
          call.openAiWs.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: payload,
            })
          );

          // 2) Cerrar bloque
          call.openAiWs.send(
            JSON.stringify({
              type: "input_audio_buffer.commit",
            })
          );

          // 3) Pedir respuesta (solo una a la vez)
          if (!call.pendingResponse) {
            call.pendingResponse = true;
            call.openAiWs.send(
              JSON.stringify({
                type: "response.create",
                response: {
                  modalities: ["audio"],
                  instructions:
                    "Responde al usuario de manera breve, clara y cordial.",
                },
              })
            );
          }
        } catch (err) {
          console.error("🚨 Error enviando audio/response.create a OpenAI:", err);
        }
        break;

      case "mark":
        console.log("🔖 Marca Twilio:", data.mark?.name);
        break;

      case "stop":
        console.log("⏹ Evento stop recibido. CallSid:", callSid);
        cleanupCall(callSid);
        break;

      default:
        console.log("❓ Evento Twilio desconocido:", event);
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
// Conectar con OpenAI Realtime
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

    // 🔍 Log básico del tipo de evento
    console.log("🧠 Evento OpenAI:", event.type);

    // ⛔ Si es error, mostrar mensaje claro y salir
    if (event.type === "error") {
      const msg = event?.error?.message || "Error desconocido de OpenAI";
      const code = event?.error?.code || "sin-codigo";
      console.error("🧠 OpenAI ERROR:", code, "-", msg);
      return;
    }

    // 🔊 Audio incremental desde OpenAI hacia Twilio
    if (event.type === "response.audio.delta") {
      const call = calls.get(callSid);
      if (!call || call.twilioWs.readyState !== WebSocket.OPEN) return;

      const audioB64 =
        event.delta?.audio || event.delta || event.audio || null;

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

    // ✅ Cuando termina una respuesta, liberamos el candado
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
// Limpiar recursos de una llamada
// ==================================================
function cleanupCall(callSid) {
  if (!callSid) return;

  const call = calls.get(callSid);
  if (!call) return;

  console.log("🧹 Limpiando recursos de CallSid:", callSid);

  try {
    if (call.openAiWs && call.openAiWs.readyState === WebSocket.OPEN) {
      call.openAiWs.close();
    }
  } catch (e) {}

  try {
    if (call.twilioWs && call.twilioWs.readyState === WebSocket.OPEN) {
      call.twilioWs.close();
    }
  } catch (e) {}

  calls.delete(callSid);
}

// ==================================================
// Iniciar servidor HTTP
// ==================================================
server.listen(PORT, () => {
  console.log(`🚀 Voice Gateway v4 escuchando en puerto ${PORT}`);
});
