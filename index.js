// index.js - Voice Gateway V4 (Render + Twilio Media Streams + OpenAI Realtime)
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
import "dotenv/config";

// ============================================
// CONFIG
// ============================================
const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const VOICE_GATEWAY_TOKEN = process.env.VOICE_GATEWAY_TOKEN;
const MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";

if (!OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY no está configurada");
  process.exit(1);
}
if (!SUPABASE_URL) {
  console.error("❌ SUPABASE_URL no está configurada");
  process.exit(1);
}

console.log("🚀 Voice Gateway v4 iniciando...");
console.log(`🌐 SUPABASE_URL: ${SUPABASE_URL}`);
console.log(`🧠 Modelo OpenAI: ${MODEL}`);

// ============================================
// MAPA DE LLAMADAS ACTIVAS
// ============================================
const calls = new Map();

// ============================================
// HELPERS: CARGAR CONFIG DEL AGENTE
// ============================================
async function loadAgentConfig(agentId) {
  if (!agentId) {
    console.log("⚠️ No agentId provided, usando config por defecto");
    return null;
  }

  const url = `${SUPABASE_URL}/functions/v1/voice-agent-config/${agentId}/config`;
  console.log(`📡 Cargando config de agente desde: ${url}`);

  try {
    const headers = {};
    if (VOICE_GATEWAY_TOKEN) {
      headers["x-voice-gateway-token"] = VOICE_GATEWAY_TOKEN;
    }

    const res = await fetch(url, { headers });

    if (!res.ok) {
      console.error(
        `❌ Error cargando config: ${res.status} ${res.statusText}`
      );
      const text = await res.text();
      console.error("   Respuesta:", text);
      return null;
    }

    const config = await res.json();
    console.log(
      `✅ Config cargada para agente: ${config.name || config.agent?.name || agentId}`
    );
    console.log(
      `   - Empresa: ${
        config.settings?.company_name ||
        config.meta?.company_name ||
        config.agent?.company_name ||
        "N/A"
      }`
    );
    console.log(
      `   - system_prompt length: ${config.system_prompt?.length || 0} chars`
    );

    return config;
  } catch (err) {
    console.error("🚨 Error llamando a voice-agent-config:", err.message);
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

    // Prompt e identidad del agente
    const systemPrompt =
      agentConfig?.system_prompt ||
      agentConfig?.prompts?.full ||
      "Eres un asistente de voz amable y profesional. Responde de forma clara y útil.";
    const welcomeMessage =
      agentConfig?.welcome_message ||
      agentConfig?.settings?.welcome_message ||
      "Hola, gracias por llamar. ¿En qué puedo ayudarte?";
    const voiceId =
      agentConfig?.settings?.voice?.voice_id ||
      agentConfig?.voice?.voice_id ||
      "alloy";

    console.log("🎛 Configurando sesión OpenAI:");
    console.log(`   - Voice: ${voiceId}`);
    console.log(
      `   - Prompt preview: ${systemPrompt.substring(0, 200).replace(/\n/g, " ")}...`
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
          input_audio_transcription: {
            model: "whisper-1",
          },
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 800,
          },
        },
      })
    );

    // Enviar saludo inicial como respuesta de la IA
    if (welcomeMessage) {
      setTimeout(() => {
        console.log(
          `📢 Enviando saludo inicial: "${welcomeMessage.substring(0, 80)}..."`
        );
        openAiWs.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "input_text",
                  text: welcomeMessage,
                },
              ],
            },
          })
        );
        openAiWs.send(JSON.stringify({ type: "response.create" }));
      }, 400);
    }
  });

  openAiWs.on("message", (data) => {
    try {
      const event = JSON.parse(data.toString());

      switch (event.type) {
        case "response.audio.delta": {
          const audio = event.delta;
          if (!audio) return;
          const call = calls.get(callSid);
          if (!call) return;

          if (
            twilioWs.readyState === WebSocket.OPEN &&
            call.streamSid /* sanity */
          ) {
            twilioWs.send(
              JSON.stringify({
                event: "media",
                streamSid: call.streamSid,
                media: { payload: audio },
              })
            );
          }
          break;
        }

        case "response.audio_transcript.done":
          console.log(`🧠 [${callSid}] AI: ${event.transcript}`);
          break;

        case "conversation.item.input_audio_transcription.completed":
          console.log(`🧑 [${callSid}] Usuario: ${event.transcript}`);
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
          // otros eventos, ignoramos/log sencillo
          break;
      }
    } catch (err) {
      console.error("❌ Error procesando mensaje de OpenAI:", err.message);
    }
  });

  openAiWs.on("error", (err) => {
    console.error(`❌ OpenAI WS error para ${callSid}:`, err.message);
  });

  openAiWs.on("close", (code, reason) => {
    console.log(
      `🔌 OpenAI WS cerrado para ${callSid}. Code=${code}, Reason=${reason}`
    );
  });

  return openAiWs;
}

// ============================================
// HTTP SERVER (Health check)
// ============================================
const server = createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        version: "4.0.1",
        activeCalls: calls.size,
        timestamp: new Date().toISOString(),
      })
    );
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

// ============================================
// WEBSOCKET SERVER (Twilio Media Streams)
// ============================================
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const { url } = req;
  console.log(`🔁 HTTP upgrade solicitado. URL: ${url}`);

  if (url && url.startsWith("/twilio-stream")) {
    console.log("✅ Aceptando conexión WS para /twilio-stream");

    wss.handleUpgrade(req, socket, head, (ws) => {
      // NOTA: ya NO confiamos en query params para agentId
      // El agentId vendrá en msg.start.customParameters.agentId
      wss.emit("connection", ws, req);
    });
  } else {
    console.log(`❌ Rechazando upgrade (ruta inválida): ${url}`);
    socket.destroy();
  }
});

wss.on("connection", (ws, req) => {
  console.log("🌐 Nueva conexión WebSocket desde Twilio");

  let callSid = null;
  let streamSid = null;

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      console.error("🚨 Error parseando JSON desde Twilio");
      return;
    }

    const event = msg.event;

    switch (event) {
      case "connected":
        console.log("📡 Evento Twilio: connected (handshake inicial)");
        break;

      case "start": {
        callSid = msg.start?.callSid || null;
        streamSid = msg.start?.streamSid || null;

        const custom = msg.start?.customParameters || {};
        const agentId = custom.agentId || null;
        const from = custom.from || msg.start?.callSidFrom || null;
        const to = custom.to || null;

        console.log("▶️ Llamada iniciada:");
        console.log("   - CallSid:", callSid);
        console.log("   - StreamSid:", streamSid);
        console.log("   - agentId (customParameters):", agentId);
        console.log("   - from:", from);
        console.log("   - to:", to);

        // Cargar config del agente desde Supabase
        const agentConfig = await loadAgentConfig(agentId);

        // Conectar OpenAI con esa config
        const openAiWs = connectOpenAI(callSid, streamSid, agentConfig, ws);

        // Guardar estado de la llamada
        calls.set(callSid, {
          twilio: ws,
          openai: openAiWs,
          streamSid,
          agentConfig,
          agentId,
          from,
          to,
          startTime: new Date(),
        });
        break;
      }

      case "media": {
        // Audio desde Twilio → OpenAI
        if (!callSid) return;
        const call = calls.get(callSid);
        if (!call || !call.openai) return;
        if (call.openai.readyState !== WebSocket.OPEN) return;

        const payload = msg.media?.payload;
        if (!payload) return;

        try {
          call.openai.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: payload,
            })
          );
        } catch (err) {
          console.error("🚨 Error enviando audio a OpenAI:", err.message);
        }

        console.log(`🎙 Evento Twilio: media (CallSid ${callSid})`);
        break;
      }

      case "stop": {
        console.log(`⏹ Llamada terminada: ${callSid}`);
        if (callSid) {
          const call = calls.get(callSid);
          if (call) {
            const duration = call.startTime
              ? Math.round((new Date() - call.startTime) / 1000)
              : 0;
            console.log(`   - Duración: ${duration} segundos`);
            console.log(
              `   - Agente: ${call.agentConfig?.name || call.agentId || "default"}`
            );

            try {
              if (call.openai) call.openai.close();
            } catch {}
            calls.delete(callSid);
          }
        }
        break;
      }

      default:
        // Otros eventos Twilio (mark, etc.)
        break;
    }
  });

  ws.on("close", () => {
    console.log("🔌 WebSocket Twilio cerrado");
    if (callSid) {
      const call = calls.get(callSid);
      if (call && call.openai) {
        try {
          call.openai.close();
        } catch {}
      }
      calls.delete(callSid);
    }
  });

  ws.on("error", (err) => {
    console.error("⚠️ WebSocket error:", err.message);
  });
});

// ============================================
// INICIAR SERVIDOR
// ============================================
server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════╗
║     🎙️  VOICE GATEWAY v4.0.1 LISTO EN RENDER      ║
╠════════════════════════════════════════════════════╣
║  Puerto:   ${PORT.toString().padEnd(40)}║
║  Modelo:   ${MODEL.padEnd(40)}║
║  Supabase: ${SUPABASE_URL.substring(0, 38).padEnd(40)}║
╚════════════════════════════════════════════════════╝
`);
});

// Shutdown limpio
process.on("SIGTERM", () => {
  console.log("📴 SIGTERM recibido, cerrando...");
  for (const [sid, call] of calls) {
    try {
      if (call.openai) call.openai.close();
      if (call.twilio) call.twilio.close();
    } catch {}
  }
  server.close(() => {
    console.log("✅ Servidor cerrado correctamente");
    process.exit(0);
  });
});
