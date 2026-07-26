# API Specific docs

## DB Initialization

On startup, the API ensures the database schema is complete via Sequelize
(`ensureSchema` in `./lib/schema.js`). This works with either MySQL (`mysql2`)
or SQLite (`sqlite3`), selected by the `DB_CLIENT` env var. Table definitions
live once in `./lib/models/` and are synced for both dialects; reference roles
are seeded after sync.
