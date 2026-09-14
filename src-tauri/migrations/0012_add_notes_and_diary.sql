CREATE TABLE notes (
    id            TEXT    NOT NULL PRIMARY KEY,
    title         TEXT    NOT NULL,
    content       TEXT    NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    deleted_at_ms INTEGER          CHECK (deleted_at_ms IS NULL OR deleted_at_ms >= 0)
);

CREATE INDEX idx_notes_updated_at
ON notes(updated_at_ms DESC, id ASC);

CREATE TABLE diary_entries (
    id            TEXT    NOT NULL PRIMARY KEY,
    title         TEXT    NOT NULL,
    content       TEXT    NOT NULL,
    diary_date    TEXT    NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    deleted_at_ms INTEGER          CHECK (deleted_at_ms IS NULL OR deleted_at_ms >= 0)
);

CREATE UNIQUE INDEX idx_diary_entries_diary_date_active_unique
ON diary_entries(diary_date)
WHERE deleted_at_ms IS NULL;

CREATE INDEX idx_diary_entries_diary_date
ON diary_entries(diary_date DESC, updated_at_ms DESC, id ASC);
