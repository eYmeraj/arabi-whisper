# Arabi Whisper

Read Egyptian Arabic songs the way they're sung. While a song plays on Spotify (on any of your devices), this page shows its lyrics line by line:

- the Arabic, as written
- how it sounds, in plain English letters (spelling guide under **Sounds**)
- what it means in English
- every word: tap it to see its meaning and a grammar note, and + to make it a flashcard

The **Flashcards** tab is for practising those words any time, even with no song playing: the Arabic and its sound on the front; the meaning, the note and the lyric lines it came from on the back. Cards you know come back less often (after 1, 3, 7, 14, 30, then 90 days); "Again" brings a card back in the same session.

With timed lyrics, the line being sung lights up and the page scrolls along. The bar at the bottom shows how far into the song you are (1:27 of 2:31), plays, pauses and skips songs on Spotify, and tapping a line plays the song from there.

Live at **https://eymeraj.github.io/arabi-whisper/**. It's a static page: your Gemini key and Spotify login stay in your browser. The only server is an optional sync database of your own.

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

**3. Sync database (optional, free).** Without it, each device converts a song once. With it, a song converted on any of your devices is ready on all of them, and costs one Gemini request in total, and your flashcards and their progress follow you too. It is a [Cloudflare Worker](https://developers.cloudflare.com/workers/) with a [D1](https://developers.cloudflare.com/d1/) database (tables `songs` and `flashcards`, one row each), both on Cloudflare's free plan. From the `worker` folder:

```sh
npx wrangler login
npx wrangler d1 create arabi-whisper   # put the database_id it prints into wrangler.toml
npx wrangler d1 execute arabi-whisper --remote --file schema.sql
npx wrangler secret put SYNC_TOKEN     # asks for a token: use a long random one (openssl rand -hex 24) and keep it
npx wrangler deploy                    # prints the Worker's address
```

Put the Worker's address into `SYNC_URL` at the top of `app.js` and into `connect-src` in the page's security policy in `index.html`, then paste the token into Settings on each device. Only requests with the token can read or write. After changing the Worker or `schema.sql`, run the `execute` and `deploy` lines again; the schema only adds missing tables.

## How it works

1. Every 5 seconds, while the page is visible, it asks Spotify what's playing ([currently-playing](https://developer.spotify.com/documentation/web-api/reference/get-the-users-currently-playing-track)). Playback buttons use Spotify's player commands, which need Premium and the "control playback" permission asked for at login. When Spotify has gone idle (its app paused or in the background for a while), Play wakes one of your devices that Spotify still lists, which needs the "read playback state" permission.
2. It looks the song up on [LRCLIB](https://lrclib.net), a free lyrics database. It prefers Arabic script, then timed lyrics, and matches the track's length to within 8 seconds. If nothing is found, you can paste the lyrics.
3. It sends each distinct line once to Gemini (`gemini-3.8-flash`, then `gemini-3.5-flash-lite` if that one is out of free requests or busy). A new song is one request, and the free tier allows 20 requests a day per model, reset at midnight Pacific time. The prompt and spelling rules are in `lib.js`. Results stream in line by line.
4. Converted songs are saved in the browser, so replaying a song costs nothing. With the sync database, the app looks there before asking Gemini and saves each new song there too.

## Run it locally

```sh
npm start   # serves http://127.0.0.1:8000/
npm test    # unit tests for parsing, matching, the Gemini stream reader and the sync Worker
```

## Changing things

- **Gemini models**: `MODELS` in `app.js`. Google retires models over time; if the page says a model is no longer offered, put a current Flash model there.
- **Spelling rules**: the prompt in `lib.js` and the **Sounds** guide in `index.html` describe the same rules. Change both together.
- **Logo**: `icon.svg` is the source. `apple-touch-icon.png` (the iPhone home screen icon) is the same image rendered at 180x180, so re-export it after changing the SVG.
