# VoyageDesk AI v0.3.3

Travel-advisor MVP with AI itinerary generation, live flight/hotel provider adapters, external booking links, saved trips, and branded print/PDF proposals.

## v0.3.3 — Improved Proposal Photos

- Proposal photos use a taller 3:2 travel-magazine frame instead of a shallow fixed-height crop.
- Photos still use `cover` for a polished edge-to-edge look.
- New focal-point controls let the advisor move the visible crop up, down, left, right, or back to center.
- The chosen focal point is stored with the trip and reused when the trip is reopened.
- Print/PDF output uses the same focal point and 3:2 framing as the on-screen proposal.


## Run on Windows PowerShell

```powershell
$env:OPENAI_API_KEY="YOUR_OPENAI_KEY"
npm.cmd start
```

Open http://localhost:3000

## Enable live flights and hotel pricing

Create Amadeus for Developers credentials, then set them in the same PowerShell window before starting the app:

```powershell
$env:AMADEUS_API_KEY="YOUR_AMADEUS_KEY"
$env:AMADEUS_API_SECRET="YOUR_AMADEUS_SECRET"
$env:AMADEUS_ENV="test"
npm.cmd start
```

The prototype uses Amadeus Self-Service APIs as the first live inventory adapter. Test inventory can differ from production. Production use requires the provider's production access and commercial terms.

## Branded PDFs

Open **Branding**, add agency details and an optional logo URL, then open a proposal and select **Export Branded PDF**. In the browser print dialog select **Save as PDF**.

## Booking links and commissions

The proposal includes Expedia, Booking.com, and Google Flights outbound search links. These are ordinary search links in v0.2. They do **not** earn commission by themselves. After an affiliate/agency account is approved, replace or wrap them with the tracking/deep-link format supplied by that partner.

## Important

Live prices and availability can change until booked. Do not represent a search result as a confirmed reservation. Affiliate relationships should be disclosed where required.

## v0.2 branding/editor update
- Upload/change/remove an agency logo from the left sidebar or Branding screen.
- Logo is stored locally in the browser and appears in the proposal/PDF header.
- Agency name, advisor, email, phone, website, address, and tagline can be customized.
- Proposal title, Introduction, and Budget Note are directly editable after AI generation.
- Manual edits sync into Save Trip and Export Branded PDF.


## v0.2.4 additions
- Smart city autocomplete distinguishes city, region/state, and country (for example London, England, UK vs London, Kentucky, US).
- Airport/city-code autocomplete accepts either a city name or IATA code and offers metro codes plus individual airports.
- Selecting a departure or destination city auto-fills sensible IATA/city-code defaults while remaining editable.


## v0.2.4 language and currency
- Proposal language is independent from pricing currency.
- Agents can save default language and currency in Branding settings.
- Per-trip language can be English, Spanish, Turkish, Hebrew, French, German, Italian, Portuguese, Arabic, or a custom language.
- Currency includes common travel currencies plus a custom 3-letter code.
- AI Translate translates an existing proposal without rebuilding the trip.


## v0.2.5 changes
- Fast vs Detailed AI generation mode.
- Fast mode uses lower reasoning effort and lower verbosity for quicker routine proposals.
- Generation and translation stream progress to the browser so the UI responds immediately.
- Budget entry automatically groups thousands using Anglo-American formatting (for example 5,000 and 12,500.50).
- Proposal prompts preserve comma thousands separators and period decimals across supported currencies and translations.


## v0.2.6 destination photos
Set `PEXELS_API_KEY` to enable automatic destination photos. Each itinerary day can show one landscape photo from Pexels, with controls to change/remove it or upload an advisor-owned image. Pexels attribution and photographer credit are displayed for API-sourced images.


## v0.3 — Agent accounts, cloud trips, and Clients

VoyageDesk can now run in two storage modes:

- **Local development mode**: if Supabase is not configured, the prototype continues using `data/trips.json`.
- **Private cloud mode**: set `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`. Agents then sign up/sign in, and Trips, Clients, and Agency Branding are stored in Supabase with Row Level Security.

### One-time Supabase setup

1. Create a Supabase project.
2. Open **SQL Editor** and run the included `supabase-setup.sql` file.
3. From the project's Connect/API settings, copy the project URL and publishable key.
4. In PowerShell, before starting VoyageDesk:

```powershell
$env:SUPABASE_URL="https://YOUR-PROJECT.supabase.co"
$env:SUPABASE_PUBLISHABLE_KEY="YOUR-PUBLISHABLE-KEY"
$env:OPENAI_API_KEY="YOUR-OPENAI-KEY"
$env:PEXELS_API_KEY="YOUR-PEXELS-KEY"
npm.cmd start
```

Do not put a Supabase service-role/secret key in the browser. This version uses the publishable key plus each signed-in agent's JWT, with database RLS policies limiting rows to that user.

### v0.4 preparation

The trip JSON structure remains extensible for live inventory selections and fields such as `pricingLastCheckedAt`. The planned v0.4 workflow is **Search Live Prices → select flight/hotel → Save Draft → Refresh Prices**.


## v0.3.2 — Password recovery

VoyageDesk now provides its own **Forgot password?** flow. Agents request a Supabase recovery email from the VoyageDesk sign-in screen. When the recovery link returns to VoyageDesk, the app recognizes the recovery access token and displays **Reset Your Password** instead of the normal login form.

The server also trims `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`, preventing accidental copied spaces from breaking authentication.

## Easy Windows startup (v0.3.3)

VoyageDesk now includes **Start VoyageDesk.bat** so you do not need to re-enter PowerShell environment-variable commands every time.

### First time only
1. Double-click **Start VoyageDesk.bat**.
2. VoyageDesk creates a private `.env` file and opens it in Notepad.
3. Paste your Supabase, OpenAI, and Pexels values into the matching lines. Amadeus is optional and can stay blank.
4. Save the file and close Notepad.

### Every time after that
Double-click **Start VoyageDesk.bat**. The server starts and `http://localhost:3000` opens automatically.

**Security:** Keep `.env` private. It is excluded by `.gitignore` and should never be emailed, uploaded, or included in a shared ZIP.
