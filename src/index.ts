import express from "express";
import { WebSocketServer } from "ws";
import { createServer } from "http";
import { CallHandler } from "./call-handler";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/incoming-call", (_req, res) => {
  const streamUrl = process.env.TWILIO_WEBSOCKET_URL;
  if (!streamUrl) {
    return res.status(500).type("text/plain").send("Missing TWILIO_WEBSOCKET_URL");
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Connect>\n    <Stream url="${streamUrl}" />\n  </Connect>\n</Response>`;
  res.type("text/xml").send(twiml);
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/media-stream" });

wss.on("connection", (ws) => {
  const handler = new CallHandler(ws);

  ws.on("message", async (message) => {
    try {
      await handler.handleMessage(message.toString());
    } catch (err) {
      console.error("failed to handle ws message", err);
    }
  });

  ws.on("error", (err) => {
    console.error("twilio ws error", err);
  });
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => {
  console.log(`cadence-v2 listening on ${port}`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    wss.close();
    server.close(() => process.exit(0));
  });
}
