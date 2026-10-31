# Danny: what it really costs, what to charge, which promises are buildable

Researched Oct 31, 2026. Prices come from vendor pages where I could read them (Anthropic, ElevenLabs) and from third-party blogs where I could not (marked **unverified**). The per-turn token sizes are my assumptions: measure yours with the query at the bottom before you set a price.

## 1. Yes, Haiku 5.5 is cheaper, and your meter does not know it

Anthropic's own [pricing page](https://platform.claude.com/docs/en/about-claude/pricing), per million tokens (MTok):

| Model | Input | 5-min cache write | Cache read | Output |
|---|---|---|---|---|
| **Haiku 5.5** (prompts up to 100k tokens) | **$0.10** | $0.125 | $0.01 | **$0.50** |
| Haiku 5.5 (prompts over 100k) | $0.50 | $0.625 | $0.05 | $2.50 |
| Sonnet 5.5 | $2 | $2.50 | $0.10 | $10 |
| Opus 5.5 | $4 | $5 | $0.20 | $20 |
| Haiku 4.5 | $1 | $1.25 | $0.10 | $5 |

Haiku 5.5 is **10x cheaper than Haiku 4.5** on every line. The defaults in `apps/api/src/config.ts` (`PRICE_INPUT_PER_MTOK_USD=1`, `PRICE_OUTPUT_PER_MTOK_USD=5`) are the Haiku 4.5 prices, while the default model is `claude-haiku-5-5`. The meter therefore charges about 10x what a request really costs. Cache multipliers (read 0.1x, write 1.25x) are the same for both, so the ratio holds on every request.

## 2. The math

### 2.1 What a request is made of (measured from the code)

Every model call sends the same fixed prefix, then the new part:

| Piece | Size | Source |
|---|---|---|
| System prompt | 4,107 characters | `SYSTEM` in `brain/run.ts` |
| 29 tool definitions as JSON | 19,576 characters | `registry.definitions()` |
| Formatting rules | ~1.5k characters | `lib/format.ts` (estimate) |
| **Fixed prefix** | **~25,000 characters = 6,300 to 8,300 tokens** | at 4.0 to 3.0 characters per token |

On top of that come pinned memory and a stable history window (the code moves the window in steps of 20 so the cache keeps hitting). I round the cached part to **C = 8,000 tokens**.

Variables I use below (assumptions, except C):

| Symbol | Meaning | Value |
|---|---|---|
| C | cached prefix tokens | 8,000 |
| U | fresh tokens per call (new message, tool results, clock) | 1,200 |
| O | output tokens per call | 300 |
| K | model calls per chat turn (tool call, then reply) | 1.8 |
| f | share of turns that start a new 5-minute cache window | 20% |

### 2.2 Formulas

With per-MTok prices *in*, *write*, *read*, *out*:

```
warm call  = ( C x read  + U x in + O x out ) / 1,000,000
cold call  = ( C x write + U x in + O x out ) / 1,000,000     (first call after the cache expired)
warm turn  = K x warm call
cold turn  = cold call + (K - 1) x warm call
turn       = (1 - f) x warm turn + f x cold turn
```

Worked example, Haiku 5.5: warm call = (8,000 x 0.01 + 1,200 x 0.10 + 300 x 0.50) / 1e6 = 0.00008 + 0.00012 + 0.00015 = **$0.00035**. Cold call = (8,000 x 0.125 + 120 + 150) / 1e6 = **$0.00127**. Warm turn = 1.8 x 0.00035 = $0.00063. Cold turn = 0.00127 + 0.8 x 0.00035 = $0.00155. Blended = 0.8 x 0.00063 + 0.2 x 0.00155 = **$0.00081**.

### 2.3 Cost of one chat turn

| Model | Warm call | Cold call | **Blended turn** |
|---|---|---|---|
| **Haiku 5.5** | $0.00035 | $0.00127 | **$0.0008** |
| Sonnet 5.5 | $0.0062 | $0.0254 | **$0.0150** |
| Opus 5.5 | $0.0124 | $0.0508 | **$0.0300** |
| What the meter charges (Haiku 4.5 prices) | $0.0035 | $0.0127 | **$0.0081** |

That last row is your "$0.01 a request". Real cost on Haiku 5.5 is **$0.0008**, exactly 10x less. Sonnet is about 19x Haiku 5.5.

Sensitivity (blended turn):

| Change | Haiku 5.5 | Sonnet 5.5 |
|---|---|---|
| Prefix C = 4,000 | $0.00065 | $0.0124 |
| **Measured, C = 8,000** | **$0.00081** | **$0.0150** |
| Prefix C = 14,000 | $0.00106 | $0.0190 |
| Longer replies, O = 800 | $0.00126 | $0.0240 |
| Tool-heavy turn, K = 4 | $0.00158 | $0.0286 |
| Cache never hits (f = 100%) | $0.00155 | $0.0304 |

The worst case on Haiku is still under two-tenths of a cent. **Caching matters most on Sonnet:** a cold Sonnet call costs 4x a warm one.

### 2.4 What the free allowance really is

The $1/day meter allowance buys 1 / 0.0081 = **about 122 chat turns**. Those 122 turns cost you 122 x 0.0008 = **about $0.10** in real money. If you fix the prices, either the same $1 buys 10x more turns, or you cut the free cap to about $0.10 of meter and keep today's behaviour.

### 2.5 Everything that is not a chat turn

| Action | Formula | Cost |
|---|---|---|
| One web search (Haiku) | $0.01 + (10,000 result tokens x $0.10 + 300 x $0.50) / 1e6 | **$0.0112** (Sonnet: $0.033) |
| Morning briefing | 2 searches + 1 warm call | $0.0226 a day, **$0.68 a month** |
| Goal check | 1 search + 1 warm call | $0.0115 each: **$0.34 a month at 1x/day, $1.38 at 4x/day** |
| Evening wrap-up | 1 chat turn, no search | $0.0008 a day |
| Call mode, per minute | STT $0.39/hr / 60 + TTS $0.04 per 1k chars x chars spoken + 3 chat turns | $0.0065 + $0.016 to $0.032 + $0.0024 = **$0.025 to $0.041** ([ElevenLabs](https://elevenlabs.io/pricing/api)) |
| Call mode, 10 minutes | | **$0.25 to $0.41** |
| Voice typing | $0.22/hr / 60 | $0.0037 per minute |
| Photo of a bill | 1 chat turn + 1,600 image tokens | $0.0010 on Haiku, $0.018 on Sonnet |
| Outbound booking call, 4 min | 4 x (platform $0.07 to $0.22 + Twilio $0.014) | **$0.34 to $0.94** ([voice-agent pricing](https://zeeg.me/en/blog/post/vapi-ai-pricing), **unverified**) |
| Flight booking | $3 + 1% of value (Managed Content) + $2 per paid extra | [Duffel](https://duffel.com/pricing) |

### 2.6 Per-user cost per month

| | Light | Typical | Heavy |
|---|---|---|---|
| Chat turns a day | 8 | 25 | 80 |
| Share on Sonnet | 0% | 15% | 25% |
| Watched goals x checks a day | 1 x 1 | 2 x 2 | 5 x 4 |
| Voice minutes a month | 10 | 30 | 120 |
| Booking calls a month | 0 | 2 | 6 |
| Bill photos a month | 3 | 10 | 30 |
| **Chat** | $0.20 | $2.21 | $10.47 |
| **Goals** | $0.34 | $1.38 | $6.90 |
| **Briefing + wrap-up** | $0.70 | $0.70 | $0.70 |
| **Voice** | $0.33 | $0.99 | $3.95 |
| **Booking calls** | $0 | $1.07 | $3.22 |
| **Photos** | $0 | $0.18 | $0.55 |
| **Total** | **$1.58** | **$6.53** | **$25.78** |

Two things jump out:
- **Chat on Haiku is almost free** (750 turns a month is about $0.60). In the Typical column, the 15% of turns routed to Sonnet cost $1.69 of the $2.21 chat total. **Routing is the biggest lever you have.** Use Haiku by default and Sonnet only when a turn needs it.
- After that, the costs are **watched goals** (search-driven), **voice** and **phone calls**. Those are what to meter and price separately.

## 3. What to charge

**Anchors.** The $4,000/mo figure is not confirmed by anything I found. Search results put a managed offshore full-time assistant at about $1,600 to $3,000/mo and a US executive assistant up to about $8,000/mo (vendor blogs, **unverified**). Consumer AI assistants sit at about $15 to $50/mo, and Lindy lists $50 to $200 (also **unverified**, sources conflict). You are not competing with the $4,000. You are competing with having no assistant, and with $20 chatbots.

**Suggested ladder** (my numbers, test them):

Payment fees assumed at 2.9% + $0.30 per charge (from memory: check your Stripe rate). Net of that, margin = (price after fees - cost) / price after fees.

| Plan | Price | Includes | Real cost | Margin |
|---|---|---|---|---|
| Free | $0 | small daily allowance, no phone calls, Haiku only | cap real spend at about $0.10/day | n/a |
| Danny | **$20/mo** | Haiku by default, memory, repeats, briefings, 2 goals, voice typing, 30 min of calls | Light $1.58, Typical $6.53 | **66% at Typical** |
| Danny Plus | **$60/mo** | Sonnet as default (about 40 turns/day), 5 goals, 10 booking calls, bill photos, forwarded mail | about $28 | **about 51%** |
| Danny Concierge | **$200/mo** | Opus on hard turns, 30 booking calls, 300 voice minutes, trips, home control | about $65 | **about 67%** |

Check on the $20 plan: a Heavy user costs $25.78 against $19.12 net, so **-35%**. That is why it needs limits (turns on Sonnet, goal checks, booking calls), not just a price.

Rules that keep it profitable:
1. **Monthly credits, not just a daily cap.** Your daily cap is a good safety net. Add a monthly allowance per plan and let people top up.
2. **Price the expensive actions on their own.** Phone calls cost $0.34 to $0.94. Charge about $1.50 to $2 per call beyond the included ones. Flights: pass through Duffel's $3 and add your own fee.
3. **Throttle searches and Sonnet.** Default watched goals to once a day and make 4x/day a paid option. Route to Haiku unless a turn needs more.
4. **Sell on web, not in the app store.** Danny is a PWA, so you can take cards with Stripe and skip Apple's cut. Apple has asked a court for 15% on link-outs (10% on subscription renewals) and the court has not ruled ([MacRumors](https://www.macrumors.com/2026/08/13/app-store-fees-apple-link-outs/), [Subscription Insider](https://www.subscriptioninsider.com/blog/apple-proposes-15-year-one-link-out-fee-10-on-subscription-renewals)). This matters the day you ship native apps.

**The $4,000 line.** At $200/mo you are still 20x cheaper than the anchor. The promise on the page can stay big, and the price can stay small.

## 4. Which promises are buildable today

| Promise | Verdict | Why |
|---|---|---|
| Read a bill from a photo | **Yes, easy** | Claude vision; fractions of a cent |
| Forward an email to Danny | **Yes** | Inbound email parsing; no Google review needed |
| Ring to book | **Yes, with work** | Twilio + a voice agent stack exists. Check recording and AI-disclosure rules with a lawyer before you launch it |
| Flights | **Yes** | Duffel has a free sandbox and pay-per-booking pricing. Hotels: Duffel Stays shows a profit share but I found no published number |
| Smart home | **Yes, for people who run Home Assistant** | REST and WebSocket APIs; remote access needs the user's own tunnel or a Nabu Casa subscription (price **not verified**). Google's [Home APIs](https://developers.googleblog.com/en/building-a-better-smart-home-expanding-access-for-developers-and-users/) are in public beta, Android first, with a stated risk Google pulls access |
| Build the grocery cart | **Partly** | Instacart's public API hands back a link; reading catalogs, prices or orders needs partner approval ([docs](https://docs.instacart.com/developer_platform_api/)). "He builds it, you tap to buy" is honest |
| Fill in forms | **Yes, but it is engineering, not an API** | PDF filling and a good prompt |
| Find forgotten subscriptions | **Yes via receipts and uploaded statements; harder via banks** | Plaid's recurring-transactions product needs approval and a per-connected-account fee. The only figure I found (about $0.30 per account per month) is anecdotal ([Plaid billing](https://plaid.com/docs/account/billing)) |
| Cancel a subscription | **No API exists** | Draft the email or open the cancel page for the user's tap |
| Pay bills for you | **No universal API** | Remind and prepare |
| Haggle a price down by phone | **Shaky** | Possible as a call script, not reliable |
| Book restaurants | **Not by API** | [OpenTable and Resy](https://supergood.ai/api-report-card/opentable) are partner-gated (sources: third-party, **unverified**). Phone calling is the fallback |

## 5. The Google fee you can avoid for now

Reading Gmail needs Google's restricted-scope review, which includes an annual third-party security assessment, estimated at **$15,000 to $75,000** ([Truto](https://truto.one/google.md), [GMass](https://www.gmass.co/blog/google-oauth-verification-security-assessment/), **third-party estimates**; I found no 2026 figure from Google). At $20/mo and about $12.60 of margin per Typical subscriber ($19.12 net minus $6.53 cost), that is **about 100 to 500 paying users** just to cover one year ($15,000 / ($12.60 x 12) = 99; $75,000 / ($12.60 x 12) = 496). That is the reason to build forward-to-Danny first and keep Gmail connect for you and early testers.

## 6. Order I would build (cheapest value first)

1. Fix the meter defaults (Haiku 5.5: $0.10 in, $0.50 out), route turns to Haiku by default, and add monthly credits per plan.
2. Photo-of-a-bill.
3. Forward-to-Danny email.
4. Lists and richer repeats.
5. Phone booking (behind approval cards, with per-call credits).
6. Instacart link carts, then Duffel flights.
7. Home Assistant connector.

## Measure your real numbers

```sql
-- Real tokens per request, and what the meter charged.
-- Run as the database owner role: spend_ledger has forced row-level security, so the app role sees nothing without a workspace.
select model,
       count(*)                                  as calls,
       round(avg(input_tokens))                  as avg_in,
       round(avg(output_tokens))                 as avg_out,
       round(avg(cost_micros) / 1e6, 5)          as avg_metered_usd
from spend_ledger
where day >= current_date - 14
group by model;
```

Plug your real `avg_in` and `avg_out` into the section 2.2 formulas (they replace C + U and O) before setting a price. `input_tokens` may not include cached tokens, so `avg_in` can understate the true prompt size; check how `recordSpend` is called before trusting it.
