// ===============================================================
// 📞 Voices Core - Voice Gateway v4 (Twilio + OpenAI Realtime)
// Formato Correcto: μ-law (G.711) - Compatible Twilio
// ===============================================================

const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview";

if (!OPENAI_API_KEY) {
  console.warn("❌ Falta OPENAI_API_KEY en Render.");
}

const calls = new Map();

// ---------------------------
// HTTP Server
// ---------------------------
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Voices Core Gateway v4 running.\n");
});

// ---------------------------
// WebSocket Upgrade
// ---------------------------
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/twilio-stream") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else socket.destroy();
});

// ---------------------------
// TWILIO CONNECTION
// ---------------------------
wss.on("connection", (ws) => {
  console.log("🌐 Twilio conectado");

  let callSid = null;

  ws.on("message", (msg) => {
    let data = JSON.parse(msg);

    switch (data.event) {
      case "start":
        callSid = data.start.callSid;
        const streamSid = data.start.streamSid;

        console.log("▶️ Llamada iniciada:", callSid);

        const openAiWs = connectOpenAI(callSid, streamSid);

        calls.set(callSid, {
          twilio: ws,
          openai: openAiWs,
          streamSid,
          pending: false,
        });
        break;

      case "media": {
        const call = calls.get(callSid);
        if (!call || call.pending) return;

        const payload = data.media.payload;

        call.openai.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: payload,
          })
        );

        call.openai.send(
          JSON.stringify({
            type: "input_audio_buffer.commit",
          })
        );

        call.openai.send(
          JSON.stringify({
            type: "response.create",
            response: {
              modalities: ["audio", "text"],
              instructions:
                "Responde breve, claro, humano y cordial. Detecta idioma.",
            },
          })
        );

        call.pending = true;
        break;
      }

      case "stop":
        cleanupCall(callSid);
        break;
    }
  });

  ws.on("close", () => cleanupCall(callSid));
});

// ---------------------------
// OPENAI CONNECTION
// ---------------------------
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
    console.log("🧠 OpenAI conectado para", callSid);

    ws.send(
      JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["audio", "text"],
          voice: "alloy",
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          instructions:
            "Eres un asistente bilingüe de Voices Core. Responde corto y cordial.",
        },
      })
    );
  });

  ws.on("message", (raw) => {
    const event = JSON.parse(raw);

    // DEBUG:
    console.log("🧠 Evento OpenAI:", event.type);

    if (event.type === "error") {
      console.error("🧠 ERROR:", event.error);
      const call = calls.get(callSid);
      if (call) call.pending = false;
      return;
    }

    // Transcripción parcial
    if (event.type === "response.audio_transcript.delta") {
      console.log("📝 Transcripción:", event.delta);
    }

    // Audio generado por OpenAI
    if (event.type === "response.audio.delta") {
      const call = calls.get(callSid);
      if (!call) return;

      const audio = event.delta.audio;
      if (!audio) return;

      console.log("🔊 AUDIO OUT → tamaño base64:", audio.length);

      // ENVIAR AUDIO A TWILIO (G.711 μ-law)
      call.twilio.send(
        JSON.stringify({
          event: "media",
          streamSid: call.streamSid,
          media: { payload: audio },
        })
      );
    }

    // Respuesta completada → permitir siguiente
    if (event.type === "response.completed") {
      const call = calls.get(callSid);
      if (call) call.pending = false;
    }
  });

  return ws;
}

// ---------------------------
// CLEANUP
// ---------------------------
function cleanupCall(callSid) {
  const call = calls.get(callSid);
  if (!call) return;

  try {
    call.openai.close();
  } catch {}
  try {
    call.twilio.close();
  } catch {}

  calls.delete(callSid);

  console.log("🧹 Call cleanup:", callSid);
}

server.listen(PORT, () => {
  console.log(`🚀 Voice Gateway escuchando en puerto ${PORT}`);
});
