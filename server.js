"use strict";

const express = require("express");
const twilio = require("twilio");
const dotenv = require("dotenv");
const OpenAI = require("openai");

dotenv.config();

const app = express();
// Ensure Express respects X-Forwarded-* headers when behind a proxy/tunnel
app.set("trust proxy", true);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const port = process.env.PORT || 3000;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Optional Twilio signature validation middleware (enable with VERIFY_TWILIO_SIGNATURE=true)
const useSignatureValidation = String(process.env.VERIFY_TWILIO_SIGNATURE || "false").toLowerCase() === "true";
const twilioWebhookMiddleware = useSignatureValidation
  ? twilio.webhook({ validate: true, protocol: "https" })
  : (req, _res, next) => next();

const sessions = new Map();
const SESSION_TTL_MS = 1000 * 60 * 30; // 30 minutes

function buildSystemPrompt() {
  const businessName = process.env.BUSINESS_NAME || "Our Company";
  return [
    `You are ${businessName}'s helpful, empathetic call center agent.`,
    "Keep replies concise and voice-friendly (1-3 sentences).",
    "Ask one question at a time when gathering info.",
    "Use plain language. Avoid lists unless necessary.",
    "Offer to connect to a human agent when appropriate.",
    "If the caller indicates they are done, politely close the call."
  ].join(" ");
}

function getSession(callSid) {
  const now = Date.now();
  let session = sessions.get(callSid);
  if (!session) {
    session = {
      createdAt: now,
      updatedAt: now,
      messages: [
        { role: "system", content: buildSystemPrompt() }
      ]
    };
    sessions.set(callSid, session);
  } else {
    session.updatedAt = now;
  }
  return session;
}

function pruneOldSessions() {
  const now = Date.now();
  for (const [sid, sess] of sessions.entries()) {
    if (now - (sess.updatedAt || sess.createdAt) > SESSION_TTL_MS) {
      sessions.delete(sid);
    }
  }
}
setInterval(pruneOldSessions, 60 * 1000);

function shouldTransferToHuman(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return [
    "representative",
    "human",
    "agent",
    "operator",
    "real person",
    "someone"
  ].some(k => t.includes(k));
}

function shouldEndCall(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return [
    "goodbye",
    "bye",
    "that's all",
    "that is all",
    "no thank you",
    "no thanks",
    "nothing else"
  ].some(k => t.includes(k));
}

app.get("/healthz", (req, res) => res.status(200).send("ok"));

app.post("/twilio/voice", twilioWebhookMiddleware, async (req, res) => {
  const callSid = req.body?.CallSid || "unknown";
  getSession(callSid);

  const response = new twilio.twiml.VoiceResponse();
  const gather = response.gather({
    input: "speech dtmf",
    action: "/twilio/gather",
    method: "POST",
    language: process.env.SPEECH_LANGUAGE || "en-US",
    speechTimeout: "auto",
    actionOnEmptyResult: true,
    timeout: parseInt(process.env.GATHER_TIMEOUT_SECONDS || "5", 10)
  });

  const voice = process.env.TWILIO_VOICE || "Polly.Joanna";
  const businessName = process.env.BUSINESS_NAME || "our company";
  const greeting = process.env.GREETING_OVERRIDE || `Hi, thanks for calling ${businessName}. How can I help you today?`;
  gather.say({ voice }, greeting);

  res.type("text/xml");
  res.send(response.toString());
});

app.post("/twilio/gather", twilioWebhookMiddleware, async (req, res) => {
  const response = new twilio.twiml.VoiceResponse();

  const callSid = req.body?.CallSid || "unknown";
  const speech = (req.body?.SpeechResult || "").trim();
  const digits = (req.body?.Digits || "").trim();
  const userText = speech || (digits ? `DTMF ${digits}` : "");

  if (shouldTransferToHuman(userText)) {
    const humanPhone = process.env.HUMAN_AGENT_PHONE;
    const voice = process.env.TWILIO_VOICE || "Polly.Joanna";
    if (humanPhone) {
      response.say({ voice }, "Connecting you to a human agent now.");
      const dial = response.dial({});
      dial.number(humanPhone);
    } else {
      response.say({ voice }, "A human agent is not available. Please leave your contact details after the tone.");
      response.record({
        maxLength: 60,
        transcribe: false,
        playBeep: true,
        finishOnKey: "#",
        action: "/twilio/voice"
      });
    }
    res.type("text/xml").send(response.toString());
    return;
  }

  if (!userText) {
    const voice = process.env.TWILIO_VOICE || "Polly.Joanna";
    response.say({ voice }, "I didn't catch that.");
    addGather(response);
    res.type("text/xml").send(response.toString());
    return;
  }

  if (shouldEndCall(userText)) {
    const voice = process.env.TWILIO_VOICE || "Polly.Joanna";
    response.say({ voice }, "Thanks for calling. Goodbye!");
    response.hangup();
    res.type("text/xml").send(response.toString());
    return;
  }

  const session = getSession(callSid);
  session.messages.push({ role: "user", content: userText });

  let assistantReply = "Sorry, I had trouble generating a response. Please try again.";
  try {
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    const result = await openai.chat.completions.create({
      model,
      messages: session.messages.slice(-20),
      temperature: Number(process.env.OPENAI_TEMPERATURE || 0.4),
      max_tokens: 180
    });
    assistantReply = (result.choices?.[0]?.message?.content || assistantReply).trim();
  } catch (err) {
    console.error("OpenAI error", err?.response?.data || err?.message || err);
  }

  session.messages.push({ role: "assistant", content: assistantReply });

  const voice = process.env.TWILIO_VOICE || "Polly.Joanna";
  response.say({ voice }, assistantReply);
  addGather(response);

  res.type("text/xml").send(response.toString());
});

function addGather(twiml) {
  const gather = twiml.gather({
    input: "speech dtmf",
    action: "/twilio/gather",
    method: "POST",
    language: process.env.SPEECH_LANGUAGE || "en-US",
    speechTimeout: "auto",
    actionOnEmptyResult: true,
    timeout: parseInt(process.env.GATHER_TIMEOUT_SECONDS || "5", 10)
  });
  const voice = process.env.TWILIO_VOICE || "Polly.Joanna";
  gather.say({ voice }, process.env.REPROMPT_OVERRIDE || "You can ask another question, or say human to talk to a person.");
}

app.listen(port, () => {
  console.log(`AI call center listening on port ${port}`);
});
