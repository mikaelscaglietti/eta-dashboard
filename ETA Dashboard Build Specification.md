# ETA Dashboard: Build Specification

Nov 1, 2026 · @Mikael

## Purpose

This spec tells Claude Code to build a web app that answers dealership lead emails within seconds, texts dealership staff, and gives the owner a dashboard to run it. It replaces an app built on Emergent. Rebuild it from scratch and reuse no Emergent code.

How to use this spec:

- Read all of it, plus the attached design file `lead-responder-console.html`, before writing code.
- Match the design file's look, wording, menu order, and behavior. Ignore its sample data and its simulated Google setup.
- Ask the owner about anything under Open questions. Do not guess.
- The owner is not a developer. Explain every choice in plain English, commit to git often, and write tests from the real sample emails.
- Keep all keys and tokens on the server. Start every dealership in test mode.

## The product in brief

The app answers every internet lead a dealership receives, instantly, so the CRM stops the lead's response clock. Speed is the product.

Each dealership has its own Google Workspace mailbox that receives lead notifications from its CRM. The app reads each notification, replies to the CRM's passthrough address with a branded HTML email containing real photos of the requested vehicle, and texts dealership staff.

In scope:

- Reading lead notification emails and extracting the customer, vehicle, VIN, and lead details.
- Sending the reply email through the dealership's own mailbox.
- Finding real vehicle photos by VIN on the dealership website and caching the links.
- Text alerts to dealership staff through Twilio.
- A dashboard to monitor leads, manage dealerships and templates, and pause sending.

Out of scope:

- Emailing customers directly. The reply always goes to the CRM passthrough address, never to the customer.
- Selling vehicles, marketing campaigns, or any CRM features beyond the reply.

## How a lead is handled

Every lead gets a reply at any hour, immediately. There is no business-hours delay.

1. **Detect.** Watch each active dealership's mailbox. A new email from `notify@eleadnotify.com` is an Elead lead notification. Other CRMs are listed under Integrations.
2. **Parse.** The Elead body is one run of `Label: value` pairs with no line breaks: dealership name, Vehicle wanted, Name, City, Phone, E-Mail, Trim, Comments. Comments holds the inquiry type, vehicle description, stock number, VIN, and a customer link. The subject holds the deal number and VIN. Any field can be missing, so the parser must cope with gaps. An email that does not look like a lead is skipped and raises an alert.
3. **Block duplicates.** One reply per deal number. A repeat notification never triggers a second reply or text.
4. **Choose the reply.**
   - VIN present and photos found: the full email with 1 to 3 photos.
   - VIN present but no photos found: the email without the photo block.
   - No VIN, or the vehicle is unavailable: the fallback email. It says the requested vehicle is unavailable and that someone from the dealership will contact the customer about options, and it lists similar vehicles.
   - Service, OnStar Service, or General Inquiry: a reply with no vehicle photos.
5. **Send.** Details are in the next list. The reply goes to the CRM, never to the customer.
6. **Text** dealership staff, as described under Text messages.
7. **Log** every step with a timestamp and the response time in seconds, so the dashboard can show what happened to each lead.

Sending rules, all required:

- **From:** the dealership's own mailbox, sent through the Gmail API.
- **To:** the dealership's CRM passthrough address only. If it is blank, refuse to send and raise an alert.
- **Subject:** the original subject copied exactly, including the double space before "New Customer", with ` Re:  ` added at the front. A test must fail if the subject is altered.
- **Threading:** set In-Reply-To and References to the original email's real Message-ID, and send into the original Gmail thread. The current app sets these to Gmail's internal ID instead, which is wrong.
- **Never send to `notify@eleadnotify.com`.** Enforce this in the sender, not only in settings.
- **Plain-text part:** write a clean plain-text version. The current app strips tags from the HTML, leaving a stray font-import line and words run together.

## The reply email

About 80 percent of the email is fixed per dealership and 20 percent changes per lead. Store the fixed parts once per dealership and fill in the rest for each lead.

| Part | Changes per lead | Fixed per dealership |
| --- | --- | --- |
| Greeting ("Hi Josh") | Yes |  |
| Year, model, trim of the vehicle | Yes |  |
| Up to 3 vehicle photos | Yes |  |
| Vehicle-specific links (Create Your Deal, Window Sticker) | Yes |  |
| Dealership logo and building photo |  | Yes |
| "Reasons to buy" list |  | Yes |
| Buttons: Schedule Test Drive, New Vehicle Warranty, Similar Vehicles, Pre-Owned Vehicles |  | Yes |
| No Bull Express link |  | Yes |
| Sales and service phone numbers, address, website, signature |  | Yes |

Rules:

- The dealership name, phone numbers, address, and website come from one stored record. Never type them into template text. The current app once showed "Chandler" in the body and "Scottsdale" in the signature.
- Use real photos of the exact vehicle, never stock images.
- Use web-safe fonts in the customer email, because many email apps ignore web fonts.
- A language model may write the greeting and the wording around the fixed template. If it is slow or fails, send the standard reply at once. See Integrations.

## Text messages

The owner's Twilio SMS compliance is already approved. Texts go out in real time whenever a lead is received.

- **Staff texts:** each lead sends a text to every staff number saved for that dealership. It names the customer's first name and the vehicle. The exact wording is an open question.
- **Customer texts:** an optional setting, off until the owner confirms it. See Open questions.
- **Opt-out:** handle STOP and START replies through a Twilio webhook, and never text a number that has opted out.
- **Test mode:** texts go only to the owner's phone, never to staff or customers.
- **Webhook security:** verify the Twilio signature on every incoming request.

## Vehicle photos and cache

Firecrawl searches the dealership's website for the lead's VIN and returns the photos of that exact vehicle. Photos are always available, but sometimes only one is found and very rarely none.

- **Look up by VIN.** Extract up to 3 photo links.
- **Cache the links, not the files.** Save the photo URLs for each VIN so a later lead for the same vehicle skips Firecrawl and saves credits. Never copy or store the image files, so the customer always sees the dealership's own photos.
- **Expiry.** A sold vehicle's page can disappear and break cached links. Give each cache entry an expiry date so it is re-checked. The length is an open question.
- **Failure.** If Firecrawl is slow, fails, or finds nothing, send the reply without the photo block. Never delay the reply waiting for photos.
- **Dashboard.** The Vehicle cache screen lists VINs, photo counts, last-scraped time, and how often each entry was reused, with refresh and remove actions.

## Dashboard screens

The design file shows every screen. Build them to match it. The left menu reads, in order: Incoming leads, Response log, Dealerships (with a Deactivated sub-item), Templates, Vehicle cache, Settings, Alerts. Menu labels and page titles are in capitals, under the title ETA DASHBOARD with a line beneath it. Use Barlow Condensed for all text in the dashboard.

| Screen | Purpose | Key behavior |
| --- | --- | --- |
| Incoming leads | What arrived today | Counter of leads received today, switching to one dealership's count when it is selected. Filters by dealership (active only), status, and search. Row opens the lead detail. |
| Response log | What was sent back | Search across customer, email, phone, vehicle, VIN, stock number, lead ID, dealership, lead type, and status. Dealership dropdown (active only) and the seven lead types. Counter of responses sent today. Eye icon opens a centered preview of the reply with left and right arrows through the filtered list; it closes only with its Close button. |
| Dealerships | Manage stores | List with CRM, mailbox, CRM passthrough address, Google status, and mode. Add dealership form. Deactivate button with confirmation. |
| Deactivated | Stores switched off | Lists deactivated stores with a Reactivate button. Their past leads stay in the logs. |
| Dealership page | Edit one store | Name, website, notification mailbox with Add account or Disconnect button, CRM dropdown, CRM passthrough address (required), phones, address, staff numbers, test mode. |
| Templates | Edit fixed email parts | Reasons to buy and buttons with a live preview using a sample lead or a fallback lead. |
| Vehicle cache | Saved photo links | Search by VIN only. Photo thumbnails open a larger view. Refresh, remove, and clear all. |
| Settings | App-wide controls | Collapsible sections of equal width: Safety, Conversational replies, Connections. |
| Alerts | Needs attention | Daily stats (leads today, average response time, failed), and a list of problems, each with a fix button and a Dismiss button. A red count badge sits on the menu item. |

Global behavior:

- **Pause and play.** At the bottom of the left menu, a status reads Live or Paused with a pause button and a play button. Pause opens a confirmation. While paused, a red banner shows on every screen and new leads are held, not answered. Live shows the play button glowing green. Paused shows the pause button glowing red.
- **Dropdowns** use the dashboard font, not the browser's default list.
- **Back links** are underlined with a left arrow.
- **Login.** The design file has no login. The real app needs one.

## Data to store

Claude Code should choose the exact tables. Store at least this.

| Record | What it holds |
| --- | --- |
| Dealership | Name, website, notification mailbox, CRM (one of eight), CRM passthrough address, sales and service phones, address, staff phone numbers, active or deactivated, test mode, Google connection status |
| Template | Per dealership: reasons to buy, buttons, logo, building photo, links, signature |
| Lead | Received time, dealership, customer first and last name, email, phone, city, vehicle year, make, model, trim, VIN, stock number, lead type, lead source, deal number, original subject, original Message-ID, raw notification text |
| Response | Lead, reply kind (full, no photos, fallback, non-vehicle), sent time, response time in seconds, status (replied, replied in test mode, held, failed), failure reason |
| Text message | Lead, recipient, staff or customer, sent time, delivery status |
| Vehicle cache entry | VIN, up to 3 photo URLs, last scraped, times reused, expiry |
| Alert | Dealership, severity, title, details, created, dismissed |
| Settings | Sending on or off, new stores start in test mode, duplicate blocking, customer texts, model provider, model ID, fallback timeout |

Security rules for the data:

- Google tokens, Twilio keys, Firecrawl key, and the AI key live only on the server, encrypted or in environment secrets. The browser sees at most the last four characters of a key.
- Customer names, emails, and phone numbers are personal data. Limit who can see them and keep them out of logs where possible.
- Keep past responses when a dealership is deactivated.

## Integrations

| Service | Use | Notes |
| --- | --- | --- |
| Google Workspace (Gmail API) | Read lead notifications and send replies from each dealership's mailbox | Each dealership has its own unique notification address. Add account runs a real Google sign-in for that address. Disconnect revokes the app's access and empties the mailbox field. Create a Google Cloud project and OAuth client owned by the owner. |
| Firecrawl | Find vehicle photos by VIN on the dealership website | The owner already has an account. Cache links. |
| Twilio | Staff and customer texts, STOP handling | SMS compliance is already approved. Verify webhook signatures. |
| Language model | Optional conversational wording | Provider and model are settings, not code. Start with OpenAI GPT-5.6 Luna and allow switching to Claude. Fallback timeout in seconds. |
| CRMs | Receive the reply at the passthrough address | Eight options: DealerSocket, DriveCentric, Elead, Ford Direct, ProMax, R&R, Tekion, VinSolutions. |

Google account rules:

- Each dealership's mailbox needs its own authorization. A separate sign-in is needed for each address unless the owner says some are aliases.
- Each reply must send as the dealership's address. Check that Gmail does not rewrite the From address.
- Provide a Send test button that replies as that address to a test inbox before a store goes live.

CRM rules:

- Only Elead is understood today. Its reply is matched by the subject line containing the deal number and VIN, and the reply goes to the passthrough address.
- Do not build other CRMs until the owner supplies a real lead notification and the reply that CRM accepts for each one. Until then, the CRM dropdown is a label.

Language model rules:

- The model may write the greeting and surrounding wording only. It never changes the subject, the recipient, or the fixed template parts.
- If the model is slow, fails, or its key is rejected, send the standard reply immediately and raise an alert.
- Show the model name, key status with the last four characters, and the count of failures in the last 24 hours in Settings. Keys are write-only in the dashboard.

## Safety and reliability

The app sends email and texts for real businesses, so these rules are required, not optional.

- **Test mode.** Every new dealership starts in test mode. Replies and texts go only to the owner until the store is switched live.
- **Pause with confirmation.** One control pauses all sending. Pausing needs a confirmation. While paused, leads are held, not lost, and the dashboard says how many. What happens to held leads on resume is an open question.
- **Duplicate protection.** One reply and one text set per deal number.
- **Loop protection.** An automatic reply must never trigger another automatic reply from the other side.
- **Required CRM address.** Refuse to send for a dealership with no passthrough address, and refuse `notify@eleadnotify.com` as one.
- **Rate limits.** Cap sends per minute so a bug cannot flood the CRM or phones.
- **Never block on slow services.** A slow photo lookup or model must never delay the reply. Send the simpler version.
- **Fast response.** Treat response time as the main measure. Log it for every lead and flag slow ones.
- **Don't lose leads on restart.** If the app restarts mid-lead, it resumes and finishes without double-sending.
- **Alerts** for failed sends, unreadable emails, expired Google sign-in, a rejected model key, and a disconnected mailbox.
- **Email and text law.** The owner is responsible for consent rules such as CAN-SPAM and CASL for emails, and Twilio opt-out handling for texts.

## Hosting, deployment, and updates

The production app runs on a managed host in accounts the owner owns. Claude Code runs on the owner's computer and only edits and publishes the project.

- **Stack.** Choose boring, popular tools. Recommend a simple stack and a managed host such as Railway, Render, or Fly.io, with a hosted Postgres database. Compare two or three hosts before choosing and check current pricing.
- **Always on.** Use a plan that never sleeps when idle. Instant replies are the product.
- **Code.** A private GitHub repository. The host rebuilds and restarts the app each time the owner publishes a change.
- **Secrets.** All keys and tokens in the host's environment settings, never in code or chat. Add `.env` to `.gitignore` first.
- **Address.** HTTPS only, on a custom domain the owner already controls, for example `dashboard.etarsp.com`.
- **Login.** Require a login for the dashboard from the first deploy.
- **Backups and logs.** Back up the database and keep logs so a failed lead can be found and replayed.
- **Two copies.** A test copy runs in test mode with a test mailbox and the owner's phone. Every change goes there first, then to production.
- **Safe updates.** A restart must not lose or double-send a lead. Deploy one change at a time, outside busy hours, and keep the ability to roll back to the previous version.
- **Never edit the live server by hand.** Every change goes through the project and git history.
- **Alerts.** Notify the owner if the app goes down.

Cutover from Emergent:

- Update every address that points at the old app: the Google sign-in return address and the Twilio webhook addresses.
- Run the new app in test mode beside Emergent and compare results on the same leads.
- Only one app may answer a dealership at a time, or every lead gets two replies.
- Move one dealership at a time, starting with a low-volume store, and keep Emergent available for one to two weeks.

## Build order

Build in small steps and test each one before the next. Start with one dealership and one lead source, Earnhardt Cadillac on Elead.

1. Project setup: git, secrets handling, a health-check page, and the dashboard login.
2. Database, dealership records, and the Dealerships screens with the required CRM address.
3. Real Google sign-in for one test mailbox, then reading a new email from it.
4. The Elead parser, with tests built from the real sample notification.
5. The reply builder and sender to a test inbox, with the exact subject, threading, and clean plain-text part.
6. Firecrawl lookup by VIN with the link cache.
7. Twilio staff texts and STOP handling, to the owner's phone only.
8. Safety controls: test mode, pause with confirmation, duplicate and loop protection, rate limits, and alerts.
9. The remaining screens: incoming leads, response log, templates, vehicle cache, settings, alerts.
10. The language model with its fallback timeout.
11. Deploy the test copy and run a lead end to end.
12. Pilot one live dealership beside Emergent, then move the others one at a time.
13. Other CRMs, only after the owner supplies real samples for each.

## Test samples and acceptance checks

The owner will supply more real notifications and replies, with customer details replaced by placeholders. This is the first sample, an Elead lead that came from Roadster for Earnhardt Cadillac. The customer details here are placeholders.

Notification received at `earnhardtcadillac@etarsp.com` from `notify@eleadnotify.com`. The subject has two spaces before "New Customer".

```text
Subject: Deal IN: 73127528  New Customer 1GYS9HK92VR133820

<> Earnhardt Cadillac Vehicle wanted: 2027 Cadillac Escalade Name: Alex Sample City: SAMPLE CITY Phone: (555) 555-0100 E-Mail: alex@example.com Trim: V-Series 4dr 4x4 Comments: Unlock Inquiry - Roadster Online; 2027 Cadillac Escalade-V V-Series - #C27099 - 1GYS9HK92VR133820; https://dealers.roadster.com/earnhardtcadillac/customers/12345678? utm_medium=eLead&utm_source=crm <>
```

Expected parse and reply:

| Item | Expected value |
| --- | --- |
| Customer first name | Alex |
| Vehicle | 2027 Cadillac Escalade, trim V-Series 4dr 4x4 |
| VIN | 1GYS9HK92VR133820 |
| Stock number | C27099 |
| Deal number | 73127528 |
| Lead source | Roadster, relayed by Elead |
| Reply from | `earnhardtcadillac@etarsp.com` |
| Reply to | `sales@earnhardtcadillac.edealerhub.com` (the Elead passthrough) |
| Reply subject | `Re: Deal IN: 73127528  New Customer 1GYS9HK92VR133820` |
| Cc, Bcc, Reply-To | None |
| Greeting | "Hi Alex," |
| Photos | Up to 3 photos of this VIN from the dealership website |
| Reply timing | Same minute the lead arrived |

Acceptance checks:

- The parser handles every field missing in turn without crashing.
- The subject of every reply equals the original with ` Re:  ` added, byte for byte.
- No reply ever goes to `notify@eleadnotify.com`, and none sends when the passthrough address is blank.
- The same deal number never produces two replies or two sets of texts.
- With no photos, no VIN, or a failed Firecrawl call, the correct simpler reply still goes out immediately.
- Test mode sends nothing to the CRM, staff, or customers.
- Pausing holds leads, and nothing is sent until sending resumes.
- A live test lead shows up in the Elead lead history through the passthrough address.

## Open questions

Ask the owner these before building the part they affect. Do not guess.

- [ ] **Lead types.** How does the app decide a lead is New Vehicle, New Vehicle (VIN), Used Vehicle, Used Vehicle (CPO), General Inquiry, Service, or OnStar Service? Which notification patterns map to each?
- [ ] **Lead ID.** The design uses the deal number as the lead ID. Is that what the owner searches by?
- [ ] **Customer texts.** Should the customer get a text as well as staff? What should each text say, and should texts wait until daytime?
- [ ] **Photo cache expiry.** How long should saved photo links stay before they are re-checked? The design suggested 30 days.
- [ ] **Other CRMs.** Which of the eight CRMs are in use besides Elead? The owner must supply a real notification and accepted reply for each.
- [ ] **Mailbox sign-in.** Is each dealership's notification address its own Google Workspace user, or are some aliases of another user? Does the Workspace admin need to approve the app?
- [ ] **Google project.** Does the owner own the Google Cloud project Emergent used, so its OAuth client can be reused, or is a new one needed?
- [ ] **Dealership groups.** Some groups list several brands under one name. Can one group have more than one mailbox, and are stores like Earnhardt Cadillac and Earnhardt Chandler Cadillac fully separate?
- [ ] **Dashboard users.** Is the dashboard for the owner only, or will dealership staff log in and see only their own store?
- [ ] **Language model.** Confirm GPT-5.6 Luna and check its current model ID and price on OpenAI's site. What exactly should the model write?
- [ ] **Held leads.** When sending resumes after a pause, should the app reply to held leads or skip them?
- [ ] **Reactivating a store.** Should a reactivated dealership return in test mode first?
