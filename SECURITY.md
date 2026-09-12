# Security Policy

## Reporting a Vulnerability

Jangan pernah menaruh informasi sensitif (token bot, PAT, API key, kata
sandi, isi `.env*`) di issue publik, PR, atau komentar.

Laporkan kerentanan/secret yang terlanjur bocor langsung ke pemilik repo
(vikricahya64-alt) melalui jalur pribadi (repo **private** terlebih dahulu,
atau saluran kontak yang disepakati). Jangan publikasikan temuan sebelum
inti masalah ditangani.

Jika menemukan secret bocor di history git, ikuti langkah berikut (tidak
menghapus return history secara normal):

1. Rotasi secret tersebut sesegera mungkin (revoke di dashboard penyedia).
2. Scrub history — contoh menggunakan `git-filter-repo`:
   ```sh
   git-filter-repo --replace-text <(printf 'LITERAL_SECRET==>REDACTED\n')
   ```
3. Force-push seluruh cabang yang bersangkutan.
4. Biarkan GitHub Actions/security untuk tidak memakainya; simpan nilai
   produksi hanya di environment (Vercel/Fly/CF secrets).

## Prinsip

- **Fail-closed**: bila konfigurasi tidak valid atau secret hilang, layanan
  menolak beroperasi daripada berjalan dengan eksposur.
- **Free-tier permanen**: tidak boleh ada komponen yang mensyaratkan
  pembayaran di atas ambang gratis.
- Repo ini adalah **single source of truth** untuk `cf/`, `api/`, dan
  `utils/`; nilai nyata (token, kunci, OWNER id) TIDAK pernah di-commit.

## Secret yang diharapkan ada di environment (bukan repo)

| Nama | Dipakai oleh | Wajib? |
|------|--------------|--------|
| `CF_API_TOKEN` | GitHub Actions (deploy, nightly) | saat auto-deploy aktif |
| `TELEGRAM_TOKEN` | Worker `cf/` & sisi Python | ya |
| `GROQ_API_KEY` | Kaskade LLM (Groq) di `cf/` & `api/` | ya |
| `OWNER_CHAT_ID` | gating owner & alarm kuota | ya |
| `CRON_SECRET` | cron `/api/cron` | ya |

Lihat `.env.example` untuk daftar placeholder lengkap.