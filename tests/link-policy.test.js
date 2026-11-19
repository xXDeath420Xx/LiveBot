import test from 'node:test';
import assert from 'node:assert/strict';
import { extractLinks, registrable, classifyHost, classifyMessage, promotionSubject } from '../core/link-policy.js';

const verdict = (s, opts) => classifyMessage(s, opts).verdict;

test('extracts links with or without a scheme', () => {
  assert.deepEqual(extractLinks('go to twitch.tv/someone').map(l => l.host), ['twitch.tv']);
  assert.deepEqual(extractLinks('https://www.youtube.com/watch?v=x').map(l => l.host), ['youtube.com']);
  assert.deepEqual(extractLinks('a.com and b.net').map(l => l.host), ['a.com', 'b.net']);
});

test('sentences are not mistaken for domains', () => {
  // Without a TLD check, "thanks. also" parses as the domain "thanks.also".
  for (const s of ['thanks. also here', 'i said no.thats it', 'v1.2 released', 'e.g. this one']) {
    assert.deepEqual(extractLinks(s), [], `false link in: ${s}`);
  }
});

test('sees through obfuscation, which is itself the tell', () => {
  for (const s of ['fiverr [dot] com', 'fiverr(dot)com', 'hxxps://fiverr.com', 'fiverr dot com']) {
    assert.equal(verdict(s), 'block', `missed: ${s}`);
  }
});

test('registrable domain collapses subdomains', () => {
  assert.equal(registrable('clips.twitch.tv'), 'twitch.tv');
  assert.equal(registrable('cdn.example.co.uk'), 'example.co.uk');
  assert.equal(registrable('twitch.tv'), 'twitch.tv');
});

test('social platforms are allowed', () => {
  for (const s of [
    'https://twitch.tv/somestreamer', 'youtu.be/abc123', 'check my tiktok.com/@me',
    'x.com/someone', 'https://bsky.app/profile/me', 'kick.com/someone',
  ]) assert.equal(verdict(s), 'allow', `wrongly flagged: ${s}`);
});

test('subdomains of an allowed platform are allowed', () => {
  assert.equal(verdict('https://clips.twitch.tv/AbcDef'), 'allow');
  assert.equal(verdict('https://m.youtube.com/watch?v=x'), 'allow');
});

test('chat plumbing is allowed — filtering it would just break the client', () => {
  for (const s of [
    'https://tenor.com/view/cat-gif-123', 'https://cdn.discordapp.com/attachments/1/2/a.png',
    'https://i.imgur.com/abc.png', 'https://open.spotify.com/track/x',
  ]) assert.equal(verdict(s), 'allow', `wrongly flagged: ${s}`);
});

test('shorteners and commission marketplaces are blocked', () => {
  for (const s of [
    'bit.ly/3xyz', 'https://tinyurl.com/abc', 'linktr.ee/someone',
    'https://fiverr.com/someone/logo', 'vgen.co/artist', 'carrd.co/me',
  ]) assert.equal(verdict(s), 'block', `should be blocked: ${s}`);
});

test('unrecognised domains follow the unknown policy', () => {
  assert.equal(verdict('https://some-random-site.xyz/thing'), 'review');
  assert.equal(verdict('https://some-random-site.xyz/thing', { unknown: 'block' }), 'block');
});

test('monetisation links follow their own policy', () => {
  assert.equal(verdict('ko-fi.com/someone'), 'review');
  assert.equal(verdict('ko-fi.com/someone', { monetisation: 'allow' }), 'allow');
  assert.equal(verdict('patreon.com/someone', { monetisation: 'block' }), 'block');
});

test('a guild allowlist overrides the defaults', () => {
  assert.equal(verdict('https://ourwiki.example.com/page'), 'review');
  assert.equal(verdict('https://ourwiki.example.com/page', { allow: ['example.com'] }), 'allow');
  // ...and a guild can ban a platform the defaults allow
  assert.equal(verdict('https://tiktok.com/@x', { deny: ['tiktok.com'] }), 'block');
});

test('deny beats allow when a guild lists both', () => {
  assert.equal(verdict('https://foo.com', { allow: ['foo.com'], deny: ['foo.com'] }), 'block');
});

test('the strictest link in a message decides it', () => {
  // A social link does not launder a blocked one posted alongside it.
  assert.equal(verdict('my stream twitch.tv/me and my shop fiverr.com/me'), 'block');
  assert.equal(verdict('twitch.tv/me and some-random.xyz'), 'review');
  const r = classifyMessage('twitch.tv/me and my shop fiverr.com/me');
  assert.equal(r.worst.host, 'fiverr.com');
  assert.equal(r.links.length, 2);
});

test('messages with no links are untouched', () => {
  assert.equal(verdict('hello everyone, how is it going'), 'allow');
  assert.deepEqual(classifyMessage('no links here').links, []);
});

test('empty and non-string content is safe', () => {
  for (const v of ['', null, undefined]) assert.equal(verdict(v), 'allow');
});

test('unusual TLDs are visible — the filter must not fail open', () => {
  // linktr.ee, is.gd and redd.it were silently invisible when TLDs were enumerated,
  // which meant an unrecognised link was allowed rather than blocked.
  for (const [s, want] of [
    ['linktr.ee/someone', 'block'], ['is.gd/abc', 'block'], ['redd.it/xyz', 'allow'],
    ['weird-domain.zz/path', 'review'], ['some-shop.gd', 'review'],
  ]) assert.equal(verdict(s), want, `${s} should be ${want}`);
});

// ── who the link is about (auto-track veto) ─────────────────────────────────
test('boosting another creator is recognised as third-party', () => {
  for (const s of [
    'go watch twitch.tv/somebody they are amazing',
    'check out this guy twitch.tv/coolstreamer',
    "he's live right now! kick.com/someone",
    'everyone go follow youtube.com/@person',
    'shoutout to my friend twitch.tv/buddy',
    'support them if you can, twitch.tv/creator',
    'this streamer is so underrated twitch.tv/x',
  ]) assert.equal(promotionSubject(s), 'third-party', `missed: ${s}`);
});

test('promoting your own channel is recognised as self', () => {
  for (const s of [
    "i'm live! twitch.tv/me",
    'my stream is up twitch.tv/me',
    'come watch me at kick.com/me',
    "i'll be live in 10, twitch.tv/me",
    'follow me youtube.com/@me',
  ]) assert.equal(promotionSubject(s), 'self', `misread: ${s}`);
});

test('a bare link stays unknown — the name gate decides, not this', () => {
  assert.equal(promotionSubject('https://twitch.tv/someone'), 'unknown');
  assert.equal(promotionSubject('twitch.tv/me 🎮'), 'unknown');
  assert.equal(promotionSubject(''), 'unknown');
});

test('third-party framing outranks first-person wording in the same message', () => {
  // "my friend" + "my stream" — the risk of auto-tracking someone else's channel is worse.
  assert.equal(promotionSubject('my friend is live, way better than my stream: twitch.tv/them'), 'third-party');
});
