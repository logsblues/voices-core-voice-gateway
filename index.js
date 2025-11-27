// ===============================================================
// 📞 Voices Core - Voice Gateway v4 (Twilio + OpenAI Realtime)
// Versión: Bilingüe, VAD servidor, g711_ulaw, multi-empresa
// ===============================================================

const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview";

if (!OPENAI_API_KEY) {
  console.warn("❌ Falta OPENAI_API_KEY en Render.");
} else {
  console.log("✅ OPENAI_API_KEY configurada.");
}

console.log("🧠 Usando modelo Realtime:", MODEL);

// callSid -> { twilio, openai, streamSid, pending, hasResponded }
const calls = new Map();

// ---------------------------
// HTTP Server
// ---------------------------
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Voices Core - Voice Gateway v4 running.\n");
});

// ---------------------------
// Upgrade HTTP → WebSocket
// ---------------------------
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const { url } = req;
  console.log("🔁 HTTP upgrade solicitado. URL:", url);

  if (url.startsWith("/twilio-stream")) {
    console.log("✅ Aceptando conexión WS para /twilio-stream");
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    console.log("❌ Rechazando upgrade (ruta inválida):", url);
    socket.destroy();
  }
});

// ---------------------------
// TWILIO → WS CONNECTION
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
          twilio: ws,
          openai: openAiWs,
          streamSid,
          pending: false,
          hasResponded: false,
        });
        break;

      case "media": {
        const call = calls.get(callSid);
        if (!call || call.openai.readyState !== WebSocket.OPEN) return;

        const payload = data.media?.payload;
        if (!payload) return;

        try {
          call.openai.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: payload,
            })
          );
        } catch (err) {
          console.error("🚨 Error enviando audio a OpenAI:", err);
        }

        console.log(`🎙 Evento Twilio: media (CallSid ${callSid})`);
        break;
      }

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

// ===============================================================
// 🔌 OPENAI CONNECTION (Realtime)
// ===============================================================
function connectOpenAI(callSid, streamSid) {
  const ws = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${MODEL}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  ws.on("open", () => {
    console.log("🧠 OpenAI conectado para CallSid", callSid);

    // ⚠️ IMPORTANTE:
    // NO hay identidad aquí (NO Voices Core, NO Konexfy).
    // La empresa se define desde Lovable con system_prompt.
    ws.send(
      JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["audio", "text"],
          voice: "alloy",
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",

          // ✨ INSTRUCCIONES NEUTRAS — cada empresa manda su propia personalidad
          instructions:
            "Eres un asistente de voz profesional y completamente bilingüe. Tu identidad, tono y marca deben seguir el system_prompt proporcionado por la empresa que está usando esta llamada. Da un saludo inicial cálido siguiendo esa identidad. Detecta el idioma automáticamente. Responde breve, humano, natural y profesional.",

          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
          },
        },
      })
    );
  });

  ws.on("message", (raw) => {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      console.error("🧠 Error parseando mensaje de OpenAI");
      return;
    }

    const type = event.type;
    console.log("🧠 Evento OpenAI:", type);

    const call = calls.get(callSid);
    if (!call) return;

    // ---------------------------
    // Errores
    // ---------------------------
    if (type === "error") {
      const msg = event?.error?.message || "sin mensaje";
      const code = event?.error?.code || "sin-codigo";
      console.error(`🧠 OPENAI-ERROR: CODE=${code} MSG=${msg}`);

      if (code !== "conversation_already_has_active_response") {
        call.pending = false;
      }
      return;
    }

    // ---------------------------
    // VAD: usuario terminó de hablar
    // ---------------------------
    if (type === "input_audio_buffer.speech_stopped") {
      console.log("🧠 VAD: speech_stopped para", callSid);

      if (!call.pending) {
        try {
          ws.send(
            JSON.stringify({
              type: "response.create",
              response: {
                modalities: ["audio", "text"],
                instructions:
                  "Responde de forma muy breve, clara, humana y profesional. Sigue el system_prompt de la empresa.",
              },
            })
          );
          call.pending = true;
          console.log("🧠 response.create enviado para", callSid);
        } catch (err) {
          console.error("🚨 Error enviando response.create:", err);
          call.pending = false;
        }
      }
    }

    // ---------------------------
    // Transcripción parcial
    // ---------------------------
    if (type === "response.audio_transcript.delta") {
      const text = event.delta || "";
      if (text) console.log(`📝 Parcial transcript (${callSid}):`, text);
    }

    // ---------------------------
    // AUDIO → TWILIO
    // ---------------------------
    if (type === "response.audio.delta") {
      const audio = event.delta;

      if (!audio || typeof audio !== "string") {
        console.log("🔇 response.audio.delta sin audio válido.");
        return;
      }

      console.log(
        `🔊 AUDIO OUT → tamaño base64=${audio.length} para ${callSid}`
      );

      try {
        call.twilio.send(
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

    // ---------------------------
    // Respuesta completada
    // ---------------------------
    if (type === "response.completed" || type === "response.done") {
      call.pending = false;
      console.log(`✅ Respuesta completada para ${callSid}`);
    }
  });

  ws.on("close", () => {
    console.log("🔌 OpenAI WS cerrado para", callSid);
  });

  ws.on("error", (err) => {
    console.error("⚠️ Error WS OpenAI:", err);
  });

  return ws;
}

// ===============================================================
// 🧹 LIMPIEZA DE LLAMADAS
// ===============================================================
function cleanupCall(callSid) {
  if (!callSid) return;

  const call = calls.get(callSid);
  if (!call) return;

  try {
    if (call.openai && call.openai.readyState === WebSocket.OPEN) {
      call.openai.close();
    }
  } catch {}

  try {
    if (call.twilio && call.twilio.readyState === WebSocket.OPEN) {
      call.twilio.close();
    }
  } catch {}

  calls.delete(callSid);

  console.log("🧹 Recursos limpiados para:", callSid);
}

// ===============================================================
server.listen(PORT, () => {
  console.log(`🚀 Voice Gateway v4 escuchando en puerto ${PORT}`);
});
