# ⚠️ LEGACY STACK — `vercel-leg/`

> **Status**: Legacy / backstop. **Stack aktif adalah `cf/` (Cloudflare Worker TypeScript).**
> Folder ini masih ter-deploy di Vercel sebagai backstop paralel (`/api/health` → 200).
> **JANGAN dihapus** selama masih menjadi fallback. Jika sudah tidak dipakai, pindahkan
> ke branch `legacy` dan hapus dari `main`.

## Kenapa masih ada?
- Stack Python/Vercel ini adalah generasi sebelumnya dari JARVIS.
- Masih melayani endpoint API tertentu sebagai backstop jika Cloudflare Worker down.
- Konstitusi & identity di sini dijaga parity dengan `cf/` (mis. varian "uang" typo).

## Yang masih aktif (terverifikasi 2026-09-27):
- `https://jarvis-sigma-navy-gamma.vercel.app/api/health` → `{"ok": true}`
- Supabase: up · Groq/Telegram: unconfigured (backstop saja)

## Stack aktif (ganti ke sini untuk pengembangan baru):
→ `../cf/` — Cloudflare Worker + D1 + KV + Vectorize + GitHub Actions executor.

## Rencana pensiun (opsional):
1. Pastikan semua endpoint penting sudah punya padanan di `cf/`.
2. Buat branch `legacy`: `git checkout -b legacy && git push -u origin legacy`
3. Hapus dari `main`: `git rm -r vercel-leg/ && git commit && git push`
4. Hapus/hentikan proyek Vercel jika sudah tidak diperlukan.
