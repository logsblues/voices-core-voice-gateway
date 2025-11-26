// ===============================================================
// 📞 Voices Core - Voice Gateway v4 (Twilio + OpenAI Realtime)
// Versión: usa config de Lovable por número de teléfono
// ===============================================================

const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview";

if (!OPENAI_API_KEY) {
  console.warn("❌ Falta OPENAI_API_KEY en Render.");
}

// 🔹 NUEVAS VARIABLES DE ENTORNO (ya creaste VOICE_AGENT_CONFIG_BASE_URL y VOICE_GATEWAY_TOKEN)
const VOICE_AGENT_CONFIG_BASE_URL = process.env.VOICE_AGENT_CONFIG_BASE_URL;
const VOICE_GATEWAY_TOKEN = process.env.VOICE_GATEWAY_TOKEN;
// Opcional: número por defecto si Twilio no manda "to"
const DEFAULT_AGENT_PHONE = process.env.DEFAULT_AGENT_PHONE || null;

if (!VOICE_AGENT_CONFIG_BASE_URL || !VOICE_GATEWAY_TOKEN) {
  console.warn("⚠️ Falta VOICE_AGENT_CONFIG_BASE_URL o VOICE_GATEWAY_TOKEN en Render.");
}

// callSid -> { twilio, openai, streamSid, pending, hasResponded, agentConfig }
const calls = new Map();

// --------------------------------------------------
// 🔹 Helper: pedir config de agente a Lovable por teléfono
// --------------------------------------------------
async function fetchAgentConfigByPhone(phone) {
  try {
    if (!VOICE_AGENT_CONFIG_BASE_URL || !VOICE_GATEWAY_TOKEN) {
      console.warn("⚠️ No hay config para voice-agent-config; usando defaults locales.");
      return null;
    }

    const base = VOICE_AGENT_CONFIG_BASE_URL.replace(/\/$/, "");
    const url = `${base}/voice-agent-config/by-phone?phone=${encodeURIComponent(
      phone
    )}`;

    console.log("🌐 Pidiendo config de agente a:", url);

    const res = await fetch(url, {
      method: "GET",
      headers: {
        "x-voice-gateway-token": VOICE_GATEWAY_TOKEN,
      },
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(
        "🚨 Error al obtener config de agente:",
        res.status,
        res.statusText,
        text
      );
      return null;
    }

    const json = await res.json();
    console.log("✅ Config de agente recibida:", json.id, json.name);
    return json;
  } catch (err) {
    console.error("🚨 fetchAgentConfigByPhone falló:", err);
    return null;
  }
}

// --------------------------------------------------
// 🌐 HTTP Server básico
// --------------------------------------------------
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Voices Core - Voice Gateway v4 running.\n");
});

// --------------------------------------------------
// 🔁 Upgrade HTTP → WebSocket
// --------------------------------------------------
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
    console.log("❌ Rechazando upgrade (ruta inválida):", url);
    socket.destroy();
  }
});

// --------------------------------------------------
// 📞 TWILIO → Nueva conexión WS
// --------------------------------------------------
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

        // Twilio puede mandar el número destino en data.start.to
        const toNumber =
          data.start?.to ||
          DEFAULT_AGENT_PHONE; // fallback si no viene en el payload

        console.log(
          `▶️ Llamada iniciada: ${callSid} (StreamSid: ${streamSid}) To=${toNumber}`
        );

        // Hacemos la llamada async sin bloquear
        (async () => {
          let agentConfig = null;

          if (toNumber) {
            agentConfig = await fetchAgentConfigByPhone(toNumber);
          } else {
            console.warn(
              "⚠️ No se recibió teléfono en evento start y no hay DEFAULT_AGENT_PHONE; usando config local por defecto."
            );
          }

          const openAiWs = connectOpenAI(callSid, streamSid, agentConfig);

          calls.set(callSid, {
            twilio: ws,
            openai: openAiWs,
            streamSid,
            pending: false,
            hasResponded: false,
            agentConfig,
          });
        })();

        break;

      case "media": {
        const call = calls.get(callSid);
        if (!call || call.openai.readyState !== WebSocket.OPEN) return;

        const payload = data.media?.payload;
        if (!payload) return;

        // Mandamos audio de entrada a OpenAI
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

// --------------------------------------------------
// 🧠 Conexión con OpenAI Realtime
// --------------------------------------------------
function connectOpenAI(callSid, streamSid, agentConfig) {
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

    // Voz según config
    let voice = "alloy";
    if (agentConfig?.voice_provider === "openai" && agentConfig.openai_voice) {
      voice = agentConfig.openai_voice;
    }

    // Prompt principal (system)
    const systemPrompt =
      agentConfig?.system_prompt ||
      "Eres el asistente de voz oficial de Voices Core. Eres bilingüe (español/inglés), saludas cordial, detectas idioma, pides nombre, teléfono y motivo de la llamada. Responde breve, humano y claro.";

    // Turn detection según settings
    const td = agentConfig?.settings?.turn_detection || {};
    const turnDetection = {
      type: "server_vad",
      threshold: td.threshold ?? 0.5,
      prefix_padding_ms: td.prefix_padding_ms ?? 300,
      silence_duration_ms: td.silence_duration_ms ?? 500,
    };

    ws.send(
      JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["audio", "text"],
          voice,
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          instructions: systemPrompt,
          turn_detection: turnDetection,
        },
      })
    );

    console.log("🧠 session.update enviado con config de agente.");
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

    // 1) Errores
    if (type === "error") {
      const msg = event?.error?.message || "sin mensaje";
      const code = event?.error?.code || "sin-codigo";
      console.error(`🧠 OPENAI-ERROR: CODE=${code} MSG=${msg}`);

      if (code !== "conversation_already_has_active_response") {
        call.pending = false;
      }
      return;
    }

    // 2) VAD: usuario terminó de hablar
    if (type === "input_audio_buffer.speech_stopped") {
      console.log("🧠 VAD: speech_stopped para", callSid);

      if (!call.pending && !call.hasResponded) {
        try {
          ws.send(
            JSON.stringify({
              type: "response.create",
              response: {
                modalities: ["audio", "text"],
                instructions:
                  "Responde de forma muy breve, clara, cordial y humana. Prioriza audio. Saluda y presenta el servicio.",
              },
            })
          );
          call.pending = true;
          call.hasResponded = true;
          console.log("🧠 response.create enviado para", callSid);
        } catch (err) {
          console.error("🚨 Error enviando response.create:", err);
          call.pending = false;
        }
      } else {
        console.log(
          "⚠️ speech_stopped ignorado (pending o ya respondió) para",
          callSid
        );
      }
    }

    // 3) Transcripción parcial de lo que responde el modelo
    if (type === "response.audio_transcript.delta") {
      const text = event.delta || "";
      if (text) {
        console.log(`📝 Parcial transcript (${callSid}):`, text);
      }
    }

    // 4) Audio generado por OpenAI → enviarlo a Twilio
    if (type === "response.audio.delta") {
      const audio = event.delta?.audio;
      if (!audio) {
        console.log("🔇 response.audio.delta sin audio");
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

    // 5) Respuesta completada
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

// --------------------------------------------------
// 🧹 Limpieza por llamada
// --------------------------------------------------
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

// --------------------------------------------------
// 🚀 Arranque del servidor
// --------------------------------------------------
server.listen(PORT, () => {
  console.log(`🚀 Voice Gateway v4 escuchando en puerto ${PORT}`);
});
