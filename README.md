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

## Conversation starters, quick actions & personalised recommendations

Configure both in the control panel under **Quick actions & recommendations**, then publish.

- **Conversation starters**: suggested questions on the widget's welcome screen (falls back to the first FAQ questions when empty). They can be generated with AI from your business knowledge and also fill the teaser pop-up when it has no chips of its own.
- **Quick actions**: shortcut buttons on the welcome screen and in a bar above the message box. Types: send a message, recommend for me, discovery quiz, book a call (Calendly), contact support (alerts the team via `human_requested`), WhatsApp, try-it demo, open link.
- **Personalised recommendations** (`src/services/recommendationService.js`): ranks the catalog per visitor using industry/challenge (chat or quiz answers), pages browsed on the site (origin + path, kept in the visitor's browser and sent with chat requests), products opened or clicked, topics asked about, and purchase intent. The ranked shortlist is added to the AI prompt, used as a fallback when the AI returns no cards, shown as "Recommended for you" on the welcome screen, and each card gets a short "why it fits" reason.
- `POST /api/recommendations` with `{ clientId, personId?, sessionId?, browsing? }` returns `{ personalised, intentLevel, basedOn, items }`. With `preview: true` and a sample `profile` it ranks the draft catalog (used by the control panel preview).
- The widget sends `product_cta_clicked` events when a product's button link is clicked; they count as strong interest.

## Lead capture

Configure in the control panel's **Lead capture** tab, then publish. Lead questions are always a separate message after the answer, never part of it.

- **When to ask**: during the chat (after N visitor messages, with a re-ask delay and a per-conversation limit), only before accessing a resource, or both.
- **How to ask** (web widget): a short form in one message, or one question at a time. Questions are editable (wording, label, where the answer is saved, type, required). Answers saved as “Other” become their own column in Leads.
- **Gated resources**: upload a file (max 3 MB) or add a link, set trigger words and the details required. When a visitor asks for it (or taps its quick action), the bot asks for the missing details, then shares a signed download link that expires after 7 days. Uploaded files are private: `.data/lead-resources/` locally, Firebase Storage in production (set `FIREBASE_STORAGE_BUCKET`). Links are hidden from the public widget config.
- APIs: `POST /api/leads/capture` saves answers (`{ personId, sessionId, answers: { questionId: value }, resourceId? }`); `GET /api/lead-capture/resources/:id/download?token=…` serves the file; `POST /api/lead-capture/upload` and `GET /api/lead-capture/admin` are used by the control panel.
- WhatsApp/Instagram (n8n): see `followUp`, `attachments` and `messages` in `public/chat-api.md`.
