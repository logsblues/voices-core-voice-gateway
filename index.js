// ===============================================================
// 📞 Voices Core - Voice Gateway v4 (Twilio + OpenAI Realtime)
// Versión: conversación multi-turno + memoria básica + sesiones
// ===============================================================

const http = require("http");
const WebSocket = require("ws");
const urlLib = require("url");

const PORT = process.env.PORT || 10000;

// === ENV VARS ===
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";
const SUPABASE_URL = process.env.SUPABASE_URL; // ej: https://xxxx.supabase.co
const VOICE_GATEWAY_TOKEN = process.env.VOICE_GATEWAY_TOKEN; // debe coincidir con Supabase

if (!OPENAI_API_KEY) {
  console.warn("❌ Falta OPENAI_API_KEY en Render.");
} else {
  console.log("✅ OPENAI_API_KEY configurada.");
}

if (!SUPABASE_URL) {
  console.warn("❌ Falta SUPABASE_URL en Render (necesario para memoria/sesiones).");
} else {
  console.log("✅ SUPABASE_URL configurada:", SUPABASE_URL);
}

if (!VOICE_GATEWAY_TOKEN) {
  console.warn("❌ Falta VOICE_GATEWAY_TOKEN en Render (auth con edge functions).");
} else {
  console.log("✅ VOICE_GATEWAY_TOKEN configurado.");
}

console.log("🧠 Usando modelo Realtime:", MODEL);

// callSid -> { twilio, openai, streamSid, pending, meta }
const calls = new Map();

// Helper para fetch JSON
async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (e) {
    console.error("⚠️ Error parseando JSON de", url, ":", e, "Body:", text);
  }
  if (!res.ok) {
    console.error("❌ Error HTTP", res.status, "en", url, "→", data || text);
    throw new Error(`HTTP ${res.status} error`);
  }
  return data;
}

// ---------------------------
// HTTP Server (+ /health con CORS)
// ---------------------------
const server = http.createServer((req, res) => {
  const { url, method } = req;

  // CORS básico para /health y futuras rutas
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");

  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        service: "Voices Core - Voice Gateway v4",
        timestamp: new Date().toISOString(),
      })
    );
    return;
  }

  // Respuesta por defecto
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

  const parsed = urlLib.parse(url, true);

  if (parsed.pathname === "/twilio-stream") {
    console.log("✅ Aceptando conexión WS para /twilio-stream");
    wss.handleUpgrade(req, socket, head, (ws) => {
      // Guardamos query params iniciales (agentId, from, to si vienen en la URL)
      ws.initialQuery = parsed.query || {};
      wss.emit("connection", ws, req);
    });
  } else {
    console.log("❌ Rechazando upgrade (ruta inválida):", url);
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

  // Datos que podamos capturar de la URL (fallback)
  let agentIdFromUrl = ws.initialQuery?.agentId || null;
  let fromFromUrl = ws.initialQuery?.from || null;
  let toFromUrl = ws.initialQuery?.to || null;

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

      case "start": {
        callSid = data.start.callSid;
        streamSid = data.start.streamSid;

        console.log(`▶️ Llamada iniciada: ${callSid} (StreamSid: ${streamSid})`);

        // Intentar obtener agentId, from, to de customParameters o de la URL
        const custom = data.start.customParameters || {};
        const fromNumber =
          custom.from || fromFromUrl || data.start.from || null;
        const toNumber =
          custom.to || toFromUrl || data.start.to || null;
        const agentId =
          custom.agentId || agentIdFromUrl || ws.initialQuery?.agentId || null;

        console.log("📞 Datos de inicio:", {
          agentId,
          fromNumber,
          toNumber,
        });

        // Crear entrada básica del call antes de conectar a OpenAI
        calls.set(callSid, {
          twilio: ws,
          openai: null, // se establecerá cuando connectOpenAI termine
          streamSid,
          pending: false,
          hasResponded: false,
          meta: {
            agentId,
            fromNumber,
            toNumber,
            config: null,
            sessionId: null,
            startedAt: Date.now(),
          },
        });

        // Conectar a OpenAI (asincrónico) y cargar config del agente
        (async () => {
          try {
            const openAiWs = await connectOpenAI(callSid);
            const call = calls.get(callSid);
            if (call) {
              call.openai = openAiWs;
            }
          } catch (err) {
            console.error("🚨 Error en connectOpenAI:", err);
          }
        })();

        break;
      }

      case "media": {
        const call = calls.get(callSid);
        if (!call || !call.openai || call.openai.readyState !== WebSocket.OPEN)
          return;

        const payload = data.media?.payload;
        if (!payload) return;

        // Mandamos audio de entrada al buffer de OpenAI
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

        // Log básico para saber que llega audio de Twilio
        console.log(`🎙 Evento Twilio: media (CallSid ${callSid})`);
        break;
      }

      case "stop":
        console.log("⏹ Evento stop recibido:", callSid);
        (async () => {
          await endVoiceSession(callSid);
          cleanupCall(callSid);
        })();
        break;

      default:
        console.log("❓ Evento Twilio desconocido:", event);
    }
  });

  ws.on("close", () => {
    (async () => {
      await endVoiceSession(callSid);
      cleanupCall(callSid);
    })();
  });
});

// ---------------------------
// OPENAI CONNECTION + CONFIG
// ---------------------------
async function connectOpenAI(callSid) {
  const call = calls.get(callSid);
  if (!call) throw new Error("Call not found in map");

  const { agentId, fromNumber, toNumber } = call.meta || {};

  // 1) Obtener configuración del agente desde Supabase
  if (!SUPABASE_URL || !VOICE_GATEWAY_TOKEN) {
    console.warn("⚠️ Sin SUPABASE_URL o VOICE_GATEWAY_TOKEN, usando prompt básico.");
  }

  let config = null;

  if (SUPABASE_URL && VOICE_GATEWAY_TOKEN && agentId) {
    const configUrl = `${SUPABASE_URL}/functions/v1/voice-agent-config/${agentId}/config${
      fromNumber ? `?from=${encodeURIComponent(fromNumber)}` : ""
    }`;

    console.log("🌐 Pidiendo config de agente a:", configUrl);

    try {
      config = await fetchJson(configUrl, {
        headers: {
          "x-voice-gateway-token": VOICE_GATEWAY_TOKEN,
        },
      });
      console.log("✅ Config recibido para agent:", config?.name || agentId);
    } catch (err) {
      console.error("❌ Error obteniendo config del agente:", err);
    }
  } else if (SUPABASE_URL && VOICE_GATEWAY_TOKEN && toNumber) {
    // Fallback por teléfono (por si algún día queremos usar /by-phone)
    const configUrl = `${SUPABASE_URL}/functions/v1/voice-agent-config/by-phone?phone=${encodeURIComponent(
      toNumber
    )}${fromNumber ? `&from=${encodeURIComponent(fromNumber)}` : ""}`;

    console.log("🌐 Pidiendo config de agente BY-PHONE a:", configUrl);

    try {
      config = await fetchJson(configUrl, {
        headers: {
          "x-voice-gateway-token": VOICE_GATEWAY_TOKEN,
        },
      });
      console.log("✅ Config BY-PHONE recibido para agent:", config?.name || "desconocido");
    } catch (err) {
      console.error("❌ Error en config BY-PHONE:", err);
    }
  }

  // Guardar config en meta
  call.meta.config = config || null;

  // 2) Crear sesión de voz en Supabase (ai_voice_call_sessions)
  if (SUPABASE_URL && VOICE_GATEWAY_TOKEN) {
    try {
      const sessionStartUrl = `${SUPABASE_URL}/functions/v1/voice-session-start`;
      console.log("🌐 Registrando inicio de sesión en:", sessionStartUrl);

      const startPayload = {
        call_sid: callSid,
        agent_id: config?.agentId || agentId || null,
        company_id: config?.meta?.company_id || null,
        contact_id: config?.contact?.id || null,
        from_number: fromNumber || null,
        to_number: toNumber || null,
        direction: "inbound",
      };

      const sessionRes = await fetchJson(sessionStartUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-voice-gateway-token": VOICE_GATEWAY_TOKEN,
        },
        body: JSON.stringify(startPayload),
      });

      console.log("✅ Voice session creada:", sessionRes.session_id);
      call.meta.sessionId = sessionRes.session_id;
    } catch (err) {
      console.error("❌ Error creando sesión de voz:", err);
    }
  }

  // 3) Conectar a OpenAI Realtime
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

    // Usar config si existe
    const systemPrompt =
      config?.system_prompt ||
      "Eres un asistente de voz bilingüe (español/inglés). Responde de forma cordial, humana, profesional y clara. Si conoces datos del cliente o historial, úsalos para personalizar la conversación.";

    const welcomeMessage =
      config?.welcome_message ||
      `Hola, gracias por llamar${
        config?.settings?.company_name
          ? ` a ${config.settings.company_name}`
          : ""
      }. ¿En qué puedo ayudarte?`;

    const language = config?.settings?.language || "es";
    const voiceId = config?.settings?.voice?.voice_id || "alloy";
    const temperature = config?.settings?.temperature ?? 0.8;

    // 3.1 Configurar sesión
    ws.send(
      JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["audio", "text"],
          voice: voiceId,
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          instructions: systemPrompt,
          temperature,
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
          },
          // Puedes usar este campo si quieres forzar idioma
          // instrucciones deben mencionar que detecte o hable en ambos idiomas
        },
      })
    );

    // 3.2 Enviar saludo inicial inmediato (sin esperar VAD)
    try {
      ws.send(
        JSON.stringify({
          type: "response.create",
          response: {
            modalities: ["audio", "text"],
            instructions: `Saluda al cliente de forma cordial, breve y profesional en su idioma (español o inglés). Usa este mensaje como base, personalizándolo suavemente si es necesario: "${welcomeMessage}"`,
          },
        })
      );
      const call = calls.get(callSid);
      if (call) {
        call.pending = true;
        call.hasResponded = true; // ya saludó al inicio
      }
      console.log("🧠 Saludo inicial enviado para", callSid);
    } catch (err) {
      console.error("🚨 Error enviando saludo inicial:", err);
    }
  });

  ws.on("message", async (raw) => {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      console.error("🧠 Error parseando mensaje de OpenAI");
      return;
    }

    const type = event.type;
    // console.log("🧠 Evento OpenAI:", type);

    const call = calls.get(callSid);
    if (!call) return;

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

    // 2) VAD: el usuario terminó de hablar → pedimos nueva respuesta
    if (type === "input_audio_buffer.speech_stopped") {
      console.log("🧠 VAD: speech_stopped para", callSid);

      // Ahora permitimos varias respuestas en la misma llamada
      if (!call.pending) {
        try {
          ws.send(
            JSON.stringify({
              type: "response.create",
              response: {
                modalities: ["audio", "text"],
                instructions:
                  "Responde de forma breve, clara y humana, siguiendo el contexto de la conversación.",
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
        console.log("⚠️ speech_stopped ignorado (pending=true) para", callSid);
      }
    }

    // 3) Transcripción parcial (texto de la IA)
    if (type === "response.audio_transcript.delta") {
      const text = event.delta || "";
      if (text) {
        console.log(`📝 Parcial transcript (${callSid}):`, text);
      }
    }

    // 4) Audio generado por OpenAI → reenvío a Twilio
    if (type === "response.audio.delta") {
      const audio = event.delta;

      if (!audio || typeof audio !== "string") {
        console.log(
          "🔇 response.audio.delta sin audio válido. Evento:",
          JSON.stringify(event)
        );
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

    // 5) Tool calls básicos (save_memory) – implementación best-effort
    if (type === "response.function_call_arguments.done") {
      const toolName = event.name;
      const argsStr = event.arguments || "{}";
      console.log("🧰 Tool call recibido:", toolName, "args:", argsStr);

      if (!SUPABASE_URL || !VOICE_GATEWAY_TOKEN) return;

      if (toolName === "save_memory") {
        try {
          const args = JSON.parse(argsStr);
          const cfg = call.meta.config || {};
          const contactId = cfg.contact?.id || null;
          const companyId = cfg.meta?.company_id || null;
          const agentId = cfg.agentId || null;

          if (!contactId) {
            console.log("⚠️ save_memory sin contact_id, se ignora.");
          } else {
            const saveUrl = `${SUPABASE_URL}/functions/v1/voice-save-memory`;
            console.log("🌐 Guardando memoria en:", saveUrl);

            await fetchJson(saveUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-voice-gateway-token": VOICE_GATEWAY_TOKEN,
              },
              body: JSON.stringify({
                call_sid: callSid,
                contact_id: contactId,
                company_id: companyId,
                agent_id: agentId,
                summary: args.summary,
                tags: args.tags,
              }),
            });

            console.log("✅ Memoria guardada para contacto:", contactId);
          }
        } catch (err) {
          console.error("❌ Error procesando save_memory:", err);
        }
      }

      // Aquí en el futuro podemos manejar request_human_transfer, etc.
    }

    // 6) Respuesta completada → liberamos pending
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

// ---------------------------
// FIN DE SESIÓN / REGISTRO
// ---------------------------
async function endVoiceSession(callSid) {
  if (!SUPABASE_URL || !VOICE_GATEWAY_TOKEN) return;
  if (!callSid) return;

  const call = calls.get(callSid);
  if (!call || !call.meta || !call.meta.sessionId) return;

  const sessionId = call.meta.sessionId;

  try {
    const endUrl = `${SUPABASE_URL}/functions/v1/voice-session-end`;
    console.log("🌐 Cerrando sesión de voz en:", endUrl);

    const payload = {
      call_sid: callSid,
      status: "completed",
      // En futuro: transcript completo y mensajes
      transcript: null,
      recording_url: null,
      duration_seconds: call.meta.startedAt
        ? Math.round((Date.now() - call.meta.startedAt) / 1000)
        : null,
      messages: [],
    };

    await fetchJson(endUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-voice-gateway-token": VOICE_GATEWAY_TOKEN,
      },
      body: JSON.stringify(payload),
    });

    console.log("✅ Voice session cerrada:", sessionId);
  } catch (err) {
    console.error("❌ Error cerrando sesión de voz:", err);
  }
}

// ---------------------------
// LIMPIEZA
// ---------------------------
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

// ---------------------------
server.listen(PORT, () => {
  console.log(`🚀 Voice Gateway v4 escuchando en puerto ${PORT}`);
});
