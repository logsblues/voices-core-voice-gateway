// index.js - Voices Core Voice Gateway (v1)
// Servidor HTTP + WebSocket para Twilio Media Streams
// FASE 1: SOLO probar que Twilio se conecta por WSS y vemos los eventos en los logs.

const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;

// Servidor HTTP simple (Render requiere que escuchemos en HTTP)
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Voices Core Voice Gateway is running.\n");
});

// Creamos un servidor WebSocket montado sobre ese HTTP server
const wss = new WebSocket.Server({ noServer: true });

// Manejo de upgrade HTTP -> WebSocket
server.on("upgrade", (request, socket, head) => {
  const { url } = request;

  // Solo aceptamos la ruta /twilio-stream
  if (url === "/twilio-stream") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Lógica cuando Twilio se conecta a /twilio-stream
wss.on("connection", (ws, request) => {
  console.log("✅ Nueva conexión WebSocket desde Twilio");

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      console.log("📩 Evento Twilio:", msg.event);

      if (msg.event === "start") {
        console.log("▶️ Llamada iniciada. CallSid:", msg.start.callSid);
        console.log("   Desde:", msg.start.from, "→ Hacia:", msg.start.to);
      }

      if (msg.event === "media") {
        // Aquí viene el audio del cliente en base64 (μ-law)
        // En esta FASE 1 solo lo reconocemos y no hacemos nada.
        // Más adelante lo mandaremos a OpenAI Realtime.
        // const audioBase64 = msg.media.payload;
      }

      if (msg.event === "stop") {
        console.log("⏹ Llamada finalizada");
        ws.close();
      }
    } catch (e) {
      console.error("❌ Error parseando mensaje:", e);
    }
  });

  ws.on("close", () => {
    console.log("🔌 Conexión WebSocket cerrada");
  });
});

// Iniciar servidor HTTP
server.listen(PORT, () => {
  console.log(`🚀 Voice Gateway escuchando en puerto ${PORT}`);
});
