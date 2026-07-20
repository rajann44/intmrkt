import { NextResponse } from 'next/server';
import { getChannel } from '@/lib/config';
import { buildHashtags } from '@/lib/hashtags';
import { captionMarksTweetId, encodeHiddenTweetId } from '@/lib/hiddenId';
import { fetchRecentCaptions, instagramConfigured, publishImage } from '@/lib/instagram';
import { viralRewrite } from '@/lib/rewrite';
import { scrapeProfile } from '@/lib/scraper';
import {
  fetchTweetDetails,
  shouldSkipTweet,
  statusIdFromUrl,
  type TweetDetailsResult,
} from '@/lib/tweetDetails';

export const dynamic = 'force-dynamic';
// Scrape + card render + Instagram round-trips can exceed the default 10s.
export const maxDuration = 60;

/**
 * Cron-triggered endpoint: fetch the latest tweet for a channel (default:
 * the first channel in src/lib/config.ts, override with ?channel=<id>), and
 * if it hasn't been posted yet, publish its generated 4:5 card to Instagram.
 * Posts at most one tweet per invocation.
 *
 * Auth: requires `Authorization: Bearer <CRON_SECRET>` when CRON_SECRET is
 * set (always set it in production).
 * Dry run: when that channel's IG credentials are absent, reports what it
 * would post instead of posting.
 */
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const channel = getChannel(new URL(request.url).searchParams.get('channel'));

  // Scrape every handle in the channel and merge into one newest-first list.
  const perHandle = await Promise.all(
    channel.handles.map((handle) => scrapeProfile(handle, 5)),
  );
  if (perHandle.every((r) => !r.ok || r.urls.length === 0)) {
    return NextResponse.json(
      { posted: false, reason: `Scrape failed for all handles in channel "${channel.id}"` },
      { status: 502 },
    );
  }
  const mergedUrls = [...new Set(perHandle.flatMap((r) => r.urls))].sort((a, b) => {
    const idA = BigInt(statusIdFromUrl(a) ?? '0');
    const idB = BigInt(statusIdFromUrl(b) ?? '0');
    return idA < idB ? 1 : idA > idB ? -1 : 0;
  });

  // Dedupe against recent Instagram captions (each carries an invisible
  // marker encoding the tweet ID it was posted from — see src/lib/hiddenId.ts).
  // Guarded: an Instagram API hiccup here must not crash the whole request
  // with an opaque platform-level error — report it as a clean JSON 502.
  let captions: string[] = [];
  if (instagramConfigured(channel.id)) {
    try {
      captions = await fetchRecentCaptions(channel.id);
    } catch (err) {
      return NextResponse.json(
        {
          posted: false,
          reason: `Failed to check recent Instagram posts: ${err instanceof Error ? err.message : String(err)}`,
        },
        { status: 502 },
      );
    }
  }
  const candidateUrls = mergedUrls.filter((url) => {
    const id = statusIdFromUrl(url);
    // The .includes(id) check is a backward-compat fallback for posts made
    // before captions switched to the invisible marker (they had a visible
    // "Source: <tweet url>" line, which also contains the ID as a substring).
    return id && !captions.some((c) => captionMarksTweetId(c, id) || c.includes(id));
  });
  if (candidateUrls.length === 0) {
    return NextResponse.json({ posted: false, reason: 'No new tweet since last post' });
  }

  // Walk candidates newest-first, skipping tweets that share an external
  // link or name-drop "polymarket" in their own text — this app posts
  // self-contained, brand-neutral cards. Skip failed detail lookups too.
  let newUrl: string | null = null;
  let tweet: TweetDetailsResult | null = null;
  for (const url of candidateUrls) {
    const candidateId = statusIdFromUrl(url)!;
    const candidate = await fetchTweetDetails(candidateId, url);
    if (candidate.ok && candidate.details && !shouldSkipTweet(candidate.details)) {
      newUrl = url;
      tweet = candidate;
      break;
    }
  }
  if (!newUrl || !tweet?.details) {
    return NextResponse.json({
      posted: false,
      reason: 'No postable tweet found (all candidates were skipped or failed to load)',
    });
  }

  const id = statusIdFromUrl(newUrl)!;
  const baseUrl = process.env.PUBLIC_BASE_URL ?? new URL(request.url).origin;

  const cleanText = tweet.details.text.replace(/https?:\/\/t\.co\/\S+/g, '').trim();
  // One rewrite, used for both the on-image headline and the caption, so
  // the posted image and its caption always say the same thing. Falls back
  // to the original (link-stripped) tweet text if the rewrite is
  // unavailable or fails its fact-preservation check — see src/lib/rewrite.ts.
  //
  // Deliberately NOT also deriving the image-search gist here: measured live,
  // doing so added a full LLM round-trip (up to 8s) directly to this
  // request's own critical path whenever it was slow, which is worse than
  // leaving it inside /api/card's render — that render's slowness is at
  // least partly absorbed into Instagram's own fetch/processing time rather
  // than blocking our response to the caller (cron-job.org) directly.
  const displayText = await viralRewrite(cleanText, id);
  const imageUrl = `${baseUrl}/api/card/${id}?headline=${encodeURIComponent(displayText)}`;

  const hashtags = buildHashtags(tweet.details.text);
  // No visible source link — the tweet ID is embedded invisibly instead,
  // purely for our own dedupe check above.
  const caption = `${displayText}\n\n${hashtags.join(' ')}${encodeHiddenTweetId(id)}`;

  if (!instagramConfigured(channel.id)) {
    return NextResponse.json({
      posted: false,
      dryRun: true,
      channel: channel.id,
      reason: `Instagram not configured for channel "${channel.id}" — would have posted:`,
      wouldPost: { tweetUrl: newUrl, imageUrl, caption },
    });
  }

  // Pre-warm the card render before asking Instagram to fetch it. Measured
  // in production: a cold Vercel instance takes ~11s for this route (fonts,
  // the gist LLM call, and stock photo search are all cold on first hit);
  // the same URL warm takes ~0.4s. Instagram's own image-fetcher times out
  // well under 11s, failing with "media could not be fetched from this
  // URI" — a real error seen in production. Fetching it ourselves first
  // means Instagram's actual fetch (inside publishImage() below) lands on
  // an already-warm instance. Best-effort: if this fails, publishImage()
  // surfaces the real problem when Instagram itself tries to fetch it.
  try {
    await fetch(imageUrl, { signal: AbortSignal.timeout(45_000) });
  } catch {
    // Ignored — see comment above.
  }

  try {
    const mediaId = await publishImage(channel.id, imageUrl, caption);
    return NextResponse.json({ posted: true, channel: channel.id, tweetUrl: newUrl, imageUrl, mediaId });
  } catch (err) {
    return NextResponse.json(
      { posted: false, reason: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
