//! Checksum：sha256_hex(sql.as_bytes())；**不做任何 canonicalization**（冻结二 6）。
//!
//! Git `.gitattributes` `src-tauri/migrations/*.sql text eol=lf` 永久在仓库级保证 LF。
//! 被 hash 的字节 == SQLite execute_batch 实际执行的字节。

use sha2::{Digest, Sha256};

/// 对任意字节计算 SHA-256，输出小写十六进制字符串。
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let out = hasher.finalize();
    let mut s = String::with_capacity(64);
    for byte in out.iter() {
        use std::fmt::Write;
        let _ = write!(s, "{:02x}", byte);
    }
    s
}

/// 流式 SHA-256：对文件路径按 64KB 分块读取，避免把整个 SQLite DB 加载进内存（冻结四 D）。
pub fn sha256_file_hex(path: &std::path::Path) -> Result<String, std::io::Error> {
    use std::fs::File;
    use std::io::Read;

    let mut f = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let out = hasher.finalize();
    let mut s = String::with_capacity(64);
    for byte in out.iter() {
        use std::fmt::Write;
        let _ = write!(s, "{:02x}", byte);
    }
    Ok(s)
}
