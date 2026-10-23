# Arabi Whisper

Read Egyptian Arabic songs the way they're sung. While a song plays on Spotify (on any of your devices), this page shows its lyrics line by line:

- the Arabic, as written
- how it sounds, in plain English letters (spelling guide under **Sounds**)
- what it means in English
- every word: tap it to see its meaning and a grammar note

With timed lyrics, the line being sung lights up and the page scrolls along. The bar at the bottom plays, pauses and skips songs on Spotify, and tapping a line plays the song from there.

Live at **https://eymeraj.github.io/arabi-whisper/**. It's a static page with no server: your Gemini key and Spotify login stay in your browser.

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

## How it works

1. Every 5 seconds, while the page is visible, it asks Spotify what's playing ([currently-playing](https://developer.spotify.com/documentation/web-api/reference/get-the-users-currently-playing-track)). Playback buttons use Spotify's player commands, which need Premium and the "control playback" permission asked for at login.
2. It looks the song up on [LRCLIB](https://lrclib.net), a free lyrics database. It prefers Arabic script, then timed lyrics, and matches the track's length to within 8 seconds. If nothing is found, you can paste the lyrics.
3. It sends each distinct line once to Gemini (`gemini-3.8-flash`, then `gemini-3.5-flash-lite` if that one is out of free requests or busy). A new song is one request, and the free tier allows 20 requests a day per model, reset at midnight Pacific time. The prompt and spelling rules are in `lib.js`. Results stream in line by line.
4. Converted songs are saved in the browser, so replaying a song costs nothing. Each device converts a song once.

## Run it locally

```sh
npm start   # serves http://127.0.0.1:8000/
npm test    # unit tests for parsing, matching and the Gemini stream reader
```

## Changing things

- **Gemini models**: `MODELS` in `app.js`. Google retires models over time; if the page says a model is no longer offered, put a current Flash model there.
- **Spelling rules**: the prompt in `lib.js` and the **Sounds** guide in `index.html` describe the same rules. Change both together.
- **Logo**: `icon.svg` is the source. `apple-touch-icon.png` (the iPhone home screen icon) is the same image rendered at 180x180, so re-export it after changing the SVG.
