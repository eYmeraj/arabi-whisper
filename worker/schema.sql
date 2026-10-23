-- One row per song: data is the song as the app saves it (lyrics, pronunciation, meanings, word cards) in JSON.
CREATE TABLE IF NOT EXISTS songs (
  key TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated INTEGER NOT NULL
);
