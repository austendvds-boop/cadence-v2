import express from "express";
import { WebSocketServer } from "ws";
import { createServer } from "http";
import { CallHandler } from "./call-handler";
import { OnboardingCallHandler } from "./onboarding-call-handler";
import { registerCallLogger } from "./call-logger";
import { getClientByPhone, isTrialExpired } from "./db";
import { getTenantRuntimeConfig } from "./tenant-config";
import { handleStripeWebhook } from "./stripe";
import { getDeactivationReason, renderTemporarilyUnavailableTwiml } from "./deactivation-policy";
import onboardingRouter from "./onboarding";

const app = express();

registerCallLogger();

const stripeWebhookRaw = express.raw({ type: "application/json" });
app.post("/stripe-webhook", stripeWebhookRaw, handleStripeWebhook);
app.post("/webhook/stripe", stripeWebhookRaw, handleStripeWebhook);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use("/api/onboarding", onboardingRouter);

app.get("/", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/incoming-call", async (req, res) => {
  const toNumber: string = req.body.To || req.body.Called || "";
  const fromNumber: string = req.body.From || req.body.Caller || "";

  const client = await getClientByPhone(toNumber);

  if (!client) {
    return res
      .type("text/xml")
      .send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>This number is not currently active. Goodbye.</Say><Hangup/></Response>');
  }

  const deactivationReason = getDeactivationReason(client, isTrialExpired(client));
  if (deactivationReason) {
    return res
      .type("text/xml")
      .send(renderTemporarilyUnavailableTwiml(client.business_name));
  }

  const streamUrl = process.env.TWILIO_WEBSOCKET_URL;
  if (!streamUrl) {
    return res.status(500).type("text/plain").send("Missing TWILIO_WEBSOCKET_URL");
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}">
      <Parameter name="clientId" value="${client.id}" />
      <Parameter name="from" value="${fromNumber}" />
    </Stream>
  </Connect>
</Response>`;

  res.type("text/xml").send(twiml);
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/media-stream" });

wss.on("connection", (ws) => {
  let handler: { handleMessage: (raw: string) => Promise<void> } | null = null;

  ws.on("message", async (message) => {
    try {
      const raw = message.toString();
      const parsed = JSON.parse(raw) as { event?: string; start?: { customParameters?: Record<string, string> } };

      if (!handler && parsed.event === "start") {
        const clientId = parsed.start?.customParameters?.clientId;
        if (!clientId) {
          ws.close();
          return;
        }

        const tenantConfig = await getTenantRuntimeConfig(clientId);
        if (!tenantConfig) {
          ws.close();
          return;
        }

        const handlerConfig = {
          clientId: tenantConfig.clientId,
          businessName: tenantConfig.businessName,
          systemPrompt: tenantConfig.systemPrompt,
          transferNumber: tenantConfig.transferNumber,
          greeting: tenantConfig.greeting,
          smsEnabled: tenantConfig.smsEnabled,
          bookingUrl: tenantConfig.bookingUrl,
          ownerPhone: tenantConfig.ownerPhone,
          twilioNumber: tenantConfig.twilioNumber
        };

        if (tenantConfig.intakeMode === "onboarding") {
          handler = new OnboardingCallHandler(ws, handlerConfig);
        } else {
          handler = new CallHandler(ws, handlerConfig);
        }
      }

      if (handler) {
        await handler.handleMessage(raw);
      }
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

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    wss.close();
    server.close(() => process.exit(0));
  });
}
