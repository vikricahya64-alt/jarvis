-- =====================================================================
-- 0022_backfill_and_counters.sql
--
-- Menormalkan data yang sudah ada di dua tabel. TIDAK menghapus apa pun,
-- TIDAK men-drop kolom, TIDAK mengubah skema tabel yang sudah berjalan.
--
-- CATATAN PENTING TENTANG IDEMPOTENSI
--   `ALTER TABLE ... ADD COLUMN` di SQLite TIDAK punya `IF NOT EXISTS` dan
--   akan gagal dengan "duplicate column name" bila dijalankan dua kali.
--   File ini aman dijalankan ulang karena `wrangler d1 migrations apply`
--   menyimpan ledger `d1_migrations` — hanya file baru yang dieksekusi.
--   Ledger itu dipulihkan lewat 0023_baseline_ledger.sql. Sebelum ledger
--   aktif, jangan jalankan file ini dua kali secara manual.
-- =====================================================================

-- ---------------------------------------------------------------------
-- A) request_log — kolom HTTP kosong, data LLM terisi
--
--    request_log sebenarnya adalah tabel LLM (0006): isinya baris
--    provider / status / latency_ms / step / note. 0010 mencoba
--    membuatnya sebagai tabel HTTP dengan (path, method, status_code,
--    error), tetapi CREATE TABLE IF NOT EXISTS membuatnya no-op, lalu
--    0013 menambahkan kolom-kolom itu dengan nilai DEFAULT.
--
--    Akibatnya SEMUA baris lama punya `status_code = 200` dan
--    `error = 0` — termasuk baris yang `status = 'fail'`. Jadi
--    deploy_safety.ts dan config_optimizer.ts, yang membaca
--    SUM(error)/COUNT(*), menghitung nol error dari basis data yang
--    sebenarnya mencatat kegagalan.
--
--    Backfill di bawah menurunkan kolom HTTP dari kolom LLM yang benar.
--    Aman diulang: dijalankan berapa kali pun menghasilkan nilai sama.
-- ---------------------------------------------------------------------
UPDATE request_log
   SET status_code = CASE status
                       WHEN 'ok'   THEN 200
                       WHEN 'fail' THEN 500
                       ELSE 200
                     END,
       error = CASE WHEN status IS NULL OR status = '' OR status = 'ok'
                    THEN 0 ELSE 1 END,
       method = CASE WHEN method IS NULL OR method = '' THEN 'PROVIDER' ELSE method END,
       path   = CASE WHEN path   IS NULL OR path   = '' THEN '/' || provider ELSE path END
 WHERE error IS NULL
    OR status_code = 200;   -- belum pernah diturunkan dari status

-- ---------------------------------------------------------------------
-- B) task_counters — kolom `queue` tidak pernah berisi nilai yang dibaca
--
--    Skema mendeklarasikan `queue TEXT -- high|standard|low` dan
--    queueStatus() membaca tepat tiga nilai itu. Tapi seluruh producer
--    menulis label semantik: 'translate', 'image_prompt', 'todo_help'.
--    Akibatnya /queue_status SELALU mengembalikan {0,0,0} sementara
--    tabel menumpuk baris yang tidak pernah dibaca siapa pun.
--
--    Perbaikan: tambah kolom `bucket` yang benar-benar berisi kelas
--    prioritas, dan biarkan `queue` tetap sebagai label semantik (tidak
--    dihapus, maknanya tidak berubah). Baris lama di-backfill ke
--    'standard' — itu jujur: producer memang tidak pernah mengklasifikasi
--    prioritas, jadi semua pekerjaan yang tercatat adalah pekerjaan
--    standar.
-- ---------------------------------------------------------------------
ALTER TABLE task_counters ADD COLUMN bucket TEXT NOT NULL DEFAULT 'standard';

UPDATE task_counters SET bucket = 'standard' WHERE bucket IS NULL OR bucket = '';

CREATE INDEX IF NOT EXISTS idx_tc_bucket ON task_counters(bucket);

-- Index gabungan untuk pembacaan per-owner per-kelas prioritas.
CREATE INDEX IF NOT EXISTS idx_tc_owner_bucket
  ON task_counters(owner_id, bucket);
