// ===============================================================
// 📞 Voices Core - Voice Gateway v4 (Twilio + OpenAI Realtime)
// Versión: commits cada 50 frames (~1s) sin pendingResponse
// ===============================================================

const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// Modelo realtime (puedes cambiarlo si usas otro)
const OPENAI_REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview";

if (!OPENAI_API_KEY) {
  console.warn("❌ Falta OPENAI_API_KEY en Render.");
}

// callSid -> { twilioWs, openAiWs, streamSid, framesAccumulated }
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
    console.log("❌ Rechazado upgrade (ruta inválida)", url);
    socket.destroy();
  }
});

// ---------------------------
// TWILIO → NUEVA CONEXIÓN WS
// ---------------------------
wss.on("connection", (ws) => {
  console.log("🌐 Nueva conexión WebSocket desde Twilio");

  let callSid = null;
  let streamSid = null;

  ws.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      console.error("🚨 Error parseando JSON de Twilio");
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

        console.log(`▶️ Llamada iniciada: ${callSid} (StreamSid: ${streamSid})`);

        const openAiWs = connectOpenAI(callSid, streamSid);

        calls.set(callSid, {
          twilioWs: ws,
          openAiWs,
          streamSid,
          framesAccumulated: 0,
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
          // 1) Mandamos el frame de audio a OpenAI (g711_ulaw base64)
          call.openAiWs.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: payload,
            })
          );

          // 2) Aumentamos contador de frames
          call.framesAccumulated = (call.framesAccumulated || 0) + 1;
          console.log(
            `🔊 Frames acumulados para ${callSid}: ${call.framesAccumulated}`
          );

          // 3) Cada 50 frames (~1s de audio), hacemos commit + response.create
          if (call.framesAccumulated % 50 === 0) {
            console.log(
              `✅ Commit + response.create para ${callSid} (frames=${call.framesAccumulated})`
            );

            // Commit del buffer actual
            call.openAiWs.send(
              JSON.stringify({
                type: "input_audio_buffer.commit",
              })
            );

            // Pedimos una respuesta en audio
            call.openAiWs.send(
              JSON.stringify({
                type: "response.create",
                response: {
                  modalities: ["audio"],
                  instructions:
                    "Responde de forma breve, clara, humana y cordial al usuario.",
                },
              })
            );
          }
        } catch (err) {
          console.error("🚨 Error enviando audio/commit/response → OpenAI:", err);
        }
        break;

      case "stop":
        console.log("⏹ Evento stop recibido:", callSid);
        cleanupCall(callSid);
        break;

      default:
        console.log("❓ Evento Twilio desconocido:", event);
    }
  });

  ws.on("close", () => cleanupCall(callSid));
});

// ------------------------
// Conectar a OpenAI
// ------------------------
function connectOpenAI(callSid, streamSid) {
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
    console.log(`🧠 OpenAI conectado para CallSid ${callSid}`);

    ws.send(
      JSON.stringify({
        type: "session.update",
        session: {
          instructions:
            "Eres un asistente de voz de Voices Core. Eres bilingüe (español/inglés), cordial y directo. Saluda, detecta idioma, pide nombre, teléfono y motivo de la llamada. Responde siempre corto y humano.",
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
    } catch {
      console.error("🧠 Error parseando mensaje de OpenAI");
      return;
    }

    console.log("🧠 Evento OpenAI:", event.type);

    if (event.type === "error") {
      const msg = event?.error?.message || "sin mensaje";
      const code = event?.error?.code || "sin-codigo";
      console.error(`🧠 OPENAI-ERROR: CODE=${code} MSG=${msg}`);
      return;
    }

    if (event.type === "response.audio.delta") {
      const call = calls.get(callSid);
      if (!call || !call.twilioWs || call.twilioWs.readyState !== WebSocket.OPEN)
        return;

      const audio = event.delta?.audio;
      if (!audio) return;

      try {
        call.twilioWs.send(
          JSON.stringify({
            event: "media",
            streamSid: call.streamSid,
            media: { payload: audio },
          })
        );
      } catch (err) {
        console.error("🚨 Error enviando audio a Twilio:", err);
      }
    }
  });

  return ws;
}

// ------------------------
// Limpiar llamada
// ------------------------
function cleanupCall(callSid) {
  if (!callSid) return;

  const call = calls.get(callSid);
  if (!call) return;

  if (call.openAiWs?.readyState === WebSocket.OPEN) {
    call.openAiWs.close();
  }

  if (call.twilioWs?.readyState === WebSocket.OPEN) {
    call.twilioWs.close();
  }

  calls.delete(callSid);

  console.log("🧹 Recursos limpiados para:", callSid);
}

// ------------------------
server.listen(PORT, () => {
  console.log(`🚀 Voice Gateway v4 escuchando en puerto ${PORT}`);
});
