-- Global Search V1 index foundation (P5 S1).
--
-- search_documents 是跨领域派生投影表；search_fts 是派生全文索引。
-- 二者均为 DERIVED DATA：权威实体仍是 tasks / notes / diary_entries / canvases，
-- 这两张表不得成为实体业务读取的 canonical source。
--
-- 索引范围（Search V1，冻结）：
--   task   -> title only
--   note   -> title + content
--   diary  -> title + content
--   canvas -> title only（canvas_nodes 文本不属于 V1）
-- 软删除实体不入索引；restore 由源表 UPDATE 触发器自动重新投影。
--
-- future table-recreate warning：
--   若未来 migration 对 tasks / notes / diary_entries / canvases 执行
--   RENAME + DROP TABLE 重建（先例：0008 / 0010 重建 canvas 表），
--   附着在源表上的本组 search 触发器会随 DROP TABLE 一并消失，
--   该 migration 必须重建本组触发器。

CREATE TABLE search_documents (
    id            INTEGER PRIMARY KEY NOT NULL,
    entity_type   TEXT    NOT NULL
                          CHECK (entity_type IN ('task', 'note', 'diary', 'canvas')),
    entity_id     TEXT    NOT NULL,
    title         TEXT    NOT NULL,
    body          TEXT    NOT NULL,
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
);

CREATE UNIQUE INDEX idx_search_documents_entity_unique
ON search_documents(entity_type, entity_id);

CREATE VIRTUAL TABLE search_fts USING fts5(
    title,
    body,
    content='search_documents',
    content_rowid='id',
    tokenize='trigram'
);

-- ------------------------------------------------------------
-- LAYER B：search_documents -> search_fts
-- FTS5 维护集中在此一层，源域触发器只维护 search_documents。
-- ------------------------------------------------------------

CREATE TRIGGER search_documents_fts_ai AFTER INSERT ON search_documents BEGIN
    INSERT INTO search_fts(rowid, title, body)
    VALUES(new.id, new.title, new.body);
END;

CREATE TRIGGER search_documents_fts_ad AFTER DELETE ON search_documents BEGIN
    INSERT INTO search_fts(search_fts, rowid, title, body)
    VALUES('delete', old.id, old.title, old.body);
END;

CREATE TRIGGER search_documents_fts_au AFTER UPDATE ON search_documents BEGIN
    INSERT INTO search_fts(search_fts, rowid, title, body)
    VALUES('delete', old.id, old.title, old.body);
    INSERT INTO search_fts(rowid, title, body)
    VALUES(new.id, new.title, new.body);
END;

-- ------------------------------------------------------------
-- LAYER A：source domain -> search_documents
-- ------------------------------------------------------------

-- Task：title only（Task 无正文字段）
CREATE TRIGGER tasks_search_ai AFTER INSERT ON tasks
WHEN new.deleted_at_ms IS NULL BEGIN
    INSERT INTO search_documents(entity_type, entity_id, title, body, updated_at_ms)
    VALUES('task', new.id, new.title, '', new.updated_at_ms);
END;

CREATE TRIGGER tasks_search_ad AFTER DELETE ON tasks BEGIN
    DELETE FROM search_documents
    WHERE entity_type = 'task' AND entity_id = old.id;
END;

CREATE TRIGGER tasks_search_au_active AFTER UPDATE ON tasks
WHEN old.deleted_at_ms IS NULL AND new.deleted_at_ms IS NULL BEGIN
    UPDATE search_documents
       SET title = new.title,
           updated_at_ms = new.updated_at_ms
     WHERE entity_type = 'task' AND entity_id = new.id;
END;

CREATE TRIGGER tasks_search_au_soft_delete AFTER UPDATE ON tasks
WHEN old.deleted_at_ms IS NULL AND new.deleted_at_ms IS NOT NULL BEGIN
    DELETE FROM search_documents
    WHERE entity_type = 'task' AND entity_id = old.id;
END;

CREATE TRIGGER tasks_search_au_restore AFTER UPDATE ON tasks
WHEN old.deleted_at_ms IS NOT NULL AND new.deleted_at_ms IS NULL BEGIN
    INSERT INTO search_documents(entity_type, entity_id, title, body, updated_at_ms)
    VALUES('task', new.id, new.title, '', new.updated_at_ms);
END;

-- Note：title + content（原文入库，不 trim / 不 normalize）
CREATE TRIGGER notes_search_ai AFTER INSERT ON notes
WHEN new.deleted_at_ms IS NULL BEGIN
    INSERT INTO search_documents(entity_type, entity_id, title, body, updated_at_ms)
    VALUES('note', new.id, new.title, new.content, new.updated_at_ms);
END;

CREATE TRIGGER notes_search_ad AFTER DELETE ON notes BEGIN
    DELETE FROM search_documents
    WHERE entity_type = 'note' AND entity_id = old.id;
END;

CREATE TRIGGER notes_search_au_active AFTER UPDATE ON notes
WHEN old.deleted_at_ms IS NULL AND new.deleted_at_ms IS NULL BEGIN
    UPDATE search_documents
       SET title = new.title,
           body = new.content,
           updated_at_ms = new.updated_at_ms
     WHERE entity_type = 'note' AND entity_id = new.id;
END;

CREATE TRIGGER notes_search_au_soft_delete AFTER UPDATE ON notes
WHEN old.deleted_at_ms IS NULL AND new.deleted_at_ms IS NOT NULL BEGIN
    DELETE FROM search_documents
    WHERE entity_type = 'note' AND entity_id = old.id;
END;

CREATE TRIGGER notes_search_au_restore AFTER UPDATE ON notes
WHEN old.deleted_at_ms IS NOT NULL AND new.deleted_at_ms IS NULL BEGIN
    INSERT INTO search_documents(entity_type, entity_id, title, body, updated_at_ms)
    VALUES('note', new.id, new.title, new.content, new.updated_at_ms);
END;

-- Diary：title + content（diary_date 不作为正文入库）
CREATE TRIGGER diary_entries_search_ai AFTER INSERT ON diary_entries
WHEN new.deleted_at_ms IS NULL BEGIN
    INSERT INTO search_documents(entity_type, entity_id, title, body, updated_at_ms)
    VALUES('diary', new.id, new.title, new.content, new.updated_at_ms);
END;

CREATE TRIGGER diary_entries_search_ad AFTER DELETE ON diary_entries BEGIN
    DELETE FROM search_documents
    WHERE entity_type = 'diary' AND entity_id = old.id;
END;

CREATE TRIGGER diary_entries_search_au_active AFTER UPDATE ON diary_entries
WHEN old.deleted_at_ms IS NULL AND new.deleted_at_ms IS NULL BEGIN
    UPDATE search_documents
       SET title = new.title,
           body = new.content,
           updated_at_ms = new.updated_at_ms
     WHERE entity_type = 'diary' AND entity_id = new.id;
END;

CREATE TRIGGER diary_entries_search_au_soft_delete AFTER UPDATE ON diary_entries
WHEN old.deleted_at_ms IS NULL AND new.deleted_at_ms IS NOT NULL BEGIN
    DELETE FROM search_documents
    WHERE entity_type = 'diary' AND entity_id = old.id;
END;

CREATE TRIGGER diary_entries_search_au_restore AFTER UPDATE ON diary_entries
WHEN old.deleted_at_ms IS NOT NULL AND new.deleted_at_ms IS NULL BEGIN
    INSERT INTO search_documents(entity_type, entity_id, title, body, updated_at_ms)
    VALUES('diary', new.id, new.title, new.content, new.updated_at_ms);
END;

-- Canvas：title only（canvases 无 deleted_at_ms，故无软删分支）
CREATE TRIGGER canvases_search_ai AFTER INSERT ON canvases BEGIN
    INSERT INTO search_documents(entity_type, entity_id, title, body, updated_at_ms)
    VALUES('canvas', new.id, new.title, '', new.updated_at_ms);
END;

CREATE TRIGGER canvases_search_au AFTER UPDATE ON canvases BEGIN
    UPDATE search_documents
       SET title = new.title,
           updated_at_ms = new.updated_at_ms
     WHERE entity_type = 'canvas' AND entity_id = new.id;
END;

CREATE TRIGGER canvases_search_ad AFTER DELETE ON canvases BEGIN
    DELETE FROM search_documents
    WHERE entity_type = 'canvas' AND entity_id = old.id;
END;

-- ------------------------------------------------------------
-- Backfill：已有活跃数据必须入索引（只索引未来写入是无效迁移）。
-- 写入 search_documents 会经由 LAYER B 触发器自动填充 search_fts。
-- ------------------------------------------------------------

INSERT INTO search_documents(entity_type, entity_id, title, body, updated_at_ms)
SELECT 'task', id, title, '', updated_at_ms
FROM tasks
WHERE deleted_at_ms IS NULL;

INSERT INTO search_documents(entity_type, entity_id, title, body, updated_at_ms)
SELECT 'note', id, title, content, updated_at_ms
FROM notes
WHERE deleted_at_ms IS NULL;

INSERT INTO search_documents(entity_type, entity_id, title, body, updated_at_ms)
SELECT 'diary', id, title, content, updated_at_ms
FROM diary_entries
WHERE deleted_at_ms IS NULL;

INSERT INTO search_documents(entity_type, entity_id, title, body, updated_at_ms)
SELECT 'canvas', id, title, '', updated_at_ms
FROM canvases;

-- canonical FTS5 rebuild：确保索引与投影表最终一致
INSERT INTO search_fts(search_fts) VALUES('rebuild');
