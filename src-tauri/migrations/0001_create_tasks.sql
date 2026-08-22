CREATE TABLE tasks (
    id            TEXT    PRIMARY KEY NOT NULL,
    title         TEXT    NOT NULL
                          CHECK (length(trim(title)) > 0),
    status        TEXT    NOT NULL DEFAULT 'todo'
                          CHECK (status IN (
                              'todo',
                              'doing',
                              'completed',
                              'cancelled'
                          )),
    created_at_ms INTEGER NOT NULL
                          CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL
                          CHECK (updated_at_ms >= created_at_ms)
);
