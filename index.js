// ===============================================================
// 📞 Voices Core - Voice Gateway v4 (Twilio + OpenAI Realtime)
// Versión: usa prompts de Lovable (voice-agent-config) y
// NUNCA dice "tu empresa" como nombre literal si no hay company_name
// ===============================================================

const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;

// === ENV VARS ===
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview";
const SUPABASE_URL = process.env.SUPABASE_URL; // https://...supabase.co
const VOICE_GATEWAY_TOKEN = process.env.VOICE_GATEWAY_TOKEN;

if (!OPENAI_API_KEY) console.warn("❌ Falta OPENAI_API_KEY en Render.");
if (!SUPABASE_URL) console.warn("❌ Falta SUPABASE_URL en Render.");
if (!VOICE_GATEWAY_TOKEN) console.warn("❌ Falta VOICE_GATEWAY_TOKEN en Render.");

console.log("🧠 Usando modelo Realtime:", MODEL);

// callSid -> { twilio, openai, streamSid, pending, transcript, agentConfig }
const calls = new Map();

// ---------------------------
// Helper URL
// ---------------------------
function parseWsUrl(reqUrl) {
  try {
    return new URL(reqUrl, "http://localhost");
  } catch {
    return new URL("http://localhost");
  }
}

// ---------------------------
// HTTP Server (+ /health con CORS)
// ---------------------------
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    const payload = JSON.stringify({
      status: "ok",
      service: "voices-core-voice-gateway",
      model: MODEL,
      timestamp: new Date().toISOString(),
    });

    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
    });
    return res.end(payload);
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Voices Core - Voice Gateway v4 running.\n");
});

// ---------------------------
// Upgrade HTTP → WebSocket
// ---------------------------
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const urlObj = parseWsUrl(req.url);
  console.log("🔁 HTTP upgrade solicitado. Path:", urlObj.pathname);

  if (urlObj.pathname === "/twilio-stream") {
    console.log("✅ Aceptando conexión WS para /twilio-stream");

    const agentId = urlObj.searchParams.get("agentId") || null;
    const fromNumber = urlObj.searchParams.get("from") || null;
    const toNumber = urlObj.searchParams.get("to") || null;

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws._voiceMeta = { agentId, fromNumber, toNumber };
      wss.emit("connection", ws, req);
    });
  } else {
    console.log("❌ Rechazando upgrade (ruta inválida):", urlObj.pathname);
    socket.destroy();
  }
});

// ---------------------------
// Helper: cargar config del agente desde Supabase
// ---------------------------
async function loadAgentConfig(agentId, fromNumber) {
  if (!SUPABASE_URL) {
    console.error("❌ SUPABASE_URL no configurada.");
    return null;
  }
  if (!agentId) {
    console.error("❌ loadAgentConfig: agentId requerido");
    return null;
  }

  const base = `${SUPABASE_URL.replace(/\/$/, "")}/functions/v1/voice-agent-config/${agentId}/config`;
  const url = new URL(base);
  if (fromNumber) url.searchParams.set("from", fromNumber);

  console.log("🌐 Fetching agent config from:", url.toString());

  const resp = await fetch(url.toString(), {
    headers: {
      "x-voice-gateway-token": VOICE_GATEWAY_TOKEN || "",
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.error("❌ Error al obtener config del agente:", resp.status, text);
    return null;
  }

  const json = await resp.json();
  console.log(
    "✅ Config recibida para agente:",
    json?.name || json?.agentId || agentId
  );

  // Log básico de company_name y length de prompt
  const companyNameLog =
    json?.settings?.company_name ||
    json?.company_name ||
    json?.meta?.company_name ||
    "(vacío)";
  const promptLengthLog =
    (json?.system_prompt || json?.prompts?.full || json?.prompts?.base || "")
      .length;

  console.log("🏢 company_name recibido:", companyNameLog);
  console.log("📏 system_prompt length:", promptLengthLog);

  return json;
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

    const settings = agentConfig?.settings || {};
    const voiceCfg = settings.voice || {};

    // 1) Prompt principal desde Lovable
    const promptFromConfig =
      agentConfig?.system_prompt ||
      agentConfig?.prompts?.full ||
      agentConfig?.prompts?.base ||
      "";

    // 2) Determinar nombre de empresa (solo si viene algo real)
    let companyNameFromConfig =
      settings.company_name ||
      agentConfig?.company_name ||
      agentConfig?.meta?.company_name ||
      "";

    if (typeof companyNameFromConfig === "string") {
      companyNameFromConfig = companyNameFromConfig.trim();
      if (!companyNameFromConfig) {
        companyNameFromConfig = "";
      }
    } else {
      companyNameFromConfig = "";
    }

    const hasCompanyName = companyNameFromConfig.length > 0;

    // 3) Bloque obligatorio de empresa: solo si tenemos nombre real
    let hardCompanyBlock = "";
    if (hasCompanyName) {
      hardCompanyBlock = `
Eres el asistente de voz OFICIAL de la empresa "${companyNameFromConfig}".

- Siempre debes decir que representas a la empresa "${companyNameFromConfig}".
- NUNCA digas que no representas una compañía específica.
- NUNCA digas que eres solo una IA genérica o un asistente sin empresa.
- Si el cliente pregunta quién eres o de qué compañía eres, responde claramente que eres el asistente de "${companyNameFromConfig}".
- Habla como humano, con tono amable y profesional.
- Eres totalmente bilingüe (español e inglés) y respondes en el idioma que use el cliente.
`.trim();
    } else {
      // Si NO tenemos nombre, no inventamos "tu empresa" ni nombres raros
      hardCompanyBlock = `
Eres un asistente de voz conectado al sistema de la empresa del cliente.

- Usa el contenido del prompt y la base de conocimiento para identificar el nombre de la empresa si está especificado allí.
- Si el nombre de la empresa aparece explícito en el prompt del sistema, úsalo siempre que el cliente pregunte.
- No inventes nombres de empresas. Si no estás seguro, responde de forma genérica (por ejemplo: "soy el asistente del sistema de atención").
- Habla como humano, con tono amable y profesional.
- Eres totalmente bilingüe (español e inglés) y respondes en el idioma que use el cliente.
`.trim();
    }

    const defaultFallback = hasCompanyName
      ? `
Tu tarea es ayudar a los clientes de "${companyNameFromConfig}" con sus preguntas sobre servicios, procesos y soporte. 
Haz preguntas claras para entender lo que necesitan y guíalos paso a paso.
`.trim()
      : `
Tu tarea es ayudar a los clientes de la empresa conectada a este sistema con sus preguntas sobre servicios, procesos y soporte. 
Haz preguntas claras para entender lo que necesitan y guíalos paso a paso.
`.trim();

    const instructions = [
      hardCompanyBlock,
      promptFromConfig || defaultFallback,
    ]
      .join("\n\n")
      .trim();

    console.log(
      "📏 Instrucciones finales length:",
      instructions.length,
      "| hasCompanyName:",
      hasCompanyName ? companyNameFromConfig : "N/A"
    );

    // 4) Mensaje de bienvenida
    let welcomeMessage =
      agentConfig?.welcome_message ||
      settings.welcome_message ||
      (hasCompanyName
        ? `Hola, gracias por llamar a ${companyNameFromConfig}. ¿En qué puedo ayudarte?`
        : `Hola, gracias por llamar. ¿En qué puedo ayudarte?`);

    // Personalizar si hay contacto conocido
    if (agentConfig?.contact?.full_name && !agentConfig.contact.is_new) {
      const firstName = agentConfig.contact.full_name.split(" ")[0];
      if (hasCompanyName) {
        welcomeMessage = `Hola ${firstName}, gracias por llamar a ${companyNameFromConfig}. ¿En qué puedo ayudarte hoy?`;
      } else {
        welcomeMessage = `Hola ${firstName}, gracias por llamar. ¿En qué puedo ayudarte hoy?`;
      }
    }

    // 5) Configurar sesión Realtime
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

    // 6) Saludo inicial automático
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
        call.pending = true;
        call.hasGreeted = true;
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

      if (!call.pending) {
        try {
          ws.send(
            JSON.stringify({
              type: "response.create",
              response: {
                modalities: ["audio", "text"],
                instructions:
                  "Responde de forma breve, clara, cordial y humana. Continúa la conversación de manera natural y enfocada en ayudar al cliente.",
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
        console.log(
          "⚠️ speech_stopped ignorado (pending ya true) para",
          callSid
        );
      }
    }

    // 3) Transcripción parcial
    if (type === "response.audio_transcript.delta") {
      const text = event.delta || "";
      if (text) {
        console.log(`📝 Parcial transcript (${callSid}):`, text);
        call.transcript += text;
      }
    }

    // 4) Audio → Twilio
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

// ---------------------------
// TWILIO → NUEVA CONEXIÓN WS
// ---------------------------
wss.on("connection", (ws) => {
  console.log("🌐 Nueva conexión WebSocket desde Twilio");

  let callSid = null;
  let streamSid = null;

  const meta = ws._voiceMeta || {};
  const wsAgentId = meta.agentId || null;
  const wsFromNumber = meta.fromNumber || null;
  const wsToNumber = meta.toNumber || null;

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

        console.log(
          `▶️ Llamada iniciada: ${callSid} (StreamSid: ${streamSid})`
        );

        let agentId = wsAgentId;
        if (!agentId && data.start.customParameters) {
          agentId =
            data.start.customParameters.agentId ||
            data.start.customParameters.agent_id ||
            null;
        }

        console.log("🧩 agentId para esta llamada:", agentId);
        console.log("📞 from:", wsFromNumber, "| to:", wsToNumber);

        const agentConfig =
          (await loadAgentConfig(agentId, wsFromNumber)) || {};

        calls.set(callSid, {
          twilio: ws,
          openai: null,
          streamSid,
          pending: false,
          hasGreeted: false,
          transcript: "",
          agentConfig,
          fromNumber: wsFromNumber,
          toNumber: wsToNumber,
        });

        const openAiWs = connectOpenAI(
          callSid,
          streamSid,
          ws,
          agentConfig
        );

        const call = calls.get(callSid);
        if (call) {
          call.openai = openAiWs;
        }
        break;
      }

      case "media": {
        const call = calls.get(callSid);
        if (!call || !call.openai || call.openai.readyState !== WebSocket.OPEN)
          return;

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
