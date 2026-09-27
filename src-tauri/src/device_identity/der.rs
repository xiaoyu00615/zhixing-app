//! Canonical public-identity and signature encodings — platform-neutral byte logic.
//!
//! # Why this module exists
//!
//! V1 Device Identity is `ECDSA P-256` (§3) and its canonical public form is the DER
//! `SubjectPublicKeyInfo` (§8). Windows CNG hands back a provider-native
//! `BCRYPT_ECCPUBLIC_BLOB` and a fixed-width IEEE-P1363 signature (`r || s`), while the
//! shared contract — and the future Android adapter — must see exactly one canonical
//! encoding. Every conversion therefore lives HERE, in one platform-neutral place:
//!
//! ```text
//! Windows:  BCRYPT_ECCPUBLIC_BLOB ──▶ SEC1 point ──▶ SPKI DER      (this module)
//! Windows:  NCryptSignHash (P1363 64B) ──▶ ECDSA-Sig-Value DER     (this module)
//! Android:  KeyStore already emits SPKI DER + DER signatures       (no conversion)
//! ```
//!
//! Nothing here names a Windows type, a provider, or a platform: the module compiles and
//! its tests run on every target. It contains no secret material by construction (public
//! keys and signatures only — the private key never enters this module).
//!
//! The DER rules implemented below were validated against a real TPM-backed signing path
//! in P7-T2V; the conversion logic and its unit tests are carried over from that spike's
//! reviewed probe crate rather than reinvented.

/// A P-256 `SubjectPublicKeyInfo` is exactly 91 bytes for every P-256 key: the algorithm
/// identifier and the point encoding are both fixed length.
pub(crate) const P256_SPKI_LEN: usize = 91;

/// P-256 coordinates / scalars are 32 bytes.
pub(crate) const P256_SCALAR_LEN: usize = 32;

/// A fixed-width P-1363 signature is `r || s`, so two scalars (64 bytes for P-256).
///
/// Named because the Windows adapter REQUIRES this exact length from `NCryptSignHash`
/// rather than inferring the encoding from the bytes (see the note below the signature
/// helpers).
pub(crate) const P1363_SIGNATURE_LEN: usize = 2 * P256_SCALAR_LEN;

/// SEC1 uncompressed point: `0x04 || X || Y`.
pub(crate) const P256_POINT_LEN: usize = 65;

/// The fixed 26-byte prefix of every canonical P-256 SPKI:
///
/// ```text
/// SEQUENCE {                      30 59
///   AlgorithmIdentifier {         30 13
///     OID 1.2.840.10045.2.1       06 07 2A 86 48 CE 3D 02 01
///     OID 1.2.840.10045.3.1.7     06 08 2A 86 48 CE 3D 03 01 07
///   }
///   BIT STRING header             03 42 00
/// }
/// ```
///
/// Followed by the 65-byte point. Used to REJECT a provider-native blob (§8): a
/// `BCRYPT_ECCPUBLIC_BLOB` must never be mistaken for the canonical identity encoding.
pub(crate) const P256_SPKI_PREFIX: [u8; 26] = [
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01, 0x06, 0x08, 0x2A,
    0x86, 0x48, 0xCE, 0x3D, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
];

/// `BCRYPT_ECDSA_PUBLIC_P256_MAGIC` (`0x31534345`, ASCII `"ECS1"` little-endian).
///
/// Repeated here as a plain constant so the parser is unit-testable without Windows.
pub(crate) const BCRYPT_ECDSA_PUBLIC_P256_MAGIC: u32 = 0x3153_4345;

// P7-S4R3 — there is deliberately NO "is this DER or P-1363?" classifier here.
//
// A 64-byte IEEE-P1363 `r || s` signature is not guaranteed to be disjoint from the set of
// syntactically valid DER byte strings, so inspecting bytes can answer that question
// differently than the provider contract does. Which representation a provider emits is
// KNOWLEDGE ABOUT THAT PROVIDER, not a property of the bytes: Windows CNG emits P-1363
// (P7-T2V runtime evidence + the rustls-cng reference path) and Android KeyStore emits DER
// (`SHA256withECDSA`). Each adapter therefore declares what its own provider returns and
// converts deterministically; nothing is inferred.
//
// The helpers below are the conversions that declaration needs — nothing more.

/// Converts a 64-byte P-1363 `r || s` signature into `ECDSA-Sig-Value` DER (RFC 3279
/// §2.2.3), which is the shared signature output format (§14).
pub(crate) fn p1363_to_der(raw: &[u8]) -> Result<Vec<u8>, String> {
    if raw.len() != 2 * P256_SCALAR_LEN {
        return Err(format!(
            "P-1363 conversion expects {} bytes, got {}",
            2 * P256_SCALAR_LEN,
            raw.len()
        ));
    }
    let r = der_integer(&raw[0..P256_SCALAR_LEN]);
    let s = der_integer(&raw[P256_SCALAR_LEN..]);
    let body_len = r.len() + s.len();
    if body_len > 127 {
        return Err(format!("ECDSA-Sig-Value body too large: {body_len}"));
    }
    let mut out = Vec::with_capacity(body_len + 2);
    out.push(0x30);
    out.push(body_len as u8);
    out.extend_from_slice(&r);
    out.extend_from_slice(&s);
    Ok(out)
}

/// Inverse of [`p1363_to_der`]: `ECDSA-Sig-Value` DER → fixed-width P-1363 `r || s`.
///
/// Exists for one reason only: verifying a production signature with a platform verifier
/// (Windows `BCryptVerifySignature`) that consumes the native fixed-width form. It is
/// therefore part of the TEST/verification path, never of the signing path.
pub(crate) fn der_to_p1363(der: &[u8]) -> Result<[u8; 2 * P256_SCALAR_LEN], String> {
    let (r, s) = try_parse_der_sig_value(der).ok_or_else(|| {
        "signature is not a well-formed ECDSA-Sig-Value".to_string()
    })?;
    if r.len() > P256_SCALAR_LEN || s.len() > P256_SCALAR_LEN {
        return Err("ECDSA-Sig-Value integer exceeds the P-256 scalar width".to_string());
    }
    let mut out = [0u8; 2 * P256_SCALAR_LEN];
    out[P256_SCALAR_LEN - r.len()..P256_SCALAR_LEN].copy_from_slice(r);
    out[2 * P256_SCALAR_LEN - s.len()..].copy_from_slice(s);
    Ok(out)
}

/// Strict `SEQUENCE { INTEGER, INTEGER }` parser. Returns `(r, s)` big-endian slices with
/// leading zeros removed, or `None` if the input is not exactly that structure.
pub(crate) fn try_parse_der_sig_value(raw: &[u8]) -> Option<(&[u8], &[u8])> {
    let mut r = Reader { buf: raw, pos: 0 };
    if r.u8()? != 0x30 {
        return None;
    }
    let body_len = r.definite_length()?;
    if body_len != raw.len().checked_sub(r.pos)? {
        return None;
    }
    let r_val = r.der_integer()?;
    let s_val = r.der_integer()?;
    // The SEQUENCE must be fully consumed: trailing bytes mean this is not a Sig-Value.
    if r.pos != raw.len() {
        return None;
    }
    Some((r_val, s_val))
}

/// Parses a `BCRYPT_ECCPUBLIC_BLOB` for P-256 and returns the SEC1 uncompressed point.
///
/// Layout: `BCRYPT_ECCKEY_BLOB { u32 dwMagic; u32 cbKey; }` followed by `cbKey` bytes of
/// `X` and `cbKey` bytes of `Y`. Every field is validated rather than assumed — a blob
/// from the wrong curve must be a loud failure, not a silently truncated point.
pub(crate) fn parse_bcrypt_public_blob(blob: &[u8]) -> Result<[u8; P256_POINT_LEN], String> {
    if blob.len() < 8 {
        return Err(format!("public blob too short: {} bytes", blob.len()));
    }
    let magic = u32::from_le_bytes([blob[0], blob[1], blob[2], blob[3]]);
    let cb_key = u32::from_le_bytes([blob[4], blob[5], blob[6], blob[7]]);
    if magic != BCRYPT_ECDSA_PUBLIC_P256_MAGIC {
        return Err(format!(
            "unexpected blob magic 0x{magic:08X} (expected 0x{BCRYPT_ECDSA_PUBLIC_P256_MAGIC:08X})"
        ));
    }
    if cb_key as usize != P256_SCALAR_LEN {
        return Err(format!(
            "unexpected coordinate size {cb_key} (expected {P256_SCALAR_LEN})"
        ));
    }
    let expected = 8 + 2 * P256_SCALAR_LEN;
    if blob.len() != expected {
        return Err(format!(
            "unexpected public blob length {} (expected {expected})",
            blob.len()
        ));
    }
    let mut point = [0u8; P256_POINT_LEN];
    point[0] = 0x04;
    point[1..1 + P256_SCALAR_LEN].copy_from_slice(&blob[8..8 + P256_SCALAR_LEN]);
    point[1 + P256_SCALAR_LEN..].copy_from_slice(&blob[8 + P256_SCALAR_LEN..]);
    Ok(point)
}

/// Wraps a SEC1 uncompressed point into an RFC 5280 `SubjectPublicKeyInfo`.
pub(crate) fn spki_from_point(point: &[u8; P256_POINT_LEN]) -> [u8; P256_SPKI_LEN] {
    debug_assert_eq!(point[0], 0x04, "SPKI requires an uncompressed point");
    let mut out = [0u8; P256_SPKI_LEN];
    out[..P256_SPKI_PREFIX.len()].copy_from_slice(&P256_SPKI_PREFIX);
    out[P256_SPKI_PREFIX.len()..].copy_from_slice(point);
    out
}

/// `true` iff `spki` is a canonical P-256 `SubjectPublicKeyInfo` (§8 / §10).
///
/// This is what stops a provider-native blob from ever becoming the wire identity: the
/// length, the algorithm identifier, the BIT STRING header and the uncompressed-point
/// marker are all checked.
pub(crate) fn is_canonical_p256_spki(spki: &[u8]) -> bool {
    spki.len() == P256_SPKI_LEN
        && spki.starts_with(&P256_SPKI_PREFIX)
        && spki[P256_SPKI_PREFIX.len()] == 0x04
}

/// Lowercase hex, for diagnostic output of PUBLIC material only.
pub(crate) fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Minimal DER reader for the two-integer structure above. Bounds-checked on every step.
struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn u8(&mut self) -> Option<u8> {
        let b = *self.buf.get(self.pos)?;
        self.pos += 1;
        Some(b)
    }

    /// Short-form and long-form definite lengths.
    fn definite_length(&mut self) -> Option<usize> {
        let first = self.u8()?;
        if first & 0x80 == 0 {
            return Some(first as usize);
        }
        let n = (first & 0x7F) as usize;
        if n == 0 || n > 2 {
            return None;
        }
        let mut len = 0usize;
        for _ in 0..n {
            len = (len << 8) | self.u8()? as usize;
        }
        Some(len)
    }

    /// Reads an `INTEGER` and returns its content with leading zeros removed.
    fn der_integer(&mut self) -> Option<&'a [u8]> {
        if self.u8()? != 0x02 {
            return None;
        }
        let len = self.definite_length()?;
        if len == 0 {
            return None;
        }
        if self.pos + len > self.buf.len() {
            return None;
        }
        let content = &self.buf[self.pos..self.pos + len];
        self.pos += len;
        // Reject non-minimal encodings and negative values.
        if content.len() > 1 && content[0] == 0x00 && content[1] & 0x80 == 0 {
            return None;
        }
        if content[0] & 0x80 != 0 {
            return None;
        }
        let mut v = content;
        while v.len() > 1 && v[0] == 0 {
            v = &v[1..];
        }
        Some(v)
    }
}

/// Encodes one big-endian unsigned value as a minimal DER `INTEGER`.
fn der_integer(value: &[u8]) -> Vec<u8> {
    let mut v = value;
    // Rule 1: strip redundant leading zeros, but keep at least one byte so a zero value
    // stays representable.
    while v.len() > 1 && v[0] == 0 {
        v = &v[1..];
    }
    let mut content = Vec::with_capacity(v.len() + 1);
    // Rule 2: a high bit would make DER read this as a negative integer.
    if v.first().map(|b| b & 0x80 != 0).unwrap_or(false) {
        content.push(0x00);
    }
    content.extend_from_slice(v);
    // Rule 3: `v` is never empty (the loop keeps one byte), so an all-zero input becomes
    // content `[0x00]` — the canonical encoding of INTEGER 0.
    let mut out = Vec::with_capacity(content.len() + 2);
    out.push(0x02);
    out.push(content.len() as u8);
    out.extend_from_slice(&content);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn point_with_x_y(x: u8, y: u8) -> [u8; P256_POINT_LEN] {
        let mut p = [0u8; P256_POINT_LEN];
        p[0] = 0x04;
        p[1] = x;
        p[P256_SCALAR_LEN + 1] = y;
        p
    }

    // --- canonical public identity (§8 / §10) --------------------------------

    /// The canonical SPKI is exactly 91 bytes and carries the P-256 algorithm identifier.
    #[test]
    fn canonical_spki_is_fixed_length_with_p256_algorithm_identifier() {
        let spki = spki_from_point(&point_with_x_y(0x11, 0x22));
        assert_eq!(spki.len(), P256_SPKI_LEN);
        assert!(is_canonical_p256_spki(&spki));
        assert_eq!(&spki[..P256_SPKI_PREFIX.len()], &P256_SPKI_PREFIX);
        assert_eq!(spki[P256_SPKI_PREFIX.len()], 0x04);
    }

    /// §8 — a provider-native blob must NEVER pass as the canonical identity encoding.
    #[test]
    fn provider_native_blob_is_not_a_canonical_spki() {
        let mut blob = vec![0u8; 8 + 2 * P256_SCALAR_LEN];
        blob[0..4].copy_from_slice(&BCRYPT_ECDSA_PUBLIC_P256_MAGIC.to_le_bytes());
        blob[4..8].copy_from_slice(&(P256_SCALAR_LEN as u32).to_le_bytes());
        blob[8] = 0x11;
        assert!(
            !is_canonical_p256_spki(&blob),
            "a BCRYPT_ECCPUBLIC_BLOB must be rejected as a public identity"
        );
        assert!(!is_canonical_p256_spki(&[0u8; P256_SPKI_LEN]));
        assert!(!is_canonical_p256_spki(&[]));
    }

    /// The blob parser validates magic, coordinate size and total length.
    #[test]
    fn blob_parser_validates_every_field() {
        let mut blob = vec![0u8; 8 + 2 * P256_SCALAR_LEN];
        blob[0..4].copy_from_slice(&BCRYPT_ECDSA_PUBLIC_P256_MAGIC.to_le_bytes());
        blob[4..8].copy_from_slice(&(P256_SCALAR_LEN as u32).to_le_bytes());
        blob[8] = 0xAA;
        blob[8 + P256_SCALAR_LEN] = 0xBB;
        let point = parse_bcrypt_public_blob(&blob).expect("valid blob parses");
        assert_eq!(point[0], 0x04);
        assert_eq!(point[1], 0xAA);
        assert_eq!(point[1 + P256_SCALAR_LEN], 0xBB);

        // Wrong magic.
        let mut bad = blob.clone();
        bad[0] = 0x00;
        assert!(parse_bcrypt_public_blob(&bad).is_err());
        // Wrong coordinate size.
        let mut bad = blob.clone();
        bad[4] = 31;
        assert!(parse_bcrypt_public_blob(&bad).is_err());
        // Truncated.
        assert!(parse_bcrypt_public_blob(&blob[..blob.len() - 1]).is_err());
        assert!(parse_bcrypt_public_blob(&[0u8; 4]).is_err());
    }

    /// Parsing a blob and wrapping the result round-trips to the same point.
    #[test]
    fn blob_parse_then_spki_round_trips() {
        let mut blob = vec![0u8; 8 + 2 * P256_SCALAR_LEN];
        blob[0..4].copy_from_slice(&BCRYPT_ECDSA_PUBLIC_P256_MAGIC.to_le_bytes());
        blob[4..8].copy_from_slice(&(P256_SCALAR_LEN as u32).to_le_bytes());
        blob[8] = 0x01;
        blob[8 + P256_SCALAR_LEN + 31] = 0x02;
        let point = parse_bcrypt_public_blob(&blob).expect("parse");
        let spki = spki_from_point(&point);
        assert_eq!(&spki[P256_SPKI_PREFIX.len()..], &point[..]);
    }

    // --- signature encoding (§14) --------------------------------------------

    #[test]
    fn zero_stays_representable() {
        assert_eq!(der_integer(&[0u8; P256_SCALAR_LEN]), vec![0x02, 0x01, 0x00]);
    }

    #[test]
    fn leading_zeros_are_trimmed() {
        let mut v = [0u8; P256_SCALAR_LEN];
        v[P256_SCALAR_LEN - 1] = 0x7F;
        assert_eq!(der_integer(&v), vec![0x02, 0x01, 0x7F]);
    }

    #[test]
    fn high_bit_gets_positive_padding() {
        let mut v = [0u8; P256_SCALAR_LEN];
        v[P256_SCALAR_LEN - 1] = 0x80;
        assert_eq!(der_integer(&v), vec![0x02, 0x02, 0x00, 0x80]);
    }

    #[test]
    fn full_width_value_is_untouched() {
        let mut v = [0u8; P256_SCALAR_LEN];
        v[0] = 0x01;
        v[P256_SCALAR_LEN - 1] = 0x02;
        let out = der_integer(&v);
        assert_eq!(out[0], 0x02);
        assert_eq!(out[1], P256_SCALAR_LEN as u8);
        assert_eq!(&out[2..], &v);
    }

    #[test]
    fn converts_a_fixed_width_signature_and_reparses_it() {
        let mut raw = [0u8; 2 * P256_SCALAR_LEN];
        raw[P256_SCALAR_LEN - 1] = 0x11; // small r, needs no trimming
        raw[P256_SCALAR_LEN] = 0x00; // redundant leading zero in s
        raw[2 * P256_SCALAR_LEN - 1] = 0xFF; // high bit set -> positive padding required
        let der = p1363_to_der(&raw).expect("convert");
        assert_eq!(der[0], 0x30);
        assert_eq!(der[1] as usize, der.len() - 2);
        let (r, s) = try_parse_der_sig_value(&der).expect("reparse");
        assert_eq!(r, &[0x11]);
        assert_eq!(s, &[0xFF]);
    }

    #[test]
    fn der_parse_rejects_non_minimal_encodings() {
        // INTEGER 0x00 0x7F is a non-minimal encoding of 0x7F.
        let non_minimal = [0x30u8, 0x09, 0x02, 0x02, 0x00, 0x7F, 0x02, 0x03, 0x00, 0x00, 0x01];
        assert!(try_parse_der_sig_value(&non_minimal).is_none());
        // Negative INTEGER.
        let negative = [0x30u8, 0x06, 0x02, 0x01, 0x80, 0x02, 0x01, 0x01];
        assert!(try_parse_der_sig_value(&negative).is_none());
        // Trailing bytes inside the SEQUENCE.
        let trailing = [0x30u8, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01, 0x00];
        assert!(try_parse_der_sig_value(&trailing).is_none());
    }

    #[test]
    fn conversion_refuses_wrong_input_length() {
        assert!(p1363_to_der(&[0u8; 63]).is_err());
        assert!(p1363_to_der(&[0u8; 65]).is_err());
    }

    /// The inverse conversion exists only for platform verification, and round-trips.
    #[test]
    fn der_to_p1363_round_trips() {
        let mut raw = [0u8; 2 * P256_SCALAR_LEN];
        raw[0] = 0x00; // redundant leading zero
        raw[P256_SCALAR_LEN - 1] = 0x11;
        raw[P256_SCALAR_LEN] = 0x80; // high bit -> padding added, must be stripped back
        raw[2 * P256_SCALAR_LEN - 1] = 0xFF;
        let der = p1363_to_der(&raw).expect("to der");
        let back = der_to_p1363(&der).expect("to p1363");
        assert_eq!(back, raw);
        assert!(der_to_p1363(&[0x30, 0x00]).is_err());
    }
}
