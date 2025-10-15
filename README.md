# AI Call Center

This repository contains an MVP AI agent call center using Twilio Voice webhooks and OpenAI. It answers calls, gathers speech, and responds using an LLM. You can route to a human agent on keyword.

## Features
- Inbound voice webhook at `/twilio/voice`
- Speech + DTMF input via Twilio `<Gather>`
- LLM responses using OpenAI Chat Completions
- Simple in-memory session history keyed by `CallSid`
- Optional transfer to human agent

## Quick start
1. Create `.env` from example and fill values:
   ```bash
   cp .env.example .env
   # fill OPENAI_API_KEY, optional HUMAN_AGENT_PHONE, etc.
   ```
2. Install deps and run locally:
   ```bash
   npm install
   npm run dev
   ```
3. Expose your local server to Twilio (choose one):
   - `npx ngrok http 3000`
   - or `cloudflared tunnel --url http://localhost:3000`
4. In Twilio Console, set your phone number Voice webhook to your public URL:
   - Voice A Call Comes In: `POST https://<your-tunnel>/twilio/voice`

## Environment
See `.env.example` for available variables.

## Deploy
Any Node 18+ environment works (Render, Fly, Railway, Heroku, etc.). Bind port from `PORT` env.

## Notes
- This is an MVP. For production, add persistent storage, auth, monitoring, and better error handling.
