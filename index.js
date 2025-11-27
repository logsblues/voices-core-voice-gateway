// ===============================================================
// 📞 Voices Core - Voice Gateway v4.5 (Twilio + OpenAI Realtime)
// Realtime Audio → μ-law | Bilingüe | CORS + Health Check para Lovable
// ===============================================================

const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview";

// ===============================
// 🔐 Comprobación de API Key
// ===============================
if (!OPENAI_API_KEY) {
  console.warn("❌ Falta OPENAI_API_KEY en Render.");
} else {
  console.log("✅ OPENAI_API_KEY configurada.");
}

console.log("🧠 Usando modelo Realtime:", MODEL);

// callSid -> { twilio, openai, streamSid, pending, hasResponded }
const calls = new Map();

// ===============================================================
// 🌍 HTTP SERVER (incluye health + CORS)
// ===============================================================
const server = http.createServer((req, res) => {
  // Ruta principal
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Voices Core - Voice Gateway v4.5 running.\n");
});

// ---------- CORS HELPERS ----------
function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
}

// ---------- ENDPOINT HEALTH PARA LOVABLE ----------
server.on("request", (req, res) => {
  if (req.url === "/health") {
    setCORS(res);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        service: "voices-core-gateway",
        timestamp: new Date().toISOString(),
      })
    );
    return;
  }
});

// ===============================================================
// 🧩 WEBSOCKET UPGRADE → Twilio Stream
// ===============================================================
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

// ===============================================================
// 🎧 TWILIO → WebSocket
// ===============================================================
wss.on("connection", (ws, req) => {
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
// 🤖 OPENAI REALTIME API (AUDIO)
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

    ws.send(
      JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["audio", "text"],
          voice: "alloy",
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",

          instructions:
            "Eres un asistente profesional de la empresa del cliente. Bilingüe (inglés/español). Abres la llamada inmediatamente con un saludo humano, cálido y natural. Nunca esperas a que la persona hable. Pide nombre y teléfono y ayuda según el servicio. No menciones Voices Core ni OpenAI.",

          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 400,
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

    // ---------- Manejo de errores ----------
    if (type === "error") {
      const msg = event?.error?.message || "sin mensaje";
      const code = event?.error?.code || "sin-codigo";
      console.error(`🧠 OPENAI-ERROR: CODE=${code} MSG=${msg}`);

      if (code !== "conversation_already_has_active_response") {
        call.pending = false;
      }
      return;
    }

    // ---------- Primer saludo inmediato ----------
    if (!call.hasResponded) {
      try {
        ws.send(
          JSON.stringify({
            type: "response.create",
            response: {
              modalities: ["audio", "text"],
              instructions:
                "Saluda inmediatamente, presenta el servicio y pregunta en qué puede ayudar.",
            },
          })
        );
        call.hasResponded = true;
        call.pending = true;
      } catch {}
    }

    // ---------- Reenviar audio generado a Twilio ----------
    if (type === "response.audio.delta") {
      const audio = event.delta;
      if (!audio) return;

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

    // ---------- Liberar pending ----------
    if (type === "response.completed" || type === "response.done") {
      call.pending = false;
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
// 🧹 LIMPIEZA
// ===============================================================
function cleanupCall(callSid) {
  if (!callSid) return;
  const call = calls.get(callSid);
  if (!call) return;

  try {
    if (call.openai?.readyState === WebSocket.OPEN) call.openai.close();
    if (call.twilio?.readyState === WebSocket.OPEN) call.twilio.close();
  } catch {}

  calls.delete(callSid);
  console.log("🧹 Recursos limpiados para:", callSid);
}

// ===============================================================
server.listen(PORT, () => {
  console.log(`🚀 Voice Gateway v4.5 escuchando en puerto ${PORT}`);
});
