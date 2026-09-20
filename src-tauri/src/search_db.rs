//! Native global search query service (P5 S2 — Native query layer only).
//!
//! Search V1 query contract. This module owns the query engine over the
//! derived `search_documents` + `search_fts` projection (migration 0013).
//! It performs NO writes: the projection is maintained exclusively by the
//! migration-0013 triggers on the source domain tables.
//!
//! Query contract (frozen for S2):
//! - The free-text query is split on whitespace into terms (max 16).
//! - A term with >= 3 characters is resolved through the FTS5 trigram index
//!   (`search_fts MATCH "term"`). This is required because trigram cannot
//!   match substrings shorter than 3 characters.
//! - A term with < 3 characters falls back to a bounded `LIKE` scan over the
//!   `title`/`body` columns (covers the Chinese 2-character case).
//! - All terms are combined with AND semantics: every term must be present.
//! - Results are ordered by `bm25(search_fts) ASC` (more negative = better),
//!   then `updated_at_ms DESC`, then `id ASC` as tie-breakers. When no FTS
//!   term exists (short-term-only queries) ordering falls back to the
//!   `updated_at_ms DESC, id ASC` tie-breaker sequence.
//! - The returned `snippet` is plain text (no markup) centered on the first
//!   matched term.

use rusqlite::{params_from_iter, Connection, Row};
use serde::{Deserialize, Serialize};

const MAX_SEARCH_TERMS: usize = 16;
const MIN_SEARCH_LIMIT: u32 = 1;
const MAX_SEARCH_LIMIT: u32 = 200;
const SNIPPET_MAX_LEN: usize = 128;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchResultRecord {
    pub entity_type: String,
    pub entity_id: String,
    pub title: String,
    pub snippet: String,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SearchError {
    InvalidQuery,
    PersistenceError,
}

impl SearchError {
    pub(crate) fn code(self) -> &'static str {
        match self {
            SearchError::InvalidQuery => "INVALID_QUERY",
            SearchError::PersistenceError => "PERSISTENCE_ERROR",
        }
    }

    pub(crate) fn safe_message(self) -> &'static str {
        match self {
            SearchError::InvalidQuery => "The search query is invalid.",
            SearchError::PersistenceError => "Unable to complete the search.",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SearchQueryInput {
    pub raw_query: String,
    pub limit: u32,
}

fn split_terms(raw: &str) -> Vec<String> {
    raw.split_whitespace().map(|t| t.to_string()).collect()
}

fn escape_fts(term: &str) -> String {
    term.replace('"', "\"\"")
}

/// Escape `%`, `_`, and `\` so they are treated literally inside a LIKE pattern
/// that uses `ESCAPE '\'`.
fn like_pattern(term: &str) -> String {
    let escaped = term
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

/// Case-insensitive character-index search (returns index into `haystack`'s
/// `char` sequence). Safe for mixed ASCII/CJK input.
fn find_char_index(haystack: &str, needle: &str) -> Option<usize> {
    if needle.is_empty() {
        return None;
    }
    let h: Vec<char> = haystack.chars().collect();
    let n: Vec<char> = needle.chars().collect();
    if n.len() > h.len() {
        return None;
    }
    let h_low: Vec<char> = h.iter().flat_map(|c| c.to_lowercase()).collect();
    let n_low: Vec<char> = n.iter().flat_map(|c| c.to_lowercase()).collect();
    for i in 0..=(h_low.len() - n_low.len()) {
        if &h_low[i..i + n_low.len()] == &n_low[..] {
            return Some(i);
        }
    }
    None
}

/// Produce a plain-text snippet centered on the first term found in `title`
/// then `body`, falling back to a leading window of the best available text.
fn make_snippet(title: &str, body: &str, terms: &[String]) -> String {
    for term in terms {
        if let Some(idx) = find_char_index(title, term) {
            return window_around(title, idx);
        }
    }
    for term in terms {
        if let Some(idx) = find_char_index(body, term) {
            return window_around(body, idx);
        }
    }
    let src = if !body.is_empty() { body } else { title };
    window_around(src, 0)
}

fn window_around(text: &str, match_char_idx: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() {
        return String::new();
    }
    let prefix = SNIPPET_MAX_LEN / 3;
    let mut start = match_char_idx.saturating_sub(prefix);
    if start + SNIPPET_MAX_LEN > chars.len() {
        start = chars.len().saturating_sub(SNIPPET_MAX_LEN);
    }
    let end = (start + SNIPPET_MAX_LEN).min(chars.len());
    chars[start..end].iter().collect()
}

fn parse_search_row(
    row: &Row<'_>,
    terms: &[String],
) -> rusqlite::Result<SearchResultRecord> {
    let entity_type: String = row.get(1)?;
    let entity_id: String = row.get(2)?;
    let title: String = row.get(3)?;
    let body: String = row.get(4)?;
    let updated_at_ms: i64 = row.get(5)?;
    let snippet = make_snippet(&title, &body, terms);
    Ok(SearchResultRecord {
        entity_type,
        entity_id,
        title,
        snippet,
        updated_at_ms,
    })
}

/// Query path that includes at least one FTS-resolvable term (>= 3 chars).
/// Short (< 3 char) terms, if any, are applied as additional AND filters via
/// `LIKE`, and `bm25` ordering is available.
fn query_with_fts(
    connection: &Connection,
    long_terms: &[&String],
    short_terms: &[&String],
    limit: u32,
    terms: &[String],
) -> rusqlite::Result<Vec<SearchResultRecord>> {
    let match_expr = long_terms
        .iter()
        .map(|t| format!("\"{}\"", escape_fts(t)))
        .collect::<Vec<_>>()
        .join(" AND ");

    let mut sql = String::from(
        "SELECT d.id, d.entity_type, d.entity_id, d.title, d.body, d.updated_at_ms \
         FROM search_documents d \
         JOIN search_fts ON d.id = search_fts.rowid \
         WHERE search_fts MATCH ?",
    );

    let mut string_params: Vec<String> = Vec::new();
    string_params.push(match_expr);
    for term in short_terms {
        let pattern = like_pattern(term);
        sql.push_str(
            " AND (d.title LIKE ? ESCAPE '\\' OR d.body LIKE ? ESCAPE '\\')",
        );
        string_params.push(pattern.clone());
        string_params.push(pattern);
    }
    sql.push_str(
        " ORDER BY bm25(search_fts) ASC, d.updated_at_ms DESC, d.id ASC LIMIT ?",
    );

    let limit_val: i64 = limit as i64;
    let mut param_refs: Vec<&dyn rusqlite::ToSql> = Vec::new();
    for s in &string_params {
        param_refs.push(s);
    }
    param_refs.push(&limit_val);

    let mut stmt = connection.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(param_refs), |row| {
        parse_search_row(row, terms)
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Query path used when every term is below the FTS threshold (< 3 chars).
/// All terms are applied as AND `LIKE` filters; `bm25` is unavailable.
fn query_short_only(
    connection: &Connection,
    short_terms: &[&String],
    limit: u32,
    terms: &[String],
) -> rusqlite::Result<Vec<SearchResultRecord>> {
    let mut clauses: Vec<String> = Vec::new();
    let mut string_params: Vec<String> = Vec::new();
    for term in short_terms {
        clauses.push(
            "(d.title LIKE ? ESCAPE '\\' OR d.body LIKE ? ESCAPE '\\')".to_string(),
        );
        let pattern = like_pattern(term);
        string_params.push(pattern.clone());
        string_params.push(pattern);
    }
    let sql = format!(
        "SELECT d.id, d.entity_type, d.entity_id, d.title, d.body, d.updated_at_ms \
         FROM search_documents d \
         WHERE {} \
         ORDER BY d.updated_at_ms DESC, d.id ASC LIMIT ?",
        clauses.join(" AND ")
    );

    let limit_val: i64 = limit as i64;
    let mut param_refs: Vec<&dyn rusqlite::ToSql> = Vec::new();
    for s in &string_params {
        param_refs.push(s);
    }
    param_refs.push(&limit_val);

    let mut stmt = connection.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(param_refs), |row| {
        parse_search_row(row, terms)
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

impl SearchDbService {
    pub fn query(
        connection: &Connection,
        input: SearchQueryInput,
    ) -> Result<Vec<SearchResultRecord>, SearchError> {
        let limit = if (MIN_SEARCH_LIMIT..=MAX_SEARCH_LIMIT).contains(&input.limit) {
            input.limit
        } else {
            return Err(SearchError::InvalidQuery);
        };

        let terms = split_terms(&input.raw_query);
        if terms.len() > MAX_SEARCH_TERMS {
            return Err(SearchError::InvalidQuery);
        }
        if terms.is_empty() {
            return Ok(Vec::new());
        }

        let long_terms: Vec<&String> = terms
            .iter()
            .filter(|t| t.chars().count() >= 3)
            .collect();
        let short_terms: Vec<&String> = terms
            .iter()
            .filter(|t| t.chars().count() < 3)
            .collect();

        let records = if long_terms.is_empty() {
            query_short_only(connection, &short_terms, limit, &terms)
        } else {
            query_with_fts(connection, &long_terms, &short_terms, limit, &terms)
        };

        records.map_err(|_| SearchError::PersistenceError)
    }
}

pub struct SearchDbService;

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;
    use rusqlite::params;
    use crate::db::definitions::MIGRATIONS;
    use crate::db::migration::MigrationRunner;
    use crate::db::policy::open_configured_connection;
    use crate::db::snapshot::SqliteBackupSnapshot;

    fn migrated_database() -> (tempfile::TempDir, Connection) {
        let sandbox = tempdir().unwrap();
        let database_dir = sandbox.path().join("database");
        let backup_dir = sandbox.path().join("backup");
        fs::create_dir_all(&database_dir).unwrap();
        fs::create_dir_all(&backup_dir).unwrap();
        let database_path = database_dir.join("zhixing.db");
        let mut connection = open_configured_connection(&database_path).unwrap();
        MigrationRunner::new(MIGRATIONS, SqliteBackupSnapshot)
            .run(&mut connection, &backup_dir)
            .unwrap();
        (sandbox, connection)
    }

    fn insert_doc(
        connection: &Connection,
        id: i64,
        entity_type: &str,
        entity_id: &str,
        title: &str,
        body: &str,
        updated_at_ms: i64,
    ) {
        connection
            .execute(
                "INSERT INTO search_documents(id, entity_type, entity_id, title, body, updated_at_ms) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, entity_type, entity_id, title, body, updated_at_ms],
            )
            .unwrap();
    }

    #[test]
    fn empty_query_returns_empty_without_error() {
        let (_sandbox, connection) = migrated_database();
        let results = SearchDbService::query(
            &connection,
            SearchQueryInput {
                raw_query: "   ".to_string(),
                limit: 50,
            },
        )
        .unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn single_english_term_matches_via_fts() {
        let (_sandbox, connection) = migrated_database();
        insert_doc(
            &connection,
            1,
            "note",
            "n1",
            "Planning",
            "project planning for q3",
            100,
        );

        let results = SearchDbService::query(
            &connection,
            SearchQueryInput {
                raw_query: "planning".to_string(),
                limit: 50,
            },
        )
        .unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].entity_id, "n1");
        assert!(results[0].snippet.to_lowercase().contains("planning"));
    }

    #[test]
    fn chinese_two_char_term_uses_like_fallback() {
        let (_sandbox, connection) = migrated_database();
        insert_doc(
            &connection,
            1,
            "note",
            "n1",
            "日记",
            "今天完成作业",
            100,
        );

        // "今天" is 2 characters → below the FTS threshold → LIKE path.
        let results = SearchDbService::query(
            &connection,
            SearchQueryInput {
                raw_query: "今天".to_string(),
                limit: 50,
            },
        )
        .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].entity_id, "n1");
    }

    #[test]
    fn chinese_three_plus_char_term_uses_fts() {
        let (_sandbox, connection) = migrated_database();
        insert_doc(
            &connection,
            1,
            "note",
            "n1",
            "日记",
            "今天完成作业",
            100,
        );

        // "完成作" is 3 characters → FTS path.
        let results = SearchDbService::query(
            &connection,
            SearchQueryInput {
                raw_query: "完成作".to_string(),
                limit: 50,
            },
        )
        .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].entity_id, "n1");
    }

    #[test]
    fn and_semantics_require_every_term() {
        let (_sandbox, connection) = migrated_database();
        insert_doc(
            &connection,
            1,
            "note",
            "n1",
            "Apple",
            "red apple fruit",
            100,
        );
        insert_doc(
            &connection,
            2,
            "note",
            "n2",
            "Banana",
            "yellow banana fruit",
            200,
        );

        // "apple" only occurs in n1; AND semantics exclude n2.
        let results = SearchDbService::query(
            &connection,
            SearchQueryInput {
                raw_query: "apple fruit".to_string(),
                limit: 50,
            },
        )
        .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].entity_id, "n1");
    }

    #[test]
    fn mixed_long_and_short_term_combined_with_and() {
        let (_sandbox, connection) = migrated_database();
        // 3-char FTS term "完成作" + 2-char LIKE term "今天".
        insert_doc(
            &connection,
            1,
            "note",
            "n1",
            "标题",
            "今天完成作业",
            100,
        );
        insert_doc(
            &connection,
            2,
            "note",
            "n2",
            "标题",
            "昨天完成数学",
            200,
        );

        let results = SearchDbService::query(
            &connection,
            SearchQueryInput {
                raw_query: "完成作 今天".to_string(),
                limit: 50,
            },
        )
        .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].entity_id, "n1");
    }

    #[test]
    fn limit_out_of_range_is_invalid_query() {
        let (_sandbox, connection) = migrated_database();
        insert_doc(&connection, 1, "note", "n1", "t", "body planning", 100);

        assert_eq!(
            SearchDbService::query(
                &connection,
                SearchQueryInput {
                    raw_query: "planning".to_string(),
                    limit: 0,
                },
            )
            .unwrap_err(),
            SearchError::InvalidQuery
        );
        assert_eq!(
            SearchDbService::query(
                &connection,
                SearchQueryInput {
                    raw_query: "planning".to_string(),
                    limit: 201,
                },
            )
            .unwrap_err(),
            SearchError::InvalidQuery
        );
    }

    #[test]
    fn limit_is_respected() {
        let (_sandbox, connection) = migrated_database();
        for i in 0..5 {
            insert_doc(
                &connection,
                i,
                "note",
                &format!("n{i}"),
                "t",
                "planning",
                100 + i as i64,
            );
        }

        let results = SearchDbService::query(
            &connection,
            SearchQueryInput {
                raw_query: "planning".to_string(),
                limit: 2,
            },
        )
        .unwrap();
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn too_many_terms_is_invalid_query() {
        let (_sandbox, connection) = migrated_database();
        let many = (0..17).map(|i| format!("term{i}")).collect::<Vec<_>>().join(" ");

        assert_eq!(
            SearchDbService::query(
                &connection,
                SearchQueryInput {
                    raw_query: many,
                    limit: 50,
                },
            )
            .unwrap_err(),
            SearchError::InvalidQuery
        );
    }

    #[test]
    fn tie_breaker_orders_by_updated_at_desc_then_id_asc() {
        let (_sandbox, connection) = migrated_database();
        // Both match "planning" identically; ordering must follow tie-breakers.
        insert_doc(&connection, 2, "note", "n2", "t", "planning", 100);
        insert_doc(&connection, 1, "note", "n1", "t", "planning", 300);
        insert_doc(&connection, 3, "note", "n3", "t", "planning", 300);

        let results = SearchDbService::query(
            &connection,
            SearchQueryInput {
                raw_query: "planning".to_string(),
                limit: 50,
            },
        )
        .unwrap();
        assert_eq!(results.len(), 3);
        // updated_at 300 first (ids 1 then 3), then 100.
        let order: Vec<i64> = results.iter().map(|r| r.updated_at_ms).collect();
        assert_eq!(order, vec![300, 300, 100]);
        let ids: Vec<&str> = results.iter().map(|r| r.entity_id.as_str()).collect();
        assert_eq!(ids, vec!["n1", "n3", "n2"]);
    }

    #[test]
    fn snippet_contains_matched_term_and_is_plain_text() {
        let (_sandbox, connection) = migrated_database();
        insert_doc(
            &connection,
            1,
            "diary",
            "d1",
            "My Day",
            "We went to the market and bought fresh apples.",
            100,
        );

        let results = SearchDbService::query(
            &connection,
            SearchQueryInput {
                raw_query: "apples".to_string(),
                limit: 50,
            },
        )
        .unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].snippet.contains("apples"));
        assert!(!results[0].snippet.contains('<'));
    }

    #[test]
    fn no_match_returns_empty() {
        let (_sandbox, connection) = migrated_database();
        insert_doc(&connection, 1, "note", "n1", "t", "planning", 100);

        let results = SearchDbService::query(
            &connection,
            SearchQueryInput {
                raw_query: "zzz_nomatch_xyz".to_string(),
                limit: 50,
            },
        )
        .unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn search_error_codes_and_safe_messages_are_frozen() {
        assert_eq!(SearchError::InvalidQuery.code(), "INVALID_QUERY");
        assert_eq!(SearchError::PersistenceError.code(), "PERSISTENCE_ERROR");
        assert_eq!(
            SearchError::InvalidQuery.safe_message(),
            "The search query is invalid."
        );
        assert_eq!(
            SearchError::PersistenceError.safe_message(),
            "Unable to complete the search."
        );
    }

    #[test]
    fn like_pattern_escapes_wildcards() {
        assert_eq!(like_pattern("a%b_c"), "%a\\%b\\_c%");
    }

    #[test]
    fn make_snippet_clamps_to_max_length() {
        let long = "x".repeat(500);
        let snippet = make_snippet("title", &long, &["x".to_string()]);
        assert!(snippet.chars().count() <= SNIPPET_MAX_LEN);
        assert!(snippet.contains('x'));
    }
}
