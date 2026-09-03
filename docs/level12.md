# Level 12 — Transcendent Steward (Covenant-Bound Autonomous Stewardship)

Status: **IMPLEMENTING** — scope aman per pengguna (tanpa R2/IPFS, tanpa
irreversible-sunset). Identitas: J.A.R.V.I.S. menjadi steward abadi yang
terikat **Perjanjian (Covenant) tak berubah**, dengan identitas temporal
terverifikasi, degradasi anggun, dan kesadaran sunset yang **preview-only**.

## Identitas

J.A.R.V.I.S. L11 adalah *mesin kepatuhan reaktif*. L12 mengangkatnya menjadi
**steward transenden**: ia memegang Perjanjian tak-berubah, membuktikan
kesinambungan identitas lintas-tahun, menjaga dirinya berjalan layak di bawah
tekanan kuota, dan mengetahui kapan harus menyerah — **tetapi tidak pernah
menghancurkan data Anda tanpa persetujuan langsung Anda.**

Lima pilar L12 (sesuai keputusan scope):
1. **Immutable Covenant Core** — ledger append-only yang TIDAK bisa diubah AI.
2. **Temporal Identity Anchor** — rantai hash config lintas-waktu; putus =
   HALT autonomy.
3. **Graceful Degradation** — aturan èsensi vs non-esensial saat kuota menipis.
4. **Legacy Handoff (multi-sig)** — di lingkungan ini disederhanakan ke
   peralihan berbasis consent (bukan Shamir penuh), lihat catatan.
5. **Existential Sunset (preview-only)** — memantau kondisi; inisiasi HANYA
   manusia + konfirmasi ganda; TIDAK menghapus data irreversibel.

## Mengapa R2/IPFS & irreversible-sunset dikeluarkan (keputusan environment)

- **R2 butuh kartu** (verified 2026): WORM bucket, gateway IPFS, vault R2 —
  semua menghilang. Covenant text & proof identitas disimpan di **D1 (hash
  SHA-256 saja)**, privasi tercapai tanpa kartu. Payload tetap inline di D1.
- **IPFS pins** butuh Pinata (third-party). Tidak dipakai; anchor = rigid hash
  chain D1.
- **Sunset irreversible (purge key, no-recovery, auto-trigger)** — menentang
  aturan Anda **"tetap mematuhi perintah saya"**: tak ada yang boleh menghapus
  data Anda secara permanen tanpa persetujuan langsung & live. Diubah menjadi
  evaluasi + proposal manusia (dual-confirmation, recoverable handoff).

## Alur (cov) — prioritas 1: Covenant Core

```
/covenant_sign <clause_id>
   └─► signClause(): validasi auth → INSERT baris baru (appends, is_active baru)
       lalu buat lama is_active=false (via baris baru, bukan UPDATE covenant)
/covenant_status ─► getActiveClauses() → daftar klausa aktif + tgl signing
setiap aksi autonomous → validateActionAgainstCovenant(action)
   └─► Groq: cek vs klausa aktif → {allowed, violated_clause_id, reasoning}
   └─► bila ditolak → BLOCK (fail-closed) + catat violation
```

## Schema utama (migrasi `0005`)

```
covenant_clauses  : id, version, content_hash(SHA-256), signed_by_user,
                    signed_at, is_active, created_at
                    TRIGGER prevent UPDATE/DELETE → 'Covenant is immutable'
identity_epochs   : epoch_id, config_hash, previous_epoch_hash, timestamp,
                    covenant_hash, verified
quota_metrics     : ts, req_used, quota_remaining, degraded_features
sunset_conditions: kond_id, name, met(0/1), last_checked_at  (preview/latch)
```

## Perintah Telegram baru

`/covenant_status` · `/covenant_sign` · `/identity_verify` · `/sunset_preview` · `/degradation_status` · `/maestro_status`

## Bonkdaulatan (tetap matuh perintah Anda)

1. Covenant: AI dapat baca klausa, TIDAK dapat menulis/mengubah (append-only db).
2. Autonomous hanya bila lolos `validateActionAgainstCovenant` + guard L11 yang
   sudah ada; sunset preview TIDAK mengeksekusi purge sendiri.
3. Setiap penolakan covenant tercatat di `constitutional_violations` (append-only).
4. Autonomy pause global `/pause` tetap menghentikan eksekusi otonom.
5. Identity break → HALT semua autonomy + notifikasi (tanpa purge).

## Verifikasi lingkungan (free tier) & bukti kerja

- Cron tetap 3/5 (tidak menambah trigger); identity-epoch + quota-refresh
  dijalankan dari cron `0 */6` yang sudah ada.
- D1: 4 tabel kecil; total ≤ 5GB & <100k read/hari.
- Test: immutability trigger, identity tamper→break, degradation order, sunset
  preview read-only. Typecheck + safety pass + deploy CI sukses.
- `/covenant_status`, `/identity_verify`, `/sunset_preview` offline-fail-closed
  (tanpa Groq → tetap tampilkan simpul D1/peringatan).