CREATE TABLE tags (
    id            TEXT    PRIMARY KEY NOT NULL,
    name          TEXT    NOT NULL UNIQUE
                          CHECK (length(trim(name)) > 0),
    created_at_ms INTEGER NOT NULL
                          CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL
                          CHECK (updated_at_ms >= created_at_ms)
);

CREATE TABLE task_tags (
    task_id TEXT NOT NULL REFERENCES tasks(id),
    tag_id  TEXT NOT NULL REFERENCES tags(id),
    PRIMARY KEY (task_id, tag_id)
);

CREATE INDEX idx_task_tags_tag_id_task_id
ON task_tags(tag_id, task_id);
