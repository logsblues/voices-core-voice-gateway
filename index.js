import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
import "dotenv/config";

// ============================================
// CONFIGURACIÓN
// ============================================
const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const VOICE_GATEWAY_TOKEN = process.env.VOICE_GATEWAY_TOKEN;
const MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";

// Validar configuración
if (!OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY no está configurada");
  process.exit(1);
}

if (!SUPABASE_URL) {
  console.error("❌ SUPABASE_URL no está configurada");
  process.exit(1);
}

console.log("🚀 Voice Gateway v4 iniciando...");
console.log(`📡 SUPABASE_URL: ${SUPABASE_URL}`);
console.log(`🧠 Modelo OpenAI: ${MODEL}`);

// ============================================
// ALMACENAMIENTO DE LLAMADAS ACTIVAS
// ============================================
const calls = new Map();

// ============================================
// CONVERSIÓN DE AUDIO: μ-law <-> PCM16 (helpers)
// ============================================
const MULAW_BIAS = 33;
const MULAW_MAX = 32635;

function mulawEncode(sample) {
  const sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) sample = -sample;
  if (sample > MULAW_MAX) sample = MULAW_MAX;
  sample += MULAW_BIAS;
  let exponent = 7;
  for (
    let expMask = 0x4000;
    (sample & expMask) === 0 && exponent > 0;
    exponent--, expMask >>= 1
  ) {}
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  const mulaw = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return mulaw;
}

function mulawDecode(mulaw) {
  mulaw = ~mulaw & 0xff;
  const sign = mulaw & 0x80 ? -1 : 1;
  const exponent = (mulaw >> 4) & 0x07;
  const mantissa = mulaw & 0x0f;
  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  sample -= MULAW_BIAS;
  return sign * sample;
}

function convertMulawToPCM16(mulawData) {
  const pcm16 = new Int16Array(mulawData.length);
  for (let i = 0; i < mulawData.length; i++) {
    pcm16[i] = mulawDecode(mulawData[i]);
  }
  return pcm16;
}

function convertPCM16ToMulaw(pcm16Data) {
  const mulaw = new Uint8Array(pcm16Data.length);
  for (let i = 0; i < pcm16Data.length; i++) {
    mulaw[i] = mulawEncode(pcm16Data[i]);
  }
  return mulaw;
}

// ============================================
// CARGAR CONFIGURACIÓN DEL AGENTE DESDE SUPABASE
// ============================================
async function loadAgentConfig(agentId) {
  if (!agentId) {
    console.log("⚠️ No agentId provided, usando config por defecto");
    return null;
  }

  const configUrl = `${SUPABASE_URL}/functions/v1/voice-agent-config/${agentId}/config`;
  console.log(`📡 Cargando config desde: ${configUrl}`);

  try {
    const headers = {};
    if (VOICE_GATEWAY_TOKEN) {
      headers["x-voice-gateway-token"] = VOICE_GATEWAY_TOKEN;
    }

    const response = await fetch(configUrl, { headers });

    if (!response.ok) {
      console.error(
        `❌ Error cargando config: ${response.status} ${response.statusText}`
      );
      const text = await response.text();
      console.error(`   Response: ${text}`);
      return null;
    }

    const config = await response.json();
    console.log(
      `✅ Config cargada para agente: ${config.name || config.agent?.name || agentId}`
    );
    console.log(
      `   - Company: ${
        config.meta?.company_name || config.agent?.company_name || "N/A"
      }`
    );
    console.log(
      `   - Language: ${config.settings?.language || "es"}`
    );
    console.log(
      `   - System prompt length: ${config.system_prompt?.length || 0} chars`
    );

    return config;
  } catch (error) {
    console.error("🚨 Error llamando a voice-agent-config:", error.message);
    return null;
  }
}

// ============================================
// CONEXIÓN A OPENAI REALTIME
// ============================================
function connectOpenAI(callSid, streamSid, agentConfig, twilioWs) {
  console.log(`🧠 Conectando a OpenAI para CallSid: ${callSid}`);

  const openAiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${MODEL}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  openAiWs.on("open", () => {
    console.log(`✅ OpenAI WebSocket conectado para CallSid: ${callSid}`);

    // Prompt del agente o default
    const systemPrompt =
      agentConfig?.system_prompt ||
      "Eres un asistente de voz amable y profesional. Responde de forma concisa y útil.";

    const welcomeMessage =
      agentConfig?.welcome_message ||
      "Hola, gracias por llamar. ¿En qué puedo ayudarte?";

    const voiceId =
      agentConfig?.settings?.voice?.voice_id ||
      agentConfig?.agent?.openai_voice ||
      "alloy";

    console.log("🎤 Configurando sesión OpenAI:");
    console.log(`   - Voice: ${voiceId}`);
    console.log(
      `   - System prompt (primeros 100 chars): ${systemPrompt.substring(
        0,
        100
      )}...`
    );

    // Configurar sesión
    openAiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["audio", "text"],
          voice: voiceId,
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          instructions: systemPrompt,
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
          },
        },
      })
    );

    // Mensaje de bienvenida (se lo damos como "user" y pedimos response.create)
    setTimeout(() => {
      console.log(
        `📢 Enviando mensaje de bienvenida: "${welcomeMessage.substring(
          0,
          50
        )}..."`
      );

      openAiWs.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: `[SISTEMA: El usuario acaba de conectarse a la llamada. Salúdalo con este mensaje exacto: "${welcomeMessage}"]`,
              },
            ],
          },
        })
      );

      openAiWs.send(JSON.stringify({ type: "response.create" }));
    }, 500);
  });

  openAiWs.on("message", (data) => {
    try {
      const event = JSON.parse(data.toString());

      switch (event.type) {
        case "response.audio.delta":
          // Audio de salida hacia Twilio
          if (event.delta && twilioWs.readyState === WebSocket.OPEN) {
            const call = calls.get(callSid);
            if (call) {
              twilioWs.send(
                JSON.stringify({
                  event: "media",
                  streamSid: call.streamSid,
                  media: {
                    payload: event.delta,
                  },
                })
              );
            }
          }
          break;

        case "response.audio_transcript.done":
          console.log(`🧠 [${callSid}] AI: ${event.transcript}`);
          break;

        case "conversation.item.input_audio_transcription.completed":
          console.log(`🧍 [${callSid}] Usuario: ${event.transcript}`);
          break;

        case "error":
          console.error(`❌ [${callSid}] Error OpenAI:`, event.error);
          break;

        case "session.created":
          console.log(`📄 [${callSid}] Sesión OpenAI creada`);
          break;

        case "session.updated":
          console.log(`📄 [${callSid}] Sesión OpenAI actualizada`);
          break;

        case "response.done":
          console.log(`✅ [${callSid}] Respuesta completada`);
          break;

        default:
          // Otros eventos informativos, los ignoramos
          break;
      }
    } catch (error) {
      console.error("❌ Error procesando mensaje OpenAI:", error.message);
    }
  });

  openAiWs.on("error", (error) => {
    console.error(
      `❌ OpenAI WebSocket error para ${callSid}:`,
      error.message
    );
  });

  openAiWs.on("close", (code, reason) => {
    console.log(
      `🔌 OpenAI WebSocket cerrado para ${callSid}. Code: ${code}, Reason: ${reason}`
    );
  });

  return openAiWs;
}

// ============================================
// SERVIDOR HTTP + WEBSOCKET
// ============================================
const server = createServer((req, res) => {
  // Health check
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        version: "4.0.0",
        activeCalls: calls.size,
        timestamp: new Date().toISOString(),
      })
    );
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

const wss = new WebSocketServer({ noServer: true });

// Upgrade HTTP → WebSocket
server.on("upgrade", (req, socket, head) => {
  const { url } = req;
  console.log(`🔁 HTTP upgrade solicitado. URL: ${url}`);

  if (url && url.startsWith("/twilio-stream")) {
    // Extraer agentId
    const fullUrl = new URL(url, `http://localhost:${PORT}`);
    const agentId = fullUrl.searchParams.get("agentId") || null;

    console.log(`✅ Aceptando conexión WS para /twilio-stream`);
    console.log(`   - agentId: ${agentId || "NO ESPECIFICADO"}`);

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.agentId = agentId;
      wss.emit("connection", ws, req);
    });
  } else {
    console.log(`❌ Rechazando upgrade (ruta inválida): ${url}`);
    socket.destroy();
  }
});

// Conexiones WebSocket (Twilio)
wss.on("connection", (ws, req) => {
  console.log("🌐 Nueva conexión WebSocket de Twilio");
  console.log(`   - agentId guardado: ${ws.agentId || "ninguno"}`);

  let callSid = null;
  let streamSid = null;

  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message.toString());

      switch (data.event) {
        case "connected":
          console.log("📞 Twilio Media Stream conectado");
          break;

        case "start":
          callSid = data.start.callSid;
          streamSid = data.start.streamSid;

          console.log("▶️ Llamada iniciada:");
          console.log(`   - CallSid: ${callSid}`);
          console.log(`   - StreamSid: ${streamSid}`);
          console.log(`   - agentId: ${ws.agentId || "NO ESPECIFICADO"}`);

          // Cargar configuración del agente
          const agentConfig = await loadAgentConfig(ws.agentId);

          // Conectar a OpenAI con esa config
          const openAiWs = connectOpenAI(
            callSid,
            streamSid,
            agentConfig,
            ws
          );

          // Guardar estado de la llamada
          calls.set(callSid, {
            twilio: ws,
            openai: openAiWs,
            streamSid,
            agentConfig,
            agentId: ws.agentId,
            startTime: new Date(),
          });
          break;

        case "media":
          // Audio entrante → OpenAI
          if (callSid) {
            const call = calls.get(callSid);
            if (
              call &&
              call.openai &&
              call.openai.readyState === WebSocket.OPEN
            ) {
              call.openai.send(
                JSON.stringify({
                  type: "input_audio_buffer.append",
                  audio: data.media.payload,
                })
              );
            }
          }
          break;

        case "stop":
          console.log(`⏹ Llamada terminada: ${callSid}`);

          if (callSid) {
            const call = calls.get(callSid);
            if (call) {
              const duration = call.startTime
                ? Math.round((new Date() - call.startTime) / 1000)
                : 0;

              console.log(`   - Duración: ${duration} segundos`);
              console.log(
                `   - Agente: ${call.agentConfig?.name || "default"}`
              );

              if (call.openai) {
                call.openai.close();
              }

              calls.delete(callSid);
            }
          }
          break;

        default:
          // Ignorar otros eventos
          break;
      }
    } catch (error) {
      console.error("❌ Error procesando mensaje Twilio:", error.message);
    }
  });

  ws.on("error", (error) => {
    console.error("❌ WebSocket error:", error.message);
  });

  ws.on("close", () => {
    console.log("🔌 WebSocket Twilio cerrado");

    if (callSid) {
      const call = calls.get(callSid);
      if (call && call.openai) {
        call.openai.close();
      }
      calls.delete(callSid);
    }
  });
});

// Iniciar servidor
server.listen(PORT, () => {
  console.log(`
┌─────────────────────────────────────────────────────────────┐
│         🎙️  VOICE GATEWAY v4.0 INICIADO  🎙️          │
├─────────────────────────────────────────────────────────────┤
│  Puerto:     ${PORT.toString().padEnd(40)}│
│  Modelo:     ${MODEL.padEnd(40)}│
│  Supabase:   ${SUPABASE_URL.substring(0, 38).padEnd(40)}│
└─────────────────────────────────────────────────────────────┘
  `);
});

// Cierre limpio
process.on("SIGTERM", () => {
  console.log("📴 Recibida señal SIGTERM, cerrando...");

  for (const [callSid, call] of calls) {
    if (call.openai) call.openai.close();
    if (call.twilio) call.twilio.close();
  }

  server.close(() => {
    console.log("✅ Servidor cerrado correctamente");
    process.exit(0);
  });
});

