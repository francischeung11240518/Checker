-- Checker auth + personal watchlist.
-- Prices are NOT stored here. The browser computes them from the Pages bundle.
-- Retention period is not decided. This is a placeholder until Legal sets one.
-- Do not invent a purge window in code.
-- provider 'apple' is reserved for a later paid Apple Developer login. v1 rejects it.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'apple')),
  sub TEXT NOT NULL,
  email TEXT,
  name TEXT,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL,
  UNIQUE (provider, sub)
);

CREATE TABLE watchlist (
  user_id TEXT NOT NULL,
  product_code TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, product_code)
);

CREATE INDEX idx_watchlist_user_created ON watchlist (user_id, created_at);

CREATE TABLE sessions (
  jti TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX idx_sessions_user ON sessions (user_id);
