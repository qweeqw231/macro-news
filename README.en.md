# Macro News · 宏观资讯台

[中文](README.md) | English

Automated collection and archive of global macro news: **rates · FX · policy · commodities · A-shares / HK & US equities**.

| | |
|---|---|
| Site | **https://qweeqw231.github.io/macro-news/** |
| Form | Pure static site (GitHub Pages) + scheduled collection writing JSON; **no server / database needed** |
| Data scale | **70 quote instruments** (26 indices + 32 on-exchange ETFs + 12 portfolio), 5 macro indicators, 8 news sources |
| Frontend | Vanilla JS + hand-drawn Canvas K-lines, zero dependencies |

**Reading guide**: §1 is the global map; §2–3 are **specifications (facts)**; §4 is the data contract; §5–7 cover usage / deployment / troubleshooting; **design rationale is concentrated in §8** and kept apart from operational steps. History and abandoned approaches are at the end.

---

## 1. What it is

The site has four tabs (top on desktop/tablet, bottom on phones):

| Tab | Content |
|---|---|
| Headlines | Search + channel filters + latest news (default view) |
| Markets | Quote cards for 70 instruments, searchable by name / code / English abbreviation; click a card to open the K-line drawer |
| Archive | Lists item counts by day; click a day to see everything for that day |
| Sources | Status / item count / elapsed time / errors for the 8 news sources |

The collection summary (last collection time / new items / quote items / total in the database) is rendered in the **footer** and stays visible in every view.

### Multi-device and responsive layout

| Width | Navigation | Layout |
|---|---|---|
| ≤640px (phone) | Only the logo stays at the top; **four tabs fixed at the bottom** | Quote cards in 2 columns; K-line/reader bottom drawer; periods and moving averages each in a horizontally scrolling row |
| 641–900px (tablet) | Four tabs at the top | Quote cards in 3–4 columns |
| >900px (desktop) | Four tabs at the top | Quote cards in 4–5 columns |

- Verified on real pages at five widths — **320 / 390 / 430 / 768 / 1024** — with no horizontal overflow.
- Notched screens / bottom gesture bars: `viewport-fit=cover` + `env(safe-area-inset-top/bottom)`.
- The bottom navigation stays fixed on phones (no hamburger drawer); the K-line canvas height is `min(340px, 42vh)`, so small screens do not lose it to the buttons.
- Phone K-line gestures: **one-finger drag to pan / two-finger pinch to zoom (anchor = midpoint of the two fingers) / double-tap to return to latest / single tap for details**; the canvas uses `touch-action:none`, so zooming does not scroll the page. Desktop still uses drag, ←→, wheel, and Ctrl+±.
- The gesture hint at the bottom-left of the canvas switches by pointer type: on touch it only says "one-finger drag · two-finger zoom" and never mentions "wheel / Ctrl".
- Landscape / short windows (height ≤560px): the K-line canvas is compressed to 200px and the modal scrolls; when a phone in landscape is wider than 640px it uses the top tabs.
- The search placeholder switches by width: ≤640px uses a short version (so the placeholder is not truncated); desktop uses the full version.

---

## 2. Data pipelines (read this first)

Collection is split into five automatic pipelines (the briefing and history slices are covered in §2.6 / §2.7). **They write different files and never overwrite each other**; `quotes.json` is written only by pipeline ①.

| # | Pipeline | What runs it | Frequency | Writes |
|---|---|---|---|---|
| ① | **News + quotes** | GitHub Actions `collect.yml` (triggered externally by the Cloudflare Worker) | 15 minutes | `data/archive/`, `latest.json`, `search.json`, `quotes.json` |
| ② | **K-lines** | Actions `kline-full.yml` / `kline-minute.yml` | Full run daily at 12:23; last bar hourly | `data/kline/` |
| ③ | **Point-in-time snapshots** | Actions `snapshot.yml` (Worker triggers every 30 minutes, backfills 5 days) | 30 minutes | `data/snapshots/` |
| ④ | **Macro indicators** | Actions `snapshot.yml` (idempotent top-up for the current day after 17:00) | Every trading day | `data/macro/daily.json`, `kline/cgb_1y*` |
| ⑤ | **Local fallback / sync** | Windows scheduled tasks `MacroNews-Collect` / `MacroNews-Pull` | 120 minutes / 4 hours | Local `data/` (fallback collection, pull remote) |

```
                      ┌──────────────────── Pipeline ① every 15 minutes ────────────────────┐
Cloudflare Worker ──> │ collect.yml → collect.mjs                                           │
(external cron)       │   news + 53 instrument quotes + 6 portfolio quotes                  │──> commit/push
                      └─────────────────────────────────────────────────────────────────────┘
                      ┌──────────────────────── Pipeline ② K-lines ─────────────────────────┐
                      │ kline-full.yml    full daily/weekly/monthly K at 12:23              │
                      │ kline-minute.yml  hourly minute K + last daily bar                  │──> commit/push
                      └─────────────────────────────────────────────────────────────────────┘
                      ┌────────────────── Pipeline ③ snapshots + ④ macro ───────────────────┐
GitHub Actions ──────>│ snapshot.yml (snapshot fallback + 5-day backfill)                   │
Cloudflare Worker ──> │ after 17:00: collect-macro-if-due.mjs (idempotent)                  │──> commit/push
                      └─────────────────────────────────────────────────────────────────────┘
```

### 2.1 Pipeline ①: news + quotes (every 15 minutes)

- **Trigger**: Cloudflare Worker Cron → GitHub `workflow_dispatch` (the in-repo `schedule` is only redundancy).
- **Action**: `node src/collect.mjs --no-kline`
- **Quotes**: Eastmoney `ulist.np` fetches all **59** instruments in one batch (26 indices + 32 ETFs + Nasdaq 100);
  portfolio quotes are filled in by `fetchPortfolioQuotesFast`: `xau/xag/brent` refresh every round
  (since 2.7.0 the front end also calls Tencent `hf_*` directly, so their cards can show "live"),
  `sge_au9999` fetches Eastmoney `118.AU9999` every round while trading (day 09:00-15:30, night 20:00-02:30),
  then adopts the official SGE daily quote once after the 15:30 close (2.6.0);
  `usdcny/cgb_1y` refresh only at publication times (09:15 / 17:00) and only when the stored value is not from today.
- **News**: 8 sources fail independently; items are first deduplicated idempotently by `id`, then by the 2.4.5 "same-story merge" rules:
  same `url`, or same source + same time + same body/title ⇒ keep only one; channels are resolved by specificity
  `A-shares/China > domestic finance > FX/commodities/US equities > global`, and within the same channel the longer body wins.
  When writing the archive, the merge runs again over "new this round + existing items", so duplicate cross-channel entries in old data heal on the next collection. The archive is written by day; `latest.json` holds the latest 200 items (first screen),
  and `search.json` holds the search index for the latest 62 days (title/source/time/link only, no summary/full text).
  Archive keys are **news days** (Beijing 08:00 → next 08:00, i.e. the UTC date) — not calendar days; the archive page says so explicitly,
  and briefings and snapshots share the same key. See [docs/day-boundary.md](docs/day-boundary.md) for every object's day boundary
  (including what the 09:00 briefing actually covers, the search window, why K-lines are unrelated, and where the 320 legacy items came from).
  **Per-day archive cap 1800 (2.12.0; 1600 since 2.11.0; 800 since 2.4.21; 1800 is a temporary value, to be finalized after 5–7 trading days of measurement)**: the four official sources keep at most 40 items first (China News Service and other `kind:official` entries are not counted), then the macro channels (domestic finance/global/FX/commodities/US equities) keep another 120, and the rest are filled in `ts` descending order (ordinary bucket: 1640);
  official sources with `windowed:false` only take the latest 7 days, so old items are not pulled back.
  **Capping is never silent (2.12.0)**: whenever a round evicts items, `_last-run.json` records `news.capped: true` and `news.evicted`, the collector logs `⚠ cap hit`, and the footer health lamp shows "archive capped · N evicted".
- **Titles (2.4.6)**: a flash item without its own title takes the **first complete sentence** of the body and stores it whole in `title`, no longer hard-truncating at 40 characters;
  when a short version is needed it breaks only at punctuation boundaries (`。！？；` → `，、`) and appends `…`; if no punctuation is found it returns the full text.
  The frontend `.item-title` uses `-webkit-line-clamp: 2` for multi-line ellipsis and does no character truncation.
  Historical data can be backfilled from `content` with `node scripts/repair-archive.mjs` (idempotent).
- **RSS time (2.4.8)**: `pubDate` with a time zone (`Z` / `±HH:MM` / `GMT`) is parsed as-is;
  one without a time zone (e.g., the NBS `2026-11-04 09:30:00`) is interpreted using the source `tz` (Chinese sources default to
  `Asia/Shanghai`), **not the runner's local time zone**. Historical offsets can be backfilled with
  `node scripts/repair-nbs-time.mjs --apply`: only entries that differ by exactly +480 minutes from the NBS original page's
  `<meta name="PubDate">` are fixed; other differences are left alone.
- **PBOC time (2.5.0)**: the list page only exposes a date; collection now uses the 14-digit
  `YYYYMMDDHHMMSS` in the detail-page URL (interpreted as `+08:00`) as the real publish time,
  and falls back to the date if parsing fails. Historical wrong-day entries can be backfilled
  idempotently with `node scripts/backfill-pbc-days.mjs --root <repo root>`.
- **Push**: `scripts/push-data.sh` (fetch + rebase retry; commits only when `data/` changed).

**Index list (26)**

| Group | key | Name | Code | Eastmoney secid | Tencent |
|---|---|---|---|---|---|
| A-shares | `sh_comp` | SSE Composite | 000001 | `1.000001` | `sh000001` |
| A-shares | `sz_comp` | SZSE Component | 399001 | `0.399001` | `sz399001` |
| A-shares | `chinext` | ChiNext | 399006 | `0.399006` | `sz399006` |
| A-shares | `star50` | STAR 50 | 000688 | `1.000688` | `sh000688` |
| A-shares | `bse50` | BSE 50 | 899050 | `0.899050` | `bj899050` |
| A-shares | `csi300` | CSI 300 | 000300 | `1.000300` | `sh000300` |
| A-shares | `sse50` | SSE 50 | 000016 | `1.000016` | `sh000016` |
| A-shares | `a500` | CSI A500 | 000510 | `1.000510` | `sh000510` |
| A-shares | `a100` | CSI A100 | 000903 | `1.000903` | `sh000903` |
| A-shares | `csi500` | CSI 500 | 000905 | `1.000905` | `sh000905` |
| A-shares | `csi1000` | CSI 1000 | 000852 | `1.000852` | `sh000852` |
| HK | `hsi` | Hang Seng | HSI | `100.HSI` | `hkHSI` |
| HK | `hs_tech` | Hang Seng Tech | HSTECH | `124.HSTECH` | `hkHSTECH` |
| US | `dji` | Dow Jones | DJI | `100.DJIA` | `usDJI` |
| US | `ixic` | Nasdaq | IXIC | `100.NDX` | `usIXIC` |
| US | `spx` | S&P 500 | SPX | `100.SPX` | `usINX` |
| US | `sox` | PHLX Semiconductor | SOX | `251.SOX` | — |
| Japan | `n225` | Nikkei 225 | N225 | `100.N225` | — |
| Europe | `dax` | DAX | DAX | `100.GDAXI` | — |
| Europe | `cac40` | CAC 40 | CAC40 | `100.FCHI` | — |
| UK | `ukx` | FTSE 100 | FTSE | `100.FTSE` | — |
| Korea | `kospi` | KOSPI | KOSPI | `100.KS11` | — |
| India | `sensex` | India SENSEX | SENSEX | `100.SENSEX` | — |
| Vietnam | `vnindex` | Vietnam VN-Index | VNINDEX | `100.VNINDEX` | — |
| FX | `dxy` | US Dollar Index | DXY | `100.UDI` | — |
| FX | `usdcny` | Offshore CNH | USDCNH | `133.USDCNH` | — |

`SSE 50`'s `000016` is the **SSE index code**; Eastmoney `QuoteID=1.000016` and Tencent `sh000016`
both return the name "上证50" (verified 2026-11-02; see CHANGELOG).

> ⚠ **The PHLX Semiconductor (`sox`) history is short — that is a fact about the upstream source, not truncation on our side.**
> Eastmoney `251.SOX` only started relaying on **2026-07-06**, so there are only **~89 daily bars**
> (18 weekly, 5 monthly) and nothing earlier (passing `end=20250101` returns 0 rows).
> **No SOXX / SMH ETF history was spliced in** — those are funds, not indices, and mixing them would merge two different series.
> Daily/weekly/monthly come from a single source (Eastmoney): Sina `gb_sox` has a live quote but **no daily K**,
> and Tencent has no code for it. Minute K-lines are pre-generated server-side (`data/kline/min/sox_*.json`)
> with the same conventions as `dji/ixic/spx`.

### 2.2 Pipeline ②: K-lines (full daily run + last bar hourly)

- **Full run** (`kline-full.yml`, UTC 04:23 = 12:23 Beijing):
  - `scripts/update-kline-full.mjs`: full daily K for 36 instruments (26 indices + 10 portfolio) (`_full.json`)
  - `node src/collect.mjs --kline-only`: 36 instruments × daily/weekly/monthly (`<key>.json` / `_1w` / `_1M`)
- **Minutes + last bar** (`kline-minute.yml`, hourly at :17):
  - `scripts/update-kline-minute.mjs`: 9 instruments × 5 minute periods (`min/`)
  - `scripts/update-kline-last.mjs`: upserts only the last daily K of instruments **currently in session**
  - **Short-sequence guard (2.4.10)**: every script writing `data/kline/` goes through `src/kline-guard.mjs`.
    New result starts later and is shorter → reject and record (`rejected: shorter`); same length but newer last bar / longer → accept;
    longer but with a hole in the middle → union-merge by time key. Never silently overwrite a long history with a short sequence.
  - **Volume protection (2.4.11)**: at the same time key, incoming 0 volume must not overwrite an existing non-zero value.
    Shanghai gold daily bars are written alternately by Eastmoney (with volume) and SGE (without volume); without this guard they would be erased repeatedly.
    (Shanghai gold's night-session "future candles" must update dynamically with collection, once a day is not enough)

### 2.3 Pipeline ③: point-in-time snapshots (cloud 30-minute fallback)

- **Cloud**: `snapshot.yml` is triggered by the Worker every 30 minutes; it backfills whichever of am/pm is missing and covers the last 5 days.
- **No local on-time task anymore**: the minimax 12:05 / 16:30 snapshot tasks were retired on 2026-10-31.
  Point-in-time prices always come from K-lines; a late collection does not change the value (`capturedAt` is later, `asOf` and the price stay the same).
- **Never overwrite**: `data/snapshots/YYYY-MM-DD_am|pm.json`, one file per point in time, written once.
- **Historical finality**: after adding a new quote instrument, only am/pm snapshots from the addition date onward are guaranteed to include it;
  historical snapshot gaps are **not backfilled and not rewritten** (point-in-time prices cannot be reconstructed after the fact; better missing than fabricated).
- **Price source**: always K-lines (history is traceable); rules in §3.2.

### 2.4 Pipeline ④: macro (after 17:00, cloud)

`node src/portfolio-collect.mjs` → 5 macro indicators + 1Y government-bond daily K.
Hooked into `snapshot.yml`: `scripts/collect-macro-if-due.mjs` checks every 30 minutes and
collects only after **17:00 on a Beijing working day when the day has no record yet** (17:13 / 17:43 are natural retries).
17:00 is the lower bound: the ChinaBond 1Y curve is published after 17:00, and collecting at 16:30 would treat yesterday's value as today's.
Each gate also first runs `scripts/backfill-macro.mjs --days 14`: backfill missing daily records for the last 14 days
(margin financing / 10Y US Treasury by target date, 1Y government bond from the day's K-line, social financing / CPI / PMI from the latest monthly value);
when there is no gap it only reads a file once and sends no request.
**Daily sources**: margin financing / 10Y US Treasury prefer the Eastmoney data center (reachable from GitHub Actions);
SSE+SZSE / FRED are fallback only (measured unreachable from Actions). 1Y government bond still uses ChinaBond.
**No longer reads or writes `quotes.json`** (all quotes are merged into pipeline ①, avoiding stale values overwriting high-frequency results).

### 2.5 Pipeline ⑤: local fallback and sync

| Task | Frequency | Purpose |
|---|---|---|
| Windows `MacroNews-Collect` | 120 minutes | Produces almost nothing when the cloud is healthy; takes over when the cloud is down (silent, no window) |
| Windows `MacroNews-Pull` | 4 hours | `git merge --ff-only` pulls remote artifacts back to the local machine and **never overwrites the working tree** |

### 2.6 Pipeline ⑥: daily briefing (09:00, local fixed conversation)

**Since 2.3.0: the pipeline belongs to scripts, the writing belongs to the LLM**. Intermediates live in `.local/runs/YYYY-MM-DD/`
(`input.json` → `outline.json` → `draft.json` → `final.json`; `.local/` is not in git);
`publish` writes `data/briefings/YYYY-MM-DD.json` only after validation (keyed to the same date as the archive, see §2.7).

> The mcode task prompt is a **hand-written finished product** and takes precedence over the `prompt.md` generated by `prepare`:
> [mcode briefing task prompt](file:///c:/Work/Minimax_Work/macro-news/docs/superpowers/specs/2026-11-02-mcode-briefing-task-prompt.md).
> When the two conflict, the task prompt wins; `prompt.md` is only the day's data entry point and supplement.

| Stage | Implementation |
|---|---|
| Trigger | minimax scheduled task `macro-news 宏观早报（每日 09:00）`, cron `0 9 * * *` (Asia/Shanghai), **fixed conversation** (one dedicated conversation per task, with accumulated history for traceability). The 2.3.0 three-stage scheduling is executed by the user on the mcode side; the repository never changes the task automatically |
| prepare | `node scripts/briefing/prepare.mjs --date <today>`: sync/import archive → `brief-candidates` dedupe and scoring → persist `input.json` (not published, not committed) |
| Writing | **LLM judgment**: read `.local/runs/<date>/prompt.md`, write `outline.json` → `draft.json` → `final.json` per schema; ≤10 items, merge multiple sources for the same event |
| publish | `node scripts/briefing/publish.mjs --date <today> --push`: validate schema / item count / source traceability / `inputSha`, then atomically write the site and local copy, update the index and status; `--push` commits only the 4 briefing-related paths (see "Publish means ingest" below) |
| Output | `.local/briefings/YYYY-MM-DD.json` + `.md` (local) + `data/briefings/YYYY-MM-DD.json` (site) |

**Candidate window (2.13.0)**: news-day based — the briefing for `D` takes `[D-1 08:00, D 09:00]`,
i.e. "the news day that just finished plus the hour elapsed today"; both ends are derived from `newsDayStart`,
and `window.fromAt/toAt` is persisted with `input.json` and the published briefing. The old implementation used two Beijing
calendar days (`T00:00:00+08:00` ~ `T23:59:59+08:00`) and pulled in 08:00–24:00 of news day `D-2` as well.

**News database** `.local/news.db` (SQLite + FTS5, Chinese bigram tokenization): about 530k rows;
the last 60 days have full text/summary, while the 5-year history is mostly title + link (China News Service backfill of about 500k).
**Already wired into the static site**: 2.2.0 shipped the trailing-year history slices, 2.4.10 filled 09-20~10-04; currently
**the trailing year (about 320 days) / about 70k items / through 2026-10-04**, and dates after 09-20 use the `archive/` full text.
History slices are mostly title/source/time/original link (136 with a summary), **with no body**.

⚠ Two measured pitfalls (the briefing task hits them every day, so they are written into the instructions):
1. **`published_at` in the database is the "ingest time", not the original publish time, and the formats are inconsistent** ——
   those ending in `+08:00` are crawler sources (Eastmoney/Sina Finance/Wallstreetcn) and are used as-is;
   those ending in `Z` are UTC (China News Service/NBS/Fed/ECB) and **need +8 hours** before converting to Beijing time.
   Validation anchor: the NBS PMI item `2026-10-31T01:30:01Z` → 9:30 Beijing time, exactly the official release time.
2. **The same article may have two rows in the database**: the China News Service backfill row is a date-precision placeholder (`T12:00:00+08:00`, empty summary),
   while only the collected row has the full text ⇒ use the row **with a summary** for time and link.

**Three stages (2.3.0)**

```
prepare --date (script, deterministic)
  → input.json / prompt.md (.local/runs/<date>/, not published)
LLM writing (semantic judgment)
  → outline.json → draft.json → final.json (checkpointed, resumable)
publish --date (script, deterministic)
  → write data/briefings/ only after validation; otherwise missed or a source:"draft" fact list
```

- **Idempotent**: `prepare` reuses `input.json` if it already exists (no re-fetch, no second candidate set);
  the LLM resumes from the latest valid checkpoint; `publish` **never overwrites** a complete AI briefing already on the site.
- **Degrade without pretending**: LLM unavailable / final draft invalid → write no file and mark `missed`;
  only with explicit `--draft-on-fail` does it write a `source:"draft"` fact list (title/source/time/link only, no AI summary).
  `source` values: `ai` (LLM final, no badge), `draft` (fact list), `rule` (manual `generate.mjs` only).
- `node scripts/briefing/ensure.mjs` **automatic mode only tops up today**: if today is still incomplete after **09:30**,
  it only runs `prepare` to persist the input and marks `awaiting`, and **no longer generates a rule-based version**; if a complete AI artifact already exists locally, it only publishes.
  Historical gaps generate no briefing at all and are only marked `missed` in the status file (better missing than fake).
  To backfill history manually, explicitly pass `--backfill-from/--backfill-to` (off by default, not part of scheduling).
- Status is written to `data/_briefing-status.json` (single file, kept 14 days, not high-frequency): the footer shows
  `早报 09:02` (green, AI) / `早报 事实清单 09:35` (brown, draft) / `早报 自动` (brown, rule) /
  `早报 待写作` / `早报 待发布` / `早报 补跑中` / `早报 失败` (Briefing 09:02 / Briefing fact list 09:35 / Briefing auto / Briefing awaiting writing / Briefing awaiting publish / Briefing catch-up running / Briefing failed).
- **Footer briefing text is layered by time (2.13.1)**: a briefing for day `D` is produced at 09:00 on `D`, so between
  08:00 and 09:00 (inside the news-day window, run time not reached) the footer shows the neutral
  `早报 今日 09:00 后生成` (grey, not a warning colour); only after 09:00 with neither a status record nor an artifact
  does it show `早报 今日未生成` (brown). When a briefing already exists (status `done` or `index.json` `hasBriefing`)
  only the completion info is shown — no "missing" wording. The status file is fetched with **no HTTP cache**
  (`no-store`, 60-second in-page memo), so a manual catch-up shows up on the next refresh.
- Re-entry locks `.local/briefing.lock` (ensure, pid + start time, expires after 20 minutes) and
  `.local/runs/<date>/run.lock` (shared by prepare/publish); hard timeout per day is 15 minutes,
  after which it exits with code 124 and records the reason.
- The acceptance criteria **do not look at `generatedAt`** (it is the start time; the 11-02 incident showed 09:02 while the file actually landed at 12:15):
  file exists, JSON parses, `items > 0`, `overview` non-empty; new artifacts also have `endedAt`.
- **Status invariants (2.2.3)**: a day with a briefing file must be `done` and `source` must match the file;
  `missed` is only for "no file and no successful generation". Every `ensure` corrects first and then validates; a violation exits with code 1.

**Publish means ingest (2.4.2)**

`publish --date <today> --push` automatically does the following after a successful publish:

1. `git add --` only 4 paths: `data/briefings/<date>.json`, `data/index.json`,
   `data/history/index.json`, `data/_briefing-status.json` (**never add the whole directory**);
2. `git fetch origin main` → `git rebase origin/main` → `git push origin HEAD:main`;
3. push/rebase failure **does not roll back the published file**; the status records `pushed:false / pushError / pushErrorKind`,
   and the footer shows `早报 已发布未入库` (briefing published but not ingested; hover for the reason).
4. **rebase conflict (2.4.8, semantics corrected in 2.4.18)**: when the collector and publisher modify `data/index.json` /
   `data/_briefing-status.json` at the same time, merge semantically and then `rebase --continue`:
   - ⚠️ **during a rebase conflict, `:2:` = upstream (origin/main) and `:3:` = the local commit being replayed**
     (the opposite of the merge ours/theirs intuition; confirmed by a real git test on 2026-11-05).
   - Merge base = **`:2:` (remote) latest counts as the base**, then layer the `:3:` (local) day's
     `hasBriefing/briefLine/source` on top; the status file is the same = remote as base + the local day's publish status.
     Never take one whole side of the file.
   - If a conflicted file is not in the allowlist (`data/index.json`, `data/history/index.json`,
     `data/_briefing-status.json`), it still aborts; never force push.

Fallback: local `collect-and-push.ps1` every 120 minutes allows only a single briefing file for **today/yesterday that already exists**.
Invariant: `hasBriefing=true` ⇔ the file exists and is tracked by git (locked by `tests/briefing-index-invariant.test.mjs`).

Archive-page briefing (2.4.3): collapsed, it shows only `briefLine` from the index; only when expanded does it fetch the day's
`data/briefings/<date>.json` (historical `default`, today `no-store`), render
`overview + items + watch`, and replace the summary with `当日早报 · N 条 · HH:MM 生成 · 覆盖 <D-1> 08:00 – <D> 09:00`
(daily briefing · N items · generated HH:MM · covers <D-1> 08:00 – <D> 09:00) to avoid repeating the same sentence.
**Since 2.13.0** briefings carry `window.fromAt/toAt`; the coverage span is shown in that meta line and in the first line of the
expanded body. Older briefings have no such fields and are shown unchanged — nothing is backfilled or guessed.
No first-screen prefetch (measured 0 `briefings` requests); one briefing is 10 KB, and expanding online takes about 40 seconds at Pages bandwidth, which is normal.

### 2.7 Pipeline ⑦: trailing-year history slices (offline export)

**Not a scheduled task**; run manually when needed; reads the local news database and writes static files only.

| Stage | Implementation |
|---|---|
| Data source | `.local/news.db` (SQLite, about 530k rows, from 2021-11) |
| Export | `node scripts/export-history.mjs --days 365` → `data/history/YYYY-MM-DD.json` + `index.json` |
| Scope | 365 days through **yesterday**; only dates not covered by `data/archive/` (gap-only); existing slices are not overwritten |
| Status (2.4.10) | **the trailing year (about 320 days) / about 70k items / through 2026-10-04**; dates from 09-20 with archive placeholder files are filled by `--include-archived`, and dates after 09-20 use archive full text |
| Fields | Mostly `title/source/time/original link` (136 with a summary), **no body** |
| Gap | 09-04~10-04 Wallstreetcn/Eastmoney/Sina were not collected (source sites do not keep history beyond 30 days, so it cannot be backfilled); that period is dominated by China News Service/official sources |
| Per-day cap | 400 items (after same-hash dedupe, selected by "official / full text / source weight"); **mostly title/source/time/link (a few with summary), no body** |
| Size | Measured **about 320 slices / about 70k items / about 16 MB** (largest single day under 100 KB) |
| Read | The archive page fetches `history/index.json` only when switched to "Archive"; a day's slice is fetched only when clicked; LRU 3 days, `max-age=600` |

History slices are **mostly title/source/time (a few with summary), with no body** (the body lives in the `archive/` day files); `search.json`
indexes only the latest **62 news days** of the archive and contains no summary (title/source/time/link only),
and does not cover `history/` — a full 365-day index is not feasible in a browser (see §9).

**Which file a day uses (2.4.10)**: when the archive has **≥ 20** items, use the archive full text; when `< 20` and a history slice exists,
use the history slice and show the reason above the list (e.g., "this day's archive has only 3 items, switched to the history slice of 243 items (title/source/time only, please open the original for the body)"). The rule lives in `assets/day-source.js`; the threshold is explicit and testable, not hidden in rendering.
To fill placeholder-day slices: `node scripts/export-history.mjs --from <start> --to <end> --include-archived --force`.

**News-day boundary (from 2.4.19)**: unified to **start at 08:00 Beijing time** (equivalent to the UTC calendar day);
the single implementation of `newsDay()` is in `assets/news-day.js`; archive files, `index.json`, `latest.json`,
`search.json`, history slices, and snapshot reconciliation all use it. Because 08:00 Beijing = 00:00 UTC,
GitHub Actions' original UTC day-cutting matches the new definition, and the local machine no longer cuts at Beijing midnight.
**No history rewrite**: day files written before 2026-11-05 stay as-is; boundaries before the switch were written by a mix of UTC/Beijing calendar days
and are uncertain, so we do not re-sort them just for tidiness. Measured now: `2026-11-04.json` has 800 items and
`2026-11-05.json` has several hundred items, all inside the new window; the switch causes no item-count jump or news changing days.


---

## 3. Collection specification (definitions)

### 3.1 When each market's bar marked D is final (Beijing time)

This is the **root of the snapshot definition**, and it also explains why 12:05 cannot read the current day's daily K for Japan/Korea.

| Market | Final at | am 12:05 reads | pm 16:12 reads |
|---|---|---|---|
| CN / ETF | D 15:00 | 5-minute 11:30 bar | D |
| HK | D 16:00 | 5-minute 12:00 bar | D |
| JP | D 14:00 | **D−1** | D |
| KR | D 14:30 | **D−1** | D |
| VN | D 15:45 | **D−1** | D |
| IN | D 18:00 | **D−1** | **— (not used)** |
| EU / UK | D+1 00:30 | **D−1** | **D−1** |
| US | D+1 05:00 | **D−1** | **D−1** |

- At 12:05, Japan/Korea (UTC+9) are already in the afternoon session, so the current day's daily K is an **unfinished half bar**;
- At 16:12, DAX/FTSE have just opened, and India's BSE closes at 18:00, so neither can use the current day;
- India is **not part of the pm snapshot** (its close is later than 16:12); in `am` it uses **D−1**, the same rule as Europe/US with no separate branch.
- Europe/US use the later winter-time close (conservative); collection times are far from the boundary, so DST does not affect them.
- pm `readyAt` is **16:12** (not 16:02): the downstream close review requires `capturedAt >= 16:10`, and HK has a 16:00–16:10 closing auction.

### 3.2 How point-in-time snapshots pick prices

| Slot | Target time | Price used |
|---|---|---|
| `am` | A-shares 11:30, HK 12:00 | close of the corresponding 5-minute bar |
| `pm` | A-shares 15:00, HK 16:00 | the daily K's official close (the bar that is already final per §3.1) |

Each record carries `price / prevClose / changePct / asOf / priceSource / note`.
- `asOf` is the **real timestamp the price corresponds to**, not the collection time;
- `priceSource` = `kline5m` or `dailyK`;
- collection time not reached → skip; non-trading day → **write no file at all** (better missing than fake);
- **Previous close**: A-shares/ETF use the previous trading day's 15:00 bar; HK uses the previous trading day's daily K close (5-minute K has no 16:00 bar).

### 3.3 Daily K-line data rules

| Item | Rule |
|---|---|
| Primary source | Eastmoney `kline/get`, `klt=101/102/103`, `fqt=1` |
| Fallback | Tencent (11 CN + 2 HK + 3 US indices) → Sina (11 CN) → Sina global (London gold/silver, Brent) → local file |
| Bar count | Frontend daily/weekly/monthly requests **20000**; server pre-generates **1000 / 1821 / 500** |
| Intraday bar | Trading days return **today's unfinished bar**, shown as a "live candle" in the K-line chart — a drawing behavior that does not affect snapshots |
| Date | A bar's `t` is the **exchange's local date**; weekly/monthly prefer the source directly and aggregate from daily K when the source lacks it |

**Minute K and yearly K**

- Minute source caps (measured 2026-10-31):
  - Eastmoney: 5m at most **1536** bars; 1m has only **240 bars for the current day**;
  - Sina: **1023** bars, and covers **both indices and on-exchange ETFs** (Eastmoney often gives only the latest day for ETFs);
  - Tencent: 320 bars.
  ⇒ The client races all three sources: "latest last bar wins; at the same timestamp, most bars wins".
  1m covers about 4 trading days; 5m ≈ 21~32 days; 15m ≈ 64~96 days; 30m ≈ 128~192 days; 60m ≈ 256~384 days.
- Yearly K: there is no reliable yearly endpoint, so it is uniformly aggregated from **monthly K** (for instruments such as ChinaBond with only daily data, from daily K),
  with `t` = `YYYY-01-01`; ETFs get as many bars as the years since listing.
- Moving averages: daily/weekly/monthly/minute use MA5 / 10 / 20 / 30 / 60 / 120 / 250, individually toggleable in the K-line modal (state in localStorage);
  yearly K uses only MA5 / 10 / 20 / 30 (unit = years).
  **Availability is decided by the number of data bars for every period**: below n bars the MA is not drawn and its button is disabled; it turns on automatically once data reaches n bars.

### 3.4 Quote refresh policy

| Instrument | Refresh |
|---|---|
| 26 indices + 32 ETFs + `ndx` | Every 15 minutes (Eastmoney batch; Nasdaq 100 is same-source with the K-line `100.NDX100`) |
| `xau` / `xag` / `brent` | Server every 15 minutes; the front end also calls Tencent `hf_XAU` / `hf_XAG` / `hf_OIL` on every load (2.7.0) |
| `sge_au9999` | Every round while trading (day 09:00-15:30 / night 20:00-02:30) from Eastmoney `118.AU9999`; after 15:30 the official SGE daily quote overrides (2.6.0) |
| `usdcny_mid` | After 09:15 and only when the stored value is not today (China Foreign Exchange Trade System; one value per day, no history) |
| `cgb_1y` | After 17:00 and only when the stored value is not today (ChinaBond curve) |

**Freshness states (2.4.0 / 2.4.1)**: only a **provable source time** (Eastmoney `f124` / Tencent time field) allows the label "live";
source time ≤ **5 minutes** = live; market **not in session** and source time ≥ the most recent close = `Closed` / `Closed (holiday)`
(lunch break shows `Midday break`); **should be trading but no new price** = delayed; all direct connections fail and we fall back to `data/quotes.json` = local snapshot.
Total quote-pipeline budget **2 seconds** (Eastmoney 1.2s → Tencent 0.8s); on timeout fall back immediately instead of spinning for ten-plus seconds.
Cards, `#quoteTime`, and the footer share the same wording (`assets/quote-status.js`, pure logic, shared with Node tests).

Trading sessions use IANA time zones (`Intl`), not a hard-coded +08:00: CN/ETF/HK/JP/KR/US/DE/FR/UK each have sessions and lunch breaks;
US/EU DST is covered by tests. Holiday table `assets/market-calendar.json` (completed in 2.4.4):
JPX / NYSE / SSE / HKEX / Xetra / Euronext Paris / LSE, full 2026 + 2027 (the official 2027 tables for CN/FR are not yet published, left empty and recorded in `gaps`).
DE/FR still sit under the `EU` group on the page, but each card uses `calendarMarket` (DAX→DE, CAC40→FR) to judge holidays separately,
so "Xetra closed, Paris open" is not merged. The KRX official page is JS-rendered and no verifiable complete table could be obtained, so `markets.KR` stays empty and the gap is recorded in `gaps`.
When the table is missing or beyond `coverageByMarket`, show only `Closed` based on session hours and **never guess a holiday**.
Maintenance: update once every December (next year's official calendars are usually published), updating
`coverage` / `coverageByMarket` / `halfDays` / `markets` / `sources` / `verifiedAt` / `updatedAt`;
tests lock `coverageByMarket.to >= 2026-12-31` for every market, at least one holiday case per market,
and forbid weekends in the holiday table.

**Half-day sessions (2.4.7)**: `halfDays` lists `date` / `closeTime` (exchange local time) /
`sessionNote` / `source` per market. On a half-day, only the trading window before `closeTime` is kept; after the close the page shows
`已收盘（半日市） · 12-24 12:00` (Closed (half-day) · 12-24 12:00); even if the price source still returns the previous trading day's stale price, it is classified as `Closed`
and not mislabeled `Delayed`. Covered:

| Market | Dates | Close | Basis |
|---|---|---|---|
| HK | 2026-02-16 / 12-24 / 12-31; 2027-02-05 / 12-24 / 12-31 | 12:00 | HKEX circulars CT/075/25, CT/077/26; exchange rule "no afternoon session on the eve" |
| FR | 2026-12-24 / 12-31 | 14:00 CET | Euronext 2026 Holiday Calendar (Half Trading Day); timing per the 2025 year-end appendix |
| UK | 2026/2027 12-24 / 12-31 | 12:30 London | LSE Business days (closing process 12:30) |
| US | 2026-11-27 / 12-24; 2027-11-26 | 13:00 ET | NYSE Holidays & Trading Hours |

Xetra's 12-24/12-31 are **full-day closures** (already listed in `markets.DE`), with no half-day; the 12-30 shortened session
has no 2026 official announcement found, so it is not included and is recorded in `gaps`.

K-line drawer header `#kmMeta` shows `source · date time · staleness · tri-state`: direct sources show "Eastmoney/Sina/Tencent",
local pre-generated shows "local pre-generated" and marks "local snapshot"; switching period follows that period's last bar time.

### 3.5 Night sessions and "future candles"

Instruments such as Shanghai gold with night sessions: Friday's night session (20:00–02:30 next day) **belongs to the next trading day**,
and Eastmoney labels it `2026-11-02`. Viewed on Saturday it is a "future candle" — that is the exchange's convention, and market software shows it the same way; **we keep it displayed**.

What must hold is that it **updates with collection**:
- Chart layer: `isTrading` includes SGE hours (day + night; early Saturday still counts as Friday night),
  and the last bar is redrawn every 20 seconds while the K-line is open;
- Collection layer: `update-kline-last.mjs` upserts the last daily K of instruments currently in session every hour.

### 3.6 Idempotency and push

- News is deduplicated by `id`; if JSON content is unchanged, skip writing (avoids repeated git blobs).
- Multiple workflows each have their own `concurrency group`; pushes go through `push-data.sh` with fetch + rebase retry.
- **Never** `git reset --hard`; do not hand-edit `data/` (the next collection overwrites it).

---

## 4. Data contract (what the frontend / AI reads)

| File | Content | Written by |
|---|---|---|
| `data/quotes.json` | Snapshots for 70 instruments (26 indices + 32 ETFs + 12 portfolio) | Pipeline ① |
| `data/snapshots/YYYY-MM-DD_am.json` | Morning point-in-time prices (item count follows the instrument list; historical files keep the count at generation time) | Pipeline ③ |
| `data/snapshots/YYYY-MM-DD_pm.json` | Closing point-in-time prices (61 items; historical files before new instruments have 57/58/59/60) | Pipeline ③ |
| `data/archive/YYYY-MM-DD.json` | News archived by day, **with full text** | Pipeline ① |
| `data/history/YYYY-MM-DD.json` | Trailing-year history slices (**mostly title/source/time/link, a few with summary, no body**, ≤400 items/day) | `scripts/export-history.mjs` |
| `data/history/index.json` | History slice index (with `hasBriefing` / `briefLine` / `source`) | Same as above |
| `data/briefings/YYYY-MM-DD.json` | The day's briefing (`overview` + `watch` + `items` + `source`, same key as the archive) | Pipeline ⑥ / `scripts/briefing/*` |
| `data/latest.json` | Latest 200 items (first screen) | Pipeline ① |
| `data/search.json` | Search index for the latest 62 news days (**title/source/time/link, no summary**, about 6 MB) | Pipeline ① |
| `data/index.json` | By-day archive index (with `hasBriefing` / `briefLine` / `source`) | Pipeline ① |
| `data/kline/<key>.json` / `_1w` / `_1M` | 36 instruments × daily/weekly/monthly | Pipeline ② |
| `data/kline/<key>_full.json` | Full daily K for 36 instruments (26 indices + 10 portfolio) (compact arrays `[t,o,c,h,l,v]`) | Pipeline ② |
| `data/kline/min/<key>_<period>.json` | 9 instruments × 5 minute periods (including London gold and PHLX Semiconductor) | Pipeline ② |
| `data/macro/daily.json` | Daily series for 5 macro indicators | Pipeline ④ |
| `data/_last-run.json` | Run status per pipeline (fields coexist, read-modify-write) | All pipelines |
| `data/_briefing-status.json` | Briefing generation status (last 14 days, read by the footer) | `scripts/briefing/*` |

**Read rules for AI / scripts**

- For **quotes / macro** → read `quotes.json` + `macro/daily.json`; do not fetch endpoints yourself.
- For **a day's closing price** → read `snapshots/`; A-shares in `quotes.json` are live prices, not closing prices.
- For **news full text** → read `archive/`'s `items[].content`; `search.json` has no body.
- For **trailing-year history** → read `history/<day>.json` (mostly title/source/time/link, a few with summary); if `archive/` also has that day, the archive wins.
- For **the day's briefing** → read `briefings/<day>.json`; the index only has `hasBriefing` + one `briefLine`.
- Do not trigger collection as a side effect, and do not hand-edit `data/`.

Frontend behavior: quotes and K-lines **connect directly from the browser to Eastmoney** (CORS `*`), falling back to the local files above only on failure;
K-lines use a **three-source concurrent race** (local snapshot / Eastmoney / Tencent+Sina), and overwrite only when the bar count does not decrease.

---

## 5. Usage

Nothing needs to be run manually in normal operation. The commands below are only for "refresh now / troubleshoot".

```powershell
# Local preview (or just double-click start.cmd)
node scripts/serve.mjs

# Pull the latest data from remote (= the 4-hour task)
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\pull-remote.ps1

# Register / update the 4-hour sync task (Windows scheduled task)
powershell -ExecutionPolicy Bypass -File scripts\register-pull-task.ps1

# Manually verify the macro source (--force ignores the gate, --dry-run writes nothing)
node scripts\collect-macro-if-due.mjs --force --dry-run

# Cross-day macro backfill (default last 7 days, excluding today; the cloud gate runs the last 14 days)
node scripts\backfill-macro.mjs --days 7 --dry-run

# Run one collection manually (news + quotes; normally run by Actions)
node src/collect.mjs

# Backfill missing point-in-time snapshots for the last 5 days
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\snapshot-collect-and-push.ps1 -Backfill 5

# Closing snapshot + macro + 1Y government-bond daily K
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\portfolio-collect-and-push.ps1

# Refresh only the last daily K of the current session (add --dry-run to inspect without writing)
node scripts/update-kline-last.mjs --dry-run

# Trailing-year history slices: measure size first (gap-only, existing slices are not rewritten by default)
node scripts/export-history.mjs --days 365 --dry-run
node scripts/export-history.mjs --days 365

# Publish local briefings to the site (JSON only; the Markdown version stays in .local)
Copy-Item .local\briefings\*.json data\briefings\ -Force

# Briefing three stages (2.3.0): prepare persists input → LLM writes outline/draft/final → publish validates and publishes
node scripts/briefing/prepare.mjs --date 2026-11-02
node scripts/briefing/publish.mjs --date 2026-11-02
node scripts/briefing/publish.mjs --date 2026-11-02 --draft-on-fail   # degraded fact list

# Briefing fallback (today only; when missing, only prepare and wait for the LLM, no rule-based version anymore)
node scripts/briefing/ensure.mjs --dry-run
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\briefing\run-ensure.ps1

# The rule-based version is kept only as an explicit manual tool (not part of automatic scheduling; do not use in the normal flow)
node scripts/briefing/generate.mjs --date 2026-11-02

# Manually backfill history (off by default; you must pass explicit start/end dates; only prepares snapshots, no rule-based version)
node scripts/briefing/ensure.mjs --backfill-from 2026-10-30 --backfill-to 2026-11-01

# Offline regression tests (no network, no disk writes): slices / briefing criteria / locks / catch-up, filename case, time zones, collection allowlist
node --test "tests/*.test.mjs"

# Assertion rules: never hard-code item counts or last-bar dates against the real data/
# → docs/test-conventions.md
```

Tabs are real `href="#view-xxx"` links: bookmarkable, shareable, and they still navigate without JS.
Search counts have two universes: with no keyword it is "latest snapshot 200 items"; after typing it is "M of N in the whole database".
The page states this explicitly to avoid the illusion that "items with a keyword > items without a keyword".

---

## 6. Deployment and operations

### 6.1 GitHub Pages (one-time)

1. Create a **Public** repository (free Actions quota); push `main`.
2. Settings → Pages → Source = `main` / `/ (root)`.
3. The repository root must contain **`.nojekyll`**: Jekyll ignores files starting with `_`, and `data/_last-run.json` is exactly one.
4. Enable `宏观资讯采集` (Macro News Collection) on the Actions page; run `Run workflow` manually to verify.

> HTTPS from this machine to `github.com` is reset, so git goes through SSH-443 (the repository has `insteadOf` configured);
> whether `github.io` is reachable depends on the network at the time.

### 6.2 Cloudflare Worker (external cron + quote sampling backup)

There are **two** Workers in the repository with different jobs; do not mix them up:

| Worker | Directory | Purpose |
|---|---|---|
| `macro-news-cron` | `worker/gh-cron/` | External cron: scheduled `workflow_dispatch` triggers for Actions |
| `macro-news-proxy` | `worker/worker.js` | Quote sampling backup: `/quote`, `/kline`, `/health` |

**The quote proxy is positioned as a scheduled sampling backup, not a reader-facing entry point**: the frontend (`market.js` / `app.js` / `config.js`)
and the collector do not call `workers.dev`; readers connect directly to Eastmoney/Tencent and fall back to the local snapshot.
`workers.dev` is **reachable on this machine only when a proxy is enabled** (the domain is DNS-poisoned), so it is used only for development verification and backup sampling.
From 2.4.0 the `/quote` fallback order is: Eastmoney three mirrors (`push2` / `1.push2` / `push2delay`) → Tencent `qt.gtimg.cn`
→ Yahoo chart; each `quotes[]` entry carries `source: eastmoney|tencent|yahoo` and `updatedAt` (source time).
`/kline` covers only the 26 indices (`INDICES`); portfolio instruments (xau/xag/brent, etc.) return 400, and the frontend never uses this path for K-lines.

GitHub's built-in `schedule` only fires about 3% of the time in practice, so triggers moved outside the repository:

| cron | Driver |
|---|---|
| `7,22,37,52 * * * *` | `collect.yml` |
| `13,43 * * * *` | `snapshot.yml` |
| `17,47 * * * *` | `kline-minute.yml` (the UTC 04:17 round also runs `kline-full.yml`) |

**GitHub `schedule` is only a staggered fallback** (the primary trigger is the Cloudflare cron above):

| Task | GitHub fallback | Relation to the CF primary trigger |
|---|---|---|
| `collect.yml` | `12,42 * * * *` | Different minutes from all CF rounds (+5 minutes; CF runs every 15 minutes, see workflow comments) |
| `snapshot.yml` | `3,33 * * * *` | +20 minutes |
| `kline-minute.yml` | `2 * * * *` | +15 minutes; the 04:00 round also refreshes daily/weekly/monthly K |
| `kline-full.yml` | `8 5 * * *` (05:08) | +51 minutes (a full run can take up to 30 minutes; avoid concurrent writes to `_full.json`) |

Daily/weekly/monthly K are refreshed by `kline-minute.yml` at UTC 04:00 (CF 04:47 / GH 04:02);
`kline-full.yml` writes only `<key>_full.json`.

```bash
# 1) GitHub → Developer settings → Fine-grained tokens
#    Repository access: select only macro-news; Permissions: Actions → Read and write
# 2) Deploy
cd worker/gh-cron && npx wrangler deploy
# 3) Write the secret (dash.cloudflare.com is not reachable from mainland China; use the API script)
powershell -ExecutionPolicy Bypass -File scripts\set-worker-secret.ps1
```

Observability: KV key `STATE.last_dispatch` (latest `{at, cron, results}`),
`GET /accounts/<acc>/storage/kv/namespaces/<ns>/values/last_dispatch`.

Three pitfalls that masquerade as "a broken token":

| Symptom | Real cause | Fix |
|---|---|---|
| GitHub returns 400 with an empty body | `workflow_id` included the full path | Use only the filename (`collect.yml`) |
| Returns 400 instead of 401 | trailing whitespace in the PAT | `.Trim()` before writing |
| Workflow fails to parse, no job | `: ` inside `MSG_PREFIX="data: ..."` in `run:` | Quote the whole line |

### 6.3 Local scheduled tasks

| Task | Schedule | Script | Registration |
|---|---|---|---|
| Local fallback collection | Every 120 minutes | `scripts\collect-and-push.ps1` | `scripts\register-task.ps1` |
| Remote sync | Every 4 hours | `scripts\pull-remote.ps1` | `scripts\register-pull-task.ps1` |

`MacroNews-Collect` is **sync first, then staleness-driven**: each round first runs `git fetch origin main`
to compare `HEAD`/`origin/main` (behind and clean → ff-only; tracked changes → stash → ff-only → pop;
diverged → normal merge, abort and skip on conflict); the sync result and short `HEAD` hash go to the log.
Then it **reads** the newest item in `data/latest.json`; if it is younger than `-NewsStaleMinutes` (default 45) minutes, the whole round skips news/quote collection — when the cloud 15-minute rounds are healthy,
the local machine never collects twice; when the cloud scheduler drops events, the local machine takes over after at most 45 minutes.
Daily/weekly/monthly K use `-KlineStaleHours` (default 6) the same way.
From 2.4.16 we no longer use `-X ours`; any merge conflict only aborts/keeps the stash and never overwrites local files.
Skipped syncs are written to `localSync` in `data/_last-run.json`, and the footer shows "Local sync skipped N rounds":
0 not shown, 1–2 amber, ≥3 red; it does not change the existing overall pipeline light.

`MacroNews-Collect` / `MacroNews-Pull` both start with zero windows via `wscript + run-hidden.vbs`;
`-StartWhenAvailable` allows catch-up after sleep/shutdown.

There is also a **minimax scheduled task** (not a Windows scheduled task):
`macro-news 宏观早报（每日 09:00）` (cron `0 9 * * *`, Asia/Shanghai, fixed conversation) —
see §2.6. It only reads the news database and writes `.local/briefings/`, **never touches site files and never commits to git**.

> minimax's 4 old tasks (12:05 morning snapshot, 16:30 close + macro, 16:35 retry, 4-hour sync)
> were retired on 2026-10-31; on 2026-11-01 one leftover 12:05 task in the list was also disabled (the user verified).
> This repository does not depend on them: snapshots and macro use `snapshot.yml`, and remote sync uses `MacroNews-Pull`.
> **The 09:00 macro briefing is still running** (see §2.6); it only reads the news database and does not touch site data.

### 6.4 Pipeline operations ledger (2.4.22)

`scripts/collect-and-push.ps1` appends one JSON ledger line to
`.local/metrics/collect-runs.jsonl` at the end of every round (success / skip / failure). `.local/` is gitignored and not committed:

| Field | Description |
|---|---|
| `at` / `durationMs` | End time (UTC ISO) / round duration |
| `day` | **Beijing day** (`Asia/Shanghai`, same key as the GitHub stats); older lines without it are converted from `at` on read |
| `host` / `mode` | Machine name / `collect` or `sync-only` |
| `result` / `skipReason` | `ok` / `skipped` / `failed`, plus the skip or failure reason |
| `headBefore` / `headAfter` | HEAD short hash before sync / at the end |
| `behind` / `ahead` | Distance from `origin/main` during sync |
| `filesWritten` / `commitCreated` | Data files written this round / whether a commit was created |
| `dirtyStreak` | Consecutive rounds deferred because of a dirty worktree (0 = this round was not a dirty skip); at ≥3 the script logs `⚠` and updates `.local/metrics/alert.json` — meaning "local fallback failed N rounds", while the site is still refreshed by the cloud Worker every 15 minutes |
| `syncResult` | `up-to-date` / `ff-only` / `merge` / `skipped:*` (dirty worktree = `skipped:dirty-worktree`) |

`-SyncOnly` records `mode: "sync-only"`; it only runs a sync self-check and does not count as a collection round.

Recompute anytime:

```powershell
node scripts/ops-stats.mjs                 # last 14 days (aligned with the Traffic window)
node scripts/ops-stats.mjs --days 30       # longer window; anonymous quota 60/hour
node scripts/ops-stats.mjs --no-network    # local ledger only
```

The output is a daily table: `date | GH runs | Pages builds | local collections | total | clone equivalent`,
plus a per-workflow summary and local skip reasons; a snapshot is written to `.local/metrics/ops-stats-<date>.json` (not committed).

**Definitions and error bounds**:
- GH runs come from anonymous `actions/runs`, split by `created` converted to Asia/Shanghai; the anonymous per-day pagination cap is
  1,000, and anything beyond is counted as missing;
- Pages builds are counted directly from `pages build and deployment` in the same dataset; when missing, fall back to the inference
  "one push, one build";
- `clone equivalent = GH runs + Pages builds` (1 run ≈ 1 clone); local fetches are excluded;
- Traffic daily numbers need a token, so the script does not pull them; read the 14-day values manually in GitHub Insights → Traffic
  and compare with the `clone equivalent` total: only the portion above the ledger could be external access,
  but **this ledger cannot attribute external clones**, it only proves a lower bound of our own usage.

---

## 7. Troubleshooting (symptom → root cause → fix)

| Symptom | Root cause | Fix |
|---|---|---|
| Scheduled tasks "run too little" / idle for a long time | GitHub schedule only fires about 3% of the time | Worker external trigger; 120-minute local fallback |
| All cloud workflows create no job | `: ` in `run:` breaks YAML parsing | Quote the whole line |
| Data committed but unchanged / data lost | `push-data.sh` treats `MSG_PREFIX=...` as a path; or multiple workflows in the same group get cancelled | Parse `KEY=VALUE`; separate concurrency groups |
| Quote cards stuck on the previous trading day | US stocks/precious metals had not closed at the 16:30 portfolio collection | Portfolio quotes merged into the 15-minute pipeline (2026-10-31) |
| Snapshot closing price wrong (e.g., csi300 off by 0.4%) | Collection before the close treats the intraday daily K as the close | `readyAt` guard + the "final" table in §3.1 |
| HK am previous close off by a dozen points | 5-minute K ends at 15:35 and has no 16:00 bar | HK previous close now uses daily K |
| Shanghai gold gains an extra "future" daily K | Night session belongs to the next trading day | **Keep it**, updated hourly by `update-kline-last` |
| Eastmoney K-line takes several seconds | Serial fallback waits for Eastmoney to time out first | Three-source race, first response wins |
| Tencent K-line fallback silently fails | DNS cannot resolve `web.ifzq.gtimg.cn` | Use `ifzq.gtimg.cn` |
| One source dies and the backup dies too | The circuit breaker is counted globally | Isolate circuit breakers by host group |
| All ETFs show `-` in batch quotes | Wrong `stock/get` fields | Use `ulist.np`'s `f2/f12/f13/f14/f18` |
| Source timestamp still moves after the close | `f124/f86` is push time, not trade time | Snapshots always use K-lines, never real-time prices to self-certify |
| HTML changes do not take effect for ten minutes | Pages sends `max-age=600` for HTML | Add a query string or hard refresh |
| `workers.dev` will not open | The domain is DNS-poisoned | The site does not depend on it; bind a custom domain if needed |

---

## 8. Design decisions (why we do it this way)

> This section covers **reasons only**; for the details, see §2/§3.

1. **Pure static + direct browser connections**: no server cost; Eastmoney/Tencent endpoints send CORS headers and are directly reachable from mainland China.
   The collector only writes JSON, and Pages only distributes.
2. **Triggers live in a Cloudflare Worker**: GitHub scheduling has long fired only about 3% (measured over 26 days: 144 runs / 288 declared per day),
   so changing the in-repo cron only changes which rounds get swallowed. External cron depends neither on GitHub's scheduler nor on a local machine being on.
3. **Snapshots use K-lines, not real-time prices**: K-lines are historical data, so a rerun at any later time can reconstruct the true value;
   the source timestamp of a real-time price keeps moving after the close (15:32 → 16:26), so it cannot prove the price froze at the target time.
4. **Portfolio quotes merged into the high-frequency pipeline**: previously collected once a day at 16:30, when US stocks/London gold had not opened yet,
   so the "latest price" was always stuck on the previous trading day. Now ndx/xau/xag/brent run every 15 minutes, and daily-frequency instruments are taken at their publication times.
5. **Collection does not consume AI context**: collection is deterministic IO and belongs to scheduled tasks; the AI reads data only when asked.
6. **Three-source K-line race**: serial fallback makes users wait for Eastmoney to time out first; concurrency cuts the first screen from seconds to hundreds of milliseconds.
7. **Snapshot files written once**: archived by trading day and never overwritten, avoiding "morning session overwritten by afternoon session, no traceability".
8. **Data cached by freshness tier**: `latest` / `quotes` / today's archive day use `no-store`
   (first screen, 15s polling, still growing today); `search` / `index` / `_last-run` / historical archive days use browser cache
   (Pages `max-age=600`); up to 3 opened "days" stay in memory (LRU), so reopening does not re-download ~166KB (gzip).
9. **Pipeline health is derived directly, with no heartbeat file**: the footer status lights only read `_last-run.json` (source success / cloud or local),
   `latest.json` (time of the newest news item), and `quotes.json` (source time of each card).
   Collection may commit `data/` every 15 minutes, and another "heartbeat" would only keep growing the repository;
   `_last-run.json`'s `startedAt` can look old during quiet periods (it is not rewritten when content is unchanged), so freshness is based on
   **the newest item time**.
10. **History slices are one file per day, gap-only**: one request per day, LRU by day, written once and immutable;
    days already covered by `archive/` (with full text) are not exported as a summary version again — otherwise the same day has two truths and another 6 MB.
    Each day is compressed to 1-letter keys + omitted empty fields + a 400-item cap; measured about 320 days at about 16 MB total (30 MB budget gate).
11. **Briefing shares the archive key and fetches its body only on expand**: the index only adds `hasBriefing` + one `briefLine` of ≤80 characters,
    with no new index file and no prefetch of 365 briefings on the first screen/archive page; the day's JSON is requested only when the collapsed block is expanded,
    with `max-age=600` for historical days and `no-store` for today.
12. **Pipeline belongs to scripts, writing belongs to the LLM (2.3.0)**: scripts only fetch data, dedupe, score candidates, persist input, validate, write to disk,
    index, report status, lock, and apply criteria; all semantic judgment goes to the LLM. The status file is separate (`_briefing-status.json`),
    criteria look only at artifact completeness and `endedAt` (not `generatedAt`); when a catch-up is missing, it only prepares a snapshot,
    never generates a rule-based version; simulations and tests always write to a temporary directory (see 2.2.1 spec §13/§14, 2.3.0 spec).

### 8.1 Visual contract (read this before changing styles)

**Lineage**: this site's visual design inherits from `micro-control-finance` (academic-paper style · serif body · paper-white background · single accent color).
Similarity is lineage, not copying. **mcf's `--mcf-*` tokens and this site's generic names have already diverged; do not sync or merge them**
(both sites evolve independently, and a shared token package is outside this repository's scope). This site treats `:root` in `assets/style.css` as the single source of truth.

| Token | Value | Use |
|---|---|---|
| `--bg` / `--surface` | `#fdfdfb` / `#ffffff` | Paper background / card background |
| `--ink` / `--ink-soft` / `--ink-mute` / `--ink-faint` | `#1a1a1a` / `#3a3a3a` / `#6b6b6b` / `#9a9a9a` | Body / secondary / caption / placeholder |
| `--rule` / `--rule-strong` | `#e5e2da` / `#c9c4b7` | Thin divider / heavy table-header rule |
| `--accent` / `--accent-soft` | `#2c5e8e` / `#d6e3ee` | Accent (links, selection, emphasis bar) / light background |
| `--warm` | `#8b5a2b` | Warm brown: note left border, footer "attention" light |
| `--up` / `--down` | `#b3261e` / `#1a6b3c` | Up / down (**text** uses darker colors for contrast on paper) |
| `--code-bg` | `#f5f3ec` | Code block / table header background |
| `--serif` / `--sans` | Song/serif stack / Hei/sans stack | Serif body; sans for buttons, headers, numbers |

**File ownership** (colors may come only from these places):

| File | Responsibility |
|---|---|
| `assets/style.css` | Site-wide layout, typography, components, footer status lights; **the site's only CSS** |
| `assets/kline.js` | Chart-specific colors: `UP=#d93025` / `DOWN=#1a9e5f` (brighter than the CSS tokens: thin lines and candles need it on paper), `MA_COLOR` (5/10/20/30/60/120/250), axis gray `#8a8a8a` |
| `assets/app.js` | Page rendering: only adds class names to elements (`.up` / `.down` / `.ft-state`); all colors are left to style.css |
| `assets/market.js` | Quote / K-line fetching, no colors (charts are drawn by kline.js) |
| `assets/icon.svg` | Site icon: accent stroke + warm-brown polyline + paper-white background (sync this when changing the accent/paper color) |

**Color-change recipe (touch only these places; do not globally replace color values)**:

1. Change the accent: `--accent` + `--accent-soft` (style.css), then sync the `icon.svg` stroke;
   if you want MA lines to follow, also change `MA_COLOR[10]` in `kline.js`.
2. Change the paper color: adjust `--bg` / `--surface` / `--code-bg` / `--rule` / `--rule-strong` **together**,
   otherwise dividers will "float" above the background.
3. Change up/down colors: change both the CSS `--up` / `--down` and `kline.js` `UP` / `DOWN`
   (the two sets are intentional, not an omission: text needs to be dark, thin lines need to be bright).

**Three hard constraints**:

- Serif body; sans for buttons/headers/numbers; all numbers use `tabular-nums`.
- Touch targets ≥ 40px (phone buttons 40 / 34px, bottom nav in 4 equal parts + safe area).
- Canvas colors only recognize constants in `kline.js`; CSS cannot override them (charts do not read CSS variables).

### 8.2 Two things we deliberately do not do (decision 2026-11-07)

**① Nasdaq futures (NQ) — not added for now.** Fetching is not the obstacle (Eastmoney `103.NQ00Y` returns live quotes,
daily/weekly/monthly and minute K-lines; Sina `hf_NQ` also works), but CME trades **23 hours a day**, which collides with
this site's "close-of-day finalisation" model: `MARKET_SESSIONS.US` is 09:30–16:00, daily K is finalised at 16:00 ET,
and the pm snapshot samples at 16:12. NQ's "daily" bar actually covers 07:00 Beijing → 06:00 next day, so attaching it as-is
would make the pm snapshot record an **intraday price as the close** (the same class of bug hit India on 11-06) and would
finalise the daily bar on the wrong date. `ndx` (Nasdaq 100) already covers the same underlying. If it is ever added,
a new `FUT` session type (its own session window and its own finalisation time) is required — `US` must not be reused.

**② No expansion to individual stocks.** The quote side has ample headroom: `ulist` returned 600 instruments in one call,
74 ms, 600/600 priced (URL only 5.5 KB). The bottlenecks are elsewhere: ① **K-line request volume** — 300 constituents
would push hourly K-line requests from 70 to 370, far beyond the ban threshold documented in `src/em.mjs`
(105–147 requests per round already triggers socket-level rejection of the push2 host family);
② **repository size** — about 677 KB of K-line per instrument, i.e. roughly 200 MB of new blobs per day for 300 stocks,
and the GitHub 5 GB soft limit would be full in about six months. A few dozen names is neither enough to be a "stock quotes"
feature nor cheap enough to justify the same scheduling cost, so we skip it.

---

## 9. Known limitations / TODO

- News body coverage is not 100%: the PBoC and ECB have titles only (the originals are in PDFs).
- `search.json` is about 6 MB (gzip about 1–2 MB, latest 62 news days, no summary): **prefetched only when the search box is focused or typing starts**, so the first screen/archive no longer competes for bandwidth with it;
  the first full-text search must wait for the index to download (Pages bandwidth measured at 5~30 KB/s).
- **Historical search is browse-based**: `data/history/` covers the trailing year (about 320 days / about 16 MB, mostly titles, a few summaries),
  but `search.json` still covers only the latest ~62 days — a full 365-day index is about 60 MB, not feasible in a browser.
  For cross-year search, use the local `scripts/news-db/query.mjs`; do not pour it into the static site.
- cron does not know official holidays: quotes keep the previous trading day, and snapshots simply write no file (normal behavior).
- `data/archive/` keeps growing; the archive strategy is worth re-evaluating after a year.
- Shanghai gold before 17:00 and the ChinaBond curve late in the evening are not yet published; for an accurate closing price on the day, use `etf_518880` (gold ETF).
- **Spot gold/silver quote sources (Tencent/Sina `hf_*`) freeze at 04:55**, while the official close is 05:00. Measured 2026-10-30:
  London gold 3876.69 (04:55) vs Wind 3875.19 / Tonghuashun 3875.06 / Alipay 3875.02, a difference of about 1.67 (0.04%).
- **London gold minute K**: Eastmoney `122.XAU` "gold/USD · spot" has daily and 1m/5m/15m/30m/60m (measured 2026-11-03);
  its same-day close differs from Sina global `XAU` by at most **0.054% over 15 trading days** — the same instrument and the same line.
  Division of labor: **daily/weekly/monthly use Sina global** (thousands of bars since 2006), **minute uses Eastmoney 122.XAU**;
  international commodities have no multi-year minute history (1m ≈ 1~2 trading days, 5m/30m hundreds of bars); missing is missing, do not fake it with daily bars.
- **Brent is a continuous contract** (Sina global OIL): it has a basis spread against the "December contract" in the news,
  2026-10-30 continuous 113.4 vs December contract 117.64 (about 4 USD), but the change is the same (+2.4%).

---

## Appendix A: Data sources

| Category | Source | What it provides | Fallback |
|---|---|---|---|
| Quotes | Eastmoney `ulist.np` | Latest prices for 26 indices + 32 ETFs (1 request) | Tencent `qt.gtimg.cn` |
| K-lines | Eastmoney `push2his` | Daily/weekly/monthly + minute | Tencent `ifzq.gtimg.cn`; Sina (CN 10 indices only) |
| Portfolio | Tencent `hf_XAU` / `hf_XAG` / `hf_OIL` / `usNDX` | London gold/silver, Brent, Nasdaq 100 | Eastmoney `100.NDX100` |
| Portfolio | SGE official site | Shanghai gold Au99.99 | estimated fallback (note=estimated) |
| Portfolio | China Foreign Exchange Trade System `ccpr.json` | CNY central parity rate | None (since 2.15.0 the offshore rate is no longer substituted) |
| Portfolio | ChinaBond `queryGjqxInfo` | 1Y government-bond yield | none |
| Macro | Eastmoney data center / PBoC / NBS | margin financing, 10Y US Treasury, social financing, CPI, PMI | SSE+SZSE / FRED |
| News | Wallstreetcn / Eastmoney / Sina / China News Service / PBoC / Fed / ECB / NBS | flash news and policy releases | none |

Fetch infrastructure `src/em.mjs`: host mirrors, 90ms global rate limit, exponential backoff, **circuit breakers isolated by host group**, disk cache.

## Appendix B: Directory layout

```
macro-news/
├── index.html / .nojekyll / start.cmd
├── assets/            style.css · app.js · market.js · kline.js · fuse.min.js · icon.svg
├── data/              collection output (committed; Pages reads it directly)
│   ├── quotes.json · latest.json · search.json · index.json · _last-run.json
│   ├── snapshots/     point-in-time snapshots (authoritative closing prices)
│   ├── archive/       news by day (with full text)
│   ├── history/       trailing-year history slices (title/summary + index.json)
│   ├── briefings/     the day's briefing JSON (same key as the date)
│   ├── kline/         daily/weekly/monthly + _full + min/
│   └── macro/daily.json
├── .local/            local private (already in .gitignore)
│   ├── news.db        news database (SQLite + FTS5, about 530k rows)
│   ├── briefings/     daily briefing YYYY-MM-DD.json / .md
│   └── runs/          2.3.0 three-stage intermediates (input/outline/draft/final + prompt)
├── scripts/news-db/   news database: db · history-slice · import-archive · brief-candidates · query · backfill-*
├── src/
│   ├── collect.mjs    news + quote main program (--no-kline / --kline-only)
│   ├── brief-meta.mjs briefing index metadata (hasBriefing / briefLine)
│   ├── sources.mjs    news sources + 26 index adapters + fetchKline
│   ├── quotes.mjs     batch quotes (Eastmoney → Tencent)
│   ├── kline.mjs      daily K / 5-minute K (Eastmoney → Tencent)
│   ├── em.mjs         mirrors / rate limit / backoff / circuit breaker / cache
│   ├── snapshot.mjs   point-in-time snapshots (am/pm, with the close-time table in §3.1)
│   ├── portfolio.mjs  12 portfolio quotes + 5 macro indicators
│   └── portfolio-collect.mjs  macro + 1Y government-bond daily K (after 17:00 on workdays, cloud)
├── scripts/           serve · export-history · push-data.sh · update-kline-{full,minute,last} · PowerShell tasks
├── scripts/briefing/  prepare · publish · pipeline · generate · ensure · core · run-ensure.ps1 (briefing three stages and fallback)
├── docs/superpowers/specs/  design docs (2.2.0 history news / 2.2.1 briefing resilience / 2.3.0 three stages)
└── worker/gh-cron/    Cloudflare external trigger (narrow responsibility, dispatch only)
```

## Appendix C: History and deprecated approaches

- **GitHub schedule era**: once declared `*/5` for 5 minutes, but measured only once every 3~6 hours; replaced by the Worker external trigger.
- **Cloudflare Worker quote proxy**: early on it was meant to bypass CORS and serve readers, but `workers.dev` was measured to be DNS-poisoned
  and unreachable from mainland China; Eastmoney endpoints already send CORS anyway ⇒ **no longer a reader-facing entry point**. Re-enabled in 2.4.0 as a **scheduled sampling backup**
  (Eastmoney three mirrors → Tencent → Yahoo, output `source`); neither the frontend nor the collector depends on it; `/kline` covers only 26 indices.
- **Serial K-line fallback**: replaced by the three-source concurrent race.
- **16:30 portfolio quote pipeline**: merged into the 15-minute pipeline; macro moved to the cloud **after 17:00** (2026-10-31).
- **minimax scheduled tasks**: once handled 12:05 / 16:30 snapshots, 16:30 macro, and 4-hour sync;
  the quota was uncontrollable and it was measured to be off-schedule (the 10-30 macro only ran at 19:28). All were retired on 2026-10-31;
  snapshots/macro now fall back to `snapshot.yml`, and remote sync moved to a Windows scheduled task.
