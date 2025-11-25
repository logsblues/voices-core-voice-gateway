// ============================
// 📞 Voices Core - Voice Gateway v4
// WebSocket Gateway para Twilio Media Streams
// ============================

import http from "http";
import WebSocket, { WebSocketServer } from "ws";

// ---------------------------
// Configuración del servidor
// ---------------------------
const PORT = process.env.PORT || 10000;

// Crear servidor HTTP base (necesario para upgrade → WebSocket)
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("VoicesCore Voice Gateway is running.");
});

// Crear WebSocket Server (sin puerto, se conecta al HTTP server)
const wss = new WebSocketServer({ noServer: true });

// ---------------------------------------
// 1️⃣ Manejo del Upgrade (HTTP → WS)
// ---------------------------------------
server.on("upgrade", (request, socket, head) => {
  const { url } = request;
  console.log("🔁 HTTP upgrade solicitado. URL:", url);

  // Solo aceptamos esta ruta EXACTA
  if (url === "/twilio-stream") {
    console.log("✅ Aceptando conexión WS para Twilio Stream");

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    console.log("❌ Rechazando upgrade (ruta no válida):", url);
    socket.destroy();
  }
});

// ---------------------------------------
// 2️⃣ Conexión WebSocket establecida
// ---------------------------------------
wss.on("connection", (ws, request) => {
  console.log("🌐 Nueva conexión WebSocket desde Twilio");

  // Mensaje recibido desde Twilio
  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      console.log("📩 Evento Twilio:", data.event);

      switch (data.event) {
        case "start":
          console.log("▶️ Llamada iniciada. CallSid:", data.start?.callSid);
          break;

        case "media":
          // Aquí recibimos audio base64
          // console.log("🎙 Audio recibido (media chunk)");
          break;

        case "mark":
          console.log("🔖 Marca:", data.mark?.name);
          break;

        case "stop":
          console.log("⏹ Llamada finalizada.");
          break;

        default:
          console.log("❓ Evento desconocido:", data.event);
      }
    } catch (err) {
      console.error("🚨 Error al procesar mensaje:", err);
    }
  });

  // Manejo de cierre de conexión
  ws.on("close", () => {
    console.log("🔌 Conexión WebSocket cerrada");
  });

  ws.on("error", (err) => {
    console.error("⚠️ Error WS:", err);
  });
});

// ---------------------------------------
// 3️⃣ Inicializar servidor HTTP
// ---------------------------------------
server.listen(PORT, () => {
  console.log(`🚀 Voice Gateway escuchando en puerto ${PORT}`);
});

