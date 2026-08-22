//! DB Bootstrap 占位模块（Step 9 Closeout 清空）。
//!
//! Step 8 原 boot_db（open + policy + drop）在 Closeout 6 中删除：
//!   - crate-private（lib 非-test 路径零调用）
//!   - first_boot_db_failure_does_not_commit_bootstrap 测试改为直接调用 db::policy::open_configured_connection
//!   - 生产 run_bootstrap_pipeline 也是内联 open_configured_connection + MigrationRunner，无需二层包装
//!
//! 未来引入 Connection Factory / Repository 层时，可在此定义高层 boot API。
