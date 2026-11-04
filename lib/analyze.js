// Pure functions: turn raw X data (from the TikHub tools sold through buy) into an audit.
// Response shapes from upstream APIs vary, so every reader below tries several key names.

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

const pick = (obj, keys) => {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    const parts = k.split('.');
    let cur = obj;
    for (const p of parts) {
      if (cur && typeof cur === 'object' && p in cur) cur = cur[p];
      else { cur = undefined; break; }
    }
    if (cur !== undefined && cur !== null && cur !== '') return cur;
  }
  return undefined;
};

// Unwrap the common envelopes: {data: {...}}, {data: {data: {...}}}, {result: ...}
export function unwrap(raw) {
  let cur = raw;
  for (let i = 0; i < 4; i++) {
    if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
      const inner = cur.data ?? cur.result ?? cur.body;
      if (inner && typeof inner === 'object') { cur = inner; continue; }
    }
    break;
  }
  return cur;
}

// Find the largest array of objects anywhere in the tree whose items look like `test`.
export function findArray(raw, test, depth = 0) {
  if (!raw || typeof raw !== 'object' || depth > 7) return [];
  let best = [];
  if (Array.isArray(raw)) {
    const objs = raw.filter((x) => x && typeof x === 'object');
    if (objs.length && objs.filter(test).length >= Math.ceil(objs.length / 2)) best = objs;
    for (const item of raw) {
      const r = findArray(item, test, depth + 1);
      if (r.length > best.length) best = r;
    }
    return best;
  }
  for (const v of Object.values(raw)) {
    const r = findArray(v, test, depth + 1);
    if (r.length > best.length) best = r;
  }
  return best;
}

// X's GraphQL style nests user fields under `legacy`; flatten that for reading.
const flatUser = (u) => {
  if (!u || typeof u !== 'object') return {};
  const res = u.result ?? u;
  const legacy = res.legacy ?? {};
  const core = res.core ?? {};
  return { ...res, ...core, ...legacy, avatar_obj: res.avatar };
};

export function readProfile(raw) {
  let d = unwrap(raw);
  if (d && d.user) d = d.user;
  const u = flatUser(d);
  const created = pick(u, ['created_at', 'createdAt', 'created']);
  return {
    name: pick(u, ['name', 'display_name']) ?? null,
    handle: pick(u, ['profile', 'screen_name', 'screenName', 'username', 'userName']) ?? null,
    id: String(pick(u, ['rest_id', 'id_str', 'user_id', 'id']) ?? ''),
    bio: pick(u, ['desc', 'description', 'bio']) ?? '',
    avatar: pick(u, ['avatar', 'profile_image_url_https', 'profile_image_url', 'profile_image', 'avatar_obj.image_url', 'profilePicture']) ?? null,
    followers: num(pick(u, ['sub_count', 'followers_count', 'followersCount', 'followers', 'normal_followers_count'])),
    following: num(pick(u, ['friends', 'friends_count', 'following_count', 'followingCount', 'following'])),
    tweets: num(pick(u, ['statuses_count', 'statusesCount', 'tweet_count', 'tweets_count'])),
    verified: Boolean(pick(u, ['blue_verified', 'is_blue_verified', 'isBlueVerified', 'verified', 'isVerified'])),
    createdAt: created ? new Date(created).toISOString() : null,
    location: pick(u, ['location']) ?? '',
  };
}

const looksLikeTweet = (t) => {
  const x = t.legacy ?? t.tweet?.legacy ?? t;
  return ('favorite_count' in x || 'favorites' in x || 'likeCount' in x || 'likes' in x) &&
    ('text' in x || 'full_text' in x || 'tweet_id' in x || 'id_str' in x);
};

export function readTweets(raw, handle) {
  const arr = findArray(raw, looksLikeTweet);
  const out = [];
  for (const t of arr) {
    const x = { ...(t.tweet ?? t), ...((t.tweet ?? t).legacy ?? {}) };
    const text = String(pick(x, ['full_text', 'text']) ?? '');
    const author = pick(x, ['author.screen_name', 'author.userName', 'author.username', 'user.screen_name']);
    const isRetweet = text.startsWith('RT @') || Boolean(x.retweeted_status_result || x.retweeted_tweet || x.retweeted);
    const id = String(pick(x, ['tweet_id', 'id_str', 'rest_id', 'id']) ?? '');
    const tweet = {
      id,
      text,
      createdAt: (() => { const c = pick(x, ['created_at', 'createdAt']); return c ? new Date(c).toISOString() : null; })(),
      likes: num(pick(x, ['favorites', 'favorite_count', 'likeCount', 'likes'])) ?? 0,
      retweets: num(pick(x, ['retweets', 'retweet_count', 'retweetCount'])) ?? 0,
      replies: num(pick(x, ['replies', 'reply_count', 'replyCount'])) ?? 0,
      quotes: num(pick(x, ['quotes', 'quote_count', 'quoteCount'])) ?? 0,
      views: num(pick(x, ['views', 'viewCount', 'views.count', 'ext_views.count'])),
      isRetweet,
      isOwn: !author || !handle || String(author).toLowerCase() === String(handle).toLowerCase(),
    };
    tweet.url = id && handle ? `https://x.com/${handle}/status/${id}` : null;
    out.push(tweet);
  }
  // de-duplicate by id
  const seen = new Set();
  return out.filter((t) => (t.id && seen.has(t.id) ? false : (seen.add(t.id), true)));
}

const looksLikeUser = (u) => {
  const x = flatUser(u);
  return ('followers_count' in x || 'sub_count' in x || 'followersCount' in x) &&
    ('screen_name' in x || 'profile' in x || 'userName' in x || 'username' in x);
};

export function readFollowers(raw) {
  return findArray(raw, looksLikeUser).map((u) => {
    const p = readProfile(u);
    p.defaultAvatar = !p.avatar || /default_profile/i.test(String(p.avatar));
    return p;
  });
}

const DAY = 86400000;

// Heuristics that, together, suggest a bot / bought / dead follower.
export function followerFlags(f, now = Date.now()) {
  const flags = [];
  if (f.defaultAvatar) flags.push('no profile photo');
  if (!f.bio || !String(f.bio).trim()) flags.push('empty bio');
  if ((f.tweets ?? 0) === 0) flags.push('never posted');
  if ((f.followers ?? 0) < 10 && (f.following ?? 0) > 200) flags.push('follows many, followed by almost none');
  if (f.createdAt && now - Date.parse(f.createdAt) < 90 * DAY) flags.push('account < 90 days old');
  if (/\d{6,}$/.test(String(f.handle ?? ''))) flags.push('auto-generated handle');
  return flags;
}

const median = (xs) => {
  const s = xs.filter((x) => x !== null && x !== undefined).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (n, d = 2) => (n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

export function analyze({ profile, tweets, followers, now = Date.now() }) {
  const own = tweets.filter((t) => t.isOwn && !t.isRetweet);
  const sample = own.length ? own : tweets;
  const eng = (t) => t.likes + t.retweets + t.replies + t.quotes;
  const fol = profile.followers || 0;

  const medianEngagement = median(sample.map(eng));
  const medianLikes = median(sample.map((t) => t.likes));
  const medianViews = median(sample.map((t) => t.views).filter((v) => v !== null));
  const engagementRate = fol > 0 && medianEngagement !== null ? (medianEngagement / fol) * 100 : null; // %
  const viewRate = fol > 0 && medianViews !== null ? (medianViews / fol) * 100 : null; // %
  const replyShare = sample.length ? sample.reduce((a, t) => a + t.replies, 0) / Math.max(1, sample.reduce((a, t) => a + eng(t), 0)) : null;

  // Follower sample
  const flagged = followers.map((f) => ({ ...f, flags: followerFlags(f, now) }));
  const suspicious = flagged.filter((f) => f.flags.length >= 2);
  const suspiciousPct = followers.length ? (suspicious.length / followers.length) * 100 : null;
  const flagCounts = {};
  for (const f of flagged) for (const fl of f.flags) flagCounts[fl] = (flagCounts[fl] || 0) + 1;

  // Posting cadence
  const dates = sample.map((t) => t.createdAt).filter(Boolean).map(Date.parse).sort((a, b) => b - a);
  const spanDays = dates.length > 1 ? (dates[0] - dates[dates.length - 1]) / DAY : null;
  const postsPerWeek = spanDays && spanDays > 0 ? (dates.length / spanDays) * 7 : null;
  const lastPostDaysAgo = dates.length ? (now - dates[0]) / DAY : null;
  const ageDays = profile.createdAt ? (now - Date.parse(profile.createdAt)) / DAY : null;
  const ffRatio = profile.following ? fol / profile.following : null;

  // Score (0-100). Each pillar is 0-25.
  // Engagement: 1% median engagement rate (for accounts >1k) is healthy; small accounts get a softer curve.
  const engTarget = fol < 1000 ? 3 : fol < 20000 ? 1 : fol < 200000 ? 0.4 : 0.15;
  const pEngagement = engagementRate === null ? 10 : clamp((engagementRate / engTarget) * 25, 0, 25);
  const viewTarget = fol < 1000 ? 40 : fol < 20000 ? 15 : fol < 200000 ? 6 : 3;
  const pReach = viewRate === null ? 12 : clamp((viewRate / viewTarget) * 25, 0, 25);
  const pAudience = suspiciousPct === null ? 12 : clamp(25 - Math.max(0, suspiciousPct - 10) * 0.5, 0, 25);
  let pActivity = 25;
  if (lastPostDaysAgo === null) pActivity = 8;
  else if (lastPostDaysAgo > 30) pActivity = 5;
  else if (lastPostDaysAgo > 7) pActivity = 15;
  if (postsPerWeek !== null && postsPerWeek < 1) pActivity = Math.min(pActivity, 12);
  const score = Math.round(pEngagement + pReach + pAudience + pActivity);

  const grade = score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 50 ? 'C' : score >= 35 ? 'D' : 'F';

  const redFlags = [];
  const greenFlags = [];
  if (suspiciousPct !== null && suspiciousPct >= 40) redFlags.push(`${Math.round(suspiciousPct)}% of sampled followers look like bots or dead accounts`);
  else if (suspiciousPct !== null && suspiciousPct >= 25) redFlags.push(`${Math.round(suspiciousPct)}% of sampled followers show bot or dead-account signals — above the ~15% you'd expect`);
  else if (suspiciousPct !== null && suspiciousPct <= 15) greenFlags.push(`Only ${Math.round(suspiciousPct)}% of sampled followers look fake or inactive`);
  if (engagementRate !== null && engagementRate < engTarget * 0.25 && fol > 2000) redFlags.push(`Engagement is very low for ${fmt(fol)} followers (median ${round(engagementRate, 3)}% per post)`);
  if (engagementRate !== null && engagementRate >= engTarget) greenFlags.push(`Healthy engagement: median ${round(engagementRate, 2)}% of followers interact per post`);
  if (viewRate !== null && viewRate < viewTarget * 0.25 && fol > 2000) redFlags.push(`Posts reach only ~${round(viewRate, 1)}% of followers in views`);
  if (viewRate !== null && viewRate >= viewTarget) greenFlags.push(`Strong reach: median post is seen by ~${round(viewRate, 1)}% of follower count`);
  if (lastPostDaysAgo !== null && lastPostDaysAgo > 30) redFlags.push(`No original post in ${Math.round(lastPostDaysAgo)} days`);
  if (ageDays !== null && ageDays < 180 && fol > 20000) redFlags.push(`Account is ${Math.round(ageDays)} days old but already has ${fmt(fol)} followers`);
  if (replyShare !== null && replyShare > 0.6 && sample.length >= 5) redFlags.push('Replies outweigh likes and reposts — check for reply-farming or bot replies');
  if (profile.verified) greenFlags.push('Verified account');

  const topPosts = [...sample].sort((a, b) => eng(b) - eng(a)).slice(0, 3).map((t) => ({ ...t, engagement: eng(t) }));

  return {
    score,
    grade,
    pillars: {
      engagement: Math.round(pEngagement),
      reach: Math.round(pReach),
      audience: Math.round(pAudience),
      activity: Math.round(pActivity),
    },
    metrics: {
      followers: fol,
      following: profile.following,
      followerFollowingRatio: round(ffRatio, 1),
      accountAgeDays: ageDays === null ? null : Math.round(ageDays),
      postsAnalyzed: sample.length,
      medianLikes,
      medianEngagement,
      medianViews,
      engagementRatePct: round(engagementRate, 3),
      viewRatePct: round(viewRate, 2),
      postsPerWeek: round(postsPerWeek, 1),
      lastPostDaysAgo: lastPostDaysAgo === null ? null : round(lastPostDaysAgo, 1),
      followersSampled: followers.length,
      suspiciousFollowerPct: round(suspiciousPct, 1),
      flagCounts,
    },
    redFlags,
    greenFlags,
    topPosts,
    suspiciousExamples: suspicious.slice(0, 5).map((f) => ({ handle: f.handle, flags: f.flags })),
  };
}

export function fmt(n) {
  if (n === null || n === undefined) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K';
  return String(Math.round(n));
}

// Plain-language verdict, used when the LLM call is unavailable (e.g. sandbox) or fails.
export function templateVerdict(profile, a) {
  const who = profile.name || '@' + profile.handle;
  const mood = a.score >= 80 ? 'looks genuinely healthy' : a.score >= 65 ? 'looks mostly real, with a few soft spots' : a.score >= 50 ? 'is mixed — some real traction, some warning signs' : a.score >= 35 ? 'shows several warning signs' : 'looks heavily inflated or inactive';
  const lines = [`${who} ${mood} (TrueReach score ${a.score}/100, grade ${a.grade}).`];
  if (a.redFlags.length) lines.push('Watch out: ' + a.redFlags.slice(0, 2).join('; ') + '.');
  if (a.greenFlags.length) lines.push('Good signs: ' + a.greenFlags.slice(0, 2).join('; ') + '.');
  return lines.join(' ');
}
