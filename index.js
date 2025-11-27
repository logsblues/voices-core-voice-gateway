// ===============================================================
// 📞 Voices Core - Voice Gateway v4
// Twilio Media Streams + OpenAI Realtime + Supabase (memoria/CRM)
// ===============================================================

const http = require("http");
const WebSocket = require("ws");
const url = require("url");

// ---------------------------
// ENV
// ---------------------------
const PORT = process.env.PORT || 10000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview";

const SUPABASE_URL = process.env.SUPABASE_URL; // https://....supabase.co
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; // solo para log
const VOICE_GATEWAY_TOKEN = process.env.VOICE_GATEWAY_TOKEN;

const VOICE_AGENT_CONFIG_BASE_URL =
  process.env.VOICE_AGENT_CONFIG_BASE_URL ||
  `${SUPABASE_URL}/functions/v1/voice-agent-config`;
const VOICE_SESSION_START_URL = `${SUPABASE_URL}/functions/v1/voice-session-start`;
const VOICE_SESSION_END_URL = `${SUPABASE_URL}/functions/v1/voice-session-end`;
const VOICE_SAVE_MEMORY_URL = `${SUPABASE_URL}/functions/v1/voice-save-memory`;

if (!OPENAI_API_KEY) console.warn("❌ Falta OPENAI_API_KEY en Render.");
else console.log("✅ OPENAI_API_KEY configurada.");

if (!SUPABASE_URL) console.warn("❌ Falta SUPABASE_URL en Render.");
else console.log("✅ SUPABASE_URL configurada.");

if (!SUPABASE_SERVICE_KEY)
  console.warn("⚠️ Falta SUPABASE_SERVICE_KEY (solo para logs, no crítico).");
else console.log("✅ SUPABASE_SERVICE_KEY configurada.");

if (!VOICE_GATEWAY_TOKEN)
  console.warn("❌ Falta VOICE_GATEWAY_TOKEN (necesario para Edge Functions).");
else console.log("✅ VOICE_GATEWAY_TOKEN configurado.");

console.log("🧠 Usando modelo Realtime:", MODEL);

// callSid -> { twilio, openai, streamSid, pending, config, transcript, ... }
const calls = new Map();

// ---------------------------
// HTTP Server (+ CORS + /health)
// ---------------------------
const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);

  // CORS básico
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(200);
    return res.end();
  }

  if (parsed.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        status: "ok",
        service: "voices-core-voice-gateway",
        model: MODEL,
        timestamp: new Date().toISOString(),
      })
    );
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Voices Core - Voice Gateway v4 running.\n");
});

// ---------------------------
// Upgrade HTTP → WebSocket
// ---------------------------
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const parsed = url.parse(req.url, true);
  console.log("🔁 HTTP upgrade solicitado. URL:", req.url);

  if (parsed.pathname === "/twilio-stream") {
    // Guardamos agentId para usarlo en la conexión
    const agentId = parsed.query.agentId || null;
    req.agentId = agentId; // extensión del objeto req

    console.log(
      "✅ Aceptando conexión WS para /twilio-stream. agentId=",
      agentId
    );
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    console.log("❌ Rechazando upgrade (ruta inválida):", req.url);
    socket.destroy();
  }
});

// ---------------------------
// TWILIO → NUEVA CONEXIÓN WS
// ---------------------------
wss.on("connection", (ws, req) => {
  console.log("🌐 Nueva conexión WebSocket desde Twilio");

  const agentIdFromUrl = req.agentId || null;
  let callSid = null;
  let streamSid = null;

  // info de llamada (para memoria/CRM)
  let fromNumber = null;
  let toNumber = null;

  ws.on("message", async (msg) => {
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

      case "start": {
        callSid = data.start.callSid;
        streamSid = data.start.streamSid;

        // CustomParameters (si están configurados en el TwiML)
        fromNumber =
          data.start.customParameters?.from ||
          data.start.customParameters?.From ||
          null;
        toNumber =
          data.start.customParameters?.to ||
          data.start.customParameters?.To ||
          null;

        console.log(
          `▶️ Llamada iniciada: ${callSid} (StreamSid: ${streamSid}) | from=${fromNumber} to=${toNumber} agentId=${agentIdFromUrl}`
        );

        // 1) Cargar configuración del agente desde Supabase
        let agentConfig = null;
        try {
          agentConfig = await loadAgentConfig(
            agentIdFromUrl,
            fromNumber,
            toNumber
          );
        } catch (err) {
          console.error("🚨 Error cargando configuración del agente:", err);
        }

        if (!agentConfig) {
          console.warn(
            "⚠️ No se pudo cargar config de agente. Usando configuración por defecto."
          );
        }

        // 2) Conectar con OpenAI
        const openAiWs = connectOpenAI(
          callSid,
          streamSid,
          ws,
          agentConfig || {}
        );

        // 3) Registrar sesión de llamada en Supabase
        if (agentConfig && SUPABASE_URL && VOICE_GATEWAY_TOKEN) {
          try {
            await fetch(VOICE_SESSION_START_URL, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-voice-gateway-token": VOICE_GATEWAY_TOKEN,
              },
              body: JSON.stringify({
                call_sid: callSid,
                agent_id: agentConfig.agentId,
                company_id: agentConfig.meta?.company_id || null,
                contact_id: agentConfig.contact?.id || null,
                from_number: fromNumber,
                to_number: toNumber,
                direction: "inbound",
              }),
            });
            console.log("📞 voice-session-start enviado para", callSid);
          } catch (err) {
            console.error("⚠️ Error enviando voice-session-start:", err);
          }
        }

        // Guardamos estado de la llamada
        calls.set(callSid, {
          twilio: ws,
          openai: openAiWs,
          streamSid,
          pending: false,
          hasResponded: false,
          hasGreeted: false,
          config: agentConfig || null,
          transcript: "",
        });

        break;
      }

      case "media": {
        if (!callSid) return;
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
        await endSessionAndCleanup(callSid);
        break;

      default:
        console.log("❓ Evento Twilio desconocido:", event);
    }
  });

  ws.on("close", () => {
    if (callSid) {
      endSessionAndCleanup(callSid);
    }
  });
});

// ---------------------------
// Cargar configuración del agente desde Supabase
// ---------------------------
async function loadAgentConfig(agentId, fromNumber, toNumber) {
  if (!SUPABASE_URL || !VOICE_GATEWAY_TOKEN) {
    console.warn("⚠️ No SUPABASE_URL o VOICE_GATEWAY_TOKEN. Sin config remota.");
    return null;
  }

  let configUrl;

  if (agentId) {
    // Modo por agentId (oficial)
    const params = new URLSearchParams();
    if (fromNumber) params.set("from", fromNumber);
    configUrl = `${VOICE_AGENT_CONFIG_BASE_URL}/${agentId}/config?${params.toString()}`;
  } else if (toNumber) {
    // Fallback: buscar por teléfono del agente
    const params = new URLSearchParams();
    params.set("phone", toNumber);
    if (fromNumber) params.set("from", fromNumber);
    configUrl = `${VOICE_AGENT_CONFIG_BASE_URL}/by-phone?${params.toString()}`;
  } else {
    console.warn("⚠️ No agentId ni toNumber para cargar config.");
    return null;
  }

  console.log("🌐 Fetching agent config:", configUrl);

  const res = await fetch(configUrl, {
    headers: {
      "x-voice-gateway-token": VOICE_GATEWAY_TOKEN,
    },
  });

  if (!res.ok) {
    console.error(
      "❌ Error response desde voice-agent-config:",
      res.status,
      await res.text()
    );
    return null;
  }

  const config = await res.json();
  console.log(
    "✅ Agent config cargada:",
    config.name || config.agentId || "sin nombre"
  );
  return config;
}

// ---------------------------
// OPENAI CONNECTION
// ---------------------------
function connectOpenAI(callSid, streamSid, twilioWs, agentConfig) {
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

    // Construir configuración de sesión a partir de agentConfig
    const settings = agentConfig.settings || {};
    const voiceCfg = settings.voice || {};

    const instructions =
      agentConfig.system_prompt ||
      agentConfig.prompts?.full ||
      agentConfig.prompts?.base ||
      "Eres un asistente de voz bilingüe (español/inglés). Responde de forma natural, cordial y muy humana. Detecta el idioma del cliente y responde en el mismo idioma. Haz preguntas claras para entender cómo ayudar.";

    const welcomeMessage =
      agentConfig.welcome_message ||
      settings.welcome_message ||
      "Hola, gracias por llamar. ¿En qué puedo ayudarte?";

    // 1) session.update
    ws.send(
      JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["audio", "text"],
          voice: voiceCfg.voice_id || "alloy",
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          instructions,
          temperature: settings.temperature ?? 0.8,
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
          },
        },
      })
    );

    // 2) Saludo inicial inmediato
    try {
      ws.send(
        JSON.stringify({
          type: "response.create",
          response: {
            modalities: ["audio", "text"],
            instructions: `Da este saludo inicial de forma natural, amable y humana, y luego espera la respuesta del cliente: "${welcomeMessage}"`,
          },
        })
      );
      const call = calls.get(callSid);
      if (call) {
        call.hasGreeted = true;
        call.pending = true;
      }
      console.log("👋 Saludo inicial enviado para", callSid);
    } catch (err) {
      console.error("⚠️ Error enviando saludo inicial:", err);
    }
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
    const call = calls.get(callSid);
    if (!call) return;

    console.log("🧠 Evento OpenAI:", type);

    // 1) Manejo de errores
    if (type === "error") {
      const msg = event?.error?.message || "sin mensaje";
      const code = event?.error?.code || "sin-codigo";
      console.error(`🧠 OPENAI-ERROR: CODE=${code} MSG=${msg}`);

      if (code !== "conversation_already_has_active_response") {
        call.pending = false;
      }
      return;
    }

    // 2) VAD: usuario terminó de hablar → pedir respuesta si no hay en curso
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
                  "Responde de forma muy breve, clara, cordial y humana. Continúa la conversación de manera natural.",
              },
            })
          );
          call.pending = true;
          console.log("🧠 response.create enviado para", callSid);
        } catch (err) {
          console.error("🚨 Error enviando response.create:", err);
          call.pending = false;
        }
      } else {
        console.log("⚠️ speech_stopped ignorado (pending ya true) para", callSid);
      }
    }

    // 3) Transcripción parcial del audio de salida
    if (type === "response.audio_transcript.delta") {
      const text = event.delta || "";
      if (text) {
        console.log(`📝 Parcial transcript (${callSid}):`, text);
        call.transcript += text;
      }
    }

    // 4) Audio generado por OpenAI → Twilio
    if (type === "response.audio.delta") {
      const audio = event.delta;

      if (!audio || typeof audio !== "string") {
        console.log(
          "🔇 response.audio.delta sin audio válido. Evento:",
          JSON.stringify(event)
        );
        return;
      }

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

    // 5) Respuesta completada → liberar pending
    if (type === "response.completed" || type === "response.done") {
      call.pending = false;
      console.log(`✅ Respuesta completada para ${callSid}`);
    }

    // (Futuro) Aquí podríamos manejar eventos de tool calls (save_memory, transfer, etc.)
  });

  ws.on("close", () => {
    console.log("🔌 OpenAI WS cerrado para", callSid);
  });

  ws.on("error", (err) => {
    console.error("⚠️ Error WS OpenAI:", err);
  });

  return ws;
}

// ---------------------------
// Cerrar sesión + limpiar recursos
// ---------------------------
async function endSessionAndCleanup(callSid) {
  if (!callSid) return;

  const call = calls.get(callSid);
  if (!call) return;

  // 1) Enviar voice-session-end a Supabase (si podemos)
  if (SUPABASE_URL && VOICE_GATEWAY_TOKEN) {
    try {
      await fetch(VOICE_SESSION_END_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-voice-gateway-token": VOICE_GATEWAY_TOKEN,
        },
        body: JSON.stringify({
          call_sid: callSid,
          status: "completed",
          transcript: call.transcript || null,
          messages: [], // futuro: historial detallado
        }),
      });
      console.log("📞 voice-session-end enviado para", callSid);
    } catch (err) {
      console.error("⚠️ Error enviando voice-session-end:", err);
    }
  }

  // 2) Cerrar websockets
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

// ---------------------------
// START SERVER
// ---------------------------
server.listen(PORT, () => {
  console.log(`🚀 Voice Gateway v4 escuchando en puerto ${PORT}`);
});
