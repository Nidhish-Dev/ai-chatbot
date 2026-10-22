# Website Bot API

Node.js API, Firebase-backed bot services, and control panel. The public website and widget remain in ../bot.

## Run locally

    cp .env.example .env
    npm install
    npm start

The control panel opens at http://localhost:3000/control-panel in development.

## Deploy

Set NODE_ENV=production, FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, and a strong N8N_API_KEY in the host's secret environment settings. Provide the Firebase private key with \n line breaks (the server converts them automatically). The OpenAI API key is saved in the Firebase client configuration from the control panel; it does not need to be a Vercel environment variable. Keep WhatsApp and Instagram access tokens in n8n; this backend does not receive Meta webhooks or send messages to Meta. Never commit .env or service-account files. Production startup requires valid Firebase credentials.

## Connect WhatsApp or Instagram through n8n

Configure Meta's webhook callback URLs in n8n, then have the workflow normalize each incoming event and call `POST https://<your-api-domain>/api/chat`. Send `Content-Type: application/json` and `x-api-key: <N8N_API_KEY>`. Example body:

    {
      "clientId": "grapelabs",
      "channel": "whatsapp",
      "channelUserId": "15551234567",
      "message": "What services do you offer?"
    }

Use `channel: "instagram"` and the Instagram sender ID for Instagram DMs. The API returns `reply`, `buttons`, `cards`, and `person`; use n8n's WhatsApp or Instagram node to send `reply` back to that sender. Preserve the same `channelUserId` for each user so conversation identity remains stable. Set the Meta access tokens and phone/account IDs in n8n credentials, not this backend.

### Deploy to Vercel

Set the Vercel project's Root Directory to `backend`, then add the required environment variables under Project Settings → Environment Variables. Vercel detects the Express app automatically; `vercel.json` sets a 60-second function limit for chat and knowledge requests.

Without Firebase credentials in development, the API uses .data/firestore.json. The control panel stores bot settings and knowledge in Firestore. Uploaded documents are sent to OpenAI for FAQ generation and are not retained by the app.
