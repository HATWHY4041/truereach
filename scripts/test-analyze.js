// Offline check of the parsing + scoring logic with sample payloads in the shapes TikHub returns.
import { readProfile, readTweets, readFollowers, analyze, templateVerdict } from '../lib/analyze.js';

const now = Date.parse('2026-11-04T12:00:00Z');
const rawProfile = { code: 200, data: { profile: 'demoproj', rest_id: '123', name: 'Demo Protocol', desc: 'Building onchain', avatar: 'https://pbs.twimg.com/a.jpg', sub_count: 48200, friends: 310, statuses_count: 2100, blue_verified: true, created_at: 'Tue Jun 02 20:12:29 +0000 2021' } };
const rawTweets = { code: 200, data: { timeline: Array.from({ length: 12 }, (_, i) => ({ tweet_id: String(1000 + i), created_at: new Date(now - i * 2 * 86400000).toUTCString(), text: i === 3 ? 'RT @x: hi' : `Update ${i}`, favorites: 120 + i * 30, retweets: 20 + i, replies: 15, quotes: 2, views: String(9000 + i * 500), author: { screen_name: 'demoproj' } })) } };
const rawFollowers = { code: 200, data: { followers: Array.from({ length: 20 }, (_, i) => ({ screen_name: i < 7 ? `user${100000 + i}` : `real_${i}`, description: i < 7 ? '' : 'web3 dev', profile_image: i < 7 ? 'https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png' : 'https://pbs.twimg.com/b.jpg', statuses_count: i < 7 ? 0 : 400, followers_count: i < 7 ? 1 : 300, friends_count: i < 7 ? 900 : 200, created_at: i < 7 ? new Date(now - 20 * 86400000).toUTCString() : 'Mon Jan 01 00:00:00 +0000 2019' })) } };

const profile = readProfile(rawProfile);
const tweets = readTweets(rawTweets, profile.handle);
const followers = readFollowers(rawFollowers);
const a = analyze({ profile, tweets, followers, now });
console.log(JSON.stringify({ profile, nTweets: tweets.length, nFollowers: followers.length, score: a.score, grade: a.grade, pillars: a.pillars, metrics: a.metrics, red: a.redFlags, green: a.greenFlags }, null, 2));
console.log(templateVerdict(profile, a));
const ok = profile.followers === 48200 && tweets.length === 12 && followers.length === 20 && a.metrics.suspiciousFollowerPct === 35;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
