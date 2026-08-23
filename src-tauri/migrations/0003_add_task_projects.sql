CREATE TABLE projects (
    id            TEXT    PRIMARY KEY NOT NULL,
    name          TEXT    NOT NULL
                          CHECK (length(trim(name)) > 0),
    created_at_ms INTEGER NOT NULL
                          CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL
                          CHECK (updated_at_ms >= created_at_ms)
);

ALTER TABLE tasks
ADD COLUMN project_id TEXT NULL
REFERENCES projects(id);

CREATE INDEX idx_tasks_project_id ON tasks(project_id);
