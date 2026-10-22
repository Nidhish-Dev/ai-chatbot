# Chat API

Use these endpoints to connect the bot to a website, n8n, WhatsApp, Instagram, or another client. Replace `<API_BASE_URL>` with the deployed backend origin, for example `https://bot-api.example.com`. Do not use `localhost` outside your own machine.

The API reads the active bot prompt, business knowledge, website content, and FAQs from its configured database. Send each user message to the API and deliver the returned `reply` through your channel.

## `POST /chat` — website and browser clients

This endpoint is intended for a website widget. It returns JSON by default and can return Server-Sent Events when the request includes `Accept: text/event-stream` and `stream: true`.

### Request

`POST <API_BASE_URL>/chat`

Headers:

```http
Content-Type: application/json
Accept: application/json
```

Body:

```json
{
  "clientId": "grapelabs",
  "sessionId": "stable-browser-session-id",
  "message": "What services do you offer?"
}
```

`sessionId` should stay the same for the same browser visitor so the bot can keep conversation context. Optional fields are `personId`, `buttonPayload`, `linkToken`, and `metadata`.

## Where `clientId`, `channel`, `channelUserId`, and `sessionId` come from

### `clientId`

`clientId` selects which bot configuration and knowledge base the API uses. This installation's value is `grapelabs`. Pass it as a fixed value in your integration. If you omit it, the API defaults to `grapelabs`.

### `channel`

Set this yourself based on where the message arrived. Use `web` for the website, `whatsapp` for WhatsApp, or `instagram` for Instagram.

### `channelUserId` for WhatsApp and Instagram

Meta includes the sender ID in each incoming webhook event. In n8n, open the Webhook/Trigger node's test output, inspect the incoming event JSON, then map the sender's ID into `channelUserId` in the HTTP Request node.

For the standard raw Meta webhook payloads, the paths are:

| Channel | Sender ID path | Message text path |
| --- | --- | --- |
| WhatsApp | `entry[0].changes[0].value.messages[0].from` | `entry[0].changes[0].value.messages[0].text.body` |
| Instagram | `entry[0].messaging[0].sender.id` | `entry[0].messaging[0].message.text` |

In n8n expressions, these are commonly `{{$json.body.entry[0].changes[0].value.messages[0].from}}` for WhatsApp and `{{$json.body.entry[0].messaging[0].sender.id}}` for Instagram. If the webhook node's output does not have a `body` wrapper, remove `.body`. Some trigger nodes reshape the event, so use the JSON shown in that node's output to select the matching fields.

Pass the channel's sender ID unchanged on every message from that person. Do not use their display name or username as the ID.

### `sessionId`

For a website, generate a random ID on the visitor's first visit and store it in `localStorage` or `sessionStorage`. Reuse it on subsequent messages from that browser. The JavaScript example below uses `sessionStorage`.

For n8n WhatsApp/Instagram calls, `sessionId` is optional. The backend can resolve returning users from `channel` plus `channelUserId`, so you can leave it out. If you need the session message counter, create a stable session ID per sender, for example `wa_<WhatsApp sender ID>` or `ig_<Instagram sender ID>`, and send that same value every time. Prefix it with the channel to keep IDs distinct across platforms.

### Streaming response

For a streaming response, send `Accept: text/event-stream` and set `"stream": true` in the JSON body. The server emits `delta` events with partial `text`, followed by a `done` event containing the final `reply`, `buttons`, `cards`, `intent`, and `person`.

### JavaScript example

```js
const sessionId = sessionStorage.getItem('botSessionId') || crypto.randomUUID();
sessionStorage.setItem('botSessionId', sessionId);

const response = await fetch('<API_BASE_URL>/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    clientId: 'grapelabs',
    sessionId,
    message: 'What services do you offer?'
  })
});

const result = await response.json();
if (!response.ok || !result.success) throw new Error(result.error || 'Chat request failed');
console.log(result.reply, result.buttons, result.cards);
```

## `POST /api/chat` — n8n and server-side integrations

Use this endpoint when n8n receives a WhatsApp or Instagram webhook. n8n normalizes the incoming event, calls this API, then sends the returned reply to the user through the appropriate WhatsApp or Instagram action/node.

### Authentication

Set a strong `N8N_API_KEY` in the backend environment. Send that value with every request using either `x-api-key` or a Bearer token. Channel access tokens belong in n8n credentials, not in the request body.

### Request

`POST <API_BASE_URL>/api/chat`

Headers:

```http
Content-Type: application/json
x-api-key: <N8N_API_KEY>
```

Body for WhatsApp:

```json
{
  "clientId": "grapelabs",
  "channel": "whatsapp",
  "channelUserId": "15551234567",
  "message": "What services do you offer?"
}
```

Body for Instagram:

```json
{
  "clientId": "grapelabs",
  "channel": "instagram",
  "channelUserId": "INSTAGRAM_SENDER_ID",
  "message": "What services do you offer?"
}
```

`channel` must be `whatsapp`, `instagram`, or `web`. `channelUserId` must be the platform's stable sender ID; keep using the same ID for each person. Optional fields include `sessionId`, `personId`, `buttonPayload`, and `metadata`.

### n8n HTTP Request node

- Method: `POST`
- URL: `<API_BASE_URL>/api/chat`
- Authentication: add header `x-api-key` with the backend's `N8N_API_KEY`
- Send body as JSON, mapping `channel`, sender ID to `channelUserId`, and incoming text to `message`
- In the following WhatsApp or Instagram send node, map the response `reply` to the message text and use the original sender ID as recipient

## Response

Both endpoints return the same JSON response shape:

```json
{
  "success": true,
  "reply": "We build custom AI and automation systems...",
  "buttons": [],
  "cards": [],
  "intent": "faq",
  "extracted": {},
  "score_signals": [],
  "person": {
    "id": "person_...",
    "stage": "visitor",
    "score": 0,
    "name": null
  },
  "latencyMs": 850
}
```

Use `reply` as the message text. `buttons` and `cards` are optional channel-specific enhancements; send them only if your channel workflow supports them.

## Errors

- `400`: invalid or missing request fields
- `401`: missing or incorrect API key on `/api/chat`
- `503`: `N8N_API_KEY` is not configured on the backend
- `500`: the bot could not process the message

## Security and deployment

- Keep `N8N_API_KEY`, OpenAI credentials, and Firebase credentials in server-side environment variables.
- Keep WhatsApp and Instagram tokens in n8n credentials.
- Use HTTPS for deployed API requests.
- Do not put the `/api/chat` API key in browser JavaScript. Use `/chat` from a browser, or call `/api/chat` from a server-side workflow such as n8n.
