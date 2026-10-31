# Danny: what it really costs, what to charge, which promises are buildable

Researched Oct 31, 2026. Prices come from vendor pages where I could read them (Anthropic, ElevenLabs) and from third-party blogs where I could not (marked **unverified**). The per-turn token sizes are my assumptions: measure yours with the query at the bottom before you set a price.

## 1. The "$0.01 a request" is the meter, not the cost

The defaults in `apps/api/src/config.ts` (`PRICE_INPUT_PER_MTOK_USD=1`, `PRICE_OUTPUT_PER_MTOK_USD=5`) are **Haiku 4.5** prices. The default model is `claude-haiku-5-5`, and Anthropic's own [pricing page](https://platform.claude.com/docs/en/about-claude/pricing) lists it at:

| Model | Input | Cache read | Output |
|---|---|---|---|
| Haiku 5.5 (prompts up to 100k tokens) | $0.10 / MTok | $0.01 | $0.50 |
| Haiku 5.5 (prompts over 100k) | $0.50 | $0.05 | $2.50 |
| Sonnet 5.5 | $2 | $0.10 | $10 |
| Opus 5.5 | $4 | $0.20 | $20 |
| Haiku 4.5 (what the code charges) | $1 | $0.10 | $5 |

My estimate for one chat turn (two model calls, ~6k tokens in, ~400 out, half cached):

| | per turn |
|---|---|
| Real cost, Haiku 5.5 | **about $0.001** |
| What the meter shows (old prices) | **about $0.011** |
| Real cost, Sonnet 5.5 | about $0.02 |
| Real cost, Opus 5.5 | about $0.04 |

The meter overcounts about 10x. Two consequences:
- The $1/day free allowance buys about 10x more real usage than intended (roughly $0.10 of real spend).
- The build-direction PDF already warned that the `.env` prices "must be checked". Updating the defaults is a one-line change. I did not make it, because it changes how generous the free tier is. That is your call.

**The cost that is real is web search:** $10 per 1,000 searches ([Anthropic](https://platform.claude.com/docs/en/about-claude/pricing)), which is $0.01 each plus the result tokens (about $0.011 total on Haiku, $0.033 on Sonnet). That matches your `PRICE_SEARCH_USD`.

## 2. What each thing costs to run

| Action | Cost | Basis |
|---|---|---|
| Chat turn (Haiku 5.5) | ~$0.001 | above |
| Photo of a bill | ~$0.0004 Haiku, ~$0.007 Sonnet | ~1.6k image tokens + 400 out |
| Morning briefing with news | ~$0.024 / day (~$0.72 / mo) | 2 searches + tokens |
| One watched goal, checked 1x/day | ~$0.34 / mo | search-dominated |
| One watched goal, checked 4x/day | ~$1.36 / mo | search-dominated |
| Call mode, per minute | $0.02 to $0.04 | Scribe v2 Realtime $0.39/hr + Flash TTS $0.04 per 1k chars ([ElevenLabs](https://elevenlabs.io/pricing/api)) |
| Call mode, a 10-minute call | $0.22 to $0.39 | same |
| Voice typing | $0.0037 / min | Scribe v2 $0.22/hr |
| Outbound booking call, 4 min | **$0.34 to $0.94** | voice-agent platforms run $0.07 to $0.22/min all-in, plus Twilio about $0.014/min ([overview](https://zeeg.me/en/blog/post/vapi-ai-pricing), **unverified**; ElevenLabs Agents list $0.08/min plus LLM) |
| Flight booking | $3 per order, +1% of value with Managed Content, $2 per paid extra | [Duffel](https://duffel.com/pricing) |

### Per-user monthly cost (Haiku by default, Sonnet on the hard turns)

| User | What they do | Cost / month |
|---|---|---|
| Light | 8 turns/day, 1 goal, briefing, 10 min voice | **$2.11** |
| Typical | 25 turns/day, 2 goals, briefing, 30 min voice, 2 booking calls, 10 photos | **$7.13** |
| Heavy | 80 turns/day, 5 goals at 4x/day, 120 min voice, 6 booking calls, 30 photos | **$28.86** |

Watched goals are the biggest line for a heavy user, then chat, then voice.

## 3. What to charge

**Anchors.** The $4,000/mo figure is not confirmed by anything I found. Search results put a managed offshore full-time assistant at about $1,600 to $3,000/mo and a US executive assistant up to about $8,000/mo (vendor blogs, **unverified**). Consumer AI assistants sit at about $15 to $50/mo, and Lindy lists $50 to $200 (also **unverified**, sources conflict). You are not competing with the $4,000. You are competing with having no assistant, and with $20 chatbots.

**Suggested ladder** (my numbers, test them):

| Plan | Price | Includes | Real cost | Margin |
|---|---|---|---|---|
| Free | $0 | small daily allowance, no phone calls | cap real spend at ~$0.05 to $0.10/day | n/a |
| Danny | **$20/mo** | chat, memory, repeats, briefings, 2 goals, voice typing, 30 min of calls | Typical $7, Light $2 | ~60% after payment fees |
| Danny Plus | **$60/mo** | Sonnet as the default, 5 goals, 10 booking calls, photo bills, forwarded mail | ~$20 to $29 | ~50% |
| Danny Concierge | **$200/mo** | Opus on hard turns, 30 booking calls, trips, home control, priority | ~$60 to $90 | ~55% |

Rules that keep it profitable:
1. **Monthly credits, not just a daily cap.** Your daily cap is a good safety net. Add a monthly allowance per plan and let people top up.
2. **Price the expensive actions on their own.** Phone calls cost $0.34 to $0.94. Charge about $1.50 to $2 per call beyond the included ones. Flights: pass through Duffel's $3 and add your own fee.
3. **Throttle searches.** Default watched goals to once a day and make 4x/day a paid option.
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

Reading Gmail needs Google's restricted-scope review, which includes an annual third-party security assessment, estimated at **$15,000 to $75,000** ([Truto](https://truto.one/google.md), [GMass](https://www.gmass.co/blog/google-oauth-verification-security-assessment/), **third-party estimates**; I found no 2026 figure from Google). At $20/mo and about $17.50 of margin per subscriber, that is **72 to 357 paying users** just to cover one year. That is the reason to build forward-to-Danny first and keep Gmail connect for you and early testers.

## 6. Order I would build (cheapest value first)

1. Fix the meter defaults and add monthly credits per plan.
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

Recompute section 2 with your real `avg_in` and `avg_out` before setting a price. `input_tokens` may not include cached tokens, so `avg_in` can understate the true prompt size; check how `recordSpend` is called before trusting it.
