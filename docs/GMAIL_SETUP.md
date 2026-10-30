# Connecting Gmail

Danny reads your mail and drafts replies. He sends only after you tap **Send it** on a card. The connection can read and send. It cannot delete, archive, label or edit anything.

You make a Google "OAuth client" once, give its ID and secret to the server, then click **Connect Gmail** in Settings.

## 1. Create the Google client (about 10 minutes)

Google moves these screens around. If a name below differs, look for the nearest match.

1. Go to <https://console.cloud.google.com> and create a project (any name).
2. **APIs & Services > Library**: search for **Gmail API** and enable it.
3. **OAuth consent screen** (now called Google Auth Platform):
   - User type: **External**.
   - App name and support email: anything you recognise.
   - **Scopes**: add exactly these two and nothing else:
     - `https://www.googleapis.com/auth/gmail.readonly`
     - `https://www.googleapis.com/auth/gmail.send`
   - **Test users**: add the Gmail address you will connect.
4. **Credentials > Create credentials > OAuth client ID**:
   - Application type: **Web application**.
   - Authorized redirect URI: `https://YOUR-DOMAIN/v1/connections/google/callback`
     (for local testing, also `http://localhost:8787/v1/connections/google/callback`).
   - It must match `APP_URL` on the server exactly.
5. Copy the client ID and secret.

## 2. Give them to the server

In `.env` on the server:

```
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
```

Then `docker compose up -d` to restart. Settings now shows **Connect Gmail**.

## 3. Connect

Settings > Gmail > **Connect Gmail**. Google will warn that the app isn't verified (it is yours). Choose Advanced, then continue. **Leave both permissions ticked.** If you untick one, Danny refuses the connection and cancels it at Google, because he would only half work.

## Things to know

- **Seven-day expiry in Testing mode.** While the consent screen's publishing status is **Testing**, Google expires the login after about 7 days and Danny will ask you to reconnect. For personal use, set the status to **In production** (you still don't need to submit for verification; the "unverified app" warning stays). Check Google's current rules, as they change.
- **Offering this to other people.** Gmail's read and send permissions are "restricted" scopes. An unverified app is capped at 100 users, and going beyond that needs Google's app verification, which for these scopes includes a paid security assessment. That is a business decision for later, not something to do for yourself.
- **Disconnecting** in Settings deletes the saved login here and tells Google to cancel it. You can also remove Danny under your Google Account > Security > Third-party access.
- **Email text is untrusted.** Danny is told to treat what emails say as information, never as instructions, and he can't send anything on his own: every send is a card you read first. Still read the card.
- **What Anthropic's model sees.** When Danny searches or reads, the message text is sent to the model to answer you. Messages are cut to 6,000 characters. Attachments are listed by name only and are never opened.
