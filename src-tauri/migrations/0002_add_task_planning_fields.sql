ALTER TABLE tasks
ADD COLUMN is_important INTEGER NOT NULL DEFAULT 0
CHECK (is_important IN (0, 1));

ALTER TABLE tasks
ADD COLUMN is_urgent INTEGER NOT NULL DEFAULT 0
CHECK (is_urgent IN (0, 1));

ALTER TABLE tasks
ADD COLUMN due_date TEXT NULL
CHECK (
    due_date IS NULL
    OR (
        length(due_date) = 10
        AND due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    )
);
