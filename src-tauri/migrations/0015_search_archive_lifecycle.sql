-- Search / Archive lifecycle integration (P5C-S2.5).
--
-- 问题根因：migration 0013 的 Task / Note 源域 Search 触发器只认识
-- `deleted_at_ms`。0014 引入正交的 `archived_at_ms` 之后，ARCHIVED 与
-- TRASHED_FROM_ARCHIVE 的 Task / Note 仍会停留在派生 Search 投影
-- `search_documents` / `search_fts` 中，从而违反「Global Search V1 只搜索
-- ACTIVE 实体」这一冻结语义。
--
-- 本迁移只做三件事：
--   1. 删除 0013 的 Task / Note 源域 Search 触发器（不认识 Archive）；
--   2. 建立 Archive-aware 的 Task / Note 源域 Search 触发器；
--   3. 修复已存在的派生 Search 投影（删除旧的 Task / Note 投影，重插 ACTIVE 行）。
--
-- 0013 / 0014 保持 byte-identical：已有数据库可能已记录它们的 checksum，
-- 修改历史 migration 会导致 MigrationHashMismatch / HISTORY_CORRUPT。
--
-- ACTIVE 谓词（与 Archive V1 一致）：
--   deleted_at_ms IS NULL AND archived_at_ms IS NULL
--
-- 因此：
--   ACTIVE               → SEARCHABLE
--   ARCHIVED             → 不可检索
--   TRASHED_FROM_ACTIVE  → 不可检索
--   TRASHED_FROM_ARCHIVE → 不可检索
--
-- 不触碰：
--   - search_documents / search_fts 表结构（不重建）
--   - tokenizer（仍是 0013 的 trigram）
--   - Diary / Canvas 触发器与投影
--   - Search 排序 / 查询语法
--   - canonical tasks / notes 数据
--
-- FTS 维护仍完全由 0013 的 LAYER B（search_documents → search_fts）触发器承担：
-- 本迁移只写 search_documents，因此不需要也不应做全局 FTS rebuild。

-- ------------------------------------------------------------
-- 1. 删除 0013 的 Task / Note 源域 Search 触发器
--    这些触发器是 0013 确定存在的 schema contract，因此使用精确
--    DROP TRIGGER（不用 IF EXISTS 静默吞掉 schema corruption）。
-- ------------------------------------------------------------

DROP TRIGGER tasks_search_ai;
DROP TRIGGER tasks_search_ad;
DROP TRIGGER tasks_search_au_active;
DROP TRIGGER tasks_search_au_soft_delete;
DROP TRIGGER tasks_search_au_restore;

DROP TRIGGER notes_search_ai;
DROP TRIGGER notes_search_ad;
DROP TRIGGER notes_search_au_active;
DROP TRIGGER notes_search_au_soft_delete;
DROP TRIGGER notes_search_au_restore;

-- ------------------------------------------------------------
-- 2. Archive-aware Task / Note 源域 Search 触发器
--    生命周期语义收敛为两个词：searchable / hidden。
-- ------------------------------------------------------------

-- Task：title only（Task 无正文字段）
CREATE TRIGGER tasks_search_ai AFTER INSERT ON tasks
WHEN new.deleted_at_ms IS NULL AND new.archived_at_ms IS NULL BEGIN
    INSERT INTO search_documents(entity_type, entity_id, title, body, updated_at_ms)
    VALUES('task', new.id, new.title, '', new.updated_at_ms);
END;

CREATE TRIGGER tasks_search_ad AFTER DELETE ON tasks BEGIN
    DELETE FROM search_documents
    WHERE entity_type = 'task' AND entity_id = old.id;
END;

-- UPSERT 统一覆盖：
--   Active -> Active 更新
--   Archived -> Unarchive -> Active
--   Trash-from-active -> Restore -> Active
CREATE TRIGGER tasks_search_au_searchable AFTER UPDATE ON tasks
WHEN new.deleted_at_ms IS NULL AND new.archived_at_ms IS NULL BEGIN
    INSERT INTO search_documents(entity_type, entity_id, title, body, updated_at_ms)
    VALUES('task', new.id, new.title, '', new.updated_at_ms)
    ON CONFLICT(entity_type, entity_id) DO UPDATE
       SET title = excluded.title,
           body = excluded.body,
           updated_at_ms = excluded.updated_at_ms;
END;

-- 统一覆盖：
--   Active -> Archive
--   Active -> Trash
--   Archive -> Trash
--   Trash-from-Archive -> Restore -> Archive（仍 hidden）
--   以及任何 hidden -> hidden 更新
-- 删除不存在的投影行是合法 no-op。
CREATE TRIGGER tasks_search_au_hidden AFTER UPDATE ON tasks
WHEN new.deleted_at_ms IS NOT NULL OR new.archived_at_ms IS NOT NULL BEGIN
    DELETE FROM search_documents
    WHERE entity_type = 'task' AND entity_id = old.id;
END;

-- Note：title + content（原文入库，不 trim / 不 normalize）
CREATE TRIGGER notes_search_ai AFTER INSERT ON notes
WHEN new.deleted_at_ms IS NULL AND new.archived_at_ms IS NULL BEGIN
    INSERT INTO search_documents(entity_type, entity_id, title, body, updated_at_ms)
    VALUES('note', new.id, new.title, new.content, new.updated_at_ms);
END;

CREATE TRIGGER notes_search_ad AFTER DELETE ON notes BEGIN
    DELETE FROM search_documents
    WHERE entity_type = 'note' AND entity_id = old.id;
END;

CREATE TRIGGER notes_search_au_searchable AFTER UPDATE ON notes
WHEN new.deleted_at_ms IS NULL AND new.archived_at_ms IS NULL BEGIN
    INSERT INTO search_documents(entity_type, entity_id, title, body, updated_at_ms)
    VALUES('note', new.id, new.title, new.content, new.updated_at_ms)
    ON CONFLICT(entity_type, entity_id) DO UPDATE
       SET title = excluded.title,
           body = excluded.body,
           updated_at_ms = excluded.updated_at_ms;
END;

CREATE TRIGGER notes_search_au_hidden AFTER UPDATE ON notes
WHEN new.deleted_at_ms IS NOT NULL OR new.archived_at_ms IS NOT NULL BEGIN
    DELETE FROM search_documents
    WHERE entity_type = 'note' AND entity_id = old.id;
END;

-- ------------------------------------------------------------
-- 3. 投影修复（Project Repair）
--    升级到 0015 时，旧的 0013 触发器可能已经把 ARCHIVED / TRASHED
--    Task / Note 留在了派生投影里，因此不能只换触发器。
--
--    Layer B（search_documents -> search_fts）由 0013 维护，正常
--    DELETE / INSERT 会同步维护 FTS，因此这里不做全局 FTS rebuild，
--    也不重建 search_documents / search_fts 表。
--    Diary / Canvas 投影不在本次修复范围内，保持原样。
-- ------------------------------------------------------------

DELETE FROM search_documents
WHERE entity_type IN ('task', 'note');

INSERT INTO search_documents(entity_type, entity_id, title, body, updated_at_ms)
SELECT 'task', id, title, '', updated_at_ms
FROM tasks
WHERE deleted_at_ms IS NULL AND archived_at_ms IS NULL;

INSERT INTO search_documents(entity_type, entity_id, title, body, updated_at_ms)
SELECT 'note', id, title, content, updated_at_ms
FROM notes
WHERE deleted_at_ms IS NULL AND archived_at_ms IS NULL;
