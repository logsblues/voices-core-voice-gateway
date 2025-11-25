// ===============================================================
// 📞 Voices Core - Voice Gateway v4 (Twilio + OpenAI Realtime)
// Versión: Log simple para errores OpenAI (100% visible en Render)
// ===============================================================

const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview";

if (!OPENAI_API_KEY) {
  console.warn("❌ Falta OPENAI_API_KEY en Render.");
}

const calls = new Map();

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Voices Core - Voice Gateway v4 is running.\n");
});

const wss = new WebSocket.Server({ noServer: true });

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

wss.on("connection", (ws) => {
  console.log("🌐 Nueva conexión WebSocket desde Twilio");

  let callSid = null;
  let streamSid = null;

  ws.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      return;
    }

    const event = data.event;

    switch (event) {
      case "start":
        callSid = data.start.callSid;
        streamSid = data.start.streamSid;

        console.log(`▶️ Llamada iniciada: ${callSid}`);

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
        if (!call || !call.openAiWs) return;

        const payload = data.media?.payload;
        if (!payload) return;

        try {
          call.openAiWs.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: payload,
            })
          );

          call.openAiWs.send(
            JSON.stringify({
              type: "input_audio_buffer.commit",
            })
          );

          if (!call.pendingResponse) {
            call.pendingResponse = true;

            call.openAiWs.send(
              JSON.stringify({
                type: "response.create",
                response: {
                  modalities: ["audio"],
                  instructions:
                    "Responde de manera breve y clara al usuario.",
                },
              })
            );
          }
        } catch (err) {
          console.error("🚨 Error enviando audio → OpenAI:", err);
        }
        break;

      case "stop":
        console.log("⏹ Evento stop recibido:", callSid);
        cleanupCall(callSid);
        break;
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
            "Eres un asistente de voz de Voices Core. Responde breve, cordial y bilingüe.",
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
      return;
    }

    console.log("🧠 Evento OpenAI:", event.type);

    if (event.type === "error") {
      const msg = event?.error?.message || "sin mensaje";
      const code = event?.error?.code || "sin-codigo";

      // 🔥 ESTA ES LA LÍNEA QUE VAS A VER SÍ O SÍ
      console.error(`🧠 OPENAI-ERROR: CODE=${code} MSG=${msg}`);

      return;
    }

    if (event.type === "response.audio.delta") {
      const call = calls.get(callSid);
      if (!call) return;

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
      } catch {}
    }

    if (event.type === "response.completed") {
      const call = calls.get(callSid);
      if (call) call.pendingResponse = false;
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
