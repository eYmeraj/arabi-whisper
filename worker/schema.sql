-- One row per song: data is the song as the app saves it (lyrics, pronunciation, meanings, word cards) in JSON.
CREATE TABLE IF NOT EXISTS songs (
  key TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated INTEGER NOT NULL
);

-- One row per flashcard (a word saved from a song): data is the card in JSON, including when it is next due.
CREATE TABLE IF NOT EXISTS flashcards (
  key TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated INTEGER NOT NULL
);
