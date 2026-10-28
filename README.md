# Arabi Whisper

Read Egyptian Arabic songs the way they're sung. While a song plays on Spotify (on any of your devices), this page shows its lyrics line by line:

- the Arabic, as written
- how it sounds, in plain English letters (spelling guide under **Sounds**)
- what it means in English
- every word: tap it to see its meaning and a grammar note, and + to make it a flashcard. A verb also has its **Conjugation**: all its tenses, from [Wiktionary](https://en.wiktionary.org) (CC BY-SA 4.0) in the app's spelling, kept in `verbs.json`, so it opens at once and offline. For the verbs Wiktionary has no table for, it comes from the [lisaanmasry.org](https://www.lisaanmasry.org) Egyptian Arabic dictionary (© Mike Green, free for non-commercial use), as that site has them and in its own spelling, through the sync database below

The **Grammar** tab is a reference to Egyptian grammar in 22 topics, from sounds, nouns and verbs to questions, numbers, time and greetings, spelled the same way as the lyrics. It covers what the grammar on [lisaanmasry.org](https://www.lisaanmasry.org/grammar/introduction.html) covers, written for this app and checked against it; each topic links to its chapter there, which has recordings.

The **Flashcards** tab is for practising those words any time, even with no song playing, and with no connection. Each word is practised both ways: from the Arabic and its sound to the meaning, and from the meaning to the Arabic. The back shows both, the note and the lyric lines the word came from, each with its song: tap the song to play it on Spotify from that line. A word is one card, however it is spelled and whichever line you add it from. Each way keeps its own schedule: what you know comes back less often (after 1, 3, 7, 14, 30, then 90 days), and "Again" brings it back in the same session.

With timed lyrics, the line being sung lights up and the page scrolls along. The bar at the bottom shows how far into the song you are (1:27 of 2:31), plays, pauses and skips songs on Spotify, and tapping a line plays the song from there.

Live at **https://eymeraj.github.io/arabi-whisper/**. It's a static page: your Gemini key and Spotify login stay in your browser. The only server is an optional sync database of your own. Once opened, the page keeps a copy of itself (`sw.js`), so it opens offline too: flashcards and songs already converted work, and practice syncs when you're back online.

## One-time setup

**1. Gemini key (free).** Create a key at [Google AI Studio](https://aistudio.google.com/apikey) and paste it into the page's Settings on each device. Keep billing off for that Google project: with billing on, Google charges for requests instead of using the free tier.

**2. Spotify app (needs Spotify Premium).** Spotify only lets Premium accounts create the developer app this page uses to see what's playing.

1. Open the [Spotify developer dashboard](https://developer.spotify.com/dashboard) and choose **Create app**.
2. Add both redirect URIs exactly as written (the trailing slash matters):
   - `https://eymeraj.github.io/arabi-whisper/`
   - `http://127.0.0.1:8000/` (for running it locally)
3. Under "Which API/SDKs are you planning to use?", tick **Web API**, then save.
4. Copy the app's **Client ID** into `SPOTIFY_CLIENT_ID` at the top of `app.js`. The Client ID is public by design, so it is fine in the code.
5. If Spotify refuses access after you log in, add your Spotify account's email under the app's **User Management**.

**3. Sync database (optional, free).** Without it, each device converts a song once. With it, a song converted on any of your devices is ready on all of them, and costs one Gemini request in total, and your flashcards and their progress follow you too. It is a [Cloudflare Worker](https://developers.cloudflare.com/workers/) with a [D1](https://developers.cloudflare.com/d1/) database (tables `songs` and `flashcards`, one row each), both on Cloudflare's free plan. It also looks up a verb on lisaanmasry.org the first time you open its conjugation and keeps it (table `verbs`), so the dictionary's site sees one visit per verb. From the `worker` folder:

```sh
npx wrangler login
npx wrangler d1 create arabi-whisper   # put the database_id it prints into wrangler.toml
npx wrangler d1 execute arabi-whisper --remote --file schema.sql
npx wrangler secret put SYNC_TOKEN     # asks for a token: use a long random one (openssl rand -hex 24) and keep it
npx wrangler deploy                    # prints the Worker's address
```

Put the Worker's address into `SYNC_URL` at the top of `app.js` and into `connect-src` in the page's security policy in `index.html`, then paste the token into Settings on each device. Only requests with the token can read or write. After changing the Worker or `schema.sql`, run the `execute` and `deploy` lines again; the schema only adds missing tables.

## How it works

1. Every 5 seconds, while the page is visible, it asks Spotify what's playing ([currently-playing](https://developer.spotify.com/documentation/web-api/reference/get-the-users-currently-playing-track)). Playback buttons use Spotify's player commands, which need Premium and the "control playback" permission asked for at login. When Spotify has gone idle (its app paused or in the background for a while), Play wakes one of your devices that Spotify still lists, which needs the "read playback state" permission. So while nothing plays, each check also asks for that list: when it is empty (Spotify isn't open anywhere), Play opens the song in the Spotify app, which plays it. That has to happen right in the tap, as iOS ignores a link into another app that waited for Spotify's answer.
2. It looks the song up on [LRCLIB](https://lrclib.net), a free lyrics database. It prefers Arabic script, then timed lyrics, and matches the track's length to within 8 seconds. If nothing is found, you can paste the lyrics.
3. It sends each distinct line once to Gemini (`gemini-3.8-flash`, then `gemini-3.6-flash` if that one is out of free requests or busy). Lyrics with no Arabic script at all (a song in another language) aren't sent unless you tap **Convert anyway**, for Arabic written in English letters; pasted lyrics always are. A new song is one request, and the free tier allows 20 requests a day per model, so about 40 new songs a day, reset at midnight Pacific time. The prompt and spelling rules are in `lib.js`. Results stream in line by line.
4. Converted songs are saved in the browser, so replaying a song costs nothing. With the sync database, the app looks there before asking Gemini and saves each new song there too. Every converted line is stamped with `CONVERSION` from `app.js`: lines with an older stamp are converted again when their song is opened (one request per song), and the flashcards from that song take the new results, keeping their progress.

## Run it locally

```sh
npm install
npm start      # serves http://127.0.0.1:8000/
npm test       # unit tests for parsing, matching, the Gemini stream reader, flashcards and the sync Worker
npm run e2e    # the page in Chrome, with Spotify, Gemini, LRCLIB and the sync Worker simulated (e2e/fakes.js)
npm run lint
```

The browser tests use the Chrome installed on the computer and spend no Gemini requests.

## Changing things

- **Gemini models**: `MODELS` in `app.js`. Google retires models over time; if the page says a model is no longer offered, put a current Flash model there. Avoid Flash-Lite models: on the test songs they broke the spelling rules and mistranslated lines. Pro models have no free tier.
- **Spelling rules**: the prompt in `lib.js` and the **Sounds** guide in `index.html` describe the same rules. Change both together.
- **Redoing saved songs**: after a change to the models or the prompt that makes earlier results worth redoing, raise `CONVERSION` in `app.js`.
- **Verb tables**: `node scripts/verbs.mjs` rebuilds `verbs.json` from Wiktionary (through [kaikki.org](https://kaikki.org)), to pick up verbs added there since. `verbs.json`, like Wiktionary, is under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
- **Logo**: `icon.svg` is the source. `apple-touch-icon.png` (the iPhone home screen icon) is the same image rendered at 180x180, so re-export it after changing the SVG.
